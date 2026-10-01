/**
 * Multi-Building Queue Aggregation & Balanced Production — Pillar 4 RTS QoL (Issue #119).
 *
 * Implements modern RTS multi-building production mechanics:
 * 1. Queue Aggregation: Inspects multiple selected buildings to aggregate
 *    trainable unit rosters, active queue progress, and capacity.
 * 2. Balanced Training Dispatch: When ordering units across multiple capable
 *    production buildings, distributes orders greedily to the building with
 *    the shortest queue depth, tie-breaking by remaining time on the head unit.
 * 3. Determinism: Submits standard, authoritative train commands directly to
 *    the world inbox targeting the chosen building's EID.
 */

import type { BuildingComponents, TrainQueueEntry } from "../components/buildings";
import {
  getBuildingRow,
  populationCapOf,
  populationOf,
  readTrainQueue,
} from "../components/buildings";
import type { SimComponents } from "../components";
import type { OwnerComponents } from "../components/owner";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import type { UnitDefinition } from "../../data/schema";
import { canEnqueueTraining } from "../systems/training";
import { issueTrainUnit, issueTrainVillager } from "../../ui/buildingPanel";
import type { CommandInbox } from "../core/inbox";
import type { World } from "../core/world";
import { PLAYER_ONE } from "../core/stockpile";

/** Status and active progress of a single building's training queue. */
export interface BuildingQueueStatus {
  readonly buildingEid: number;
  readonly defId: string;
  readonly defName: string;
  readonly queueLength: number;
  readonly capacity: number;
  readonly headUnitId?: string | undefined;
  readonly headUnitName?: string | undefined;
  readonly headRemainingTicks?: number | undefined;
  readonly queue: readonly TrainQueueEntry[];
}

/** Trainable unit entry aggregated across capable selected buildings. */
export interface AggregatedTrainableUnit {
  readonly unitId: string;
  readonly def: UnitDefinition;
  readonly label: string;
  readonly costStr: string;
  readonly capableBuildingCount: number;
  readonly capableBuildingEids: readonly number[];
  readonly canTrain: boolean;
}

/** Multi-building selection summary for UI display & command routing. */
export interface MultiBuildingSelectionSummary {
  readonly buildingEids: readonly number[];
  readonly isHomogeneous: boolean;
  readonly title: string;
  readonly trainableUnits: readonly AggregatedTrainableUnit[];
  readonly canTrain: boolean;
  readonly totalQueuedCount: number;
  readonly buildingQueues: readonly BuildingQueueStatus[];
  readonly pop: { readonly current: number; readonly cap: number };
}

/** Pluralizes building names cleanly for RTS selection titles. */
export function pluralizeBuildingName(name: string, count: number): string {
  if (count <= 1) return name;
  if (name.endsWith("s")) return name; // e.g. Barracks
  if (name.endsWith("y")) return name.slice(0, -1) + "ies"; // e.g. Monastery -> Monasteries
  return name + "s";
}

/** Formats a compact cost string (e.g. "60 food · 20 gold"). */
export function formatCostString(costs: Record<string, number>): string {
  return Object.entries(costs)
    .filter(([, amt]) => amt > 0)
    .map(([res, amt]) => `${String(amt)} ${res}`)
    .join(" · ");
}

/** Read queue status and progress for one building. */
export function getBuildingQueueStatus(
  world: World,
  comps: Pick<BuildingComponents, "trainQueueId" | "buildingId">,
  eid: number,
): BuildingQueueStatus | undefined {
  const row = getBuildingRow(world, comps, eid);
  if (!row) return undefined;
  const defId = buildingIdOfCode(row[1]!);
  const def = buildingDefOf(defId);
  if (!def.trainQueue) return undefined;

  const queue = readTrainQueue(world, comps, eid);
  const head = queue[0];
  let headUnitId: string | undefined;
  let headUnitName: string | undefined;
  let headRemainingTicks: number | undefined;

  if (head !== undefined) {
    headUnitId = unitIdOfCode(head.unitCode);
    headUnitName = unitDefOf(headUnitId).name;
    headRemainingTicks = head.remainingTicks;
  }

  return {
    buildingEid: eid,
    defId,
    defName: def.name,
    queueLength: queue.length,
    capacity: def.trainQueue.capacity,
    headUnitId,
    headUnitName,
    headRemainingTicks,
    queue,
  };
}

/**
 * Aggregates a selection of building EIDs into a cohesive multi-building summary.
 * Returns undefined if no selected buildings belong to `playerId` or have queues.
 */
export function aggregateBuildingSelection(
  world: World,
  comps: SimComponents & Pick<OwnerComponents, "ownerId">,
  selectedEids: readonly number[],
  playerId: number = PLAYER_ONE,
): MultiBuildingSelectionSummary | undefined {
  const buildingEids: number[] = [];
  const defIds: string[] = [];

  for (const eid of selectedEids) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    const defId = buildingIdOfCode(row[1]!);
    const def = buildingDefOf(defId);
    // Focus aggregation on production buildings with train queues
    if (def.trainQueue) {
      buildingEids.push(eid);
      defIds.push(defId);
    }
  }

  if (buildingEids.length === 0) return undefined;

  const isHomogeneous = defIds.every((id) => id === defIds[0]);
  const primaryDef = buildingDefOf(defIds[0]!);
  const title = isHomogeneous
    ? `${String(buildingEids.length)} ${pluralizeBuildingName(primaryDef.name, buildingEids.length)}`
    : `${String(buildingEids.length)} Production Buildings`;

  // Aggregate trainable units across all selected buildings
  const unitMap = new Map<string, { capableEids: number[] }>();
  const buildingQueues: BuildingQueueStatus[] = [];
  let totalQueuedCount = 0;

  for (const bEid of buildingEids) {
    const status = getBuildingQueueStatus(world, comps, bEid);
    if (status) {
      buildingQueues.push(status);
      totalQueuedCount += status.queueLength;
    }
    const row = getBuildingRow(world, comps, bEid)!;
    const def = buildingDefOf(buildingIdOfCode(row[1]!));
    if (!def.trainQueue) continue;

    for (const t of def.trainQueue.trainable) {
      let entry = unitMap.get(t.unitId);
      if (!entry) {
        entry = { capableEids: [] };
        unitMap.set(t.unitId, entry);
      }
      entry.capableEids.push(bEid);
    }
  }

  const trainableUnits: AggregatedTrainableUnit[] = [];
  let anyCanTrain = false;

  for (const [unitId, { capableEids }] of unitMap.entries()) {
    const uDef = unitDefOf(unitId);
    const costStr = formatCostString(uDef.costs);
    const unitCanTrain = capableEids.some((bEid) =>
      canEnqueueTraining(world, comps, bEid, playerId, unitId),
    );
    if (unitCanTrain) anyCanTrain = true;

    const buildingCountStr =
      buildingEids.length > 1 ? ` · ${String(capableEids.length)} bldgs` : "";
    const label = `Train ${uDef.name} (${costStr})${buildingCountStr}`;

    trainableUnits.push({
      unitId,
      def: uDef,
      label,
      costStr,
      capableBuildingCount: capableEids.length,
      capableBuildingEids: capableEids,
      canTrain: unitCanTrain,
    });
  }

  // Sort trainable units deterministically by name
  trainableUnits.sort((a, b) => a.def.name.localeCompare(b.def.name));

  const pop = {
    current: populationOf(world, comps, playerId),
    cap: populationCapOf(world, comps, playerId),
  };

  return {
    buildingEids,
    isHomogeneous,
    title,
    trainableUnits,
    canTrain: anyCanTrain,
    totalQueuedCount,
    buildingQueues,
    pop,
  };
}

/**
 * Evaluates queue score for shortest-queue-first load balancing:
 * Lower score = prioritized for next training assignment.
 * Primary metric: active queue depth (number of units).
 * Secondary metric: ticks remaining on active head unit (if any).
 * Tie-breaker: lowest entity ID.
 */
export function calculateQueueScore(
  status: BuildingQueueStatus,
  simulatedAdditionCount: number = 0,
): number {
  const currentTotal = status.queueLength + simulatedAdditionCount;
  // Weight queue length heavily; tie-break with remaining ticks
  const remaining = status.headRemainingTicks ?? 0;
  return currentTotal * 100_000 + remaining;
}

/**
 * Selects the optimal building from capable candidates to enqueue the next unit.
 * Uses shortest-queue-first balancing with tie-breaking on remaining time and EID.
 */
export function pickBuildingForTraining(
  world: World,
  comps: SimComponents,
  capableBuildingEids: readonly number[],
  playerId: number,
  unitId: string,
  simulatedAdditions: ReadonlyMap<number, number> = new Map(),
): number | undefined {
  let bestEid: number | undefined;
  let bestScore = Infinity;

  for (const bEid of capableBuildingEids) {
    const added = simulatedAdditions.get(bEid) ?? 0;
    const status = getBuildingQueueStatus(world, comps, bEid);
    if (!status) continue;

    // Check if adding one more would exceed queue capacity
    if (status.queueLength + added >= status.capacity) continue;

    // Verify player and age gate authorization
    if (!canEnqueueTraining(world, comps, bEid, playerId, unitId)) continue;

    const score = calculateQueueScore(status, added);
    if (score < bestScore) {
      bestScore = score;
      bestEid = bEid;
    } else if (score === bestScore && (bestEid === undefined || bEid < bestEid)) {
      bestEid = bEid;
    }
  }

  return bestEid;
}

/**
 * Dispatches `count` units across capable buildings using shortest-queue balancing.
 * Submits authoritative `trainUnit` (or `trainVillager`) inbox commands.
 * Returns the number of units successfully enqueued.
 */
export function dispatchBalancedTraining(
  world: World,
  comps: SimComponents,
  inbox: CommandInbox,
  currentTick: number,
  capableBuildingEids: readonly number[],
  playerId: number,
  unitId: string,
  count: number = 1,
): number {
  if (count <= 0 || capableBuildingEids.length === 0) return 0;

  const simulatedAdditions = new Map<number, number>();
  let enqueued = 0;

  for (let i = 0; i < count; i++) {
    const targetEid = pickBuildingForTraining(
      world,
      comps,
      capableBuildingEids,
      playerId,
      unitId,
      simulatedAdditions,
    );

    if (targetEid === undefined) {
      // No capable buildings have room in queue or can afford
      break;
    }

    if (unitId === "villager") {
      issueTrainVillager(inbox, currentTick);
    } else {
      issueTrainUnit(inbox, currentTick, targetEid, unitId);
    }

    simulatedAdditions.set(targetEid, (simulatedAdditions.get(targetEid) ?? 0) + 1);
    enqueued += 1;
  }

  return enqueued;
}

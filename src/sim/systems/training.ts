/**
 * Training system — SPEC §2.6/§2.13 / M1-T10.
 *
 * Production buildings (any finished building whose definition carries
 * a trainQueue config — M1: town-center) run an AoE2-style finite queue:
 *
 *   `{kind:"trainVillager"}` → validate + pay the unit's food cost at
 *   ENQUEUE time, then append {unitCode, remainingTicks: trainTime} to
 *   the building's TrainQueue row.
 *
 * Each tick, per queue ascending eid:
 *   - the head counts down ONLY while population < popCap — housed
 *     players pause production exactly like AoE2, and the frozen row is
 *     digest-visible so replays see the stall too;
 *   - a head reaching zero spawns its villager at the first free
 *     perimeter tile (pinned clockwise rings around the footprint) and
 *     shifts the queue up; with no free tile the head waits at zero and
 *     retries next tick — deterministic backpressure.
 *
 * Population = live UnitTag rows (M1 single player); popCap = Σ
 * populationCap over FINISHED buildings. Enqueue is REJECTED loudly
 * (gather/placement command discipline) once population + queued ≥ cap
 * or the queue itself is full; the TC panel disables its button via the
 * same exported predicate.
 */

import type { SimComponents } from "../components";
import {
  getBuildingRow,
  footprintOfDefCode,
  populationCapOf,
  populationOf,
  readTrainQueue,
  writeTrainQueue,
} from "../components/buildings";
import { appendGateRejection, GATE_HANDLER_TRAIN } from "../components/age";
import { spawnUnit } from "../components";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitCodeOf,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import { isDefAgeUnlocked } from "./age";
import { payCosts } from "./costs";
import { PLAYER_ONE } from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kind owned by this system. */
export const TRAIN_VILLAGER_KIND = "trainVillager";

/** Perimeter search depth (in whole-tile rings) for spawn placement. */
export const SPAWN_RING_DEPTH = 3;

export interface TrainingDiagnostics {
  /** trainVillager commands applied. */
  commandsApplied: number;
  /** Villagers spawned from completed queue heads. */
  unitsTrained: number;
  /** Polite age-gate refusals (digest-visible GateRejected rows). */
  gateRejections: number;
}

export function createTrainingDiagnostics(): TrainingDiagnostics {
  return { commandsApplied: 0, unitsTrained: 0, gateRejections: 0 };
}

/** Structural slice of the definition's trainQueue config. */
interface TrainQueueConfig {
  readonly capacity: number;
  readonly trainable: readonly { readonly unitId: string }[];
}

/**
 * The unit this queue config trains: the villager entry when present
 * (M1 command-kind intent), else the first listed unit. Shared by the
 * command handler and the enqueue predicate so both always agree.
 */
function trainableUnitIdFor(queueConfig: TrainQueueConfig): string {
  return queueConfig.trainable.some((entry) => entry.unitId === "villager")
    ? "villager"
    : queueConfig.trainable[0]!.unitId;
}

function parseTrainData(data: Readonly<Record<string, unknown>>): {
  siteEid: number | undefined;
} {
  const raw = data.siteEid;
  if (raw === undefined) return { siteEid: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `trainVillager siteEid must be a positive integer, got ${String(raw)}`,
    );
  }
  return { siteEid: raw };
}

interface ProductionBuilding {
  readonly eid: number;
  readonly playerId: number;
  readonly defId: string;
}

function productionBuildingsOf(
  world: World,
  comps: SimComponents,
): ProductionBuilding[] {
  const out: ProductionBuilding[] = [];
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row) continue;
    const defId = buildingIdOfCode(row[1]!);
    if (!buildingDefOf(defId).trainQueue) continue;
    out.push({ eid, playerId: row[0]!, defId });
  }
  // world.entities ascends → the lowest-eid TC wins when unspecified.
  return out;
}

function tileSpawnable(
  passability: Uint8Array,
  size: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  // Buildings/sites mark every covered tile impassable at placement, so
  // the passability plane alone decides "free of construction".
  return passability[y * size + x] === 1;
}

/**
 * First free perimeter tile around an origin-anchored footprint,
 * scanning rings outward (depth SPAWN_RING_DEPTH), each ring clockwise
 * from its north-west corner. Deterministic spawn placement.
 */
export function findSpawnTile(
  world: World,
  originX: number,
  originY: number,
  width: number,
  height: number,
): { x: number; y: number } | undefined {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  for (let ring = 1; ring <= SPAWN_RING_DEPTH; ring++) {
    const minX = originX - ring;
    const minY = originY - ring;
    const maxX = originX + width - 1 + ring;
    const maxY = originY + height - 1 + ring;
    for (let x = minX; x <= maxX; x++) {
      if (tileSpawnable(passability, size, x, minY)) return { x, y: minY };
    }
    for (let y = minY + 1; y <= maxY; y++) {
      if (tileSpawnable(passability, size, maxX, y)) return { x: maxX, y };
    }
    for (let x = maxX - 1; x >= minX; x--) {
      if (tileSpawnable(passability, size, x, maxY)) return { x, y: maxY };
    }
    for (let y = maxY - 1; y > minY; y--) {
      if (tileSpawnable(passability, size, minX, y)) return { x: minX, y };
    }
  }
  return undefined;
}

/**
 * True when one more queued unit fits under the queue capacity, the
 * population ceiling AND the age gate — shared by the command handler
 * and the TC panel's disabled state.
 */
export function canEnqueueTraining(
  world: World,
  comps: SimComponents,
  buildingEid: number,
  playerId: number = PLAYER_ONE,
): boolean {
  const row = getBuildingRow(world, comps, buildingEid);
  if (!row || row[0] !== playerId) return false;
  const queueConfig = buildingDefOf(buildingIdOfCode(row[1]!)).trainQueue;
  if (!queueConfig) return false;
  const unitDef = unitDefOf(trainableUnitIdFor(queueConfig));
  if (!isDefAgeUnlocked(world, comps, playerId, unitDef.ageGate)) {
    return false;
  }
  const queued = readTrainQueue(world, comps, buildingEid).length;
  if (queued >= queueConfig.capacity) return false;
  return populationOf(world, comps) + queued < populationCapOf(world, comps);
}

function applyTrainCommand(
  world: World,
  comps: SimComponents,
  diagnostics: TrainingDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseTrainData(data);
  const buildings = productionBuildingsOf(world, comps);
  const target =
    parsed.siteEid !== undefined
      ? buildings.find((b) => b.eid === parsed.siteEid)
      : buildings.find((b) => b.playerId === PLAYER_ONE);
  if (!target) {
    throw new Error(
      parsed.siteEid !== undefined
        ? `trainVillager targets entity ${String(parsed.siteEid)}, which is not a finished production building`
        : "trainVillager requires a finished production building (none exists)",
    );
  }

  const def = buildingDefOf(target.defId);
  const queueConfig = def.trainQueue!;
  // M1 trains villagers only; membership in the trainable list keeps it
  // data-driven while the command kind pins intent.
  const unitId = trainableUnitIdFor(queueConfig);
  const unitDef = unitDefOf(unitId);

  // Polite age-gate refusal BEFORE escrow: gated content can reach the
  // sim from laggy clicks or AI probes, so record the digest-visible
  // GateRejected row and return — no cost, no queue entry.
  if (!isDefAgeUnlocked(world, comps, target.playerId, unitDef.ageGate)) {
    appendGateRejection(world, comps, target.playerId, {
      tick: world.tick,
      handler: GATE_HANDLER_TRAIN,
      defCode: unitCodeOf(unitId),
    });
    diagnostics.gateRejections += 1;
    return;
  }

  // Escrow at enqueue (AoE2-faithful); throws when unaffordable.
  payCosts(
    world,
    comps,
    target.playerId,
    unitDef.costs,
    `training a ${unitId}`,
  );

  const entries = readTrainQueue(world, comps, target.eid);
  if (entries.length >= queueConfig.capacity) {
    throw new Error(
      `training queue full at ${def.id}: capacity ${String(queueConfig.capacity)}`,
    );
  }
  if (
    populationOf(world, comps) + entries.length >=
    populationCapOf(world, comps)
  ) {
    throw new Error(
      `training blocked: population ${String(populationOf(world, comps))}/${String(populationCapOf(world, comps))} at cap`,
    );
  }
  entries.push({
    unitCode: unitCodeOf(unitId),
    remainingTicks: unitDef.trainTime,
  });
  writeTrainQueue(world, comps, target.eid, entries);
  diagnostics.commandsApplied += 1;
}

/**
 * Build the training SimSystem. Register after construction so only
 * finished buildings ever carry live queues.
 */
export function createTrainingSystem(
  comps: SimComponents,
  diagnostics: TrainingDiagnostics = createTrainingDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    // ---- 1) Commands consumed exactly on their tick boundary.
    for (const command of commands) {
      if (command.kind !== TRAIN_VILLAGER_KIND) continue;
      if (!command.data) throw new Error("trainVillager requires command data");
      applyTrainCommand(world, comps, diagnostics, command.data);
    }

    // ---- 2) Advance queues ascending eid inside step().
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const trainRows = world.rowsByComponentId.get(comps.trainQueueId);
    if (!trainRows) throw new Error("unregistered TrainQueue component");

    let population = populationOf(world, comps);
    let cap = populationCapOf(world, comps);

    for (const eid of [...trainRows.keys()].sort((a, b) => a - b)) {
      const buildingRow = getBuildingRow(world, comps, eid);
      if (!buildingRow) continue; // no finished building: queue stays frozen
      const entries = readTrainQueue(world, comps, eid);
      if (entries.length === 0) continue;
      const head = entries[0]!;

      if (population < cap && head.remainingTicks > 0) {
        head.remainingTicks -= 1;
        writeTrainQueue(world, comps, eid, entries);
      }

      if (head.remainingTicks <= 0) {
        const rectPos = posRows?.get(eid);
        if (!rectPos) continue;
        const fp = footprintOfDefCode(buildingRow[1]!);
        const originX = rectPos[0]! - fp.width / 2;
        const originY = rectPos[1]! - fp.height / 2;
        const tile = findSpawnTile(
          world,
          originX,
          originY,
          fp.width,
          fp.height,
        );
        if (!tile) continue; // boxed in: retry next tick
        const unitDef = unitDefOf(unitIdOfCode(head.unitCode));
        spawnUnit(world, comps, tile.x + 0.5, tile.y + 0.5, {
          baseSpeed: unitDef.speed,
        });
        population += 1;
        diagnostics.unitsTrained += 1;
        entries.shift();
        writeTrainQueue(world, comps, eid, entries);
      }
    }
  };
}

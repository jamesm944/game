/**
 * Training system — SPEC §2.6/§2.13 / M1-T10, military M2-T6.
 *
 * Production buildings (any finished building whose definition carries
 * a trainQueue config) run an AoE2-style finite queue:
 *
 *   `{kind:"trainVillager"}` → the M1 shape: trains the villager entry.
 *   `{kind:"trainUnit", unitId}` → the M2-T6 generalization: trains any
 *   unit in THAT building's `trainable` list (barracks militia/man-at-
 *   arms, archery-range archer/skirmisher, stable scout/knight), after
 *   validating membership, the age gate and affordability.
 *
 * Both validate + pay costs at ENQUEUE time, then append
 * {unitCode, remainingTicks: trainTime} to the building's TrainQueue
 * row.
 *
 * Each tick, per queue ascending eid:
 *   - the head counts down ONLY while population < popCap — housed
 *     players pause production exactly like AoE2, and the frozen row is
 *     digest-visible so replays see the stall too;
 *   - a head reaching zero spawns its unit at the first free perimeter
 *     tile (pinned clockwise rings around the footprint) and shifts the
 *     queue up; with no free tile the head waits at zero and retries
 *     next tick — deterministic backpressure. Villagers spawn through
 *     the legacy M1 spawner (no Combat row); military units spawn as
 *     full combatants via spawnCombatUnit (SPEC §2.5).
 *
 * Population = live UnitTag rows; popCap = Σ populationCap over
 * FINISHED buildings. Enqueue is REJECTED loudly (gather/placement
 * command discipline) once population + queued ≥ cap or the queue
 * itself is full; age-gated content reaches the sim only as polite
 * digest-visible GateRejected rows. The exported predicates power the
 * UI's disabled buttons.
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
import { spawnCombatUnit, spawnUnit } from "../components";
import { ensureCarryCapacity } from "../components/economy";
import { waterPassabilityWithBuildings } from "../world/navigability";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitCodeOf,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import { isDefAgeUnlocked } from "./age";
import { effectiveCosts, payCosts } from "./costs";
import { canPlayerTrainUnit } from "../core/civilization";
import {
  SET_RALLY_POINT_KIND,
  SET_MULTI_RALLY_POINT_KIND,
  CLEAR_RALLY_POINT_KIND,
  setRallyPoint,
  clearRallyPoint,
  dispatchSpawnedUnitToRally,
} from "../core/rally";
import { PLAYER_ONE } from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kinds owned by this system. */
export const TRAIN_VILLAGER_KIND = "trainVillager";
export const TRAIN_UNIT_KIND = "trainUnit";
export {
  SET_RALLY_POINT_KIND,
  SET_MULTI_RALLY_POINT_KIND,
  CLEAR_RALLY_POINT_KIND,
};

/** Perimeter search depth (in whole-tile rings) for spawn placement. */
export const SPAWN_RING_DEPTH = 3;

export interface TrainingDiagnostics {
  /** trainVillager/trainUnit commands applied. */
  commandsApplied: number;
  /** Units spawned from completed queue heads. */
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
 * The unit this queue config trains when the order names none: the
 * villager entry when present (M1 command-kind intent), else the first
 * listed unit. Shared by the command handler and the enqueue predicate
 * so both always agree.
 */
function defaultTrainableUnitIdFor(queueConfig: TrainQueueConfig): string {
  return queueConfig.trainable.some((entry) => entry.unitId === "villager")
    ? "villager"
    : queueConfig.trainable[0]!.unitId;
}

function parseTrainData(data: Readonly<Record<string, unknown>>): {
  siteEid: number | undefined;
  unitId: string | undefined;
} {
  const raw = data.siteEid;
  if (
    raw !== undefined &&
    (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)
  ) {
    throw new Error(
      `training siteEid must be a positive integer, got ${String(raw)}`,
    );
  }
  let unitId: string | undefined;
  if (data.unitId !== undefined) {
    if (typeof data.unitId !== "string" || data.unitId.length === 0) {
      throw new Error("trainUnit unitId must be a non-empty string");
    }
    unitId = data.unitId;
  }
  return { siteEid: raw as number | undefined, unitId };
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
  customPassability?: Uint8Array,
): { x: number; y: number } | undefined {
  const size = world.layers.size;
  const passability = customPassability ?? world.layers.derivedPassability;
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
 * population ceiling AND the age gate — shared by the command handlers
 * and the production panel's disabled state. `unitId` selects among the
 * building's trainable list; omit it for the M1 default entry.
 */
export function canEnqueueTraining(
  world: World,
  comps: SimComponents,
  buildingEid: number,
  playerId: number = PLAYER_ONE,
  unitId?: string | undefined,
): boolean {
  const row = getBuildingRow(world, comps, buildingEid);
  if (!row || row[0] !== playerId) return false;
  const queueConfig = buildingDefOf(buildingIdOfCode(row[1]!)).trainQueue;
  if (!queueConfig) return false;
  const resolved = unitId ?? defaultTrainableUnitIdFor(queueConfig);
  if (!queueConfig.trainable.some((entry) => entry.unitId === resolved)) {
    return false;
  }
  if (!canPlayerTrainUnit(world, playerId, resolved)) {
    return false;
  }
  const unitDef = unitDefOf(resolved);
  if (!isDefAgeUnlocked(world, comps, playerId, unitDef.ageGate)) {
    return false;
  }
  const queued = readTrainQueue(world, comps, buildingEid).length;
  if (queued >= queueConfig.capacity) return false;
  return (
    populationOf(world, comps, playerId) + queued <
    populationCapOf(world, comps, playerId)
  );
}

function applyTrainCommand(
  world: World,
  comps: SimComponents,
  diagnostics: TrainingDiagnostics,
  kind: string,
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
        ? `${kind} targets entity ${String(parsed.siteEid)}, which is not a finished production building`
        : `${kind} requires a finished production building (none exists)`,
    );
  }

  const def = buildingDefOf(target.defId);
  const queueConfig = def.trainQueue!;
  // Membership in the trainable list keeps this data-driven: trainUnit
  // names its unit explicitly; trainVillager pins the M1 intent.
  const unitId = parsed.unitId ?? defaultTrainableUnitIdFor(queueConfig);
  if (!queueConfig.trainable.some((entry) => entry.unitId === unitId)) {
    throw new Error(`${def.id} does not train ${unitId}`);
  }
  if (!canPlayerTrainUnit(world, target.playerId, unitId)) {
    throw new Error(
      `player ${String(target.playerId)} cannot train ${unitId}: civilization restriction`,
    );
  }
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
  const costs = effectiveCosts(world, target.playerId, unitDef);
  payCosts(world, comps, target.playerId, costs, `training a ${unitId}`);

  const entries = readTrainQueue(world, comps, target.eid);
  if (entries.length >= queueConfig.capacity) {
    throw new Error(
      `training queue full at ${def.id}: capacity ${String(queueConfig.capacity)}`,
    );
  }
  if (
    populationOf(world, comps, target.playerId) + entries.length >=
    populationCapOf(world, comps, target.playerId)
  ) {
    throw new Error(
      `training blocked: population ${String(populationOf(world, comps, target.playerId))}/${String(populationCapOf(world, comps, target.playerId))} at cap`,
    );
  }
  entries.push({
    unitCode: unitCodeOf(unitId),
    remainingTicks: unitDef.trainTime,
  });
  writeTrainQueue(world, comps, target.eid, entries);
  diagnostics.commandsApplied += 1;
}

function applySetRallyCommand(
  world: World,
  comps: SimComponents,
  data: Readonly<Record<string, unknown>>,
): void {
  const bEid = data.buildingEid;
  if (typeof bEid !== "number" || !Number.isInteger(bEid) || bEid < 1) {
    throw new Error(
      `setRallyPoint buildingEid must be a positive integer, got ${String(bEid)}`,
    );
  }
  const x = data.x;
  const y = data.y;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    throw new Error(
      `setRallyPoint coordinates must be finite numbers, got (${String(x)}, ${String(y)})`,
    );
  }
  const targetEntityId =
    data.targetEntityId !== undefined
      ? typeof data.targetEntityId === "number" &&
        Number.isInteger(data.targetEntityId) &&
        data.targetEntityId > 0
        ? data.targetEntityId
        : undefined
      : undefined;

  const row = getBuildingRow(world, comps, bEid);
  if (!row) {
    throw new Error(
      `setRallyPoint targets entity ${String(bEid)}, which is not a finished building`,
    );
  }
  const def = buildingDefOf(buildingIdOfCode(row[1]!));
  if (!def.trainQueue) {
    throw new Error(`building ${def.id} does not have a production queue`);
  }

  setRallyPoint(world, bEid, { x, y, targetEntityId });
}

function applySetMultiRallyCommand(
  world: World,
  comps: SimComponents,
  data: Readonly<Record<string, unknown>>,
): void {
  const bEids = data.buildingEids;
  if (!Array.isArray(bEids) || bEids.length === 0) {
    throw new Error(
      "setMultiRallyPoint buildingEids must be a non-empty array",
    );
  }
  const x = data.x;
  const y = data.y;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    throw new Error(
      `setMultiRallyPoint coordinates must be finite numbers, got (${String(x)}, ${String(y)})`,
    );
  }
  const targetEntityId =
    data.targetEntityId !== undefined
      ? typeof data.targetEntityId === "number" &&
        Number.isInteger(data.targetEntityId) &&
        data.targetEntityId > 0
        ? data.targetEntityId
        : undefined
      : undefined;

  for (const bEid of bEids) {
    if (typeof bEid !== "number" || !Number.isInteger(bEid) || bEid < 1)
      continue;
    const row = getBuildingRow(world, comps, bEid);
    if (!row) continue;
    const def = buildingDefOf(buildingIdOfCode(row[1]!));
    if (!def.trainQueue) continue;
    setRallyPoint(world, bEid, { x, y, targetEntityId });
  }
}

function applyClearRallyCommand(
  world: World,
  data: Readonly<Record<string, unknown>>,
): void {
  const bEid = data.buildingEid;
  if (typeof bEid === "number" && Number.isInteger(bEid) && bEid >= 1) {
    clearRallyPoint(world, bEid);
  }
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
      if (command.kind === TRAIN_VILLAGER_KIND) {
        if (!command.data)
          throw new Error("trainVillager requires command data");
        applyTrainCommand(
          world,
          comps,
          diagnostics,
          command.kind,
          command.data,
        );
      } else if (command.kind === TRAIN_UNIT_KIND) {
        if (!command.data) throw new Error("trainUnit requires command data");
        applyTrainCommand(
          world,
          comps,
          diagnostics,
          command.kind,
          command.data,
        );
      } else if (command.kind === SET_RALLY_POINT_KIND) {
        if (!command.data)
          throw new Error("setRallyPoint requires command data");
        applySetRallyCommand(world, comps, command.data);
      } else if (command.kind === SET_MULTI_RALLY_POINT_KIND) {
        if (!command.data)
          throw new Error("setMultiRallyPoint requires command data");
        applySetMultiRallyCommand(world, comps, command.data);
      } else if (command.kind === CLEAR_RALLY_POINT_KIND) {
        if (!command.data)
          throw new Error("clearRallyPoint requires command data");
        applyClearRallyCommand(world, command.data);
      }
    }

    // ---- 2) Advance queues ascending eid inside step(). Housing gates
    // are PER OWNER (M2-T9): each player's population counts against
    // its own buildings' caps — a rival's town center no longer houses
    // our training. Owner tallies are memoized per tick.
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const trainRows = world.rowsByComponentId.get(comps.trainQueueId);
    if (!trainRows) throw new Error("unregistered TrainQueue component");

    const popByOwner = new Map<number, number>();
    const capByOwner = new Map<number, number>();
    const populationFor = (owner: number): number => {
      let value = popByOwner.get(owner);
      if (value === undefined) {
        value = populationOf(world, comps, owner);
        popByOwner.set(owner, value);
      }
      return value;
    };
    const capFor = (owner: number): number => {
      let value = capByOwner.get(owner);
      if (value === undefined) {
        value = populationCapOf(world, comps, owner);
        capByOwner.set(owner, value);
      }
      return value;
    };

    for (const eid of [...trainRows.keys()].sort((a, b) => a - b)) {
      const buildingRow = getBuildingRow(world, comps, eid);
      if (!buildingRow) continue; // no finished building: queue stays frozen
      const entries = readTrainQueue(world, comps, eid);
      if (entries.length === 0) continue;
      const head = entries[0]!;
      const owner = buildingRow[0]!;

      if (populationFor(owner) < capFor(owner) && head.remainingTicks > 0) {
        head.remainingTicks -= 1;
        writeTrainQueue(world, comps, eid, entries);
      }

      if (head.remainingTicks <= 0) {
        const rectPos = posRows?.get(eid);
        if (!rectPos) continue;
        const fp = footprintOfDefCode(buildingRow[1]!);
        const originX = rectPos[0]! - fp.width / 2;
        const originY = rectPos[1]! - fp.height / 2;
        const unitId = unitIdOfCode(head.unitCode);
        const unitDef = unitDefOf(unitId);
        const isNaval = unitDef.armorClasses?.includes("ship");
        const customPass = isNaval
          ? waterPassabilityWithBuildings(world, comps)
          : undefined;
        const tile = findSpawnTile(
          world,
          originX,
          originY,
          fp.width,
          fp.height,
          customPass,
        );
        if (!tile) continue; // boxed in: retry next tick
        const spawnedEid = spawnTrainedUnit(
          world,
          comps,
          unitId,
          tile.x + 0.5,
          tile.y + 0.5,
          buildingRow[0]!,
        );
        popByOwner.set(owner, populationFor(owner) + 1);
        diagnostics.unitsTrained += 1;
        entries.shift();
        writeTrainQueue(world, comps, eid, entries);
        dispatchSpawnedUnitToRally(world, comps, spawnedEid, eid, unitId);
      }
    }
  };
}

/**
 * Spawn one completed queue head: villagers ride the legacy M1 spawner
 * (no Combat row — they stay untargetable per the M2-T5 contract);
 * every other definition spawns as a full combatant owned by the
 * producing building's player (SPEC §2.5).
 */
function spawnTrainedUnit(
  world: World,
  comps: SimComponents,
  unitId: string,
  x: number,
  y: number,
  playerId: number,
): number {
  if (unitId === "villager") {
    return spawnUnit(world, comps, x, y, {
      baseSpeed: unitDefOf(unitId).speed,
      // M2-T9: non-zero owners stamp an explicit Owner row so the
      // producing player's economy can attribute (and manage) its own
      // villagers; player zero stays rowless for digest stability.
      ownerId: playerId,
      // M3-T1: trained villagers are named Pops with seeded traits.
      identity: true,
      // M3-T4: trained villagers carry the wound model.
      body: true,
    });
  }
  const eid = spawnCombatUnit(world, comps, unitId, x, y, playerId, {
    // M3-T4: trained soldiers carry the wound model too.
    body: true,
  });
  const def = unitDefOf(unitId);
  if (
    def.carryCapacity !== undefined &&
    def.carryCapacity > 0 &&
    typeof comps.carryCapacityId === "number"
  ) {
    ensureCarryCapacity(world, comps, eid, def.carryCapacity);
  }
  return eid;
}

/**
 * Component definitions — SPEC §2.1/§2.2/§2.6.
 *
 * Components register through the world ComponentRegistry, whose
 * alphabetical enforcement pins the digest/save iteration order forever
 * (world.ts). Because the registry validates ONE strictly ascending
 * sequence per world, movement + economy + stockpile components
 * register interleaved via defineSimComponents:
 *
 *   ActivityQueue, AssignedNode, CarryCapacity, DropOff, Inventory,
 *   MoveTarget, Position, ResourceNode, Stockpile, UnitTag, Velocity
 *
 * Per ADR-0001 the hand-rolled row store is the sanctioned M1 component
 * store — bitecs slots in behind this same registration surface later
 * without touching call sites or fixtures.
 *
 * Movement row layouts (arity is part of the digest contract):
 * - ActivityQueue (variable): encoded activity stream — see activities/.
 * - MoveTarget (2): final destination x,y in float tile coordinates.
 * - Position (2): current x,y float tile coordinates.
 * - UnitTag (3): [baseSpeed tiles/s, turnRate rad/s, radius tiles].
 * - Velocity (8): [headingRad, speedTilesPerSec, stalledTicks,
 *   parkedContactTicks, closeArrivalTicks, avoidSide, avoidTicksLeft,
 *   propagationParked] — motion state + steering FSM bookkeeping.
 * Economy/stockpile layouts live beside their modules (economy.ts,
 * core/stockpile.ts).
 */

import {
  decodeActivities,
  encodeActivities,
  type Activity,
} from "../activities";
import {
  ASSIGNED_SITE,
  BUILDING,
  BUILDING_COMPONENT_ARITIES,
  BUILDING_SITE,
  TRAIN_QUEUE,
  type BuildingComponents,
} from "./buildings";
import {
  ASSIGNED_NODE,
  CARRY_CAPACITY,
  INVENTORY,
  RESOURCE_NODE,
  type EconomyComponents,
} from "./economy";
import {
  DROP_OFF,
  STOCKPILE,
  type StockpileComponents,
} from "../core/stockpile";
import { defineComponent, spawnEntity, type World } from "../core/world";

export const ACTIVITY_QUEUE = "ActivityQueue" as const;
export const MOVE_TARGET = "MoveTarget" as const;
export const POSITION = "Position" as const;
export const UNIT_TAG = "UnitTag" as const;
export const VELOCITY = "Velocity" as const;

/** Row arity per movement component — pinned for digest stability. */
export const MOVEMENT_COMPONENT_ARITIES: readonly [string, number][] = [
  [ACTIVITY_QUEUE, -1], // variable-length encoded stream
  [MOVE_TARGET, 2],
  [POSITION, 2],
  [UNIT_TAG, 3],
  [VELOCITY, 8],
];

/**
 * Every component family's arities in one table, in canonical registry
 * order — documentation of the digest contract, re-validated by the
 * registry's alphabetical enforcement at registration time.
 */
export const SIM_COMPONENT_ARITIES: readonly [string, number][] = [
  ...MOVEMENT_COMPONENT_ARITIES,
  ...BUILDING_COMPONENT_ARITIES,
];

export interface MovementComponents {
  readonly activityQueueId: number;
  readonly moveTargetId: number;
  readonly positionId: number;
  readonly unitTagId: number;
  readonly velocityId: number;
}

/** Every component id the M1 sim reads/writes. */
export interface SimComponents
  extends
    MovementComponents,
    EconomyComponents,
    StockpileComponents,
    BuildingComponents {}

/**
 * Register ALL sim components in one strictly alphabetical sequence —
 * the registry re-validates order and would throw on any regression.
 * The single canonical entry point for production worlds AND fixtures.
 */
export function defineSimComponents(world: World): SimComponents {
  return {
    activityQueueId: defineComponent(world, ACTIVITY_QUEUE),
    assignedNodeId: defineComponent(world, ASSIGNED_NODE),
    assignedSiteId: defineComponent(world, ASSIGNED_SITE),
    buildingId: defineComponent(world, BUILDING),
    buildingSiteId: defineComponent(world, BUILDING_SITE),
    carryCapacityId: defineComponent(world, CARRY_CAPACITY),
    dropoffId: defineComponent(world, DROP_OFF),
    inventoryId: defineComponent(world, INVENTORY),
    moveTargetId: defineComponent(world, MOVE_TARGET),
    positionId: defineComponent(world, POSITION),
    resourceNodeId: defineComponent(world, RESOURCE_NODE),
    stockpileId: defineComponent(world, STOCKPILE),
    trainQueueId: defineComponent(world, TRAIN_QUEUE),
    unitTagId: defineComponent(world, UNIT_TAG),
    velocityId: defineComponent(world, VELOCITY),
  };
}

/**
 * Legacy movement-only alias. Registers the full set (the registry has
 * no partial sequences) and returns it — structurally a superset of
 * MovementComponents, so existing call sites keep compiling unchanged.
 */
export function defineMovementComponents(world: World): SimComponents {
  return defineSimComponents(world);
}

function requireRow(
  world: World,
  componentId: number,
  eid: number,
  label: string,
): number[] {
  const values = world.rowsByComponentId.get(componentId)?.get(eid);
  if (!values) {
    throw new Error(`entity ${String(eid)} has no ${label} row`);
  }
  return values;
}

export function getPosition(
  world: World,
  comps: MovementComponents,
  eid: number,
): { x: number; y: number } {
  const row = requireRow(world, comps.positionId, eid, POSITION);
  return { x: row[0]!, y: row[1]! };
}

export function setPosition(
  world: World,
  comps: MovementComponents,
  eid: number,
  x: number,
  y: number,
): void {
  const row = requireRow(world, comps.positionId, eid, POSITION);
  row[0] = x;
  row[1] = y;
}

export function getVelocityRow(
  world: World,
  comps: MovementComponents,
  eid: number,
): number[] {
  return requireRow(world, comps.velocityId, eid, VELOCITY);
}

export function getUnitTagRow(
  world: World,
  comps: MovementComponents,
  eid: number,
): number[] {
  return requireRow(world, comps.unitTagId, eid, UNIT_TAG);
}

/** Final destination of the active order (MoveTarget row). */
export function getMoveTarget(
  world: World,
  comps: MovementComponents,
  eid: number,
): { x: number; y: number } | undefined {
  const row = world.rowsByComponentId.get(comps.moveTargetId)?.get(eid);
  if (!row) return undefined;
  return { x: row[0]!, y: row[1]! };
}

export function setMoveTarget(
  world: World,
  comps: MovementComponents,
  eid: number,
  x: number,
  y: number,
): void {
  requireRow(world, comps.moveTargetId, eid, MOVE_TARGET);
  setComponentValuesById(world, comps.moveTargetId, eid, [x, y]);
}

/** Decoded activity queue for one entity (fresh copy each call). */
export function readActivityQueue(
  world: World,
  comps: MovementComponents,
  eid: number,
): Activity[] {
  const row = world.rowsByComponentId.get(comps.activityQueueId)?.get(eid);
  if (!row) return [];
  return decodeActivities(row);
}

export function writeActivityQueue(
  world: World,
  comps: MovementComponents,
  eid: number,
  queue: readonly Activity[],
): void {
  requireRow(world, comps.activityQueueId, eid, ACTIVITY_QUEUE);
  setComponentValuesById(
    world,
    comps.activityQueueId,
    eid,
    encodeActivities(queue),
  );
}

function setComponentValuesById(
  world: World,
  componentId: number,
  eid: number,
  values: readonly number[],
): void {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows)
    throw new Error(`unregistered component id: ${String(componentId)}`);
  rows.set(eid, [...values]);
}

export interface SpawnUnitOptions {
  /** Base cruise speed in tiles per second (M1 default 1.0). */
  readonly baseSpeed?: number | undefined;
  /** Individual turn rate in rad/s; defaults to a seed+eid hash in [5.5, 8.5]. */
  readonly turnRate?: number | undefined;
  /** Body radius in tiles used by separation/push-apart. */
  readonly radius?: number | undefined;
}

/** Default M1 unit speed — SPEC ticket: 1.0 tile/sec constant. */
export const DEFAULT_UNIT_SPEED = 1.0;

/** Turn-rate personality band ported from the validated prototype feel. */
export const TURN_RATE_MIN = 5.5;
export const TURN_RATE_VARIANCE = 3.0; // → individual rates in [5.5, 8.5]

const TURN_RATE_HASH_MULTIPLIER = 0x9e3779b9;

function defaultTurnRate(seed: number, eid: number): number {
  // Pure function of (seed, eid): no shared-stream coupling at spawn.
  let z = (seed ^ Math.imul(eid, TURN_RATE_HASH_MULTIPLIER)) >>> 0 || 0x1;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  const unit = ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  return TURN_RATE_MIN + unit * TURN_RATE_VARIANCE;
}

/** Spawn one movable Pop with every movement component attached. */
export function spawnUnit(
  world: World,
  comps: MovementComponents,
  x: number,
  y: number,
  options: SpawnUnitOptions = {},
): number {
  const eid = spawnEntity(world);
  const rows = (id: number, values: number[]): void => {
    setComponentValuesById(world, id, eid, values);
  };
  rows(comps.positionId, [x, y]);
  // heading east (0 rad), idle; FSM counters zeroed; no committed side.
  rows(comps.velocityId, [0, 0, 0, 0, 0, 0, 0, 0]);
  rows(comps.unitTagId, [
    options.baseSpeed ?? DEFAULT_UNIT_SPEED,
    options.turnRate ?? defaultTurnRate(world.seed, eid),
    options.radius ?? DEFAULT_UNIT_RADIUS,
  ]);
  rows(comps.moveTargetId, [x, y]);
  rows(comps.activityQueueId, encodeActivities([]));
  return eid;
}

/** Default body radius in tiles (units keep ≥ 0.5-tile clearance). */
export const DEFAULT_UNIT_RADIUS = 0.25;

export * from "./economy";
export * from "./buildings";

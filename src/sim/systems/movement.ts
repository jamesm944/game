/**
 * Movement system — SPEC §2.2 / ADR-0003 phase 1 (sim-side).
 *
 * Per 30 Hz tick, ascending eid:
 *   0. apply due path responses through the PathScheduler (ascending-id,
 *      dueTick-gated — handled by world.step() just before this system)
 *   1. consume `groupMove` commands → ONE leader A* request through the
 *      FIFO path worker; slots are dealt when the response lands
 *   2. activity-queue steering: turn-rate-limited heading arcs, ease-in
 *      acceleration, sqrt braking near arrival, waypoint consumption
 *   3. steering layer: per-tick spatial hash (2-tile cells) driving boid
 *      separation (~1 tile), symmetric positional push-apart on overlap,
 *      impassable-tile clamping with axis slide
 *   4. FSM resolution: Moving / Stalled (>45 ticks → seeded sidestep +
 *      individual re-path) / Parked (idle, or propagated backward through
 *      contact after ~0.7 s stalled against a parked unit)
 *
 * All searches flow through the injected PathScheduler (worker or
 * synchronous fallback — byte-identical results either way). While a
 * path is in flight the affected Pops hold position deterministically.
 *
 * Determinism: all randomness comes from the world PRNG stream plus
 * pure per-request seeds derived from (worldSeed, tiles, issueTick),
 * trig from core/trig (IEEE basic ops only), iteration order is pinned,
 * and every constant below is a documented tuning value.
 */

import {
  cancelActivities,
  dequeueCurrentActivity,
  moveActivity,
  peekActivity,
  type Activity,
} from "../activities";
import {
  getMoveTarget,
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type MovementComponents,
} from "../components";
import {
  angleDelta,
  buildSinCosLut,
  detAtan2,
  detCos,
  detSin,
  HALF_PI,
  wrapAngle,
} from "../core/trig";
import { TICK_HZ, type SimSystem, type World } from "../core/world";
import type { SimCommand } from "../core/inbox";
import { type BodyComponents, injuryImpairmentOf } from "../components/body";
import { type OwnerComponents, ownerOfUnit } from "../components/owner";
import { type BuildingComponents } from "../components/buildings";
import {
  type GarrisonComponents,
  addGarrisonedUnit,
  readGarrison,
} from "../components/garrison";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import { despawnEntity } from "../core/world";
import { isNavalUnit, type CombatComponents } from "../components/combat";
import type { StanceComponents } from "../components/stance";
import { passabilityForPlayer } from "./placement";
import { waterPassabilityWithBuildings } from "../world/navigability";
import { hasLineOfSight } from "../path/astar";
import type { PathScheduler } from "../path/scheduler";

/** Seconds per sim tick. */
const TICK_DT = 1 / TICK_HZ;

// ---- Prototype-validated locomotion feel constants -------------------------

/** Boid separation influence radius in tiles. */
export const SEPARATION_RADIUS = 1.0;
/** Spatial hash cell edge in tiles; rebuilt every tick (SPEC §2.2). */
export const SPATIAL_HASH_CELL = 2;
/** Separation drift speed at full weight, tiles/s. */
const SEPARATION_DRIFT_RATE = 1.5;
/** Stalled ticks before a seeded sidestep + individual re-path (~1.5 s). */
export const STALL_SIDESTEP_TICKS = 45;
/**
 * Committed-side avoidance hysteresis AND Parked propagation delay
 * (~0.7 s): a unit keeps its chosen yield side this many ticks, and a
 * mover stalled against a Parked unit for this long halts instead of
 * shoving forever.
 */
export const AVOIDANCE_COMMIT_TICKS = 21;
/** Ease-in acceleration limit, tiles/s². */
const ACCEL_TILES_PER_S2 = 3.0;
/** Sqrt-braking profile deceleration, tiles/s² (v = √(2·a·d)). */
const BRAKE_DECEL_TILES_PER_S2 = 2.0;
/** Intermediate waypoints complete within this distance, tiles. */
const WAYPOINT_REACH_RADIUS = 0.35;
/** Final waypoint arrival tolerance, tiles. */
const FINAL_ARRIVAL_RADIUS = 0.08;
/** "Close to goal" zone that freezes stall counting, tiles. */
const APPROACH_RADIUS = 0.4;
/** Consecutive close-to-goal ticks before forced arrival (anti-orbit). */
const ARRIVAL_GRACE_TICKS = 20;
/** Sidestep nudge distance, tiles. */
const SIDESTEP_DISTANCE = 0.6;
/** Per-tick steering displacement treated as real progress, tiles. */
const PROGRESS_EPSILON = 1e-4;
/**
 * Exponential-moving-average smoothing of net per-tick displacement
 * (~10-tick memory): shoving equilibria alternate forward/backward and
 * must classify as blocked, while steady walking stays well above the
 * bar.
 */
const NET_PROGRESS_SMOOTHING = 0.1;
/** Smoothed forward displacement treated as real progress, tiles. */
const NET_PROGRESS_EPSILON = 0.005;
/**
 * Stalled-tick decay when progress resumes: brief oscillations while
 * shoving through a crowd must not reset the ladder, but clean walking
 * bleeds the counter away fast.
 */
const STALL_DECAY_PER_TICK = 3;
/** Extra clearance beyond radii sum before units count as touching. */
const PARKED_CONTACT_MARGIN = 0.25;
/** Minimum turn-slow factor when facing away from the target. */
const TURN_SLOW_MIN = 0.35;

// ---- Formation slots --------------------------------------------------------

/** Sin/cos LUT granularity for ring slot angles (SPEC §2.2). */
export const SLOT_LUT_SIZE = 256;
/** Radial spacing between concentric rings, tiles. */
export const SLOT_RING_SPACING = 0.9;

const SLOT_LUT = buildSinCosLut(SLOT_LUT_SIZE);

/**
 * Concentric-ring slot offset for the unit dealt slot `index` around a
 * destination: slot 0 sits at the center; ring k holds 8k slots evenly
 * spaced through the LUT, odd rings rotated half a step.
 */
export function formationSlotOffset(index: number): { dx: number; dy: number } {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `slot index must be a non-negative integer, got ${String(index)}`,
    );
  }
  if (index === 0) return { dx: 0, dy: 0 };
  let ring = 1;
  let positionInRing = index - 1;
  while (positionInRing >= 8 * ring) {
    positionInRing -= 8 * ring;
    ring += 1;
  }
  const countInRing = 8 * ring;
  const halfStep = Math.floor(SLOT_LUT_SIZE / (2 * countInRing));
  const lutIndex =
    (Math.floor((positionInRing * SLOT_LUT_SIZE) / countInRing) +
      (ring % 2) * halfStep) %
    SLOT_LUT_SIZE;
  return {
    dx: SLOT_LUT.cos[lutIndex]! * SLOT_RING_SPACING * ring,
    dy: SLOT_LUT.sin[lutIndex]! * SLOT_RING_SPACING * ring,
  };
}

// ---- Velocity row layout (see components/index.ts) --------------------------

const V_HEADING = 0;
const V_SPEED = 1;
const V_STALLED_TICKS = 2;
const V_PARK_CONTACT_TICKS = 3;
const V_CLOSE_TICKS = 4;
const V_AVOID_SIDE = 5;
const V_AVOID_TICKS_LEFT = 6;
const V_PROPAGATION_PARKED = 7;

/**
 * Zero every steering-FSM counter for one unit's Velocity row. A fresh
 * order (groupMove, gather chain) invalidates all prior avoidance/
 * stall/arrival bookkeeping — shared by every system that rewrites a
 * unit's activity queue.
 */
export function resetSteeringBookkeeping(velRow: number[]): void {
  velRow[V_STALLED_TICKS] = 0;
  velRow[V_PARK_CONTACT_TICKS] = 0;
  velRow[V_CLOSE_TICKS] = 0;
  velRow[V_PROPAGATION_PARKED] = 0;
}

/**
 * True when the steering FSM classifies this unit as jammed: deep in
 * the stall ladder, sustaining contact with a parked body, or halted
 * by Parked-contact propagation. Heuristic thresholds sit below the
 * movement system's own escalation points (sidestep at 45, propagation
 * at 21) so callers react before recovery churn begins. Consumed by
 * the gather system's congested-delivery unload.
 */
export function isSteeringJammed(velRow: readonly number[]): boolean {
  return (
    velRow[V_STALLED_TICKS]! >= 30 ||
    velRow[V_PARK_CONTACT_TICKS]! >= 15 ||
    velRow[V_PROPAGATION_PARKED] !== 0
  );
}

const T_RADIUS = 2;

interface UnitState {
  readonly eid: number;
  readonly posRow: number[];
  readonly velRow: number[];
  readonly tagRow: number[];
  x: number;
  y: number;
  heading: number;
  speed: number;
  radius: number;
  /** Position at the start of this tick's steering pass. */
  tickStartX: number;
  tickStartY: number;
  /** Unit vector toward this tick's steering target. */
  desiredDirX: number;
  desiredDirY: number;
  /** True while inside the final-approach zone (stall counting frozen). */
  inApproachZone: boolean;
  /** EMA of net per-tick displacement (see NET_PROGRESS_SMOOTHING). */
  emaNetX: number;
  emaNetY: number;
  progressed: boolean;
  contactWithParked: boolean;
  accumulatedSepX: number;
  accumulatedSepY: number;
  queue: Activity[];
  queueDirty: boolean;
  readonly passability: Uint8Array;
  despawned?: boolean;
}

/** Movement heads the steering layer drives (attackMove rides along). */
function isMovementHead(activity: Activity | undefined): boolean {
  return activity !== undefined && isMovementKind(activity.kind);
}

function isMovementKind(kind: Activity["kind"]): boolean {
  return kind === "move" || kind === "attackMove";
}

/** A unit can steer only while its head activity is a movement head. */
function isSteerable(unit: UnitState): boolean {
  return (
    isMovementHead(unit.queue[0]) && unit.velRow[V_PROPAGATION_PARKED] === 0
  );
}

function tileIsPassable(
  passability: Uint8Array,
  size: number,
  x: number,
  y: number,
): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return passability[y * size + x] === 1;
}

/**
 * Move a unit toward (nx, ny), sliding along impassable tiles axis by
 * axis instead of snapping: full move → horizontal slide → vertical
 * slide → stay put. Units are therefore always on passable tiles.
 */
function tryMove(
  unit: UnitState,
  nx: number,
  ny: number,
  passability: Uint8Array,
  size: number,
): void {
  const tx = Math.floor(nx);
  const ty = Math.floor(ny);
  if (tileIsPassable(passability, size, tx, ty)) {
    unit.x = nx;
    unit.y = ny;
    unit.posRow[0] = nx;
    unit.posRow[1] = ny;
    return;
  }
  if (tileIsPassable(passability, size, tx, Math.floor(unit.y))) {
    unit.x = nx;
    unit.posRow[0] = nx;
    return;
  }
  if (tileIsPassable(passability, size, Math.floor(unit.x), ty)) {
    unit.y = ny;
    unit.posRow[1] = ny;
    return;
  }
}

// ---- Diagnostics ------------------------------------------------------------

export interface MovementDiagnostics {
  /** Sidestep nudges attempted after stall timeouts. */
  sidesteps: number;
  /** Individual re-paths issued (stall recovery + blocked segments). */
  repaths: number;
  /** groupMove commands applied. */
  groupMoves: number;
}

export function createMovementDiagnostics(): MovementDiagnostics {
  return { sidesteps: 0, repaths: 0, groupMoves: 0 };
}

// ---- Path request seeding ---------------------------------------------------

/**
 * Pure child seed for one path request, mixed from the world seed, the
 * tile indices and the issuing tick (splitmix32-style avalanche, same
 * shape as component defaultTurnRate). Drawing nothing from the world
 * PRNG keeps the tick stream untouched by path traffic.
 */
function derivePathSeed(
  worldSeed: number,
  startTile: number,
  goalTile: number,
  issueTick: number,
): number {
  let z =
    (worldSeed ^
      Math.imul(startTile, 0x85ebca6b) ^
      Math.imul(goalTile, 0xc2b2ae35) ^
      Math.imul(issueTick, 0x27d4eb2f)) >>>
    0;
  if (z === 0) z = 0x1;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

// ---- group route pipeline ----------------------------------------------------

export interface GroupRouteOrder {
  readonly entityIds: readonly number[];
  readonly x: number;
  readonly y: number;
}

/**
 * Caller hooks adapting the shared route pipeline (M2-T6): plain moves
 * write Move heads; attack-marches write combat-ready attackMove heads
 * and clear engagements at issue time.
 */
export interface GroupRouteHooks {
  /**
   * Extra per-member writes at ISSUE time, before any path response
   * lands (explicit orders release job claims immediately). Closures
   * capture their own world/comps.
   */
  readonly onIssue?: (eid: number) => void;
  /** Head activity written for one member's dealt waypoints. */
  readonly buildHead: (waypoints: number[]) => Activity;
}

function parseGroupMoveData(
  data: Readonly<Record<string, unknown>>,
): GroupRouteOrder {
  const rawIds = data.entityIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("groupMove requires a non-empty entityIds array");
  }
  const entityIds: number[] = [];
  for (const id of rawIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `groupMove entityIds entries must be positive integers, got ${String(id)}`,
      );
    }
    if (!entityIds.includes(id)) entityIds.push(id);
  }
  entityIds.sort((a, b) => a - b);
  const x = data.x;
  const y = data.y;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    throw new Error("groupMove requires finite numeric x/y destination");
  }
  return { entityIds, x, y };
}

/** Nearest passable tile to (tx, ty) by expanding square rings, or null. */
function nearestPassableTile(
  passability: Uint8Array,
  size: number,
  tx: number,
  ty: number,
): { x: number; y: number } | undefined {
  const clampedX = Math.min(Math.max(tx, 0), size - 1);
  const clampedY = Math.min(Math.max(ty, 0), size - 1);
  for (let radius = 0; radius <= size; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Only the perimeter of each expanding ring needs checking.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = clampedX + dx;
        const y = clampedY + dy;
        if (tileIsPassable(passability, size, x, y)) return { x, y };
      }
    }
  }
  return undefined;
}

/**
 * The ONE leader-path + formation-slot pipeline behind groupMove AND
 * the M2-T6 formation attack-move: pick the leader nearest the centroid
 * (ascending-eid tiebreak), resolve start/goal tiles, then issue ONE
 * octile A* request through the path scheduler. When its response
 * applies (ascending-id, dueTick ≤ tick), deal concentric-ring slots to
 * every Pop sorted ascending-eid (leader on slot 0) and enqueue one
 * `hooks.buildHead(...)` activity per Pop whose final waypoint is the
 * slot-adjusted destination.
 *
 * Member positions are captured at ISSUE time and reused at
 * application: between the two, this continuation is the only writer of
 * the members' queues, so both modes (worker and synchronous fallback)
 * observe identical inputs regardless of what the Pops were still doing
 * from an earlier order during the latency window.
 */
export function issueGroupRoute(
  world: World,
  comps: MovementComponents &
    Partial<OwnerComponents> &
    Partial<BuildingComponents> &
    Partial<CombatComponents>,
  diagnostics: MovementDiagnostics | undefined,
  paths: PathScheduler,
  order: GroupRouteOrder,
  hooks: GroupRouteHooks,
): void {
  const { x, y } = order;
  const size = world.layers.size;

  const members: { eid: number; x: number; y: number }[] = [];
  for (const eid of order.entityIds) {
    const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    const queueRow = world.rowsByComponentId
      .get(comps.activityQueueId)
      ?.get(eid);
    if (!posRow || !velRow || !queueRow) continue; // not a live unit
    members.push({ eid, x: posRow[0]!, y: posRow[1]! });
  }
  if (members.length === 0) return;

  // Leader selection: nearest the centroid, strict `<` keeps the
  // lowest eid among exact ties (members ascend by eid).
  let centroidX = 0;
  let centroidY = 0;
  for (const member of members) {
    centroidX += member.x;
    centroidY += member.y;
  }
  centroidX /= members.length;
  centroidY /= members.length;
  let leader = members[0]!;
  let leaderDistanceSq = Infinity;
  for (const member of members) {
    const dx = member.x - centroidX;
    const dy = member.y - centroidY;
    const d2 = dx * dx + dy * dy;
    if (d2 < leaderDistanceSq) {
      leaderDistanceSq = d2;
      leader = member;
    }
  }

  const startTileX = Math.floor(leader.x);
  const startTileY = Math.floor(leader.y);
  const leaderOwner =
    comps.ownerId !== undefined
      ? ownerOfUnit(world, { ownerId: comps.ownerId }, leader.eid)
      : 0;
  const isNaval = isNavalUnit(world, comps, leader.eid);
  const passability = isNaval
    ? waterPassabilityWithBuildings(world, comps)
    : comps.buildingId !== undefined
      ? passabilityForPlayer(
          world,
          {
            buildingId: comps.buildingId,
            buildingSiteId: comps.buildingSiteId,
            positionId: comps.positionId,
          },
          leaderOwner,
        )
      : world.layers.derivedPassability;
  if (!tileIsPassable(passability, size, startTileX, startTileY)) return;
  const goal = nearestPassableTile(
    passability,
    size,
    Math.floor(x),
    Math.floor(y),
  );
  if (!goal) return;

  if (hooks.onIssue !== undefined) {
    for (const member of members) {
      hooks.onIssue(member.eid);
    }
  }

  // Deal slots: leader on the center slot, remaining Pops ascending.
  const ordered = [leader, ...members.filter((member) => member !== leader)];

  paths.requestPath(
    {
      startX: startTileX,
      startY: startTileY,
      goalX: goal.x,
      goalY: goal.y,
    },
    {
      issueTick: world.tick,
      seed: derivePathSeed(
        world.seed,
        startTileY * size + startTileX,
        goal.y * size + goal.x,
        world.tick,
      ),
      passability,
      onApply: (response): void => {
        if (!response.ok) return; // unreachable destination: command is a no-op

        if (diagnostics !== undefined) diagnostics.groupMoves += 1;
        // Pulled waypoints are tile indices; activities steer in continuous
        // coordinates, so convert every pair to its tile center first.
        const sharedWaypoints: number[] = [];
        for (let k = 0; k < response.waypoints.length; k += 2) {
          sharedWaypoints.push(
            response.waypoints[k]! + 0.5,
            response.waypoints[k + 1]! + 0.5,
          );
        }

        for (let slotIndex = 0; slotIndex < ordered.length; slotIndex++) {
          const member = ordered[slotIndex]!;
          const offset = formationSlotOffset(slotIndex);
          const finalX = x + offset.dx;
          const finalY = y + offset.dy;
          const velRow = world.rowsByComponentId
            .get(comps.velocityId)
            ?.get(member.eid);
          if (!velRow) continue;
          // A fresh order clears all steering-FSM bookkeeping.
          resetSteeringBookkeeping(velRow);
          // String-pull per member: a clear straight line to the slot skips
          // the leader's route entirely; otherwise reuse the shared centers.
          let waypoints: number[];
          if (
            slotIndex > 0 &&
            hasLineOfSight(
              passability,
              size,
              Math.floor(member.x),
              Math.floor(member.y),
              Math.floor(finalX),
              Math.floor(finalY),
            )
          ) {
            waypoints = [finalX, finalY];
          } else {
            waypoints = [...sharedWaypoints.slice(0, -2), finalX, finalY];
          }
          writeActivityQueue(world, comps, member.eid, [
            hooks.buildHead(waypoints),
          ]);
          setMoveTarget(world, comps, member.eid, finalX, finalY);
        }
      },
    },
  );
}

/**
 * Apply one group-move order through the shared route pipeline with
 * plain Move heads.
 */
function handleGroupMove(
  world: World,
  comps: MovementComponents &
    Partial<OwnerComponents> &
    Partial<BuildingComponents> &
    Partial<CombatComponents>,
  diagnostics: MovementDiagnostics,
  paths: PathScheduler,
  data: Readonly<Record<string, unknown>>,
): void {
  issueGroupRoute(world, comps, diagnostics, paths, parseGroupMoveData(data), {
    buildHead: moveActivity,
  });
}

// ---- The system -------------------------------------------------------------

/**
 * Build the movement SimSystem. Every search is issued through the
 * injected path scheduler (worker transport in production, synchronous
 * fallback in headless tests — byte-identical results). Pass a
 * diagnostics sink to observe sidesteps/re-paths/group moves from tests
 * or telemetry.
 */
export function createMovementSystem(
  comps: MovementComponents &
    Partial<Pick<BodyComponents, "bodyId">> &
    Partial<OwnerComponents> &
    Partial<BuildingComponents> &
    Partial<GarrisonComponents> &
    Partial<CombatComponents> &
    Partial<StanceComponents>,
  paths: PathScheduler,
  diagnostics: MovementDiagnostics = createMovementDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    const dt = TICK_DT;
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;

    const passCache = new Map<number, Uint8Array>();
    let waterPassCache: Uint8Array | undefined;
    const getUnitPassability = (eid: number): Uint8Array => {
      if (isNavalUnit(world, comps, eid)) {
        if (!waterPassCache) {
          waterPassCache = waterPassabilityWithBuildings(world, comps);
        }
        return waterPassCache;
      }
      if (comps.buildingId === undefined || comps.ownerId === undefined) {
        return passability;
      }
      const owner = ownerOfUnit(world, { ownerId: comps.ownerId }, eid);
      let p = passCache.get(owner);
      if (!p) {
        p = passabilityForPlayer(
          world,
          {
            buildingId: comps.buildingId,
            buildingSiteId: comps.buildingSiteId,
            positionId: comps.positionId,
          },
          owner,
        );
        passCache.set(owner, p);
      }
      return p;
    };

    // 0) Apply responses that became due for THIS tick boundary before
    // any steering runs (pump already gated/block-checked in step()).
    // Continuations registered below fire from inside pump, so fresh
    // paths land here and are consumed immediately by this system.

    // 1) Commands consumed exactly on their target tick boundary. The
    // inbox is a SHARED stream: every system sees every drained command,
    // so each system dispatches on kind and skips foreign orders (the
    // gather system owns "gather" since M1-T9).
    for (const command of commands) {
      if (command.kind !== "groupMove") continue;
      if (!command.data) throw new Error("groupMove requires command data");
      handleGroupMove(world, comps, diagnostics, paths, command.data);
    }

    // Collect live units in ascending-eid order with decoded queues.
    const units: UnitState[] = [];
    for (const eid of world.entities) {
      const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
      const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(eid);
      if (!posRow || !velRow || !tagRow) continue;
      units.push({
        eid,
        posRow,
        velRow,
        tagRow,
        x: posRow[0]!,
        y: posRow[1]!,
        heading: velRow[V_HEADING]!,
        speed: velRow[V_SPEED]!,
        radius: tagRow[T_RADIUS]!,
        tickStartX: 0,
        tickStartY: 0,
        desiredDirX: 0,
        desiredDirY: 0,
        inApproachZone: false,
        emaNetX: 0,
        emaNetY: 0,
        progressed: false,
        contactWithParked: false,
        accumulatedSepX: 0,
        accumulatedSepY: 0,
        queue: readActivityQueue(world, comps, eid),
        queueDirty: false,
        passability: getUnitPassability(eid),
      });
    }

    // 2) Per-tick spatial hash over current positions (2-tile cells).
    const cells = new Map<number, number[]>();
    for (const unit of units) {
      const cx = Math.max(0, Math.floor(unit.x / SPATIAL_HASH_CELL));
      const cy = Math.max(0, Math.floor(unit.y / SPATIAL_HASH_CELL));
      const key = cx * 4096 + cy;
      const bucket = cells.get(key);
      if (bucket) bucket.push(unit.eid);
      else cells.set(key, [unit.eid]);
    }
    const indexByEid = new Map<number, number>();
    for (let i = 0; i < units.length; i++) indexByEid.set(units[i]!.eid, i);

    const neighborScratch: number[] = [];
    const gatherNeighbors = (unit: UnitState): void => {
      neighborScratch.length = 0;
      const baseCx = Math.max(0, Math.floor(unit.x / SPATIAL_HASH_CELL));
      const baseCy = Math.max(0, Math.floor(unit.y / SPATIAL_HASH_CELL));
      for (let dcx = -1; dcx <= 1; dcx++) {
        for (let dcy = -1; dcy <= 1; dcy++) {
          const cx = baseCx + dcx;
          const cy = baseCy + dcy;
          if (cx < 0 || cy < 0) continue;
          const bucket = cells.get(cx * 4096 + cy);
          if (bucket) neighborScratch.push(...bucket);
        }
      }
    };

    // Entity ids with an individual re-path request in flight. While
    // awaiting a response the unit holds position deterministically.
    const awaitRepath = new Set<number>();

    /**
     * Issue an individual async re-path from the unit's current tile to
     * its slot-adjusted MoveTarget. When the response applies, the
     * remaining waypoints of the head Move activity are replaced — or
     * the activity cancelled when no route exists any more. The order
     * is re-validated on application: a newer command that replaced the
     * destination voids this stale response.
     */
    const requestRepath = (unit: UnitState): void => {
      diagnostics.repaths += 1;
      const dest = getMoveTarget(world, comps, unit.eid);
      const current = peekActivity(unit.queue);
      if (!dest || !isMovementHead(current)) return;
      const eid = unit.eid;
      const startX = Math.floor(unit.x);
      const startY = Math.floor(unit.y);
      const goalX = Math.floor(dest.x);
      const goalY = Math.floor(dest.y);
      awaitRepath.add(eid);
      paths.requestPath(
        { startX, startY, goalX, goalY },
        {
          issueTick: world.tick,
          seed: derivePathSeed(
            world.seed,
            startY * size + startX,
            goalY * size + goalX,
            world.tick,
          ),
          passability: getUnitPassability(eid),
          // A version-stale response is discarded by the scheduler
          // without onApply; release the hold so the unit re-issues a
          // fresh repath next tick instead of freezing forever.
          onDiscard: (): void => {
            awaitRepath.delete(eid);
          },
          onApply: (response): void => {
            awaitRepath.delete(eid);
            // A newer order owns this unit now; the response is void.
            const destNow = getMoveTarget(world, comps, eid);
            if (
              destNow === undefined ||
              destNow.x !== dest.x ||
              destNow.y !== dest.y
            ) {
              return;
            }
            const queue = readActivityQueue(world, comps, eid);
            const head = peekActivity(queue);
            if (
              !head ||
              !(head.kind === "move" || head.kind === "attackMove")
            ) {
              return;
            }
            if (!response.ok) {
              cancelActivities(queue);
              writeActivityQueue(world, comps, eid, queue);
              return;
            }
            // Skip the start-tile pair: the unit's own position must never
            // become a steering target (zero-length segments steer into float
            // noise). Convert remaining tiles to centers; the last point is
            // the exact destination.
            const waypoints: number[] = [];
            for (let k = 2; k < response.waypoints.length; k += 2) {
              waypoints.push(
                response.waypoints[k]! + 0.5,
                response.waypoints[k + 1]! + 0.5,
              );
            }
            if (waypoints.length < 2) {
              // Already inside the goal tile: steer straight onto the slot.
              waypoints.push(dest.x, dest.y);
            } else {
              waypoints[waypoints.length - 2] = dest.x;
              waypoints[waypoints.length - 1] = dest.y;
            }
            head.waypoints = waypoints;
            head.cursor = 0;
            writeActivityQueue(world, comps, eid, queue);
            const velRow = world.rowsByComponentId
              .get(comps.velocityId)
              ?.get(eid);
            if (velRow) velRow[V_CLOSE_TICKS] = 0;
          },
        },
      );
    };

    /** Seeded sidestep nudge, then an individual re-path. */
    const sidestepAndRepath = (unit: UnitState): void => {
      diagnostics.sidesteps += 1;
      let preferredSide = unit.velRow[V_AVOID_SIDE]!;
      if (preferredSide === 0) {
        preferredSide = world.prng.nextFloat() < 0.5 ? -1 : 1;
      }
      const perpX = -detSin(unit.heading) * SIDESTEP_DISTANCE;
      const perpY = detCos(unit.heading) * SIDESTEP_DISTANCE;
      for (const side of [preferredSide, -preferredSide]) {
        const nx = unit.x + perpX * side;
        const ny = unit.y + perpY * side;
        if (
          !tileIsPassable(
            unit.passability,
            size,
            Math.floor(nx),
            Math.floor(ny),
          )
        )
          continue;
        let occupied = false;
        for (const other of units) {
          if (other === unit) continue;
          const ddx = other.x - nx;
          const ddy = other.y - ny;
          // The nudge must respect body radii, not just a fixed band.
          const clearDistance =
            other.radius + unit.radius + PARKED_CONTACT_MARGIN;
          if (ddx * ddx + ddy * ddy < clearDistance * clearDistance) {
            occupied = true;
            break;
          }
        }
        if (occupied) continue;
        unit.x = nx;
        unit.y = ny;
        unit.posRow[0] = nx;
        unit.posRow[1] = ny;
        unit.velRow[V_AVOID_SIDE] = side;
        unit.velRow[V_AVOID_TICKS_LEFT] = AVOIDANCE_COMMIT_TICKS;
        break;
      }
      requestRepath(unit);
    };

    /**
     * Commit (or keep) a yield side when squeezed: prefer the side the
     * current heading naturally turns toward; draw from the world PRNG
     * only when perfectly symmetric.
     */
    const commitAvoidanceSide = (
      unit: UnitState,
      awayX: number,
      awayY: number,
    ): void => {
      if (unit.velRow[V_AVOID_TICKS_LEFT]! > 0) return;
      const hx = detCos(unit.heading);
      const hy = detSin(unit.heading);
      const cross = hx * awayY - hy * awayX;
      let side: number;
      if (cross > 1e-9) side = 1;
      else if (cross < -1e-9) side = -1;
      else side = world.prng.nextFloat() < 0.5 ? -1 : 1;
      unit.velRow[V_AVOID_SIDE] = side;
      unit.velRow[V_AVOID_TICKS_LEFT] = AVOIDANCE_COMMIT_TICKS;
    };

    // 3) Activity steering + integration (ascending eid).
    for (const unit of units) {
      unit.heading = unit.velRow[V_HEADING]!;
      unit.speed = unit.velRow[V_SPEED]!;
      const current = peekActivity(unit.queue);

      // Combat heads owned by the combat system: an engaged unit stands
      // its ground here — out-of-range attackers get a Move approach leg
      // inserted ahead of the Attack head and steer through that.
      // M3-T3: Eat heads belong to the needs system the same way.
      // M3-T6: Sleep heads belong to schedules (which pops them at
      // wakeTick and applies the rest refill) — parked here, never
      // decremented like wait. M3-T7: Leisure heads belong to social
      // (which executes the venue behavior on arrival) — parked alike.
      if (
        !current ||
        current.kind === "wait" ||
        current.kind === "gather" ||
        current.kind === "deliver" ||
        current.kind === "attack" ||
        current.kind === "eat" ||
        current.kind === "sleep" ||
        current.kind === "leisure" ||
        current.kind === "pack" ||
        current.kind === "convert"
      ) {
        if (current?.kind === "wait") {
          current.ticks -= 1;
          if (current.ticks <= 0) dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
        }
        unit.speed = 0; // idle/waiting/working units are Parked
        continue;
      }

      if (current.kind === "guard") {
        const targetPosRow = world.rowsByComponentId
          .get(comps.positionId)
          ?.get(current.targetEid);
        if (!targetPosRow) {
          dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }
        const tx = targetPosRow[0]!;
        const ty = targetPosRow[1]!;
        const gdx = tx - unit.x;
        const gdy = ty - unit.y;
        const gdist = Math.sqrt(gdx * gdx + gdy * gdy);
        // Acceptance criteria: follow target at <= 1.5 tile distance
        if (gdist <= 1.5) {
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }

        unit.tickStartX = unit.x;
        unit.tickStartY = unit.y;
        const baseSpeed =
          unit.tagRow[0]! *
          injuryImpairmentOf(world, comps, unit.eid).speedMult;
        const turnRate = unit.tagRow[1]!;

        const desiredDirX = gdx / gdist;
        const desiredDirY = gdy / gdist;
        unit.desiredDirX = desiredDirX;
        unit.desiredDirY = desiredDirY;
        const targetX = tx - desiredDirX * 1.0;
        const targetY = ty - desiredDirY * 1.0;
        const dx = targetX - unit.x;
        const dy = targetY - unit.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        world.rowsByComponentId
          .get(comps.moveTargetId)
          ?.set(unit.eid, [targetX, targetY]);

        const desiredHeading = detAtan2(dy, dx);
        const delta = angleDelta(unit.heading, desiredHeading);
        const maxTurnStep = turnRate * dt;
        const turnStep = Math.max(-maxTurnStep, Math.min(maxTurnStep, delta));
        unit.heading = wrapAngle(unit.heading + turnStep);

        const align = detCos(Math.min(Math.abs(delta), HALF_PI));
        const cruise =
          baseSpeed * (TURN_SLOW_MIN + (1 - TURN_SLOW_MIN) * align);
        const targetSpeed = cruise;
        if (targetSpeed > unit.speed) {
          unit.speed = Math.min(
            targetSpeed,
            unit.speed + ACCEL_TILES_PER_S2 * dt,
          );
        } else {
          unit.speed = Math.max(
            targetSpeed,
            unit.speed - BRAKE_DECEL_TILES_PER_S2 * dt,
          );
        }

        if (dist > 0 && unit.speed > 0) {
          const dirX = dx / dist;
          const dirY = dy / dist;
          const stepLength = Math.min(unit.speed * dt, dist);
          tryMove(
            unit,
            unit.x + dirX * stepLength,
            unit.y + dirY * stepLength,
            unit.passability,
            size,
          );
        }
        unit.velRow[V_HEADING] = unit.heading;
        unit.velRow[V_SPEED] = unit.speed;
        continue;
      }

      if (current.kind === "garrison") {
        const targetEid = current.targetBuildingId;
        const targetPosRow = world.rowsByComponentId
          .get(comps.positionId)
          ?.get(targetEid);
        const bRow =
          comps.buildingId !== undefined
            ? world.rowsByComponentId.get(comps.buildingId)?.get(targetEid)
            : undefined;
        const targetCombatRow =
          comps.combatId !== undefined
            ? world.rowsByComponentId.get(comps.combatId)?.get(targetEid)
            : undefined;

        if (!targetPosRow || (!bRow && !targetCombatRow)) {
          dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }

        let targetOwner = 0;
        let capacity = 0;
        let distToEdge = 0;
        let steerTargetX = targetPosRow[0]!;
        let steerTargetY = targetPosRow[1]!;
        let embarkThreshold = 1.2;

        if (bRow) {
          const bDefCode = bRow[1]!;
          const bDef = buildingDefOf(buildingIdOfCode(bDefCode));
          const originX = bRow[2]!;
          const originY = bRow[3]!;
          const rw = bDef.footprint.width;
          const rh = bDef.footprint.height;

          // Calculate distance from unit to building footprint rectangle
          const closestX = Math.max(originX, Math.min(unit.x, originX + rw));
          const closestY = Math.max(originY, Math.min(unit.y, originY + rh));
          const cdx = unit.x - closestX;
          const cdy = unit.y - closestY;
          distToEdge = Math.sqrt(cdx * cdx + cdy * cdy);

          targetOwner = bRow[0]!;
          capacity = bDef.garrisonCapacity ?? 0;
          embarkThreshold = 1.2;
        } else if (targetCombatRow) {
          const uDef = unitDefOf(unitIdOfCode(targetCombatRow[0]!));
          targetOwner = targetCombatRow[1]!;
          capacity = uDef.garrisonCapacity ?? 0;
          const cdx = unit.x - targetPosRow[0]!;
          const cdy = unit.y - targetPosRow[1]!;
          distToEdge = Math.sqrt(cdx * cdx + cdy * cdy);
          embarkThreshold = 1.5;

          // For land units embarking onto water transports: steer towards closest passable tile
          if (
            !tileIsPassable(
              unit.passability,
              size,
              Math.floor(steerTargetX),
              Math.floor(steerTargetY),
            )
          ) {
            const near = nearestPassableTile(
              unit.passability,
              size,
              Math.floor(steerTargetX),
              Math.floor(steerTargetY),
            );
            if (near) {
              steerTargetX = near.x + 0.5;
              steerTargetY = near.y + 0.5;
            }
          }
        }

        const uOwner =
          comps.ownerId !== undefined
            ? ownerOfUnit(world, { ownerId: comps.ownerId }, unit.eid)
            : 0;

        const currentGarrison =
          comps.garrisonId !== undefined
            ? readGarrison(world, { garrisonId: comps.garrisonId }, targetEid)
            : [];

        // If hostile or at capacity, cannot enter -> cancel order
        if (
          targetOwner !== uOwner ||
          capacity <= 0 ||
          currentGarrison.length >= capacity
        ) {
          dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }

        // Check if close enough to enter
        if (distToEdge <= embarkThreshold) {
          const combatRow =
            comps.combatId !== undefined
              ? world.rowsByComponentId.get(comps.combatId)?.get(unit.eid)
              : undefined;
          const unitCode = combatRow ? combatRow[0]! : 0;
          const uDef = unitDefOf(unitIdOfCode(unitCode));
          const hp = combatRow ? combatRow[2]! : uDef.hp;
          const maxHp = uDef.hp;
          const stanceCode =
            comps.stanceId !== undefined
              ? (world.rowsByComponentId
                  .get(comps.stanceId)
                  ?.get(unit.eid)?.[0] ?? 0)
              : 0;

          if (comps.garrisonId !== undefined) {
            addGarrisonedUnit(
              world,
              { garrisonId: comps.garrisonId },
              targetEid,
              {
                unitCode,
                owner: uOwner,
                hp,
                maxHp,
                stanceCode,
              },
            );
          }

          unit.despawned = true;
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          unit.queueDirty = false;
          despawnEntity(world, unit.eid);
          continue;
        }

        // Steer towards target position
        const bx = steerTargetX;
        const by = steerTargetY;
        const tdx = bx - unit.x;
        const tdy = by - unit.y;
        const tdist = Math.sqrt(tdx * tdx + tdy * tdy);

        unit.tickStartX = unit.x;
        unit.tickStartY = unit.y;
        const baseSpeed =
          unit.tagRow[0]! *
          injuryImpairmentOf(world, comps, unit.eid).speedMult;
        const turnRate = unit.tagRow[1]!;

        const desiredDirX = tdist > 0 ? tdx / tdist : 0;
        const desiredDirY = tdist > 0 ? tdy / tdist : 0;
        unit.desiredDirX = desiredDirX;
        unit.desiredDirY = desiredDirY;

        world.rowsByComponentId
          .get(comps.moveTargetId)
          ?.set(unit.eid, [bx, by]);

        const desiredHeading = detAtan2(tdy, tdx);
        const delta = angleDelta(unit.heading, desiredHeading);
        const maxTurnStep = turnRate * dt;
        const turnStep = Math.max(-maxTurnStep, Math.min(maxTurnStep, delta));
        unit.heading = wrapAngle(unit.heading + turnStep);

        const align = detCos(Math.min(Math.abs(delta), HALF_PI));
        const cruise =
          baseSpeed * (TURN_SLOW_MIN + (1 - TURN_SLOW_MIN) * align);
        const targetSpeed = cruise;
        if (targetSpeed > unit.speed) {
          unit.speed = Math.min(
            targetSpeed,
            unit.speed + ACCEL_TILES_PER_S2 * dt,
          );
        } else {
          unit.speed = Math.max(
            targetSpeed,
            unit.speed - BRAKE_DECEL_TILES_PER_S2 * dt,
          );
        }

        if (tdist > 0 && unit.speed > 0) {
          const stepLength = Math.min(unit.speed * dt, tdist);
          tryMove(
            unit,
            unit.x + desiredDirX * stepLength,
            unit.y + desiredDirY * stepLength,
            unit.passability,
            size,
          );
        }
        unit.velRow[V_HEADING] = unit.heading;
        unit.velRow[V_SPEED] = unit.speed;
        continue;
      }

      if (unit.velRow[V_PROPAGATION_PARKED] !== 0) {
        // Propagated-Parked keeps its movement activity but halts cleanly.
        unit.speed = 0;
        continue;
      }

      if (awaitRepath.has(unit.eid)) {
        // Awaiting an async re-path response: hold position this tick
        // (the fresh route lands at a tick boundary via the scheduler).
        unit.speed = 0;
        unit.velRow[V_SPEED] = 0;
        continue;
      }

      const move = current; // movement head (move | attackMove | patrol)
      const waypoints = move.waypoints;
      // M3-T4: leg/vital wounds drag the cruise speed (multiplier
      // exactly 1 for rowless units — legacy arithmetic untouched).
      const baseSpeed =
        unit.tagRow[0]! * injuryImpairmentOf(world, comps, unit.eid).speedMult;
      const turnRate = unit.tagRow[1]!;

      // Consume reached intermediate waypoints.
      if (move.kind === "patrol") {
        if (move.direction === 1) {
          for (;;) {
            const nextX = waypoints[move.cursor]!;
            const nextY = waypoints[move.cursor + 1]!;
            const ndx = nextX - unit.x;
            const ndy = nextY - unit.y;
            const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
            if (
              move.cursor + 2 < waypoints.length &&
              ndist <= WAYPOINT_REACH_RADIUS
            ) {
              move.cursor += 2;
              unit.queueDirty = true;
              continue;
            }
            break;
          }
        } else {
          for (;;) {
            const nextX = waypoints[move.cursor]!;
            const nextY = waypoints[move.cursor + 1]!;
            const ndx = nextX - unit.x;
            const ndy = nextY - unit.y;
            const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
            if (move.cursor > 0 && ndist <= WAYPOINT_REACH_RADIUS) {
              move.cursor -= 2;
              unit.queueDirty = true;
              continue;
            }
            break;
          }
        }
      } else {
        for (;;) {
          const nextX = waypoints[move.cursor]!;
          const nextY = waypoints[move.cursor + 1]!;
          const ndx = nextX - unit.x;
          const ndy = nextY - unit.y;
          const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
          if (
            move.cursor + 2 < waypoints.length &&
            ndist <= WAYPOINT_REACH_RADIUS
          ) {
            move.cursor += 2;
            unit.queueDirty = true;
            continue;
          }
          break;
        }
      }

      // Snapshot for net-progress measurement in the FSM pass: a unit
      // only counts as progressing when its position actually moved
      // TOWARD the steering target this tick — being shoved backward or
      // wall-clamped counts as stalled.
      unit.tickStartX = unit.x;
      unit.tickStartY = unit.y;

      const targetX = waypoints[move.cursor]!;
      const targetY = waypoints[move.cursor + 1]!;
      const dx = targetX - unit.x;
      const dy = targetY - unit.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isFinalLeg =
        move.kind === "patrol" ? false : move.cursor + 2 >= waypoints.length;
      unit.inApproachZone = isFinalLeg && dist <= APPROACH_RADIUS;
      if (dist > 1e-12) {
        unit.desiredDirX = dx / dist;
        unit.desiredDirY = dy / dist;
      }

      if (move.kind === "patrol") {
        const isEnd =
          (move.direction === 1 && move.cursor + 2 >= waypoints.length) ||
          (move.direction === -1 && move.cursor <= 0);
        if (isEnd && dist <= WAYPOINT_REACH_RADIUS) {
          if (move.direction === 1) {
            move.direction = -1;
            move.cursor = Math.max(0, waypoints.length - 4);
          } else {
            move.direction = 1;
            move.cursor = Math.min(waypoints.length - 2, 2);
          }
          unit.queueDirty = true;
          const nextTargetX = waypoints[move.cursor]!;
          const nextTargetY = waypoints[move.cursor + 1]!;
          world.rowsByComponentId
            .get(comps.moveTargetId)
            ?.set(unit.eid, [nextTargetX, nextTargetY]);
          continue;
        }
      } else {
        if (isFinalLeg && dist <= FINAL_ARRIVAL_RADIUS) {
          dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
          unit.speed = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }
      }

      // Segment validity raycast against LIVE passability (ADR-0003):
      // a newly-blocked next segment issues an async re-path; the unit
      // holds position until the fresh route applies.
      if (
        !hasLineOfSight(
          unit.passability,
          size,
          Math.floor(unit.x),
          Math.floor(unit.y),
          Math.floor(targetX),
          Math.floor(targetY),
        )
      ) {
        requestRepath(unit);
        continue;
      }

      if (isFinalLeg && dist <= APPROACH_RADIUS) {
        unit.velRow[V_CLOSE_TICKS] = unit.velRow[V_CLOSE_TICKS]! + 1;
        if (unit.velRow[V_CLOSE_TICKS]! >= ARRIVAL_GRACE_TICKS) {
          // Anti-orbit grace: close enough for long enough ⇒ arrived.
          dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
          unit.speed = 0;
          unit.velRow[V_CLOSE_TICKS] = 0;
          unit.velRow[V_SPEED] = 0;
          continue;
        }
      } else {
        unit.velRow[V_CLOSE_TICKS] = 0;
      }

      // Turn-rate-limited heading (smooth arcs, never snapping).
      const desiredHeading = detAtan2(dy, dx);
      const delta = angleDelta(unit.heading, desiredHeading);
      const maxTurnStep = turnRate * dt;
      const turnStep = Math.max(-maxTurnStep, Math.min(maxTurnStep, delta));
      unit.heading = wrapAngle(unit.heading + turnStep);

      // Ease-in accel; slow down for sharp turns; sqrt braking profile.
      const align = detCos(Math.min(Math.abs(delta), HALF_PI)); // ∈ [0, 1]
      const cruise = baseSpeed * (TURN_SLOW_MIN + (1 - TURN_SLOW_MIN) * align);
      let remaining = dist;
      for (let i = move.cursor + 2; i < waypoints.length; i += 2) {
        const segDX = waypoints[i]! - waypoints[i - 2]!;
        const segDY = waypoints[i + 1]! - waypoints[i - 1]!;
        remaining += Math.sqrt(segDX * segDX + segDY * segDY);
      }
      const brakeSpeed = Math.sqrt(
        2 * BRAKE_DECEL_TILES_PER_S2 * Math.max(remaining, 0),
      );
      const targetSpeed = Math.min(cruise, brakeSpeed);
      if (targetSpeed > unit.speed) {
        unit.speed = Math.min(
          targetSpeed,
          unit.speed + ACCEL_TILES_PER_S2 * dt,
        );
      } else {
        unit.speed = Math.max(
          targetSpeed,
          unit.speed - BRAKE_DECEL_TILES_PER_S2 * dt,
        );
      }

      if (dist > 0 && unit.speed > 0) {
        const dirX = dx / dist;
        const dirY = dy / dist;
        const stepLength = Math.min(unit.speed * dt, dist);
        tryMove(
          unit,
          unit.x + dirX * stepLength,
          unit.y + dirY * stepLength,
          unit.passability,
          size,
        );
      }
      unit.velRow[V_HEADING] = unit.heading;
      unit.velRow[V_SPEED] = unit.speed;
    }

    // 4) Pairwise steering layer via the spatial hash (each unordered
    // pair handled once: i < j).
    for (let i = 0; i < units.length; i++) {
      const unitA = units[i]!;
      if (unitA.despawned) continue;
      gatherNeighbors(unitA);
      for (const otherEid of neighborScratch) {
        const j = indexByEid.get(otherEid)!;
        if (j <= i) continue;
        const unitB = units[j]!;
        if (unitB.despawned) continue;
        let dx = unitB.x - unitA.x;
        let dy = unitB.y - unitA.y;
        let d2 = dx * dx + dy * dy;
        // Process a pair inside the boid band OR while their bodies
        // touch — large units must still resolve overlaps lying beyond
        // the 1-tile separation band.
        const pairRadius = Math.max(
          SEPARATION_RADIUS,
          unitA.radius + unitB.radius + PARKED_CONTACT_MARGIN,
        );
        if (d2 > pairRadius * pairRadius) continue;
        if (d2 < 1e-12) {
          // Coincident centers: deterministic split direction by eid.
          const flip = unitA.eid < unitB.eid ? -1 : 1;
          dx = flip;
          dy = 0;
          d2 = 1;
        }
        const distance = Math.sqrt(d2);
        const ux = dx / distance; // unit vector from A toward B
        const uy = dy / distance;

        // Boid separation drift, weighted by proximity so the push
        // fades continuously to zero at the band edge (an unweighted
        // impulse creates shove limit-cycles at the boundary). Only
        // steerable units generate drift.
        const proximity = 1 - distance / pairRadius;
        if (isSteerable(unitA)) {
          unitA.accumulatedSepX -= ux * proximity;
          unitA.accumulatedSepY -= uy * proximity;
        }
        if (isSteerable(unitB)) {
          unitB.accumulatedSepX += ux * proximity;
          unitB.accumulatedSepY += uy * proximity;
        }

        // Parked-contact bookkeeping for backward propagation: any
        // order-carrying unit pressed against a Parked one.
        const touchDistance =
          unitA.radius + unitB.radius + PARKED_CONTACT_MARGIN;
        if (distance <= touchDistance) {
          if (isSteerable(unitA) && !isSteerable(unitB))
            unitA.contactWithParked = true;
          if (isSteerable(unitB) && !isSteerable(unitA))
            unitB.contactWithParked = true;
        }

        // Symmetric positional push-apart on overlap.
        const minDistance = unitA.radius + unitB.radius;
        const overlap = minDistance - distance;
        if (overlap > 0) {
          const half = overlap / 2;
          const steerA = isSteerable(unitA);
          const steerB = isSteerable(unitB);
          if (steerA && steerB) {
            tryMove(
              unitA,
              unitA.x - ux * half,
              unitA.y - uy * half,
              unitA.passability,
              size,
            );
            tryMove(
              unitB,
              unitB.x + ux * half,
              unitB.y + uy * half,
              unitB.passability,
              size,
            );
            commitAvoidanceSide(unitA, -ux, -uy);
            commitAvoidanceSide(unitB, ux, uy);
          } else if (steerA) {
            tryMove(
              unitA,
              unitA.x - ux * overlap,
              unitA.y - uy * overlap,
              unitA.passability,
              size,
            );
            commitAvoidanceSide(unitA, -ux, -uy);
          } else if (steerB) {
            tryMove(
              unitB,
              unitB.x + ux * overlap,
              unitB.y + uy * overlap,
              unitB.passability,
              size,
            );
            commitAvoidanceSide(unitB, ux, uy);
          }
          // Both Parked: soft obstacles may rest overlapped.
        }
      }
    }

    // Apply accumulated boid separation drift (capped per tick).
    for (const unit of units) {
      const magSq =
        unit.accumulatedSepX * unit.accumulatedSepX +
        unit.accumulatedSepY * unit.accumulatedSepY;
      if (magSq < 1e-12) continue;
      const magnitude = Math.sqrt(magSq);
      const strength =
        Math.min(magnitude, SEPARATION_RADIUS) * SEPARATION_DRIFT_RATE * dt;
      const scale = strength / magnitude;
      tryMove(
        unit,
        unit.x + unit.accumulatedSepX * scale,
        unit.y + unit.accumulatedSepY * scale,
        unit.passability,
        size,
      );
    }

    // 5) FSM resolution: Moving / Stalled / Parked (+ propagation).
    for (const unit of units) {
      if (unit.despawned) continue;
      const ticksLeft = unit.velRow[V_AVOID_TICKS_LEFT]!;
      if (ticksLeft > 0) unit.velRow[V_AVOID_TICKS_LEFT] = ticksLeft - 1;

      const current = peekActivity(unit.queue);
      const hasMoveHead = isMovementHead(current);

      // Net displacement this tick, smoothed over ~10 ticks and
      // projected onto the steering target direction. A unit counts as
      // progressing only while its ACTUAL displacement stays above half
      // its COMMANDED step — pressing into a blocker at full speed with
      // nowhere to go is being impeded, not moving.
      const netDX = unit.x - unit.tickStartX;
      const netDY = unit.y - unit.tickStartY;
      unit.emaNetX += (netDX - unit.emaNetX) * NET_PROGRESS_SMOOTHING;
      unit.emaNetY += (netDY - unit.emaNetY) * NET_PROGRESS_SMOOTHING;
      const emaProjection =
        unit.emaNetX * unit.desiredDirX + unit.emaNetY * unit.desiredDirY;
      const commandedStep = Math.max(unit.speed * dt, PROGRESS_EPSILON);
      unit.progressed =
        !hasMoveHead ||
        unit.inApproachZone ||
        emaProjection > Math.max(NET_PROGRESS_EPSILON, 0.5 * commandedStep);

      if (!hasMoveHead) {
        unit.velRow[V_STALLED_TICKS] = 0;
        unit.velRow[V_PARK_CONTACT_TICKS] = 0;
        unit.velRow[V_CLOSE_TICKS] = 0;
        unit.velRow[V_PROPAGATION_PARKED] = 0;
      } else if (awaitRepath.has(unit.eid)) {
        // Held for an in-flight re-path: counters stay frozen so a
        // two-tick path latency never trips the stall ladder.
      } else if (unit.velRow[V_PROPAGATION_PARKED] !== 0) {
        if (!unit.contactWithParked) {
          // Released from the halted chain: resume steering next tick.
          unit.velRow[V_PROPAGATION_PARKED] = 0;
          unit.velRow[V_STALLED_TICKS] = 0;
          unit.velRow[V_PARK_CONTACT_TICKS] = 0;
        }
      } else {
        if (unit.progressed) {
          const stalled = unit.velRow[V_STALLED_TICKS]!;
          unit.velRow[V_STALLED_TICKS] = Math.max(
            0,
            stalled - STALL_DECAY_PER_TICK,
          );
        } else {
          unit.velRow[V_STALLED_TICKS] = unit.velRow[V_STALLED_TICKS]! + 1;
        }
        // Sustained contact with a Parked unit while impeded accumulates
        // toward propagation; free movement bleeds the counter away.
        const parkContact = unit.velRow[V_PARK_CONTACT_TICKS]!;
        if (!unit.progressed && unit.contactWithParked) {
          unit.velRow[V_PARK_CONTACT_TICKS] = parkContact + 1;
        } else {
          unit.velRow[V_PARK_CONTACT_TICKS] = Math.max(0, parkContact - 2);
        }
        const stalledNow = unit.velRow[V_STALLED_TICKS]!;
        const parkContactNow = unit.velRow[V_PARK_CONTACT_TICKS]!;
        if (parkContactNow >= AVOIDANCE_COMMIT_TICKS) {
          // Parked propagates backward through the contact chain.
          unit.velRow[V_PROPAGATION_PARKED] = 1;
          unit.velRow[V_SPEED] = 0;
          unit.velRow[V_STALLED_TICKS] = 0;
          unit.velRow[V_PARK_CONTACT_TICKS] = 0;
        } else if (stalledNow > STALL_SIDESTEP_TICKS) {
          sidestepAndRepath(unit);
          unit.velRow[V_STALLED_TICKS] = 0;
          unit.velRow[V_CLOSE_TICKS] = 0;
        }
      }

      if (unit.queueDirty) {
        writeActivityQueue(world, comps, unit.eid, unit.queue);
      }
    }

    // Fog dirty marks (SPEC §2.9): any unit whose committed tile changed
    // this tick re-stamps its sight circle at the tick-boundary flush
    // (the flush un-stamps the previously stamped circle first).
    for (const unit of units) {
      if (unit.despawned) continue;
      if (
        Math.floor(unit.x) !== Math.floor(unit.tickStartX) ||
        Math.floor(unit.y) !== Math.floor(unit.tickStartY)
      ) {
        world.visibility.markDirty("moved", unit.eid);
      }
    }
  };
}

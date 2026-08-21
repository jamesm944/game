/**
 * Movement system — SPEC §2.2 / ADR-0003 phase 1 (sim-side).
 *
 * Per 30 Hz tick, ascending eid:
 *   1. consume `groupMove` commands → leader A* + formation slot dealing
 *   2. activity-queue steering: turn-rate-limited heading arcs, ease-in
 *      acceleration, sqrt braking near arrival, waypoint consumption
 *   3. steering layer: per-tick spatial hash (2-tile cells) driving boid
 *      separation (~1 tile), symmetric positional push-apart on overlap,
 *      impassable-tile clamping with axis slide
 *   4. FSM resolution: Moving / Stalled (>45 ticks → seeded sidestep +
 *      individual re-path) / Parked (idle, or propagated backward through
 *      contact after ~0.7 s stalled against a parked unit)
 *
 * Determinism: all randomness comes from the world PRNG stream, trig
 * from core/trig (IEEE basic ops only), iteration order is pinned, and
 * every constant below is a documented tuning value.
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
import { findPath, hasLineOfSight } from "../path/astar";

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
}

/** A unit can steer only while its head activity is a Move. */
function isSteerable(unit: UnitState): boolean {
  return (
    unit.queue.length > 0 &&
    unit.queue[0]!.kind === "move" &&
    unit.velRow[V_PROPAGATION_PARKED] === 0
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

// ---- groupMove command handling ---------------------------------------------

interface GroupMoveData {
  readonly entityIds: readonly number[];
  readonly x: number;
  readonly y: number;
}

function parseGroupMoveData(
  data: Readonly<Record<string, unknown>>,
): GroupMoveData {
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
 * Apply one group-move order: pick the leader nearest the centroid
 * (ascending-eid tiebreak), run ONE octile A* for the leader, deal
 * concentric-ring slots to every Pop sorted ascending-eid (leader on
 * slot 0), and enqueue per-Pop Move activities whose final waypoint is
 * the slot-adjusted destination.
 */
function handleGroupMove(
  world: World,
  comps: MovementComponents,
  diagnostics: MovementDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseGroupMoveData(data);
  const { x, y } = parsed;
  const passability = world.layers.derivedPassability;
  const size = world.layers.size;

  const members: { eid: number; x: number; y: number }[] = [];
  for (const eid of parsed.entityIds) {
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
  if (!tileIsPassable(passability, size, startTileX, startTileY)) return;
  const goal = nearestPassableTile(
    passability,
    size,
    Math.floor(x),
    Math.floor(y),
  );
  if (!goal) return;
  const path = findPath({
    passability,
    width: size,
    startX: startTileX,
    startY: startTileY,
    goalX: goal.x,
    goalY: goal.y,
  });
  if (!path) return; // unreachable destination: command is a no-op

  diagnostics.groupMoves += 1;
  // Pulled waypoints are tile indices; activities steer in continuous
  // coordinates, so convert every pair to its tile center first.
  const sharedWaypoints: number[] = [];
  for (let k = 0; k < path.waypoints.length; k += 2) {
    sharedWaypoints.push(
      path.waypoints[k]! + 0.5,
      path.waypoints[k + 1]! + 0.5,
    );
  }

  // Deal slots: leader on the center slot, remaining Pops ascending.
  const ordered = [leader, ...members.filter((member) => member !== leader)];
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
    velRow[V_STALLED_TICKS] = 0;
    velRow[V_PARK_CONTACT_TICKS] = 0;
    velRow[V_CLOSE_TICKS] = 0;
    velRow[V_PROPAGATION_PARKED] = 0;
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
    writeActivityQueue(world, comps, member.eid, [moveActivity(waypoints)]);
    setMoveTarget(world, comps, member.eid, finalX, finalY);
  }
}

// ---- The system -------------------------------------------------------------

/**
 * Build the movement SimSystem. Pass a diagnostics sink to observe
 * sidesteps/re-paths/group moves from tests or telemetry.
 */
export function createMovementSystem(
  comps: MovementComponents,
  diagnostics: MovementDiagnostics = createMovementDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    const dt = TICK_DT;
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;

    // 1) Commands consumed exactly on their target tick boundary.
    for (const command of commands) {
      if (command.kind !== "groupMove") {
        throw new Error(
          `movement system cannot handle command kind: ${command.kind}`,
        );
      }
      if (!command.data) throw new Error("groupMove requires command data");
      handleGroupMove(world, comps, diagnostics, command.data);
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

    /**
     * Individual re-path from the unit's current tile to its slot-
     * adjusted MoveTarget. Replaces the remaining waypoints of the head
     * Move activity, or cancels it when no route exists any more.
     */
    const repathUnit = (unit: UnitState): void => {
      diagnostics.repaths += 1;
      const dest = getMoveTarget(world, comps, unit.eid);
      const current = peekActivity(unit.queue);
      if (!dest || !current || current.kind !== "move") return;
      const path = findPath({
        passability,
        width: size,
        startX: Math.floor(unit.x),
        startY: Math.floor(unit.y),
        goalX: Math.floor(dest.x),
        goalY: Math.floor(dest.y),
      });
      if (!path) {
        cancelActivities(unit.queue);
        unit.queueDirty = true;
        return;
      }
      // Skip the start-tile pair: the unit's own position must never
      // become a steering target (zero-length segments steer into float
      // noise). Convert remaining tiles to centers; the last point is
      // the exact destination.
      const waypoints: number[] = [];
      for (let k = 2; k < path.waypoints.length; k += 2) {
        waypoints.push(path.waypoints[k]! + 0.5, path.waypoints[k + 1]! + 0.5);
      }
      if (waypoints.length < 2) {
        // Already inside the goal tile: steer straight onto the slot.
        waypoints.push(dest.x, dest.y);
      } else {
        waypoints[waypoints.length - 2] = dest.x;
        waypoints[waypoints.length - 1] = dest.y;
      }
      current.waypoints = waypoints;
      current.cursor = 0;
      unit.queueDirty = true;
      unit.velRow[V_CLOSE_TICKS] = 0;
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
        if (!tileIsPassable(passability, size, Math.floor(nx), Math.floor(ny)))
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
      repathUnit(unit);
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

      if (!current || current.kind === "wait") {
        if (current?.kind === "wait") {
          current.ticks -= 1;
          if (current.ticks <= 0) dequeueCurrentActivity(unit.queue);
          unit.queueDirty = true;
        }
        unit.speed = 0; // idle/waiting units are Parked
        continue;
      }

      if (unit.velRow[V_PROPAGATION_PARKED] !== 0) {
        // Propagated-Parked keeps its Move activity but halts cleanly.
        unit.speed = 0;
        continue;
      }

      const move = current; // kind === "move"
      const waypoints = move.waypoints;
      const baseSpeed = unit.tagRow[0]!;
      const turnRate = unit.tagRow[1]!;

      // Consume reached intermediate waypoints.
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
      const isFinalLeg = move.cursor + 2 >= waypoints.length;
      unit.inApproachZone = isFinalLeg && dist <= APPROACH_RADIUS;
      if (dist > 1e-12) {
        unit.desiredDirX = dx / dist;
        unit.desiredDirY = dy / dist;
      }

      if (isFinalLeg && dist <= FINAL_ARRIVAL_RADIUS) {
        dequeueCurrentActivity(unit.queue);
        unit.queueDirty = true;
        unit.speed = 0;
        unit.velRow[V_SPEED] = 0;
        continue;
      }

      // Segment validity raycast against LIVE passability (ADR-0003):
      // a newly-blocked next segment re-paths immediately.
      if (
        !hasLineOfSight(
          passability,
          size,
          Math.floor(unit.x),
          Math.floor(unit.y),
          Math.floor(targetX),
          Math.floor(targetY),
        )
      ) {
        repathUnit(unit);
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
          passability,
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
      gatherNeighbors(unitA);
      for (const otherEid of neighborScratch) {
        const j = indexByEid.get(otherEid)!;
        if (j <= i) continue;
        const unitB = units[j]!;
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
              passability,
              size,
            );
            tryMove(
              unitB,
              unitB.x + ux * half,
              unitB.y + uy * half,
              passability,
              size,
            );
            commitAvoidanceSide(unitA, -ux, -uy);
            commitAvoidanceSide(unitB, ux, uy);
          } else if (steerA) {
            tryMove(
              unitA,
              unitA.x - ux * overlap,
              unitA.y - uy * overlap,
              passability,
              size,
            );
            commitAvoidanceSide(unitA, -ux, -uy);
          } else if (steerB) {
            tryMove(
              unitB,
              unitB.x + ux * overlap,
              unitB.y + uy * overlap,
              passability,
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
        passability,
        size,
      );
    }

    // 5) FSM resolution: Moving / Stalled / Parked (+ propagation).
    for (const unit of units) {
      const ticksLeft = unit.velRow[V_AVOID_TICKS_LEFT]!;
      if (ticksLeft > 0) unit.velRow[V_AVOID_TICKS_LEFT] = ticksLeft - 1;

      const current = peekActivity(unit.queue);
      const hasMoveHead = current?.kind === "move";

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
  };
}

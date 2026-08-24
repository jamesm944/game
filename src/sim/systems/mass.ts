/**
 * Sunday Morning Mass planner — SPEC §2.4 weekly cycle / M3-T8
 * (issue #53).
 *
 * "…if a Church stands, community attends Morning Mass — broad morale
 * buff + bond reinforcement across attendees, extra weight for Pious."
 *
 * The communal half of the §2.4 rest day in one ascending-eid pass.
 * Schedules still owns every clock fact this module consumes — the
 * weekday cycle (isRestDay), the ±90 s deterministic jitter, the wake
 * tick for cooldown stamps — and the SOCIAL system owns execution: this
 * module only books [Move door, Leisure{MASS}] chains, byte-for-byte
 * the chain shape a brain-scored evening outing uses, so movement parks
 * them and social executes them with zero special-casing downstream.
 *
 * BOOKING RULES (deterministic, no prng):
 *   - window    Sunday morning only — isMassTime gates on BOTH the rest
 *               day and the 09:00–11:00 band;
 *   - stagger   each Pop departs at its own jittered minute past 09:00
 *               (`massBookingTickFor` reuses schedules'
 *               transitionJitterTicks) so paths trickle, never stampede;
 *   - roster    living named Pops of the scoped player except CHILDREN
 *               (§2.3 childhood steers through School alone; Mass is
 *               adult/elder duty);
 *   - venue     the owner's NEAREST finished Church by center distance,
 *               ties by ascending eid (nearestVenueOf convention);
 *   - once      an empty queue AND no live self JobCooldown are both
 *               required, and booking stamps the same run-through-next-
 *               05:00 cooldown the brain stamps for private outings —
 *               one Mass per Pop per Sunday, no double-bookings;
 *   - priority  a still-standing private chain is cancelled at booking:
 *               communal duty outranks a tavern morning.
 *
 * EXPIRY: Leisure heads carrying LEISURE_VENUE_MASS that survive past
 * the band (a walker who never arrived) are cancelled WITHOUT effects
 * right here — social only ever executes Mass inside the church's
 * shadow, never at 3pm. Without a finished Church nothing is booked and
 * §2.4's "plain leisure" stands.
 */

import {
  cancelActivities,
  enqueueActivity,
  LEISURE_VENUE_MASS,
  leisureActivity,
  moveActivity,
  peekActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { jobCooldownActive, stampJobCooldown } from "../components/jobCooldown";
import { ownerOfUnit } from "../components/owner";
import { buildingIdOfCode } from "../../data/definitions";
import {
  LIFE_STAGE_CHILD,
  lifeStageOf,
  minuteOfDay,
  normalizeLifecycleConfig,
  DEFAULT_LIFECYCLE_CONFIG,
  type LifecycleConfig,
} from "./lifecycle";
import { resetSteeringBookkeeping } from "./movement";
import { isRestDay, transitionJitterTicks, wakeTickFor } from "./schedules";
import type { World, SimSystem } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/** Morning Mass opens at 09:00 sim-clock (§2.4 "Morning Mass"). */
export const MASS_OPEN_MINUTE = 9 * 60;
/** …and the band closes at 11:00; stragglers lose the blessing. */
export const MASS_CLOSE_MINUTE = 11 * 60;

/**
 * True when `tick` sits inside the Sunday Morning Mass band: the weekly
 * REST DAY plus the 09:00–11:00 window (pure clock math).
 */
export function isMassTime(tick: number, config: LifecycleConfig): boolean {
  if (!isRestDay(tick, config)) return false;
  const minute = minuteOfDay(tick, config);
  return minute >= MASS_OPEN_MINUTE && minute < MASS_CLOSE_MINUTE;
}

/**
 * The exact tick Pop `eid` books its Sunday Mass on `dayIndex`: the
 * band open plus the shared ±90 s transition jitter (same hash family
 * as every other §2.4 off-work transition — departures trickle).
 */
export function massBookingTickFor(
  eid: number,
  dayIndex: number,
  config: LifecycleConfig,
): number {
  return (
    dayIndex * config.dayTicks +
    Math.floor((MASS_OPEN_MINUTE * config.dayTicks) / 1440) +
    transitionJitterTicks(eid, dayIndex, config)
  );
}

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface MassDiagnostics {
  /** Communal chains booked into Move+Leisure{MASS} queues. */
  massesPlanned: number;
  /** Stale Mass heads cancelled after the band closed without effects. */
  expiredMasses: number;
}

export function createMassDiagnostics(): MassDiagnostics {
  return { massesPlanned: 0, expiredMasses: 0 };
}

// ---- The system ---------------------------------------------------------------

/** Every component id the Mass pass reads or writes. */
export type MassSystemComponents = Pick<
  SimComponents,
  | "identityId"
  | "unitTagId"
  | "positionId"
  | "activityQueueId"
  | "moveTargetId"
  | "velocityId"
  | "buildingId"
  | "ownerId"
  | "jobCooldownId"
>;

export interface MassSystemOptions {
  readonly comps: MassSystemComponents;
  /**
   * Players whose Pops attend Mass. Undefined serves everyone;
   * production wires [PLAYER_ONE] like schedules/social/the brain.
   */
  readonly players?: readonly number[] | undefined;
  /** Lifecycle timescale; compressed golden fixtures pass their own. */
  readonly lifecycleConfig?: LifecycleConfig | undefined;
  readonly diagnostics?: MassDiagnostics | undefined;
}

function requireRows(world: World, componentId: number): Map<number, number[]> {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) throw new Error("unregistered component");
  return rows as Map<number, number[]>;
}

/** Nearest passable tile to (tx, ty) by expanding square rings. */
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
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = clampedX + dx;
        const y = clampedY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (passability[y * size + x] === 1) return { x, y };
      }
    }
  }
  return undefined;
}

/** One finished Church of `playerId` nearest to (x, y); ties → lower eid. */
function nearestChurchOf(
  world: World,
  comps: MassSystemComponents,
  playerId: number,
  x: number,
  y: number,
): { eid: number; x: number; y: number } | undefined {
  let best: { eid: number; x: number; y: number } | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  let bestEid = Number.POSITIVE_INFINITY;
  const posRows = requireRows(world, comps.positionId);
  for (const [eid, row] of requireRows(world, comps.buildingId)) {
    if (row[0] !== playerId) continue;
    if (buildingIdOfCode(row[1]!) !== "church") continue;
    const pos = posRows.get(eid);
    if (!pos) continue;
    const d = (pos[0]! - x) ** 2 + (pos[1]! - y) ** 2;
    if (d < bestD || (d === bestD && eid < bestEid)) {
      bestD = d;
      bestEid = eid;
      best = { eid, x: pos[0]!, y: pos[1]! };
    }
  }
  return best;
}

/**
 * Build the Sunday Morning Mass SimSystem. Register AFTER school/
 * households (clock + roster facts settle first) and BEFORE social so a
 * chain booked this tick is advanced/executed next tick, and BEFORE
 * schedules so the night band still outranks any late booking.
 */
export function createMassSystem(options: MassSystemOptions): SimSystem {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createMassDiagnostics();
  const config = normalizeLifecycleConfig(
    options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG,
  );

  return (world: World): void => {
    const tick = world.tick;
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;
    const dayIndex = Math.floor(tick / config.dayTicks);
    const posRows = requireRows(world, comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = requireRows(world, comps.unitTagId);
    const identityRows = requireRows(world, comps.identityId);

    for (const eid of world.entities) {
      if (!tagRows.has(eid)) continue; // units only
      if (!identityRows.has(eid)) continue; // named Pops only
      if (
        players !== undefined &&
        !players.includes(ownerOfUnit(world, comps, eid))
      ) {
        continue;
      }

      // -- Expiry: stale Mass heads die quietly once the band is over.
      const queue = readActivityQueue(world, comps, eid);
      const head = peekActivity(queue);
      if (
        head?.kind === "leisure" &&
        head.venueCode === LEISURE_VENUE_MASS &&
        !isMassTime(tick, config)
      ) {
        cancelActivities(queue);
        writeActivityQueue(world, comps, eid, queue);
        diagnostics.expiredMasses += 1;
        continue;
      }

      // §2.3 childhood: children keep Sundays at home (their week is
      // School-shaped; Mass is adult/elder communal duty).
      if (lifeStageOf(world, comps, eid, config) === LIFE_STAGE_CHILD) {
        continue;
      }
      if (queue.length > 0) continue; // already steered this tick
      // One Mass per Sunday: a live self cooldown means this Pop already
      // booked (or completed) its outing today.
      if (jobCooldownActive(world, comps, eid, tick)) continue;
      if (!isMassTime(tick, config)) continue;
      if (tick < massBookingTickFor(eid, dayIndex, config)) {
        continue; // this Pop's jittered departure minute has not come
      }

      const pos = posRows.get(eid);
      if (!pos) continue;
      const church = nearestChurchOf(
        world,
        comps,
        ownerOfUnit(world, comps, eid),
        pos[0]!,
        pos[1]!,
      );
      if (!church) continue; // no finished Church ⇒ plain leisure (§2.4)
      const door = nearestPassableTile(
        passability,
        size,
        Math.floor(church.x),
        Math.floor(church.y),
      );
      if (!door) continue;

      // Book the communal chain; any standing private chain loses.
      cancelActivities(queue);
      enqueueActivity(queue, moveActivity([door.x + 0.5, door.y + 0.5]));
      enqueueActivity(queue, leisureActivity(LEISURE_VENUE_MASS, church.eid));
      writeActivityQueue(world, comps, eid, queue);
      setMoveTarget(world, comps, eid, door.x + 0.5, door.y + 0.5);
      const velRow = velRows?.get(eid);
      if (velRow) resetSteeringBookkeeping(velRow);
      stampJobCooldown(world, comps, eid, wakeTickFor(tick, config));
      diagnostics.massesPlanned += 1;
    }
  };
}

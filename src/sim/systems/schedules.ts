/**
 * Day/night schedules & sleep — SPEC §2.4 / M3-T6 (issue #51), extended
 * with the §2.4 weekly cycle in M3-T8 (issue #53).
 *
 * The §2.4 clock already exists (systems/lifecycle.ts `minuteOfDay`,
 * canonical 8-minute day = 14,400 ticks, integer sim minutes); this
 * module turns it into behavior. One ascending-eid pass steers every
 * named Pop through three derived phases — WORK → EVENING → SLEEP —
 * with NO phase component anywhere: state lives in digest-visible rows
 * (assignment rows + ActivityQueue sleep heads), phases derive from the
 * clock exactly like life stage does.
 *
 *   WORK    role-windowed labor: gatherers 06:00–18:00, builders
 *           +30 min offsets, producers −30 (children's School band
 *           stays systems/school.ts; military has no Identity row and
 *           is never scheduled).
 *   EVENING end-of-work: assigned Pops are released inside a bounded
 *           grace window once `tick ≥ closeTick + jitter(eid)` and walk
 *           to their household's bed slot. M3-T7: nothing HOLDS them
 *           there anymore — the released Pop simply goes idle, and the
 *           IAUS brain (whose leisure window this module defines via
 *           systems/social.isLeisureTime) scores the §2.4 evening
 *           venues from wherever the walk left them. One outing per
 *           Pop per evening, then idling until the 22:00 bedding.
 *           Jitter is ±90 SIM-CLOCK seconds, a pure (eid, dayIndex)
 *           hash — departures trickle instead of stampeding pathfinding
 *           (SPEC §2.4 performance note; gated by tests/perf/
 *           schedules-budget.test.ts and tests/perf/social-budget.test.ts).
 *   SLEEP   night band 22:00–05:00 (§2.4 awake band 5am–10pm): Pops
 *           with a Household home queue [Move bed, Sleep{wakeTick}].
 *           The Sleep activity is popped BY THIS SYSTEM at wakeTick —
 *           exactly once — applying the Rest refill:
 *
 *               refill = REST_REFILL_BASE × housingQuality × crowding
 *
 *           housing quality per building id (a finished House sleeps
 *           best; the Town Center is barracks-grade), crowding falls
 *           off linearly past one occupant per capacity seat. Rest
 *           decay is FROZEN while asleep (needs.ts reads the sleep
 *           head) so the wake lump lands on the pre-sleep level.
 *
 * WEEKLY CYCLE (M3-T8, SPEC §2.4 "7 named days; Sunday rest day"):
 * days roll deterministically off `dayIndexOf` modulo seven — Monday-
 * first naming so day 0 stays an ordinary workday and every existing
 * fixture (all shorter than one week) is untouched. On the REST DAY
 * (`isRestDay`, every seventh dawn) non-essential work windows are
 * CLOSED: assigned gatherers/builders are released at WAKE time through
 * the ordinary grace window (their close minute collapses to 05:00),
 * the brain refuses gather/build candidates outright, and private
 * leisure is re-weighted ABOVE work (SUNDAY_*_UTILITY_MULT consumed by
 * systems/mass + popBrain). Essential roles stay staffed —
 * REST_DAY_ESSENTIAL_ROLES keeps production open at half slot count
 * (restDayProductionSlotsOf); TC training needs no schedule surface at
 * all (the training queue consumes stock, never a villager's shift), so
 * it runs straight through Sundays by construction.
 *
 * DEPRIVATION ("deprivation ⇒ next-day work/combat penalties and
 * napping idle states", SPEC §2.4) derives from the Rest meter alone —
 * no stored flag: below DEPRIVED_REST_LEVEL the derived multiplier
 * {@link deprivationWorkMultiplierOf} slows work (folded into
 * skills.resolveGatherInterval and construction milli-ticks beside the
 * M3-T3 rest penalty), and during the work shift idle Pops take timed
 * micro-sleep NAPS (Sleep activities flagged isNap restoring a small
 * fixed amount) instead of staying employable.
 *
 * Player orders win, with one v1 exception: the 22:00 bedding outranks
 * even direct orders for scheduled Pops (night rest is not optional);
 * essential roles would be exempt via ESSENTIAL_ROLES — the stub list
 * is empty until a milestone ships one (distinct from the rest-day
 * roster above: ESSENTIAL_ROLES skips NIGHT steering, which no shipped
 * role qualifies for yet).
 *
 * Like the IAUS brain (M3-T3), production scopes this system to chosen
 * players: the skirmish session wires [PLAYER_ONE] so the scripted AI
 * opponent keeps its own planner stack unperturbed (SPEC §2.8 layering).
 * All randomness-free arithmetic is deterministic integer/float math on
 * digest-visible rows; no prng stream is touched.
 */

import {
  cancelActivities,
  dequeueCurrentActivity,
  enqueueActivity,
  moveActivity,
  peekActivity,
  sleepActivity,
} from "../activities";
import {
  clearAssignedSite,
  getBuildingRow,
  buildingRectOf,
} from "../components/buildings";
import {
  clearAssignedNode,
  type EconomyComponents,
} from "../components/economy";
import { readHousehold } from "../components/household";
import { clearProductionJob } from "../components/production";
import { FAMILY_UNASSIGNED, readIdentity } from "../components/pop";
import { NEED_MAX } from "../components/needs";
import { ownerOfUnit } from "../components/owner";
import {
  readActivityQueue,
  writeActivityQueue,
  setMoveTarget,
  type SimComponents,
} from "../components";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  dayIndexOf,
  minuteOfDay,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "./lifecycle";
import { HUNGRY_FOOD_LEVEL } from "./needs";
import { resetSteeringBookkeeping } from "./movement";
import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import type { World, SimSystem } from "../core/world";

// ---- Clock exposure (SPEC §2.4 integer-minute clock) --------------------------

export { minuteOfDay, dayIndexOf, DEFAULT_LIFECYCLE_CONFIG };

// ---- Weekly cycle (M3-T8, SPEC §2.4 "7 named days; Sunday rest") --------------

/** Days per §2.4 week — the named-day cycle length. */
export const DAYS_PER_WEEK = 7;

/**
 * The seven day names, Monday-first: day index 0 (every fixture's first
 * dawn) is an ordinary workday, and Sunday lands on index 6 — so no
 * pre-M3-T8 world ever crosses a rest day.
 */
export const WEEKDAY_NAMES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/** Weekday slot of `dayIndex` (0 = Monday … 6 = Sunday), wrap-safe. */
export function weekdayIndexOf(dayIndex: number): number {
  return (((dayIndex % DAYS_PER_WEEK) + DAYS_PER_WEEK) %
    DAYS_PER_WEEK) as number;
}

/** The named §2.4 weekday of `dayIndex` (pure, deterministic). */
export function weekdayNameOf(dayIndex: number): WeekdayName {
  return WEEKDAY_NAMES[weekdayIndexOf(dayIndex)]!;
}

/** The rest-day slot inside WEEKDAY_NAMES (§2.4 "Sunday rest day"). */
export const SUNDAY_DAY_INDEX = 6;

/**
 * True when `tick` falls on the weekly REST DAY — work windows close
 * (essential roles excepted), the village keeps Sunday.
 */
export function isRestDay(
  tick: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  return weekdayIndexOf(dayIndexOf(tick, config)) === SUNDAY_DAY_INDEX;
}

// ---- Documented tuning constants ---------------------------------------------

/** Work opens at 06:00 sim-clock for gatherers (§2.4 "~6am"). */
export const WORK_OPEN_MINUTE = 6 * 60;
/** Gatherer work closes at 18:00 ("~6pm"); other roles offset from this. */
export const WORK_CLOSE_MINUTE = 18 * 60;

/**
 * Per-role [open, close] offsets in sim minutes around the 06:00–18:00
 * base band (§2.4 "work windows per role"): builders start and finish
 * half an hour later, producers half an hour earlier. Children keep the
 * School band (systems/school.ts 9am–3pm) instead.
 */
export const ROLE_WORK_WINDOW_OFFSET_MINUTES: Readonly<
  Record<ScheduleRole, readonly [number, number]>
> = {
  gather: [0, 0],
  build: [30, 30],
  produce: [-30, -30],
};

/** Night band opens at 22:00 (awake band 5am–10pm, SPEC §2.4). */
export const SLEEP_OPEN_MINUTE = 22 * 60;
/** The village wakes at 05:00. */
export const WAKE_MINUTE = 5 * 60;

/**
 * Evening-release grace: after their role window closes, Pops may still
 * be released for this many sim minutes (the staggered departures land
 * here); past the grace the release stands down so late player orders
 * stick until the 22:00 bedding.
 */
export const RELEASE_GRACE_MINUTES = 90;

/**
 * Departure/bedding jitter half-span in SIM-CLOCK seconds: each Pop's
 * transition fires up to ±90 s (sim time) off the boundary, hashed from
 * (eid, dayIndex) — SPEC §2.4's "±90 s jitter … paths trickle, never
 * stampede".
 */
export const TRANSITION_JITTER_SIM_SECONDS = 90;

/** Arrival radius around the bed slot that counts as "in bed". */
export const BED_ARRIVAL_RADIUS_TILES = 1.5;

/**
 * Micro-sleep length in canonical ticks (~5 real seconds at 30 Hz),
 * scaled proportionally under compressed fixture clocks (≥ 1 tick).
 */
export const NAP_TICKS_CANONICAL = 150;

/** Idle Pops at/below this Rest level nap during the work shift. */
export const NAP_REST_LEVEL = 40;
/** Rest restored per completed nap (clamped at NEED_MAX). */
export const NAP_REST_RESTORE = 4;

/** Rest refill of a perfect night (quality 1 × crowding 1). */
export const REST_REFILL_BASE = 100;
/** A Pop waking below this Rest level is sleep-deprived for the day. */
export const DEPRIVED_REST_LEVEL = 30;
/** Work-speed multiplier while deprived (stacks with the M3-T3 slope). */
export const DEPRIVATION_WORK_MULT = 0.75;

/**
 * Housing quality per building id (§2.4 quality = housing × crowding):
 * a finished House is the baseline-perfect bedroom; households that
 * formed in a multi-seat Town Center sleep noticeably worse. Unlisted
 * buildings default to HOUSELESS_DEFAULT_QUALITY.
 */
export const HOUSING_QUALITY_BY_BUILDING_ID: Readonly<Record<string, number>> =
  {
    house: 1,
    "town-center": 0.6,
  };
export const HOUSING_DEFAULT_QUALITY = 0.5;

/**
 * Essential-role exception stub (§2.4 night fires arrive in later
 * milestones): roles listed here skip evening release AND night
 * bedding. Empty in M3 — the gate is wired, the roster is not. This is
 * the NIGHT-exemption surface, deliberately separate from
 * {@link REST_DAY_ESSENTIAL_ROLES} (the Sunday surface below).
 */
export const ESSENTIAL_ROLES: readonly string[] = [];

/** True when `role` is exempt from schedule steering. */
export function isEssentialRole(role: ScheduleRole | undefined): boolean {
  return role !== undefined && ESSENTIAL_ROLES.includes(role);
}

// ---- Rest-day essentials (M3-T8, SPEC §2.4 "essential roles only") ------------

/**
 * Roles that keep working through the §2.4 Sunday rest day: production
 * slots stay staffed (at reduced capacity — the village still eats).
 * Gather/build close outright; TC training needs no schedule surface
 * (its queue consumes stock, never a villager's shift) so it runs
 * through Sundays by construction.
 */
export const REST_DAY_ESSENTIAL_ROLES: readonly ScheduleRole[] = ["produce"];

/** True when `role` stays staffable on the weekly rest day. */
export function isRestDayEssentialRole(
  role: ScheduleRole | undefined,
): boolean {
  return role !== undefined && REST_DAY_ESSENTIAL_ROLES.includes(role);
}

/**
 * Sunday staffing fraction for essential production slots (§2.4
 * "essential roles only" at half crew): a 2-slot workshop runs one
 * crafter, odd sizes round up so a lone baker never loses their oven.
 */
export const REST_DAY_PRODUCTION_SLOT_FRACTION = 0.5;

/**
 * Essential production slots allowed on the rest day for a building
 * with `workSlots` ordinary slots (0 stays 0; otherwise ≥ 1).
 */
export function restDayProductionSlotsOf(workSlots: number): number {
  if (workSlots <= 0) return 0;
  return Math.max(1, Math.ceil(workSlots * REST_DAY_PRODUCTION_SLOT_FRACTION));
}

/**
 * Rest-day utility weighting consumed by the pop brain (systems/mass +
 * popBrain): leisure/home scores multiply UP, the surviving essential
 * work scores multiply DOWN — §2.4 Sundays lean toward plain leisure.
 */
export const SUNDAY_LEISURE_UTILITY_MULT = 1.25;
export const SUNDAY_WORK_UTILITY_MULT = 0.75;

// ---- Pure schedule math ---------------------------------------------------------

/** The three labor surfaces the IAUS brain assigns — a Pop's "role". */
export type ScheduleRole = "gather" | "build" | "produce";

/** Role work window in sim minutes: [open, close). */
export function roleWorkWindowMinutes(
  role: ScheduleRole,
): readonly [number, number] {
  const [openOff, closeOff] = ROLE_WORK_WINDOW_OFFSET_MINUTES[role];
  return [WORK_OPEN_MINUTE + openOff, WORK_CLOSE_MINUTE + closeOff];
}

/** True when `tick`'s sim minute falls inside `role`'s work window. */
export function isRoleWorkTime(
  role: ScheduleRole,
  tick: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  const [open, close] = roleWorkWindowMinutes(role);
  const minute = minuteOfDay(tick, config);
  return minute >= open && minute < close;
}

/** Core work shift (napping gate): the ungathered base 06:00–18:00 band. */
export function isCoreWorkTime(
  tick: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  const minute = minuteOfDay(tick, config);
  return minute >= WORK_OPEN_MINUTE && minute < WORK_CLOSE_MINUTE;
}

/** True inside the 22:00–05:00 night band (wraps midnight). */
export function isSleepTime(
  tick: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  const minute = minuteOfDay(tick, config);
  return minute >= SLEEP_OPEN_MINUTE || minute < WAKE_MINUTE;
}

/** The exact tick `dayIndex`'s village wakes at. */
export function wakeTickForDay(
  dayIndex: number,
  config: LifecycleConfig,
): number {
  return (
    dayIndex * config.dayTicks +
    Math.floor((WAKE_MINUTE * config.dayTicks) / 1440)
  );
}

/**
 * The wake tick for a sleeper bedded at `tick`: still-asleep-at-2am
 * stragglers wake THAT morning; everyone bedded from 22:00 wakes at the
 * NEXT 05:00.
 */
export function wakeTickFor(tick: number, config: LifecycleConfig): number {
  const dayIndex = dayIndexOf(tick, config);
  return minuteOfDay(tick, config) < WAKE_MINUTE
    ? wakeTickForDay(dayIndex, config)
    : wakeTickForDay(dayIndex + 1, config);
}

/**
 * Deterministic ±`TRANSITION_JITTER_SIM_SECONDS` offset in ticks for
 * (eid, dayIndex): a pure hash — same inputs, same offset, forever —
 * scaled proportionally under compressed clocks.
 */
export function transitionJitterTicks(
  eid: number,
  dayIndex: number,
  config: LifecycleConfig,
): number {
  const span = TRANSITION_JITTER_SIM_SECONDS * 2 + 1;
  const secondsHash =
    ((eid * 37 + dayIndex * 911) % span) - TRANSITION_JITTER_SIM_SECONDS;
  return Math.round((secondsHash * config.dayTicks) / 86400);
}

/**
 * Crowding factor from occupancy ÷ capacity: 1 while everyone has a
 * bed's worth of room, falling linearly to a hard floor of 0.25 at
 * double occupancy (§2.4 quality = housing × crowding).
 */
export function crowdingFactorOf(occupancy: number, capacity: number): number {
  if (capacity <= 0) return 0;
  const ratio = occupancy / capacity;
  if (ratio <= 1) return 1;
  return Math.max(0.25, 1 - (ratio - 1));
}

/** Housing quality of a finished building by definition id. */
export function housingQualityOf(buildingDefId: string): number {
  return (
    HOUSING_QUALITY_BY_BUILDING_ID[buildingDefId] ?? HOUSING_DEFAULT_QUALITY
  );
}

/**
 * The Rest refill one wake delivers: base × housing quality × crowding,
 * rounded, clamped to the meter scale.
 */
export function sleepRestRefillOf(
  housingQuality: number,
  crowdingFactor: number,
): number {
  return Math.min(
    NEED_MAX,
    Math.max(0, Math.round(REST_REFILL_BASE * housingQuality * crowdingFactor)),
  );
}

/**
 * Derived deprivation work penalty (SPEC §2.4 "next-day penalties"):
 * below DEPRIVED_REST_LEVEL work runs at DEPRIVATION_WORK_MULT, stacking
 * with the continuous M3-T3 rest slope. Rowless entities multiply by
 * exactly 1 — legacy arithmetic untouched.
 */
export function deprivationWorkMultiplierOf(
  world: World,
  comps: Pick<SimComponents, "needsId">,
  eid: number,
): number {
  const row = world.rowsByComponentId.get(comps.needsId)?.get(eid);
  if (!row) return 1;
  return row[1]! < DEPRIVED_REST_LEVEL ? DEPRIVATION_WORK_MULT : 1;
}

/** Nap length under `config`'s clock (proportional scaling, ≥ 1 tick). */
export function napTicksFor(config: LifecycleConfig): number {
  return Math.max(
    1,
    Math.floor((NAP_TICKS_CANONICAL * config.dayTicks) / 14400),
  );
}

// ---- Internals -----------------------------------------------------------------

/** Every component id the schedules pass reads or writes. */
export type ScheduleSystemComponents = Pick<
  SimComponents,
  | "identityId"
  | "unitTagId"
  | "activityQueueId"
  | "moveTargetId"
  | "velocityId"
  | "positionId"
  | "needsId"
  | "assignedNodeId"
  | "assignedSiteId"
  | "productionJobId"
  | "householdId"
  | "buildingId"
  | "ownerId"
> &
  EconomyComponents;

function requireRows(world: World, componentId: number): Map<number, number[]> {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) throw new Error("unregistered component");
  return rows as Map<number, number[]>;
}

/** Current labor role from live assignment rows (undefined when idle). */
function roleOfAssignment(
  world: World,
  comps: ScheduleSystemComponents,
  eid: number,
): ScheduleRole | undefined {
  if (requireRows(world, comps.assignedNodeId).has(eid)) return "gather";
  if (requireRows(world, comps.assignedSiteId).has(eid)) return "build";
  if (requireRows(world, comps.productionJobId).has(eid)) return "produce";
  return undefined;
}

/** The household entity bound to one Pop, or undefined (homeless). */
function familyEidOf(
  world: World,
  comps: ScheduleSystemComponents,
  eid: number,
): number | undefined {
  const identity = readIdentity(world, comps, eid);
  if (!identity || identity.familyId === FAMILY_UNASSIGNED) return undefined;
  return requireRows(world, comps.householdId).has(identity.familyId)
    ? identity.familyId
    : undefined;
}

/**
 * Everyone currently living at `homeEid`: living founders plus births
 * (the same occupancy contract systems/households.ts uses for beds —
 * mirrored locally to keep this module import-light).
 */
function occupancyOf(
  world: World,
  comps: ScheduleSystemComponents,
  homeEid: number,
): number {
  let occupants = 0;
  for (const famEid of requireRows(world, comps.householdId).keys()) {
    const household = readHousehold(world, comps, famEid);
    if (!household || household.homeEid !== homeEid) continue;
    if (requireRows(world, comps.identityId).has(household.headEid)) {
      occupants += 1;
    }
    if (requireRows(world, comps.identityId).has(household.partnerEid)) {
      occupants += 1;
    }
    occupants += household.birthCount;
  }
  return occupants;
}

/**
 * Deterministic bed slot for `eid` at `homeEid`: ring-1 perimeter tiles
 * clockwise from the north-west corner, rotated by eid so household
 * members spread across the walls instead of stacking on one tile.
 * Undefined when the whole ring is impassable (walled-in ruin).
 */
export function bedTileFor(
  world: World,
  comps: Pick<ScheduleSystemComponents, "buildingId" | "positionId">,
  homeEid: number,
  eid: number,
): { x: number; y: number } | undefined {
  const rect = buildingRectOf(world, comps, homeEid);
  if (!rect) return undefined;
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  const minX = Math.floor(rect.x) - 1;
  const minY = Math.floor(rect.y) - 1;
  const maxX = Math.floor(rect.x + rect.width);
  const maxY = Math.floor(rect.y + rect.height);
  const perimeter: { x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x++) perimeter.push({ x, y: minY });
  for (let y = minY + 1; y <= maxY; y++) perimeter.push({ x: maxX, y });
  for (let x = maxX - 1; x >= minX; x--) perimeter.push({ x, y: maxY });
  for (let y = maxY - 1; y > minY; y--) perimeter.push({ x: minX, y });
  const start = eid % perimeter.length;
  for (let i = 0; i < perimeter.length; i++) {
    const tile = perimeter[(start + i) % perimeter.length]!;
    if (tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size) continue;
    if (passability[tile.y * size + tile.x] === 1) {
      return { x: tile.x + 0.5, y: tile.y + 0.5 };
    }
  }
  return undefined;
}

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface SchedulesDiagnostics {
  /**
   * Evening releases steered (end-of-work → homeward walk; since M3-T7
   * the walk ends in leisure scoring, not a Wait hold).
   */
  releasedToHome: number;
  /** Bedding events (Move-bed/Sleep chains planned at the night band). */
  beddedNights: number;
  /** Sleep heads popped at wakeTick (full-quality refills). */
  wakesCompleted: number;
  /** Nap micro-sleeps taken during the work shift. */
  napsTaken: number;
}

export function createSchedulesDiagnostics(): SchedulesDiagnostics {
  return {
    releasedToHome: 0,
    beddedNights: 0,
    wakesCompleted: 0,
    napsTaken: 0,
  };
}

// ---- The system ---------------------------------------------------------------

export interface SchedulesSystemOptions {
  readonly comps: ScheduleSystemComponents;
  /**
   * Players whose named Pops follow the village schedule. Undefined
   * serves everyone; production wires [PLAYER_ONE] so the scripted AI
   * opponent keeps its own planner stack (SPEC §2.8 layering).
   */
  readonly players?: readonly number[] | undefined;
  /** Lifecycle timescale; compressed golden fixtures pass their own. */
  readonly lifecycleConfig?: LifecycleConfig | undefined;
  readonly diagnostics?: SchedulesDiagnostics | undefined;
}

/**
 * Build the schedules SimSystem. Register after needs (its decay pass
 * must see last tick's sleep heads before today's bedding) and before
 * the pop brain: since M3-T7 the brain consumes this module's clock
 * knowledge through the injected leisure window (systems/social
 * isLeisureTime), scoring evening venues exactly when releases go idle.
 */
export function createSchedulesSystem(
  options: SchedulesSystemOptions,
): SimSystem {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createSchedulesDiagnostics();
  const config = normalizeLifecycleConfig(
    options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG,
  );
  const napTicks = napTicksFor(config);

  return (world: World): void => {
    const tick = world.tick;
    const dayIndex = dayIndexOf(tick, config);
    const posRows = requireRows(world, comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = requireRows(world, comps.unitTagId);
    const identityRows = requireRows(world, comps.identityId);
    const needsRows = world.rowsByComponentId.get(comps.needsId);

    for (const eid of world.entities) {
      if (!tagRows.has(eid)) continue; // units only
      if (!identityRows.has(eid)) continue; // named Pops only (never military)
      if (
        players !== undefined &&
        !players.includes(ownerOfUnit(world, comps, eid))
      ) {
        continue;
      }

      const queue = readActivityQueue(world, comps, eid);

      // -- 1) Wake: pop due Sleep heads, refill exactly once ----------
      const head = peekActivity(queue);
      if (head?.kind === "sleep") {
        if (tick < head.wakeTick) continue; // still asleep
        dequeueCurrentActivity(queue);
        const needsRow = needsRows?.get(eid);
        if (needsRow) {
          if (head.isNap) {
            needsRow[1] = Math.min(NEED_MAX, needsRow[1]! + NAP_REST_RESTORE);
          } else {
            // Full-night refill: housing quality × crowding (§2.4).
            let refill = 0;
            const famEid = familyEidOf(world, comps, eid);
            const household =
              famEid !== undefined
                ? readHousehold(world, comps, famEid)
                : undefined;
            if (household !== undefined) {
              const homeRow = getBuildingRow(world, comps, household.homeEid);
              if (homeRow) {
                const cap = buildingDefOf(
                  buildingIdOfCode(homeRow[1]!),
                ).populationCap;
                refill = sleepRestRefillOf(
                  housingQualityOf(buildingIdOfCode(homeRow[1]!)),
                  crowdingFactorOf(
                    occupancyOf(world, comps, household.homeEid),
                    cap,
                  ),
                );
              }
            }
            needsRow[1] = Math.min(NEED_MAX, needsRow[1]! + refill);
          }
        }
        if (!head.isNap) diagnostics.wakesCompleted += 1;
        writeActivityQueue(world, comps, eid, queue);
        continue;
      }

      // -- 2) Already carrying a pending Sleep (walking to bed or
      //       napping later in the queue): hands off entirely.
      if (queue.some((activity) => activity.kind === "sleep")) continue;

      const role = roleOfAssignment(world, comps, eid);

      // -- 3) Night band: bed every scheduled Pop with a home --------
      if (isSleepTime(tick, config)) {
        if (isEssentialRole(role)) continue; // stub list: vacuous in M3
        const famEid = familyEidOf(world, comps, eid);
        if (famEid === undefined) continue; // homeless Pops roam (and tire)
        const household = readHousehold(world, comps, famEid)!;
        const bed = bedTileFor(world, comps, household.homeEid, eid);
        if (bed === undefined) continue;
        // Bedding staggers like departures: ±90 sim-s past 22:00.
        if (
          tick <
          dayIndex * config.dayTicks +
            Math.floor((SLEEP_OPEN_MINUTE * config.dayTicks) / 1440) +
            transitionJitterTicks(eid, dayIndex + 7, config)
        ) {
          continue;
        }
        // Release whatever the day left attached (orders lose to night).
        clearAssignedNode(world, comps, eid);
        clearAssignedSite(world, comps, eid);
        clearProductionJob(world, comps, eid);
        cancelActivities(queue);
        const pos = posRows.get(eid)!;
        const dx = bed.x - pos[0]!;
        const dy = bed.y - pos[1]!;
        if (dx * dx + dy * dy > BED_ARRIVAL_RADIUS_TILES ** 2) {
          enqueueActivity(queue, moveActivity([bed.x, bed.y]));
          setMoveTarget(world, comps, eid, bed.x, bed.y);
          const velRow = velRows?.get(eid);
          if (velRow) resetSteeringBookkeeping(velRow);
        }
        enqueueActivity(queue, sleepActivity(wakeTickFor(tick, config)));
        writeActivityQueue(world, comps, eid, queue);
        diagnostics.beddedNights += 1;
        continue;
      }

      // -- 4) Release: end-of-work → home walk, then LEISURE.
      //       M3-T7: the old Wait-hold is gone. The homeward Move still
      //       gives released Pops a destination (and keeps the evening
      //       pathfinding wave trickling), but on arrival they are idle
      //       with an empty queue — exactly the state the brain's IAUS
      //       leisure extension scores while the social module's
      //       isLeisureTime window (injected into the brain) is open.
      //       One outing per Pop per evening; the self cooldown stamped
      //       at assignment/completion runs through the 05:00 wake, and
      //       the 22:00 bedding cancels whatever is still standing.
      //       M3-T8: on the weekly REST DAY non-essential windows are
      //       CLOSED — their close minute collapses to the 05:00 wake,
      //       so assigned gatherers/builders are released through the
      //       ordinary staggered grace window at dawn and never work
      //       that day. Rest-day essential roles keep their ordinary
      //       window (production stays half-staffed all shift).
      if (role !== undefined && !isEssentialRole(role)) {
        const restDay = isRestDay(tick, config);
        const close =
          restDay && !isRestDayEssentialRole(role)
            ? WAKE_MINUTE
            : roleWorkWindowMinutes(role)[1];
        const minute = minuteOfDay(tick, config);
        const closeTickOffset = Math.floor((close * config.dayTicks) / 1440);
        if (
          minute >= close &&
          minute < close + RELEASE_GRACE_MINUTES &&
          tick >=
            dayIndex * config.dayTicks +
              closeTickOffset +
              transitionJitterTicks(eid, dayIndex, config)
        ) {
          const famEid = familyEidOf(world, comps, eid);
          const household =
            famEid !== undefined
              ? readHousehold(world, comps, famEid)
              : undefined;
          const bed =
            household !== undefined
              ? bedTileFor(world, comps, household.homeEid, eid)
              : undefined;
          clearAssignedNode(world, comps, eid);
          clearAssignedSite(world, comps, eid);
          clearProductionJob(world, comps, eid);
          cancelActivities(queue);
          const pos = posRows.get(eid)!;
          if (bed !== undefined) {
            const dx = bed.x - pos[0]!;
            const dy = bed.y - pos[1]!;
            if (dx * dx + dy * dy > BED_ARRIVAL_RADIUS_TILES ** 2) {
              enqueueActivity(queue, moveActivity([bed.x, bed.y]));
              setMoveTarget(world, comps, eid, bed.x, bed.y);
              const velRow = velRows?.get(eid);
              if (velRow) resetSteeringBookkeeping(velRow);
            }
          }
          writeActivityQueue(world, comps, eid, queue);
          diagnostics.releasedToHome += 1;
          continue;
        }
      }

      // -- 5) Deprivation napping: idle + drained during the shift ---
      if (
        role === undefined &&
        queue.length === 0 &&
        isCoreWorkTime(tick, config) &&
        needsRowLevel(needsRows, eid, 1) < NAP_REST_LEVEL &&
        needsRowLevel(needsRows, eid, 0) > HUNGRY_FOOD_LEVEL
      ) {
        enqueueActivity(queue, sleepActivity(tick + napTicks, true));
        writeActivityQueue(world, comps, eid, queue);
        diagnostics.napsTaken += 1; // completed at the wake pop (step 1)
      }
    }
  };
}

/** Safe meter read (rowless/legacy Pops read as full). */
function needsRowLevel(
  needsRows: Map<number, number[]> | undefined,
  eid: number,
  index: number,
): number {
  const row = needsRows?.get(eid);
  if (!row) return NEED_MAX;
  return row[index] ?? NEED_MAX;
}

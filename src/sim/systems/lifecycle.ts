/**
 * Lifecycle system — SPEC §2.3 birth→child→adult→elder→death / M3-T5
 * (issue #50).
 *
 * Stage is DERIVED, never stored ("derived stats, never stored", SPEC
 * §2.5 discipline): a Pop's effective age is a pure function of its
 * Identity row and the world clock, so every read path (pop brain,
 * order handlers, combat strikes) can consult it with zero bookkeeping
 * and no new digest rows:
 *
 *   elapsed      = tick − birthTick
 *   effectiveAge = elapsed + (origin === POP_ORIGIN_ARRIVAL
 *                               ? adultTicks : 0)
 *
 * Natural-born children (POP_ORIGIN_BIRTH) age from birthTick: child
 * until the adult threshold (~6–8 real minutes at the canonical clock —
 * one §2.4 day), adult until the elder threshold (SPEC lifespan ~40 min
 * ⇒ elder from day 4), then die at the lifespan threshold. ARRIVAL Pops
 * (trained villagers, starting settlers) enter as working adults whose
 * elder/death clocks run from arrival.
 *
 * Aging lands ON DAY BOUNDARIES measured from birthTick: thresholds are
 * whole-day multiples of dayTicks, so transitions fire exactly when
 * effective age crosses them (school graduation reads the same exact
 * boundary — systems/school.ts).
 *
 * The system pass itself owns only what derivation cannot do: natural
 * death at end of lifespan — despawnEntity drops EVERY row on the dead
 * Pop (work claims die with the owner; Household head/partner fields go
 * stale by design and are validated lazily on the households daily
 * pass). Iteration is ascending eid; arithmetic is integer-only.
 *
 * Timescale: production runs the canonical §2.4 clock (one 8-minute day
 * = 14,400 ticks — the same constant RUST_GRACE_TICKS documents as "one
 * 8-min day"). Golden fixtures compress days through LifecycleConfig to
 * watch generations turn inside one test.
 */

import {
  POP_ORIGIN_BIRTH,
  readIdentity,
  type PopComponents,
} from "../components/pop";
import { despawnEntity, type World, type SimSystem } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/**
 * Canonical §2.4 day length in ticks: an 8-minute day at the 30 Hz sim
 * tick (480 s × 30).
 */
export const DAY_TICKS = 14_400;

/** Life stages in ascending order — stable codes for tests/telemetry. */
export const LIFE_STAGE_CHILD = "child" as const;
export const LIFE_STAGE_ADULT = "adult" as const;
export const LIFE_STAGE_ELDER = "elder" as const;
export type LifeStage =
  typeof LIFE_STAGE_CHILD | typeof LIFE_STAGE_ADULT | typeof LIFE_STAGE_ELDER;

/** SPEC §2.3: adulthood after ~6–8 real minutes — one compressed day. */
export const ADULT_AGE_DAYS = 1;
/** SPEC §2.3: elder past work age with a light-duty tail before death. */
export const ELDER_AGE_DAYS = 4;
/** SPEC §2.3: lifespan ~40 real minutes ⇒ five canonical days. */
export const LIFESPAN_DAYS = 5;

/**
 * Boot-time minute-of-day offset (SPEC §2.4 / Issue #75): games boot at
 * 07:00 AM (420 minutes) so the initial scene is bathed in morning sunlight
 * and villagers are already awake for their workday.
 */
export const BOOT_MINUTE_OFFSET = 420;

/** Lifecycle timescale — override in fixtures for compressed weeks. */
export interface LifecycleConfig {
  /** Ticks per simulated day (canonical 14,400). */
  readonly dayTicks: number;
  /** Adult at this many whole days of effective age. */
  readonly adultAgeDays: number;
  /** Elder at this many whole days of effective age. */
  readonly elderAgeDays: number;
  /** Natural death at this many whole days of effective age. */
  readonly lifespanDays: number;
  /** Clock offset in minutes applied to minuteOfDay (canonical 420 = 7:00 AM). */
  readonly clockOffsetMinutes?: number | undefined;
}

/** The production clock: SPEC §2.3 lifetimes on the §2.4 day grid. */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  dayTicks: DAY_TICKS,
  adultAgeDays: ADULT_AGE_DAYS,
  elderAgeDays: ELDER_AGE_DAYS,
  lifespanDays: LIFESPAN_DAYS,
  clockOffsetMinutes: BOOT_MINUTE_OFFSET,
};

export function normalizeLifecycleConfig(
  config: Partial<LifecycleConfig> = {},
): LifecycleConfig {
  const dayTicks = config.dayTicks ?? DEFAULT_LIFECYCLE_CONFIG.dayTicks;
  if (
    !Number.isInteger(dayTicks) ||
    dayTicks <= 0 ||
    !Number.isInteger(config.adultAgeDays ?? ADULT_AGE_DAYS) ||
    !Number.isInteger(config.elderAgeDays ?? ELDER_AGE_DAYS) ||
    !Number.isInteger(config.lifespanDays ?? LIFESPAN_DAYS)
  ) {
    throw new Error(`invalid LifecycleConfig: ${JSON.stringify(config)}`);
  }
  const cfg: LifecycleConfig = {
    dayTicks,
    adultAgeDays: config.adultAgeDays ?? ADULT_AGE_DAYS,
    elderAgeDays: config.elderAgeDays ?? ELDER_AGE_DAYS,
    lifespanDays: config.lifespanDays ?? LIFESPAN_DAYS,
    clockOffsetMinutes:
      config.clockOffsetMinutes ??
      (config.dayTicks !== undefined ? 0 : BOOT_MINUTE_OFFSET),
  };
  if (!(
    cfg.adultAgeDays < cfg.elderAgeDays && cfg.elderAgeDays <= cfg.lifespanDays
  )) {
    throw new Error(
      `LifecycleConfig thresholds must ascend (adult < elder ≤ lifespan): ${JSON.stringify(cfg)}`,
    );
  }
  return cfg;
}

/** Whole-day tick thresholds implied by a config. */
export function adultTicksOf(config: LifecycleConfig): number {
  return config.adultAgeDays * config.dayTicks;
}
export function elderTicksOf(config: LifecycleConfig): number {
  return config.elderAgeDays * config.dayTicks;
}
export function lifespanTicksOf(config: LifecycleConfig): number {
  return config.lifespanDays * config.dayTicks;
}

/** Sim-clock minute of one tick under `config`'s day length (0–1439). */
export function minuteOfDay(tick: number, config: LifecycleConfig): number {
  const perMinute = config.dayTicks / 1440;
  const rawMinute = Math.floor((tick % config.dayTicks) / perMinute);
  const offset = config.clockOffsetMinutes ?? 0;
  return (rawMinute + offset) % 1440;
}

/** Day index of one tick (whole days elapsed since tick 0). */
export function dayIndexOf(tick: number, config: LifecycleConfig): number {
  return Math.floor(tick / config.dayTicks);
}

// ---- Pure stage math -----------------------------------------------------------

/**
 * Stage for one effective age in ticks: child below the adult
 * threshold, adult below the elder threshold, elder beyond.
 */
export function lifeStageAt(
  effectiveAgeTicks: number,
  config: LifecycleConfig,
): LifeStage {
  if (effectiveAgeTicks < adultTicksOf(config)) return LIFE_STAGE_CHILD;
  if (effectiveAgeTicks < elderTicksOf(config)) return LIFE_STAGE_ADULT;
  return LIFE_STAGE_ELDER;
}

/** Component ids the lifecycle read paths need (Identity only). */
export type LifecycleComponents = PopComponents; /**
 * Effective age of one named Pop right now, or undefined for entities
 * without an Identity row (rowless legacy units never age).
 */
export function effectiveAgeOf(
  world: World,
  comps: Pick<LifecycleComponents, "identityId">,
  eid: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): number | undefined {
  const identity = readIdentity(world, comps, eid);
  if (!identity) return undefined;
  const elapsed = world.tick - identity.birthTick;
  // ARRIVAL Pops enter as working adults: their pre-adult years are
  // presumed spent elsewhere, and the elder clock runs from arrival.
  return identity.origin === POP_ORIGIN_BIRTH
    ? elapsed
    : elapsed + adultTicksOf(config);
}

/** Derived life stage of one Pop (undefined rowless — legacy units). */
export function lifeStageOf(
  world: World,
  comps: Pick<LifecycleComponents, "identityId">,
  eid: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): LifeStage | undefined {
  const age = effectiveAgeOf(world, comps, eid, config);
  return age === undefined ? undefined : lifeStageAt(age, config);
}

/** True when `eid` is a named child (children cannot work or fight). */
export function isChildOf(
  world: World,
  comps: Pick<LifecycleComponents, "identityId">,
  eid: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  return lifeStageOf(world, comps, eid, config) === LIFE_STAGE_CHILD;
}

/** True when `eid` is a named elder (light duties only). */
export function isElderOf(
  world: World,
  comps: Pick<LifecycleComponents, "identityId">,
  eid: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean {
  return lifeStageOf(world, comps, eid, config) === LIFE_STAGE_ELDER;
}

// ---- Order-handler gate ----------------------------------------------------------

/**
 * Filter player-ordered actors down to those allowed to work/fight:
 * children are politely dropped (SPEC §2.3 "childhood — cannot work/
 * fight"), everything else passes through in order. Uses the canonical
 * clock — compressed fixture clocks only ever make MORE Pops children,
 * never fewer, so the gate stays conservative under compression.
 */
export function workingActorsOnly(
  world: World,
  comps: Pick<LifecycleComponents, "identityId">,
  entityIds: readonly number[],
): number[] {
  return entityIds.filter((eid) => !isChildOf(world, comps, eid));
}

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface LifecycleDiagnostics {
  /** Pops that died of old age at the lifespan boundary. */
  naturalDeaths: number;
  /** Elder-phase Pops alive at each death pass (telemetry only). */
  elderDeaths: number;
}

export function createLifecycleDiagnostics(): LifecycleDiagnostics {
  return { naturalDeaths: 0, elderDeaths: 0 };
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the lifecycle SimSystem: the natural-death pass. Register it
 * anywhere after spawn-producing systems; deaths despawn mid-tick like
 * combat kills do. Worlds without it simply never age (legacy fixture
 * compatibility); production registers it after needs, before popBrain.
 */
export function createLifecycleSystem(
  comps: Pick<LifecycleComponents, "identityId"> & { unitTagId: number },
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
  diagnostics: LifecycleDiagnostics = createLifecycleDiagnostics(),
): SimSystem {
  const normalized = normalizeLifecycleConfig(config);
  const lifespanTicks = lifespanTicksOf(normalized);
  return (world: World): void => {
    const identityRows = world.rowsByComponentId.get(comps.identityId);
    if (!identityRows || identityRows.size === 0) return;
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    if (!tagRows) return;
    for (const eid of [...identityRows.keys()].sort((a, b) => a - b)) {
      if (!tagRows.has(eid)) continue; // Pops only (never buildings)
      const identity = identityRows.get(eid)!;
      const elapsed = world.tick - identity[1]!;
      const origin = identity[3] ?? 0;
      const age =
        origin === POP_ORIGIN_BIRTH
          ? elapsed
          : elapsed + adultTicksOf(normalized);
      if (age < lifespanTicks) continue;
      // Death is final (SPEC §2.3): despawnEntity drops every attached
      // row — work claims die with their owner, family references go
      // stale for the households daily pass to validate.
      despawnEntity(world, eid);
      diagnostics.naturalDeaths += 1;
      if (age >= elderTicksOf(normalized)) diagnostics.elderDeaths += 1;
    }
  };
}

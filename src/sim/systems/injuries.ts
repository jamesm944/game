/**
 * Injuries system — SPEC §2.5 wounds / M3-T4 (issue #49).
 *
 * One allocation path feeds every combat wound; one rare-tick pass
 * heals, scars and kills. "One system, two contexts" (SPEC §2.5): the
 * SAME active-severity stacks degrade aim/speed in battle and work
 * rates at home through the derived-on-read multipliers of
 * components/body.ts.
 *
 * Allocation (combat strikes): every landed blow converts to hediff
 * severity (INJURY_SEVERITY_PER_DAMAGE × damage) and lands on ONE body
 * part drawn from a seeded roll — torso/head 50%, arms 30%, legs 20%,
 * split within groups so no single part dominates. The roll is a PURE
 * function of (world.seed, victimEid, tick, live stack count) via a
 * dedicated hash stream — it NEVER touches world.prng or the per-Pop
 * identity streams, so movement/economy/combat replay fixtures stay
 * byte-identical (same doctrine as components/pop.ts).
 *
 * Rare-tick pass (RimWorld tickerType pattern, skills-rust stagger):
 * each wounded entity processes on `(tick + eid) % RARE_TICK_INTERVAL`
 * (reuses the skills pass's exact cadence). Per open stack:
 *
 *   severity       -= HEAL_SEVERITY_PER_RARE_TICK   (floored at 0)
 *   ticksRemaining -= RARE_TICK_INTERVAL
 *
 *   severity hits 0 first          → healed CLEAN, stack removed
 *   ticksRemaining expires first   → healed-at-full-severity: a
 *     permanent scar {part, residual severity} is appended and the
 *     stack removed (scar permanence, SPEC §2.5)
 *
 * After resolution the death check runs: cumulative ACTIVE severity
 * above DEATH_SEVERITY_THRESHOLD kills. Deaths route through the same
 * pipeline as combat deaths — UNIT_DEATH event on the owner's ledger
 * (attackerEid 0: nobody landed the killing blow), then despawnEntity,
 * whose row wipe releases work-slot/site/production claims by
 * construction (claims ARE rows); lingering Attack heads targeting the
 * corpse are dropped by combat's own stale-target backstop next tick.
 *
 * Determinism: integer arithmetic only, ascending-eid iteration, all
 * state digest-visible Body rows. Rowless entities no-op everywhere —
 * legacy fixtures untouched.
 */

import {
  addInjuryStack,
  BODY_PART_ARM_L,
  BODY_PART_ARM_R,
  BODY_PART_HEAD,
  BODY_PART_LEG_L,
  BODY_PART_LEG_R,
  BODY_PART_TORSO,
  bodyRowOf,
  cumulativeActiveSeverityFromRow,
  DEATH_SEVERITY_THRESHOLD,
  INJURY_STACK_STRIDE,
  SCAR_ENTRY_STRIDE,
  type BodyComponents,
} from "../components/body";
import {
  appendCombatEvent,
  COMBAT_EVENT_UNIT_DEATH,
  ledgerEidOf,
} from "../components/combat";
import { despawnEntity, type SimSystem, type World } from "../core/world";
import { dropCarriedRelicsOf } from "../components/relic";
import { RARE_TICK_INTERVAL, rareTickDue } from "./skills";

/** Components the injury helpers/system need (SimComponents satisfies). */
export type InjurySystemComponents = BodyComponents & {
  readonly ownerId: number;
  readonly combatId: number;
  readonly combatEventsId: number;
  readonly stockpileId: number;
  /** M4-T5: carried relics ground at the corpse's position on death. */
  readonly positionId: number;
  readonly relicId: number;
};

// ---- Documented tuning constants ---------------------------------------------

/** Hediff severity gained per point of strike damage. */
export const INJURY_SEVERITY_PER_DAMAGE = 2;

/**
 * Recovery window per wound (ticks): a stack still severe when its
 * window closes scars instead of healing clean. At the heal rate below,
 * single stacks of up to 18 severity drain clean in time; anything
 * heavier heals at full severity — a permanent scar.
 */
export const INJURY_DURATION_TICKS = 1500;

/** Active severity drained per rare tick (impairments ease as it goes). */
export const HEAL_SEVERITY_PER_RARE_TICK = 3;

/**
 * Strike→part allocation weights in basis points over 10 000 (integer
 * math, no float edges). Group contract per #49: torso+head 50%,
 * arms 30%, legs 20%; within-group splits documented here.
 */
export const PART_WEIGHT_BASIS_POINTS: readonly number[] = [
  /* torso */ 3000, /* head  */ 5000, /* armL  */ 6500, /* armR  */ 8000,
  /* legL  */ 9000, /* legR  */ 10000,
] as const;

const PART_CODES_BY_ROLL_ORDER: readonly number[] = [
  BODY_PART_TORSO,
  BODY_PART_HEAD,
  BODY_PART_ARM_L,
  BODY_PART_ARM_R,
  BODY_PART_LEG_L,
  BODY_PART_LEG_R,
];

// ---- Seeded allocation roll ------------------------------------------------------

const INJURY_STREAM_DOMAIN = 0x626f6479; // "body"

function mix32(z: number): number {
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Pure strike→part roll for one blow: 0..9999 against
 * PART_WEIGHT_BASIS_POINTS. A pure function of digest-visible state
 * (seed, victim, tick, current stack count) — replays recompute it
 * bit-exactly without consuming any shared stream.
 */
export function strikePartRoll(
  seed: number,
  victimEid: number,
  tick: number,
  stackCount: number,
): number {
  let z = (seed ^ INJURY_STREAM_DOMAIN) >>> 0 || 1;
  z = mix32(z ^ Math.imul(victimEid + 1, 0x9e3779b9));
  z = mix32(z ^ Math.imul(tick + 1, 0x85ebca6b));
  z = mix32(z ^ Math.imul(stackCount + 1, 0xc2b2ae35));
  return z % 10_000;
}

/** Resolve one allocation roll (0..9999) to its body-part code. */
export function partCodeForRoll(roll: number): number {
  for (let i = 0; i < PART_WEIGHT_BASIS_POINTS.length; i++) {
    if (roll < PART_WEIGHT_BASIS_POINTS[i]!) {
      return PART_CODES_BY_ROLL_ORDER[i]!;
    }
  }
  return PART_CODES_BY_ROLL_ORDER[PART_CODES_BY_ROLL_ORDER.length - 1]!;
}

function pickPartCode(roll: number): number {
  return partCodeForRoll(roll);
}

// ---- Allocation path -------------------------------------------------------------

export interface StrikeInjuryOutcome {
  /** Severity actually stored after capacity clamping (0 = saturated). */
  readonly storedSeverity: number;
  /** True when this blow pushed cumulative severity past the threshold. */
  readonly fatal: boolean;
}

/**
 * Allocate ONE combat strike's wounds onto the victim's Body row:
 * convert damage → severity, roll the part, append the clamped stack.
 * Rowless victims no-op with a non-fatal outcome. Returns whether the
 * accumulated trauma is immediately lethal so the caller can route
 * through its kill pipeline.
 */
export function applyStrikeInjuries(
  world: World,
  comps: BodyComponents,
  victimEid: number,
  damage: number,
): StrikeInjuryOutcome {
  if (!Number.isInteger(damage) || damage < 1) {
    throw new Error(
      `strike injury requires positive integer damage, got ${String(damage)}`,
    );
  }
  const row = bodyRowOf(world, comps, victimEid);
  if (!row) return { storedSeverity: 0, fatal: false };
  const before = row[0]!;
  const severity = damage * INJURY_SEVERITY_PER_DAMAGE;
  const partCode = pickPartCode(
    strikePartRoll(world.seed, victimEid, world.tick, before),
  );
  const storedSeverity = addInjuryStack(
    world,
    comps,
    victimEid,
    partCode,
    severity,
    INJURY_DURATION_TICKS,
  );
  return {
    storedSeverity,
    fatal:
      storedSeverity > 0 &&
      cumulativeActiveSeverityFromRow(bodyRowOf(world, comps, victimEid)!) >
        DEATH_SEVERITY_THRESHOLD,
  };
}

// ---- Death pipeline ----------------------------------------------------------------

/**
 * Death by wounds through the existing death pipeline: UNIT_DEATH event
 * on the owner's ledger (attackerEid 0 — no striker landed the final
 * blow; owners without any ledger entity skip only the log entry),
 * followed by despawnEntity. Every component row dies at once, so
 * AssignedNode/AssignedSite/ProductionJob claims are released by
 * construction; combat's stale-target backstop drops any Attack head
 * that still points here when it next runs.
 */
export function killUnitByWounds(
  world: World,
  comps: InjurySystemComponents,
  victimEid: number,
  totalSeverity: number,
): void {
  // Owner attribution rides the explicit Owner row when present
  // (non-player-zero villagers), else the Combat row's owner column
  // (military), else the documented legacy default (player zero).
  const owner =
    world.rowsByComponentId.get(comps.ownerId)?.get(victimEid)?.[0] ??
    world.rowsByComponentId.get(comps.combatId)?.get(victimEid)?.[1] ??
    0;
  if (
    Number.isInteger(owner) &&
    ledgerEidOf(world, comps.stockpileId, owner) !== undefined
  ) {
    appendCombatEvent(world, comps, owner, {
      tick: world.tick,
      kind: COMBAT_EVENT_UNIT_DEATH,
      attackerEid: 0,
      victimEid,
      amount: totalSeverity,
    });
  }
  // M4-T5 §2.11: a wound-dead carrier grounds its carried relic before
  // the rows die (combat kills take the same hook).
  dropCarriedRelicsOf(world, comps, victimEid);
  despawnEntity(world, victimEid);
}

// ---- The system --------------------------------------------------------------------

/**
 * Build the injuries SimSystem: the rare-tick heal/scar/death pass.
 * Register AFTER combat (strikes allocate during the combat step; this
 * pass observes the resulting rows), alongside skills/needs. Worlds
 * without it simply never run wounds through time.
 */
export function createInjuriesSystem(comps: InjurySystemComponents): SimSystem {
  return (world: World): void => {
    const rows = world.rowsByComponentId.get(comps.bodyId);
    if (!rows || rows.size === 0) return;
    const tick = world.tick;
    for (const eid of world.entities) {
      if (!rareTickDue(tick, eid)) continue;
      const row = rows.get(eid);
      if (!row) continue;
      advanceWounds(row);
      const total = cumulativeActiveSeverityFromRow(row);
      if (total > DEATH_SEVERITY_THRESHOLD) {
        killUnitByWounds(world, comps, eid, total);
      }
    }
  };
}

/**
 * Advance every open stack on one raw row by one rare tick: drain
 * severity, count down the recovery window, resolve each stack either
 * clean (drained to zero inside its window) or into a permanent scar
 * appended after the surviving stacks (window closed while severe).
 * Rebuilds the flat row in one pass — order of survivors and scars is
 * chronological by insertion.
 */
function advanceWounds(row: number[]): void {
  const stackCount = row[0]!;
  const scarBase = 1 + stackCount * INJURY_STACK_STRIDE;
  const carriedScars = row.slice(scarBase); // count-led scars segment

  const survivors: number[] = [];
  for (let i = 0; i < stackCount; i++) {
    const base = 1 + i * INJURY_STACK_STRIDE;
    const partCode = row[base]!;
    const severity = Math.max(0, row[base + 1]! - HEAL_SEVERITY_PER_RARE_TICK);
    const ticksRemaining = row[base + 2]! - RARE_TICK_INTERVAL;
    if (severity === 0) continue; // healed clean inside its window
    if (ticksRemaining <= 0) {
      // Healed-at-full-severity: permanent scar {part, residual}.
      carriedScars.push(partCode, severity);
      continue;
    }
    survivors.push(partCode, severity, ticksRemaining);
  }

  const next: number[] = [
    survivors.length / INJURY_STACK_STRIDE,
    ...survivors,
    (carriedScars.length - 1) / SCAR_ENTRY_STRIDE,
    ...carriedScars.slice(1),
  ];
  row.splice(0, row.length, ...next);
}

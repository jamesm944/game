/**
 * Skills system — SPEC §2.3 knowledge-vs-practice / M3-T2 (issue #47).
 *
 * One award path feeds every skill-bearing event; one rare-tick pass
 * rusts idle practice back toward the knowledge floor.
 *
 * Awards (practice XP by DOING — CDDA practice pool):
 *   gather extraction   → gathering, GATHER_XP_PER_UNIT per extracted
 *                         unit (DF mining-grade constant)
 *   build contribution  → construction, CONSTRUCTION_XP_PER_TICK per
 *                         in-range contributing builder-tick
 *   combat strike / kill→ melee or ranged (by the attacker's reach),
 *                         COMBAT_XP_PER_HIT per landed blow plus
 *                         COMBAT_XP_PER_KILL on kills
 *
 * Every award routes through awardPractice, which applies the Pop's
 * trait xpGainMult (fast-learner/slow-learner), clamps total XP at the
 * Legendary cap, and stamps lastPracticeTick. Knowledge XP enters ONLY
 * through grantKnowledge (School lesson windows land in a later M3
 * ticket); it never decays. Entities without a Skills row no-op every
 * entry point — legacy fixtures stay byte-identical.
 *
 * Levels are derived on read: levelOfTotalXp(knowledgeXp + practiceXp).
 * The work/combat multipliers fold into the derived-stats read paths:
 *   work speed ×(100+6·L)/100 → gather ticks-per-unit shrink and build
 *   milli-ticks grow (integer-rounded; L=0 is bit-identical to base);
 *   attack ×(100+4·L)/100 via StatContext.skillLevels.
 * Trait workSpeedMult (industrious/lazy) multiplies the work side here
 * too.
 *
 * Rust pass (rare tick, RimWorld tickerType pattern — SPEC §2.3's
 * ~250-tick hash-stagger): entities process iff
 * `(tick + eid) % RARE_TICK_INTERVAL === 0`. Per skill entry, DF-style
 * counter machine compressed to game scale (constants documented in
 * docs/research/pop-sim-sources.md):
 *
 *   idle < RUST_GRACE_TICKS      → rustAccumulator resets
 *   else accumulator += 1; at RUST_ACCUMULATOR_CAP it resets and one
 *   RUST_DRAIN_PRACTICE_XP chunk drains off practiceXp (never below
 *   zero). knowledgeXp is untouchable — the knowledge floor holds by
 *   construction because practice lives ABOVE it in the same row.
 *
 * Determinism: integer arithmetic only, ascending-eid iteration, all
 * state digest-visible Skills/Traits rows. Register after gather/
 * construction/combat so the pass observes this tick's awards.
 */

import {
  insertSkillEntryInRow,
  skillsRowOf,
  SKILL_ENTRY_ARITY,
  type SkillComponents,
} from "../components/skills";
import { readTraits } from "../components/pop";
import {
  LEGENDARY_TOTAL_XP,
  levelOfTotalXp,
  type SkillSlug,
  skillCodeOf,
} from "../data/skills";
import { traitWorkSpeedMult, traitXpGainMult } from "../data/traits";
import type { SimComponents } from "../components";
import type { NeedsComponents } from "../components/needs";
import { injuryImpairmentOf } from "../components/body";
import { restWorkMultiplierOf } from "./needs";
import { deprivationWorkMultiplierOf } from "./schedules";
import type { SimSystem, World } from "../core/world";

/** Components the skill helpers/system need. */
export type SkillSystemComponents = SkillComponents & {
  readonly traitsId: number;
};

// ---- Documented tuning constants ---------------------------------------------

/** Rare-tick cadence: SPEC §2.3's ~250-tick staggered tier. */
export const RARE_TICK_INTERVAL = 250;
/** Practice newer than this many ticks is immune to rust (one 8-min day). */
export const RUST_GRACE_TICKS = 14_400;
/** Idle rare-ticks needed to bank one drain event (DF unused-cap steal). */
export const RUST_ACCUMULATOR_CAP = 8;
/** practiceXp removed per drain event (~720 XP per fully idle day). */
export const RUST_DRAIN_PRACTICE_XP = 100;

/** gathering XP per extracted resource unit. */
export const GATHER_XP_PER_UNIT = 10;
/** construction XP per contributing builder-tick. */
export const CONSTRUCTION_XP_PER_TICK = 1;
/** melee/ranged XP per landed strike. */
export const COMBAT_XP_PER_HIT = 10;
/** bonus melee/ranged XP for a kill. */
export const COMBAT_XP_PER_KILL = 50;

/** Work-speed percent added per skill level (×(100+6L)/100 exact). */
export const WORK_RATE_PCT_PER_LEVEL = 6;
/** Attack percent added per relevant combat skill level. */
export const ATTACK_PCT_PER_LEVEL = 4;

/** True on this entity's staggered rare tick (pure (tick, eid) function). */
export function rareTickDue(tick: number, eid: number): boolean {
  return (tick + eid) % RARE_TICK_INTERVAL === 0;
}

// ---- Award & knowledge path ---------------------------------------------------

function traitSlugsOf(
  world: World,
  comps: Pick<SkillSystemComponents, "traitsId">,
  eid: number,
): string[] {
  return readTraits(world, comps, eid) ?? [];
}

function mutateEntry(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  slug: SkillSlug | string,
  mutate: (
    practiceXp: number,
    rustAccumulator: number,
    lastPracticeTick: number,
    base: number,
    row: number[],
  ) => void,
): void {
  const row = skillsRowOf(world, comps, eid);
  if (!row) return; // legacy rowless Pop: awards/rust never apply
  const code = skillCodeOf(slug);
  let base = -1;
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    const candidate = 1 + i * SKILL_ENTRY_ARITY;
    if (row[candidate] === code) {
      base = candidate;
      break;
    }
    if (row[candidate]! > code) break;
  }
  if (base === -1) {
    // First touch of this skill: insert its zeroed entry (ascending).
    base = insertSkillEntryInRow(row, slug);
  }
  mutate(row[base + 1]!, row[base + 2]!, row[base + 3]!, base, row);
}

/**
 * Award practice XP for one of the Pop's own actions. Applies the
 * trait xpGainMult, rounds to an integer (minimum 1 when any XP was
 * requested), clamps at the Legendary cap and stamps lastPracticeTick.
 * Practicing reverses rust (DF): the accumulator zeroes on award and
 * the grace clock restarts from this tick. No-op for entities without
 * a Skills row.
 */
export function awardPractice(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  slug: string,
  amount: number,
): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `skill award must be a positive integer, got ${String(amount)}`,
    );
  }
  const row = skillsRowOf(world, comps, eid);
  if (!row) return;
  const mult = traitXpGainMult(traitSlugsOf(world, comps, eid));
  const gained = Math.max(1, Math.round(amount * mult));
  mutateEntry(world, comps, eid, slug, (_k, practiceXp, _r, base, live) => {
    const knowledgeXp = live[base + 1]!;
    const headroom = LEGENDARY_TOTAL_XP - (knowledgeXp + practiceXp);
    live[base + 2] = practiceXp + Math.min(gained, Math.max(0, headroom));
    live[base + 4] = world.tick;
    live[base + 3] = 0;
  });
}

/**
 * Grant knowledge XP (theory that never rusts). School systems and
 * tests call this; doing NEVER grants knowledge directly. Same clamp
 * and no-op contract as awardPractice; lastPracticeTick is untouched —
 * studying does not pause rust of already-idle practice.
 */
export function grantKnowledge(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  slug: string,
  amount: number,
): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `knowledge grant must be a positive integer, got ${String(amount)}`,
    );
  }
  const row = skillsRowOf(world, comps, eid);
  if (!row) return;
  mutateEntry(world, comps, eid, slug, (_k, practiceXp, _r, base, live) => {
    const knowledgeXp = live[base + 1]!;
    const room = LEGENDARY_TOTAL_XP - (knowledgeXp + practiceXp);
    live[base + 1] = knowledgeXp + Math.min(amount, Math.max(0, room));
  });
}

// ---- Derived read path ---------------------------------------------------------

/** Total effective XP of one skill (undefined before first touch/row). */
export function totalXpOf(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  slug: string,
): number | undefined {
  const row = skillsRowOf(world, comps, eid);
  if (!row) return undefined;
  const code = skillCodeOf(slug);
  for (let i = 0; i < row[0]!; i++) {
    const base = 1 + i * SKILL_ENTRY_ARITY;
    if (row[base] === code) return row[base + 1]! + row[base + 2]!;
    if (row[base]! > code) break;
  }
  return undefined;
}

/**
 * Derived skill level for `eid` (0 for untouched skills on row holders;
 * undefined when the entity has no Skills row at all).
 */
export function skillLevelOf(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  slug: string,
): number | undefined {
  if (!skillsRowOf(world, comps, eid)) return undefined;
  return levelOfTotalXp(totalXpOf(world, comps, eid, slug) ?? 0);
}

/**
 * Product of the Pop's workSpeedMult traits (1 without a Traits row).
 */
export function workTraitMultOf(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
): number {
  return traitWorkSpeedMult(traitSlugsOf(world, comps, eid));
}

/** Exact work multiplier implied by a level and trait product. */
export function workMultiplierFor(level: number, traitMult: number): number {
  return ((100 + WORK_RATE_PCT_PER_LEVEL * level) / 100) * traitMult;
}

/**
 * Effective gather ticks per resource unit for a worker of `level`:
 * base ticks divided by the work multiplier, integer-rounded, floored
 * at 1. Level 0 with neutral traits returns the base unchanged.
 */
export function gatherTicksPerUnitFor(
  baseTicks: number,
  level: number,
  traitMult: number,
): number {
  return Math.max(
    1,
    Math.round(baseTicks / workMultiplierFor(level, traitMult)),
  );
}

/**
 * Effective fixed-point build contribution (milli-ticks/tick) for a
 * builder of `level`: base scaled BY the multiplier, integer-rounded.
 */
export function builderMilliPerTickFor(
  baseMilli: number,
  level: number,
  traitMult: number,
): number {
  return Math.round(baseMilli * workMultiplierFor(level, traitMult));
}

/**
 * Effective gather ticks per resource unit for one worker entity:
 * derived on read from its gathering level + workSpeedMult traits.
 * Rowless entities return `baseTicks` unchanged (legacy byte-compat).
 *
 * M3-T3 NOTE: this per-read derivation is now only correct for
 * SHRINKING intervals (skill growth). Chain construction must use
 * {@link resolveGatherInterval} instead — see the gather system's
 * advanceGatherHead for why encoded==effective is an invariant.
 */
export function effectiveGatherTicksPerUnit(
  world: World,
  comps: SkillSystemComponents,
  eid: number,
  baseTicks: number,
): number {
  if (!skillsRowOf(world, comps, eid)) return baseTicks;
  const level = skillLevelOf(world, comps, eid, "gathering") ?? 0;
  if (level === 0) {
    const traitMult = workTraitMultOf(world, comps, eid);
    if (traitMult === 1) return baseTicks;
    return gatherTicksPerUnitFor(baseTicks, level, traitMult);
  }
  return gatherTicksPerUnitFor(
    baseTicks,
    level,
    workTraitMultOf(world, comps, eid),
  );
}

/**
 * The ONE gather-interval resolver (M3-T2 ×M3-T3 ×M3-T4 ×M3-T6): folds
 * the worker's gathering skill + work-speed traits AND the rest penalty
 * AND wound impairments AND sleep deprivation into a single integer
 * interval for a freshly constructed work chain. Purely a function of
 * digest-visible rows; rowless/fully-rested/healthy workers get exactly
 * `baseTicks`.
 */
export function resolveGatherInterval(
  world: World,
  comps: SimComponents & NeedsComponents,
  eid: number,
  baseTicks: number,
): number {
  const skillMult = workMultiplierFor(
    skillLevelOf(world, comps, eid, "gathering") ?? 0,
    workTraitMultOf(world, comps, eid),
  );
  const restMult = restWorkMultiplierOf(world, comps, eid);
  // M3-T4: arm/vital wounds slow the swing exactly like exhaustion.
  const injuryWorkMult = injuryImpairmentOf(world, comps, eid).workMult;
  // M3-T6: a bad night's sleep drags the whole next day (§2.4).
  const deprivedMult = deprivationWorkMultiplierOf(world, comps, eid);
  return Math.max(
    1,
    Math.round(
      baseTicks / (skillMult * restMult * injuryWorkMult * deprivedMult),
    ),
  );
}

/** Attack multiplier contributed by a combat skill level (exact float). */
export function attackMultiplierFor(level: number): number {
  return (100 + ATTACK_PCT_PER_LEVEL * level) / 100;
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the skills SimSystem: the rare-tick rust pass. Worlds without
 * it simply never rust (legacy fixture compatibility); production
 * registers it after combat.
 */
export function createSkillsSystem(comps: SkillSystemComponents): SimSystem {
  return (world: World): void => {
    const rows = world.rowsByComponentId.get(comps.skillsId);
    if (!rows || rows.size === 0) return;
    const tick = world.tick;
    for (const eid of world.entities) {
      if (!rareTickDue(tick, eid)) continue;
      const row = rows.get(eid);
      if (!row) continue;
      const count = row[0]!;
      for (let i = 0; i < count; i++) {
        const base = 1 + i * SKILL_ENTRY_ARITY;
        const practiceXp = row[base + 2]!;
        if (practiceXp <= 0) {
          if (row[base + 3] !== 0) row[base + 3] = 0;
          continue;
        }
        const idle = tick - row[base + 4]!;
        if (idle < RUST_GRACE_TICKS) {
          if (row[base + 3] !== 0) row[base + 3] = 0;
          continue;
        }
        const accumulated = row[base + 3]! + 1;
        if (accumulated >= RUST_ACCUMULATOR_CAP) {
          row[base + 3] = 0;
          row[base + 2] =
            practiceXp - Math.min(practiceXp, RUST_DRAIN_PRACTICE_XP);
        } else {
          row[base + 3] = accumulated;
        }
      }
    }
  };
}

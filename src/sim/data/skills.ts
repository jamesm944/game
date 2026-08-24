/**
 * Skill content registry & progression curve — SPEC §2.3 / M3-T2 (issue #47).
 *
 * The knowledge-vs-practice model steals CDDA's `SkillLevel` architecture
 * (knowledge never rusts; practice decays toward the knowledge floor via
 * a rust accumulator) driven by DF-wiki constants (MIT-licensable text):
 * advancing into level L costs `400 + 100·L` XP, so cumulative XP at
 * level L is `500·L + 50·L·(L−1)` — Novice at 500, the Adequate→
 * Competent step at 700, and level 15 ("Legendary") totals exactly
 * 18,000 XP. Provenance and the adopted rust constants live in
 * docs/research/pop-sim-sources.md.
 *
 * Skills are pure data here: stable u8 codes assigned by ascending slug
 * (same discipline as traits/definitions), the XP curve, and nothing
 * else. Per-Pop state lives in the Skills component row; decay cadence
 * constants live beside the rust pass in systems/skills.ts.
 */

/** Skill slugs ascending — the stable iteration/code order. */
export const SKILL_SLUGS = [
  "construction",
  "gathering",
  "melee",
  "ranged",
] as const;

export type SkillSlug = (typeof SKILL_SLUGS)[number];

/**
 * u8 skill codes by ascending slug (1-based) — the digest-visible
 * projection stored in Skill rows.
 */
export const SKILL_CODES: ReadonlyMap<SkillSlug, number> = new Map(
  SKILL_SLUGS.map((slug, index) => [slug, index + 1]),
);

function requireSkill(slug: string): asserts slug is SkillSlug {
  if (!SKILL_CODES.has(slug as SkillSlug)) {
    throw new Error(`unknown skill: ${JSON.stringify(slug)}`);
  }
}

/** Stable u8 code of one skill (ascending-slug assignment). */
export function skillCodeOf(slug: string): number {
  requireSkill(slug);
  return SKILL_CODES.get(slug)!;
}

/** Slug for one stable skill code; throws on out-of-range codes. */
export function skillIdOfCode(code: number): SkillSlug {
  for (const [slug, candidate] of SKILL_CODES) {
    if (candidate === code) return slug;
  }
  throw new Error(`unknown skill code: ${String(code)}`);
}

// ---- Progression curve (DF wiki, MIT-licensable) ------------------------------

/** Highest reachable level; DF's Legendary rank. */
export const MAX_SKILL_LEVEL = 15;
/**
 * Cumulative XP that buys level MAX_SKILL_LEVEL exactly — DF's
 * "Legendary totals 18,000". Total XP clamps here; surplus awards are
 * discarded (documented tuning constant).
 */
export const LEGENDARY_TOTAL_XP = 18_000;

/**
 * Cumulative XP needed to REACH `level` from zero:
 * `Σ_{k=1..level} (400 + 100k)` closed-formed as `500·L + 50·L·(L−1)`.
 * Level 0 returns 0; levels above MAX_SKILL_LEVEL throw.
 */
export function xpToReachLevel(level: number): number {
  if (!Number.isInteger(level) || level < 0 || level > MAX_SKILL_LEVEL) {
    throw new Error(`skill level out of range: ${String(level)}`);
  }
  return 500 * level + 50 * level * (level - 1);
}

/** Level implied by total XP: highest L whose threshold ≤ xp. */
export function levelOfTotalXp(totalXp: number): number {
  let level = 0;
  while (
    level < MAX_SKILL_LEVEL &&
    xpToReachLevel(level + 1) <= Math.min(totalXp, LEGENDARY_TOTAL_XP)
  ) {
    level += 1;
  }
  return level;
}

/**
 * XP still missing from `totalXp` to reach the next level (0 when
 * already Legendary). The marginal cost of advancing from level L−1 to
 * L is `400 + 100·L` — the SPEC §2.3 curve verbatim.
 */
export function xpForNextLevel(totalXp: number): number {
  const level = levelOfTotalXp(totalXp);
  if (level >= MAX_SKILL_LEVEL) return 0;
  return xpToReachLevel(level + 1) - Math.min(totalXp, LEGENDARY_TOTAL_XP);
}

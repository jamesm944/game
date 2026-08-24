/**
 * Pop skills component — SPEC §2.3 / M3-T2 (issue #47).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Skills slots between Rubble
 * and Stockpile.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Skills (variable), count-led:
 *
 *   [entryCount,
 *     code₀, knowledgeXp₀, practiceXp₀, rustAccumulator₀,
 *       lastPracticeTick₀,
 *     code₁, …]
 *
 * One 5-int entry per skill the Pop holds, ascending stable skill code
 * (data/skills.ts). All values are integers:
 * - knowledgeXp: cumulative theory XP — NEVER decays (CDDA SkillLevel
 *   steal); grows only through grantKnowledge (School work feeds it in
 *   a later M3 ticket).
 * - practiceXp: XP accumulated ABOVE the knowledge pool by doing
 *   (gather/build/attack awards). The rust pass drains this toward 0,
 *   so the Pop's effective level falls toward its knowledge floor but
 *   never below it.
 * - rustAccumulator: idle rare-ticks since the last drain/reset — the
 *   documented DF-style counter machine state.
 * - lastPracticeTick: world.tick of the most recent practice award;
 *   gates the grace window.
 *
 * Levels are DERIVED, never stored ("derived stats, never stored",
 * SPEC §2.5 discipline): level = levelOfTotalXp(knowledgeXp +
 * practiceXp) on every read, so "practice→level conversion at
 * thresholds" is a pure function with no threshold bookkeeping to
 * replay. Rows attach only where Identity attaches (spawnUnit identity
 * branch → training completions, AI bootstrap, skirmish starts);
 * rowless entities stay byte-compatible legacy Pops whose awards and
 * multipliers no-op to exactly pre-M3-T2 behavior.
 */

import { skillCodeOf, skillIdOfCode } from "../data/skills";
import type { ComponentRows, World } from "../core/world";

export const SKILLS = "Skills" as const;

/** Variable-length count-led row — arity is part of the digest contract. */
export const SKILLS_ARITY = -1;

/** Integers per skill entry inside the row. */
export const SKILL_ENTRY_ARITY = 5;

/** Component id the skills system reads/writes. */
export interface SkillComponents {
  readonly skillsId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/**
 * Attach an empty Skills row (a fresh novice) to one Pop. Call exactly
 * once per entity alongside attachPopIdentity; re-attaching wipes all
 * progression.
 */
export function attachPopSkills(
  world: World,
  comps: Pick<SkillComponents, "skillsId">,
  eid: number,
): void {
  requireRows(world, comps.skillsId).set(eid, [0]);
}

/** True when the entity carries a Skills row (awards may land). */
export function hasSkillsRow(
  world: World,
  comps: Pick<SkillComponents, "skillsId">,
  eid: number,
): boolean {
  return world.rowsByComponentId.get(comps.skillsId)?.has(eid) ?? false;
}

/** Live (mutable) Skills row for `eid`, or undefined before attachment. */
export function skillsRowOf(
  world: World,
  comps: Pick<SkillComponents, "skillsId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.skillsId)?.get(eid);
}

/** One decoded skill entry of a Skills row. */
export interface SkillEntry {
  readonly slug: string;
  /** Cumulative theory XP — never decays. */
  knowledgeXp: number;
  /** Practice XP above the knowledge pool — drained by rust. */
  practiceXp: number;
  /** Idle rare-tick counter since the last drain/reset. */
  rustAccumulator: number;
  /** world.tick of the most recent practice award. */
  lastPracticeTick: number;
}

/**
 * Locate one skill's live 5-int slice inside a row; returns the index
 * of its code column or −1. Entries sit ascending by code after the
 * leading count.
 */
export function skillEntryIndexInRow(
  row: readonly number[],
  slug: string,
): number {
  const code = skillCodeOf(slug);
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    const base = 1 + i * SKILL_ENTRY_ARITY;
    if (row[base] === code) return base;
    if (row[base]! > code) break; // ascending order ⇒ not present
  }
  return -1;
}

/**
 * Insert a zeroed entry for `slug` into the live row, keeping ascending
 * code order. Returns the entry's base index. Caller must already hold
 * the row (attachment is the only way rows are born).
 */
export function insertSkillEntryInRow(row: number[], slug: string): number {
  const code = skillCodeOf(slug);
  const count = row[0]!;
  let insertAt = -1;
  for (let i = 0; i < count; i++) {
    const base = 1 + i * SKILL_ENTRY_ARITY;
    if (row[base] === code) return base; // already present
    if (row[base]! > code) {
      insertAt = base;
      break;
    }
  }
  if (insertAt === -1) insertAt = 1 + count * SKILL_ENTRY_ARITY;
  row.splice(insertAt, 0, code, 0, 0, 0, 0);
  row[0] = count + 1;
  return insertAt;
}

/** Decoded copy of one Pop's skill entries, ascending slug order. */
export function readSkillEntries(
  world: World,
  comps: Pick<SkillComponents, "skillsId">,
  eid: number,
): SkillEntry[] | undefined {
  const row = skillsRowOf(world, comps, eid);
  if (!row) return undefined;
  const entries: SkillEntry[] = [];
  for (let i = 0; i < row[0]!; i++) {
    const base = 1 + i * SKILL_ENTRY_ARITY;
    entries.push({
      slug: skillIdOfCode(row[base]!),
      knowledgeXp: row[base + 1]!,
      practiceXp: row[base + 2]!,
      rustAccumulator: row[base + 3]!,
      lastPracticeTick: row[base + 4]!,
    });
  }
  return entries;
}

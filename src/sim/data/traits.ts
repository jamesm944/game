/**
 * Trait content registry — SPEC §2.3 / M3-T1 (issue #46).
 *
 * Traits are pure data (src/sim/data/traits.json), validated ONCE at
 * module load with ONE aggregated error listing every problem — the
 * load.ts discipline applied to a single content file. The design
 * copies the RimWorld pattern documented in
 * docs/research/pop-sim-sources.md: a commonality-weighted pool with
 * pairwise conflict exclusion (kind/cruel, gregarious/solitary, and
 * the ascetic↔greedy↔jealous triangle from the wiki research).
 *
 * Stable numeric trait codes: digest-visible Trait rows carry u8 codes,
 * not slugs. Codes are assigned once per process by ascending slug
 * order over the loaded set — a pure function of the file content,
 * deterministic across runs and platforms (same discipline as
 * data/definitions.ts def codes).
 *
 * `rollTraitSlugs` is the seeded generator shared by every Pop spawn:
 * 1–3 traits per Pop (uniform count), each pick commonality-weighted
 * over the eligible pool (never chosen, not conflicting with anything
 * chosen), terminating early when the pool empties. Output is sorted
 * ascending by slug so the component row order is canonical.
 */

import { z } from "zod";
import type { Prng } from "../core/prng";
import rawTraitsJson from "./traits.json";

const TRAIT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

/** One trait definition as authored in traits.json. */
export interface TraitDefinition {
  readonly id: string;
  /** Relative pick weight; any positive number (normalized at roll time). */
  readonly commonality: number;
  /**
   * Multiplicative work-speed modifier (M3-T2): folded into the derived
   * work multiplier read path (gather rate / build speed). Absent = 1.
   */
  readonly workSpeedMult?: number | undefined;
  /**
   * Multiplicative practice-XP modifier (M3-T2): scales skill XP
   * awards on the Pop's own actions. Absent = 1.
   */
  readonly xpGainMult?: number | undefined;
}

const traitDefSchema = z.object({
  id: z.string().regex(TRAIT_SLUG_PATTERN),
  commonality: z.number().positive(),
  workSpeedMult: z.number().positive().optional(),
  xpGainMult: z.number().positive().optional(),
});

export const traitsFileSchema = z.object({
  traits: z.array(traitDefSchema).min(1),
  conflictPairs: z.array(z.tuple([z.string(), z.string()])),
});

interface TraitContent {
  readonly defs: ReadonlyMap<string, TraitDefinition>;
  readonly conflicts: ReadonlyMap<string, readonly string[]>;
}

function loadTraitContent(raw: unknown): TraitContent {
  const parsed = traitsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const at = issue.path.map(String).join(".");
        return at.length > 0 ? `${at}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new Error(`trait content validation failed: ${details}`);
  }
  const errors: string[] = [];
  const defs = new Map<string, TraitDefinition>();
  for (const trait of parsed.data.traits) {
    if (defs.has(trait.id)) {
      errors.push(`duplicate trait id ${JSON.stringify(trait.id)}`);
      continue;
    }
    defs.set(trait.id, trait);
  }
  const undirected = new Map<string, Set<string>>();
  for (const [a, b] of parsed.data.conflictPairs) {
    if (!defs.has(a))
      errors.push(
        `conflict pair references unknown trait ${JSON.stringify(a)}`,
      );
    if (!defs.has(b))
      errors.push(
        `conflict pair references unknown trait ${JSON.stringify(b)}`,
      );
    if (a === b) {
      errors.push(`conflict pair is self-referential: ${JSON.stringify(a)}`);
      continue;
    }
    if (!undirected.has(a)) undirected.set(a, new Set());
    if (!undirected.has(b)) undirected.set(b, new Set());
    undirected.get(a)!.add(b);
    undirected.get(b)!.add(a);
  }
  if (errors.length > 0) {
    throw new Error(
      `trait content validation failed (${String(errors.length)}):\n  - ${errors.join("\n  - ")}`,
    );
  }
  return { defs, conflicts: normalizeConflicts(undirected) };
}

function normalizeConflicts(
  undirected: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [slug, set] of undirected) {
    out.set(slug, [...set].sort());
  }
  return out;
}

const CONTENT: TraitContent = loadTraitContent(rawTraitsJson);

/** Loaded trait definitions keyed by slug. */
export const TRAIT_DEFINITIONS: ReadonlyMap<string, TraitDefinition> =
  CONTENT.defs;

/** Every trait slug, ascending — the stable iteration order for rolls. */
export const TRAIT_SLUGS: readonly string[] = [...CONTENT.defs.keys()].sort();

/**
 * u8 trait codes by ascending slug (1-based) — the digest-visible
 * projection stored in Trait rows.
 */
export const TRAIT_CODES: ReadonlyMap<string, number> = new Map(
  TRAIT_SLUGS.map((slug, index) => [slug, index + 1]),
);

function requireTrait(slug: string): TraitDefinition {
  const def = CONTENT.defs.get(slug);
  if (!def) throw new Error(`unknown trait: ${JSON.stringify(slug)}`);
  return def;
}

/** Stable u8 code of one trait (ascending-slug assignment). */
export function traitCodeOf(slug: string): number {
  const code = TRAIT_CODES.get(slug);
  if (code === undefined)
    throw new Error(`unknown trait: ${JSON.stringify(slug)}`);
  return code;
}

/** Slug for one stable trait code; throws on out-of-range codes. */
export function traitIdOfCode(code: number): string {
  for (const [slug, candidate] of TRAIT_CODES) {
    if (candidate === code) return slug;
  }
  throw new Error(`unknown trait code: ${String(code)}`);
}

/** Conflicts of one trait, ascending; empty for conflict-free traits. */
export function conflictsOf(slug: string): readonly string[] {
  requireTrait(slug);
  return CONTENT.conflicts.get(slug) ?? [];
}

/** True when two traits may never co-occur on one Pop. */
export function traitsConflict(a: string, b: string): boolean {
  requireTrait(a);
  requireTrait(b);
  return (CONTENT.conflicts.get(a) ?? []).includes(b);
}

// ---- Skill-system modifiers (M3-T2) ---------------------------------------------

/**
 * Product of every listed trait's workSpeedMult (1 when none declare
 * one). Unknown slugs throw — callers pass readTraits output.
 */
export function traitWorkSpeedMult(slugs: readonly string[]): number {
  let mult = 1;
  for (const slug of slugs) {
    const def = requireTrait(slug);
    if (def.workSpeedMult !== undefined) mult *= def.workSpeedMult;
  }
  return mult;
}

/**
 * Product of every listed trait's xpGainMult (1 when none declare one).
 * Unknown slugs throw — callers pass readTraits output.
 */
export function traitXpGainMult(slugs: readonly string[]): number {
  let mult = 1;
  for (const slug of slugs) {
    const def = requireTrait(slug);
    if (def.xpGainMult !== undefined) mult *= def.xpGainMult;
  }
  return mult;
}

// ---- Weighted generation ------------------------------------------------------

/** RimWorld adult cap: Pops acquire between one and three traits. */
export const POP_TRAIT_COUNT_MIN = 1;
export const POP_TRAIT_COUNT_MAX = 3;

/**
 * Roll one Pop's trait set from `random` (a Prng or any nextFloat
 * source): uniform count in [1, 3], then that many commonality-weighted
 * picks excluding already-chosen slugs and every conflict of theirs,
 * stopping early if the eligible pool empties. Returns slugs ascending.
 */
export function rollTraitSlugs(random: Pick<Prng, "nextFloat">): string[] {
  const span = POP_TRAIT_COUNT_MAX - POP_TRAIT_COUNT_MIN + 1;
  const target =
    POP_TRAIT_COUNT_MIN + Math.floor(random.nextFloat() * Number(span));
  const chosen: string[] = [];
  const excluded = new Set<string>();
  for (let slot = 0; slot < target; slot++) {
    let totalWeight = 0;
    for (const slug of TRAIT_SLUGS) {
      if (!excluded.has(slug)) totalWeight += requireCommonality(slug);
    }
    if (totalWeight <= 0) break;
    let roll = random.nextFloat() * totalWeight;
    let picked: string | undefined;
    for (const slug of TRAIT_SLUGS) {
      if (excluded.has(slug)) continue;
      roll -= requireCommonality(slug);
      if (roll < 0) {
        picked = slug;
        break;
      }
    }
    if (picked === undefined) break; // float edge: never expected
    chosen.push(picked);
    excluded.add(picked);
    for (const conflict of conflictsOf(picked)) excluded.add(conflict);
  }
  return chosen.sort();
}

function requireCommonality(slug: string): number {
  return requireTrait(slug).commonality;
}

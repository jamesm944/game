/**
 * Pop identity & traits components — SPEC §2.3 / M3-T1 (issue #46).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - Identity (4): [nameIdx, birthTick, familyId, origin] — one row per
 *   named Pop. nameIdx indexes the seed-derived given-name list built by
 *   {@link nameListFor} (syllable-combined, unique within the list);
 *   allocation probes from a (seed, eid)-derived start and never reuses
 *   an index inside one world, so no two living-or-dead Pops of a world
 *   share a name and replayed spawns land on identical assignments.
 *   birthTick is world.tick at attach time; familyId stays
 *   FAMILY_UNASSIGNED until households.ts (M3-T5) assigns it. origin
 *   separates natural-born children (POP_ORIGIN_BIRTH — lifecycle age
 *   runs from birthTick through child→adult→elder) from working-age
 *   arrivals (POP_ORIGIN_ARRIVAL — trained villagers, starting settlers:
 *   they enter as adults, with their elder clock measured from arrival;
 *   M3-T5).
 * - Traits (variable): ascending stable u8 trait codes (ascending slug
 *   order over data/traits.ts) — the digest-visible projection of the
 *   sorted slug array returned by rollTraitSlugs.
 *
 * Generation follows the RimWorld pattern from
 * docs/research/pop-sim-sources.md: commonality-weighted picks with
 * pairwise conflict exclusion, 1–3 traits per Pop, drawn from a
 * dedicated sfc32 sub-stream derived from (seed, eid) — NEVER the
 * shared world.prng stream, so attaching identity cannot perturb the
 * movement/economy/combat replay streams that existing fixtures pin.
 */

import { rollTraitSlugs, traitCodeOf, traitIdOfCode } from "../data/traits";
import { createPrng } from "../core/prng";
import type { ComponentRows, World } from "../core/world";

export const IDENTITY = "Identity" as const;
export const TRAITS = "Traits" as const;

/** Row arity per pop component — pinned for digest stability. */
export const IDENTITY_ARITY = 4;
export const TRAITS_ARITY = -1; // variable-length sorted trait codes

/** familyId sentinel: household assignment is M3-lifecycle work. */
export const FAMILY_UNASSIGNED = -1;

/**
 * Lifecycle origins (M3-T5). ARRIVAL Pops (trained villagers, starting
 * settlers, AI bootstrap spawns) enter as working adults — their
 * effective age starts at the adult threshold so the elder clock runs
 * from arrival. BIRTH Pops are natural-born children: age runs from
 * birthTick through the full child→adult→elder arc.
 */
export const POP_ORIGIN_ARRIVAL = 0;
export const POP_ORIGIN_BIRTH = 1;

/** Component ids the pop systems read/write. */
export interface PopComponents {
  readonly identityId: number;
  readonly traitsId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Deterministic given-name lists -------------------------------------------

/**
 * Syllable tables for the given-name generator. Onsets open a name,
 * codas close it, and middles optionally extend it to three syllables:
 * onset+coda ("Alric") or onset+middle+coda ("Caleth"). The combined
 * space (14×18 two-syllable + 14×10×18 three-syllable = 2772 forms)
 * comfortably exceeds NAME_LIST_SIZE, so the dedupe loop below always
 * terminates well before its attempt budget.
 */
const NAME_ONSETS: readonly string[] = [
  "Al",
  "Ber",
  "Cad",
  "Dor",
  "El",
  "Fen",
  "Gar",
  "Hal",
  "Is",
  "Jor",
  "Kel",
  "Lun",
  "Mar",
  "Nor",
];
const NAME_MIDDLES: readonly string[] = [
  "a",
  "e",
  "i",
  "o",
  "u",
  "an",
  "ar",
  "el",
  "ir",
  "ol",
];
const NAME_CODAS: readonly string[] = [
  "ric",
  "mund",
  "win",
  "bald",
  "gard",
  "hild",
  "leif",
  "mir",
  "wyn",
  "dred",
  "wick",
  "holm",
  "vor",
  "yth",
  "ek",
  "us",
  "und",
  "ia",
];

/** Names available per world — ≥4× the §2.3 500-Pop envelope. */
export const NAME_LIST_SIZE = 2048;

/** Domain constant separating the name stream from other seed uses. */
const NAME_STREAM_DOMAIN = 0x6e616d65; // "name"

const ATTEMPT_BUDGET_FACTOR = 64;

const nameListsBySeed = new Map<number, readonly string[]>();

function composeName(
  onset: number,
  middle: number | undefined,
  coda: number,
): string {
  const parts = [NAME_ONSETS[onset]!];
  if (middle !== undefined) parts.push(NAME_MIDDLES[middle]!);
  parts.push(NAME_CODAS[coda]!);
  return parts.join("");
}

/**
 * The deterministic given-name list for one world seed — syllable
 * combinations drawn from a dedicated splitmix32→sfc32 sub-stream,
 * deduped so every index names a DIFFERENT person. Pure function of the
 * seed (memoized per process).
 */
export function nameListFor(seed: number): readonly string[] {
  const cached = nameListsBySeed.get(seed);
  if (cached) return cached;
  const prng = createPrng((seed ^ NAME_STREAM_DOMAIN) >>> 0);
  const seen = new Set<string>();
  const list: string[] = [];
  const budget = NAME_LIST_SIZE * ATTEMPT_BUDGET_FACTOR;
  for (
    let attempt = 0;
    attempt < budget && list.length < NAME_LIST_SIZE;
    attempt++
  ) {
    const threeSyllable = (prng.nextU32() & 1) === 1;
    const name = composeName(
      prng.nextU32() % NAME_ONSETS.length,
      threeSyllable ? prng.nextU32() % NAME_MIDDLES.length : undefined,
      prng.nextU32() % NAME_CODAS.length,
    );
    if (!seen.has(name)) {
      seen.add(name);
      list.push(name);
    }
  }
  if (list.length < NAME_LIST_SIZE) {
    throw new Error(
      `given-name syllable space exhausted at ${String(list.length)}/${String(NAME_LIST_SIZE)} for seed ${String(seed)}`,
    );
  }
  nameListsBySeed.set(seed, list);
  return list;
}

/** Given name behind one Identity row's nameIdx. */
export function givenNameOf(world: World, nameIdx: number): string {
  const list = nameListFor(world.seed);
  const name = list[nameIdx];
  if (name === undefined) {
    throw new Error(
      `nameIdx ${String(nameIdx)} out of range for seed ${String(world.seed)}`,
    );
  }
  return name;
}

/**
 * Per-world used-name-index set: once assigned to a Pop an index is
 * never reassigned, even after despawn (dead names stay retired).
 * Spawn order is deterministic under replay, so assignments are too.
 */
const usedNameIndexesByWorld = new WeakMap<World, Set<number>>();

/** Splitmix-style scramble of (seed, eid) into a u32 stream seed. */
export function popStreamSeed(seed: number, eid: number): number {
  let z = (seed ^ Math.imul(eid, 0x9e3779b9)) >>> 0 || 1;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

function allocateNameIndex(world: World, eid: number): number {
  let used = usedNameIndexesByWorld.get(world);
  if (!used) {
    used = new Set();
    usedNameIndexesByWorld.set(world, used);
  }
  const list = nameListFor(world.seed);
  const start =
    popStreamSeed(world.seed, eid ^ NAME_STREAM_DOMAIN) % list.length;
  for (let probe = 0; probe < list.length; probe++) {
    const idx = (start + probe) % list.length;
    if (!used.has(idx)) {
      used.add(idx);
      return idx;
    }
  }
  throw new Error(
    `given-name list exhausted for world seed ${String(world.seed)}`,
  );
}

// ---- Trait rolls ---------------------------------------------------------------

/** Domain constant separating trait streams from other per-pop streams. */
const TRAIT_STREAM_DOMAIN = 0x74726169; // "trai"

/**
 * One Pop's traits as a pure function of (seed, eid): the exact stream
 * derivation attachPopIdentity performs, exposed for property tests.
 * Returns slugs ascending — 1–3 conflict-free weighted picks.
 */
export function generatePopTraits(seed: number, eid: number): string[] {
  const prng = createPrng(
    (popStreamSeed(seed, eid) ^ TRAIT_STREAM_DOMAIN) >>> 0,
  );
  return rollTraitSlugs(prng);
}

// ---- Component rows --------------------------------------------------------------

/**
 * Attach Identity + Traits rows to one spawned Pop: next unused name
 * index, birthTick = current tick, family unassigned, the seeded trait
 * roll, and the lifecycle origin (default ARRIVAL — trained villagers
 * and starting settlers are working adults; households.ts passes
 * POP_ORIGIN_BIRTH for newborns). Call exactly once per entity
 * (re-attaching re-rolls nothing but DOES burn another name index).
 */
export function attachPopIdentity(
  world: World,
  comps: PopComponents,
  eid: number,
  options: { readonly origin?: number | undefined } = {},
): void {
  const nameIdx = allocateNameIndex(world, eid);
  const origin =
    options.origin === POP_ORIGIN_BIRTH ? POP_ORIGIN_BIRTH : POP_ORIGIN_ARRIVAL;
  requireRows(world, comps.identityId).set(eid, [
    nameIdx,
    world.tick,
    FAMILY_UNASSIGNED,
    origin,
  ]);
  const traitCodes = generatePopTraits(world.seed, eid).map(traitCodeOf);
  requireRows(world, comps.traitsId).set(eid, traitCodes);
}

/** Decoded Identity fields for one Pop, or undefined before attachment. */
export interface IdentityFields {
  readonly nameIdx: number;
  readonly birthTick: number;
  readonly familyId: number;
  /** POP_ORIGIN_* — how this Pop entered the world (M3-T5). */
  readonly origin: number;
}

export function readIdentity(
  world: World,
  comps: Pick<PopComponents, "identityId">,
  eid: number,
): IdentityFields | undefined {
  const row = world.rowsByComponentId.get(comps.identityId)?.get(eid);
  if (!row) return undefined;
  return {
    nameIdx: row[0]!,
    birthTick: row[1]!,
    familyId: row[2]!,
    origin: row[3] ?? POP_ORIGIN_ARRIVAL,
  };
}

/**
 * Assign one Pop to a household (M3-T5): `familyEid` is the Household
 * row's entity id, or FAMILY_UNASSIGNED to detach (never expected in
 * production). No-op for Pops without an Identity row.
 */
export function setIdentityFamilyId(
  world: World,
  comps: Pick<PopComponents, "identityId">,
  eid: number,
  familyEid: number,
): void {
  const row = world.rowsByComponentId.get(comps.identityId)?.get(eid);
  if (!row) return;
  row[2] = familyEid;
}

/** Full name resolution for one Pop's Identity row (fresh string). */
export function popNameOf(
  world: World,
  comps: Pick<PopComponents, "identityId">,
  eid: number,
): string | undefined {
  const identity = readIdentity(world, comps, eid);
  return identity === undefined
    ? undefined
    : givenNameOf(world, identity.nameIdx);
}

/** One Pop's trait slugs ascending, or undefined before attachment. */
export function readTraits(
  world: World,
  comps: Pick<PopComponents, "traitsId">,
  eid: number,
): string[] | undefined {
  const row = world.rowsByComponentId.get(comps.traitsId)?.get(eid);
  if (!row) return undefined;
  return row.map((code) => traitIdOfCode(code));
}

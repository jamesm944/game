/**
 * Pairwise Relationship component — SPEC §2.4 social bonds / M3-T7
 * (issue #52).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/pop sets; registration is one strictly alphabetical sequence
 * (components/index.ts defineSimComponents), pinning digest/save
 * iteration order forever (world.ts). Relationship slots between
 * ResearchedTechs and ResourceNode ("Relationship" < "ResourceNode").
 *
 * One row per PAIR on its own dedicated entity (the Household pattern):
 * Relationship (3): [popAeid, popBeid, value] with popA < popB and an
 * i32 `value` capped at ±BOND_CAP. Dedicated entities survive either
 * party's death — dead Pops' rows are despawned with them, but the pair
 * row persists so grief/vendetta state outlives a casualty; stale pairs
 * are validated lazily by readers exactly like Household head/partner
 * refs (systems/social.ts). Pair entities spawn lazily on first
 * interaction, ascending eids, deterministic under replay.
 *
 * All mutation flows through adjustRelationship/setRelationship so the
 * per-world pair index (WeakMap-cached) stays exact; values clamp into
 * [-BOND_CAP, BOND_CAP]. Rivals are DERIVED (never stored): a pair is
 * rivals when its value ≤ RIVAL_THRESHOLD.
 */

import type { ComponentRows, World } from "../core/world";

export const RELATIONSHIP = "Relationship" as const;

/** Row arity per relationship component — pinned for digest stability. */
export const RELATIONSHIP_ARITY = 3;

/** |value| ceiling for every bond. */
export const BOND_CAP = 100;
/** Pairs at or below this value count as rivals (derived, never stored). */
export const RIVAL_THRESHOLD = -50;

/**
 * Strong-bond morale buffer: a shock on a Pop whose strongest positive
 * bond is `strongest` lands as shock × (1 − fraction), fraction rising
 * linearly to BOND_BUFFER_MAX at a perfect bond (SPEC §2.4 "strong
 * bonds buffer morale shocks").
 */
export const BOND_BUFFER_MAX = 0.6;

/** Component ids the social system reads/writes. */
export interface RelationshipComponents {
  readonly relationshipId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** Canonical pair key: ascending-eid join. Pure. */
export function pairKeyOf(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Per-world pairKey → pair-entity index (lazily built, then exact). */
const pairIndexByWorld = new WeakMap<World, Map<string, number>>();

function pairIndex(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
): Map<string, number> {
  let index = pairIndexByWorld.get(world);
  if (index === undefined) {
    index = new Map<string, number>();
    for (const [eid, row] of requireRows(world, comps.relationshipId)) {
      index.set(pairKeyOf(row[0]!, row[1]!), eid);
    }
    pairIndexByWorld.set(world, index);
  }
  return index;
}

function clampBond(value: number): number {
  return Math.max(-BOND_CAP, Math.min(BOND_CAP, value));
}

/**
 * Fetch (or lazily create) the canonical Relationship row for one pair.
 * Creating spawns a dedicated pair entity — call only where a row is
 * wanted (visits, penalties), never on hot read paths.
 */
export function ensureRelationship(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  a: number,
  b: number,
): number[] {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    throw new Error(
      `ensureRelationship needs positive eids, got ${String(a)}, ${String(b)}`,
    );
  }
  if (a === b)
    throw new Error(`self-relationship makes no sense: ${String(a)}`);
  const key = pairKeyOf(a, b);
  const index = pairIndex(world, comps);
  const existing = index.get(key);
  if (existing !== undefined) {
    const row = requireRows(world, comps.relationshipId).get(existing);
    if (row) return row;
    // Pair entity was despawned externally (never in production);
    // rebuild below.
    index.delete(key);
  }
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const eid = world.lastAllocatedEid + 1;
  world.lastAllocatedEid = eid;
  world.entities.push(eid);
  const row = [lo, hi, 0];
  requireRows(world, comps.relationshipId).set(eid, row);
  index.set(key, eid);
  return row;
}

/** Raw bond value for one pair, or undefined when they never interacted. */
export function relationshipValueOf(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  a: number,
  b: number,
): number | undefined {
  const key = pairKeyOf(a, b);
  const eid = pairIndex(world, comps).get(key);
  if (eid === undefined) return undefined;
  const row = requireRows(world, comps.relationshipId).get(eid);
  if (!row) return undefined;
  return row[2]!;
}

/**
 * Apply one signed delta to a pair's bond (creating the row when the
 * pair first interacts), clamped to ±BOND_CAP. Returns the new value.
 */
export function adjustRelationship(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  a: number,
  b: number,
  delta: number,
): number {
  const row = ensureRelationship(world, comps, a, b);
  row[2] = clampBond(row[2]! + delta);
  return row[2]!;
}

/** Overwrite a pair's bond outright (validated, clamped). */
export function setRelationship(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  a: number,
  b: number,
  value: number,
): void {
  if (!Number.isInteger(value)) {
    throw new Error(`bond value must be an integer, got ${String(value)}`);
  }
  ensureRelationship(world, comps, a, b)[2] = clampBond(value);
}

/** True when the pair exists AND sits at/below the rival threshold. */
export function isRivalPair(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  a: number,
  b: number,
): boolean {
  const value = relationshipValueOf(world, comps, a, b);
  return value !== undefined && value <= RIVAL_THRESHOLD;
}

/** Every pair-entity id holding a Relationship row, ascending. */
export function relationshipPairEids(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
): number[] {
  return [...requireRows(world, comps.relationshipId).keys()].sort(
    (a, b) => a - b,
  );
}

/** Live Relationship row for one pair entity, or undefined. */
export function relationshipRowOf(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  pairEid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.relationshipId)?.get(pairEid);
}

/**
 * Strongest positive bond `eid` holds right now (0 when it has only
 * neutral/negative/no bonds). Reads scan live pair rows — visit-scale
 * data, not a hot path until T9 wires combat griefing.
 */
export function strongestBondOf(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  eid: number,
): number {
  let strongest = 0;
  for (const row of requireRows(world, comps.relationshipId).values()) {
    if (row[0] !== eid && row[1] !== eid) continue;
    if (row[2]! > strongest) strongest = row[2]!;
  }
  return strongest;
}

/** Morale-shock buffer fraction for one Pop ∈ [0, BOND_BUFFER_MAX]. */
export function bondBufferFractionOf(
  world: World,
  comps: Pick<RelationshipComponents, "relationshipId">,
  eid: number,
): number {
  return (strongestBondOf(world, comps, eid) / BOND_CAP) * BOND_BUFFER_MAX;
}

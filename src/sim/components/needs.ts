/**
 * Pop needs component — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Needs slots between
 * MoveTarget and Owner.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Needs (3): [food, rest, morale].
 *
 * Three integer meters on the SAME 0–NEED_MAX scale, spawned full and
 * decayed ONLY on the entity's staggered rare tick — SPEC §2.3's
 * RimWorld tickerType pattern, hash-offset per entity exactly like the
 * skills rust pass (`(tick + eid) % NEEDS_TICK_INTERVAL === 0`, needs
 * systems/needs.ts owns the arithmetic). Meters are plain digest-
 * visible integers: starvation and morale-zero states are observable
 * in every golden digest by construction (acceptance criterion, #48).
 *
 * Interim v1 semantics (full moodlets/leisure venues arrive §2.4/T6):
 * - food/rest decay one point per rare tick (~one day from full to
 *   empty at 30 Hz × 250);
 * - morale drifts down slowly and CRASHES under deprivation — starving
 *   (food 0) bleeds extra morale every rare tick, exhaustion (rest 0)
 *   a smaller bite — while eating restores a large chunk, so fed
 *   villages hold steady and hungry ones visibly sour;
 * - a drained rest meter slows work through restWorkMultiplierOf
 *   (systems/needs.ts); full sleep arrives with the T6 night band.
 *
 * Rows attach wherever Identity attaches (the spawnUnit identity
 * branch): every named Pop carries needs; legacy rowless entities stay
 * byte-compatible and every multiplier no-ops to pre-M3 behavior.
 */

import type { ComponentRows, World } from "../core/world";

export const NEEDS = "Needs" as const;

/** Row arity per needs component — pinned for digest stability. */
export const NEEDS_ARITY = 3;

/**
 * Rare-tick cadence: SPEC §2.3's ~250-tick hash-staggered tier — the
 * same interval the skills rust pass uses, offset per entity so needs
 * work amortizes instead of spiking.
 */
export const NEEDS_TICK_INTERVAL = 250;

/** Shared meter ceiling and the value every newborn Pop starts at. */
export const NEED_MAX = 100;
export const NEED_INITIAL = 100;

/** True on this entity's staggered rare needs tick (pure function). */
export function needsRareTickDue(tick: number, eid: number): boolean {
  return (tick + eid) % NEEDS_TICK_INTERVAL === 0;
}

/** Component ids the needs systems read/write. */
export interface NeedsComponents {
  readonly needsId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

function requireLevel(level: number, label: string): number {
  if (!Number.isInteger(level) || level < 0 || level > NEED_MAX) {
    throw new Error(
      `${label} meter must be an integer in [0, ${String(NEED_MAX)}], got ${String(level)}`,
    );
  }
  return level;
}

/**
 * Attach a full Needs row to one Pop. Call exactly once per entity
 * alongside attachPopIdentity; re-attaching resets all three meters.
 */
export function attachPopNeeds(
  world: World,
  comps: Pick<NeedsComponents, "needsId">,
  eid: number,
): void {
  requireRows(world, comps.needsId).set(eid, [
    NEED_INITIAL,
    NEED_INITIAL,
    NEED_INITIAL,
  ]);
}

/** Live (mutable) Needs row for `eid`, or undefined before attachment. */
export function needsRowOf(
  world: World,
  comps: Pick<NeedsComponents, "needsId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.needsId)?.get(eid);
}

/** Decoded {food, rest, morale} for one Pop, or undefined rowless. */
export interface NeedLevels {
  readonly food: number;
  readonly rest: number;
  readonly morale: number;
}

export function readNeeds(
  world: World,
  comps: Pick<NeedsComponents, "needsId">,
  eid: number,
): NeedLevels | undefined {
  const row = needsRowOf(world, comps, eid);
  if (!row) return undefined;
  return { food: row[0]!, rest: row[1]!, morale: row[2]! };
}

/**
 * Overwrite one Pop's three meters (validated). Tests and scenario
 * setups use this to stage hunger/exhaustion; systems mutate the live
 * row in place instead.
 */
export function setNeedLevels(
  world: World,
  comps: Pick<NeedsComponents, "needsId">,
  eid: number,
  levels: NeedLevels,
): void {
  requireRows(world, comps.needsId).set(eid, [
    requireLevel(levels.food, "food"),
    requireLevel(levels.rest, "rest"),
    requireLevel(levels.morale, "morale"),
  ]);
}

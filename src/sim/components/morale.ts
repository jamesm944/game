/**
 * Morale component — SPEC §2.5 routing / M3-T9 (issue #54).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/pop sets; registration is one strictly alphabetical sequence
 * (components/index.ts defineSimComponents), pinning digest/save
 * iteration order forever (world.ts). Morale slots between MealConsumed
 * and MoveTarget.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Morale (3): [routing, threatEid, routedSinceTick].
 *
 * - routing: 0 = steady, 1 = ROUTED — the Pop has broken (SPEC §2.5
 *   "individual break points; AoE2-style routing") and flees its threat,
 *   ignoring player/AI orders until rallied by nearby high-morale allies
 *   or safe (threat dead or far away).
 * - threatEid: the entity this router flees from (0 = none). Dead or
 *   missing threats end the episode through the "safe" exit.
 * - routedSinceTick: world.tick when the current (or last) episode
 *   began — telemetry only, never read for behavior.
 *
 * The morale METER itself lives on the Needs row (components/needs.ts,
 * M3-T3) — this component holds only the routing state the meter cannot.
 * The break THRESHOLD is derived on read in systems/morale.ts ("derived
 * stats, never stored", SPEC §2.5): traits + melee skill + open wounds.
 *
 * Rows are opt-in like Body (M3-T4): fixtures pinning pre-M3-T9 digests
 * keep spawning morale-less Pops byte-identically, because an empty
 * registered component contributes no digest lines.
 */

import type { ComponentRows, World } from "../core/world";

export const MORALE = "Morale" as const;

/** Row arity per morale component — pinned for digest stability. */
export const MORALE_ARITY = 3;

/** Component ids the morale system reads/writes. */
export interface MoraleComponents {
  readonly moraleId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/**
 * Attach a steady (unrouted) Morale row to one Pop. Call exactly once
 * per entity at spawn; re-attaching resets any live routing episode.
 */
export function attachPopMorale(
  world: World,
  comps: Pick<MoraleComponents, "moraleId">,
  eid: number,
): void {
  requireRows(world, comps.moraleId).set(eid, [0, 0, 0]);
}

/** Live (mutable) Morale row for `eid`, or undefined when rowless. */
export function moraleRowOf(
  world: World,
  comps: Pick<MoraleComponents, "moraleId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.moraleId)?.get(eid);
}

/** True while `eid` is routed and fleeing its threat. */
export function isRoutingOf(
  world: World,
  comps: Pick<MoraleComponents, "moraleId">,
  eid: number,
): boolean {
  return (
    (world.rowsByComponentId.get(comps.moraleId)?.get(eid)?.[0] ?? 0) === 1
  );
}

/** The entity `eid` currently flees from (0 when none/steady). */
export function routingThreatOf(
  world: World,
  comps: Pick<MoraleComponents, "moraleId">,
  eid: number,
): number {
  return world.rowsByComponentId.get(comps.moraleId)?.get(eid)?.[1] ?? 0;
}

/** Stamp a routing episode onto a live row (systems/morale.ts owns when). */
export function enterRouting(
  row: number[],
  threatEid: number,
  tick: number,
): void {
  if (!Number.isInteger(threatEid) || threatEid < 0) {
    throw new Error(
      `routing threat must be a non-negative eid: ${String(threatEid)}`,
    );
  }
  row[0] = 1;
  row[1] = threatEid;
  row[2] = tick;
}

/** Clear a routing episode (rallied or safe — the caller records which). */
export function exitRouting(row: number[]): void {
  row[0] = 0;
  row[1] = 0;
}

/**
 * Faith & conversion component — V14 / Issue #101.
 *
 * Monks carry a Faith row: [faith, targetEid, castProgressTicks]
 * - faith: float/int 0..maxFaith (default 100). Depletes to 0 on successful conversion,
 *   regenerates +faithRegenPerTick per tick.
 * - targetEid: positive integer eid of enemy unit being converted, or 0 if idle.
 * - castProgressTicks: integer ticks spent casting, 0..castTicks.
 *
 * Pinned alphabetically between ExpansionLog and Foreman.
 */

import type { ComponentRows, World } from "../core/world";

export const FAITH = "Faith" as const;

/** Row arity: [faith, targetEid, castProgressTicks]. */
export const FAITH_ARITY = 3;

export interface FaithComponents {
  readonly faithId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

export function attachFaith(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
  initialFaith = 100,
): void {
  requireRows(world, comps.faithId).set(eid, [initialFaith, 0, 0]);
}

export function getFaithRow(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.faithId)?.get(eid);
}

export function getFaith(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
): number {
  return getFaithRow(world, comps, eid)?.[0] ?? 0;
}

export function setFaith(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
  faith: number,
): void {
  const row = getFaithRow(world, comps, eid);
  if (row) {
    row[0] = faith;
  }
}

export function getConversionTarget(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
): number {
  return getFaithRow(world, comps, eid)?.[1] ?? 0;
}

export function getConversionProgress(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
): number {
  return getFaithRow(world, comps, eid)?.[2] ?? 0;
}

export function setConversion(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
  targetEid: number,
  progress: number,
): void {
  const row = getFaithRow(world, comps, eid);
  if (row) {
    row[1] = targetEid;
    row[2] = progress;
  }
}

export function clearConversion(
  world: World,
  comps: Pick<FaithComponents, "faithId">,
  eid: number,
): void {
  const row = getFaithRow(world, comps, eid);
  if (row) {
    row[1] = 0;
    row[2] = 0;
  }
}

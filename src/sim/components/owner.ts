/**
 * Unit-ownership component — M2-T9 two-player accounting.
 *
 * Legacy M1 worlds have exactly one player, so bare `UnitTag` villagers
 * never carried an owner: every reader defaulted them to PLAYER_ONE
 * (the same `?? 0` convention placement/training commands use). A
 * second (AI-owned) town center breaks that assumption — population
 * caps and villager rosters must attribute units per player.
 *
 * `spawnUnit({ ownerId })` attaches an explicit `Owner` row ONLY for
 * non-default owners; player-zero units stay rowless so every existing
 * digest stays byte-identical. Reads go through {@link ownerOfUnit},
 * which applies the documented default:
 *
 *   owner(eid) = Owner row?.[0] ?? PLAYER_ONE
 *
 * The component name slots alphabetically between MoveTarget and
 * Position in components/index.ts defineSimComponents — inserting it
 * there keeps the registry's strictly ascending order (and therefore
 * every digest line) unchanged.
 */

import type { ComponentRows, World } from "../core/world";

export const OWNER = "Owner" as const;

/** Row arity: [ownerPlayerId]. */
export const OWNER_ARITY = 1;

export interface OwnerComponents {
  readonly ownerId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/**
 * Owning player of one unit: the explicit Owner row when present,
 * otherwise the legacy single-player default (player zero).
 */
export function ownerOfUnit(
  world: World,
  comps: Pick<OwnerComponents, "ownerId">,
  eid: number,
): number {
  return requireRows(world, comps.ownerId).get(eid)?.[0] ?? 0;
}

/**
 * Attach an explicit owner row to one unit. Player-zero ownership stays
 * IMPLICIT (no row) so pre-M2-T9 fixtures keep byte-identical digests;
 * calling this with any other player stamps `[playerId]`.
 */
export function attachOwner(
  world: World,
  comps: Pick<OwnerComponents, "ownerId">,
  eid: number,
  playerId: number,
): void {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `unit owner must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  if (playerId === 0) return; // legacy default: rowless means player zero
  requireRows(world, comps.ownerId).set(eid, [playerId]);
}

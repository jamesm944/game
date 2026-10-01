/**
 * Simulation-Side Deterministic Rally Point Architecture — Q1 (Issue #120).
 *
 * Provides:
 * 1. RallyTarget data structure for production buildings (Town Center, Barracks,
 *    Archery Range, Stable, Siege Workshop, Castle, Dock, Monastery).
 * 2. Simulation helpers to query, set, and clear building rally targets.
 * 3. Smart dispatch for newly trained units (ground move, resource gathering,
 *    construction assistance, or garrisoning).
 * 4. Deterministic inbox commands for single and multi-building rally points.
 */

import type { World } from "./world";
import type { SimComponents } from "../components";

export const SET_RALLY_POINT_KIND = "setRallyPoint";
export const SET_MULTI_RALLY_POINT_KIND = "setMultiRallyPoint";
export const CLEAR_RALLY_POINT_KIND = "clearRallyPoint";

export interface RallyTarget {
  readonly x: number;
  readonly y: number;
  readonly targetEntityId?: number | undefined;
}

/**
 * Returns the active rally target for a production building, or undefined if none is set.
 */
export function getRallyPoint(
  world: World,
  buildingEid: number,
): RallyTarget | undefined {
  return world.rallyPoints?.get(buildingEid);
}

/**
 * Sets or updates the active rally target for a production building.
 */
export function setRallyPoint(
  world: World,
  buildingEid: number,
  target: RallyTarget,
): void {
  world.rallyPoints ??= new Map<number, RallyTarget>();
  world.rallyPoints.set(buildingEid, {
    x: target.x,
    y: target.y,
    targetEntityId: target.targetEntityId,
  });
}

/**
 * Clears the active rally target for a building.
 * Returns true if a rally point was present and removed.
 */
export function clearRallyPoint(
  world: World,
  buildingEid: number,
): boolean {
  if (!world.rallyPoints) return false;
  return world.rallyPoints.delete(buildingEid);
}

/**
 * Checks if a building currently has a rally point.
 */
export function hasRallyPoint(
  world: World,
  buildingEid: number,
): boolean {
  return world.rallyPoints?.has(buildingEid) ?? false;
}

/**
 * Dispatches a newly spawned unit to its producing building's rally point.
 * Contextually issues:
 * - Gather command if rallied to a living resource node (for Villagers & Fishing Boats).
 * - Build command if rallied to an unfinished building site (for Villagers).
 * - GroupMove command if rallied to ground or fallback coordinates.
 */
export function dispatchSpawnedUnitToRally(
  world: World,
  comps: SimComponents,
  spawnedEid: number,
  buildingEid: number,
  unitId: string,
): void {
  const rally = getRallyPoint(world, buildingEid);
  if (!rally) return;

  const targetEntityId = rally.targetEntityId;

  // 1. Smart rally to resource node
  if (targetEntityId !== undefined && comps.resourceNodeId !== undefined) {
    const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
    const nodeRow = nodeRows?.get(targetEntityId);
    if (nodeRow && nodeRow[1]! > 0) {
      const isVillager = unitId === "villager";
      const isFishingBoat = unitId === "fishing-boat";

      if (isVillager || isFishingBoat) {
        world.inbox.submit({
          kind: "gather",
          targetTick: world.tick + 1,
          data: {
            entityIds: [spawnedEid],
            nodeId: targetEntityId,
          },
        });
        return;
      }
    }
  }

  // 2. Smart rally to construction site
  if (targetEntityId !== undefined && comps.buildingSiteId !== undefined) {
    const siteRows = world.rowsByComponentId.get(comps.buildingSiteId);
    const siteRow = siteRows?.get(targetEntityId);
    if (siteRow) {
      // Unfinished building site
      if (unitId === "villager") {
        world.inbox.submit({
          kind: "build",
          targetTick: world.tick + 1,
          data: {
            entityIds: [spawnedEid],
            siteEid: targetEntityId,
          },
        });
        return;
      }
    }
  }

  // 3. Fallback: Group move to rally ground coordinates
  world.inbox.submit({
    kind: "groupMove",
    targetTick: world.tick + 1,
    data: {
      entityIds: [spawnedEid],
      x: rally.x,
      y: rally.y,
    },
  });
}

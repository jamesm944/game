/**
 * Water navigability, shoreline detection & unified terrain bitmasks — V15 / ADR-0005 (Milestone N1 / #108).
 *
 * Provides bitmask constants and pure query helpers:
 * - FLAG_WALKABLE_LAND (1): Passable terrain for land units (villagers, infantry, cavalry, siege).
 * - FLAG_NAVIGABLE_WATER (2): Navigable water for naval vessels (fishing boats, galleys, transports).
 * - FLAG_SHORELINE (4): Transition boundary tiles between water and land.
 *
 * All functions are pure with respect to WorldLayers and never touch mutable state.
 */

import { isWaterTerrain, type WorldLayers } from "./layers";
import type { World } from "../core/world";
import { footprintOfDefCode } from "../components/buildings";

/** Bitmask flags for tile navigability — SPEC / ADR-0005. */
export const FLAG_WALKABLE_LAND = 1; // 0b001
export const FLAG_NAVIGABLE_WATER = 2; // 0b010
export const FLAG_SHORELINE = 4; // 0b100

/**
 * Returns true if world position (x, y) falls on navigable water.
 * Out-of-bounds positions return false.
 */
export function isNavigableWaterTile(
  layers: WorldLayers,
  x: number,
  y: number,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= layers.size || ty >= layers.size) {
    return false;
  }
  return isWaterTerrain(layers.terrainType[ty * layers.size + tx]!);
}

/**
 * Returns true if world position (x, y) falls on walkable land.
 * Out-of-bounds positions return false.
 */
export function isWalkableLandTile(
  layers: WorldLayers,
  x: number,
  y: number,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= layers.size || ty >= layers.size) {
    return false;
  }
  return !isWaterTerrain(layers.terrainType[ty * layers.size + tx]!);
}

/**
 * Returns true if tile (x, y) is on the shoreline seam — i.e. it borders
 * at least one cardinal or diagonal tile of the opposing medium (water vs land).
 * Out-of-bounds positions return false.
 */
export function isShorelineTile(
  layers: WorldLayers,
  x: number,
  y: number,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= layers.size || ty >= layers.size) {
    return false;
  }
  const selfIsWater = isWaterTerrain(
    layers.terrainType[ty * layers.size + tx]!,
  );

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= layers.size || ny >= layers.size) {
        continue;
      }
      const neighborIsWater = isWaterTerrain(
        layers.terrainType[ny * layers.size + nx]!,
      );
      if (selfIsWater !== neighborIsWater) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns the combined navigability bitmask for tile (x, y).
 * Out-of-bounds tiles return 0.
 */
export function navigabilityAt(
  layers: WorldLayers,
  x: number,
  y: number,
): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= layers.size || ty >= layers.size) {
    return 0;
  }
  let mask = isWaterTerrain(layers.terrainType[ty * layers.size + tx]!)
    ? FLAG_NAVIGABLE_WATER
    : FLAG_WALKABLE_LAND;

  if (isShorelineTile(layers, tx, ty)) {
    mask |= FLAG_SHORELINE;
  }
  return mask;
}

/**
 * Derives a full navigability bitmask plane (length size×size) for the entire map.
 */
export function deriveNavigability(layers: WorldLayers): Uint8Array {
  const size = layers.size;
  const tileCount = size * size;
  const out = new Uint8Array(tileCount);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = navigabilityAt(layers, x, y);
    }
  }
  return out;
}

/**
 * Derives a water passability plane where 1 = navigable water, 0 = blocked land.
 * Directly usable by A* pathfinding (astar.ts / findPath) for ships without
 * modifying the engine or allocating duplicate structs.
 */
export function deriveWaterPassability(layers: WorldLayers): Uint8Array {
  const size = layers.size;
  const tileCount = size * size;
  const out = new Uint8Array(tileCount);

  for (let i = 0; i < tileCount; i++) {
    out[i] = isWaterTerrain(layers.terrainType[i]!) ? 1 : 0;
  }
  return out;
}

/**
 * Derives a water passability plane with building/site footprints blocked (0 = blocked, 1 = navigable water).
 */
export function waterPassabilityWithBuildings(
  world: World,
  comps: { buildingId?: number; buildingSiteId?: number; positionId?: number },
): Uint8Array {
  const size = world.layers.size;
  const out = deriveWaterPassability(world.layers);
  if (comps.positionId === undefined) return out;
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!posRows) return out;

  if (comps.buildingId !== undefined) {
    const bRows = world.rowsByComponentId.get(comps.buildingId);
    if (bRows) {
      for (const [eid, bRow] of bRows) {
        const pos = posRows.get(eid);
        if (!pos) continue;
        const fp = footprintOfDefCode(bRow[1]!);
        const ox = Math.floor(pos[0]! - fp.width / 2);
        const oy = Math.floor(pos[1]! - fp.height / 2);
        for (let dy = 0; dy < fp.height; dy++) {
          for (let dx = 0; dx < fp.width; dx++) {
            const tx = ox + dx;
            const ty = oy + dy;
            if (tx >= 0 && tx < size && ty >= 0 && ty < size) {
              out[ty * size + tx] = 0;
            }
          }
        }
      }
    }
  }

  if (comps.buildingSiteId !== undefined) {
    const sRows = world.rowsByComponentId.get(comps.buildingSiteId);
    if (sRows) {
      for (const [eid, sRow] of sRows) {
        const pos = posRows.get(eid);
        if (!pos) continue;
        const fp = footprintOfDefCode(sRow[1]!);
        const ox = Math.floor(pos[0]! - fp.width / 2);
        const oy = Math.floor(pos[1]! - fp.height / 2);
        for (let dy = 0; dy < fp.height; dy++) {
          for (let dx = 0; dx < fp.width; dx++) {
            const tx = ox + dx;
            const ty = oy + dy;
            if (tx >= 0 && tx < size && ty >= 0 && ty < size) {
              out[ty * size + tx] = 0;
            }
          }
        }
      }
    }
  }

  return out;
}

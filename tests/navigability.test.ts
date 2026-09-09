/**
 * Navigability grid & shoreline detection tests — V15 / Milestone N1 (Issue #108).
 */

import { describe, expect, it } from "vitest";
import {
  FLAG_NAVIGABLE_WATER,
  FLAG_SHORELINE,
  FLAG_WALKABLE_LAND,
  deriveNavigability,
  deriveWaterPassability,
  isNavigableWaterTile,
  isShorelineTile,
  isWalkableLandTile,
  navigabilityAt,
} from "../src/sim/world/navigability";
import {
  buildLayers,
  TERRAIN_DEEP_WATER,
  TERRAIN_DIRT,
  TERRAIN_GRASS,
  TERRAIN_SHORE,
  TERRAIN_WATER,
} from "../src/sim/world/layers";

describe("navigability flags & constants", () => {
  it("defines orthogonal bitmask flags adhering to SPEC / ADR-0005", () => {
    expect(FLAG_WALKABLE_LAND).toBe(1);
    expect(FLAG_NAVIGABLE_WATER).toBe(2);
    expect(FLAG_SHORELINE).toBe(4);

    // Bitwise disjoint
    expect(FLAG_WALKABLE_LAND & FLAG_NAVIGABLE_WATER).toBe(0);
    expect(FLAG_WALKABLE_LAND & FLAG_SHORELINE).toBe(0);
    expect(FLAG_NAVIGABLE_WATER & FLAG_SHORELINE).toBe(0);
  });
});

describe("tile query helpers", () => {
  // Build a 4×4 synthetic world:
  // Rows 0-1: Grass (land)
  // Row 2: Shore (beach land)
  // Row 3: Water (water)
  const size = 4;
  const terrain = new Uint8Array([
    TERRAIN_GRASS, TERRAIN_GRASS, TERRAIN_GRASS, TERRAIN_GRASS,
    TERRAIN_GRASS, TERRAIN_DIRT,  TERRAIN_DIRT,  TERRAIN_GRASS,
    TERRAIN_SHORE, TERRAIN_SHORE, TERRAIN_SHORE, TERRAIN_SHORE,
    TERRAIN_WATER, TERRAIN_WATER, TERRAIN_WATER, TERRAIN_DEEP_WATER,
  ]);
  const elev = new Uint8Array(size * size);
  const layers = buildLayers(terrain, elev);

  it("identifies walkable land vs navigable water correctly", () => {
    // Pure land
    expect(isWalkableLandTile(layers, 0, 0)).toBe(true);
    expect(isNavigableWaterTile(layers, 0, 0)).toBe(false);

    // Shore terrain is walkable land
    expect(isWalkableLandTile(layers, 1, 2)).toBe(true);
    expect(isNavigableWaterTile(layers, 1, 2)).toBe(false);

    // Water
    expect(isWalkableLandTile(layers, 0, 3)).toBe(false);
    expect(isNavigableWaterTile(layers, 0, 3)).toBe(true);

    // Out of bounds
    expect(isWalkableLandTile(layers, -1, 0)).toBe(false);
    expect(isNavigableWaterTile(layers, 5, 5)).toBe(false);
  });

  it("detects shoreline transitions between land and water", () => {
    // Row 0 is pure inland (no water neighbors in row 0 or 1)
    expect(isShorelineTile(layers, 1, 0)).toBe(false);

    // Row 1 (y=1) has neighbor in row 2 (which is shore land, not water)
    // but wait: row 1 (y=1) has diagonal distance 2 from water (y=3), so y=1 has no water neighbor!
    expect(isShorelineTile(layers, 1, 1)).toBe(false);

    // Row 2 (y=2) is land and borders water at row 3 (y=3) -> shoreline!
    expect(isShorelineTile(layers, 0, 2)).toBe(true);
    expect(isShorelineTile(layers, 2, 2)).toBe(true);

    // Row 3 (y=3) is water and borders land at row 2 (y=2) -> shoreline!
    expect(isShorelineTile(layers, 0, 3)).toBe(true);
    expect(isShorelineTile(layers, 3, 3)).toBe(true);
  });

  it("assigns composite navigability bitmasks", () => {
    // Inland land: FLAG_WALKABLE_LAND only (1)
    expect(navigabilityAt(layers, 0, 0)).toBe(FLAG_WALKABLE_LAND);

    // Shoreline land: FLAG_WALKABLE_LAND | FLAG_SHORELINE (5)
    expect(navigabilityAt(layers, 1, 2)).toBe(FLAG_WALKABLE_LAND | FLAG_SHORELINE);

    // Shoreline water: FLAG_NAVIGABLE_WATER | FLAG_SHORELINE (6)
    expect(navigabilityAt(layers, 1, 3)).toBe(FLAG_NAVIGABLE_WATER | FLAG_SHORELINE);
  });

  it("derives full water passability for A* pathfinding", () => {
    const waterPass = deriveWaterPassability(layers);
    expect(waterPass.length).toBe(16);

    // Land rows (0, 1, 2) are 0 (blocked for ships)
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        expect(waterPass[y * 4 + x]).toBe(0);
      }
    }

    // Water row (3) is 1 (navigable for ships)
    for (let x = 0; x < 4; x++) {
      expect(waterPass[3 * 4 + x]).toBe(1);
    }
  });

  it("derives full navigability grid", () => {
    const nav = deriveNavigability(layers);
    expect(nav.length).toBe(16);
    expect(nav[0]).toBe(FLAG_WALKABLE_LAND);
    expect(nav[2 * 4 + 1]).toBe(FLAG_WALKABLE_LAND | FLAG_SHORELINE);
    expect(nav[3 * 4 + 1]).toBe(FLAG_NAVIGABLE_WATER | FLAG_SHORELINE);
  });
});

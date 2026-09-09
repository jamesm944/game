/**
 * Elevation Combat Advantage — V15 / Issue #107.
 *
 * Unit tests for the pure helper functions in src/sim/combat/elevation.ts.
 * Covers damage multipliers, range bonuses, and sight bonuses for all
 * elevation step combinations per the acceptance criteria.
 */

import { describe, expect, it } from "vitest";
import {
  elevationAt,
  elevationDamageMultiplier,
  applyElevationDamage,
  elevationRangeBonus,
  elevationSightBonus,
  HIGH_GROUND_DAMAGE_MULT,
  LOW_GROUND_DAMAGE_MULT,
  ELEVATION_RANGE_BONUS_THRESHOLD,
  ELEVATION_SIGHT_BONUS_THRESHOLD,
} from "../src/sim/combat/elevation";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";

// ---------------------------------------------------------------------------
// Helper — build a small world layer for elevationAt tests
// ---------------------------------------------------------------------------

function makeTestLayers(size: number, elevData: number[]) {
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const elevationLevel = new Uint8Array(size * size);
  for (let i = 0; i < elevData.length && i < elevationLevel.length; i++) {
    elevationLevel[i] = elevData[i]!;
  }
  return buildLayers(terrainType, elevationLevel);
}

// ---------------------------------------------------------------------------
// elevationAt
// ---------------------------------------------------------------------------

describe("elevationAt", () => {
  it("returns the correct elevation level for a tile", () => {
    // 4×4 grid; tile (2,1) = level 5
    const data = new Array(16).fill(0);
    data[1 * 4 + 2] = 5;
    const layers = makeTestLayers(4, data);
    expect(elevationAt(layers, 2.5, 1.5)).toBe(5);
  });

  it("returns 0 for flat terrain", () => {
    const layers = makeTestLayers(8, new Array(64).fill(0));
    expect(elevationAt(layers, 3.5, 3.5)).toBe(0);
  });

  it("returns 0 for out-of-bounds positions", () => {
    const layers = makeTestLayers(4, new Array(16).fill(3));
    expect(elevationAt(layers, -1, 0)).toBe(0);
    expect(elevationAt(layers, 0, -1)).toBe(0);
    expect(elevationAt(layers, 100, 0)).toBe(0);
    expect(elevationAt(layers, 0, 100)).toBe(0);
  });

  it("reads tile by flooring the position (not rounding)", () => {
    const data = new Array(16).fill(0);
    data[0 * 4 + 0] = 7;
    const layers = makeTestLayers(4, data);
    // Position 0.99 still falls on tile (0,0)
    expect(elevationAt(layers, 0.99, 0.99)).toBe(7);
    // Position 1.0 falls on tile (1,0)
    expect(elevationAt(layers, 1.0, 0.0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// elevationDamageMultiplier
// ---------------------------------------------------------------------------

describe("elevationDamageMultiplier", () => {
  it("returns 1.25 when attacker is above target", () => {
    expect(elevationDamageMultiplier(3, 1)).toBe(HIGH_GROUND_DAMAGE_MULT);
    expect(elevationDamageMultiplier(1, 0)).toBe(HIGH_GROUND_DAMAGE_MULT);
    expect(elevationDamageMultiplier(8, 0)).toBe(HIGH_GROUND_DAMAGE_MULT);
  });

  it("returns 0.75 when attacker is below target", () => {
    expect(elevationDamageMultiplier(0, 3)).toBe(LOW_GROUND_DAMAGE_MULT);
    expect(elevationDamageMultiplier(1, 8)).toBe(LOW_GROUND_DAMAGE_MULT);
  });

  it("returns 1.0 when elevations are equal", () => {
    expect(elevationDamageMultiplier(0, 0)).toBe(1.0);
    expect(elevationDamageMultiplier(4, 4)).toBe(1.0);
    expect(elevationDamageMultiplier(8, 8)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// applyElevationDamage
// ---------------------------------------------------------------------------

describe("applyElevationDamage", () => {
  it("returns baseDamage unmodified for equal elevations (fast path)", () => {
    expect(applyElevationDamage(10, 2, 2)).toBe(10);
    expect(applyElevationDamage(1, 0, 0)).toBe(1);
  });

  it("applies +25% bonus and rounds for high ground", () => {
    // 10 * 1.25 = 12.5 → round → 13
    expect(applyElevationDamage(10, 3, 1)).toBe(13);
    // 8 * 1.25 = 10.0 → round → 10
    expect(applyElevationDamage(8, 2, 0)).toBe(10);
    // 1 * 1.25 = 1.25 → round → 1
    expect(applyElevationDamage(1, 5, 0)).toBe(1);
  });

  it("applies -25% penalty and rounds for low ground", () => {
    // 10 * 0.75 = 7.5 → round → 8
    expect(applyElevationDamage(10, 1, 3)).toBe(8);
    // 4 * 0.75 = 3.0 → round → 3
    expect(applyElevationDamage(4, 0, 2)).toBe(3);
  });

  it("never returns less than 1 (minimum chip damage)", () => {
    // 1 * 0.75 = 0.75 → clamp to 1
    expect(applyElevationDamage(1, 0, 8)).toBe(1);
    expect(applyElevationDamage(1, 0, 1)).toBe(1);
  });

  it("handles all single-step elevation differences", () => {
    for (let base = 0; base < 8; base++) {
      const high = applyElevationDamage(20, base + 1, base);
      const low  = applyElevationDamage(20, base, base + 1);
      expect(high).toBe(Math.max(1, Math.round(20 * 1.25)));
      expect(low).toBe(Math.max(1, Math.round(20 * 0.75)));
    }
  });
});

// ---------------------------------------------------------------------------
// elevationRangeBonus
// ---------------------------------------------------------------------------

describe("elevationRangeBonus", () => {
  it("returns 1 when attacker is strictly above target by at least the threshold", () => {
    expect(elevationRangeBonus(2, 1)).toBe(1);
    expect(elevationRangeBonus(8, 0)).toBe(1);
    expect(elevationRangeBonus(3, 0)).toBe(1);
  });

  it("returns 0 when elevations are equal", () => {
    expect(elevationRangeBonus(0, 0)).toBe(0);
    expect(elevationRangeBonus(4, 4)).toBe(0);
  });

  it("returns 0 when attacker is below target", () => {
    expect(elevationRangeBonus(0, 1)).toBe(0);
    expect(elevationRangeBonus(1, 5)).toBe(0);
  });

  it("threshold boundary: exactly THRESHOLD levels apart returns 1", () => {
    expect(elevationRangeBonus(ELEVATION_RANGE_BONUS_THRESHOLD, 0)).toBe(1);
    expect(elevationRangeBonus(ELEVATION_RANGE_BONUS_THRESHOLD - 1, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// elevationSightBonus
// ---------------------------------------------------------------------------

describe("elevationSightBonus", () => {
  it("returns 1 when unit is at least THRESHOLD levels above reference", () => {
    expect(elevationSightBonus(2, 0)).toBe(1);
    expect(elevationSightBonus(8, 0)).toBe(1);
    expect(elevationSightBonus(5, 2)).toBe(1);
  });

  it("returns 0 when below threshold", () => {
    expect(elevationSightBonus(1, 0)).toBe(0);
    expect(elevationSightBonus(0, 0)).toBe(0);
  });

  it("returns 0 when unit is below reference", () => {
    expect(elevationSightBonus(0, 3)).toBe(0);
  });

  it("threshold boundary: exactly THRESHOLD levels apart returns 1", () => {
    expect(elevationSightBonus(ELEVATION_SIGHT_BONUS_THRESHOLD, 0)).toBe(1);
    expect(elevationSightBonus(ELEVATION_SIGHT_BONUS_THRESHOLD - 1, 0)).toBe(0);
  });

  it("returns consistent bonus regardless of absolute elevation values", () => {
    // Any ≥2-level advantage from any base should give the same result
    expect(elevationSightBonus(3, 1)).toBe(1);
    expect(elevationSightBonus(7, 5)).toBe(1);
    expect(elevationSightBonus(4, 3)).toBe(0);
  });
});

/**
 * Coastal Dock definition & 3x3 hybrid placement tests — V15 / Milestone N1 (Issue #108).
 */

import { describe, expect, it } from "vitest";
import { buildingCodeOf, buildingDefOf } from "../src/data/definitions";
import {
  defineSimComponents,
  getBuildingSiteRow,
  spawnResourceNode,
  type SimComponents,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PLACE_BUILDING_KIND,
  canAfford,
  createPlacementSystem,
  validatePlacement,
} from "../src/sim/systems/placement";
import {
  TERRAIN_GRASS,
  TERRAIN_WATER,
  buildLayers,
} from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

/**
 * 16×16 coastal grid:
 * Rows 0..6: Land ('.')
 * Rows 7..15: Water ('#')
 */
const COASTAL_16: readonly string[] = [
  "................", // 0
  "................", // 1
  "................", // 2
  "................", // 3
  "................", // 4
  "................", // 5
  "................", // 6: Shoreline land
  "################", // 7: Shoreline water
  "################", // 8
  "################", // 9
  "################", // 10
  "################", // 11
  "################", // 12
  "################", // 13
  "################", // 14
  "################", // 15
];

function worldFromAscii(rows: readonly string[], seed = 424242): World {
  const size = rows.length;
  const terrainType = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      terrainType[y * size + x] =
        rows[y]![x] === "#" ? TERRAIN_WATER : TERRAIN_GRASS;
    }
  }
  return createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
}

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
}

function harness(rows: readonly string[] = COASTAL_16, seed = 424242): Harness {
  const world = worldFromAscii(rows, seed);
  const comps = defineSimComponents(world);
  registerSystem(world, createPlacementSystem(comps));
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [500, 1000, 200, 200, 0, 0, 0],
  );
  return { world, comps };
}

describe("dock definition", () => {
  it("conforms to 3x3 footprint, Dark Age, and 150 wood cost", () => {
    const def = buildingDefOf("dock");
    expect(def.id).toBe("dock");
    expect(def.footprint).toEqual({ width: 3, height: 3 });
    expect(def.costs).toEqual({ wood: 150 });
    expect(def.ageGate).toBe("dark");
    expect(def.hp).toBe(1800);
    expect(def.dropoffFilters).toContain("food");
    expect(buildingCodeOf("dock")).toBeGreaterThan(0);
  });
});

describe("hybrid dock placement validation", () => {
  it("rejects dock placed completely on land", () => {
    const h = harness();
    // (5, 2) footprint covers y: 2, 3, 4 (pure land)
    const check = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      2,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("dock-needs-water");
  });

  it("rejects dock placed completely in water", () => {
    const h = harness();
    // (5, 10) footprint covers y: 10, 11, 12 (pure water)
    const check = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      10,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("dock-needs-land");
  });

  it("accepts dock straddling the shoreline with both land and water contact", () => {
    const h = harness();
    // (5, 5) footprint covers y: 5 (land), 6 (land), 7 (water)
    // Exterior has land at y=4 and water at y=8
    const check = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      5,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(check.ok).toBe(true);
    expect(check.rect).toEqual({ x: 5, y: 5, width: 3, height: 3 });
  });

  it("rejects out-of-bounds dock placement", () => {
    const h = harness();
    const check = validatePlacement(
      h.world,
      h.comps,
      "dock",
      14,
      5,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("out-of-bounds");
  });

  it("rejects dock overlapping an existing building or resource node", () => {
    const h = harness();
    // Spawn a resource node at (6, 6) on the shoreline
    spawnResourceNode(h.world, h.comps, 6, 6, 0, 100);

    const check = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      5,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("occupied");
  });

  it("rejects unexplored fog unless ignoreFog option is set", () => {
    const h = harness();
    // Swap visibility to denying provider
    (h.world as unknown as { visibility: unknown }).visibility = {
      id: "deny-explored",
      isVisible: () => true,
      isExplored: () => false,
      markDirty: () => {},
      flushDirty: () => {},
    };

    const checkBlocked = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      5,
      PLAYER_ONE,
      { ignoreFog: false },
    );
    expect(checkBlocked.ok).toBe(false);
    expect(checkBlocked.reason).toBe("unexplored");

    const checkIgnored = validatePlacement(
      h.world,
      h.comps,
      "dock",
      5,
      5,
      PLAYER_ONE,
      { ignoreFog: true },
    );
    expect(checkIgnored.ok).toBe(true);
  });
});

describe("dock placement order execution", () => {
  it("escrows 150 wood and spawns a 3x3 construction site on shoreline", () => {
    const h = harness();
    const woodBefore = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]!;
    expect(canAfford(h.world, h.comps, PLAYER_ONE, "dock")).toBe(true);

    h.world.inbox.submit({
      kind: PLACE_BUILDING_KIND,
      targetTick: 1,
      data: {
        defId: "dock",
        tileX: 5,
        tileY: 5,
        playerId: PLAYER_ONE,
      },
    });

    step(h.world);

    // 150 wood debited
    const woodAfter = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]!;
    expect(woodBefore - woodAfter).toBe(150);

    // Site spawned: [ownerPlayerId, defCode, progressMilliTicks, hp]
    const siteEid = h.world.entities[h.world.entities.length - 1]!;
    const siteRow = getBuildingSiteRow(h.world, h.comps, siteEid);
    expect(siteRow).toBeDefined();
    expect(siteRow![0]).toBe(PLAYER_ONE);
    expect(siteRow![1]).toBe(buildingCodeOf("dock"));
    expect(siteRow![2]).toBe(0); // progress
    expect(siteRow![3]).toBe(1800); // hp

    // Footprint tiles blocked in derivedPassability
    const size = h.world.layers.size;
    const pass = h.world.layers.derivedPassability;
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        expect(pass[(5 + dy) * size + (5 + dx)]).toBe(0);
      }
    }
  });
});

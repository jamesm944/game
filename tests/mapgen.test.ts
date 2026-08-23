/**
 * Seeded mapgen property tests — SPEC §7.
 *
 * Same seed → byte-identical map + identical hash; different seeds
 * diverge; every tile stays in enum range; reload-from-bytes is exact;
 * createWorld carries layers that match direct generation.
 */
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/sim/core/world";
import { generateMap } from "../src/sim/mapgen/generate";
import {
  RESOURCE_CLAY,
  RESOURCE_COAL,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_IRON,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../src/sim/components/economy";
import {
  DEFAULT_NODE_AMOUNTS,
  scatterResourceNodes,
} from "../src/sim/mapgen/resources";
import {
  buildLayers,
  derivePassability,
  deserializeLayers,
  IMPASSABLE,
  isWaterTerrain,
  layersHash,
  MAX_ELEVATION_LEVEL,
  PASSABLE,
  serializeLayers,
  TERRAIN_DEEP_WATER,
  TERRAIN_DIRT,
  TERRAIN_FOREST_FLOOR,
  TERRAIN_GRASS,
  TERRAIN_TYPE_COUNT,
  TERRAIN_WATER,
} from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const PINNED_SEED = 424242;

describe("seeded mapgen", () => {
  it("same seed twice produces byte-identical layers and an identical hash", () => {
    const first = generateMap(PINNED_SEED, 32);
    const second = generateMap(PINNED_SEED, 32);
    expect(serializeLayers(second)).toEqual(serializeLayers(first));
    expect(layersHash(second)).toBe(layersHash(first));
  });

  it("different seeds produce different maps", () => {
    const baseline = layersHash(generateMap(PINNED_SEED, 32));
    for (const other of [0, 1, PINNED_SEED + 1, 0xffffffff]) {
      const hash = layersHash(generateMap(other, 32));
      if (other === PINNED_SEED) continue;
      expect(hash).not.toBe(baseline);
    }
  });

  it("keeps every tile within enum ranges on a full-size map", () => {
    const layers = generateMap(PINNED_SEED);
    expect(layers.size).toBe(120);
    for (let i = 0; i < layers.terrainType.length; i++) {
      expect(layers.terrainType[i]!).toBeLessThan(TERRAIN_TYPE_COUNT);
      expect(layers.elevationLevel[i]!).toBeLessThanOrEqual(
        MAX_ELEVATION_LEVEL,
      );
      expect([PASSABLE, IMPASSABLE]).toContain(layers.derivedPassability[i]);
    }
  });

  it("water exists somewhere on the pinned seed (sanity)", () => {
    const layers = generateMap(PINNED_SEED, 32);
    let waterTiles = 0;
    for (let i = 0; i < layers.terrainType.length; i++) {
      if (isWaterTerrain(layers.terrainType[i]!)) waterTiles += 1;
    }
    expect(waterTiles).toBeGreaterThan(0);
  });

  it("derives passability from terrain only: water blocks, land walks", () => {
    const layers = generateMap(PINNED_SEED, 32);
    expect(layers.derivedPassability).toEqual(
      derivePassability(layers.terrainType),
    );
    for (let i = 0; i < layers.terrainType.length; i++) {
      const terrain = layers.terrainType[i]!;
      if (isWaterTerrain(terrain)) {
        expect(layers.derivedPassability[i]).toBe(IMPASSABLE);
      } else {
        expect(layers.derivedPassability[i]).toBe(PASSABLE);
      }
    }
  });

  it("reload-from-bytes reproduces the world exactly", () => {
    const original = generateMap(PINNED_SEED, 32);
    const bytes = serializeLayers(original);
    const restored = deserializeLayers(bytes);
    expect(restored.size).toBe(original.size);
    expect(restored.terrainType).toEqual(original.terrainType);
    expect(restored.elevationLevel).toEqual(original.elevationLevel);
    expect(restored.derivedPassability).toEqual(original.derivedPassability);
    expect(serializeLayers(restored)).toEqual(bytes);
    expect(layersHash(restored)).toBe(layersHash(original));
  });

  it("rejects corrupted layer bytes loudly", () => {
    const bytes = serializeLayers(generateMap(PINNED_SEED, 8));
    const tileCount = bytes.length / 3;

    const badTerrain = bytes.slice();
    badTerrain[2] = TERRAIN_TYPE_COUNT + 1;
    expect(() => deserializeLayers(badTerrain)).toThrow(/out of enum range/);

    const badElevation = bytes.slice();
    badElevation[tileCount] = MAX_ELEVATION_LEVEL + 1;
    expect(() => deserializeLayers(badElevation)).toThrow(/above level/);

    const badPassability = bytes.slice();
    const firstLandTile = [...badPassability.slice(0, tileCount)].findIndex(
      (t) => t !== TERRAIN_WATER && t !== TERRAIN_DEEP_WATER,
    );
    badPassability[tileCount * 2 + firstLandTile] = IMPASSABLE;
    expect(() => deserializeLayers(badPassability)).toThrow(
      /inconsistent with terrain/,
    );

    const truncated = bytes.slice(0, bytes.length - 1);
    expect(() => deserializeLayers(truncated)).toThrow(/multiple of 3/);

    const nonSquare = new Uint8Array(3 * 12);
    expect(() => deserializeLayers(nonSquare)).toThrow(/perfect square/);
  });

  it("createWorld carries generated layers matching direct mapgen", () => {
    const world = createWorld(PINNED_SEED, { size: 32 });
    const direct = generateMap(PINNED_SEED, 32);
    expect(world.layers.size).toBe(direct.size);
    expect(world.layers.terrainType).toEqual(direct.terrainType);
    expect(world.layers.elevationLevel).toEqual(direct.elevationLevel);
    expect(layersHash(world.layers)).toBe(layersHash(direct));

    const defaultWorld = createWorld(PINNED_SEED);
    expect(defaultWorld.layers.size).toBe(120);
  });

  it("mapgen leaves the forest floor band reachable across sample seeds", () => {
    for (const seed of [PINNED_SEED, 7, 123456]) {
      const layers = generateMap(seed, 64);
      const terrainValues = new Set([...layers.terrainType]);
      expect(terrainValues.has(TERRAIN_FOREST_FLOOR)).toBe(true);
    }
  });
});

// ---- Deterministic node scatter ------------------------------------------------

/** Uniform-terrain layers of `size×size` with optional water patches. */
function uniformLayers(
  terrain: number,
  size = 48,
  waterTiles: readonly (readonly [number, number])[] = [],
) {
  const terrainType = new Uint8Array(size * size).fill(terrain);
  for (const [x, y] of waterTiles) terrainType[y * size + x] = TERRAIN_WATER;
  return buildLayers(terrainType, new Uint8Array(size * size));
}

describe("scatterResourceNodes (M2-T2)", () => {
  it("is deterministic: same seed yields the identical placement set", () => {
    const layers = generateMap(PINNED_SEED, 48);
    const first = scatterResourceNodes(layers, 99, { count: 40 });
    const second = scatterResourceNodes(layers, 99, { count: 40 });
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    // Canonical spawn order: ascending tile index regardless of draws.
    for (let i = 1; i < first.length; i++) {
      expect(first[i]!.tileY * layers.size + first[i]!.tileX).toBeGreaterThan(
        first[i - 1]!.tileY * layers.size + first[i - 1]!.tileX,
      );
    }
  });

  it("forest floor yields wood, rocky dirt hosts iron/coal/clay only", () => {
    const forest = scatterResourceNodes(
      uniformLayers(TERRAIN_FOREST_FLOOR),
      5,
      {
        count: 30,
      },
    );
    expect(forest.length).toBe(30);
    for (const node of forest) {
      expect(node.resourceCode).toBe(RESOURCE_WOOD);
      expect(node.amount).toBe(DEFAULT_NODE_AMOUNTS[RESOURCE_WOOD]);
    }

    const dirt = scatterResourceNodes(uniformLayers(TERRAIN_DIRT), 5, {
      count: 60,
    });
    expect(dirt.length).toBe(60);
    const metalSet = new Set([RESOURCE_IRON, RESOURCE_COAL, RESOURCE_CLAY]);
    for (const node of dirt) {
      expect(metalSet.has(node.resourceCode)).toBe(true);
      expect(node.amount).toBe(DEFAULT_NODE_AMOUNTS[node.resourceCode]);
    }
    // All three rocky deposits appear across a healthy sample.
    expect(new Set(dirt.map((node) => node.resourceCode)).size).toBe(3);
  });

  it("grass keeps the surface variety: food plus gold/stone piles only", () => {
    const grass = scatterResourceNodes(uniformLayers(TERRAIN_GRASS), 11, {
      count: 60,
    });
    expect(grass.length).toBe(60);
    const surfaceSet = new Set([RESOURCE_FOOD, RESOURCE_GOLD, RESOURCE_STONE]);
    for (const node of grass) {
      expect(surfaceSet.has(node.resourceCode)).toBe(true);
    }
    // All three surface kinds appear across a healthy sample.
    expect(new Set(grass.map((node) => node.resourceCode)).size).toBe(3);
  });

  it("never places on water and honors min spacing plus custom amounts", () => {
    const waterTiles: [number, number][] = [];
    for (let y = 20; y < 28; y++) {
      for (let x = 20; x < 28; x++) waterTiles.push([x, y]);
    }
    const layers = uniformLayers(TERRAIN_GRASS, 32, waterTiles);
    const amounts = new Array(7).fill(9);
    const placed = scatterResourceNodes(layers, 77, {
      count: 24,
      minSpacing: 4,
      amounts,
    });
    expect(placed.length).toBeGreaterThan(0);
    for (const node of placed) {
      expect(
        isWaterTerrain(layers.terrainType[node.tileY * 32 + node.tileX]!),
      ).toBe(false);
      expect(node.amount).toBe(9);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = Math.abs(placed[i]!.tileX - placed[j]!.tileX);
        const dy = Math.abs(placed[i]!.tileY - placed[j]!.tileY);
        expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

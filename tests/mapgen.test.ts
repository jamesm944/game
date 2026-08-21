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
  derivePassability,
  deserializeLayers,
  IMPASSABLE,
  isWaterTerrain,
  layersHash,
  MAX_ELEVATION_LEVEL,
  PASSABLE,
  serializeLayers,
  TERRAIN_DEEP_WATER,
  TERRAIN_FOREST_FLOOR,
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

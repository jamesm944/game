import { describe, expect, it } from "vitest";
import {
  createSplatTexture,
  buildTerrainMesh,
  terrainHeightAt,
  ELEVATION_STEP,
} from "../src/render/terrain";
import {
  TERRAIN_DEEP_WATER,
  TERRAIN_WATER,
  TERRAIN_SHORE,
  TERRAIN_GRASS,
  TERRAIN_DIRT,
  TERRAIN_FOREST_FLOOR,
  type WorldLayers,
} from "../src/sim/world/layers";
// Numeric constants matching Three.js LinearFilter (1006) and ClampToEdgeWrapping (1001)
const THREE_LINEAR_FILTER = 1006;
const THREE_CLAMP_TO_EDGE = 1001;

function mockLayers(size = 4): WorldLayers {
  const count = size * size;
  const terrainType = new Uint8Array(count);
  const elevationLevel = new Uint8Array(count);
  const derivedPassability = new Uint8Array(count).fill(1);

  // Set up different tiles for testing
  terrainType[0] = TERRAIN_DEEP_WATER;
  terrainType[1] = TERRAIN_WATER;
  terrainType[2] = TERRAIN_SHORE;
  terrainType[3] = TERRAIN_GRASS;
  terrainType[4] = TERRAIN_DIRT;
  terrainType[5] = TERRAIN_FOREST_FLOOR;

  // Elevation step for cliff testing
  elevationLevel[0] = 0;
  elevationLevel[1] = 1;

  return {
    size,
    terrainType,
    elevationLevel,
    derivedPassability,
  };
}

describe("terrain splatmap & mesh (V13, #93)", () => {
  it("creates a GPU splat texture with RGBA weights per biome", () => {
    const layers = mockLayers(4);
    const splat = createSplatTexture(layers);

    expect(splat.image.width).toBe(4);
    expect(splat.image.height).toBe(4);
    expect(splat.minFilter).toBe(THREE_LINEAR_FILTER);
    expect(splat.magFilter).toBe(THREE_LINEAR_FILTER);
    expect(splat.wrapS).toBe(THREE_CLAMP_TO_EDGE);
    expect(splat.wrapT).toBe(THREE_CLAMP_TO_EDGE);

    const data = splat.image.data as Uint8Array;

    // Tile 0: deep-water -> all 0
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(0);
    expect(data[3]).toBe(0);

    // Tile 1: water -> all 0
    expect(data[4]).toBe(0);
    expect(data[5]).toBe(0);
    expect(data[6]).toBe(0);
    expect(data[7]).toBe(0);

    // Tile 2: shore -> R=255
    expect(data[8]).toBe(255);
    expect(data[9]).toBe(0);
    expect(data[10]).toBe(0);
    expect(data[11]).toBe(0);

    // Tile 3: grass -> G=255
    expect(data[12]).toBe(0);
    expect(data[13]).toBe(255);
    expect(data[14]).toBe(0);
    expect(data[15]).toBe(0);

    // Tile 4: dirt -> B=255
    expect(data[16]).toBe(0);
    expect(data[17]).toBe(0);
    expect(data[18]).toBe(255);
    expect(data[19]).toBe(0);

    // Tile 5: forest floor -> A=255
    expect(data[20]).toBe(0);
    expect(data[21]).toBe(0);
    expect(data[22]).toBe(0);
    expect(data[23]).toBe(255);
  });

  it("builds terrain mesh with single draw call and correct attributes", () => {
    const layers = mockLayers(4);
    const mesh = buildTerrainMesh(layers);

    expect(mesh.geometry.getAttribute("position")).toBeDefined();
    expect(mesh.geometry.getAttribute("normal")).toBeDefined();
    expect(mesh.geometry.getAttribute("color")).toBeDefined();
    expect(mesh.geometry.getAttribute("aTerrainType")).toBeDefined();
    expect(mesh.uTime).toBeDefined();
    expect(typeof mesh.updateFarms).toBe("function");

    // Check vertex colors are normalized and positive
    const colors = mesh.geometry.getAttribute("color");
    for (let i = 0; i < Math.min(colors.count, 24); i++) {
      expect(colors.getX(i)).toBeGreaterThan(0.5);
      expect(colors.getY(i)).toBeGreaterThan(0.5);
      expect(colors.getZ(i)).toBeGreaterThan(0.5);
    }
  });

  it("terrainHeightAt correctly evaluates elevation steps", () => {
    const layers = mockLayers(4);
    // Tile (0, 0) is deep water at level 0: 0 * ELEVATION_STEP - WATER_RECESS
    expect(terrainHeightAt(layers, 0.5, 0.5)).toBeCloseTo(-0.15);
    // Tile (1, 0) is water at level 1: 1 * ELEVATION_STEP - WATER_RECESS
    expect(terrainHeightAt(layers, 1.5, 0.5)).toBeCloseTo(
      ELEVATION_STEP - 0.15,
    );
    // Tile (3, 0) is grass at level 0: 0 * ELEVATION_STEP
    expect(terrainHeightAt(layers, 3.5, 0.5)).toBeCloseTo(0);
  });
});

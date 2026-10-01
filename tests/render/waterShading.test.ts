/**
 * Unit & Integration Tests for Dynamic Water Shading & Shoreline Foam — W1 / Issue #128.
 */

import { describe, expect, it } from "vitest";
import {
  calculateFoamFactor,
  calculateFresnel,
  calculateWaterDepthColor,
  createWaterUniforms,
  WATER_DEEP_COLOR,
  WATER_FOAM_COLOR,
  WATER_FRAGMENT_GLSL,
  WATER_FRESNEL_F0,
  WATER_SHALLOW_COLOR,
} from "../../src/render/water";
import { buildTerrainMesh } from "../../src/render/terrain";
import {
  TERRAIN_DEEP_WATER,
  TERRAIN_WATER,
  TERRAIN_SHORE,
  TERRAIN_GRASS,
  type WorldLayers,
} from "../../src/sim/world/layers";

function mockLayers(size = 4): WorldLayers {
  const count = size * size;
  const terrainType = new Uint8Array(count);
  const elevationLevel = new Uint8Array(count);
  const derivedPassability = new Uint8Array(count).fill(1);

  terrainType[0] = TERRAIN_DEEP_WATER;
  terrainType[1] = TERRAIN_WATER;
  terrainType[2] = TERRAIN_SHORE;
  terrainType[3] = TERRAIN_GRASS;

  return {
    size,
    terrainType,
    elevationLevel,
    derivedPassability,
  };
}

describe("W1: Water Optics & Wave Physics Formulas", () => {
  it("defines calibrated physical water and foam color constants", () => {
    // Colors must be normalized in [0, 1] range
    for (const c of [WATER_DEEP_COLOR, WATER_SHALLOW_COLOR, WATER_FOAM_COLOR]) {
      expect(c[0]).toBeGreaterThanOrEqual(0);
      expect(c[0]).toBeLessThanOrEqual(1);
      expect(c[1]).toBeGreaterThanOrEqual(0);
      expect(c[1]).toBeLessThanOrEqual(1);
      expect(c[2]).toBeGreaterThanOrEqual(0);
      expect(c[2]).toBeLessThanOrEqual(1);
    }

    // Deep water is darker than shallow water
    const deepLum =
      WATER_DEEP_COLOR[0] + WATER_DEEP_COLOR[1] + WATER_DEEP_COLOR[2];
    const shallowLum =
      WATER_SHALLOW_COLOR[0] +
      WATER_SHALLOW_COLOR[1] +
      WATER_SHALLOW_COLOR[2];
    expect(deepLum).toBeLessThan(shallowLum);

    // Foam is high-albedo sea salt near-white with blue-tinted undertone
    expect(WATER_FOAM_COLOR[0]).toBeGreaterThan(0.9);
    expect(WATER_FOAM_COLOR[1]).toBeGreaterThan(0.9);
    expect(WATER_FOAM_COLOR[2]).toBe(1.0);
  });

  it("calculates Schlick Fresnel reflectance across viewing angles", () => {
    // Normal incidence (looking directly down, cosTheta = 1.0) -> F0 (0.02)
    const normalReflectance = calculateFresnel(1.0);
    expect(normalReflectance).toBeCloseTo(WATER_FRESNEL_F0, 4);

    // Glancing / grazing angle (cosTheta = 0.0) -> 1.0 (total reflection)
    const grazingReflectance = calculateFresnel(0.0);
    expect(grazingReflectance).toBeCloseTo(1.0, 4);

    // Moderate angle (45 degrees, cosTheta ~ 0.707)
    const midReflectance = calculateFresnel(Math.cos(Math.PI / 4));
    expect(midReflectance).toBeGreaterThan(normalReflectance);
    expect(midReflectance).toBeLessThan(grazingReflectance);

    // Monotonicity check: as angle goes from 0 (normal) to 90 (grazing), reflectance increases
    let prev = 0.0;
    for (let angle = 0; angle <= 90; angle += 10) {
      const rad = (angle * Math.PI) / 180;
      const f = calculateFresnel(Math.cos(rad));
      expect(f).toBeGreaterThanOrEqual(prev - 0.0001);
      prev = f;
    }
  });

  it("interpolates water depth color between deep abyss and coastal turquoise", () => {
    const deep = calculateWaterDepthColor(0.0);
    expect(deep[0]).toBeCloseTo(WATER_DEEP_COLOR[0], 4);
    expect(deep[1]).toBeCloseTo(WATER_DEEP_COLOR[1], 4);
    expect(deep[2]).toBeCloseTo(WATER_DEEP_COLOR[2], 4);

    const shallow = calculateWaterDepthColor(1.0);
    expect(shallow[0]).toBeCloseTo(WATER_SHALLOW_COLOR[0], 4);
    expect(shallow[1]).toBeCloseTo(WATER_SHALLOW_COLOR[1], 4);
    expect(shallow[2]).toBeCloseTo(WATER_SHALLOW_COLOR[2], 4);

    const mid = calculateWaterDepthColor(0.5);
    expect(mid[0]).toBeCloseTo(
      (WATER_DEEP_COLOR[0] + WATER_SHALLOW_COLOR[0]) / 2,
      4,
    );
    expect(mid[1]).toBeCloseTo(
      (WATER_DEEP_COLOR[1] + WATER_SHALLOW_COLOR[1]) / 2,
      4,
    );
  });

  it("computes dynamic coastal foam with distance falloff and surf wash", () => {
    // Zero foam in deep open water (shoreProximity = 0)
    expect(calculateFoamFactor(0.0, 1.5, 10, 10)).toBe(0);

    // Foam generates near shoreline
    let hasFoam = false;
    for (let t = 0; t < 10; t += 0.5) {
      const foam = calculateFoamFactor(0.45, t, 12, 14);
      if (foam > 0.01) {
        hasFoam = true;
        break;
      }
    }
    expect(hasFoam).toBe(true);

    // Output is clamped in [0, 1]
    const fMax = calculateFoamFactor(1.0, 3.2, 5, 5);
    expect(fMax).toBeGreaterThanOrEqual(0);
    expect(fMax).toBeLessThanOrEqual(1);
  });
});

describe("W1: Water Shader Injections & Uniform Integration", () => {
  it("contains all essential physical lighting stages in WATER_FRAGMENT_GLSL", () => {
    // Multi-octave wave sampling
    expect(WATER_FRAGMENT_GLSL).toContain("waveUv1");
    expect(WATER_FRAGMENT_GLSL).toContain("waveUv2");
    expect(WATER_FRAGMENT_GLSL).toContain("waveRipple");

    // Surface normal perturbation
    expect(WATER_FRAGMENT_GLSL).toContain("waveNormal");

    // Fresnel view reflectance
    expect(WATER_FRAGMENT_GLSL).toContain("fresnel");
    expect(WATER_FRAGMENT_GLSL).toContain("NdotV");

    // Sun specular glints
    expect(WATER_FRAGMENT_GLSL).toContain("sunGlint");
    expect(WATER_FRAGMENT_GLSL).toContain("uSunDir");

    // Coastal foam line & surf wash
    expect(WATER_FRAGMENT_GLSL).toContain("shoreProximity");
    expect(WATER_FRAGMENT_GLSL).toContain("surfWave");
    expect(WATER_FRAGMENT_GLSL).toContain("uFoamColor");
  });

  it("initializes water uniforms with valid default vectors and colors", () => {
    const uniforms = createWaterUniforms();

    expect(uniforms.uSunDir.value.length()).toBeCloseTo(1.0, 3);
    expect(uniforms.uSunColor.value.r).toBeGreaterThan(0.9);
    expect(uniforms.uSkyColor.value.b).toBeGreaterThan(0.8);
    expect(uniforms.uWaterDeepColor.value.b).toBeGreaterThan(0.1);
    expect(uniforms.uWaterShallowColor.value.g).toBeGreaterThan(0.4);
    expect(uniforms.uFoamColor.value.r).toBeGreaterThan(0.9);
  });

  it("attaches waterUniforms to TerrainMesh and updates without errors", () => {
    const layers = mockLayers(4);
    const terrain = buildTerrainMesh(layers);

    expect(terrain.waterUniforms).toBeDefined();
    expect(terrain.waterUniforms.uSunDir).toBeDefined();
    expect(terrain.waterUniforms.uSunColor).toBeDefined();
    expect(terrain.waterUniforms.uSkyColor).toBeDefined();

    // Verify updating uniforms dynamically
    terrain.waterUniforms.uSunDir.value.set(0, 1, 0);
    terrain.waterUniforms.uSunColor.value.setRGB(1, 1, 1);
    expect(terrain.waterUniforms.uSunDir.value.y).toBe(1);
    expect(terrain.waterUniforms.uSunColor.value.r).toBe(1);
  });
});

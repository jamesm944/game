/**
 * Unit & Integration Tests for Architectural Night Lighting & Celestial Shadows — L1 / Issue #129.
 */

import { describe, expect, it } from "vitest";
import {
  calculateFlameFlicker,
  calculateNightLightIntensity,
  createNightLights,
  MAX_NIGHT_LIGHTS,
  TORCH_LIGHT_COLOR,
} from "../../src/render/nightLights";
import {
  createBuildingShadowMaterial,
  createBuildingShadowMesh,
  updateBuildingShadowSun,
} from "../../src/render/buildingShadows";
import type { BuildingSnapshotFrame } from "../../src/sim/mirror";
import type { WorldLayers } from "../../src/sim/world/layers";

function mockLayers(size = 4): WorldLayers {
  const count = size * size;
  return {
    size,
    terrainType: new Uint8Array(count),
    elevationLevel: new Uint8Array(count),
    derivedPassability: new Uint8Array(count).fill(1),
  };
}

describe("L1: Night Light Intensity Curves & Flame Flickering", () => {
  it("computes accurate time-of-day ignition and extinguishing transitions", () => {
    // Midnight & early night -> fully illuminated
    expect(calculateNightLightIntensity(0)).toBe(1.0);
    expect(calculateNightLightIntensity(180)).toBe(1.0);
    expect(calculateNightLightIntensity(359)).toBe(1.0);

    // Dawn transition (360..480) -> fades from 1.0 down to 0.0
    expect(calculateNightLightIntensity(360)).toBeCloseTo(1.0, 3);
    expect(calculateNightLightIntensity(420)).toBeCloseTo(0.5, 3);
    expect(calculateNightLightIntensity(480)).toBe(0.0);

    // Midday daylight (480..1080) -> 0.0
    expect(calculateNightLightIntensity(720)).toBe(0.0);
    expect(calculateNightLightIntensity(1000)).toBe(0.0);

    // Dusk transition (1080..1260) -> ignites from 0.0 up to 1.0
    expect(calculateNightLightIntensity(1080)).toBeCloseTo(0.0, 3);
    expect(calculateNightLightIntensity(1170)).toBeCloseTo(0.5, 3);
    expect(calculateNightLightIntensity(1260)).toBeCloseTo(1.0, 3);

    // Late night (1260..1439) -> 1.0
    expect(calculateNightLightIntensity(1350)).toBe(1.0);
  });

  it("handles out-of-range minutes safely using modulo 1440", () => {
    expect(calculateNightLightIntensity(-60)).toBeCloseTo(
      calculateNightLightIntensity(1380),
      3,
    );
    expect(calculateNightLightIntensity(1440 + 720)).toBe(0.0);
  });

  it("evaluates bounded flame turbulence flickering", () => {
    const f0 = calculateFlameFlicker(0, 0);
    expect(f0).toBeGreaterThan(0.85);
    expect(f0).toBeLessThan(1.15);

    let hasVariance = false;
    for (let t = 0; t < 5; t += 0.5) {
      const f = calculateFlameFlicker(t, 42);
      if (Math.abs(f - 1.0) > 0.02) {
        hasVariance = true;
        break;
      }
    }
    expect(hasVariance).toBe(true);
  });

  it("defines warm amber torchlight color", () => {
    expect(TORCH_LIGHT_COLOR[0]).toBe(1.0);
    expect(TORCH_LIGHT_COLOR[1]).toBeGreaterThan(0.6);
    expect(TORCH_LIGHT_COLOR[2]).toBeLessThan(0.4);
  });
});

describe("L1: Architectural Night Lights Layer", () => {
  it("creates instanced night light mesh with additive blending and spherical billboarding", () => {
    const handle = createNightLights(128);

    expect(handle.mesh.name).toBe("architectural-night-lights");
    expect(handle.mesh.visible).toBe(false);
    expect(handle.mesh.count).toBe(0);
    expect(handle.material.transparent).toBe(true);
    expect(handle.material.depthWrite).toBe(false);

    // Shaders must contain billboarding and Gaussian glow
    expect(handle.material.vertexShader).toContain("modelViewMatrix");
    expect(handle.material.vertexShader).toContain("uGlowRadius");
    expect(handle.material.fragmentShader).toContain("exp(-dist * dist");

    handle.dispose();
  });

  it("remains dormant during daytime (0 active instances)", () => {
    const handle = createNightLights(128);
    const layers = mockLayers(8);

    const frame: BuildingSnapshotFrame = {
      count: 2,
      eids: new Int32Array([1, 2]),
      origins: new Float32Array([2, 2, 5, 5]),
      sizes: new Float32Array([4, 4, 2, 2]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
      defCodes: new Uint8Array([1, 2]),
      ownerIds: new Uint8Array([0, 0]),
      ageRanks: new Uint8Array([2, 2]),
    };

    // At minute 720 (midday 12:00)
    const active = handle.update(frame, layers, 720, 10.0);
    expect(active).toBe(0);
    expect(handle.mesh.visible).toBe(false);
    expect(handle.mesh.count).toBe(0);

    handle.dispose();
  });

  it("populates lantern and torch glows during night", () => {
    const handle = createNightLights(MAX_NIGHT_LIGHTS);
    const layers = mockLayers(8);

    const frame: BuildingSnapshotFrame = {
      count: 2,
      eids: new Int32Array([1, 2]),
      origins: new Float32Array([2, 2, 5, 5]),
      sizes: new Float32Array([4, 4, 2, 2]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
      defCodes: new Uint8Array([1, 2]),
      ownerIds: new Uint8Array([0, 0]),
      ageRanks: new Uint8Array([2, 2]),
    };

    // At minute 120 (2:00 AM full night)
    const active = handle.update(frame, layers, 120, 10.0);
    expect(active).toBeGreaterThan(0);
    expect(handle.mesh.visible).toBe(true);
    expect(handle.mesh.count).toBe(active);

    handle.dispose();
  });
});

describe("L1: Dynamic Sun Ground Shadows", () => {
  it("adjusts shadow offset and darkness based on celestial sun vector", () => {
    const shadowMesh = createBuildingShadowMesh(64);
    const mat =
      shadowMesh.material as ReturnType<typeof createBuildingShadowMaterial>;

    expect(mat.uniforms.uShadowOffset).toBeDefined();
    expect(mat.uniforms.uShadowDarkness).toBeDefined();

    // High sun (midday, sun.y = 1.0) -> offset is minimal
    updateBuildingShadowSun(shadowMesh, { x: 0, y: 1.0, z: 0 }, false);
    expect(mat.uniforms.uShadowOffset!.value.length()).toBeCloseTo(0, 3);
    expect(mat.uniforms.uShadowDarkness!.value).toBe(0.65);

    // Low raking sun (dawn/sunset, sun pointing from +X) -> shadow offsets towards -X
    updateBuildingShadowSun(shadowMesh, { x: 0.8, y: 0.2, z: 0 }, false);
    expect(mat.uniforms.uShadowOffset!.value.x).toBeLessThan(0);
    expect(mat.uniforms.uShadowDarkness!.value).toBe(0.65);

    // Night moonlight -> softer darkness
    updateBuildingShadowSun(shadowMesh, { x: 0.3, y: 0.5, z: 0.3 }, true);
    expect(mat.uniforms.uShadowDarkness!.value).toBe(0.35);
  });
});

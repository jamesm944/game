/**
 * Unit Tests for RTS Post-Processing & Tone Mapping — P1 / Issue #130.
 *
 * Verifies analytical tone mapping, bloom luminance extraction, and vignette
 * functions in headless test environments without Three.js DOM dependencies.
 */

import { describe, expect, it } from "vitest";
import {
  calculateACESFilm,
  calculateBloomWeight,
  calculateVignette,
  POST_PROCESSING_FRAGMENT_GLSL,
} from "../../src/render/postProcessing";

describe("P1: Analytical ACES Filmic Tone Mapping", () => {
  it("maps black (0) strictly to 0", () => {
    expect(calculateACESFilm(0)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(calculateACESFilm(-0.5)).toBe(0);
    expect(calculateACESFilm(-10)).toBe(0);
  });

  it("strictly preserves monotonicity for positive radiance", () => {
    const samples = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0];
    for (let i = 0; i < samples.length - 1; i++) {
      const s1 = samples[i];
      const s2 = samples[i + 1];
      if (s1 === undefined || s2 === undefined) continue;
      const v1 = calculateACESFilm(s1);
      const v2 = calculateACESFilm(s2);
      expect(v2).toBeGreaterThan(v1);
    }
  });

  it("compresses super-bright HDR radiance smoothly without exceeding 1.0", () => {
    const hdr1 = calculateACESFilm(1.0);
    const hdr3 = calculateACESFilm(3.0);
    const hdr10 = calculateACESFilm(10.0);
    const hdr100 = calculateACESFilm(100.0);

    expect(hdr1).toBeLessThan(hdr3);
    expect(hdr3).toBeLessThan(hdr10);
    expect(hdr10).toBeLessThanOrEqual(1.0);
    expect(hdr100).toBeLessThanOrEqual(1.0);
    expect(hdr10).toBeGreaterThan(0.95);
    expect(hdr100).toBeGreaterThanOrEqual(hdr10);
  });
});

describe("P1: Luminance-Weighted Bloom Extraction", () => {
  it("rejects low and medium luminance values below threshold", () => {
    expect(calculateBloomWeight(0.0)).toBe(0);
    expect(calculateBloomWeight(0.5)).toBe(0);
    expect(calculateBloomWeight(0.82)).toBe(0);
  });

  it("smoothly ramps up bloom weight for super-luminous highlights", () => {
    const threshold = 0.82;
    const mid = calculateBloomWeight(threshold + 0.225);
    const peak = calculateBloomWeight(threshold + 0.45);
    const overPeak = calculateBloomWeight(threshold + 1.0);

    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(peak).toBeCloseTo(1.0, 4);
    expect(overPeak).toBe(1.0);
  });

  it("respects custom threshold parameters", () => {
    expect(calculateBloomWeight(0.5, 0.4)).toBeGreaterThan(0);
    expect(calculateBloomWeight(0.5, 0.6)).toBe(0);
  });
});

describe("P1: Analytical Vignette Shading", () => {
  it("yields 1.0 at screen center", () => {
    expect(calculateVignette(0.5, 0.5)).toBe(1.0);
  });

  it("darkens corners symmetrically", () => {
    const topLeft = calculateVignette(0.0, 0.0);
    const topRight = calculateVignette(1.0, 0.0);
    const bottomLeft = calculateVignette(0.0, 1.0);
    const bottomRight = calculateVignette(1.0, 1.0);

    expect(topLeft).toBeLessThan(1.0);
    expect(topRight).toBeCloseTo(topLeft, 5);
    expect(bottomLeft).toBeCloseTo(topLeft, 5);
    expect(bottomRight).toBeCloseTo(topLeft, 5);
  });

  it("scales with intensity parameter", () => {
    const mild = calculateVignette(0.0, 0.0, 0.1);
    const strong = calculateVignette(0.0, 0.0, 0.4);

    expect(strong).toBeLessThan(mild);
  });
});

describe("P1: Post-Processing Shader Definition", () => {
  it("contains all necessary uniforms and ACES tone mapping GLSL function", () => {
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform sampler2D tDiffuse;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform vec2 uResolution;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform float uBloomIntensity;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform float uVignetteIntensity;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform float uContrast;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("uniform float uSaturation;");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("vec3 ACESFilm(vec3 x)");
    expect(POST_PROCESSING_FRAGMENT_GLSL).toContain("smoothstep(0.80, 1.25, luma)");
  });
});

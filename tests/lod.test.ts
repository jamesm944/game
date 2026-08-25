/**
 * LOD zoom-band math — SPEC §7 / M5-T4 (issue #66).
 *
 * Sprite playback is quantized to a zoom-derived rate: the near band
 * runs the canonical 15 fps clip quantum; once the camera is ≥60% of
 * the way to full zoom-out the far band throttles to 7.5 fps. The
 * vertex shader consumes the same number via uPlaybackRate, so these
 * pure bounds pin exactly what the GPU plays.
 */
import { describe, expect, it } from "vitest";
import {
  FAR_BAND_QUANTUM_FPS,
  FAR_BAND_ZOOM_OUT_FRACTION,
  PLAYBACK_QUANTUM_FPS,
  frameAtTime,
  playbackRateForZoom,
} from "../src/render/atlasFrames";

/** The live camera clamp (render/camera.ts) for sanity scenarios. */
const MIN_VIEW_HEIGHT = 24;
const MAX_VIEW_HEIGHT = 240;

describe("playbackRateForZoom (§7 LOD bands)", () => {
  it("keeps the near-band 15 fps fully zoomed in", () => {
    expect(
      playbackRateForZoom(MIN_VIEW_HEIGHT, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT),
    ).toBe(PLAYBACK_QUANTUM_FPS);
  });

  it("stays at 15 fps below the 60% zoom-out trigger", () => {
    // Halfway through the zoom range: still near band.
    const mid = (MIN_VIEW_HEIGHT + MAX_VIEW_HEIGHT) / 2;
    expect(playbackRateForZoom(mid, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT)).toBe(
      PLAYBACK_QUANTUM_FPS,
    );
    // Just under the threshold fraction.
    const span = MAX_VIEW_HEIGHT - MIN_VIEW_HEIGHT;
    const justUnder =
      MIN_VIEW_HEIGHT + span * (FAR_BAND_ZOOM_OUT_FRACTION - 0.001);
    expect(
      playbackRateForZoom(justUnder, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT),
    ).toBe(PLAYBACK_QUANTUM_FPS);
  });

  it("switches to 7.5 fps exactly at and beyond 60% zoom-out", () => {
    expect(FAR_BAND_QUANTUM_FPS).toBe(7.5);
    const span = MAX_VIEW_HEIGHT - MIN_VIEW_HEIGHT;
    const threshold = MIN_VIEW_HEIGHT + span * FAR_BAND_ZOOM_OUT_FRACTION;
    expect(
      playbackRateForZoom(threshold, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT),
    ).toBe(FAR_BAND_QUANTUM_FPS);
    expect(
      playbackRateForZoom(MAX_VIEW_HEIGHT, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT),
    ).toBe(FAR_BAND_QUANTUM_FPS);
  });

  it("defaults to near-band on a degenerate zoom range", () => {
    expect(playbackRateForZoom(50, 40, 40)).toBe(PLAYBACK_QUANTUM_FPS);
    expect(playbackRateForZoom(50, 50, 20)).toBe(PLAYBACK_QUANTUM_FPS);
  });

  it("halves the shared-clock flip cadence in the far band", () => {
    // A 16-frame @24 fps clip outruns BOTH quanta, so each band's
    // flip rate is set purely by its quantum: ~15/s near, ~7.5/s far.
    const frames = 16;
    const duration = frames / 24;
    const countFlips = (quantumFps: number): number => {
      const step = 1 / 480;
      let flips = 0;
      let prev = frameAtTime(frames, duration, 0, quantumFps);
      for (let t = step; t < 8; t += step) {
        const next = frameAtTime(frames, duration, t, quantumFps);
        if (next !== prev) flips += 1;
        prev = next;
      }
      return flips;
    };
    const near = countFlips(PLAYBACK_QUANTUM_FPS);
    const far = countFlips(FAR_BAND_QUANTUM_FPS);
    expect(near).toBeGreaterThanOrEqual(8 * PLAYBACK_QUANTUM_FPS - 2);
    expect(far).toBeLessThanOrEqual(8 * FAR_BAND_QUANTUM_FPS + 2);
    expect(near / far).toBeGreaterThan(1.9);
    expect(near / far).toBeLessThan(2.1);
  });
});

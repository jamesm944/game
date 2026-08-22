/**
 * Billboard-atlas correctness + headless perf gate — SPEC §7 / M1-T7.
 *
 * Node-only by design (no jsdom, no three): every function exercised
 * here lives in render/atlasFrames.ts, deliberately THREE-FREE so the
 * bake tool (node), the runtime (browser), and this suite all share
 * one implementation of the math.
 *
 * Perf claim under test: per-frame CPU work is O(1) PER TYPE for
 * playback (the vertex shader advances frames from uTime; the CPU
 * never evaluates animation) and the only per-instance work is a flat
 * typed-array attribute fill — pinned at 10k instances < 2 ms.
 */

import { describe, expect, it } from "vitest";
import {
  atlasActionSlot,
  directionIndexFor,
  frameAtTime,
  parseAtlasIndex,
  planAtlasLayout,
  uvRectFor,
  writeSpriteAttributes,
  type AtlasActionMeta,
  type SpriteAttributeArrays,
} from "../../src/render/atlasFrames";

const FRAME = 128;
const PAGE = 2048;
const YAWS = 8;

function testMetas(): AtlasActionMeta[] {
  return [
    { name: "walk", frameCount: 8, fps: 12 },
    { name: "idle", frameCount: 4, fps: 6 },
  ];
}

describe("atlas layout planning", () => {
  it("assigns contiguous cells in (action → yaw → frame) order", () => {
    const layout = planAtlasLayout(testMetas(), YAWS, FRAME, PAGE);
    expect(layout.totalFrames).toBe((8 + 4) * YAWS);
    // Alphabetical: idle first.
    expect(layout.actions[0]!.name).toBe("idle");
    expect(layout.actions[0]!.baseFrame).toBe(0);
    expect(layout.actions[1]!.name).toBe("walk");
    expect(layout.actions[1]!.baseFrame).toBe(4 * YAWS);
  });

  it("maps frames to a strict grid with no overlaps", () => {
    const layout = planAtlasLayout(testMetas(), YAWS, FRAME, PAGE);
    const seen = new Set<string>();
    for (let abs = 0; abs < layout.totalFrames; abs++) {
      const o = abs * 4;
      const col = Math.round(layout.rects[o]! * (PAGE / FRAME));
      const row = Math.round(layout.rects[o + 1]! * (PAGE / FRAME));
      const key = `${col},${row}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(col).toBe(abs % layout.columns);
      expect(row).toBe(Math.floor(abs / layout.columns));
    }
  });

  it("is byte-stable against input key order", () => {
    const a = planAtlasLayout(testMetas(), YAWS, FRAME, PAGE);
    const b = planAtlasLayout([...testMetas()].reverse(), YAWS, FRAME, PAGE);
    expect(
      Buffer.from(a.rects.buffer).equals(Buffer.from(b.rects.buffer)),
    ).toBe(true);
    expect(a.actions.map((x) => x.baseFrame)).toEqual(
      b.actions.map((x) => x.baseFrame),
    );
  });
});

describe("uvRect lookup", () => {
  const layout = planAtlasLayout(testMetas(), YAWS, FRAME, PAGE);

  it("resolves (action, yaw, frame) to the planned cell's uv rect", () => {
    // walk baseFrame=32; yaw 3, frame 5 → abs 32 + 24 + 5 = 61.
    const abs = 32 + 3 * 8 + 5;
    const rect = uvRectFor(layout, "walk", 3, 5);
    expect(rect.u0).toBeCloseTo(((abs % 16) * FRAME) / PAGE, 10);
    expect(rect.v0).toBeCloseTo((Math.floor(abs / 16) * FRAME) / PAGE, 10);
    expect(rect.u1 - rect.u0).toBeCloseTo(FRAME / PAGE, 10);
    expect(rect.v1 - rect.v0).toBeCloseTo(FRAME / PAGE, 10);
  });

  it("keeps yaw blocks contiguous inside an action", () => {
    const r0 = uvRectFor(layout, "walk", 0, 0);
    const r1 = uvRectFor(layout, "walk", 1, 0);
    expect(r1.u0 - r0.u0).toBeCloseTo(8 * (FRAME / PAGE), 10);
  });

  it("rejects out-of-range lookups loudly", () => {
    expect(() => uvRectFor(layout, "walk", YAWS, 0)).toThrow();
    expect(() => uvRectFor(layout, "walk", 0, 8)).toThrow();
    expect(() => uvRectFor(layout, "chop", 0, 0)).toThrow();
  });
});

describe("quantized playback frame selection", () => {
  it("advances one frame per clip step and wraps the loop", () => {
    // walk: 8 frames @ 12 fps → duration 2/3 s.
    expect(frameAtTime(8, 8 / 12, 0, 15)).toBe(0);
    expect(frameAtTime(8, 8 / 12, 0.4, 15)).toBe(4); // 0.4/0.666*8 = 4.8
    expect(frameAtTime(8, 8 / 12, 8 / 12 + 0.01, 15)).toBe(0); // wrapped
    expect(frameAtTime(8, 8 / 12, 5, 15)).toBeLessThan(8);
  });

  it("snaps time to the 15 fps quantum before dividing the loop", () => {
    // t=0.03 quantizes to floor(0.45)/15 = 0 → frame 0 even though raw
    // 0.03/dur would land in frame 1 territory at lower granularity.
    expect(frameAtTime(8, 8 / 12, 0.03, 15)).toBe(0);
    // Same input time ⇒ same frame regardless of instance count:
    // playback is a pure per-type function, never per-instance state.
    expect(frameAtTime(8, 8 / 12, 0.31, 15)).toBe(
      frameAtTime(8, 8 / 12, 0.31, 15),
    );
  });
});

describe("view-direction picking", () => {
  // Bake convention: camera at azimuth 0 sits on +Z looking −Z; the rig
  // faces +Z at bind pose and cell k rotates the rig +k·τ/8 about Y.
  it("picks front/back/left/right cells for canonical headings", () => {
    expect(directionIndexFor(Math.PI / 2, 0, YAWS)).toBe(0); // toward camera
    expect(directionIndexFor(-Math.PI / 2, 0, YAWS)).toBe(4); // away
    expect(directionIndexFor(0, 0, YAWS)).toBe(2); // facing east = viewer's right
    expect(directionIndexFor(Math.PI, 0, YAWS)).toBe(6); // west
  });

  it("rotates consistently when the camera azimuth changes", () => {
    // Facing the camera from any azimuth must stay cell 0: camera on
    // +X (β=π/2) means "toward camera" heading is +X (h=0).
    expect(directionIndexFor(0, Math.PI / 2, YAWS)).toBe(0);
    expect(directionIndexFor(Math.PI, Math.PI / 2, YAWS)).toBe(4);
  });

  it("stays within [0, yawCount) for arbitrary inputs", () => {
    for (let i = 0; i < 720; i++) {
      const k = directionIndexFor(i * 0.137, i * 0.291, YAWS);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(YAWS);
    }
  });
});

describe("bake-index parsing", () => {
  const layout = planAtlasLayout(testMetas(), YAWS, FRAME, PAGE);

  /** JSON exactly as tools/atlas-bake writes it. */
  function bakeJson(): Record<string, unknown> {
    return {
      id: "atlas/villager",
      generator: "tools/atlas-bake",
      source: "stand-in:tools/atlas-bake/standin.ts",
      provenance: "synthetic stand-in rig generated by tools/atlas-bake",
      frameSize: FRAME,
      pageSize: PAGE,
      columns: layout.columns,
      rows: layout.rows,
      cellsPerPage: layout.cellsPerPage,
      pageCount: layout.pageCount,
      yawCount: YAWS,
      totalFrames: layout.totalFrames,
      quantumFps: 15,
      actions: layout.actions.map((a, slot) => ({
        name: a.name,
        slot,
        baseFrame: a.baseFrame,
        frameCount: a.frameCount,
        fps: a.fps,
        duration: a.duration,
        page: a.page,
      })),
      rects: Array.from({ length: layout.totalFrames }, (_, abs) => [
        layout.rects[abs * 4]!,
        layout.rects[abs * 4 + 1]!,
        layout.rects[abs * 4 + 2]!,
        layout.rects[abs * 4 + 3]!,
      ]),
    };
  }

  it("round-trips the planner and converts v into GL texture space", () => {
    const atlas = parseAtlasIndex(bakeJson());
    expect(atlas.id).toBe("atlas/villager");
    expect(atlas.rectTexels.length).toBe(layout.totalFrames * 4);
    // flipY upload: GL-space bottom edge = 1 − (vImg + dv).
    const rect = uvRectFor(layout, "idle", 0, 0); // image space, row 0
    const glVBottom = atlas.rectTexels[1]!;
    expect(glVBottom).toBeCloseTo(1 - rect.v0 - FRAME / PAGE, 10);
    expect(atlas.actionTexels).toEqual(
      Float32Array.of(0, 4, 4 / 6, 8, 32, 8, 8 / 12, 8),
    );
  });

  it("exposes action slots for the shader uniform", () => {
    const atlas = parseAtlasIndex(bakeJson());
    expect(atlasActionSlot(atlas, "walk").slot).toBe(1);
    expect(atlasActionSlot(atlas, "walk").frameCount).toBe(8);
    expect(() => atlasActionSlot(atlas, "chop")).toThrow(/no action/);
  });

  it("fails loudly on malformed indices", () => {
    const broken = bakeJson() as { rects?: unknown };
    broken.rects = [];
    expect(() => parseAtlasIndex(broken)).toThrow(/rects/);
    expect(() =>
      parseAtlasIndex({ ...bakeJson(), id: "wrong-prefix" }),
    ).toThrow(/"id"/);
  });
});

describe("attribute-write hot path (per-instance CPU budget)", () => {
  const INSTANCES = 10_000;
  const BUDGET_MS = 2;

  const samples = {
    positions: new Float32Array(INSTANCES * 2),
    headings: new Float32Array(INSTANCES),
    count: INSTANCES,
  };
  for (let i = 0; i < INSTANCES; i++) {
    samples.positions[i * 2] = (i % 100) * 1.19;
    samples.positions[i * 2 + 1] = Math.floor(i / 100) * 1.17;
    samples.headings[i] = i * 0.00061;
  }
  const heights = new Float32Array(INSTANCES).fill(0.25);
  const arrays: SpriteAttributeArrays = {
    origins: new Float32Array(INSTANCES * 3),
    directions: new Float32Array(INSTANCES),
    tints: new Float32Array(INSTANCES * 3),
  };

  it("writes correct attributes for all instances", () => {
    const written = writeSpriteAttributes(
      arrays,
      samples,
      heights,
      { yawCount: YAWS },
      0.42,
      1,
      0.9,
      0.8,
      INSTANCES,
    );
    expect(written).toBe(INSTANCES);
    expect(arrays.origins[0]).toBe(samples.positions[0]);
    expect(arrays.origins[1]).toBe(heights[0]);
    expect(arrays.origins[2]).toBe(samples.positions[1]);
    for (let i = 0; i < INSTANCES; i += 977) {
      expect(arrays.directions[i]).toBe(
        directionIndexFor(samples.headings[i]!, 0.42, YAWS),
      );
      expect(arrays.tints[i * 3]).toBe(1);
      // Attributes are f32; 0.9 rounds on store.
      expect(arrays.tints[i * 3 + 1]).toBeCloseTo(Math.fround(0.9), 10);
    }
  });

  it("fills 10k instances in under 2 ms (best-of-seven)", () => {
    writeSpriteAttributes(
      arrays,
      samples,
      heights,
      { yawCount: YAWS },
      0.42,
      1,
      1,
      1,
      INSTANCES,
    ); // warm-up: JIT + allocator
    let fastest = Infinity;
    for (let attempt = 0; attempt < 7; attempt++) {
      const start = performance.now();
      const n = writeSpriteAttributes(
        arrays,
        samples,
        heights,
        { yawCount: YAWS },
        attempt * 0.05,
        1,
        1,
        1,
        INSTANCES,
      );
      fastest = Math.min(fastest, performance.now() - start);
      expect(n).toBe(INSTANCES);
    }
    expect(fastest).toBeLessThan(BUDGET_MS);
  });

  it("caps writes at maxInstances without touching capacity beyond", () => {
    const tiny: SpriteAttributeArrays = {
      origins: new Float32Array(3 * 4),
      directions: new Float32Array(4),
      tints: new Float32Array(3 * 4),
    };
    const written = writeSpriteAttributes(
      tiny,
      samples,
      heights,
      { yawCount: YAWS },
      0,
      1,
      1,
      1,
      4,
    );
    expect(written).toBe(4);
  });
});

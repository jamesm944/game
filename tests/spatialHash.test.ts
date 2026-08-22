/**
 * Spatial-hash helper tests — SPEC §2.13 picking support (M1-T8).
 *
 * The hash is the UI's picking primitive (marquee rect + click nearest)
 * over sim coordinates, so these tests pin its contract exactly against
 * brute-force references on deterministic layouts: closed-rect
 * inclusion, multi-cell coverage, ascending result order, nearest-with-
 * radius semantics and eid tie-breaking.
 */
import { describe, expect, it } from "vitest";
import {
  PICK_HASH_CELL,
  buildEntitySpatialHash,
  createEntitySpatialHash,
} from "../src/sim/core/spatialHash";
import { createPrng } from "../src/sim/core/prng";

interface Entry {
  eid: number;
  x: number;
  y: number;
}

function buildFrom(entries: readonly Entry[]) {
  const positions = new Float32Array(entries.length * 2);
  const eids = new Int32Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    eids[i] = entry.eid;
    positions[i * 2] = entry.x;
    positions[i * 2 + 1] = entry.y;
  }
  return {
    hash: buildEntitySpatialHash({ count: entries.length, eids, positions }),
    entries,
  };
}

function bruteForceRect(
  entries: readonly Entry[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  return entries
    .filter((e) => e.x >= minX && e.x <= maxX && e.y >= minY && e.y <= maxY)
    .map((e) => e.eid)
    .sort((a, b) => a - b);
}

describe("entity spatial hash", () => {
  it("reports zero results for an empty hash", () => {
    const hash = createEntitySpatialHash();
    expect(hash.count).toBe(0);
    expect(hash.queryRect(-100, -100, 100, 100)).toEqual([]);
    expect(hash.nearest(0, 0, 50)).toBeUndefined();
  });

  it("finds points inside a closed rect spanning many cells", () => {
    const { hash, entries } = buildFrom([
      { eid: 1, x: 0.5, y: 0.5 },
      { eid: 2, x: 3.9, y: 1.1 },
      { eid: 3, x: 4.0, y: 2.0 }, // exactly on a cell boundary tile
      { eid: 4, x: 10.2, y: 10.7 },
      { eid: 5, x: 5.5, y: 5.5 },
    ]);
    // Rect edges are INCLUSIVE on every side.
    const hits = hash.queryRect(3.9, 1.1, 5.5, 5.5);
    expect(hits).toEqual(bruteForceRect(entries, 3.9, 1.1, 5.5, 5.5));
    expect(hits).toEqual([2, 3, 5]);
    // Inverted corner order must behave identically (marquee drags both ways).
    expect(hash.queryRect(5.5, 5.5, 3.9, 1.1)).toEqual([2, 3, 5]);
  });

  it("returns ascending eids regardless of insertion order", () => {
    const { hash } = buildFrom([
      { eid: 30, x: 1.0, y: 1.0 },
      { eid: 10, x: 1.5, y: 1.5 },
      { eid: 20, x: 2.0, y: 2.0 },
    ]);
    expect(hash.queryRect(0, 0, 10, 10)).toEqual([10, 20, 30]);
  });

  it("matches brute force over a deterministic random field", () => {
    const prng = createPrng(20260822);
    const entries: Entry[] = [];
    for (let i = 0; i < 400; i++) {
      entries.push({
        eid: i + 1,
        x: prng.nextFloat() * 64,
        y: prng.nextFloat() * 64,
      });
    }
    const { hash } = buildFrom(entries);

    for (let trial = 0; trial < 200; trial++) {
      const ax = prng.nextFloat() * 64;
      const ay = prng.nextFloat() * 64;
      const bx = prng.nextFloat() * 64;
      const by = prng.nextFloat() * 64;
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minY = Math.min(ay, by);
      const maxY = Math.max(ay, by);
      expect(hash.queryRect(minX, minY, maxX, maxY)).toEqual(
        bruteForceRect(entries, minX, minY, maxX, maxY),
      );
    }
  });

  it("nearest returns the closest entry within the radius (inclusive)", () => {
    const { hash } = buildFrom([
      { eid: 1, x: 10, y: 10 },
      { eid: 2, x: 11.5, y: 10 }, // 1.5 away — inside radius 2
      { eid: 3, x: 12.5, y: 10 }, // 2.5 away — outside
      { eid: 4, x: 40, y: 40 },
    ]);
    expect(hash.nearest(10, 10, 2)).toEqual({
      eid: 1,
      distSq: 0,
    });
    // Boundary inclusive: eid 3 sits EXACTLY 1.0 tiles from the query.
    expect(hash.nearest(13.5, 10, 1)).toEqual({ eid: 3, distSq: 1 });
    // Just past the boundary nothing qualifies.
    expect(hash.nearest(13.5, 10, 0.9)).toBeUndefined();
    // Radius 0 only matches coincident points.
    expect(hash.nearest(12, 10, 0)?.eid).toBeUndefined(); // midpoint: nobody here
    expect(hash.nearest(10, 10, 0)?.eid).toBe(1);
    expect(hash.nearest(11.5, 10, 0)?.eid).toBe(2);
  });

  it("breaks exact-distance ties toward the lower eid", () => {
    const { hash } = buildFrom([
      { eid: 9, x: 8, y: 6 },
      { eid: 4, x: 12, y: 6 }, // mirror image of eid 9 around (10, 6)
    ]);
    const hit = hash.nearest(10, 6, 5);
    expect(hit?.eid).toBe(4);
    expect(hit?.distSq).toBe(4);
  });

  it("queries work across cell borders at the configured cell size", () => {
    expect(PICK_HASH_CELL).toBeGreaterThan(0);
    const edge = PICK_HASH_CELL; // first interior cell boundary
    const { hash, entries } = buildFrom([
      { eid: 1, x: edge - 0.25, y: edge - 0.25 },
      { eid: 2, x: edge + 0.25, y: edge + 0.25 },
    ]);
    expect(hash.queryRect(edge - 1, edge - 1, edge + 1, edge + 1)).toEqual(
      bruteForceRect(entries, edge - 1, edge - 1, edge + 1, edge + 1),
    );
    expect(hash.nearest(edge + 0.3, edge + 0.3, 1)?.eid).toBe(2);
  });

  it("ignores non-finite insertions instead of corrupting cells", () => {
    const hash = createEntitySpatialHash();
    hash.insert(1, Number.NaN, 5);
    hash.insert(2, 5, Number.POSITIVE_INFINITY);
    expect(hash.count).toBe(0);
    expect(hash.nearest(Number.NaN, 5, 100)).toBeUndefined();
  });
});

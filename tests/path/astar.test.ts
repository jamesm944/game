/**
 * A* unit tests — SPEC §2.2 / ADR-0003.
 *
 * Hand-built tiny grids pin optimal costs (integer ×1000), diagonal
 * behavior, corner-cut prevention, string-pulling sparsity and
 * unreachable-goal purity. The purity shims prove the search never
 * touches wall-clock or platform randomness even when a seed is passed.
 */
import { describe, expect, it } from "vitest";
import { createPrng } from "../../src/sim/core/prng";
import {
  findPath,
  hasLineOfSight,
  octileHeuristic,
  PATH_DIAGONAL_COST,
  PATH_STRAIGHT_COST,
} from "../../src/sim/path/astar";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

/** Build a grid from ASCII rows: '.' walkable, '#' blocked. */
function grid(rows: readonly string[]): {
  passability: Uint8Array;
  width: number;
} {
  const width = rows[0]!.length;
  const passability = new Uint8Array(rows.length * width);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    if (row.length !== width) throw new Error("ragged test grid");
    for (let x = 0; x < width; x++) {
      passability[y * width + x] = row[x] === "#" ? 0 : 1;
    }
  }
  return { passability, width };
}

const OPEN_4 = grid(["....", "....", "....", "...."]);

function waypointPairs(waypoints: Int16Array): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < waypoints.length; i += 2) {
    pairs.push([waypoints[i]!, waypoints[i + 1]!]);
  }
  return pairs;
}

describe("octile heuristic", () => {
  it("charges 1000 straight and 1414 per diagonal step", () => {
    expect(octileHeuristic(0, 0, 5, 0)).toBe(5 * PATH_STRAIGHT_COST);
    expect(octileHeuristic(0, 0, 0, 3)).toBe(3 * PATH_STRAIGHT_COST);
    expect(octileHeuristic(0, 0, 3, 3)).toBe(3 * PATH_DIAGONAL_COST);
    // Mixed: two diagonals plus one straight.
    expect(octileHeuristic(0, 0, 3, 2)).toBe(
      2 * PATH_DIAGONAL_COST + PATH_STRAIGHT_COST,
    );
  });
});

describe("findPath on hand-built grids", () => {
  it("pulls a straight run to exactly two waypoints", () => {
    const result = findPath({
      ...OPEN_4,
      startX: 0,
      startY: 1,
      goalX: 3,
      goalY: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.cost).toBe(3 * PATH_STRAIGHT_COST);
    expect(waypointPairs(result!.waypoints)).toEqual([
      [0, 1],
      [3, 1],
    ]);
  });

  it("charges exact diagonal cost and removes collinear points", () => {
    const result = findPath({
      ...OPEN_4,
      startX: 0,
      startY: 0,
      goalX: 3,
      goalY: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.cost).toBe(3 * PATH_DIAGONAL_COST);
    expect(waypointPairs(result!.waypoints)).toEqual([
      [0, 0],
      [3, 3],
    ]);
  });

  it("bends around an L-shaped wall at known optimal cost", () => {
    //   x0 x1 x2
    // y0 .  #  g
    // y1 .  #  .
    // y2 s  .  .
    const walls = grid([".#.", ".#.", "..."]);
    const result = findPath({
      ...walls,
      startX: 0,
      startY: 2,
      goalX: 2,
      goalY: 0,
    });
    expect(result).not.toBeNull();
    // Straight along the bottom row, then straight up the open column
    // (no legal diagonal exists past the wall): 4 × 1000 = 4000.
    expect(result!.cost).toBe(4000);
    expect(waypointPairs(result!.waypoints)).toEqual([
      [0, 2],
      [2, 2],
      [2, 0],
    ]);
  });

  it("never cuts diagonal corners between two blocked tiles", () => {
    //   x0 x1
    // y0 s  #
    // y1 #  g
    // The direct diagonal squeezes past a blocked corner — forbidden,
    // but no alternate route exists inside this 2×2 box, so the search
    // must report unreachability rather than cheat through.
    const pinch = grid([".#", "#."]);
    const result = findPath({
      ...pinch,
      startX: 0,
      startY: 0,
      goalX: 1,
      goalY: 1,
    });
    expect(result).toBeNull();
  });

  it("prefers the legal long way when corners are blocked", () => {
    //   x0 x1 x2
    // y0 s  #  g
    // y1 .  #  .
    // y2 .  .  .
    const detour = grid([".#.", ".#.", "..."]);
    const result = findPath({
      ...detour,
      startX: 0,
      startY: 0,
      goalX: 2,
      goalY: 0,
    });
    expect(result).not.toBeNull();
    // Every diagonal through the gap would cut a blocked corner, so the
    // optimum is six straight steps around the wall foot: 6 × 1000.
    expect(result!.cost).toBe(6000);
    expect(waypointPairs(result!.waypoints)).toEqual([
      [0, 0],
      [0, 2],
      [2, 2],
      [2, 0],
    ]);
  });

  it("returns null fast for unreachable goals", () => {
    const sealed = grid([".....", ".###.", ".#.#.", ".###.", "....."]);
    const startedAt = performance.now();
    const result = findPath({
      ...sealed,
      startX: 0,
      startY: 0,
      goalX: 2,
      goalY: 2,
    });
    expect(result).toBeNull();
    // Exhausting the whole reachable region must be effectively instant.
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("rejects impassable start or goal outright", () => {
    const walls = grid(["..", ".#"]);
    expect(
      findPath({ ...walls, startX: 1, startY: 1, goalX: 0, goalY: 0 }),
    ).toBeNull();
    expect(
      findPath({ ...walls, startX: 0, startY: 0, goalX: 1, goalY: 1 }),
    ).toBeNull();
  });

  it("returns the start tile alone with zero cost when already there", () => {
    const result = findPath({
      ...OPEN_4,
      startX: 2,
      startY: 2,
      goalX: 2,
      goalY: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.cost).toBe(0);
    expect(waypointPairs(result!.waypoints)).toEqual([[2, 2]]);
  });

  it("is deterministic across runs and independent of the reserved rng", () => {
    const request = { ...OPEN_4, startX: 0, startY: 0, goalX: 3, goalY: 1 };
    const plain = findPath(request);
    const seeded = findPath({ ...request, rng: createPrng(123456789) });
    const again = findPath({ ...request, rng: createPrng(123456789) });
    expect(plain).not.toBeNull();
    expect(seeded).not.toBeNull();
    expect(Array.from(seeded!.waypoints)).toEqual(Array.from(plain!.waypoints));
    expect(Array.from(again!.waypoints)).toEqual(Array.from(seeded!.waypoints));
    expect(again!.cost).toBe(plain!.cost);
  });

  it("throws on malformed grids or out-of-range coordinates", () => {
    const ragged = new Uint8Array(5); // not a multiple of width 3
    expect(() =>
      findPath({
        passability: ragged,
        width: 3,
        startX: 0,
        startY: 0,
        goalX: 1,
        goalY: 1,
      }),
    ).toThrow(/multiple of width/);
    expect(() =>
      findPath({ ...OPEN_4, startX: -1, startY: 0, goalX: 1, goalY: 1 }),
    ).toThrow(/out of range/);
    expect(() =>
      findPath({ ...OPEN_4, startX: 0, startY: 0, goalX: 4, goalY: 0 }),
    ).toThrow(/out of range/);
  });
});

describe("hasLineOfSight", () => {
  it("sees across open tiles along any slope", () => {
    expect(hasLineOfSight(OPEN_4.passability, OPEN_4.width, 0, 0, 3, 2)).toBe(
      true,
    );
  });

  it("is blocked by walls and by squeezed corners", () => {
    const walls = grid([".#.", ".#.", "..."]);
    expect(hasLineOfSight(walls.passability, walls.width, 0, 2, 2, 0)).toBe(
      false,
    );
    expect(hasLineOfSight(walls.passability, walls.width, 0, 2, 2, 2)).toBe(
      true,
    );
    const pinch = grid([".#", "#."]);
    expect(hasLineOfSight(pinch.passability, pinch.width, 0, 0, 1, 1)).toBe(
      false,
    );
  });
});

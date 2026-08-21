/**
 * Path engine tests — the pure worker-side request handler (M1-T5).
 *
 * The engine must be a pure function of its request contents
 * (ADR-0004): responses byte-identical to a direct astar search,
 * LRU-bounded cache invisible to results, and version-keyed so a
 * passability bump can never serve a stale route.
 */
import { describe, expect, it } from "vitest";
import { installSimPurityShims } from "../helpers/sim-purity-shims";
import { findPath } from "../../src/sim/path/astar";
import {
  PATH_CACHE_CAPACITY,
  createPathEngine,
} from "../../src/sim/path/engine";
import type { PathRequest } from "../../src/sim/path/protocol";

installSimPurityShims();

/** 8×8 open grid with a wall column at x=4 except rows 5–6. */
function wallGrid(): Uint8Array {
  const grid = new Uint8Array(64).fill(1);
  for (let y = 0; y < 8; y++) {
    if (y < 5) grid[y * 8 + 4] = 0;
  }
  return grid;
}

let nextId = 1;

function makeRequest(
  grid: Uint8Array,
  overrides: Partial<Omit<PathRequest, "kind" | "passable">> = {},
): PathRequest {
  const id = overrides.id ?? nextId++;
  return {
    kind: "path",
    id,
    dueTick: overrides.dueTick ?? id + 2,
    startX: overrides.startX ?? 1,
    startY: overrides.startY ?? 1,
    goalX: overrides.goalX ?? 6,
    goalY: overrides.goalY ?? 6,
    passable: grid,
    passableVersion: overrides.passableVersion ?? 0,
    seed: overrides.seed ?? 1234,
  };
}

describe("path engine purity", () => {
  it("returns exactly what a direct astar search returns", () => {
    const engine = createPathEngine();
    const grid = wallGrid();
    for (const [startX, startY, goalX, goalY] of [
      [1, 1, 6, 6],
      [2, 6, 7, 4],
      [3, 3, 5, 2],
    ] as const) {
      const response = engine.handle(
        makeRequest(grid, { startX, startY, goalX, goalY }),
      );
      const direct = findPath({
        passability: grid,
        width: 8,
        startX,
        startY,
        goalX,
        goalY,
      });
      expect(direct).not.toBeNull();
      expect(response.ok).toBe(true);
      expect([...response.waypoints]).toEqual([...direct!.waypoints]);
      expect(response.cost).toBe(direct!.cost);
    }
    // Every distinct start/goal pair computed fresh.
    expect(engine.cacheSize).toBe(3);
  });

  it("answers unreachable goals with ok:false and an empty waypoint list", () => {
    const engine = createPathEngine();
    const sealed = new Uint8Array(16);
    sealed[0] = 1; // single open tile: start exists, no route anywhere
    const response = engine.handle(
      makeRequest(sealed, { startX: 0, startY: 0, goalX: 3, goalY: 3 }),
    );
    expect(response.ok).toBe(false);
    expect(response.waypoints.length).toBe(0);
    expect(response.cost).toBe(0);
  });

  it("is deterministic across repeated identical requests", () => {
    const engine = createPathEngine();
    const grid = wallGrid();
    const first = engine.handle(makeRequest(grid, { id: 42 }));
    // Fresh engine, fresh cache: same bytes out.
    const second = createPathEngine().handle(makeRequest(grid, { id: 42 }));
    expect(second.id).toBe(first.id);
    expect([...second.waypoints]).toEqual([...first.waypoints]);
    expect(second.cost).toBe(first.cost);
  });
});

describe("path engine LRU cache", () => {
  it("caches by (goalTile, startTile, passabilityVersion) and refreshes on hits", () => {
    const engine = createPathEngine();
    const grid = wallGrid();

    const first = engine.handle(
      makeRequest(grid, { id: 77, startX: 2, startY: 5, seed: 999 }),
    );
    expect(engine.cacheSize).toBe(1);
    const hit = engine.handle(
      makeRequest(grid, { id: 88, startX: 2, startY: 5 }),
    );
    expect(engine.cacheSize).toBe(1); // served from cache
    expect(hit.id).toBe(88); // but still echoes THIS request's id
    expect([...hit.waypoints]).toEqual([...first.waypoints]);
    expect(hit.cost).toBe(first.cost);

    // A different start recomputes: routes are endpoint-specific.
    engine.handle(makeRequest(grid, { startX: 1, startY: 1 }));
    expect(engine.cacheSize).toBe(2);

    // A different goal tile adds its own entry too.
    engine.handle(
      makeRequest(grid, { startX: 1, startY: 1, goalX: 7, goalY: 0 }),
    );
    expect(engine.cacheSize).toBe(3);

    // A version bump invalidates: same endpoints recompute under v2.
    engine.handle(
      makeRequest(grid, {
        startX: 1,
        startY: 1,
        goalX: 7,
        goalY: 0,
        passableVersion: 1,
      }),
    );
    expect(engine.cacheSize).toBe(4);
  });

  it("evicts least-recently-used entries beyond capacity", () => {
    const engine = createPathEngine();
    const grid = new Uint8Array(1024).fill(1); // 32×32 open

    // Fill beyond capacity with 33 distinct goals (row 0, then row 1).
    for (let i = 0; i <= PATH_CACHE_CAPACITY; i++) {
      engine.handle(
        makeRequest(grid, {
          startX: 31,
          startY: 31,
          goalX: i % 32,
          goalY: Math.floor(i / 32),
        }),
      );
    }
    expect(engine.cacheSize).toBe(PATH_CACHE_CAPACITY);

    // Touching entry 0's goal again must recompute (it was evicted)
    // without growing past capacity.
    engine.handle(
      makeRequest(grid, { startX: 31, startY: 31, goalX: 0, goalY: 0 }),
    );
    expect(engine.cacheSize).toBe(PATH_CACHE_CAPACITY);
  });

  it("serves cached negative results too", () => {
    const engine = createPathEngine();
    const sealed = new Uint8Array(16);
    sealed[0] = 1;
    const miss = engine.handle(
      makeRequest(sealed, { startX: 0, startY: 0, goalX: 3, goalY: 3 }),
    );
    expect(miss.ok).toBe(false);
    expect(engine.cacheSize).toBe(1);
    const again = engine.handle(
      makeRequest(sealed, { startX: 0, startY: 0, goalX: 3, goalY: 3 }),
    );
    expect(again.ok).toBe(false);
    expect(engine.cacheSize).toBe(1);
  });
});

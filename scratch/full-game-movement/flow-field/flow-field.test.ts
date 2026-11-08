import { describe, expect, it } from "vitest";
import {
  findPath,
  PATH_DIAGONAL_COST,
  PATH_STRAIGHT_COST,
} from "../../../src/sim/path/astar";
import {
  buildFlowField,
  FlowFieldCache,
  FLOW_AT_GOAL,
  FLOW_DIAGONAL_COST,
  FLOW_DX,
  FLOW_DY,
  FLOW_STRAIGHT_COST,
  FLOW_UNREACHABLE,
  FLOW_UNREACHABLE_DIRECTION,
  type FlowTile,
} from "./flow-field";

interface Grid {
  readonly passability: Uint8Array;
  readonly width: number;
}

function grid(rows: readonly string[]): Grid {
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

function height(g: Grid): number {
  return g.passability.length / g.width;
}

function field(g: Grid, goals: readonly FlowTile[]) {
  return buildFlowField({ ...g, goals });
}

function expectRawRouteMatchesAStar(g: Grid, x: number, y: number, goal: FlowTile): void {
  const expected = findPath({ ...g, startX: x, startY: y, goalX: goal.x, goalY: goal.y });
  const flow = field(g, [goal]);
  const route = flow.traceRoute(x, y);
  if (expected === null) {
    expect(route).toBeNull();
    expect(flow.costAt(x, y)).toBe(FLOW_UNREACHABLE);
    return;
  }
  expect(route).not.toBeNull();
  expect(route!.cost).toBe(expected.cost);
  expect(flow.costAt(x, y)).toBe(expected.cost);
  expect(route!.tiles[0]).toBe(y * g.width + x);
  expect(route!.tiles[route!.tiles.length - 1]).toBe(goal.y * g.width + goal.x);
  let measured = 0;
  for (let i = 1; i < route!.tiles.length; i++) {
    const a = route!.tiles[i - 1]!;
    const b = route!.tiles[i]!;
    const ax = a % g.width;
    const ay = Math.floor(a / g.width);
    const bx = b % g.width;
    const by = Math.floor(b / g.width);
    const dx = bx - ax;
    const dy = by - ay;
    expect(Math.abs(dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(dy)).toBeLessThanOrEqual(1);
    expect(g.passability[b]).toBe(1);
    if (dx !== 0 && dy !== 0) {
      expect(g.passability[ay * g.width + bx]).toBe(1);
      expect(g.passability[by * g.width + ax]).toBe(1);
      measured += PATH_DIAGONAL_COST;
    } else {
      measured += PATH_STRAIGHT_COST;
    }
  }
  expect(measured).toBe(expected.cost);
}

describe("deterministic flow-field integration and routes", () => {
  it("matches production A* raw costs for every start on hand-built grids", () => {
    const grids = [
      grid(["....", "....", "....", "...."]),
      grid([".#.", ".#.", "..."]),
      grid([".....", ".###.", ".#.#.", ".###.", "....."]),
      grid(["....#", ".##..", "...#.", "##...", "....."]),
    ];
    const goals = [
      { x: 3, y: 1 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 4, y: 4 },
    ];
    for (let n = 0; n < grids.length; n++) {
      const g = grids[n]!;
      for (let y = 0; y < height(g); y++) {
        for (let x = 0; x < g.width; x++) {
          expectRawRouteMatchesAStar(g, x, y, goals[n]!);
        }
      }
    }
  });

  it("uses the exact integer costs and returns a zero-cost goal route", () => {
    expect(FLOW_STRAIGHT_COST).toBe(PATH_STRAIGHT_COST);
    expect(FLOW_DIAGONAL_COST).toBe(PATH_DIAGONAL_COST);
    const g = grid(["....", "....", "....", "...."]);
    const f = field(g, [{ x: 3, y: 3 }]);
    expect(f.costAt(0, 0)).toBe(3 * PATH_DIAGONAL_COST);
    expect(f.traceRoute(3, 3)).toEqual({ tiles: Int32Array.from([15]), cost: 0 });
    expect(f.directionAt(3, 3)).toBe(FLOW_AT_GOAL);
  });

  it("handles unreachable cells and blocked goals without fake directions", () => {
    const sealed = grid([".....", ".###.", ".#.#.", ".###.", "....."]);
    const inside = field(sealed, [{ x: 2, y: 2 }]);
    expect(inside.costAt(0, 0)).toBe(FLOW_UNREACHABLE);
    expect(inside.directionAt(0, 0)).toBe(FLOW_UNREACHABLE_DIRECTION);
    expect(inside.traceRoute(0, 0)).toBeNull();

    const blocked = field(sealed, [{ x: 1, y: 1 }]);
    expect(blocked.costAt(0, 0)).toBe(FLOW_UNREACHABLE);
    expect(blocked.traceRoute(0, 0)).toBeNull();
    expect(blocked.directionAt(1, 1)).toBe(FLOW_UNREACHABLE_DIRECTION);
  });

  it("never cuts a corner during integration or direction selection", () => {
    const pinch = grid([".#", "#."]);
    const f = field(pinch, [{ x: 1, y: 1 }]);
    expect(f.traceRoute(0, 0)).toBeNull();
    expect(f.costAt(0, 0)).toBe(FLOW_UNREACHABLE);

    const detour = grid([".#.", ".#.", "..."]);
    const around = field(detour, [{ x: 2, y: 0 }]);
    expect(around.costAt(0, 0)).toBe(6000);
    expectRawRouteMatchesAStar(detour, 0, 0, { x: 2, y: 0 });
  });

  it("supports multiple destinations and deterministic nearest-goal ties", () => {
    const g = grid([".....", ".....", "....."]);
    const f = field(g, [{ x: 0, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 1 }]);
    expect(f.costAt(2, 1)).toBe(2000);
    // East precedes west in the pinned clockwise direction order.
    expect(f.directionAt(2, 1)).toBe(0);
    const route = f.traceRoute(2, 1)!;
    expect(route.tiles[route.tiles.length - 1]).toBe(1 * g.width + 4);
    expect(f.costAt(0, 2)).toBe(1000);
    expect(f.costAt(4, 0)).toBe(1000);
  });

  it("ignores blocked members of a multi-goal set", () => {
    const g = grid([".....", ".....", "..#.."]);
    const f = field(g, [{ x: 2, y: 2 }, { x: 0, y: 0 }]);
    expect(f.costAt(1, 0)).toBe(1000);
    expect(f.directionAt(2, 2)).toBe(FLOW_UNREACHABLE_DIRECTION);
    expect(f.traceRoute(4, 2)!.cost).toBe(findPath({
      ...g, startX: 4, startY: 2, goalX: 0, goalY: 0,
    })!.cost);
  });

  it("is byte-for-byte deterministic across goal order and repeated builds", () => {
    const g = grid(["......", ".##...", "...#..", "......", "..##..", "......"]);
    const goals = [{ x: 5, y: 5 }, { x: 0, y: 5 }];
    const a = field(g, goals);
    const b = field(g, [...goals].reverse());
    const c = field(g, goals);
    expect(a.integration).toEqual(b.integration);
    expect(a.directions).toEqual(b.directions);
    expect(a.integration).toEqual(c.integration);
    expect(a.directions).toEqual(c.directions);
    expect(a.goals).toEqual(Int32Array.from([30, 35]));
  });
});

describe("passability revisions and shared-field caching", () => {
  it("reuses fields within a revision and invalidates on mutation", () => {
    const original = grid([".....", ".....", "..#..", ".....", "....."]);
    const cache = new FlowFieldCache(original.passability, original.width, 7, 2);
    const goals = [{ x: 4, y: 4 }];
    const first = cache.getField(goals);
    expect(cache.getField(goals)).toBe(first);
    expect(cache.getField([...goals, ...goals])).toBe(first);
    expect(first.revision).toBe(7);
    const oldCost = first.costAt(0, 4);

    const opened = original.passability.slice();
    opened[2 * original.width + 2] = 1;
    cache.updatePassability(opened, 8);
    const rebuilt = cache.getField(goals);
    expect(rebuilt).not.toBe(first);
    expect(cache.size).toBe(1);
    expect(rebuilt.revision).toBe(8);
    expect(rebuilt.costAt(0, 4)).toBeLessThanOrEqual(oldCost);
    expect(first.costAt(0, 4)).toBe(oldCost); // stale field is immutable

    // Constructor and update both snapshot caller-owned arrays.
    opened[0] = 0;
    expect(cache.getField(goals)).toBe(rebuilt);
    expect(rebuilt.costAt(0, 0)).not.toBe(FLOW_UNREACHABLE);
  });

  it("rebuilds connectivity after a blocking revision", () => {
    const g = grid(["...", "...", "..."]);
    const cache = new FlowFieldCache(g.passability, g.width);
    const goals = [{ x: 2, y: 2 }];
    expect(cache.getField(goals).traceRoute(0, 0)).not.toBeNull();
    const blocked = g.passability.slice();
    blocked[2] = 0;
    blocked[5] = 0;
    blocked[8] = 0;
    cache.updatePassability(blocked, 1);
    const f = cache.getField(goals);
    expect(f.directionAt(2, 2)).toBe(FLOW_UNREACHABLE_DIRECTION);
    expect(f.traceRoute(0, 0)).toBeNull();
  });

  it("rejects stale revisions and evicts the least recently used field", () => {
    const g = grid(["...", "..."]);
    const cache = new FlowFieldCache(g.passability, g.width, 1, 1);
    const a = cache.getField([{ x: 0, y: 0 }]);
    cache.getField([{ x: 2, y: 1 }]);
    expect(cache.size).toBe(1);
    expect(cache.getField([{ x: 0, y: 0 }])).not.toBe(a);
    expect(() => cache.updatePassability(g.passability, 1)).toThrow(/must increase/);
    expect(() => cache.updatePassability(g.passability, 0)).toThrow(/must increase/);
  });
});

describe("120x120 correctness", () => {
  it("matches A* costs and legal raw routes across open and obstacle maps", () => {
    for (const kind of ["open", "obstacles"] as const) {
      const width = 120;
      const passability = new Uint8Array(width * width).fill(1);
      if (kind === "obstacles") {
        for (let y = 0; y < width; y++) {
          for (let x = 0; x < width; x++) {
            if ((x % 17 === 8 && y % 23 !== 11) || (y % 29 === 14 && x % 31 !== 15)) {
              passability[y * width + x] = 0;
            }
          }
        }
      }
      const g = { passability, width };
      const goal = { x: 91, y: 87 };
      passability[goal.y * width + goal.x] = 1;
      const f = field(g, [goal]);
      for (let i = 0; i < 160; i++) {
        const x = (i * 47 + 3) % width;
        const y = (i * 71 + 9) % width;
        if (passability[y * width + x] !== 1) continue;
        const expected = findPath({ ...g, startX: x, startY: y, goalX: goal.x, goalY: goal.y });
        const route = f.traceRoute(x, y);
        if (expected === null) {
          expect(route).toBeNull();
        } else {
          expect(route).not.toBeNull();
          expect(route!.cost).toBe(expected.cost);
          let currentX = x;
          let currentY = y;
          for (let step = 0; step < route!.tiles.length - 1; step++) {
            const direction = f.directionAt(currentX, currentY);
            expect(direction).toBeGreaterThanOrEqual(0);
            currentX += FLOW_DX[direction]!;
            currentY += FLOW_DY[direction]!;
            expect(passability[currentY * width + currentX]).toBe(1);
          }
          expect([currentX, currentY]).toEqual([goal.x, goal.y]);
        }
      }
    }
  });
});

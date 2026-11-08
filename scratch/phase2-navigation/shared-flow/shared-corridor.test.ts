import { describe, expect, it } from "vitest";
import { hasLineOfSight } from "../../../src/sim/path/astar";
import type { PathRequest } from "../../../src/sim/path/protocol";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { ScenarioSpec } from "../../full-game-movement/harness/types";
import {
  canonicalRegionAnchor,
  createMockSharedCorridorCandidate,
  createSharedCorridorCandidate,
  SharedCorridorRouteEngine,
} from "./shared-corridor-candidate";

function request(
  id: number,
  passable: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  version = 0,
): PathRequest {
  return {
    kind: "path",
    id,
    dueTick: 2,
    startX,
    startY,
    goalX,
    goalY,
    passable,
    passableVersion: version,
    seed: 168,
  };
}

function expectLegalExactRoute(response: ReturnType<SharedCorridorRouteEngine["handle"]>, passable: Uint8Array, width: number, startX: number, startY: number, goalX: number, goalY: number): void {
  expect(response.ok).toBe(true);
  expect(Array.from(response.waypoints.slice(0, 2))).toEqual([startX, startY]);
  expect(Array.from(response.waypoints.slice(-2))).toEqual([goalX, goalY]);
  for (let index = 2; index < response.waypoints.length; index += 2) {
    expect(hasLineOfSight(
      passable,
      width,
      response.waypoints[index - 2]!,
      response.waypoints[index - 1]!,
      response.waypoints[index]!,
      response.waypoints[index + 1]!,
    )).toBe(true);
  }
}

function logicalDigest(run: ReturnType<typeof runBenchmark>) {
  return {
    milestones: run.milestones,
    completions: run.completions,
    diagnostics: run.movementDiagnostics,
    crowd: run.crowdStates,
    units: run.units,
    paths: run.pathRequests.map((entry) => ({
      id: entry.id,
      issueTick: entry.issueTick,
      applyTick: entry.applyTick,
      outcome: entry.outcome,
      ok: entry.ok,
      passableVersion: entry.passableVersion,
    })),
  };
}

describe("shared corridor exact-slot routes", () => {
  it("shares one region field across different exact goals without changing endpoints", () => {
    const width = 8;
    const passable = new Uint8Array(width * width).fill(1);
    const engine = new SharedCorridorRouteEngine();
    const first = engine.handle(request(1, passable, width, 0, 0, 7, 7), () => 0);
    const second = engine.handle(request(2, passable, width, 1, 0, 6, 7), () => 0);
    const third = engine.handle(request(3, passable, width, 0, 1, 7, 6), () => 0);
    expectLegalExactRoute(first, passable, width, 0, 0, 7, 7);
    expectLegalExactRoute(second, passable, width, 1, 0, 6, 7);
    expectLegalExactRoute(third, passable, width, 0, 1, 7, 6);
    expect(engine.metrics.fieldsBuilt).toBe(1);
    expect(engine.metrics.cacheMisses).toBe(1);
    expect(engine.metrics.cacheHits).toBe(2);
    expect(engine.metrics.localSearches).toBe(3);
    expect(engine.metrics.fullAstarFallbackSearches).toBe(0);
    expect(canonicalRegionAnchor(passable, width, 7, 7).anchor).toBe(7 * width + 7);
  });

  it("uses an explicit full A* fallback when the canonical anchor is disconnected", () => {
    const width = 7;
    const passable = new Uint8Array(width * width).fill(1);
    // Seal clamped region-center anchor (6,6); exact (0,0) remains reachable.
    const seal: readonly (readonly [number, number])[] = [[5, 5], [6, 5], [5, 6]];
    for (const [x, y] of seal) passable[y * width + x] = 0;
    const engine = new SharedCorridorRouteEngine();
    const response = engine.handle(request(1, passable, width, 6, 4, 0, 0), () => 0);
    expectLegalExactRoute(response, passable, width, 6, 4, 0, 0);
    expect(engine.metrics.directFallbacks).toBe(1);
    expect(engine.metrics.fullAstarFallbackSearches).toBe(1);
    expect(engine.metrics.localSearches).toBe(0);
  });

  it("preserves blocked-goal and disconnected-map no-path behavior", () => {
    const width = 5;
    const passable = new Uint8Array(width * width).fill(1);
    for (let y = 0; y < width; y += 1) passable[y * width + 2] = 0;
    const engine = new SharedCorridorRouteEngine();
    expect(engine.handle(request(1, passable, width, 0, 0, 4, 4), () => 0).ok).toBe(false);
    expect(engine.metrics.unreachableRoutes).toBe(1);
    const blocked = new Uint8Array(width * width).fill(1);
    blocked[4 * width + 4] = 0;
    expect(engine.handle(request(2, blocked, width, 0, 0, 4, 4, 1), () => 0).ok).toBe(false);
  });

  it("rejects diagonal corner cutting and preserves the legal exact detour", () => {
    const pinch = new Uint8Array([1, 0, 0, 1]);
    const pinched = new SharedCorridorRouteEngine();
    expect(pinched.handle(request(1, pinch, 2, 0, 0, 1, 1), () => 0).ok).toBe(false);

    const width = 3;
    const detour = new Uint8Array([1, 0, 1, 1, 0, 1, 1, 1, 1]);
    const engine = new SharedCorridorRouteEngine();
    const response = engine.handle(request(1, detour, width, 0, 0, 2, 0), () => 0);
    expectLegalExactRoute(response, detour, width, 0, 0, 2, 0);
    expect(response.cost).toBe(6000);
  });
});

describe("shared corridor revisions and full-game replay", () => {
  it("invalidates on revisions and never lets stale snapshots move the cache backward", () => {
    const width = 6;
    const open = new Uint8Array(width * width).fill(1);
    const engine = new SharedCorridorRouteEngine();
    const original = engine.handle(request(1, open, width, 0, 0, 5, 5, 0), () => 0);
    const changed = open.slice();
    changed[2 * width + 2] = 0;
    const revised = engine.handle(request(2, changed, width, 0, 0, 5, 5, 1), () => 0);
    expectLegalExactRoute(revised, changed, width, 0, 0, 5, 5);
    expect(engine.metrics.cacheInvalidations).toBe(1);
    expect(engine.metrics.fieldsBuilt).toBe(2);

    const stale = engine.handle(request(3, open, width, 0, 0, 5, 5, 0), () => 0);
    expect({ ...stale, id: original.id }).toEqual(original);
    expect(engine.metrics.staleSnapshotBuilds).toBe(1);
    expect(engine.metrics.fieldsBuilt).toBe(3);
    const current = engine.handle(request(4, changed, width, 0, 0, 5, 5, 1), () => 0);
    expect({ ...current, id: revised.id }).toEqual(revised);
    expect(engine.metrics.cacheHits).toBe(1);
    expect(engine.metrics.cacheInvalidations).toBe(1);
  });

  it("completes a real World.step single-unit route at the exact destination", () => {
    const base = scenarioByName("dense-open-120");
    const short: ScenarioSpec = {
      ...base,
      name: "test-shared-corridor-exact-120",
      ticks: 300,
      groups: [{ ...base.groups[0]!, spawn: { x: 78, y: 60, width: 1, height: 1 } }],
    };
    const run = runBenchmark({
      scenario: short,
      population: 1,
      ticks: 300,
      candidate: createSharedCorridorCandidate(),
      evidenceClass: "node-inline",
    });
    expect(run.completions.map((entry) => entry.outcome)).toEqual(["completed"]);
    expect(Math.abs(run.units[0]!.x - 80.5)).toBeLessThanOrEqual(0.08);
    expect(Math.abs(run.units[0]!.y - 60.5)).toBeLessThanOrEqual(0.08);
    expect(run.movementDiagnostics.groupMoves).toBe(1);
  }, 30_000);

  it("preserves mutation recovery and its own repeated/delayed deterministic state", () => {
    const config = {
      scenario: scenarioByName("narrow-mutation-120"),
      population: 40,
      ticks: 400,
    } as const;
    const first = runBenchmark({ ...config, candidate: createSharedCorridorCandidate(), evidenceClass: "node-inline" });
    const second = runBenchmark({ ...config, candidate: createSharedCorridorCandidate(), evidenceClass: "node-inline" });
    const mocked = runBenchmark({ ...config, candidate: createMockSharedCorridorCandidate(), evidenceClass: "node-mock-transport" });
    expect(first.mutations.at(-1)?.revisionAfter).toBe(6);
    expect(first.mutations.at(-1)?.firstRecoveryApplyTick).toBe(182);
    expect(first.pathRequests.filter((entry) => entry.outcome === "stale-discarded")).toHaveLength(2);
    expect(first.completions.filter((entry) => entry.outcome === "stale-cancelled")).toHaveLength(40);
    expect(first.scheduler.blockedTicks).toBe(0);
    expect(mocked.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(logicalDigest(second)).toEqual(logicalDigest(first));
    expect(logicalDigest(mocked)).toEqual(logicalDigest(first));
    expect(second.finalFullStateHash).toBe(first.finalFullStateHash);
    expect(mocked.finalFullStateHash).toBe(first.finalFullStateHash);
  }, 30_000);
});

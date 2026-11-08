import { beforeAll, describe, expect, it } from "vitest";
import { hasLineOfSight } from "../../../src/sim/path/astar";
import type { PathRequest } from "../../../src/sim/path/protocol";
import { createCurrentAstarCandidate } from "../harness/candidates";
import { runBenchmark } from "../harness/runner";
import { scenarioByName } from "../harness/scenarios";
import type { ScenarioSpec } from "../harness/types";
import {
  createMockRecastCandidate,
  createRecastCandidate,
  initializeRecast,
} from "./recast-candidate";
import { RecastRouteEngine } from "./recast-engine";

beforeAll(async () => {
  await initializeRecast();
}, 30_000);

function request(
  id: number,
  passable: Uint8Array,
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
    seed: 167,
  };
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

describe("Recast/Detour full-game integration", () => {
  it("runs the identical short scenario through A* and Recast to the exact goal", async () => {
    const base = scenarioByName("dense-open-120");
    const short: ScenarioSpec = {
      ...base,
      name: "test-recast-short-exact-120",
      ticks: 300,
      groups: [{ ...base.groups[0]!, spawn: { x: 78, y: 60, width: 1, height: 1 } }],
    };
    const astar = runBenchmark({
      scenario: short,
      population: 1,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "node-inline",
    });
    const recast = runBenchmark({
      scenario: short,
      population: 1,
      candidate: await createRecastCandidate(),
      evidenceClass: "node-inline",
    });
    for (const run of [astar, recast]) {
      expect(run.completions.map((entry) => entry.outcome)).toEqual(["completed"]);
      expect(Math.abs(run.units[0]!.x - 80.5)).toBeLessThanOrEqual(0.08);
      expect(Math.abs(run.units[0]!.y - 60.5)).toBeLessThanOrEqual(0.08);
      expect(run.movementDiagnostics.groupMoves).toBe(1);
      expect(run.pathRequests[0]?.issueToApplyTicks).toBe(2);
    }
    expect(recast.candidateMetrics.crowdAgentsCreated).toBe(0);
    expect(recast.candidateMetrics.revisionBuilds).toBe(1);
  }, 30_000);

  it("preserves sealed-map no-path behavior instead of accepting a projected goal", async () => {
    const base = scenarioByName("dense-open-120");
    const sealed: ScenarioSpec = {
      ...base,
      name: "test-recast-sealed-120",
      ticks: 10,
      map: { blocked: [{ x: 60, y: 0, width: 1, height: 120 }] },
    };
    const run = runBenchmark({
      scenario: sealed,
      population: 1,
      candidate: await createRecastCandidate(),
      evidenceClass: "node-inline",
    });
    expect(run.completions.map((entry) => entry.outcome)).toEqual(["no-path"]);
    expect(run.pathRequests[0]?.ok).toBe(false);
    expect(run.movementDiagnostics.groupMoves).toBe(0);
    expect(run.crowdStates.parkedNoActivity).toBe(1);
    expect(run.candidateMetrics.partialPathsRejected).toBeGreaterThan(0);
  }, 30_000);

  it("rejects corner cutting and returns only grid-valid exact-goal corridors", () => {
    const engine = new RecastRouteEngine();
    try {
      const diagonalOnly = new Uint8Array([
        1, 0, 1,
        0, 1, 1,
        1, 1, 1,
      ]);
      const corner = engine.handle(request(1, diagonalOnly, 0, 0, 1, 1), () => 0);
      expect(corner.ok).toBe(false);

      const width = 12;
      const oneTileGate = new Uint8Array(width * width).fill(1);
      for (let y = 0; y < width; y += 1) if (y !== 4) oneTileGate[y * width + 5] = 0;
      // Recast 0.43.0 rasterization does not connect this one-cell gap at
      // cs=0.5 even with radius zero; do not hide that semantic difference.
      expect(engine.handle(request(2, oneTileGate, 0, 4, 11, 4), () => 0).ok).toBe(false);

      const aroundWall = new Uint8Array(width * width).fill(1);
      for (let y = 0; y < width - 2; y += 1) aroundWall[y * width + 5] = 0;
      const route = engine.handle(request(2, aroundWall, 0, 0, 11, 0), () => 0);
      expect(route.ok).toBe(true);
      expect(Array.from(route.waypoints.slice(0, 2))).toEqual([0, 0]);
      expect(Array.from(route.waypoints.slice(-2))).toEqual([11, 0]);
      for (let index = 2; index < route.waypoints.length; index += 2) {
        expect(hasLineOfSight(
          aroundWall,
          width,
          route.waypoints[index - 2]!,
          route.waypoints[index - 1]!,
          route.waypoints[index]!,
          route.waypoints[index + 1]!,
        )).toBe(true);
      }
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("rebuilds exact snapshots across gate revisions and isolates version mismatches", () => {
    const engine = new RecastRouteEngine();
    const width = 12;
    const open = new Uint8Array(width * width).fill(1);
    for (let y = 0; y < width; y += 1) if (y !== 4 && y !== 5) open[y * width + 5] = 0;
    const closed = open.slice();
    closed[4 * width + 5] = 0;
    closed[5 * width + 5] = 0;
    try {
      const baseline = engine.handle(request(1, open, 0, 4, 11, 4, 0), () => 0);
      expect(baseline.ok).toBe(true);
      expect(engine.handle(request(2, closed, 0, 4, 11, 4, 1), () => 0).ok).toBe(false);
      const restored = engine.handle(request(3, open, 0, 4, 11, 4, 2), () => 0);
      expect(restored.ok).toBe(true);
      expect(restored.waypoints).toEqual(baseline.waypoints);
      expect(engine.metrics.revisionBuilds).toBe(3);

      // Same number, different bytes: query an ephemeral exact mesh rather
      // than silently reusing the revision-2 open mesh.
      expect(engine.handle(request(4, closed, 0, 4, 11, 4, 2), () => 0).ok).toBe(false);
      expect(engine.metrics.snapshotMismatches).toBe(1);
      expect(engine.metrics.ephemeralSnapshotBuilds).toBe(1);
      expect(engine.handle(request(5, open, 0, 4, 11, 4, 2), () => 0).waypoints).toEqual(baseline.waypoints);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("preserves stale cancellation, real building revisions, and recovery at tick 182", async () => {
    const run = runBenchmark({
      scenario: scenarioByName("narrow-mutation-120"),
      population: 40,
      candidate: await createRecastCandidate(),
      evidenceClass: "node-inline",
      ticks: 400,
    });
    expect(run.mutations.map((entry) => entry.kind)).toEqual(["terrain", "building", "terrain"]);
    expect(run.mutations.map((entry) => entry.revisionAfter)).toEqual([1, 5, 6]);
    expect(run.pathRequests.filter((entry) => entry.outcome === "stale-discarded")).toHaveLength(2);
    expect(run.completions.filter((entry) => entry.outcome === "stale-cancelled")).toHaveLength(40);
    expect(run.mutations.at(-1)?.firstRecoveryApplyTick).toBe(182);
    expect(run.completions.filter((entry) => entry.commandTick === 180 && entry.applyTick === 182)).toHaveLength(40);
    expect(run.candidateMetrics.revisionBuilds).toBe(2);
    expect(run.candidateMetrics.navmeshGenerationFailures).toBe(0);
    expect(run.candidateMetrics.geometryRejections).toBe(0);
  }, 30_000);

  it("matches its own repeated and delayed/out-of-order full-state replay", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const first = runBenchmark({ ...config, candidate: await createRecastCandidate(), evidenceClass: "node-inline" });
    const second = runBenchmark({ ...config, candidate: await createRecastCandidate(), evidenceClass: "node-inline" });
    const mocked = runBenchmark({
      ...config,
      candidate: await createMockRecastCandidate(),
      evidenceClass: "node-mock-transport",
    });
    expect(logicalDigest(second)).toEqual(logicalDigest(first));
    expect(logicalDigest(mocked)).toEqual(logicalDigest(first));
    expect(new Set([first.finalFullStateHash, second.finalFullStateHash, mocked.finalFullStateHash]).size).toBe(1);
    expect(mocked.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(first.scheduler.blockedTicks).toBe(0);
  }, 30_000);
});

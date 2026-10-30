import { beforeAll, describe, expect, it } from "vitest";
import { hasLineOfSight } from "../../../src/sim/path/astar";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import { RecastRouteEngine as FullRebuildEngine } from "../../phase2-navigation/recast-corridor/corridor-engine";
import {
  createMockRecastCandidate,
  createRecastCandidate,
  initializeRecast,
} from "./incremental-candidate";
import { RecastRouteEngine as IncrementalEngine } from "./incremental-engine";

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
  return { kind: "path", id, dueTick: 2, startX, startY, goalX, goalY, passable, passableVersion: version, seed: 169 };
}

function expectExactLegalRoute(response: PathResponse, passable: Uint8Array, width: number, input: PathRequest): void {
  expect(response.ok).toBe(true);
  expect(Array.from(response.waypoints.slice(0, 2))).toEqual([input.startX, input.startY]);
  expect(Array.from(response.waypoints.slice(-2))).toEqual([input.goalX, input.goalY]);
  for (let index = 0; index < response.waypoints.length; index += 2) {
    expect(passable[response.waypoints[index + 1]! * width + response.waypoints[index]!]).toBe(1);
    if (index > 0) {
      expect(hasLineOfSight(passable, width,
        response.waypoints[index - 2]!, response.waypoints[index - 1]!,
        response.waypoints[index]!, response.waypoints[index + 1]!)).toBe(true);
    }
  }
}

function compareWithFull(
  incremental: IncrementalEngine,
  full: FullRebuildEngine,
  input: PathRequest,
): PathResponse {
  const actual = incremental.handle(input, () => 0);
  const expected = full.handle(input, () => 0);
  expect(actual.ok).toBe(expected.ok);
  if (expected.ok) expectExactLegalRoute(actual, input.passable, Math.sqrt(input.passable.length), input);
  return actual;
}

function logicalDigest(run: ReturnType<typeof runBenchmark>) {
  return {
    milestones: run.milestones,
    completions: run.completions,
    diagnostics: run.movementDiagnostics,
    crowd: run.crowdStates,
    units: run.units,
    paths: run.pathRequests.map((entry) => ({
      id: entry.id, issueTick: entry.issueTick, applyTick: entry.applyTick,
      outcome: entry.outcome, ok: entry.ok, passableVersion: entry.passableVersion,
    })),
  };
}

describe("revision-acknowledged incremental TileCache", () => {
  it("matches full rebuild outcomes for one-/two-tile gates and repeated exact reopen", () => {
    const incremental = new IncrementalEngine();
    const full = new FullRebuildEngine();
    const width = 12;
    try {
      for (const gateHeight of [1, 2]) {
        const open = new Uint8Array(width * width).fill(1);
        for (let y = 0; y < width; y += 1) {
          if (y !== 4 && !(gateHeight === 2 && y === 5)) open[y * width + 5] = 0;
        }
        const closed = open.slice();
        for (let y = 4; y < 4 + gateHeight; y += 1) closed[y * width + 5] = 0;
        const versionBase = gateHeight === 1 ? 0 : 20;
        const baseline = compareWithFull(incremental, full, request(gateHeight * 100, open, 0, 4, 11, 4, versionBase));
        for (let cycle = 1; cycle <= 6; cycle += 1) {
          compareWithFull(incremental, full, request(gateHeight * 100 + cycle * 2 - 1, closed, 0, 4, 11, 4, versionBase + cycle * 2 - 1));
          const reopened = compareWithFull(incremental, full, request(gateHeight * 100 + cycle * 2, open, 0, 4, 11, 4, versionBase + cycle * 2));
          expect(reopened.waypoints).toEqual(baseline.waypoints);
        }
      }
      expect(incremental.metrics.confirmedIncrementalNoPaths).toBe(12);
      expect(incremental.candidateMetrics().incrementalBaseActive).toBe(true);
      expect(incremental.metrics.revisionVisibilityFailures).toBe(0);
      expect(incremental.metrics.geometryRejections).toBe(0);
      expect(incremental.metrics.revisionBarriersCompleted).toBe(26);
    } finally {
      incremental.dispose();
      full.dispose();
    }
  }, 30_000);

  it("matches full rebuild for building add/remove and multi-rectangle mutation bursts", () => {
    const incremental = new IncrementalEngine();
    const full = new FullRebuildEngine();
    const width = 40;
    const open = new Uint8Array(width * width).fill(1);
    try {
      compareWithFull(incremental, full, request(1, open, 0, 0, 39, 39, 0));
      const building = open.slice();
      for (let y = 8; y < 12; y += 1) for (let x = 8; x < 12; x += 1) building[y * width + x] = 0;
      compareWithFull(incremental, full, request(2, building, 0, 0, 39, 39, 1));
      const burst = building.slice();
      for (let y = 20; y < 24; y += 1) for (let x = 26; x < 30; x += 1) burst[y * width + x] = 0;
      for (let y = 30; y < 34; y += 1) for (let x = 4; x < 8; x += 1) burst[y * width + x] = 0;
      compareWithFull(incremental, full, request(3, burst, 0, 0, 39, 39, 2));
      compareWithFull(incremental, full, request(4, open, 0, 0, 39, 39, 3));
      expect(incremental.metrics.dynamicObstacleAdds).toBe(3);
      expect(incremental.metrics.dynamicObstacleRemoves).toBe(3);
      expect(incremental.metrics.mutationRebuilds).toBe(0);
      expect(incremental.metrics.guardedFallbacks).toBe(0);
    } finally {
      incremental.dispose();
      full.dispose();
    }
  }, 30_000);

  it("uses guarded exact rebuilds for stale/out-of-order and same-version snapshot mismatches", () => {
    const engine = new IncrementalEngine();
    const width = 12;
    const open = new Uint8Array(width * width).fill(1);
    const closed = open.slice();
    for (let y = 0; y < width; y += 1) closed[y * width + 5] = 0;
    try {
      expect(engine.handle(request(1, open, 0, 4, 11, 4, 0), () => 0).ok).toBe(true);
      expect(engine.handle(request(2, closed, 0, 4, 11, 4, 1), () => 0).ok).toBe(false);
      expect(engine.handle(request(3, open, 0, 4, 11, 4, 2), () => 0).ok).toBe(true);
      expect(engine.handle(request(4, closed, 0, 4, 11, 4, 1), () => 0).ok).toBe(false);
      expect(engine.metrics.outOfOrderRebuilds).toBe(1);
      expect(engine.handle(request(5, closed, 0, 4, 11, 4, 2), () => 0).ok).toBe(false);
      expect(engine.metrics.snapshotMismatchRebuilds).toBe(1);
      expect(engine.handle(request(6, open, 0, 4, 11, 4, 2), () => 0).ok).toBe(true);
      expect(engine.metrics.revisionVisibilityFailures).toBe(0);
      expect(engine.metrics.ephemeralSnapshotBuilds).toBe(3);
      expect(engine.metrics.confirmedIncrementalNoPaths).toBe(1);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("drains large multi-tile updates before acknowledging the visible revision", () => {
    const engine = new IncrementalEngine();
    const width = 120;
    const open = new Uint8Array(width * width).fill(1);
    const blocked = open.slice();
    for (let y = 8; y < 112; y += 1) for (let x = 8; x < 112; x += 1) blocked[y * width + x] = 0;
    const full = new FullRebuildEngine();
    try {
      compareWithFull(engine, full, request(1, open, 0, 0, 119, 119, 0));
      const response = engine.handle(request(2, blocked, 0, 0, 119, 119, 1), () => 0);
      expectExactLegalRoute(response, blocked, width, request(2, blocked, 0, 0, 119, 119, 1));
      expect(engine.metrics.maxUpdateCallsPerRevision).toBeGreaterThan(1);
      expect(engine.metrics.maxNavTilesTouchedPerRevision).toBeGreaterThan(64);
      expect(engine.metrics.lastAcknowledgedRevision).toBe(1);
      expect(engine.candidateMetrics().visibleRevision).toBe(1);
      expect(engine.metrics.geometryFallbacks).toBe(1);
      compareWithFull(engine, full, request(3, open, 0, 0, 119, 119, 2));
      expect(engine.metrics.incrementalRevisions).toBe(3);
      expect(engine.metrics.nonIncrementalBaseFallbacks).toBe(0);
      expect(engine.candidateMetrics().visibleRevision).toBe(2);
    } finally {
      engine.dispose();
      full.dispose();
    }
  }, 30_000);

  it("reports >512 live obstacles and falls back to an exact full rebuild", () => {
    const incremental = new IncrementalEngine();
    const full = new FullRebuildEngine();
    const width = 48;
    const passable = new Uint8Array(width * width).fill(1);
    for (let y = 1; y < width; y += 2) for (let x = 1; x < width; x += 2) passable[y * width + x] = 0;
    try {
      compareWithFull(incremental, full, request(1, passable, 0, 0, 47, 46, 0));
      expect(incremental.metrics.obstacleCapacityFailures).toBeGreaterThan(0);
      expect(incremental.metrics.capacityFallbacks).toBe(1);
      expect(incremental.metrics.guardedFallbacks).toBe(1);
      expect(incremental.candidateMetrics().incrementalBaseActive).toBe(false);
      expect(incremental.candidateMetrics().liveObstacles).toBe(0);
      expect(incremental.metrics.revisionVisibilityFailures).toBe(0);
    } finally {
      incremental.dispose();
      full.dispose();
    }
  }, 30_000);

  it("preserves production stale cancellation, due-tick recovery, and exact gate visibility", async () => {
    const run = runBenchmark({
      scenario: scenarioByName("narrow-mutation-120"), population: 40,
      candidate: await createRecastCandidate(), evidenceClass: "node-inline", ticks: 400,
    });
    expect(run.mutations.map((entry) => entry.revisionAfter)).toEqual([1, 5, 6]);
    expect(run.pathRequests.filter((entry) => entry.outcome === "stale-discarded")).toHaveLength(2);
    expect(run.completions.filter((entry) => entry.outcome === "stale-cancelled")).toHaveLength(40);
    expect(run.mutations.at(-1)?.firstRecoveryApplyTick).toBe(182);
    expect(run.pathRequests.filter((entry) => entry.outcome === "applied").every((entry) => entry.issueToApplyTicks === 2)).toBe(true);
    expect(run.candidateMetrics.geometryRejections).toBe(run.candidateMetrics.geometryFallbacks);
    expect(run.candidateMetrics.revisionVisibilityFailures).toBe(0);
  }, 30_000);

  it("matches repeated and delayed/out-of-order logical state and hashes", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const first = runBenchmark({ ...config, candidate: await createRecastCandidate(), evidenceClass: "node-inline" });
    const second = runBenchmark({ ...config, candidate: await createRecastCandidate(), evidenceClass: "node-inline" });
    const mocked = runBenchmark({ ...config, candidate: await createMockRecastCandidate(), evidenceClass: "node-mock-transport" });
    expect(logicalDigest(second)).toEqual(logicalDigest(first));
    expect(logicalDigest(mocked)).toEqual(logicalDigest(first));
    expect(new Set([first.finalFullStateHash, second.finalFullStateHash, mocked.finalFullStateHash]).size).toBe(1);
    expect(mocked.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(first.scheduler.blockedTicks).toBe(0);
  }, 30_000);
});

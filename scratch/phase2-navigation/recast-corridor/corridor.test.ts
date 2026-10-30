import { beforeAll, describe, expect, it } from "vitest";
import { hasLineOfSight } from "../../../src/sim/path/astar";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import {
  createMockRecastCandidate,
  createRecastCandidate,
  initializeRecast,
} from "./corridor-candidate";
import { RecastRouteEngine } from "./corridor-engine";
import { convertCorridorToGrid } from "./corridor-grid";

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
    seed: 168,
  };
}

function expectExactLegalRoute(response: PathResponse, passable: Uint8Array, width: number, request: PathRequest): void {
  expect(response.ok).toBe(true);
  expect(Array.from(response.waypoints.slice(0, 2))).toEqual([request.startX, request.startY]);
  expect(Array.from(response.waypoints.slice(-2))).toEqual([request.goalX, request.goalY]);
  for (let index = 0; index < response.waypoints.length; index += 2) {
    expect(passable[response.waypoints[index + 1]! * width + response.waypoints[index]!]).toBe(1);
    if (index > 0) {
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

describe("Recast corridor supercover gate prototype", () => {
  it("preserves one- and two-tile gates with exact legal endpoints", () => {
    const engine = new RecastRouteEngine();
    const width = 12;
    try {
      for (const gateHeight of [1, 2]) {
        const passable = new Uint8Array(width * width).fill(1);
        for (let y = 0; y < width; y += 1) {
          if (y !== 4 && !(gateHeight === 2 && y === 5)) passable[y * width + 5] = 0;
        }
        const input = request(gateHeight, passable, 0, 4, 11, 4);
        const response = engine.handle(input, () => 0);
        expectExactLegalRoute(response, passable, width, input);
      }
      expect(engine.metrics.geometryRejections).toBe(0);
      expect(engine.metrics.partialPathsRejected).toBe(0);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("arrives at the exact production Activity destination through World.step", async () => {
    const base = scenarioByName("dense-open-120");
    const short = {
      ...base,
      name: "test-corridor-exact-120",
      ticks: 300,
      groups: [{ ...base.groups[0]!, spawn: { x: 78, y: 60, width: 1, height: 1 } }],
    };
    const run = runBenchmark({
      scenario: short,
      population: 1,
      candidate: await createRecastCandidate(),
      evidenceClass: "node-inline",
    });
    expect(run.completions.map((entry) => entry.outcome)).toEqual(["completed"]);
    expect(Math.abs(run.units[0]!.x - 80.5)).toBeLessThanOrEqual(0.08);
    expect(Math.abs(run.units[0]!.y - 60.5)).toBeLessThanOrEqual(0.08);
    expect(run.movementDiagnostics.groupMoves).toBe(1);
    expect(run.pathRequests[0]?.issueToApplyTicks).toBe(2);
  }, 30_000);

  it("supercovers shallow float segments instead of flooring isolated portals", () => {
    const width = 12;
    const passable = new Uint8Array(width * width).fill(1);
    const waypoints = convertCorridorToGrid(
      [{ x: 0.5, z: 0.5 }, { x: 4.95, z: 1.05 }, { x: 10.5, z: 2.5 }],
      passable,
      width,
      0,
      0,
      10,
      2,
    );
    expect(waypoints).not.toBeNull();
    expect(Array.from(waypoints!.slice(0, 2))).toEqual([0, 0]);
    expect(Array.from(waypoints!.slice(-2))).toEqual([10, 2]);
    for (let index = 2; index < waypoints!.length; index += 2) {
      expect(hasLineOfSight(passable, width, waypoints![index - 2]!, waypoints![index - 1]!, waypoints![index]!, waypoints![index + 1]!)).toBe(true);
    }

    const blocked = passable.slice();
    blocked[3 * width + 3] = 0;
    expect(convertCorridorToGrid(
      [{ x: 0.5, z: 0.5 }, { x: 10.5, z: 10.5 }],
      blocked,
      width,
      0,
      0,
      10,
      10,
    )).toBeNull();
  });

  it("keeps exact goals, rejects unreachable or impassable goals, and forbids corner cutting", () => {
    const engine = new RecastRouteEngine();
    const width = 12;
    const open = new Uint8Array(width * width).fill(1);
    try {
      const exact = request(1, open, 1, 1, 10, 8);
      expectExactLegalRoute(engine.handle(exact, () => 0), open, width, exact);
      const sealed = open.slice();
      for (let y = 0; y < width; y += 1) sealed[y * width + 5] = 0;
      expect(engine.handle(request(2, sealed, 0, 4, 11, 4), () => 0).ok).toBe(false);
      const impassable = open.slice();
      impassable[8 * width + 10] = 0;
      expect(engine.handle(request(3, impassable, 1, 1, 10, 8), () => 0).ok).toBe(false);
      const diagonalOnly = new Uint8Array([
        1, 0, 1,
        0, 1, 1,
        1, 1, 1,
      ]);
      expect(engine.handle(request(4, diagonalOnly, 0, 0, 1, 1), () => 0).ok).toBe(false);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("rebuilds narrow gates across close/reopen mutations and isolates snapshot mismatches", () => {
    const engine = new RecastRouteEngine();
    const width = 12;
    const open = new Uint8Array(width * width).fill(1);
    for (let y = 0; y < width; y += 1) if (y !== 4) open[y * width + 5] = 0;
    const closed = open.slice();
    closed[4 * width + 5] = 0;
    try {
      const baseline = engine.handle(request(1, open, 0, 4, 11, 4, 0), () => 0);
      expect(baseline.ok).toBe(true);
      expect(engine.handle(request(2, closed, 0, 4, 11, 4, 1), () => 0).ok).toBe(false);
      const restored = engine.handle(request(3, open, 0, 4, 11, 4, 2), () => 0);
      expect(restored.waypoints).toEqual(baseline.waypoints);
      expect(engine.handle(request(4, closed, 0, 4, 11, 4, 2), () => 0).ok).toBe(false);
      expect(engine.metrics.snapshotMismatches).toBe(1);
      expect(engine.metrics.ephemeralSnapshotBuilds).toBe(1);
      expect(engine.metrics.revisionBuilds).toBe(4);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it("preserves production narrow mutations, stale cancellation, due ticks, and tick-182 recovery", async () => {
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
    expect(run.pathRequests.filter((entry) => entry.outcome === "applied").every((entry) => entry.issueToApplyTicks === 2)).toBe(true);
    expect(run.candidateMetrics.geometryRejections).toBe(0);
    expect(run.candidateMetrics.crowdAgentsCreated).toBe(0);
  }, 30_000);

  it("matches repeated and delayed/out-of-order logical state and full-state hashes", async () => {
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

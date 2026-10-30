import { describe, expect, it } from "vitest";
import type { PathRequest } from "../../../../src/sim/path/protocol";
import { createCurrentAstarCandidate } from "../candidates";
import { runBenchmark } from "../runner";
import { scenarioByName } from "../scenarios";
import type { ScenarioSpec } from "../types";
import {
  createFlowFieldCandidate,
  createMockFlowFieldCandidate,
  FlowFieldRouteEngine,
} from "./flow-candidate";

function logicalDigest(run: ReturnType<typeof runBenchmark>) {
  return {
    milestones: run.milestones,
    completions: run.completions,
    diagnostics: run.movementDiagnostics,
    crowd: run.crowdStates,
    units: run.units,
    paths: run.pathRequests.map((request) => ({
      id: request.id,
      issueTick: request.issueTick,
      applyTick: request.applyTick,
      outcome: request.outcome,
      ok: request.ok,
      passableVersion: request.passableVersion,
    })),
  };
}

function request(id: number, passable: Uint8Array, goalX: number, goalY: number, version = 0): PathRequest {
  return {
    kind: "path",
    id,
    dueTick: 2,
    startX: 0,
    startY: 0,
    goalX,
    goalY,
    passable,
    passableVersion: version,
    seed: 167,
  };
}

describe("flow-field full-game integration", () => {
  it("runs the identical single-unit scenario through A* and flow to the exact goal", () => {
    const base = scenarioByName("dense-open-120");
    const short: ScenarioSpec = {
      ...base,
      name: "test-short-exact-120",
      ticks: 300,
      groups: [{ ...base.groups[0]!, spawn: { x: 78, y: 60, width: 1, height: 1 } }],
    };
    const config = { scenario: short, population: 1, ticks: 300 } as const;
    const astar = runBenchmark({ ...config, candidate: createCurrentAstarCandidate(), evidenceClass: "node-inline" });
    const flow = runBenchmark({ ...config, candidate: createFlowFieldCandidate(), evidenceClass: "node-inline" });
    for (const run of [astar, flow]) {
      expect(run.completions.map((entry) => entry.outcome)).toEqual(["completed"]);
      expect(Math.abs(run.units[0]!.x - 80.5)).toBeLessThanOrEqual(0.08);
      expect(Math.abs(run.units[0]!.y - 60.5)).toBeLessThanOrEqual(0.08);
      expect(run.movementDiagnostics.groupMoves).toBe(1);
    }
    expect(flow.candidateMetrics.fieldsBuilt).toBe(1);
    expect(flow.candidateMetrics.cacheMisses).toBe(1);
    expect(flow.candidateMetrics.cacheHits).toBe(flow.pathRequests.length - 1);
    expect(flow.candidateMetrics.cachedFieldBytes).toBe(72_000);
  }, 30_000);

  it("preserves unreachable/no-path behavior on the same sealed map", () => {
    const base = scenarioByName("dense-open-120");
    const sealed: ScenarioSpec = {
      ...base,
      name: "test-sealed-120",
      ticks: 10,
      map: { blocked: [{ x: 60, y: 0, width: 1, height: 120 }] },
    };
    for (const candidate of [createCurrentAstarCandidate(), createFlowFieldCandidate()]) {
      const run = runBenchmark({ scenario: sealed, population: 1, candidate, evidenceClass: "node-inline" });
      expect(run.completions.map((entry) => entry.outcome)).toEqual(["no-path"]);
      expect(run.pathRequests[0]?.ok).toBe(false);
      expect(run.movementDiagnostics.groupMoves).toBe(0);
      expect(run.crowdStates.parkedNoActivity).toBe(1);
    }
  });

  it("returns exact-goal and unreachable routes and rebuilds after revision", () => {
    const engine = new FlowFieldRouteEngine();
    const open = new Uint8Array(9).fill(1);
    const first = engine.handle(request(1, open, 2, 2), () => 0);
    expect(first.ok).toBe(true);
    expect(Array.from(first.waypoints.slice(-2))).toEqual([2, 2]);
    expect(first.cost).toBe(2828);
    const second = engine.handle(request(2, open, 2, 2), () => 0);
    expect(second.waypoints).toEqual(first.waypoints);
    expect(engine.metrics.cacheHits).toBe(1);
    expect(engine.metrics.fieldsBuilt).toBe(1);

    const sealed = new Uint8Array([
      1, 1, 1,
      1, 0, 1,
      1, 1, 1,
    ]);
    expect(engine.handle(request(3, sealed, 1, 1, 1), () => 0).ok).toBe(false);
    expect(engine.metrics.cacheInvalidations).toBe(1);
    expect(engine.metrics.unreachableRoutes).toBe(1);
  });

  it("preserves stale group cancellation, revisions, and mutation recovery", () => {
    const run = runBenchmark({
      scenario: scenarioByName("narrow-mutation-120"),
      population: 40,
      candidate: createFlowFieldCandidate(),
      evidenceClass: "node-inline",
      ticks: 400,
    });
    expect(run.mutations.map((entry) => entry.kind)).toEqual(["terrain", "building", "terrain"]);
    expect(run.mutations.at(-1)?.revisionAfter).toBe(6);
    expect(run.pathRequests.filter((request) => request.outcome === "stale-discarded")).toHaveLength(2);
    expect(run.completions.filter((entry) => entry.outcome === "stale-cancelled")).toHaveLength(40);
    expect(run.mutations.at(-1)?.firstRecoveryApplyTick).toBe(182);
    expect(run.candidateMetrics.cacheInvalidations).toBe(1);
    // Two leader destinations plus one field per distinct stall-repath slot.
    expect(run.candidateMetrics.fieldsBuilt).toBeGreaterThan(4);
    expect(run.candidateMetrics.fieldsBuilt).toBeLessThanOrEqual(42);
    expect(run.candidateMetrics.cacheMisses).toBe(run.candidateMetrics.fieldsBuilt);
    expect(run.candidateMetrics.cacheHits).toBeGreaterThan(0);
  }, 30_000);

  it("matches its own repeated and delayed/out-of-order full-state replay", () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const first = runBenchmark({ ...config, candidate: createFlowFieldCandidate(), evidenceClass: "node-inline" });
    const second = runBenchmark({ ...config, candidate: createFlowFieldCandidate(), evidenceClass: "node-inline" });
    const mocked = runBenchmark({ ...config, candidate: createMockFlowFieldCandidate(), evidenceClass: "node-mock-transport" });
    expect(logicalDigest(second)).toEqual(logicalDigest(first));
    expect(logicalDigest(mocked)).toEqual(logicalDigest(first));
    expect(mocked.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(first.scheduler.blockedTicks).toBe(0);
  }, 30_000);
});

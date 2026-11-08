import { describe, expect, it } from "vitest";
import { createCurrentAstarCandidate, createMockAstarCandidate } from "./candidates";
import { runBenchmark } from "./runner";
import { scenarioByName } from "./scenarios";

function logicalDigest(run: ReturnType<typeof runBenchmark>) {
  return {
    milestones: run.milestones,
    completions: run.completions,
    diagnostics: run.movementDiagnostics,
    crowd: run.crowdStates,
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

describe("full-game movement harness", () => {
  it("runs actual Activity/movement loops and measures command completion", () => {
    const run = runBenchmark({
      scenario: scenarioByName("dense-open-120"),
      population: 32,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "node-inline",
      ticks: 3600,
    });
    expect(run.finalTick).toBe(3600);
    expect(run.initialMapHash).toMatch(/^fnv1a64:/);
    expect(run.pathRequests.length).toBeGreaterThanOrEqual(1);
    expect(run.pathRequests[0]?.issueToApplyTicks).toBe(2);
    expect(run.pathRequests[0]?.applyCostMs).toBeGreaterThanOrEqual(0);
    const completed = run.completions.filter((entry) => entry.outcome === "completed");
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.every((entry) => (entry.completionTick ?? 0) >= (entry.applyTick ?? 0))).toBe(true);
    expect(run.crowdStates.completed).toBe(completed.length);
    expect(Object.values(run.crowdStates).reduce((sum, count) => sum + count, 0)).toBe(32);
  }, 30_000);

  it("matches repeated full-state hashes under delayed/out-of-order mock transport", () => {
    const config = {
      scenario: scenarioByName("narrow-mutation-120"),
      population: 40,
      ticks: 400,
    } as const;
    const first = runBenchmark({ ...config, candidate: createCurrentAstarCandidate(), evidenceClass: "node-inline" });
    const second = runBenchmark({ ...config, candidate: createCurrentAstarCandidate(), evidenceClass: "node-inline" });
    const mocked = runBenchmark({ ...config, candidate: createMockAstarCandidate(), evidenceClass: "node-mock-transport" });
    expect(logicalDigest(second)).toEqual(logicalDigest(first));
    expect(logicalDigest(mocked)).toEqual(logicalDigest(first));
    expect(mocked.evidenceClass).toBe("node-mock-transport");
    expect(mocked.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(first.scheduler.blockedTicks).toBe(0);
  }, 30_000);

  it("records stale group cancellation, mutation revisions, and recovery", () => {
    const run = runBenchmark({
      scenario: scenarioByName("narrow-mutation-120"),
      population: 40,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "node-inline",
      ticks: 400,
    });
    expect(run.mutations.map((entry) => entry.kind)).toEqual(["terrain", "building", "terrain"]);
    expect(run.mutations.at(-1)?.revisionAfter).toBe(6);
    expect(run.pathRequests.filter((request) => request.outcome === "stale-discarded")).toHaveLength(2);
    expect(run.completions.filter((entry) => entry.outcome === "stale-cancelled")).toHaveLength(40);
    expect(run.mutations.at(-1)?.firstRecoveryApplyTick).toBe(182);
    expect(run.completions.filter((entry) => entry.commandTick === 180 && entry.applyTick === 182)).toHaveLength(40);
  }, 30_000);

  it("smokes opposing flows and mixed destinations with real path application", () => {
    for (const [name, population, requests] of [["opposing-open-120", 64, 2], ["mixed-destinations-120", 80, 8]] as const) {
      const run = runBenchmark({
        scenario: scenarioByName(name),
        population,
        candidate: createCurrentAstarCandidate(),
        evidenceClass: "node-inline",
        ticks: 240,
      });
      expect(run.movementDiagnostics.groupMoves).toBe(requests);
      expect(run.pathRequests.filter((request) => request.commandTick !== undefined && request.outcome === "applied")).toHaveLength(requests);
      expect(run.completions).toHaveLength(population);
      expect(run.crowdStates.moving + run.crowdStates.stalled + run.crowdStates.propagatedParked).toBeGreaterThan(0);
    }
  }, 30_000);
});

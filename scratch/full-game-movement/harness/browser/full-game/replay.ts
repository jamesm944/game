import type { BenchmarkResult } from "../../types";

/** Logical replay surface: no wall timings, response frames, or queue samples. */
export function logicalBenchmark(result: BenchmarkResult) {
  return {
    scenario: result.scenario.name,
    population: result.population,
    finalTick: result.finalTick,
    initialMapHash: result.initialMapHash,
    finalMapHash: result.finalMapHash,
    finalWorldDigest: result.finalWorldDigest,
    finalFullStateHash: result.finalFullStateHash,
    milestones: result.milestones,
    completions: result.completions,
    units: result.units,
    crowdStates: result.crowdStates,
    movementDiagnostics: result.movementDiagnostics,
    mutations: result.mutations,
    paths: result.pathRequests.map((request) => ({
      id: request.id,
      issueTick: request.issueTick,
      dueTick: request.dueTick,
      applyTick: request.applyTick,
      issueToApplyTicks: request.issueToApplyTicks,
      outcome: request.outcome,
      ok: request.ok,
      passableVersion: request.passableVersion,
      commandTick: request.commandTick,
    })),
  };
}

export function logicalBenchmarkString(result: BenchmarkResult): string {
  return JSON.stringify(logicalBenchmark(result));
}

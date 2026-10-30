import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import scenarioFixtures from "../../full-game-movement/harness/fixtures/scenarios.json";
import { logicalBenchmark, logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { BenchmarkResult, ScenarioSpec } from "../../full-game-movement/harness/types";
import { createLocalQueueWorkerFactory, createQueueAstarCandidate } from "./adapter";
import { runBenchmarkAsync } from "./runner";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const scenario = (scenarioFixtures as ScenarioSpec[]).find((entry) => entry.name === "narrow-mutation-120")!;
const reference = await runBenchmarkAsync({
  scenario, population: 1000, ticks: 3600,
  candidate: createQueueAstarCandidate("fifo", createLocalQueueWorkerFactory()),
  evidenceClass: "node-mock-transport", omitComputeMs: false,
});
function simulationLogical(result: BenchmarkResult) {
  const logical = logicalBenchmark(result);
  return {
    ...logical,
    // Response availability for a still-pending request is transport telemetry,
    // not simulation state. No pending response has reached the apply/discard seam.
    paths: logical.paths.map((request) => {
      if (request.outcome !== "pending") return request;
      const { ok: _unobservedResponse, ...settled } = request;
      return settled;
    }),
  };
}
const referenceRawLogical = logicalBenchmarkString(reference);
const referenceLogical = JSON.stringify(simulationLogical(reference));
const referenceProjection = simulationLogical(reference) as unknown as Record<string, unknown>;
const referenceRawProjection = logicalBenchmark(reference) as unknown as Record<string, unknown>;

function differences(actual: unknown, expected: unknown, at = "$"): Array<{ path: string; browser: unknown; node: unknown }> {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return [{ path: `${at}.length`, browser: actual.length, node: expected.length }];
    for (let index = 0; index < actual.length; index += 1) {
      const found = differences(actual[index], expected[index], `${at}[${index}]`);
      if (found.length > 0) return found;
    }
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual) && !Array.isArray(expected)) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(e)])].sort()) {
      const found = differences(a[key], e[key], `${at}.${key}`);
      if (found.length > 0) return found;
    }
  }
  return [{ path: at, browser: actual, node: expected }];
}

const comparisons = [];
for (const policy of ["fifo", "batch-32"]) {
  for (const iteration of [1, 2, 3, 4, 5]) {
    const file = `chrome-${policy}-iteration-${iteration}.json`;
    const run = JSON.parse(await readFile(path.join(ROOT, "results", file), "utf8")) as { samples: BenchmarkResult[]; logical: string; warmupTicks: number };
    if (run.samples.length !== 1) throw new Error(`${file}: expected one sample`);
    const sample = run.samples[0]!;
    const rawLogical = logicalBenchmarkString(sample);
    const logicalEqual = JSON.stringify(simulationLogical(sample)) === referenceLogical;
    const rawLogicalProjectionEqual = rawLogical === referenceRawLogical;
    comparisons.push({
      policy, iteration, file,
      logicalEqual,
      rawLogicalProjectionEqual,
      storedLogicalProjectionEqual: run.logical === rawLogical,
      finalFullStateHashEqual: sample.finalFullStateHash === reference.finalFullStateHash,
      applicationTicksValid: sample.pathRequests.filter((request) => request.applyTick !== undefined).every((request) => request.issueToApplyTicks === 2),
      appliedOrDiscardedRequests: sample.pathRequests.filter((request) => request.applyTick !== undefined).length,
      browserFinalFullStateHash: sample.finalFullStateHash,
      nodeFinalFullStateHash: reference.finalFullStateHash,
      logicalDifferences: logicalEqual ? [] : differences(simulationLogical(sample), referenceProjection),
      rawLogicalDifferences: rawLogicalProjectionEqual ? [] : differences(logicalBenchmark(sample), referenceRawProjection),
    });
  }
}
const output = {
  schema: "wayfinder-172-replay-v3", generatedAt: new Date().toISOString(),
  pendingResponsePolicy: "simulation comparison omits ok only for pending, unapplied requests; raw comparison retains and reports it",
  reference: {
    engine: "preserved production Node A* through clean handle scheduler and local FIFO worker",
    finalTick: reference.finalTick, finalFullStateHash: reference.finalFullStateHash,
    finalWorldDigest: reference.finalWorldDigest, finalMapHash: reference.finalMapHash,
    pathRequests: reference.pathRequests.length, workloadComposition: reference.workloadComposition,
    crowdStates: reference.crowdStates,
  },
  allLogicalEqual: comparisons.every((entry) => entry.logicalEqual),
  allRawLogicalProjectionsEqual: comparisons.every((entry) => entry.rawLogicalProjectionEqual),
  allStoredLogicalProjectionsEqual: comparisons.every((entry) => entry.storedLogicalProjectionEqual),
  allFinalFullStateHashesEqual: comparisons.every((entry) => entry.finalFullStateHashEqual),
  allApplicationTicksValid: comparisons.every((entry) => entry.applicationTicksValid),
  comparisons,
};
await writeFile(path.join(ROOT, "results", "replay-equivalence.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!output.allLogicalEqual || !output.allStoredLogicalProjectionsEqual || !output.allFinalFullStateHashesEqual || !output.allApplicationTicksValid) throw new Error("replay mismatch");

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";
import {
  createMockSharedCorridorCandidate,
  createSharedCorridorCandidate,
} from "./shared-corridor-candidate";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenarioName = argument("scenario") ?? "dense-open-120";
const population = Number(argument("population") ?? "1000");
const ticks = Number(argument("ticks") ?? "3600");
const delayed = process.argv.includes("--mock");
const label = argument("label") ?? (delayed ? "shared-flow-mock" : "shared-flow");
const output = resolve(argument("output") ?? `scratch/phase2-navigation/shared-flow/results/${scenarioName}-p${population}-t${ticks}-${label}.json`);
if (!output.includes("/scratch/phase2-navigation/shared-flow/")) {
  throw new Error("output must stay inside scratch/phase2-navigation/shared-flow");
}
if (!Number.isInteger(population) || population < 1 || !Number.isInteger(ticks) || ticks < 1) {
  throw new Error("population and ticks must be positive integers");
}

const result: BenchmarkResult = runBenchmark({
  scenario: scenarioByName(scenarioName),
  population,
  ticks,
  candidate: delayed ? createMockSharedCorridorCandidate() : createSharedCorridorCandidate(),
  evidenceClass: delayed ? "node-mock-transport" : "node-inline",
});
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const completed = result.completions.filter((entry) => entry.outcome === "completed").length;
console.log(JSON.stringify({
  output,
  scenario: scenarioName,
  candidate: result.candidate,
  population,
  finalTick: result.finalTick,
  frames: result.frames,
  wallClockMs: result.wallClockMs,
  completed,
  requests: result.pathRequests.length,
  repaths: result.movementDiagnostics.repaths,
  blockedTicks: result.scheduler.blockedTicks,
  meanTickMs: result.timing.meanTickMs,
  p95TickMs: result.timing.p95TickMs,
  fieldsBuilt: result.candidateMetrics.fieldsBuilt,
  cacheHitRate: result.candidateMetrics.cacheHitRate,
  localSearches: result.candidateMetrics.localSearches,
  directFallbacks: result.candidateMetrics.directFallbacks,
  finalFullStateHash: result.finalFullStateHash,
}, null, 2));

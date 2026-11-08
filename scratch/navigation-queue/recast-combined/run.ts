import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";
import { createMockRecastCandidate, createRecastCandidate } from "./incremental-candidate";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenarioName = argument("scenario") ?? "dense-open-120";
const population = Number(argument("population") ?? "1000");
const mode = argument("mode") ?? "sync";
const ticksRaw = argument("ticks");
const output = resolve(argument("output") ?? `scratch/navigation-protocol/recast-incremental/results/${scenarioName}-p${population}-incremental${mode === "mock" ? "-mock" : ""}.json`);
if (mode !== "sync" && mode !== "mock") throw new Error("--mode must be sync or mock");
if (!output.includes("/scratch/navigation-protocol/recast-incremental/")) {
  throw new Error("output must stay inside the isolated incremental prototype directory");
}

const candidate = mode === "sync" ? await createRecastCandidate() : await createMockRecastCandidate();
const result: BenchmarkResult = runBenchmark({
  scenario: scenarioByName(scenarioName),
  population,
  candidate,
  evidenceClass: mode === "sync" ? "node-inline" : "node-mock-transport",
  ...(ticksRaw !== undefined ? { ticks: Number(ticksRaw) } : {}),
});
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const completed = result.completions.filter((entry) => entry.outcome === "completed").length;
const noPath = result.completions.filter((entry) => entry.outcome === "no-path").length;
console.log(JSON.stringify({
  output,
  scenario: scenarioName,
  candidate: result.candidate,
  evidenceClass: result.evidenceClass,
  population: result.population,
  finalTick: result.finalTick,
  frames: result.frames,
  wallClockMs: result.wallClockMs,
  completed,
  noPath,
  completionRecords: result.completions.length,
  pathRequests: result.pathRequests.length,
  repaths: result.movementDiagnostics.repaths,
  blockedTicks: result.scheduler.blockedTicks,
  meanTickMs: result.timing.meanTickMs,
  p95TickMs: result.timing.p95TickMs,
  finalFullStateHash: result.finalFullStateHash,
  candidateMetrics: result.candidateMetrics,
}, null, 2));

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCurrentAstarCandidate, createMockAstarCandidate } from "./candidates";
import { createFlowFieldCandidate, createMockFlowFieldCandidate } from "./flow-integration/flow-candidate";
import { runBenchmark } from "./runner";
import { SCENARIOS, scenarioByName } from "./scenarios";
import type { BenchmarkResult } from "./types";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenarioName = argument("scenario") ?? "dense-open-120";
const population = Number(argument("population") ?? "1000");
const mode = argument("mode") ?? "sync";
const ticksRaw = argument("ticks");
const output = resolve(argument("output") ?? `scratch/full-game-movement/harness/results/${scenarioName}-p${population}-${mode}.json`);
if (!["sync", "mock", "flow", "flow-mock"].includes(mode)) throw new Error("--mode must be sync, mock, flow, or flow-mock");
if (!output.includes("/scratch/full-game-movement/harness/")) throw new Error("output must stay inside the isolated harness directory");

const candidate = mode === "sync"
  ? createCurrentAstarCandidate()
  : mode === "mock"
    ? createMockAstarCandidate()
    : mode === "flow"
      ? createFlowFieldCandidate()
      : createMockFlowFieldCandidate();
const result: BenchmarkResult = runBenchmark({
  scenario: scenarioByName(scenarioName),
  population,
  candidate,
  evidenceClass: mode === "sync" || mode === "flow" ? "node-inline" : "node-mock-transport",
  ...(ticksRaw !== undefined ? { ticks: Number(ticksRaw) } : {}),
});
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const completed = result.completions.filter((entry) => entry.outcome === "completed").length;
console.log(JSON.stringify({
  output,
  scenario: scenarioName,
  scenariosAvailable: SCENARIOS.length,
  candidate: result.candidate,
  evidenceClass: result.evidenceClass,
  population: result.population,
  finalTick: result.finalTick,
  frames: result.frames,
  wallClockMs: result.wallClockMs,
  completed,
  completionRecords: result.completions.length,
  pathRequests: result.pathRequests.length,
  repaths: result.movementDiagnostics.repaths,
  blockedTicks: result.scheduler.blockedTicks,
  meanTickMs: result.timing.meanTickMs,
  p95TickMs: result.timing.p95TickMs,
  finalFullStateHash: result.finalFullStateHash,
}, null, 2));

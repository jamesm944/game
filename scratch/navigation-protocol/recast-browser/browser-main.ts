import scenarioFixtures from "../../full-game-movement/harness/fixtures/scenarios.json";
import type { BenchmarkResult, ScenarioSpec } from "../../full-game-movement/harness/types";
import { runBenchmarkAsync } from "../../full-game-movement/harness/browser/full-game/async-runner";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import { createRecastBrowserAdapter, smokeRecastBrowserWorker } from "./worker-adapter";

const scenarios = scenarioFixtures as ScenarioSpec[];

export interface RecastBrowserConfig {
  readonly scenario: string;
  readonly population: number;
  readonly ticks?: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly maxFrames?: number;
}

export async function runRecastBrowserBenchmark(config: RecastBrowserConfig) {
  const scenario = scenarios.find((entry) => entry.name === config.scenario);
  if (!scenario) throw new Error(`Unknown scenario ${config.scenario}`);
  if (!Number.isInteger(config.warmupRuns) || config.warmupRuns < 0) throw new Error("Invalid warmups");
  if (!Number.isInteger(config.measuredRuns) || config.measuredRuns < 1) throw new Error("Invalid samples");
  const progress = document.querySelector<HTMLElement>("#progress");
  const runOnce = async (label: string) => {
    const candidate = createRecastBrowserAdapter();
    await candidate.ready;
    const result: BenchmarkResult = await runBenchmarkAsync({
      scenario,
      population: config.population,
      candidate,
      evidenceClass: "browser-worker",
      omitComputeMs: false,
      ...(config.ticks !== undefined ? { ticks: config.ticks } : {}),
      ...(config.maxFrames !== undefined ? { maxFrames: config.maxFrames } : {}),
      onProgress: (tick, frame, pending) => {
        if (progress && frame % 300 === 0) progress.textContent = `${label}: tick ${tick}, frame ${frame}, pending ${pending}`;
      },
    });
    return { ...result, recastRoutes: candidate.routes };
  };
  const warmups = [];
  for (let index = 0; index < config.warmupRuns; index += 1) {
    const run = await runOnce(`warmup ${index + 1}/${config.warmupRuns}`);
    warmups.push({ finalTick: run.finalTick, frames: run.frames, wallClockMs: run.wallClockMs, pathRequests: run.pathRequests.length, finalFullStateHash: run.finalFullStateHash });
  }
  const samples = [];
  for (let index = 0; index < config.measuredRuns; index += 1) samples.push(await runOnce(`sample ${index + 1}/${config.measuredRuns}`));
  const logical = samples.map(logicalBenchmarkString);
  const hashes = samples.map((sample) => sample.finalFullStateHash);
  return {
    schema: "wayfinder-recast-browser-full-game-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "actual-recast-detour-wasm-module-worker-production-world-step",
    candidate: "recast-corridor-supercover-cs0.25-full-rebuild",
    mutationStrategy: "full-generateTileCache-rebuild-from-exact-snapshot",
    scenario: scenario.name,
    population: config.population,
    requestedTicks: config.ticks ?? scenario.ticks,
    yieldSchedule: "set-timeout-0-after-every-attempted-step",
    warmupRuns: config.warmupRuns,
    measuredRuns: config.measuredRuns,
    userAgent: navigator.userAgent,
    navigatorPlatform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    warmups,
    samples,
    repeatLogicalResultsEqual: logical.every((value) => value === logical[0]),
    repeatFullStateHashesEqual: hashes.every((value) => value === hashes[0]),
  };
}

declare global {
  interface Window {
    runRecastBrowserBenchmark: typeof runRecastBrowserBenchmark;
    smokeRecastBrowserWorker: typeof smokeRecastBrowserWorker;
  }
}
window.runRecastBrowserBenchmark = runRecastBrowserBenchmark;
window.smokeRecastBrowserWorker = smokeRecastBrowserWorker;
const status = document.querySelector<HTMLElement>("#status");
if (status) status.textContent = "Recast browser runner loaded; worker initializes on demand.";

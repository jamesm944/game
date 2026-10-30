import scenarioFixtures from "../../fixtures/scenarios.json";
import type { ScenarioSpec } from "../../types";
import { runBenchmarkAsync } from "./async-runner";
import { logicalBenchmarkString } from "./replay";
import { createFullGameWorkerAdapter, type FullGameCandidate } from "./worker-adapters";

const scenarios = scenarioFixtures as ScenarioSpec[];

export interface FullGameBrowserConfig {
  readonly candidate: FullGameCandidate;
  readonly scenario: string;
  readonly population: number;
  readonly ticks?: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly maxFrames?: number;
}

function scenarioByName(name: string): ScenarioSpec {
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`unknown full-game scenario ${name}`);
  return scenario;
}

export async function runFullGameBrowserBenchmark(config: FullGameBrowserConfig) {
  if (!Number.isInteger(config.warmupRuns) || config.warmupRuns < 0) throw new Error("invalid warmups");
  if (!Number.isInteger(config.measuredRuns) || config.measuredRuns < 1) throw new Error("invalid samples");
  const scenario = scenarioByName(config.scenario);
  const progress = document.querySelector<HTMLElement>("#progress");
  const runOnce = (label: string) => runBenchmarkAsync({
    scenario,
    population: config.population,
    candidate: createFullGameWorkerAdapter(config.candidate),
    evidenceClass: "browser-worker",
    omitComputeMs: true,
    ...(config.ticks !== undefined ? { ticks: config.ticks } : {}),
    ...(config.maxFrames !== undefined ? { maxFrames: config.maxFrames } : {}),
    onProgress: (tick, frame, pending) => {
      if (progress && frame % 300 === 0) progress.textContent = `${label}: tick ${tick}, frame ${frame}, pending ${pending}`;
    },
  });
  const warmups = [];
  for (let index = 0; index < config.warmupRuns; index += 1) {
    const run = await runOnce(`warmup ${index + 1}/${config.warmupRuns}`);
    warmups.push({
      finalTick: run.finalTick,
      frames: run.frames,
      wallClockMs: run.wallClockMs,
      pathRequests: run.pathRequests.length,
      finalFullStateHash: run.finalFullStateHash,
    });
  }
  const samples = [];
  for (let index = 0; index < config.measuredRuns; index += 1) {
    samples.push(await runOnce(`sample ${index + 1}/${config.measuredRuns}`));
  }
  const logical = samples.map(logicalBenchmarkString);
  const hashes = samples.map((sample) => sample.finalFullStateHash);
  return {
    schema: "wayfinder-browser-full-game-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "asynchronous-full-game-world-step-real-worker",
    candidate: config.candidate,
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
    runFullGameBrowserBenchmark: typeof runFullGameBrowserBenchmark;
  }
}

window.runFullGameBrowserBenchmark = runFullGameBrowserBenchmark;
const status = document.querySelector<HTMLElement>("#status");
if (status) status.textContent = "Asynchronous full-game runner ready.";

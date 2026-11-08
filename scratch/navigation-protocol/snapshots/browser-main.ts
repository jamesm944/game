import scenarioFixtures from "../../full-game-movement/harness/fixtures/scenarios.json";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { ScenarioSpec } from "../../full-game-movement/harness/types";
import { createVersionedAstarCandidate } from "./adapter";
import { runBenchmarkAsync } from "./async-runner";

const scenarios = scenarioFixtures as ScenarioSpec[];

export interface VersionedBrowserConfig {
  readonly scenario: "mixed-destinations-120" | "narrow-mutation-120";
  readonly population: number;
  readonly ticks: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
}

export async function runVersionedBrowserBenchmark(config: VersionedBrowserConfig) {
  const scenario = scenarios.find((entry) => entry.name === config.scenario);
  if (!scenario) throw new Error(`unknown scenario ${config.scenario}`);
  const progress = document.querySelector<HTMLElement>("#progress");
  const runOnce = (label: string, includeProtocol: boolean) => {
    const candidate = createVersionedAstarCandidate();
    return runBenchmarkAsync({
      scenario,
      population: config.population,
      ticks: config.ticks,
      candidate,
      evidenceClass: "browser-worker",
      omitComputeMs: false,
      onProgress: (tick, frame, pending) => {
        if (progress && frame % 300 === 0) progress.textContent = `${label}: tick ${tick}, frame ${frame}, pending ${pending}`;
      },
    }).then((run) => includeProtocol ? { ...run, protocol: candidate.protocolTelemetry() } : run);
  };
  const warmups = [];
  for (let index = 0; index < config.warmupRuns; index += 1) {
    const run = await runOnce(`warmup ${index + 1}/${config.warmupRuns}`, false);
    warmups.push({
      finalTick: run.finalTick,
      frames: run.frames,
      wallClockMs: run.wallClockMs,
      pathRequests: run.pathRequests.length,
      finalFullStateHash: run.finalFullStateHash,
      candidateMetrics: run.candidateMetrics,
    });
  }
  const samples = [];
  for (let index = 0; index < config.measuredRuns; index += 1) {
    samples.push(await runOnce(`sample ${index + 1}/${config.measuredRuns}`, true));
  }
  const logical = samples.map(logicalBenchmarkString);
  const hashes = samples.map((sample) => sample.finalFullStateHash);
  return {
    schema: "wayfinder-versioned-snapshot-browser-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "asynchronous-full-game-world-step-versioned-snapshot-worker",
    candidate: "versioned-snapshot-astar",
    scenario: scenario.name,
    population: config.population,
    requestedTicks: config.ticks,
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
    runVersionedBrowserBenchmark: typeof runVersionedBrowserBenchmark;
  }
}

window.runVersionedBrowserBenchmark = runVersionedBrowserBenchmark;
const status = document.querySelector<HTMLElement>("#status");
if (status) status.textContent = "Versioned snapshot full-game runner ready.";

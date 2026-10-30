import scenarioFixtures from "../full-game-movement/harness/fixtures/scenarios.json";
import { logicalBenchmarkString } from "../full-game-movement/harness/browser/full-game/replay";
import type { ScenarioSpec } from "../full-game-movement/harness/types";
import { createBrowserQueueWorkerFactory, createQueueAstarCandidate, runDeliveryProbeDiagnostic } from "./adapter";
import { runBenchmarkAsync } from "./async-runner";
import type { QueuePolicy } from "./protocol";

const scenarios = scenarioFixtures as ScenarioSpec[];
export interface QueueBrowserConfig {
  readonly policy: QueuePolicy;
  readonly scenario: "mixed-destinations-120" | "narrow-mutation-120";
  readonly population: number;
  readonly ticks: number;
  readonly warmupTicks: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
}

export async function runQueueBrowserBenchmark(config: QueueBrowserConfig) {
  const scenario = scenarios.find((entry) => entry.name === config.scenario);
  if (!scenario) throw new Error(`unknown scenario ${config.scenario}`);
  const progress = document.querySelector<HTMLElement>("#progress");
  const runOnce = async (label: string, includeProtocol: boolean, ticks: number) => {
    const candidate = createQueueAstarCandidate(config.policy);
    const run = await runBenchmarkAsync({
      scenario,
      population: config.population,
      ticks,
      candidate,
      evidenceClass: "browser-worker",
      omitComputeMs: false,
      onProgress: (tick, frame, pending) => {
        if (progress && frame % 300 === 0) progress.textContent = `${label}: tick ${tick}, frame ${frame}, pending ${pending}`;
      },
    });
    return includeProtocol ? { ...run, protocol: candidate.protocolTelemetry() } : run;
  };
  const warmups = [];
  for (let index = 0; index < config.warmupRuns; index += 1) {
    const run = await runOnce(`warmup ${index + 1}/${config.warmupRuns}`, false, config.warmupTicks);
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
    samples.push(await runOnce(`sample ${index + 1}/${config.measuredRuns}`, true, config.ticks));
  }
  // Runs only after all headline timings; uses a fresh worker and main-only RTT timestamps.
  const deliveryDiagnostic = await runDeliveryProbeDiagnostic(createBrowserQueueWorkerFactory(), 64);
  const logical = samples.map(logicalBenchmarkString);
  const hashes = samples.map((sample) => sample.finalFullStateHash);
  return {
    schema: "wayfinder-171-batch-only-browser-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "asynchronous-full-game-world-step-queue-policy-worker",
    candidate: `queue-${config.policy}-snapshot-astar`,
    policy: config.policy,
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
    deliveryDiagnostic,
    repeatLogicalResultsEqual: logical.every((value) => value === logical[0]),
    repeatFullStateHashesEqual: hashes.every((value) => value === hashes[0]),
  };
}

declare global {
  interface Window {
    runQueueBrowserBenchmark: typeof runQueueBrowserBenchmark;
  }
}
window.runQueueBrowserBenchmark = runQueueBrowserBenchmark;
const status = document.querySelector<HTMLElement>("#status");
if (status) status.textContent = "Navigation queue policy runner ready.";

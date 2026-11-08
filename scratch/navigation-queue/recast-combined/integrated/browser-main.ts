import scenarioFixtures from "../../../full-game-movement/harness/fixtures/scenarios.json";
import type { BenchmarkResult, ScenarioSpec } from "../../../full-game-movement/harness/types";
import { logicalBenchmarkString } from "../../../full-game-movement/harness/browser/full-game/replay";
import type { PathResponse } from "../../../../src/sim/path/protocol";
import { runBenchmarkAsync } from "./async-runner";
import { createCombinedRecastCandidate } from "./adapter";

const scenarios = scenarioFixtures as ScenarioSpec[];

export interface CombinedBrowserConfig {
  readonly scenario: string;
  readonly population: number;
  readonly ticks?: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly maxFrames?: number;
}

export async function runRecastBrowserBenchmark(config: CombinedBrowserConfig) {
  const scenario = scenarios.find((entry) => entry.name === config.scenario);
  if (!scenario) throw new Error(`Unknown scenario ${config.scenario}`);
  if (!Number.isInteger(config.warmupRuns) || config.warmupRuns < 0) throw new Error("Invalid warmups");
  if (!Number.isInteger(config.measuredRuns) || config.measuredRuns < 1) throw new Error("Invalid samples");
  const progress = document.querySelector<HTMLElement>("#progress");
  const runOnce = async (label: string) => {
    const candidate = createCombinedRecastCandidate();
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
    return { ...result, recastRoutes: candidate.routes, protocol: candidate.protocolTelemetry() };
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
    schema: "wayfinder-combined-recast-browser-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "exact-tile-recast-acknowledged-full-delta-real-module-worker-production-world-step",
    candidate: "combined-exact-tile-recast-versioned-snapshots",
    mutationStrategy: "exact-touched-nav-tile-rasterization-with-unchanged-compressed-layer-reuse",
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

export async function smokeRecastBrowserWorker() {
  const adapter = createCombinedRecastCandidate();
  await adapter.ready;
  let responseResolve!: (response: PathResponse) => void;
  const responsePromise = new Promise<PathResponse>((resolve) => { responseResolve = resolve; });
  const transport = adapter.createTransport({ evidenceClass: "browser-worker", now: () => performance.now(), onRequest: () => {}, onResponse: (response) => responseResolve(response) });
  transport.attach((response) => responseResolve(response));
  const width = 12;
  const source = new Uint8Array(width * width).fill(1);
  for (let y = 0; y < width; y += 1) if (y !== 4) source[y * width + 5] = 0;
  const passable = adapter.snapshots.prepare(0, source).passable;
  transport.send({ kind: "path", id: 1, dueTick: 2, startX: 0, startY: 4, goalX: 11, goalY: 4, passable, passableVersion: 0, seed: 171 });
  const timeout = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("combined Recast worker smoke timeout")), 30_000); });
  const response = await Promise.race([responsePromise, timeout]);
  if (!response.ok || response.id !== 1 || Array.from(response.waypoints.slice(0, 2)).join(",") !== "0,4" || Array.from(response.waypoints.slice(-2)).join(",") !== "11,4") throw new Error(`combined Recast smoke invalid route: ${JSON.stringify({ ok: response.ok, id: response.id, route: Array.from(response.waypoints) })}`);
  const protocol = adapter.protocolTelemetry();
  if (protocol.snapshotAcks.length !== 1 || protocol.errors.length !== 0) throw new Error("combined Recast smoke did not receive exactly one clean acknowledgment");
  const metrics = adapter.candidateMetrics?.() ?? {};
  transport.dispose();
  return { ready: true as const, route: Array.from(response.waypoints), metrics, protocol };
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
if (status) status.textContent = "Combined Recast browser runner loaded; worker initializes on demand.";

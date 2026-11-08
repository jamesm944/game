import { createPathWorkerFactory } from "../../../../src/game/paths";
import type { PathWorkerFactory } from "../../../../src/sim/path/scheduler";
import { SchedulerInstrumentation } from "../instrumentation";
import scenarioFixtures from "../fixtures/scenarios.json";
import type { MovementCandidateAdapter, PathRequestMetric, ScenarioSpec } from "../types";
import {
  canonicalLogical,
  createLoadSpecs,
  createPassability,
  summarizeRequests,
  type AppliedLogicalRoute,
  type LoadPattern,
} from "./load-model";

const scenarios = scenarioFixtures as ScenarioSpec[];
function scenarioByName(name: string): ScenarioSpec {
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`unknown browser scenario ${name}`);
  return scenario;
}

export type BrowserCandidate = "astar" | "flow";

export interface BrowserRunConfig {
  readonly candidate: BrowserCandidate;
  readonly scenario: string;
  readonly population: number;
  readonly pattern: LoadPattern;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly maxFrames?: number;
}

interface BrowserPathMetric extends PathRequestMetric {
  readonly responseWaypointBytes?: number;
}

function createFlowWorkerFactory(): PathWorkerFactory {
  return () => {
    const worker = new Worker(new URL("./flow.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage: (message) => worker.postMessage(message),
      setMessageHandler: (handler) => {
        worker.onmessage = handler ? (event) => handler({ data: event.data }) : null;
      },
      terminate: () => worker.terminate(),
    };
  };
}

function createRealWorkerAdapter(candidate: BrowserCandidate): MovementCandidateAdapter {
  const factory = candidate === "astar" ? createPathWorkerFactory() : createFlowWorkerFactory();
  let activeWorker: ReturnType<PathWorkerFactory> | undefined;
  return {
    id: candidate === "astar" ? "current-integer-astar" : "flow-field-shared-destination",
    createTransport(context) {
      const worker = factory();
      activeWorker = worker;
      return {
        attach(receive) {
          worker.setMessageHandler((event) => {
            // Worker-internal compute time is intentionally not estimated.
            context.onResponse(event.data, 0);
            receive(event.data);
          });
        },
        send(request) {
          context.onRequest(request);
          worker.postMessage(request);
        },
        dispose() {
          worker.setMessageHandler(null);
          worker.terminate();
        },
      };
    },
    dispose() {
      activeWorker?.terminate();
      activeWorker = undefined;
    },
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function runOnce(config: BrowserRunConfig) {
  const scenario = scenarioByName(config.scenario);
  const specs = createLoadSpecs(scenario, config.population, config.pattern);
  const passable = createPassability(scenario);
  const applied: AppliedLogicalRoute[] = [];
  const responseBytes = new Map<number, number>();
  let tick = 1;
  let frame = 0;
  const instrumentation = new SchedulerInstrumentation({
    adapter: createRealWorkerAdapter(config.candidate),
    evidenceClass: "browser-worker",
    boundaryTick: () => tick,
    frame: () => frame,
    now: () => performance.now(),
    onApply: (_metric, response) => responseBytes.set(response.id, response.waypoints.byteLength),
  });
  const scheduler = instrumentation.scheduler;
  const frames: { frame: number; tick: number; queueDepth: number; blockedTicks: number }[] = [];
  let issued = 0;
  let maxQueueDepth = 0;
  let queueDepthTotal = 0;
  const started = performance.now();
  const maxFrames = config.maxFrames ?? 5000;
  try {
    while (frame < maxFrames) {
      while (issued < specs.length && specs[issued]!.issueTick === tick) {
        const spec = specs[issued]!;
        scheduler.requestPath(spec, {
          issueTick: spec.issueTick,
          seed: spec.seed,
          passability: passable,
          onApply: (response) => {
            // The measured direct-load consumer retains the actual applied route.
            applied.push({
              id: response.id,
              issueTick: spec.issueTick,
              dueTick: spec.issueTick + 2,
              applyTick: tick,
              response: {
                ...response,
                waypoints: response.waypoints.slice(),
              },
            });
          },
        });
        issued += 1;
      }
      frame += 1;
      const advanced = scheduler.pump(tick);
      const queueDepth = scheduler.pendingCount;
      maxQueueDepth = Math.max(maxQueueDepth, queueDepth);
      queueDepthTotal += queueDepth;
      frames.push({ frame, tick, queueDepth, blockedTicks: scheduler.blockedTicks });
      if (advanced) {
        if (issued === specs.length && queueDepth === 0) break;
        tick += 1;
      }
      await nextFrame();
    }
    if (issued !== specs.length || scheduler.pendingCount !== 0 || applied.length !== specs.length) {
      throw new Error(`worker run did not drain: issued=${issued}, applied=${applied.length}, pending=${scheduler.pendingCount}`);
    }
    const wallClockMs = performance.now() - started;
    const pathRequests: BrowserPathMetric[] = instrumentation.requests.map((request) => {
      const { computeMs: _notMeasured, ...withoutCompute } = request;
      return { ...withoutCompute, responseWaypointBytes: responseBytes.get(request.id) ?? 0 };
    });
    const logical = canonicalLogical(applied);
    return {
      wallClockMs,
      frames: frame,
      finalTick: tick,
      requests: specs.length,
      pathRequests,
      scheduler: {
        blockedTicks: scheduler.blockedTicks,
        finalQueueDepth: scheduler.pendingCount,
        maxQueueDepth,
        meanQueueDepth: queueDepthTotal / frame,
      },
      timing: summarizeRequests(pathRequests),
      responseWaypointBytes: pathRequests.reduce((sum, request) => sum + (request.responseWaypointBytes ?? 0), 0),
      appliedOrder: applied.map((route) => route.id),
      logicalRouteHash: await sha256(logical),
      frameSamples: frames,
    };
  } finally {
    instrumentation.adapter.dispose?.();
  }
}

export async function runBrowserBenchmark(config: BrowserRunConfig) {
  if (config.warmupRuns < 0 || config.measuredRuns < 1) throw new Error("invalid warmup/sample counts");
  const scenario = scenarioByName(config.scenario);
  const progress = document.querySelector<HTMLElement>("#progress");
  const warmups = [];
  for (let index = 0; index < config.warmupRuns; index += 1) {
    if (progress) progress.textContent = `warmup ${index + 1}/${config.warmupRuns}`;
    const run = await runOnce(config);
    warmups.push({ wallClockMs: run.wallClockMs, logicalRouteHash: run.logicalRouteHash });
  }
  const samples = [];
  for (let index = 0; index < config.measuredRuns; index += 1) {
    if (progress) progress.textContent = `sample ${index + 1}/${config.measuredRuns}`;
    samples.push(await runOnce(config));
  }
  const hashes = samples.map((sample) => sample.logicalRouteHash);
  const ordered = samples.every((sample) => sample.appliedOrder.every((id, index) => id === index + 1));
  return {
    schema: "wayfinder-browser-direct-worker-load-v1",
    evidenceClass: "browser-worker",
    evidenceScope: "direct-real-worker-load-not-full-game-world-step",
    candidate: config.candidate,
    scenario: scenario.name,
    population: config.population,
    pattern: config.pattern,
    warmupRuns: config.warmupRuns,
    measuredRuns: config.measuredRuns,
    userAgent: navigator.userAgent,
    navigatorPlatform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    warmups,
    samples,
    repeatLogicalHashesEqual: hashes.every((hash) => hash === hashes[0]),
    ascendingApplicationOrder: ordered,
  };
}

declare global {
  interface Window {
    runBrowserBenchmark: typeof runBrowserBenchmark;
  }
}

window.runBrowserBenchmark = runBrowserBenchmark;
const status = document.querySelector<HTMLElement>("#status");
if (status) status.textContent = "Real-worker runner ready.";

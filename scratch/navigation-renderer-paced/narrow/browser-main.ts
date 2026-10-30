import scenarioFixtures from "../../full-game-movement/harness/fixtures/scenarios.json";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { ScenarioSpec } from "../../full-game-movement/harness/types";
import { createQueueAstarCandidate } from "./adapter";
import type { QueuePolicy } from "./protocol";
import { runBenchmarkAsync } from "./runner";
import { ProductionRenderer } from "./renderer";
import { buildLayers, TERRAIN_DEEP_WATER, TERRAIN_GRASS } from "../../../src/sim/world/layers";

const scenarios = scenarioFixtures as ScenarioSpec[];
export interface RendererBrowserConfig {
  readonly policy: QueuePolicy;
  readonly population: number;
  readonly ticks: number;
  readonly warmupTicks: number;
}

export async function runRendererBenchmark(config: RendererBrowserConfig) {
  if (config.policy !== "fifo" && config.policy !== "batch-32") throw new Error("only FIFO and batch32");
  const scenario = scenarios.find((entry) => entry.name === "narrow-mutation-120")!;
  const terrain = new Uint8Array(scenario.size * scenario.size).fill(TERRAIN_GRASS);
  for (const rect of scenario.map.blocked) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) terrain[y * scenario.size + x] = TERRAIN_DEEP_WATER;
    }
  }
  const renderer = await ProductionRenderer.create(buildLayers(terrain, new Uint8Array(terrain.length)));
  const progress = document.querySelector<HTMLElement>("#progress")!;
  const runOnce = async (label: string, ticks: number, includeProtocol: boolean) => {
    const candidate = createQueueAstarCandidate(config.policy);
    const run = await runBenchmarkAsync({
      scenario, population: config.population, ticks, candidate, renderer,
      evidenceClass: "browser-worker", omitComputeMs: false,
      onProgress: (tick, frame, pending) => {
        if (frame % 300 === 0) progress.textContent = `${label}: tick ${tick}, frame ${frame}, pending ${pending}`;
      },
    });
    return includeProtocol ? { ...run, protocol: candidate.protocolTelemetry() } : run;
  };
  const warmup = await runOnce("warmup", config.warmupTicks, false);
  const sample = await runOnce("measured", config.ticks, true);
  return {
    schema: "wayfinder-172-renderer-paced-narrow-v1",
    evidenceClass: "browser-worker-production-renderer",
    evidenceScope: "narrow-mutation-p1000-t3600-real-rAF-30Hz-full-renderer-combat-gather-placement-movement",
    policy: config.policy,
    scenario: scenario.name,
    population: config.population,
    requestedTicks: config.ticks,
    warmupTicks: config.warmupTicks,
    pacing: sample.pacing,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    warmup: {
      finalTick: warmup.finalTick, frames: warmup.frames, wallClockMs: warmup.wallClockMs,
      finalFullStateHash: warmup.finalFullStateHash,
    },
    samples: [sample],
    logical: logicalBenchmarkString(sample),
  };
}

declare global {
  interface Window { runRendererBenchmark: typeof runRendererBenchmark }
}
window.runRendererBenchmark = runRendererBenchmark;
document.querySelector<HTMLElement>("#status")!.textContent = "Renderer-paced navigation runner ready.";

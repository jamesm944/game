import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCurrentAstarCandidate, createMockAstarCandidate } from "../../candidates";
import { createMockFlowFieldCandidate } from "../../flow-integration/flow-candidate";
import { runBenchmark } from "../../runner";
import { scenarioByName } from "../../scenarios";
import { macrotaskYield, runBenchmarkAsync } from "./async-runner";
import { logicalBenchmarkString } from "./replay";

describe("asynchronous full-game browser artifacts", () => {
  it("matches synchronous inline logical state with honest macrotask yields", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const synchronous = runBenchmark({ ...config, candidate: createCurrentAstarCandidate(), evidenceClass: "node-inline" });
    const asynchronous = await runBenchmarkAsync({
      ...config,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "browser-worker",
      yieldFrame: macrotaskYield,
    });
    expect(logicalBenchmarkString(asynchronous)).toBe(logicalBenchmarkString(synchronous));
    expect(asynchronous.frames).toBe(400);
    expect(asynchronous.scheduler.blockedTicks).toBe(0);
  }, 30_000);

  it("matches the equivalent delayed A* frame schedule exactly", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const synchronous = runBenchmark({ ...config, candidate: createMockAstarCandidate(), evidenceClass: "node-mock-transport" });
    const asynchronous = await runBenchmarkAsync({
      ...config,
      candidate: createMockAstarCandidate(),
      evidenceClass: "browser-worker",
      yieldFrame: macrotaskYield,
    });
    expect(asynchronous.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(asynchronous.frames).toBeGreaterThan(400);
    expect(logicalBenchmarkString(asynchronous)).toBe(logicalBenchmarkString(synchronous));
  }, 30_000);

  it("matches the equivalent delayed flow frame schedule exactly", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const synchronous = runBenchmark({ ...config, candidate: createMockFlowFieldCandidate(), evidenceClass: "node-mock-transport" });
    const asynchronous = await runBenchmarkAsync({
      ...config,
      candidate: createMockFlowFieldCandidate(),
      evidenceClass: "browser-worker",
      yieldFrame: macrotaskYield,
    });
    expect(asynchronous.scheduler.blockedTicks).toBeGreaterThan(0);
    expect(logicalBenchmarkString(asynchronous)).toBe(logicalBenchmarkString(synchronous));
  }, 30_000);

  it("uses one production leader request for the initial dense group order", async () => {
    const run = await runBenchmarkAsync({
      scenario: scenarioByName("dense-open-120"),
      population: 40,
      ticks: 60,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "browser-worker",
      yieldFrame: macrotaskYield,
    });
    expect(run.movementDiagnostics.groupMoves).toBe(1);
    expect(run.pathRequests.filter((request) => request.commandTick === 1)).toHaveLength(1);
    expect(run.pathRequests[0]).toMatchObject({ id: 1, commandTick: 1, applyTick: 3 });
    expect(run.pathRequests.slice(1).every((request) => request.commandTick === undefined)).toBe(true);
  }, 30_000);

  it("wires the real production A* worker and existing flow worker", () => {
    const adapters = readFileSync(new URL("./worker-adapters.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("./full-game-main.ts", import.meta.url), "utf8");
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(adapters).toContain("createPathWorkerFactory()");
    expect(adapters).toContain('new URL("../flow.worker.ts", import.meta.url)');
    expect(main).toContain("runBenchmarkAsync");
    expect(main).toContain('evidenceClass: "browser-worker"');
    expect(html).toContain('type="module" src="./full-game-main.ts"');
  });
});

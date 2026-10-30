import { describe, expect, it } from "vitest";
import { createPathEngine } from "../../src/sim/path/engine";
import type { PathResponse } from "../../src/sim/path/protocol";
import { createCurrentAstarCandidate } from "../full-game-movement/harness/candidates";
import { SchedulerInstrumentation } from "../full-game-movement/harness/instrumentation";
import { runBenchmark } from "../full-game-movement/harness/runner";
import { scenarioByName } from "../full-game-movement/harness/scenarios";
import { logicalBenchmarkString } from "../full-game-movement/harness/browser/full-game/replay";
import { createLocalQueueWorkerFactory, createQueueAstarCandidate } from "./adapter";
import { runBenchmarkAsync } from "./async-runner";
import { installLegacySnapshotCompatibility, LegacySnapshotCompatibility } from "./legacy-compat";
import {
  epochNowMs,
  type QueuePathRequest,
  type QueueWorkerFactory,
  type QueueWorkerMessage,
  type QueueWorkerRequest,
  type SnapshotPlane,
} from "./protocol";
import { SchedulerOwnedSnapshotProvider } from "./provider";
import { postNavigationResult } from "./queue.worker";
import { MAX_BATCH_SIZE, NavigationQueueWorker } from "./worker-handler";

function grid(width: number): Uint8Array {
  return new Uint8Array(width * width).fill(1);
}
function register(snapshotId: number, revision: number, passable: Uint8Array, plane: SnapshotPlane = "land") {
  return {
    kind: "snapshot-register" as const,
    handle: { snapshotId, revision, plane, width: Math.sqrt(passable.length) },
    passable: passable.buffer as ArrayBuffer,
  };
}
function request(id: number, overrides: Partial<QueuePathRequest> = {}): QueuePathRequest {
  return {
    id, dueTick: 3, startX: 0, startY: 0, goalX: 4, goalY: 4, seed: 99,
    snapshot: { snapshotId: 1, revision: 0, plane: "land", width: 5 },
    requestClass: "repath", groupKey: "group-a", sentAtEpochMs: epochNowMs(), ...overrides,
  };
}
function expectedPath(req: QueuePathRequest, passable: Uint8Array): PathResponse {
  return createPathEngine().handle({
    kind: "path", id: req.id, dueTick: req.dueTick,
    startX: req.startX, startY: req.startY, goalX: req.goalX, goalY: req.goalY,
    seed: req.seed, passable, passableVersion: req.snapshot.revision,
  });
}

describe("clean snapshot provider and queue worker", () => {
  it("keeps clean handles free of legacy slice behavior and bounds main planes", () => {
    const provider = new SchedulerOwnedSnapshotProvider();
    const land = provider.prepare(0, "land", grid(5));
    expect(land.passable.slice()).not.toBe(land.passable);
    provider.prepare(0, "naval", grid(5));
    provider.prepare(0, "owner", grid(5));
    expect(provider.retainedSnapshotCount).toBe(3);
    expect(provider.retainedSnapshotBytes).toBe(75);
    const compatibility = new LegacySnapshotCompatibility(provider);
    const legacy = compatibility.prepare(1, "land", grid(5));
    expect(legacy.passable.slice()).toBe(legacy.passable);
    expect(compatibility.resolve(legacy.passable).handle).toEqual(legacy.handle);
  });

  it("coalesces only identical same-group requests and preserves exact paths", () => {
    const worker = new NavigationQueueWorker();
    const passable = grid(5);
    worker.handle(register(1, 0, passable));
    const first = request(1);
    const same = request(2);
    const otherGroup = request(3, { groupKey: "group-b" });
    const otherStart = request(4, { startX: 1 });
    const otherSeed = request(5, { seed: 100 });
    const result = worker.handle({ kind: "path-batch", batchId: 1, requests: [first, same, otherGroup, otherStart, otherSeed] });
    if (result.kind !== "path-results") throw new Error("expected paths");
    expect(result.items[1]?.coalescedFromId).toBe(1);
    expect(result.items.slice(2).every((item) => item.coalescedFromId === undefined)).toBe(true);
    for (const req of [first, same, otherGroup, otherStart, otherSeed]) {
      const item = result.items.find((entry) => entry.response.id === req.id)!;
      expect(item.response).toEqual(expectedPath(req, passable));
    }
    expect(worker.coalescedRequests).toBe(1);
    expect(() => worker.handle({
      kind: "path-batch", batchId: 2,
      requests: Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, id) => request(id + 1)),
    })).toThrow("batch size");
  });

  it("handles registration races, revision immutability, planes, and two-revision eviction", () => {
    const worker = new NavigationQueueWorker();
    expect(() => worker.handle({ kind: "path", ...request(1) })).toThrow("unregistered");
    const land = grid(5);
    worker.handle(register(1, 0, land));
    worker.handle(register(2, 0, grid(5), "naval"));
    worker.handle(register(3, 0, grid(5), "owner"));
    worker.handle({
      kind: "snapshot-update",
      handle: { snapshotId: 4, revision: 1, plane: "land", width: 5 },
      baseSnapshotId: 1, baseRevision: 0,
      indices: Uint32Array.of(0), values: Uint8Array.of(0),
    });
    const oldResult = worker.handle({ kind: "path", ...request(1) });
    const newResult = worker.handle({
      kind: "path", ...request(2, { snapshot: { snapshotId: 4, revision: 1, plane: "land", width: 5 } }),
    });
    if (oldResult.kind !== "path-results" || newResult.kind !== "path-results") throw new Error("expected paths");
    expect(oldResult.items[0]!.response).toEqual(expectedPath(request(1), land));
    const changed = land.slice();
    changed[0] = 0;
    expect(newResult.items[0]!.response).toEqual(expectedPath(request(2), changed));
    worker.handle({
      kind: "snapshot-update",
      handle: { snapshotId: 5, revision: 2, plane: "land", width: 5 },
      baseSnapshotId: 4, baseRevision: 1, indices: new Uint32Array(0), values: new Uint8Array(0),
    });
    expect(worker.snapshotCount("land")).toBe(2);
    expect(worker.snapshotBytes("land")).toBe(50);
    expect(worker.snapshotCount()).toBe(4);
    expect(() => worker.handle({ kind: "path", ...request(3) })).toThrow("unregistered");
  });
});

function manualWorker() {
  const outbound: QueueWorkerRequest[] = [];
  const handler = new NavigationQueueWorker();
  let receive: ((event: { data: QueueWorkerMessage }) => void) | null = null;
  const factory: QueueWorkerFactory = () => ({
    postMessage(message) { outbound.push(message); },
    setMessageHandler(handler) { receive = handler; },
    terminate() {},
  });
  return {
    factory,
    outbound,
    deliver(message: QueueWorkerRequest) {
      postNavigationResult((output) => receive?.({ data: output }), message, handler);
    },
  };
}

describe("priority, batching, and production scheduler races", () => {
  it("executes leaders first but applies duplicate-safe responses in ascending ID order", async () => {
    const manual = manualWorker();
    const candidate = createQueueAstarCandidate("priority", manual.factory);
    const instrumentation = new SchedulerInstrumentation({
      adapter: candidate, evidenceClass: "node-mock-transport", boundaryTick: () => 3, frame: () => 0,
    });
    const scheduler = instrumentation.scheduler;
    installLegacySnapshotCompatibility(scheduler, candidate.compatibility);
    const applied: number[] = [];
    const live = grid(5);
    candidate.noteRequest(1, "repath", "r1");
    candidate.noteRequest(2, "leader", "g1");
    scheduler.requestPath({ startX: 0, startY: 0, goalX: 4, goalY: 4 }, {
      issueTick: 1, seed: 1, passability: live, onApply: () => applied.push(1),
    });
    scheduler.requestPath({ startX: 1, startY: 0, goalX: 4, goalY: 4 }, {
      issueTick: 1, seed: 2, passability: live, onApply: () => applied.push(2),
    });
    await Promise.resolve();
    const paths = manual.outbound.filter((message) => message.kind === "path");
    expect(paths.map((message) => message.id)).toEqual([2, 1]);
    manual.deliver(manual.outbound[0]!);
    manual.deliver(paths[1]!);
    expect(scheduler.pump(3)).toBe(false);
    manual.deliver(paths[0]!);
    manual.deliver(paths[0]!);
    expect(scheduler.pump(3)).toBe(true);
    expect(applied).toEqual([1, 2]);
  });

  it("keeps stale handling and issue-apply ticks under revision/update and batch races", async () => {
    const manual = manualWorker();
    const candidate = createQueueAstarCandidate("priority-batch", manual.factory);
    const instrumentation = new SchedulerInstrumentation({
      adapter: candidate, evidenceClass: "node-mock-transport", boundaryTick: () => 3, frame: () => 0,
    });
    const scheduler = instrumentation.scheduler;
    installLegacySnapshotCompatibility(scheduler, candidate.compatibility);
    const live = grid(5);
    const applied: number[] = [];
    const discarded: number[] = [];
    scheduler.requestPath({ startX: 0, startY: 0, goalX: 4, goalY: 4 }, {
      issueTick: 1, seed: 1, passability: live,
      onApply: () => applied.push(1), onDiscard: () => discarded.push(1),
    });
    scheduler.setPassabilityVersion(1);
    live[0] = 0;
    scheduler.requestPath({ startX: 1, startY: 0, goalX: 4, goalY: 4 }, {
      issueTick: 1, seed: 2, passability: live,
      onApply: () => applied.push(2), onDiscard: () => discarded.push(2),
    });
    await Promise.resolve();
    for (const message of manual.outbound) manual.deliver(message);
    expect(scheduler.pump(3)).toBe(true);
    expect(applied).toEqual([2]);
    expect(discarded).toEqual([1]);
    expect(instrumentation.requests.map((request) => request.issueToApplyTicks)).toEqual([2, 2]);
    expect(candidate.protocolTelemetry().maxBatchSize).toBe(2);
  });
});

describe("delayed and out-of-order full-game policy replay", () => {
  const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
  it("matches production A* and repeats logically for FIFO, priority, and batch", async () => {
    const synchronous = runBenchmark({ ...config, candidate: createCurrentAstarCandidate(), evidenceClass: "node-inline" });
    const expected = logicalBenchmarkString(synchronous);
    for (const policy of ["fifo", "priority", "priority-batch"] as const) {
      const runs = [];
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const candidate = createQueueAstarCandidate(policy, createLocalQueueWorkerFactory(10));
        const run = await runBenchmarkAsync({ ...config, candidate, evidenceClass: "node-mock-transport" });
        expect(logicalBenchmarkString(run)).toBe(expected);
        expect(run.pathRequests.filter((request) => request.applyTick !== undefined)
          .every((request) => request.issueToApplyTicks === 2)).toBe(true);
        expect(candidate.protocolTelemetry().maxBatchSize).toBeLessThanOrEqual(MAX_BATCH_SIZE);
        runs.push(run);
      }
      expect(logicalBenchmarkString(runs[0]!)).toBe(logicalBenchmarkString(runs[1]!));
      expect(runs[0]!.finalFullStateHash).toBe(runs[1]!.finalFullStateHash);
      expect(runs[0]!.scheduler.blockedTicks).toBeGreaterThan(0);
    }
  }, 60_000);
});

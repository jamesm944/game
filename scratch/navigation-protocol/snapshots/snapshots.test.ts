import { describe, expect, it } from "vitest";
import { createPathEngine } from "../../../src/sim/path/engine";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { SchedulerInstrumentation } from "../../full-game-movement/harness/instrumentation";
import { createCurrentAstarCandidate } from "../../full-game-movement/harness/candidates";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import {
  createLocalVersionedWorkerFactory,
  createVersionedAstarCandidate,
} from "./adapter";
import { runBenchmarkAsync } from "./async-runner";
import {
  epochNowMs,
  type VersionedWorkerMessage,
  type VersionedWorkerRequest,
  type VersionedWorkerFactory,
} from "./protocol";
import { MainSnapshotCache, installVersionedSnapshotScheduler } from "./snapshot-cache";
import { postVersionedResult } from "./versioned.worker";
import { VersionedSnapshotWorker } from "./worker-handler";

function grid(width: number): Uint8Array {
  return new Uint8Array(width * width).fill(1);
}

function register(snapshotId: number, revision: number, passable: Uint8Array, plane: "land" | "naval" | "owner" = "land") {
  return {
    kind: "snapshot-register" as const,
    snapshotId,
    revision,
    plane,
    width: Math.sqrt(passable.length),
    passable: passable.buffer as ArrayBuffer,
  };
}

function path(id: number, snapshotId: number, revision: number, overrides: Partial<{
  startX: number; startY: number; goalX: number; goalY: number; plane: "land" | "naval" | "owner";
}> = {}) {
  return {
    kind: "versioned-path" as const,
    id,
    dueTick: 3,
    startX: overrides.startX ?? 0,
    startY: overrides.startY ?? 0,
    goalX: overrides.goalX ?? 4,
    goalY: overrides.goalY ?? 4,
    snapshotId,
    passableVersion: revision,
    plane: overrides.plane ?? "land",
    seed: 12345,
    sentAtEpochMs: epochNowMs(),
  };
}

function productionPath(request: ReturnType<typeof path>, passable: Uint8Array): PathResponse {
  return createPathEngine().handle({
    kind: "path",
    id: request.id,
    dueTick: request.dueTick,
    startX: request.startX,
    startY: request.startY,
    goalX: request.goalX,
    goalY: request.goalY,
    passable,
    passableVersion: request.passableVersion,
    seed: request.seed,
  });
}

describe("versioned snapshot cache and worker protocol", () => {
  it("repeats one immutable same-revision snapshot and emits only revision deltas", () => {
    const cache = new MainSnapshotCache();
    const live = grid(4);
    const first = cache.prepare(0, live);
    expect(cache.prepare(0, live)).toBe(first);
    expect(first.passable.slice()).toBe(first.passable);
    live[3] = 0;
    expect(cache.prepare(0, live).passable[3]).toBe(1);
    const second = cache.prepare(1, live);
    expect(second).not.toBe(first);
    expect([...second.indices]).toEqual([3]);
    expect([...second.values]).toEqual([0]);
    expect(first.passable[3]).toBe(1);
    expect(cache.events.map((event) => event.operation)).toEqual(["register", "update"]);
    expect(cache.retainedSnapshotCount).toBe(1);
    expect(cache.currentSnapshotBytes).toBe(16);
  });

  it("matches production A* exactly for fresh and cached same-revision requests", () => {
    const worker = new VersionedSnapshotWorker();
    const passable = grid(5);
    passable[6] = 0;
    passable[7] = 0;
    worker.handle(register(1, 0, passable));
    const first = worker.handle(path(1, 1, 0));
    const second = worker.handle(path(2, 1, 0));
    if (first.kind !== "versioned-path-result" || second.kind !== "versioned-path-result") throw new Error("expected paths");
    expect(first.response).toEqual(productionPath(path(1, 1, 0), passable));
    expect(second.response).toEqual(productionPath(path(2, 1, 0), passable));
    expect(second.pathCacheSize).toBe(1);
    expect([...second.response.waypoints]).toEqual([...first.response.waypoints]);
  });

  it("keeps old revisions immutable, handles planes independently, and evicts to bounded memory", () => {
    const worker = new VersionedSnapshotWorker(2);
    const land = grid(5);
    const naval = grid(5);
    naval[0] = 0;
    worker.handle(register(1, 0, land));
    worker.handle(register(2, 0, naval, "naval"));
    const changed = land.slice();
    changed[0] = 0;
    worker.handle({
      kind: "snapshot-update", snapshotId: 3, baseSnapshotId: 1, revision: 1, baseRevision: 0,
      plane: "land", width: 5, indices: Uint32Array.of(0), values: Uint8Array.of(0),
    });
    const oldResult = worker.handle(path(4, 1, 0));
    const newResult = worker.handle(path(5, 3, 1));
    const navalResult = worker.handle(path(6, 2, 0, { plane: "naval" }));
    if (oldResult.kind !== "versioned-path-result" || newResult.kind !== "versioned-path-result" || navalResult.kind !== "versioned-path-result") throw new Error("expected paths");
    expect(oldResult.response).toEqual(productionPath(path(4, 1, 0), land));
    expect(newResult.response).toEqual(productionPath(path(5, 3, 1), changed));
    expect(navalResult.response).toEqual(productionPath(path(6, 2, 0, { plane: "naval" }), naval));
    worker.handle({
      kind: "snapshot-update", snapshotId: 4, baseSnapshotId: 3, revision: 2, baseRevision: 1,
      plane: "land", width: 5, indices: new Uint32Array(0), values: new Uint8Array(0),
    });
    expect(worker.snapshotCount()).toBe(2);
    expect(worker.snapshotBytes()).toBe(50);
    expect(() => worker.handle(path(7, 1, 0))).toThrow("not registered");
  });

  it("rejects registration races and accepts FIFO registration before a request", () => {
    const worker = new VersionedSnapshotWorker();
    expect(() => worker.handle(path(1, 1, 0))).toThrow("not registered");
    const ack = worker.handle(register(1, 0, grid(5)));
    expect(ack).toMatchObject({ kind: "snapshot-ack", operation: "register", snapshotCount: 1 });
    expect(worker.handle(path(1, 1, 0)).kind).toBe("versioned-path-result");
    expect(() => worker.handle({
      kind: "snapshot-update", snapshotId: 2, baseSnapshotId: 99, revision: 1, baseRevision: 0,
      plane: "land", width: 5, indices: new Uint32Array(0), values: new Uint8Array(0),
    })).toThrow("base snapshot");
  });
});

function createManualWorkerFactory() {
  const outbound: VersionedWorkerRequest[] = [];
  const worker = new VersionedSnapshotWorker();
  let receive: ((event: { data: VersionedWorkerMessage }) => void) | null = null;
  const factory: VersionedWorkerFactory = () => ({
    postMessage(message) {
      outbound.push(message);
    },
    setMessageHandler(handler) {
      receive = handler;
    },
    terminate() {},
  });
  return {
    factory,
    outbound,
    deliver(message: VersionedWorkerRequest) {
      postVersionedResult((output) => receive?.({ data: output }), message, worker);
    },
  };
}

describe("production scheduler semantics with versioned transport", () => {
  it("preserves ascending application, due blocking, stale discard, and duplicate suppression", () => {
    const manual = createManualWorkerFactory();
    const candidate = createVersionedAstarCandidate(manual.factory);
    const instrumentation = new SchedulerInstrumentation({
      adapter: candidate,
      evidenceClass: "node-mock-transport",
      boundaryTick: () => 3,
      frame: () => 0,
    });
    const scheduler = instrumentation.scheduler;
    installVersionedSnapshotScheduler(scheduler, candidate.snapshots);
    const live = grid(5);
    const applied: number[] = [];
    const discarded: number[] = [];
    scheduler.requestPath(
      { startX: 0, startY: 0, goalX: 4, goalY: 4 },
      { issueTick: 1, seed: 1, passability: live, onApply: () => applied.push(1), onDiscard: () => discarded.push(1) },
    );
    scheduler.setPassabilityVersion(1);
    live[0] = 0;
    scheduler.requestPath(
      { startX: 1, startY: 0, goalX: 4, goalY: 4 },
      { issueTick: 1, seed: 2, passability: live, onApply: () => applied.push(2), onDiscard: () => discarded.push(2) },
    );
    const registerMessage = manual.outbound.find((message) => message.kind === "snapshot-register")!;
    const updateMessage = manual.outbound.find((message) => message.kind === "snapshot-update")!;
    const first = manual.outbound.find((message) => message.kind === "versioned-path" && message.id === 1)!;
    const second = manual.outbound.find((message) => message.kind === "versioned-path" && message.id === 2)!;
    manual.deliver(registerMessage);
    manual.deliver(updateMessage);
    manual.deliver(second);
    expect(scheduler.pump(3)).toBe(false);
    expect(scheduler.blockedTicks).toBe(1);
    manual.deliver(first);
    manual.deliver(first);
    expect(scheduler.pump(3)).toBe(true);
    expect(applied).toEqual([2]);
    expect(discarded).toEqual([1]);
    expect(scheduler.pendingCount).toBe(0);
    expect(candidate.snapshots.events).toHaveLength(2);
  });
});

describe("full-game versioned async replay", () => {
  const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;

  it("matches synchronous production A* and sends incremental revision updates", async () => {
    const synchronous = runBenchmark({
      ...config,
      candidate: createCurrentAstarCandidate(),
      evidenceClass: "node-inline",
    });
    const candidate = createVersionedAstarCandidate(createLocalVersionedWorkerFactory());
    const asynchronous = await runBenchmarkAsync({
      ...config,
      candidate,
      evidenceClass: "node-mock-transport",
    });
    expect(logicalBenchmarkString(asynchronous)).toBe(logicalBenchmarkString(synchronous));
    const protocol = candidate.protocolTelemetry();
    expect(protocol.snapshotSends[0]?.operation).toBe("register");
    expect(protocol.snapshotSends.length).toBeGreaterThan(1);
    expect(protocol.snapshotSends.slice(1).every((event) => event.operation === "update")).toBe(true);
    expect(protocol.mainRetainedSnapshotCount).toBe(1);
    expect(Math.max(...protocol.responses.map((response) => response.snapshotCount))).toBeLessThanOrEqual(2);
    expect(protocol.requests.every((request) => request.requestPayloadBytes < 500)).toBe(true);
  }, 30_000);

  it("repeats exact logical replay with delayed out-of-frame worker delivery", async () => {
    const runs = [];
    for (let index = 0; index < 2; index += 1) {
      runs.push(await runBenchmarkAsync({
        ...config,
        candidate: createVersionedAstarCandidate(createLocalVersionedWorkerFactory(10)),
        evidenceClass: "node-mock-transport",
      }));
    }
    expect(logicalBenchmarkString(runs[0]!)).toBe(logicalBenchmarkString(runs[1]!));
    expect(runs[0]!.finalFullStateHash).toBe(runs[1]!.finalFullStateHash);
    expect(runs[0]!.frames).toBeGreaterThan(config.ticks);
    expect(runs[0]!.scheduler.blockedTicks).toBeGreaterThan(0);
  }, 60_000);
});

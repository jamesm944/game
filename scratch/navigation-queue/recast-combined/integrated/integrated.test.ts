import { beforeAll, describe, expect, it } from "vitest";
import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import { SchedulerInstrumentation } from "../../../full-game-movement/harness/instrumentation";
import { runBenchmark } from "../../../full-game-movement/harness/runner";
import { scenarioByName } from "../../../full-game-movement/harness/scenarios";
import { logicalBenchmarkString } from "../../../full-game-movement/harness/browser/full-game/replay";
import { createRecastCandidate } from "../../../phase2-navigation/recast-corridor/corridor-candidate";
import { RecastRouteEngine as FullRebuildEngine } from "../../../phase2-navigation/recast-corridor/corridor-engine";
import { CombinedRecastEngine, initializeCombinedRecast } from "../combined-engine";
import { createCombinedRecastCandidate, createLocalCombinedWorkerFactory, type CombinedRouteRecord } from "./adapter";
import { runBenchmarkAsync } from "./async-runner";
import { postCombinedResult } from "./combined.worker";
import { epochNowMs, type VersionedPathRequestMessage, type VersionedWorkerMessage, type VersionedWorkerRequest, type VersionedWorkerFactory } from "./protocol";
import { installVersionedSnapshotScheduler } from "./snapshot-cache";
import { CombinedSnapshotWorker, type CombinedPathEngine } from "./worker-handler";

beforeAll(async () => { await initializeCombinedRecast(); }, 30_000);

function grid(width: number): Uint8Array { return new Uint8Array(width * width).fill(1); }
function request(id: number, passable: Uint8Array, version: number, startX = 0, startY = 0, goalX = Math.sqrt(passable.length) - 1, goalY = goalX): PathRequest {
  return { kind: "path", id, dueTick: version + 2, startX, startY, goalX, goalY, passable, passableVersion: version, seed: 171 };
}
function register(snapshotId: number, revision: number, passable: Uint8Array, plane: "land" | "naval" | "owner" = "land") {
  return { kind: "snapshot-register" as const, snapshotId, revision, plane, width: Math.sqrt(passable.length), passable: passable.buffer as ArrayBuffer };
}
function path(id: number, snapshotId: number, revision: number, plane: "land" | "naval" | "owner" = "land"): VersionedPathRequestMessage {
  return { kind: "versioned-path", id, dueTick: 3, startX: 0, startY: 0, goalX: 4, goalY: 4, snapshotId, passableVersion: revision, plane, seed: 171, sentAtEpochMs: epochNowMs() };
}
function sameRoute(actual: PathResponse, expected: PathResponse): boolean {
  return actual.id === expected.id && actual.ok === expected.ok && actual.cost === expected.cost && actual.waypoints.length === expected.waypoints.length && actual.waypoints.every((value, index) => value === expected.waypoints[index]);
}
function compareExact(combined: CombinedRecastEngine, full: FullRebuildEngine, input: PathRequest): PathResponse {
  const actual = combined.handle(input, () => 0);
  const expected = full.handle(input, () => 0);
  expect(sameRoute(actual, expected), `route ${input.id} revision ${input.passableVersion}`).toBe(true);
  return actual;
}

describe("combined exact-tile mutation correctness", () => {
  it("matches exact full Recast through repeated one-tile gate close/reopen", () => {
    const combined = new CombinedRecastEngine();
    const full = new FullRebuildEngine();
    const width = 12;
    const open = grid(width);
    for (let y = 0; y < width; y += 1) if (y !== 4) open[y * width + 5] = 0;
    const closed = open.slice();
    closed[4 * width + 5] = 0;
    try {
      const baseline = compareExact(combined, full, request(1, open, 0, 0, 4, 11, 4));
      for (let cycle = 1; cycle <= 10; cycle += 1) {
        expect(compareExact(combined, full, request(cycle * 2, closed, cycle * 2 - 1, 0, 4, 11, 4)).ok).toBe(false);
        expect(compareExact(combined, full, request(cycle * 2 + 1, open, cycle * 2, 0, 4, 11, 4)).waypoints).toEqual(baseline.waypoints);
      }
      expect(combined.metrics.geometryRejections).toBe(0);
      expect(combined.metrics.revisionVisibilityFailures).toBe(0);
      expect(combined.metrics.revisionCacheEvictions).toBeGreaterThan(0);
    } finally { combined.dispose(); full.dispose(); }
  }, 30_000);

  it("matches exact full Recast for a 104x104 multi-tile mutation and reopen", () => {
    const combined = new CombinedRecastEngine();
    const full = new FullRebuildEngine();
    const width = 120;
    const open = grid(width);
    const blocked = open.slice();
    for (let y = 8; y < 112; y += 1) for (let x = 8; x < 112; x += 1) blocked[y * width + x] = 0;
    try {
      compareExact(combined, full, request(1, open, 0));
      compareExact(combined, full, request(2, blocked, 1));
      compareExact(combined, full, request(3, open, 2));
      expect(combined.metrics.mutationChangedTiles).toBe(2 * 104 * 104);
      expect(combined.metrics.maxRasterizedNavTilesPerRevision).toBeGreaterThan(100);
      expect(combined.metrics.geometryRejections).toBe(0);
    } finally { combined.dispose(); full.dispose(); }
  }, 30_000);

  it("matches exact full Recast with 576 isolated blocked cells without obstacle fallback", () => {
    const combined = new CombinedRecastEngine();
    const full = new FullRebuildEngine();
    const width = 48;
    const passable = grid(width);
    for (let y = 1; y < width; y += 2) for (let x = 1; x < width; x += 2) passable[y * width + x] = 0;
    try {
      compareExact(combined, full, request(1, passable, 0, 0, 0, 47, 46));
      expect(combined.metrics.changedTilesObserved).toBe(width * width);
      expect(combined.metrics.dynamicObstacleAdds).toBe(0);
      expect(combined.metrics.obstacleCapacityFailures).toBe(0);
      expect(combined.metrics.geometryRejections).toBe(0);
    } finally { combined.dispose(); full.dispose(); }
  }, 30_000);

  it("bounds mesh revisions and exactly handles stale, out-of-order, and same-version bytes", () => {
    const combined = new CombinedRecastEngine();
    const full = new FullRebuildEngine();
    const width = 12;
    const open = grid(width);
    const closed = open.slice();
    for (let y = 0; y < width; y += 1) closed[y * width + 5] = 0;
    try {
      compareExact(combined, full, request(1, open, 0, 0, 4, 11, 4));
      compareExact(combined, full, request(2, closed, 1, 0, 4, 11, 4));
      compareExact(combined, full, request(3, open, 2, 0, 4, 11, 4));
      compareExact(combined, full, request(4, closed, 1, 0, 4, 11, 4));
      expect(combined.metrics.outOfOrderRebuilds).toBe(0);
      compareExact(combined, full, request(5, open, 3, 0, 4, 11, 4));
      compareExact(combined, full, request(6, open, 0, 0, 4, 11, 4));
      expect(combined.metrics.outOfOrderRebuilds).toBe(1);
      compareExact(combined, full, request(7, closed, 3, 0, 4, 11, 4));
      expect(combined.metrics.snapshotMismatches).toBe(1);
      compareExact(combined, full, request(8, open, 3, 0, 4, 11, 4));
      expect(combined.metrics.ephemeralSnapshotBuilds).toBe(2);
      expect(combined.candidateMetrics().revisionCacheEntries).toBe(2);
      expect(combined.candidateMetrics().snapshotCacheBytes).toBe(2 * width * width);
      expect(combined.metrics.revisionCacheEvictions).toBe(2);
    } finally { combined.dispose(); full.dispose(); }
  }, 30_000);
});

describe("acknowledged full/delta protocol and scheduler races", () => {
  it("keeps two immutable revisions per plane and evicts older snapshots", () => {
    const worker = new CombinedSnapshotWorker();
    const land = grid(5);
    const naval = grid(5);
    worker.handle(register(1, 0, land));
    worker.handle(register(10, 0, naval, "naval"));
    worker.handle({ kind: "snapshot-update", snapshotId: 2, baseSnapshotId: 1, revision: 1, baseRevision: 0, plane: "land", width: 5, indices: Uint32Array.of(6), values: Uint8Array.of(0) });
    worker.handle({ kind: "snapshot-update", snapshotId: 3, baseSnapshotId: 2, revision: 2, baseRevision: 1, plane: "land", width: 5, indices: Uint32Array.of(7), values: Uint8Array.of(0) });
    expect(worker.snapshotCount()).toBe(2);
    expect(worker.snapshotBytes()).toBe(50);
    expect(worker.snapshotCount("naval")).toBe(1);
    expect(() => worker.handle(path(1, 1, 0))).toThrow("not registered");
    expect(worker.handle(path(2, 2, 1)).kind).toBe("versioned-path-result");
    worker.dispose();
  });

  it("preserves IDs, due ticks, ascending application, stale discard, and duplicate suppression under reversed delivery", async () => {
    const outbound: VersionedWorkerRequest[] = [];
    const worker = new CombinedSnapshotWorker();
    let receive: ((event: { data: VersionedWorkerMessage }) => void) | null = null;
    const factory: VersionedWorkerFactory = () => ({
      postMessage(message) { outbound.push(message); },
      setMessageHandler(handler) { receive = handler; queueMicrotask(() => receive?.({ data: { kind: "ready", initializationMs: 0, recastNavigationVersion: "0.43.0", wasm: "@recast-navigation/wasm-compat" } })); },
      terminate() { worker.dispose(); },
    });
    const candidate = createCombinedRecastCandidate(factory);
    await candidate.ready;
    const instrumentation = new SchedulerInstrumentation({ adapter: candidate, evidenceClass: "node-mock-transport", boundaryTick: () => 3, frame: () => 0 });
    const scheduler = instrumentation.scheduler;
    installVersionedSnapshotScheduler(scheduler, candidate.snapshots);
    const live = grid(5);
    const applied: number[] = [];
    const discarded: number[] = [];
    scheduler.requestPath({ startX: 0, startY: 0, goalX: 4, goalY: 4 }, { issueTick: 1, seed: 1, passability: live, onApply: () => applied.push(1), onDiscard: () => discarded.push(1) });
    scheduler.setPassabilityVersion(1);
    live[0] = 0;
    scheduler.requestPath({ startX: 1, startY: 0, goalX: 4, goalY: 4 }, { issueTick: 1, seed: 2, passability: live, onApply: () => applied.push(2), onDiscard: () => discarded.push(2) });
    const registration = outbound.find((message) => message.kind === "snapshot-register")!;
    const update = outbound.find((message) => message.kind === "snapshot-update")!;
    const first = outbound.find((message) => message.kind === "versioned-path" && message.id === 1)!;
    const second = outbound.find((message) => message.kind === "versioned-path" && message.id === 2)!;
    const deliver = (message: VersionedWorkerRequest) => postCombinedResult((output) => receive?.({ data: output }), message, worker);
    deliver(registration); deliver(update); deliver(second);
    expect(scheduler.pump(3)).toBe(false);
    expect(scheduler.blockedTicks).toBe(1);
    deliver(first); deliver(first);
    expect(scheduler.pump(3)).toBe(true);
    expect(applied).toEqual([2]);
    expect(discarded).toEqual([1]);
    expect(scheduler.pendingCount).toBe(0);
    expect(candidate.protocolTelemetry().requests.map((entry) => [entry.id, entry.dueTick])).toEqual([[1, 3], [2, 3]]);
    candidate.dispose?.();
  }, 30_000);

  it("surfaces injected native engine failure instead of converting it to no-path", async () => {
    const failingEngine: CombinedPathEngine = {
      handle() { throw new Error("injected native findPath failure"); },
      candidateMetrics() { return { revisionCacheEntries: 0 }; },
      dispose() {},
    };
    const candidate = createCombinedRecastCandidate(createLocalCombinedWorkerFactory(0, () => failingEngine));
    await candidate.ready;
    const transport = candidate.createTransport({ evidenceClass: "node-mock-transport", now: () => 0, onRequest: () => {}, onResponse: () => { throw new Error("failure must not produce a response"); } });
    const passable = candidate.snapshots.prepare(0, grid(5)).passable;
    transport.send(request(1, passable, 0, 0, 0, 4, 4));
    expect(() => candidate.beforeFrame?.()).toThrow("injected native findPath failure");
    expect(candidate.protocolTelemetry().errors[0]).toContain("request 1");
    expect(candidate.routes).toHaveLength(0);
    candidate.dispose?.();
  });

  it("matches corrected Node Recast routes, logical replay, and final hash with delayed delivery", async () => {
    const config = { scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400 } as const;
    const oracle = await createRecastCandidate();
    const expectedRoutes: CombinedRouteRecord[] = [];
    const expected = runBenchmark({ ...config, evidenceClass: "node-inline", candidate: {
      ...oracle,
      createTransport(context) {
        return oracle.createTransport({ ...context, onResponse(response, computeMs) {
          expectedRoutes.push({ id: response.id, ok: response.ok, cost: response.cost, waypoints: Array.from(response.waypoints) });
          context.onResponse(response, computeMs);
        } });
      },
    } });
    const candidate = createCombinedRecastCandidate(createLocalCombinedWorkerFactory(20));
    await candidate.ready;
    const actual = await runBenchmarkAsync({ ...config, candidate, evidenceClass: "node-mock-transport" });
    expect(candidate.routes).toEqual(expectedRoutes);
    expect(logicalBenchmarkString(actual)).toBe(logicalBenchmarkString(expected));
    expect(actual.finalFullStateHash).toBe(expected.finalFullStateHash);
    expect(actual.finalFullStateHash).toBe("e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f");
    const protocol = candidate.protocolTelemetry();
    expect(protocol.errors).toEqual([]);
    expect(protocol.snapshotSends[0]?.operation).toBe("register");
    expect(protocol.snapshotSends.slice(1).every((event) => event.operation === "update")).toBe(true);
    expect(protocol.snapshotAcks).toHaveLength(protocol.snapshotSends.length);
    expect(Math.max(...protocol.responses.map((entry) => entry.snapshotCount))).toBeLessThanOrEqual(2);
    expect(protocol.requests.every((entry, index) => entry.id === index + 1 && entry.dueTick === actual.pathRequests[index]?.dueTick)).toBe(true);
    expect(actual.frames).toBeGreaterThan(config.ticks);
    expect(actual.scheduler.blockedTicks).toBeGreaterThan(0);
  }, 60_000);
});

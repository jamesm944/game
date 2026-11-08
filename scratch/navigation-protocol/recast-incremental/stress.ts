import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { RecastRouteEngine as FullRebuildEngine } from "../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "./incremental-candidate";
import { RecastRouteEngine as IncrementalEngine } from "./incremental-engine";

interface Snapshot {
  readonly passable: Uint8Array;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
}

interface CaseSpec {
  readonly name: string;
  readonly width: number;
  readonly snapshots: readonly Snapshot[];
}

function request(id: number, snapshot: Snapshot, version: number): PathRequest {
  return {
    kind: "path", id, dueTick: version + 2,
    startX: snapshot.startX, startY: snapshot.startY,
    goalX: snapshot.goalX, goalY: snapshot.goalY,
    passable: snapshot.passable, passableVersion: version, seed: 169,
  };
}

function responseSummary(response: PathResponse) {
  return { ok: response.ok, waypoints: Array.from(response.waypoints), cost: response.cost };
}

function snapshotHash(snapshot: Snapshot): string {
  return createHash("sha256").update(snapshot.passable).digest("hex");
}

function runCase(spec: CaseSpec) {
  const incremental = new IncrementalEngine();
  const full = new FullRebuildEngine();
  const revisions = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  let previous = incremental.candidateMetrics();
  try {
    for (let version = 0; version < spec.snapshots.length; version += 1) {
      const snapshot = spec.snapshots[version]!;
      const input = request(version + 1, snapshot, version);
      const now = () => performance.now();
      const actual = incremental.handle(input, now);
      const expected = full.handle(input, now);
      if (actual.ok !== expected.ok) throw new Error(`${spec.name} revision ${version}: outcome mismatch`);
      const current = incremental.candidateMetrics();
      revisions.push({
        revision: version,
        snapshotHash: snapshotHash(snapshot),
        outcomeEqual: true,
        incremental: responseSummary(actual),
        fullRebuild: responseSummary(expected),
        visibleRevision: current.visibleRevision,
        lastAcknowledgedRevision: current.lastAcknowledgedRevision,
        incrementalBaseActive: current.incrementalBaseActive,
        liveObstacles: current.liveObstacles,
        snapshotCacheBytes: current.snapshotCacheBytes,
        delta: {
          incrementalUpdateMs: Number(current.totalIncrementalUpdateMs) - Number(previous.totalIncrementalUpdateMs),
          tileCacheUpdateCalls: Number(current.tileCacheUpdateCalls) - Number(previous.tileCacheUpdateCalls),
          queueDrains: Number(current.queueDrains) - Number(previous.queueDrains),
          navTilesTouchedRequested: Number(current.navTilesTouchedRequested) - Number(previous.navTilesTouchedRequested),
          dynamicObstacleAdds: Number(current.dynamicObstacleAdds) - Number(previous.dynamicObstacleAdds),
          dynamicObstacleRemoves: Number(current.dynamicObstacleRemoves) - Number(previous.dynamicObstacleRemoves),
          guardedFallbacks: Number(current.guardedFallbacks) - Number(previous.guardedFallbacks),
          mutationRebuilds: Number(current.mutationRebuilds) - Number(previous.mutationRebuilds),
        },
      });
      previous = current;
    }
    return {
      name: spec.name,
      width: spec.width,
      wallClockMs: performance.now() - started,
      jsHeapUsedBeforeBytes: heapBefore,
      jsHeapUsedAfterBytes: process.memoryUsage().heapUsed,
      revisions,
      incrementalMetrics: incremental.candidateMetrics(),
      fullRebuildMetrics: full.candidateMetrics(),
    };
  } finally {
    incremental.dispose();
    full.dispose();
  }
}

function open(width: number): Uint8Array {
  return new Uint8Array(width * width).fill(1);
}

function endpoints(passable: Uint8Array, width = 120): Snapshot {
  return { passable, startX: 0, startY: 0, goalX: width - 1, goalY: width - 1 };
}

function repeatedGates(): CaseSpec {
  const width = 12;
  const initial = open(width);
  for (let y = 0; y < width; y += 1) if (y !== 4) initial[y * width + 5] = 0;
  const closed = initial.slice();
  closed[4 * width + 5] = 0;
  const snapshots: Snapshot[] = [];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    snapshots.push(endpoints(initial, width), endpoints(closed, width));
  }
  return { name: "repeated-one-tile-gate-close-reopen", width, snapshots };
}

function buildingAddRemove(): CaseSpec {
  const width = 40;
  const initial = open(width);
  const building = initial.slice();
  for (let y = 8; y < 12; y += 1) for (let x = 8; x < 12; x += 1) building[y * width + x] = 0;
  return { name: "building-add-remove", width, snapshots: [endpoints(initial, width), endpoints(building, width), endpoints(initial, width)] };
}

function mutationBurst(): CaseSpec {
  const width = 120;
  const initial = open(width);
  const burst = initial.slice();
  for (const [ox, oy] of [[8, 8], [40, 16], [72, 40], [96, 80], [16, 96]] as const) {
    for (let y = oy; y < oy + 4; y += 1) for (let x = ox; x < ox + 4; x += 1) burst[y * width + x] = 0;
  }
  return { name: "five-rectangle-mutation-burst", width, snapshots: [endpoints(initial, width), endpoints(burst, width), endpoints(initial, width)] };
}

function largeObstacle(): CaseSpec {
  const width = 120;
  const initial = open(width);
  const blocked = initial.slice();
  for (let y = 8; y < 112; y += 1) for (let x = 8; x < 112; x += 1) blocked[y * width + x] = 0;
  return { name: "large-104x104-obstacle-multi-tile-drain", width, snapshots: [endpoints(initial, width), endpoints(blocked, width), endpoints(initial, width)] };
}

function overCapacity(): CaseSpec {
  const width = 48;
  const passable = open(width);
  for (let y = 1; y < width; y += 2) for (let x = 1; x < width; x += 2) passable[y * width + x] = 0;
  return { name: "576-live-obstacle-requests-capacity-fallback", width, snapshots: [{ passable, startX: 0, startY: 0, goalX: 47, goalY: 46 }] };
}

await initializeRecast();
const cases = [repeatedGates(), buildingAddRemove(), mutationBurst(), largeObstacle(), overCapacity()];
const result = {
  schemaVersion: 1,
  ticket: 169,
  recastNavigationVersion: "0.43.0",
  host: { node: process.version, arch: process.arch, platform: process.platform },
  outcomeEqualityRequired: true,
  waypointEqualityRequired: false,
  cases: cases.map(runCase),
};
const output = new URL("./results/mutation-stress.json", import.meta.url);
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output: output.pathname,
  cases: result.cases.map((entry) => ({
    name: entry.name,
    revisions: entry.revisions.length,
    wallClockMs: entry.wallClockMs,
    incrementalRevisions: entry.incrementalMetrics.incrementalRevisions,
    tileCacheUpdateCalls: entry.incrementalMetrics.tileCacheUpdateCalls,
    maxUpdateCallsPerRevision: entry.incrementalMetrics.maxUpdateCallsPerRevision,
    guardedFallbacks: entry.incrementalMetrics.guardedFallbacks,
    obstacleCapacityFailures: entry.incrementalMetrics.obstacleCapacityFailures,
  })),
}, null, 2));

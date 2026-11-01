// Wayfinder #173 Node-side WASM memory probe (supplement; NOT browser evidence).
// Reports process.memoryUsage() around combined-engine init/build/query/dispose so
// WASM linear-memory growth is at least bounded in Node, where wasm ArrayBuffers
// surface in `external`/`arrayBuffers`. Chrome exposes no equivalent per-worker
// native allocator counter to this harness (see findings).
import { writeFileSync } from "node:fs";
import type { PathRequest } from "../../../src/sim/path/protocol";
import {
  CombinedRecastEngine,
  initializeCombinedRecast,
} from "../recast-combined/combined-engine";

function usage(label: string) {
  const m = process.memoryUsage();
  return {
    label,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}
function request(
  id: number,
  passable: Uint8Array,
  version: number,
): PathRequest {
  return {
    kind: "path",
    id,
    dueTick: version + 2,
    startX: 0,
    startY: 60,
    goalX: 119,
    goalY: 60,
    passable,
    passableVersion: version,
    seed: 173,
  };
}

const rows = [usage("before-init")];
await initializeCombinedRecast();
rows.push(usage("after-wasm-init"));
const engine = new CombinedRecastEngine();
const width = 120;
const open = new Uint8Array(width * width).fill(1);
// Narrow wall with a 4-cell gate, mirroring narrow-mutation-120 geometry.
const walled = open.slice();
for (let y = 0; y < width; y += 1)
  if (y < 59 || y > 62) walled[y * width + 60] = 0;
engine.handle(request(1, walled, 0), () => 0);
rows.push(usage("after-initial-full-build"));
const initialMetrics = engine.candidateMetrics();
// Gate mutation: close then reopen pieces of the gate across revisions (revision churn).
let current = walled;
for (let revision = 1; revision <= 10; revision += 1) {
  const next = current.slice();
  next[60 * width + 60] = revision % 2 === 0 ? 1 : 0;
  next[61 * width + 60] = revision % 3 === 0 ? 0 : 1;
  engine.handle(request(1 + revision, next, revision), () => 0);
  current = next;
  if (revision === 1) rows.push(usage("after-first-incremental-revision"));
}
rows.push(usage("after-10-revision-churn"));
for (let index = 0; index < 1000; index += 1)
  engine.handle(request(100 + index, current, 10), () => 0);
rows.push(usage("after-1000-queries-same-revision"));
const finalMetrics = engine.candidateMetrics();
engine.dispose();
rows.push(usage("after-dispose"));
if (globalThis.gc) {
  globalThis.gc();
  rows.push(usage("after-dispose-and-gc"));
}

const output = {
  schema: "wayfinder-173-node-wasm-memory-probe-v1",
  evidenceScope:
    "node-process-memoryUsage-around-combined-recast-engine; not browser allocator telemetry",
  node: process.version,
  rows,
  deltasExternalBytes: {
    wasmInit: rows[1]!.external - rows[0]!.external,
    initialBuild: rows[2]!.external - rows[1]!.external,
    firstIncremental: rows[3]!.external - rows[2]!.external,
    churnToQueries: rows[5]!.external - rows[3]!.external,
  },
  initialMetrics: {
    compressedLayerBytes: initialMetrics.compressedLayerBytes,
    rasterizedNavTiles: initialMetrics.rasterizedNavTiles,
    revisionCacheEntries: initialMetrics.revisionCacheEntries,
    snapshotCacheBytes: initialMetrics.snapshotCacheBytes,
  },
  finalMetrics: {
    compressedLayerBytes: finalMetrics.compressedLayerBytes,
    rasterizedNavTiles: finalMetrics.rasterizedNavTiles,
    reusedCompressedLayers: finalMetrics.reusedCompressedLayers,
    revisionCacheEntries: finalMetrics.revisionCacheEntries,
    revisionCacheCapacity: finalMetrics.revisionCacheCapacity,
    snapshotCacheBytes: finalMetrics.snapshotCacheBytes,
    revisionBuilds: finalMetrics.revisionBuilds,
    incrementalRevisionBuilds: finalMetrics.incrementalRevisionBuilds,
    totalRevisionBuildMs: finalMetrics.totalRevisionBuildMs,
    totalIncrementalUpdateMs: finalMetrics.totalIncrementalUpdateMs,
  },
};
const target = new URL("./results/node-memory-probe.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));

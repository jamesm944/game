import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult, PathRequestMetric } from "../../full-game-movement/harness/types";
import type { RenderFrameMetric } from "./renderer";
import type { QueueProtocolTelemetry, QueueResponseTelemetry } from "./adapter";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = [1, 2, 3, 4, 5].flatMap((iteration) => [
  `chrome-fifo-iteration-${iteration}.json`,
  `chrome-batch-32-iteration-${iteration}.json`,
]);

type Sample = BenchmarkResult & {
  readonly renderFrames: readonly RenderFrameMetric[];
  readonly protocol: QueueProtocolTelemetry;
  readonly workloadComposition: Record<string, number>;
};
type RawRun = {
  readonly browserVersion: string;
  readonly userAgent: string;
  readonly iteration: number;
  readonly policyOrder: readonly string[];
  readonly samples: readonly Sample[];
};
type Distribution = { readonly n: number; readonly p50: number; readonly p95: number; readonly max: number };

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]!;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1)! };
}

function joinedRequests(sample: Sample) {
  const byId = new Map<number, PathRequestMetric>(sample.pathRequests.map((request) => [request.id, request]));
  const seen = new Set<number>();
  const joined: Array<{ request: PathRequestMetric; response: QueueResponseTelemetry }> = [];
  for (const response of sample.protocol.responses) {
    if (seen.has(response.id)) throw new Error(`duplicate response id ${response.id}`);
    seen.add(response.id);
    const request = byId.get(response.id);
    if (!request) throw new Error(`response ${response.id} has no path request`);
    if (request.computeMs !== undefined && Math.abs(request.computeMs - response.computeMs) > 1e-9) {
      throw new Error(`compute telemetry mismatch for request ${response.id}`);
    }
    joined.push({ request, response });
  }
  return joined;
}
type Joined = ReturnType<typeof joinedRequests>;

function applyTickMetrics(sample: Sample) {
  const applyByTick = new Map<number, { count: number; costMs: number }>();
  for (const request of sample.pathRequests) {
    if (request.outcome !== "applied" || request.applyTick === undefined) continue;
    const current = applyByTick.get(request.applyTick) ?? { count: 0, costMs: 0 };
    current.count += 1;
    current.costMs += request.applyCostMs ?? 0;
    applyByTick.set(request.applyTick, current);
  }
  return [...applyByTick.values()].filter((entry) => entry.count > 0);
}

function metrics(sample: Sample, joined: Joined) {
  const inClass = (requestClass: "leader" | "repath") => joined.filter((entry) => entry.response.requestClass === requestClass);
  const leader = inClass("leader");
  const repath = inClass("repath");
  const nonzeroApplyTicks = applyTickMetrics(sample);
  const outcomeCounts = Object.fromEntries(["applied", "stale-discarded", "pending"].map((outcome) => [
    outcome, sample.pathRequests.filter((request) => request.outcome === outcome).length,
  ]));
  return {
    responseMs: {
      leader: distribution(leader.map((entry) => entry.request.issueToResponseMs!)),
      repath: distribution(repath.map((entry) => entry.request.issueToResponseMs!)),
    },
    workerQueueMs: {
      all: distribution(joined.map((entry) => entry.response.workerQueueMs)),
      leader: distribution(leader.map((entry) => entry.response.workerQueueMs)),
      repath: distribution(repath.map((entry) => entry.response.workerQueueMs)),
    },
    workerComputeMs: {
      all: distribution(joined.map((entry) => entry.response.computeMs)),
      leader: distribution(leader.map((entry) => entry.response.computeMs)),
      repath: distribution(repath.map((entry) => entry.response.computeMs)),
    },
    actualRafIntervalMs: distribution(sample.renderFrames.slice(1).map((frame) => frame.intervalMs)),
    renderCpuMs: distribution(sample.renderFrames.map((frame) => frame.renderCpuMs)),
    applyCostMs: {
      perAppliedRequest: distribution(sample.pathRequests.flatMap((request) => request.outcome === "applied" && request.applyCostMs !== undefined ? [request.applyCostMs] : [])),
      perNonzeroApplyTick: distribution(nonzeroApplyTicks.map((entry) => entry.costMs)),
      nonzeroApplyTicks: nonzeroApplyTicks.length,
      maxApplicationsOnOneTick: Math.max(0, ...nonzeroApplyTicks.map((entry) => entry.count)),
    },
    wallClockMs: sample.wallClockMs,
    frames: sample.frames,
    blockedTicks: sample.scheduler.blockedTicks,
    finalTick: sample.finalTick,
    finalFullStateHash: sample.finalFullStateHash,
    pathRequests: sample.pathRequests.length,
    joinedResponses: joined.length,
    unmatchedResponses: sample.protocol.responses.length - joined.length,
    pendingWithoutResponse: sample.pathRequests.filter((request) => request.outcome === "pending" && !seenResponse(sample, request.id)).length,
    outcomeCounts,
    crowdStates: sample.crowdStates,
    workloadComposition: sample.workloadComposition,
    protocol: {
      pathRequestMessages: sample.protocol.pathRequestMessages,
      pathResultMessages: sample.protocol.pathResultMessages,
      maxBatchSize: sample.protocol.maxBatchSize,
      maxQueuedRequests: sample.protocol.maxQueuedRequests,
      coalescingEligibleResponses: sample.protocol.coalescingEligibleResponses,
      coalescedResponses: sample.protocol.coalescedResponses,
      responseWaypointBytes: sample.protocol.responses.reduce((sum, response) => sum + response.responsePayloadBytes, 0),
      fullSnapshotPayloadBytes: sample.candidateMetrics.fullSnapshotPayloadBytes,
      deltaSnapshotPayloadBytes: sample.candidateMetrics.deltaSnapshotPayloadBytes,
      snapshotPreparationCount: sample.candidateMetrics.snapshotPreparationCount,
      sameRevisionRequests: sample.candidateMetrics.sameRevisionRequests,
      maxWorkerSnapshotCount: sample.protocol.maxWorkerSnapshotCount,
      maxWorkerSnapshotBytes: sample.protocol.maxWorkerSnapshotBytes,
      maxPathCacheSize: sample.protocol.maxPathCacheSize,
    },
  };
}
type Metrics = ReturnType<typeof metrics>;

// Avoid retaining another large set in the hot analysis loop.
function seenResponse(sample: Sample, id: number): boolean {
  return sample.protocol.responses.some((response) => response.id === id);
}

function pooledMetric(runs: readonly { sample: Sample; joined: Joined }[]): Metrics {
  const synthetic = runs[0]!.sample;
  const joined = runs.flatMap((run) => run.joined);
  const combined: Sample = {
    ...synthetic,
    frames: runs.reduce((sum, run) => sum + run.sample.frames, 0),
    wallClockMs: runs.reduce((sum, run) => sum + run.sample.wallClockMs, 0),
    pathRequests: runs.flatMap((run) => run.sample.pathRequests),
    renderFrames: runs.flatMap((run) => run.sample.renderFrames),
    scheduler: {
      ...synthetic.scheduler,
      blockedTicks: runs.reduce((sum, run) => sum + run.sample.scheduler.blockedTicks, 0),
    },
    protocol: {
      ...synthetic.protocol,
      responses: joined.map((entry) => entry.response),
      pathRequestMessages: runs.reduce((sum, run) => sum + run.sample.protocol.pathRequestMessages, 0),
      pathResultMessages: runs.reduce((sum, run) => sum + run.sample.protocol.pathResultMessages, 0),
      maxBatchSize: Math.max(...runs.map((run) => run.sample.protocol.maxBatchSize)),
      maxQueuedRequests: Math.max(...runs.map((run) => run.sample.protocol.maxQueuedRequests)),
      coalescingEligibleResponses: runs.reduce((sum, run) => sum + run.sample.protocol.coalescingEligibleResponses, 0),
      coalescedResponses: runs.reduce((sum, run) => sum + run.sample.protocol.coalescedResponses, 0),
      maxWorkerSnapshotCount: Math.max(...runs.map((run) => run.sample.protocol.maxWorkerSnapshotCount)),
      maxWorkerSnapshotBytes: Math.max(...runs.map((run) => run.sample.protocol.maxWorkerSnapshotBytes)),
      maxPathCacheSize: Math.max(...runs.map((run) => run.sample.protocol.maxPathCacheSize)),
    },
    candidateMetrics: {
      ...synthetic.candidateMetrics,
      fullSnapshotPayloadBytes: runs.reduce((sum, run) => sum + Number(run.sample.candidateMetrics.fullSnapshotPayloadBytes), 0),
      deltaSnapshotPayloadBytes: runs.reduce((sum, run) => sum + Number(run.sample.candidateMetrics.deltaSnapshotPayloadBytes), 0),
      snapshotPreparationCount: runs.reduce((sum, run) => sum + Number(run.sample.candidateMetrics.snapshotPreparationCount), 0),
      sameRevisionRequests: runs.reduce((sum, run) => sum + Number(run.sample.candidateMetrics.sameRevisionRequests), 0),
    },
  };
  const result = metrics(combined, joined);
  // Apply ticks are run-local boundaries; pool their observations, never sum
  // independent runs that happen to share the same simulation tick number.
  const applyTicks = runs.flatMap((run) => applyTickMetrics(run.sample));
  return {
    ...result,
    applyCostMs: {
      ...result.applyCostMs,
      perNonzeroApplyTick: distribution(applyTicks.map((entry) => entry.costMs)),
      nonzeroApplyTicks: applyTicks.length,
      maxApplicationsOnOneTick: Math.max(0, ...applyTicks.map((entry) => entry.count)),
    },
  };
}

const runs: Array<{ file: string; raw: RawRun; sample: Sample; joined: Joined }> = [];
for (const file of FILES) {
  const raw = JSON.parse(await readFile(path.join(ROOT, "results", file), "utf8")) as RawRun;
  if (raw.samples.length !== 1) throw new Error(`${file}: expected exactly one measured sample`);
  const sample = raw.samples[0]!;
  if (sample.finalTick !== 3600 || sample.requestedTicks !== 3600) throw new Error(`${file}: incomplete measured run`);
  runs.push({ file, raw, sample, joined: joinedRequests(sample) });
}
const iterations = runs.map((run) => ({ file: run.file, iteration: run.raw.iteration, metrics: metrics(run.sample, run.joined) }));
const policies = Object.fromEntries(["fifo", "batch-32"].map((policy) => [policy,
  pooledMetric(runs.filter((run) => run.sample.protocol.policy === policy)),
]));
const pairs = [1, 2, 3, 4, 5].map((iteration) => {
  const fifo = runs.find((run) => run.raw.iteration === iteration && run.sample.protocol.policy === "fifo")!;
  const batch = runs.find((run) => run.raw.iteration === iteration && run.sample.protocol.policy === "batch-32")!;
  const expectedOrder = iteration % 2 === 1 ? ["fifo", "batch-32"] : ["batch-32", "fifo"];
  if (JSON.stringify(fifo.raw.policyOrder) !== JSON.stringify(expectedOrder) || JSON.stringify(batch.raw.policyOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error(`iteration ${iteration}: invalid rotation metadata`);
  }
  const fifoMetrics = metrics(fifo.sample, fifo.joined);
  const batchMetrics = metrics(batch.sample, batch.joined);
  return {
    iteration,
    order: fifo.raw.policyOrder,
    fifoWallClockMs: fifoMetrics.wallClockMs,
    batch32WallClockMs: batchMetrics.wallClockMs,
    batch32MinusFifoWallClockMs: batchMetrics.wallClockMs - fifoMetrics.wallClockMs,
    batch32MinusFifoBlockedTicks: batchMetrics.blockedTicks - fifoMetrics.blockedTicks,
    fifoRepathResponseP50Ms: fifoMetrics.responseMs.repath.p50,
    batch32RepathResponseP50Ms: batchMetrics.responseMs.repath.p50,
    batch32MinusFifoRepathResponseP50Ms: batchMetrics.responseMs.repath.p50 - fifoMetrics.responseMs.repath.p50,
  };
});
const output = {
  schema: "wayfinder-172-distribution-v2",
  generatedAt: new Date().toISOString(),
  percentileMethod: "nearest-rank: sorted[ceil(n*p)-1]",
  scope: "five rotated measured iterations per policy; no smoke data",
  iterations,
  pooled: policies,
  pairs,
};
await writeFile(path.join(ROOT, "results", "distribution.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ pairs, pooled: policies }, null, 2));

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";
import type { VersionedProtocolTelemetry } from "./adapter";
import {
  aggregateApplyTicks,
  distribution,
  individualRepaths,
  initialGroupApplyTotal,
  initialLeaders,
  responseMs,
} from "../../phase2-navigation/browser-distribution/metrics.mts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, "results");
interface Run {
  readonly browserVersion: string;
  readonly capturedAt: string;
  readonly host: unknown;
  readonly userAgent: string;
  readonly navigatorPlatform: string;
  readonly hardwareConcurrency: number;
  readonly samples: readonly (BenchmarkResult & { readonly protocol: VersionedProtocolTelemetry })[];
}
const baseline = JSON.parse(await readFile(
  path.resolve(ROOT, "../../phase2-navigation/browser-distribution/results/distribution.json"),
  "utf8",
)) as {
  readonly pooled: {
    readonly initialLeaderResponse: { readonly p50Ms: number; readonly p95Ms: number; readonly maxMs: number };
    readonly individualRepathResponse: { readonly p50Ms: number; readonly p95Ms: number; readonly maxMs: number };
    readonly perActiveTickApply: { readonly p95Ms: number; readonly maxMs: number };
  };
  readonly samples: readonly { readonly wallClockMs: number; readonly blockedFrames: number }[];
};
const runs: Run[] = [];
for (let sample = 1; sample <= 3; sample += 1) {
  const file = `chrome-versioned-mixed-p1000-t3600-sample-${String(sample).padStart(2, "0")}.json`;
  const run = JSON.parse(await readFile(path.join(RESULTS, file), "utf8")) as Run;
  if (run.samples.length !== 1 || run.samples[0]!.finalTick !== 3600) throw new Error(`bad ${file}`);
  runs.push(run);
}
const mutation = JSON.parse(await readFile(
  path.join(RESULTS, "chrome-versioned-mutation-p100-t600-sample-01.json"),
  "utf8",
)) as Run;

function responsesFor(run: Run, ids: ReadonlySet<number>) {
  return run.samples[0]!.protocol.responses.filter((response) => ids.has(response.id));
}
function queueDistribution(run: Run, ids: ReadonlySet<number>) {
  return distribution(responsesFor(run, ids).map((response) => response.workerQueueMs));
}
function computeDistribution(run: Run, ids: ReadonlySet<number>) {
  return distribution(responsesFor(run, ids).map((response) => response.computeMs));
}
function metric(run: Run, name: string): number {
  const value = run.samples[0]!.candidateMetrics[name];
  if (typeof value !== "number") throw new Error(`missing numeric candidate metric ${name}`);
  return value;
}
function protocolSummary(run: Run) {
  const sample = run.samples[0]!;
  const protocol = sample.protocol;
  const leaderIds = new Set(initialLeaders(sample).map((request) => request.id));
  const repathIds = new Set(individualRepaths(sample).map((request) => request.id));
  const responsePost = protocol.responses.flatMap((response) => response.responsePostMs === undefined ? [] : [response.responsePostMs]);
  const workerSnapshots = [...protocol.responses, ...protocol.snapshotAcks];
  return {
    registrationCount: metric(run, "registrationCount"),
    updateCount: metric(run, "updateCount"),
    sameRevisionRequests: metric(run, "sameRevisionRequests"),
    baselinePerRequestSnapshotBytes: sample.pathRequests.reduce((sum, request) => sum + request.snapshotBytes, 0),
    fullSnapshotPayloadBytes: metric(run, "snapshotFullPayloadBytes"),
    deltaSnapshotPayloadBytes: metric(run, "snapshotDeltaPayloadBytes"),
    registrationUpdateProtocolBytes: metric(run, "registrationUpdateProtocolBytes"),
    scalarRequestProtocolBytes: metric(run, "requestProtocolBytes"),
    totalMainToWorkerPayloadBytes: metric(run, "registrationUpdateProtocolBytes") + metric(run, "requestProtocolBytes"),
    snapshotPreparations: protocol.snapshotPreparations,
    snapshotSends: protocol.snapshotSends,
    snapshotAcks: protocol.snapshotAcks,
    mainRetainedSnapshotCount: protocol.mainRetainedSnapshotCount,
    mainRetainedSnapshotBytes: protocol.mainRetainedSnapshotBytes,
    maxWorkerSnapshotCount: Math.max(...workerSnapshots.map((entry) => entry.snapshotCount)),
    maxWorkerSnapshotBytes: Math.max(...workerSnapshots.map((entry) => entry.snapshotBytes)),
    maxPathCacheSize: Math.max(...protocol.responses.map((response) => response.pathCacheSize)),
    requestPost: distribution(protocol.requests.map((request) => request.requestPostMs)),
    responsePostSampleCount: responsePost.length,
    responsePost: distribution(responsePost),
    leaderQueue: queueDistribution(run, leaderIds),
    repathQueue: queueDistribution(run, repathIds),
    leaderCompute: computeDistribution(run, leaderIds),
    repathCompute: computeDistribution(run, repathIds),
  };
}
function appliedOnly(sample: BenchmarkResult): BenchmarkResult {
  return { ...sample, pathRequests: sample.pathRequests.filter((request) => request.outcome === "applied") };
}
function sampleSummary(run: Run, index: number) {
  const sample = run.samples[0]!;
  const applyRows = aggregateApplyTicks(index, appliedOnly(sample));
  return {
    sample: index,
    capturedAt: run.capturedAt,
    wallClockMs: sample.wallClockMs,
    frames: sample.frames,
    blockedFrames: sample.scheduler.blockedTicks,
    meanQueueDepth: sample.scheduler.meanQueueDepth,
    maxQueueDepth: sample.scheduler.maxQueueDepth,
    requests: sample.pathRequests.length,
    repaths: sample.movementDiagnostics.repaths,
    completed: sample.crowdStates.completed,
    activeAtCutoff: sample.population - sample.crowdStates.completed,
    finalFullStateHash: sample.finalFullStateHash,
    leaderResponse: distribution(initialLeaders(sample).map(responseMs)),
    repathResponse: distribution(individualRepaths(sample).map(responseMs)),
    initialGroupApplyTotalMs: initialLeaders(sample).every((request) => request.outcome === "applied")
      ? initialGroupApplyTotal(sample)
      : null,
    perActiveTickApply: distribution(applyRows.map((row) => row.totalApplyCostMs)),
    protocol: protocolSummary(run),
  };
}
const samples = runs.map((run, index) => sampleSummary(run, index + 1));
const allRunsResponses = runs.flatMap((run) => run.samples[0]!.protocol.responses);
const leaderResponses = runs.flatMap((run) => {
  const ids = new Set(initialLeaders(run.samples[0]!).map((request) => request.id));
  return responsesFor(run, ids);
});
const repathResponses = runs.flatMap((run) => {
  const ids = new Set(individualRepaths(run.samples[0]!).map((request) => request.id));
  return responsesFor(run, ids);
});
const applyTickRows = runs.flatMap((run, index) => aggregateApplyTicks(index + 1, appliedOnly(run.samples[0]!)));
const pooled = {
  leaderResponse: distribution(runs.flatMap((run) => initialLeaders(run.samples[0]!).map(responseMs))),
  repathResponse: distribution(runs.flatMap((run) => individualRepaths(run.samples[0]!).map(responseMs))),
  perActiveTickApply: distribution(applyTickRows.map((row) => row.totalApplyCostMs)),
  leaderQueue: distribution(leaderResponses.map((response) => response.workerQueueMs)),
  repathQueue: distribution(repathResponses.map((response) => response.workerQueueMs)),
  leaderCompute: distribution(leaderResponses.map((response) => response.computeMs)),
  repathCompute: distribution(repathResponses.map((response) => response.computeMs)),
  requestPost: distribution(runs.flatMap((run) => run.samples[0]!.protocol.requests.map((request) => request.requestPostMs))),
  responsePost: distribution(allRunsResponses.flatMap((response) => response.responsePostMs === undefined ? [] : [response.responsePostMs])),
};
const mixedBytes = samples.map((sample) => sample.protocol.totalMainToWorkerPayloadBytes);
const mutationSample = sampleSummary(mutation, 1);
const output = {
  schema: "wayfinder-169-versioned-snapshot-distribution-v1",
  generatedAt: new Date().toISOString(),
  browserVersion: runs[0]!.browserVersion,
  host: runs[0]!.host,
  userAgent: runs[0]!.userAgent,
  navigatorPlatform: runs[0]!.navigatorPlatform,
  hardwareConcurrency: runs[0]!.hardwareConcurrency,
  config: { candidate: "versioned-snapshot-astar", scenario: "mixed-destinations-120", population: 1000, ticks: 3600, warmupRuns: 1, measuredRunsPerLaunch: 1 },
  byteAccounting: "Exact binary payloads plus UTF-8 JSON scalar accounting; not browser structured-clone wire size. Full registration is cloned once, deltas and responses use transfer lists.",
  responsePostSampling: "responsePostMs measured for request id 1 and every 256th response to avoid doubling the message stream",
  baseline: {
    sampleCount: 5,
    pooled: baseline.pooled,
    wallClockMsRange: [Math.min(...baseline.samples.map((sample) => sample.wallClockMs)), Math.max(...baseline.samples.map((sample) => sample.wallClockMs))],
    blockedFramesRange: [Math.min(...baseline.samples.map((sample) => sample.blockedFrames)), Math.max(...baseline.samples.map((sample) => sample.blockedFrames))],
  },
  samples,
  pooled,
  pooledProtocol: {
    fullSnapshotPayloadBytes: samples.reduce((sum, sample) => sum + sample.protocol.fullSnapshotPayloadBytes, 0),
    baselinePerRequestSnapshotBytes: samples.reduce((sum, sample) => sum + sample.protocol.baselinePerRequestSnapshotBytes, 0),
    mainToWorkerPayloadBytesRange: [Math.min(...mixedBytes), Math.max(...mixedBytes)],
    mainToWorkerPayloadBytesMean: mixedBytes.reduce((sum, value) => sum + value, 0) / mixedBytes.length,
  },
  comparisonToBaseline: {
    leaderP95DeltaMs: pooled.leaderResponse.p95Ms - baseline.pooled.initialLeaderResponse.p95Ms,
    repathP95DeltaMs: pooled.repathResponse.p95Ms - baseline.pooled.individualRepathResponse.p95Ms,
    applyP95DeltaMs: pooled.perActiveTickApply.p95Ms - baseline.pooled.perActiveTickApply.p95Ms,
  },
  mutationSmoke: mutationSample,
};
await writeFile(path.join(RESULTS, "apply-ticks.json"), `${JSON.stringify({
  schema: "wayfinder-169-apply-ticks-v1",
  definition: "Production apply callbacks grouped by committed applyTick; zero-apply ticks excluded. Mixed samples are 1..3.",
  rows: applyTickRows,
}, null, 2)}\n`);
await writeFile(path.join(RESULTS, "distribution.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  samples: samples.map((sample) => ({
    sample: sample.sample,
    wallClockMs: sample.wallClockMs,
    blocked: sample.blockedFrames,
    leaderP95: sample.leaderResponse.p95Ms,
    repathP95: sample.repathResponse.p95Ms,
    leaderQueueP95: sample.protocol.leaderQueue.p95Ms,
    repathQueueP95: sample.protocol.repathQueue.p95Ms,
    applyP95: sample.perActiveTickApply.p95Ms,
    applyMax: sample.perActiveTickApply.maxMs,
    bytes: sample.protocol.totalMainToWorkerPayloadBytes,
  })),
  pooled,
  comparisonToBaseline: output.comparisonToBaseline,
  mutation: {
    hash: mutationSample.finalFullStateHash,
    sends: mutationSample.protocol.snapshotSends,
    workerSnapshots: mutationSample.protocol.maxWorkerSnapshotCount,
  },
}, null, 2));

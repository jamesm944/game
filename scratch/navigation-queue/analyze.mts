import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult } from "../full-game-movement/harness/types";
import type { QueueProtocolTelemetry } from "./adapter";
import {
  aggregateApplyTicks,
  distribution,
  individualRepaths,
  initialGroupApplyTotal,
  initialLeaders,
  responseMs,
} from "../phase2-navigation/browser-distribution/metrics.mts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const policies = ["fifo", "priority", "priority-batch"] as const;
type Policy = typeof policies[number];
interface Run {
  readonly browserVersion: string;
  readonly capturedAt: string;
  readonly host: unknown;
  readonly iteration: number;
  readonly policyOrder: readonly Policy[];
  readonly samples: readonly (BenchmarkResult & { readonly protocol: QueueProtocolTelemetry })[];
}
const runs = new Map<Policy, Run[]>();
for (const policy of policies) {
  const policyRuns: Run[] = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const file = `chrome-${policy}-mixed-iteration-${iteration}.json`;
    const run = JSON.parse(await readFile(path.join(ROOT, "results", file), "utf8")) as Run;
    if (run.iteration !== iteration || run.samples.length !== 1 || run.samples[0]!.finalTick !== 3600) {
      throw new Error(`invalid ${file}`);
    }
    policyRuns.push(run);
  }
  runs.set(policy, policyRuns);
}
const versioned = JSON.parse(await readFile(
  path.resolve(ROOT, "../navigation-protocol/snapshots/results/distribution.json"),
  "utf8",
)) as {
  readonly pooled: {
    readonly leaderResponse: { readonly p95Ms: number };
    readonly repathResponse: { readonly p95Ms: number };
    readonly leaderQueue: { readonly p95Ms: number };
    readonly repathQueue: { readonly p95Ms: number };
    readonly leaderCompute: { readonly p95Ms: number };
    readonly repathCompute: { readonly p95Ms: number };
  };
  readonly baseline: {
    readonly pooled: {
      readonly initialLeaderResponse: { readonly p95Ms: number };
      readonly individualRepathResponse: { readonly p95Ms: number };
    };
  };
};
function telemetry(sample: BenchmarkResult & { protocol: QueueProtocolTelemetry }, requestClass: "leader" | "repath") {
  return sample.protocol.responses.filter((response) => response.requestClass === requestClass);
}
function summarizeRun(run: Run) {
  const sample = run.samples[0]!;
  const leaders = initialLeaders(sample);
  const repaths = individualRepaths(sample);
  const leaderTelemetry = telemetry(sample, "leader");
  const repathTelemetry = telemetry(sample, "repath");
  const applyRows = aggregateApplyTicks(run.iteration, sample);
  return {
    iteration: run.iteration,
    capturedAt: run.capturedAt,
    policyOrder: run.policyOrder,
    wallClockMs: sample.wallClockMs,
    frames: sample.frames,
    blockedFrames: sample.scheduler.blockedTicks,
    requests: sample.pathRequests.length,
    repaths: sample.movementDiagnostics.repaths,
    completed: sample.crowdStates.completed,
    activeAtCutoff: sample.population - sample.crowdStates.completed,
    finalFullStateHash: sample.finalFullStateHash,
    leaderResponse: distribution(leaders.map(responseMs)),
    repathResponse: distribution(repaths.map(responseMs)),
    leaderQueue: distribution(leaderTelemetry.map((response) => response.workerQueueMs)),
    repathQueue: distribution(repathTelemetry.map((response) => response.workerQueueMs)),
    leaderCompute: distribution(leaderTelemetry.map((response) => response.computeMs)),
    repathCompute: distribution(repathTelemetry.map((response) => response.computeMs)),
    leaderDelivery: distribution(leaderTelemetry.map((response) => response.responseDeliveryMs)),
    repathDelivery: distribution(repathTelemetry.map((response) => response.responseDeliveryMs)),
    initialGroupApplyMs: initialGroupApplyTotal(sample),
    perActiveTickApply: distribution(applyRows.map((row) => row.totalApplyCostMs)),
    protocol: {
      fullSnapshotPayloadBytes: sample.candidateMetrics.fullSnapshotPayloadBytes,
      deltaSnapshotPayloadBytes: sample.candidateMetrics.deltaSnapshotPayloadBytes,
      responseWaypointBytes: sample.candidateMetrics.responseWaypointBytes,
      mainSnapshotCount: sample.protocol.mainSnapshotCount,
      mainSnapshotBytes: sample.protocol.mainSnapshotBytes,
      maxWorkerSnapshotCount: sample.protocol.maxWorkerSnapshotCount,
      maxWorkerSnapshotBytes: sample.protocol.maxWorkerSnapshotBytes,
      maxPathCacheSize: sample.protocol.maxPathCacheSize,
      pathRequestMessages: sample.protocol.pathRequestMessages,
      pathResultMessages: sample.protocol.pathResultMessages,
      maxBatchSize: sample.protocol.maxBatchSize,
      coalescedResponses: sample.protocol.coalescedResponses,
      maxQueuedRequests: sample.protocol.maxQueuedRequests,
    },
  };
}
function summarizePolicy(policy: Policy) {
  const policyRuns = runs.get(policy)!;
  const samples = policyRuns.map(summarizeRun);
  const fullSamples = policyRuns.map((run) => run.samples[0]!);
  const leaderTelemetry = fullSamples.flatMap((sample) => telemetry(sample, "leader"));
  const repathTelemetry = fullSamples.flatMap((sample) => telemetry(sample, "repath"));
  const applyRows = fullSamples.flatMap((sample, index) => aggregateApplyTicks(index + 1, sample));
  return {
    samples,
    pooled: {
      leaderResponse: distribution(fullSamples.flatMap((sample) => initialLeaders(sample).map(responseMs))),
      repathResponse: distribution(fullSamples.flatMap((sample) => individualRepaths(sample).map(responseMs))),
      leaderQueue: distribution(leaderTelemetry.map((response) => response.workerQueueMs)),
      repathQueue: distribution(repathTelemetry.map((response) => response.workerQueueMs)),
      leaderCompute: distribution(leaderTelemetry.map((response) => response.computeMs)),
      repathCompute: distribution(repathTelemetry.map((response) => response.computeMs)),
      leaderDelivery: distribution(leaderTelemetry.map((response) => response.responseDeliveryMs)),
      repathDelivery: distribution(repathTelemetry.map((response) => response.responseDeliveryMs)),
      perActiveTickApply: distribution(applyRows.map((row) => row.totalApplyCostMs)),
    },
  };
}
const fifo = summarizePolicy("fifo");
const priority = summarizePolicy("priority");
const batch = summarizePolicy("priority-batch");
const perIteration = [1, 2, 3].map((iteration) => {
  const control = fifo.samples[iteration - 1]!;
  const prioritized = priority.samples[iteration - 1]!;
  const batched = batch.samples[iteration - 1]!;
  return {
    iteration,
    policyOrder: control.policyOrder,
    priorityMinusFifo: {
      leaderP95Ms: prioritized.leaderResponse.p95Ms - control.leaderResponse.p95Ms,
      repathP95Ms: prioritized.repathResponse.p95Ms - control.repathResponse.p95Ms,
      blockedFrames: prioritized.blockedFrames - control.blockedFrames,
      wallClockMs: prioritized.wallClockMs - control.wallClockMs,
    },
    batchMinusFifo: {
      leaderP95Ms: batched.leaderResponse.p95Ms - control.leaderResponse.p95Ms,
      repathP95Ms: batched.repathResponse.p95Ms - control.repathResponse.p95Ms,
      blockedFrames: batched.blockedFrames - control.blockedFrames,
      wallClockMs: batched.wallClockMs - control.wallClockMs,
    },
  };
});
const applyTickRows = policies.flatMap((policy) => runs.get(policy)!.flatMap((run) => {
  const iteration = run.iteration;
  return aggregateApplyTicks(iteration, run.samples[0]!).map(({ sample: _sample, ...row }) => ({ policy, iteration, ...row }));
}));
const output = {
  schema: "wayfinder-170-queue-policy-distribution-v1",
  generatedAt: new Date().toISOString(),
  browserVersion: runs.get("fifo")![0]!.browserVersion,
  host: runs.get("fifo")![0]!.host,
  design: "Rotated same-browser-session iterations; fresh page and worker per policy; one warmup plus one measured run per page",
  policies: { fifo, priority, "priority-batch": batch },
  perIteration,
  historicalContext: {
    versionedFifo169: versioned.pooled,
    preservedAstar168: versioned.baseline.pooled,
    note: "Different sessions, sample sets, and telemetry; descriptive context only",
  },
};
await writeFile(path.join(ROOT, "results", "apply-ticks.json"), `${JSON.stringify({
  schema: "wayfinder-170-apply-ticks-v1",
  definition: "Production apply callbacks grouped by committed applyTick; zero-apply ticks excluded",
  rows: applyTickRows,
}, null, 2)}\n`);
await writeFile(path.join(ROOT, "results", "distribution.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  policies: Object.fromEntries(policies.map((policy) => [policy, {
    samples: output.policies[policy].samples.map((sample) => ({
      iteration: sample.iteration,
      leaderP95: sample.leaderResponse.p95Ms,
      repathP95: sample.repathResponse.p95Ms,
      leaderQueueP95: sample.leaderQueue.p95Ms,
      repathQueueP95: sample.repathQueue.p95Ms,
      leaderDeliveryP95: sample.leaderDelivery.p95Ms,
      repathDeliveryP95: sample.repathDelivery.p95Ms,
      blocked: sample.blockedFrames,
      wall: sample.wallClockMs,
    })),
    pooled: output.policies[policy].pooled,
  }])),
  perIteration,
}, null, 2));

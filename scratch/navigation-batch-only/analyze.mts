import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult } from "../full-game-movement/harness/types";
import type { DeliveryProbeSample, QueueProtocolTelemetry } from "./adapter";
import {
  aggregateApplyTicks,
  distribution,
  individualRepaths,
  initialGroupApplyTotal,
  initialLeaders,
  responseMs,
} from "../phase2-navigation/browser-distribution/metrics.mts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const policies = ["fifo", "batch-8", "batch-16", "batch-32", "batch-64"] as const;
type Policy = typeof policies[number];
interface Run {
  readonly browserVersion: string;
  readonly capturedAt: string;
  readonly host: unknown;
  readonly iteration: number;
  readonly policyOrder: readonly Policy[];
  readonly samples: readonly (BenchmarkResult & { readonly protocol: QueueProtocolTelemetry })[];
  readonly deliveryDiagnostic: { readonly method: string; readonly samples: readonly DeliveryProbeSample[] };
}
const runs = new Map<Policy, Run[]>();
for (const policy of policies) {
  const policyRuns: Run[] = [];
  for (let iteration = 1; iteration <= 4; iteration += 1) {
    const file = `chrome-${policy}-mixed-iteration-${iteration}.json`;
    const run = JSON.parse(await readFile(path.join(ROOT, "results", file), "utf8")) as Run;
    const sample = run.samples[0];
    if (run.iteration !== iteration || run.samples.length !== 1 || sample?.finalTick !== 3600) throw new Error(`invalid ${file}`);
    if (sample.pathRequests.length !== 46_807 || sample.protocol.responses.length !== 46_807) throw new Error(`request count mismatch in ${file}`);
    if (run.deliveryDiagnostic.samples.length !== 64) throw new Error(`diagnostic count mismatch in ${file}`);
    policyRuns.push(run);
  }
  runs.set(policy, policyRuns);
}
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
    tickWall: distribution(sample.ticks.map((tick) => tick.wallMs)),
    initialGroupApplyMs: initialGroupApplyTotal(sample),
    perActiveTickApply: distribution(applyRows.map((row) => row.totalApplyCostMs)),
    deliveryDiagnosticRtt: distribution(run.deliveryDiagnostic.samples.map((probe) => probe.roundTripMs)),
    deliveryDiagnosticWorkerHandling: distribution(run.deliveryDiagnostic.samples.map((probe) => probe.workerHandlingMs)),
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
      coalescingEligibleResponses: sample.protocol.coalescingEligibleResponses,
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
      wallClock: distribution(fullSamples.map((sample) => sample.wallClockMs)),
      tickWall: distribution(fullSamples.flatMap((sample) => sample.ticks.map((tick) => tick.wallMs))),
      perActiveTickApply: distribution(applyRows.map((row) => row.totalApplyCostMs)),
      deliveryDiagnosticRtt: distribution(policyRuns.flatMap((run) => run.deliveryDiagnostic.samples.map((probe) => probe.roundTripMs))),
      deliveryDiagnosticWorkerHandling: distribution(policyRuns.flatMap((run) => run.deliveryDiagnostic.samples.map((probe) => probe.workerHandlingMs))),
    },
  };
}
const summaries = Object.fromEntries(policies.map((policy) => [policy, summarizePolicy(policy)])) as Record<Policy, ReturnType<typeof summarizePolicy>>;
const perIteration = [1, 2, 3, 4].map((iteration) => {
  const control = summaries.fifo.samples[iteration - 1]!;
  return {
    iteration,
    policyOrder: control.policyOrder,
    challengersMinusFifo: Object.fromEntries(policies.slice(1).map((policy) => {
      const challenger = summaries[policy].samples[iteration - 1]!;
      return [policy, {
        leaderP95Ms: challenger.leaderResponse.p95Ms - control.leaderResponse.p95Ms,
        repathP95Ms: challenger.repathResponse.p95Ms - control.repathResponse.p95Ms,
        blockedFrames: challenger.blockedFrames - control.blockedFrames,
        wallClockMs: challenger.wallClockMs - control.wallClockMs,
      }];
    })),
  };
});
const applyTickRows = policies.flatMap((policy) => runs.get(policy)!.flatMap((run) => {
  const iteration = run.iteration;
  return aggregateApplyTicks(iteration, run.samples[0]!).map(({ sample: _sample, ...row }) => ({ policy, iteration, ...row }));
}));
const output = {
  schema: "wayfinder-171-batch-only-distribution-v1",
  generatedAt: new Date().toISOString(),
  browserVersion: runs.get("fifo")![0]!.browserVersion,
  host: runs.get("fifo")![0]!.host,
  design: "Four rotated same-browser-session iterations; fresh page/worker per policy; one warmup plus one measured run per page; diagnostic after headline timings",
  diagnosticMethod: runs.get("fifo")![0]!.deliveryDiagnostic.method,
  policies: summaries,
  perIteration,
};
await writeFile(path.join(ROOT, "results", "apply-ticks.json"), `${JSON.stringify({
  schema: "wayfinder-171-apply-ticks-v1",
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
      diagnosticRttP95: sample.deliveryDiagnosticRtt.p95Ms,
      blocked: sample.blockedFrames,
      wall: sample.wallClockMs,
      messages: sample.protocol.pathRequestMessages,
      eligible: sample.protocol.coalescingEligibleResponses,
      coalesced: sample.protocol.coalescedResponses,
    })),
    pooled: output.policies[policy].pooled,
  }])),
  perIteration,
}, null, 2));

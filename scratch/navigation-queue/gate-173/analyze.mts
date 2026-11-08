// Wayfinder #173 analyzer: per-iteration and pooled distributions for the
// Recast-vs-A* FIFO full-scale gate. Reuses the #171 metric definitions
// (nearest-rank percentiles; leaders = commandTick===1; repaths = no commandTick).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";
import {
  distribution,
  individualRepaths,
  initialLeaders,
  responseMs,
} from "../../phase2-navigation/browser-distribution/metrics.mts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const scenarios = [
  ["dense-open-120", "dense"],
  ["mixed-destinations-120", "mixed"],
  ["narrow-mutation-120", "narrow"],
] as const;
const engines = ["astar", "recast"] as const;
type Engine = (typeof engines)[number];

interface ProtocolResponse {
  readonly id: number;
  readonly workerQueueMs: number;
  readonly computeMs: number;
  readonly responsePayloadBytes: number;
}
interface RunFile {
  readonly samples: readonly (BenchmarkResult & {
    readonly protocol: any;
    readonly recastRoutes?: unknown;
  })[];
  readonly iteration: number;
  readonly engine: Engine;
  readonly browserVersion: string;
  readonly host: unknown;
  readonly memoryProbe?: {
    readonly polls: readonly any[];
    readonly pageMemoryAfter: any;
    readonly workerGlobals: readonly any[];
  };
  readonly deliveryDiagnostic?: {
    readonly samples: readonly {
      readonly roundTripMs: number;
      readonly workerHandlingMs: number;
    }[];
  };
}

async function loadRun(
  engine: Engine,
  short: string,
  iteration: number,
): Promise<RunFile | null> {
  const file = path.join(
    ROOT,
    "results",
    `chrome-${engine}-${short}-iter${iteration}.json`,
  );
  try {
    return JSON.parse(await readFile(file, "utf8")) as RunFile;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function distOrNull(values: number[]) {
  return values.length ? distribution(values) : null;
}

// aggregateApplyTicks() from metrics.mts throws when an applied request lacks
// applyCostMs (the Recast harness records applyTick on some stale-discarded rows
// without an apply cost). This tolerant copy excludes and counts those rows.
function applyTickTotals(sample: BenchmarkResult): {
  totals: number[];
  excludedAppliedWithoutCost: number;
} {
  const byTick = new Map<number, number>();
  let excluded = 0;
  for (const request of sample.pathRequests) {
    if (request.applyTick === undefined) continue;
    if (
      request.applyCostMs === undefined ||
      !Number.isFinite(request.applyCostMs)
    ) {
      excluded += 1;
      continue;
    }
    byTick.set(
      request.applyTick,
      (byTick.get(request.applyTick) ?? 0) + request.applyCostMs,
    );
  }
  return { totals: [...byTick.values()], excludedAppliedWithoutCost: excluded };
}

function classTelemetry(
  sample: BenchmarkResult & { protocol: any },
  ids: Set<number>,
) {
  const byId = new Map<number, ProtocolResponse>();
  for (const response of sample.protocol.responses as ProtocolResponse[])
    byId.set(response.id, response);
  const rows = [...ids]
    .map((id) => byId.get(id))
    .filter((row): row is ProtocolResponse => row !== undefined);
  const responseById = new Map(
    sample.pathRequests.map((request) => [
      request.id,
      request.issueToResponseMs,
    ]),
  );
  return {
    queue: distOrNull(rows.map((row) => row.workerQueueMs)),
    compute: distOrNull(rows.map((row) => row.computeMs)),
    // Residual = response - queue - compute. Queue crosses agent clocks, so this
    // residual mixes true one-way delivery with clock error; reported, never used for selection.
    deliveryResidual: distOrNull(
      rows.flatMap((row) => {
        const response = responseById.get(row.id);
        return response === undefined
          ? []
          : [response - row.workerQueueMs - row.computeMs];
      }),
    ),
    telemetryCount: rows.length,
  };
}

function summarizeSample(run: RunFile) {
  const sample = run.samples[0]!;
  const leaders = initialLeaders(sample);
  const repaths = individualRepaths(sample);
  const otherCommand = sample.pathRequests.filter(
    (request) => request.commandTick !== undefined && request.commandTick !== 1,
  );
  const leaderIds = new Set(leaders.map((request) => request.id));
  const repathIds = new Set(repaths.map((request) => request.id));
  const applyTotals = applyTickTotals(sample);
  const cm = sample.candidateMetrics as Record<string, any>;
  const polls = run.memoryProbe?.polls ?? [];
  const heapPolls = polls.filter((poll) => poll.hasMemory);
  const outcomes: Record<string, number> = {};
  for (const request of sample.pathRequests)
    outcomes[request.outcome] = (outcomes[request.outcome] ?? 0) + 1;
  return {
    iteration: run.iteration,
    engine: run.engine,
    wallClockMs: sample.wallClockMs,
    frames: sample.frames,
    blockedFrames: sample.scheduler.blockedTicks,
    finalTick: sample.finalTick,
    requests: sample.pathRequests.length,
    leaderCount: leaders.length,
    repathCount: repaths.length,
    otherCommandCount: otherCommand.length,
    movementRepaths: sample.movementDiagnostics.repaths,
    completed: sample.crowdStates.completed,
    activeAtCutoff: sample.population - sample.crowdStates.completed,
    crowdStates: sample.crowdStates,
    outcomes,
    noPathResponses: sample.pathRequests.filter(
      (request) => request.ok === false,
    ).length,
    finalFullStateHash: sample.finalFullStateHash,
    leaderResponse: distOrNull(leaders.map(responseMs)),
    repathResponse: distOrNull(repaths.map(responseMs)),
    otherCommandResponse: distOrNull(otherCommand.map(responseMs)),
    leaderTelemetry: classTelemetry(sample, leaderIds),
    repathTelemetry: classTelemetry(sample, repathIds),
    tickWall: distOrNull(sample.ticks.map((tick) => tick.wallMs)),
    initialGroupApplyMs:
      leaders.length &&
      leaders.every((request) => Number.isFinite(request.applyCostMs))
        ? leaders.reduce((sum, request) => sum + (request.applyCostMs ?? 0), 0)
        : null,
    leadersMissingApplyCost: leaders.filter(
      (request) => !Number.isFinite(request.applyCostMs),
    ).length,
    perActiveTickApply: distOrNull(applyTotals.totals),
    applyExcludedWithoutCost: applyTotals.excludedAppliedWithoutCost,
    schedulerQueue: sample.scheduler,
    memoryProbe: {
      pollCount: polls.length,
      heapPollCount: heapPolls.length,
      maxWorkerUsedJSHeapBytes: heapPolls.length
        ? Math.max(...heapPolls.map((poll) => poll.usedJSHeapSize))
        : null,
      maxWorkerTotalJSHeapBytes: heapPolls.length
        ? Math.max(...heapPolls.map((poll) => poll.totalJSHeapSize))
        : null,
      pageMemoryAfter: run.memoryProbe?.pageMemoryAfter ?? null,
    },
    deliveryDiagnosticRtt: run.deliveryDiagnostic
      ? distOrNull(
          run.deliveryDiagnostic.samples.map((probe) => probe.roundTripMs),
        )
      : null,
    bytes:
      run.engine === "astar"
        ? {
            fullSnapshotPayloadBytes: cm.fullSnapshotPayloadBytes,
            deltaSnapshotPayloadBytes: cm.deltaSnapshotPayloadBytes,
            responseWaypointBytes: cm.responseWaypointBytes,
            pathRequestMessages: cm.pathRequestMessages,
            pathResultMessages: cm.pathResultMessages,
            maxBatchSize: cm.maxBatchSize,
            snapshotPreparationCount: cm.snapshotPreparationCount,
            maxWorkerSnapshotCount: cm.maxWorkerSnapshotCount,
            maxWorkerSnapshotBytes: cm.maxWorkerSnapshotBytes,
            maxPathCacheSize: cm.maxPathCacheSize,
          }
        : {
            registrationUpdateProtocolBytes: cm.registrationUpdateProtocolBytes,
            requestProtocolBytes: cm.requestProtocolBytes,
            snapshotFullPayloadBytes: cm.snapshotFullPayloadBytes,
            snapshotDeltaPayloadBytes: cm.snapshotDeltaPayloadBytes,
            responseWaypointBytes: cm.responseWaypointBytes,
            registrationCount: cm.registrationCount,
            updateCount: cm.updateCount,
            snapshotPreparationCount: cm.snapshotPreparationCount,
            mainRetainedSnapshotCount: cm.mainRetainedSnapshotCount,
            mainRetainedSnapshotBytes: cm.mainRetainedSnapshotBytes,
            snapshotCacheBytes: cm.snapshotCacheBytes,
            compressedLayerBytes: cm.compressedLayerBytes,
            revisionCacheEntries: cm.revisionCacheEntries,
            revisionCacheCapacity: cm.revisionCacheCapacity,
          },
    rebuild:
      run.engine === "recast"
        ? {
            wasmInitializationMs: cm.wasmInitializationMs,
            revisionBuilds: cm.revisionBuilds,
            fullRasterRevisionBuilds: cm.fullRasterRevisionBuilds,
            incrementalRevisionBuilds: cm.incrementalRevisionBuilds,
            mutationRebuilds: cm.mutationRebuilds,
            totalRevisionBuildMs: cm.totalRevisionBuildMs,
            totalIncrementalUpdateMs: cm.totalIncrementalUpdateMs,
            maxRevisionBuildMs: cm.maxRevisionBuildMs,
            lastRevisionBuildMs: cm.lastRevisionBuildMs,
            totalRasterizeMs: cm.totalRasterizeMs,
            totalNavMeshBuildMs: cm.totalNavMeshBuildMs,
            totalGeometryMs: cm.totalGeometryMs,
            changedNavTiles: cm.changedNavTiles,
            rasterizedNavTiles: cm.rasterizedNavTiles,
            maxRasterizedNavTilesPerRevision:
              cm.maxRasterizedNavTilesPerRevision,
            reusedCompressedLayers: cm.reusedCompressedLayers,
            revisionCacheHits: cm.revisionCacheHits,
            revisionCacheMisses: cm.revisionCacheMisses,
            revisionCacheEvictions: cm.revisionCacheEvictions,
            ephemeralSnapshotBuilds: cm.ephemeralSnapshotBuilds,
            outOfOrderRebuilds: cm.outOfOrderRebuilds,
            totalPathQueryMs: cm.totalPathQueryMs,
            maxPathQueryMs: cm.maxPathQueryMs,
            totalRouteConversionMs: cm.totalRouteConversionMs,
            maxRouteConversionMs: cm.maxRouteConversionMs,
            pathQueries: cm.pathQueries,
            geometryRejections: cm.geometryRejections,
            unreachableRoutes: cm.unreachableRoutes,
            partialPathsRejected: cm.partialPathsRejected,
            endpointProjectionsRejected: cm.endpointProjectionsRejected,
            nativeQueryFailures: cm.nativeQueryFailures,
            navmeshGenerationFailures: cm.navmeshGenerationFailures,
            workerErrorCount: cm.workerErrorCount,
          }
        : null,
  };
}

function poolTelemetry(
  runs: RunFile[],
  pick: (sample: BenchmarkResult) => { id: number }[],
) {
  const queues: number[] = [];
  const computes: number[] = [];
  const residuals: number[] = [];
  for (const run of runs) {
    const sample = run.samples[0]!;
    const ids = new Set(pick(sample).map((request) => request.id));
    const responseById = new Map(
      sample.pathRequests.map((request) => [
        request.id,
        request.issueToResponseMs,
      ]),
    );
    for (const response of sample.protocol.responses as ProtocolResponse[]) {
      if (!ids.has(response.id)) continue;
      queues.push(response.workerQueueMs);
      computes.push(response.computeMs);
      const total = responseById.get(response.id);
      if (total !== undefined)
        residuals.push(total - response.workerQueueMs - response.computeMs);
    }
  }
  return {
    queue: distOrNull(queues),
    compute: distOrNull(computes),
    deliveryResidual: distOrNull(residuals),
  };
}

const output: any = {
  schema: "wayfinder-173-recast-vs-astar-distribution-v1",
  generatedAt: new Date().toISOString(),
  design:
    "Four rotated same-session iterations per scenario (A*/Recast order alternates); fresh page per sample; one 400-tick warmup worker then fresh measured worker; FIFO single-request messages for both engines",
  scenarios: {},
};
let headline: any = {};
for (const [scenario, short] of scenarios) {
  const perEngine: any = {};
  const runsByEngine = new Map<Engine, RunFile[]>();
  for (const engine of engines) {
    const runs: RunFile[] = [];
    for (let iteration = 1; iteration <= 4; iteration += 1) {
      const run = await loadRun(engine, short, iteration);
      if (run) runs.push(run);
    }
    runsByEngine.set(engine, runs);
    if (!runs.length) continue;
    const samples = runs.map(summarizeSample);
    const full = runs.map((run) => run.samples[0]!);
    perEngine[engine] = {
      samples,
      pooled: {
        leaderResponse: distOrNull(
          full.flatMap((sample) => initialLeaders(sample).map(responseMs)),
        ),
        repathResponse: distOrNull(
          full.flatMap((sample) => individualRepaths(sample).map(responseMs)),
        ),
        leaderTelemetry: poolTelemetry(runs, (sample) =>
          initialLeaders(sample),
        ),
        repathTelemetry: poolTelemetry(runs, (sample) =>
          individualRepaths(sample),
        ),
        wallClock: distOrNull(full.map((sample) => sample.wallClockMs)),
        tickWall: distOrNull(
          full.flatMap((sample) => sample.ticks.map((tick) => tick.wallMs)),
        ),
        perActiveTickApply: distOrNull(
          runs.flatMap((run) => applyTickTotals(run.samples[0]!).totals),
        ),
        blockedFrames: samples.map((sample) => sample.blockedFrames),
      },
    };
  }
  const deltas = [];
  for (let iteration = 1; iteration <= 4; iteration += 1) {
    const astar = perEngine.astar?.samples.find(
      (sample: any) => sample.iteration === iteration,
    );
    const recast = perEngine.recast?.samples.find(
      (sample: any) => sample.iteration === iteration,
    );
    if (!astar || !recast) continue;
    deltas.push({
      iteration,
      engineOrder:
        iteration % 2 === 1 ? ["astar", "recast"] : ["recast", "astar"],
      recastMinusAstar: {
        leaderP50Ms:
          recast.leaderResponse && astar.leaderResponse
            ? recast.leaderResponse.p50Ms - astar.leaderResponse.p50Ms
            : null,
        leaderP95Ms:
          recast.leaderResponse && astar.leaderResponse
            ? recast.leaderResponse.p95Ms - astar.leaderResponse.p95Ms
            : null,
        leaderMaxMs:
          recast.leaderResponse && astar.leaderResponse
            ? recast.leaderResponse.maxMs - astar.leaderResponse.maxMs
            : null,
        repathP50Ms: recast.repathResponse.p50Ms - astar.repathResponse.p50Ms,
        repathP95Ms: recast.repathResponse.p95Ms - astar.repathResponse.p95Ms,
        repathMaxMs: recast.repathResponse.maxMs - astar.repathResponse.maxMs,
        blockedFrames: recast.blockedFrames - astar.blockedFrames,
        wallClockMs: recast.wallClockMs - astar.wallClockMs,
        completed: recast.completed - astar.completed,
        requests: recast.requests - astar.requests,
      },
    });
  }
  output.scenarios[scenario] = { ...perEngine, perIterationDeltas: deltas };
  headline[scenario] = Object.fromEntries(
    engines
      .filter((engine) => perEngine[engine])
      .map((engine) => [
        engine,
        {
          samples: perEngine[engine].samples.map((sample: any) => ({
            iteration: sample.iteration,
            leaderP95: sample.leaderResponse?.p95Ms ?? null,
            leaderN: sample.leaderCount,
            repathP50: sample.repathResponse?.p50Ms ?? null,
            repathP95: sample.repathResponse?.p95Ms ?? null,
            repathMax: sample.repathResponse?.maxMs ?? null,
            blocked: sample.blockedFrames,
            wallMs: Math.round(sample.wallClockMs),
            completed: sample.completed,
            requests: sample.requests,
          })),
          pooledLeader: perEngine[engine].pooled.leaderResponse,
          pooledRepath: perEngine[engine].pooled.repathResponse,
        },
      ]),
  );
}
await writeFile(
  path.join(ROOT, "results", "distribution-173.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(headline, null, 2));

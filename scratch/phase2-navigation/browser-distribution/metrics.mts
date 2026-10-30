import type { BenchmarkResult, PathRequestMetric } from "../../full-game-movement/harness/types";

export interface Distribution {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export interface ApplyTickRow {
  readonly sample: number;
  readonly applyTick: number;
  readonly totalApplyCostMs: number;
  readonly callbackCount: number;
  readonly initialLeaderApplyCostMs: number;
  readonly individualRepathApplyCostMs: number;
  readonly otherApplyCostMs: number;
}

export interface LeaderTiming {
  readonly id: number;
  readonly issueToResponseMs: number;
  readonly applyTick: number;
  readonly applyCostMs: number;
  readonly issueToApplyTicks: number;
}

/** Nearest-rank percentile over a non-empty sample, without interpolation. */
export function nearestRank(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  if (!(probability > 0 && probability <= 1)) throw new Error("probability must be in (0, 1]");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("non-finite timing value");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(probability * sorted.length) - 1]!;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) throw new Error("distribution requires at least one value");
  let minMs = values[0]!;
  let maxMs = values[0]!;
  let sum = 0;
  for (const value of values) {
    minMs = Math.min(minMs, value);
    maxMs = Math.max(maxMs, value);
    sum += value;
  }
  return {
    count: values.length,
    minMs,
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maxMs,
    meanMs: sum / values.length,
  };
}

export function responseMs(request: PathRequestMetric): number {
  if (request.issueToResponseMs === undefined || !Number.isFinite(request.issueToResponseMs)) {
    throw new Error(`request ${request.id} has no finite issue-to-response timing`);
  }
  return request.issueToResponseMs;
}

export function initialLeaders(sample: BenchmarkResult): PathRequestMetric[] {
  return sample.pathRequests.filter((request) => request.commandTick === 1);
}

export function individualRepaths(sample: BenchmarkResult): PathRequestMetric[] {
  return sample.pathRequests.filter((request) => request.commandTick === undefined);
}

export function leaderTimings(sample: BenchmarkResult): LeaderTiming[] {
  return initialLeaders(sample).map((request) => {
    if (request.applyTick === undefined || request.applyCostMs === undefined || request.issueToApplyTicks === undefined) {
      throw new Error(`initial leader ${request.id} lacks application metrics`);
    }
    return {
      id: request.id,
      issueToResponseMs: responseMs(request),
      applyTick: request.applyTick,
      applyCostMs: request.applyCostMs,
      issueToApplyTicks: request.issueToApplyTicks,
    };
  });
}

/** Aggregate real production callbacks by committed application tick. */
export function aggregateApplyTicks(sampleNumber: number, sample: BenchmarkResult): ApplyTickRow[] {
  const ticks = new Map<number, {
    totalApplyCostMs: number;
    callbackCount: number;
    initialLeaderApplyCostMs: number;
    individualRepathApplyCostMs: number;
    otherApplyCostMs: number;
  }>();
  for (const request of sample.pathRequests) {
    if (request.applyTick === undefined) continue;
    if (request.applyCostMs === undefined || !Number.isFinite(request.applyCostMs)) {
      throw new Error(`applied request ${request.id} has no finite apply cost`);
    }
    const row = ticks.get(request.applyTick) ?? {
      totalApplyCostMs: 0,
      callbackCount: 0,
      initialLeaderApplyCostMs: 0,
      individualRepathApplyCostMs: 0,
      otherApplyCostMs: 0,
    };
    row.totalApplyCostMs += request.applyCostMs;
    row.callbackCount += 1;
    if (request.commandTick === 1) row.initialLeaderApplyCostMs += request.applyCostMs;
    else if (request.commandTick === undefined) row.individualRepathApplyCostMs += request.applyCostMs;
    else row.otherApplyCostMs += request.applyCostMs;
    ticks.set(request.applyTick, row);
  }
  return [...ticks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([applyTick, row]) => ({ sample: sampleNumber, applyTick, ...row }));
}

export function initialGroupApplyTotal(sample: BenchmarkResult): number {
  const leaders = initialLeaders(sample);
  const applyTicks = new Set(leaders.map((request) => request.applyTick));
  if (applyTicks.size !== 1 || leaders.some((request) => request.applyTick === undefined)) {
    throw new Error("initial leaders do not share one defined application tick");
  }
  return leaders.reduce((sum, request) => {
    if (request.applyCostMs === undefined) throw new Error(`leader ${request.id} has no apply cost`);
    return sum + request.applyCostMs;
  }, 0);
}

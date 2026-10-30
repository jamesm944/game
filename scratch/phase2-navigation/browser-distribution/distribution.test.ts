import { describe, expect, it } from "vitest";
import type { BenchmarkResult, PathRequestMetric } from "../../full-game-movement/harness/types";
import {
  aggregateApplyTicks,
  individualRepaths,
  initialGroupApplyTotal,
  initialLeaders,
  nearestRank,
} from "./metrics.mts";

function request(values: Partial<PathRequestMetric> & Pick<PathRequestMetric, "id">): PathRequestMetric {
  return {
    issueTick: 1,
    dueTick: 3,
    snapshotBytes: 14_400,
    passableVersion: 0,
    outcome: "applied",
    ...values,
  };
}

function sample(pathRequests: PathRequestMetric[]): BenchmarkResult {
  return { pathRequests } as unknown as BenchmarkResult;
}

describe("Wayfinder #168 distribution statistics", () => {
  it("uses nearest-rank p95, including the maximum for eight leaders", () => {
    expect(nearestRank([8, 1, 7, 2, 6, 3, 5, 4], 0.95)).toBe(8);
    expect(nearestRank(Array.from({ length: 40 }, (_, index) => index + 1), 0.95)).toBe(38);
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(() => nearestRank([], 0.95)).toThrow();
  });

  it("classifies exactly the tick-one command requests as initial leaders", () => {
    const result = sample([
      request({ id: 1, commandTick: 1, issueToResponseMs: 20 }),
      request({ id: 2, commandTick: 1, issueToResponseMs: 30 }),
      request({ id: 3, issueToResponseMs: 40 }),
      request({ id: 4, commandTick: 180, issueToResponseMs: 50 }),
    ]);
    expect(initialLeaders(result).map((entry) => entry.id)).toEqual([1, 2]);
    expect(individualRepaths(result).map((entry) => entry.id)).toEqual([3]);
  });

  it("aggregates production callbacks by apply tick and request class", () => {
    const result = sample([
      request({ id: 1, commandTick: 1, applyTick: 3, applyCostMs: 0.2 }),
      request({ id: 2, commandTick: 1, applyTick: 3, applyCostMs: 0.3 }),
      request({ id: 3, applyTick: 3, applyCostMs: 0.1 }),
      request({ id: 4, applyTick: 4, applyCostMs: 0 }),
      request({ id: 5, commandTick: 180, applyTick: 4, applyCostMs: 0.4 }),
      request({ id: 6, outcome: "pending" }),
    ]);
    expect(aggregateApplyTicks(2, result)).toEqual([
      {
        sample: 2,
        applyTick: 3,
        totalApplyCostMs: 0.6,
        callbackCount: 3,
        initialLeaderApplyCostMs: 0.5,
        individualRepathApplyCostMs: 0.1,
        otherApplyCostMs: 0,
      },
      {
        sample: 2,
        applyTick: 4,
        totalApplyCostMs: 0.4,
        callbackCount: 2,
        initialLeaderApplyCostMs: 0,
        individualRepathApplyCostMs: 0,
        otherApplyCostMs: 0.4,
      },
    ]);
  });

  it("sums the initial production group at its single shared apply tick", () => {
    const result = sample([
      request({ id: 1, commandTick: 1, applyTick: 3, applyCostMs: 0.2 }),
      request({ id: 2, commandTick: 1, applyTick: 3, applyCostMs: 0.3 }),
      request({ id: 3, applyTick: 3, applyCostMs: 10 }),
    ]);
    expect(initialGroupApplyTotal(result)).toBe(0.5);
    expect(() => initialGroupApplyTotal(sample([
      request({ id: 1, commandTick: 1, applyTick: 3, applyCostMs: 0.2 }),
      request({ id: 2, commandTick: 1, applyTick: 4, applyCostMs: 0.3 }),
    ]))).toThrow("share");
  });
});

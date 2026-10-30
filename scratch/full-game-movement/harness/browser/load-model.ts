import type { GroupSpec, PathRequestMetric, ScenarioSpec } from "../types";
import type { PathResponse } from "../../../../src/sim/path/protocol";

export type LoadPattern = "concurrent-burst" | "staggered-groups";

export interface LoadSpec {
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
  readonly issueTick: number;
  readonly seed: number;
  readonly groupId: string;
}

export interface NumericStats {
  readonly count: number;
  readonly min: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export function nearestRank(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

export function stats(values: readonly number[]): NumericStats {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function allocate(groups: readonly GroupSpec[], population: number): number[] {
  const shareTotal = groups.reduce((sum, group) => sum + group.share, 0);
  const exact = groups.map((group) => population * group.share / shareTotal);
  const counts = exact.map(Math.floor);
  let remaining = population - counts.reduce((sum, count) => sum + count, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remaining > 0; index = (index + 1) % order.length) {
    counts[order[index]!.index]! += 1;
    remaining -= 1;
  }
  return counts;
}

/** Deterministic direct member searches; production group orders are not implied. */
export function createLoadSpecs(
  scenario: ScenarioSpec,
  population: number,
  pattern: LoadPattern,
): LoadSpec[] {
  if (!Number.isInteger(population) || population < 1) throw new Error("population must be positive");
  const counts = allocate(scenario.groups, population);
  const specs: LoadSpec[] = [];
  let globalIndex = 0;
  scenario.groups.forEach((group, groupIndex) => {
    const count = counts[groupIndex]!;
    const capacity = group.spawn.width * group.spawn.height;
    if (count > capacity) throw new Error(`population exceeds spawn capacity for ${group.id}`);
    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      specs.push({
        startX: group.spawn.x + localIndex % group.spawn.width,
        startY: group.spawn.y + Math.floor(localIndex / group.spawn.width),
        goalX: Math.floor(group.destination.x),
        goalY: Math.floor(group.destination.y),
        issueTick: pattern === "concurrent-burst" ? 1 : groupIndex + 1,
        seed: scenario.seed + globalIndex,
        groupId: group.id,
      });
      globalIndex += 1;
    }
  });
  return specs;
}

export function createPassability(scenario: ScenarioSpec): Uint8Array {
  const passable = new Uint8Array(scenario.size * scenario.size).fill(1);
  for (const rect of scenario.map.blocked) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) passable[y * scenario.size + x] = 0;
    }
  }
  return passable;
}

export interface AppliedLogicalRoute {
  readonly id: number;
  readonly issueTick: number;
  readonly dueTick: number;
  readonly applyTick: number;
  readonly response: PathResponse;
}

/** Timing, response arrival order, and wall-clock frames are deliberately excluded. */
export function canonicalLogical(routes: readonly AppliedLogicalRoute[]): string {
  return JSON.stringify(routes.map((route) => ({
    id: route.id,
    issueTick: route.issueTick,
    dueTick: route.dueTick,
    applyTick: route.applyTick,
    ok: route.response.ok,
    cost: route.response.cost,
    waypoints: Array.from(route.response.waypoints),
  })));
}

export function summarizeRequests(requests: readonly PathRequestMetric[]) {
  const response = requests.flatMap((request) => request.issueToResponseMs ?? []);
  const apply = requests.flatMap((request) => request.applyCostMs ?? []);
  const applyTicks = requests.flatMap((request) => request.issueToApplyTicks ?? []);
  return {
    issueToResponseWallMs: stats(response),
    pathApplyMainThreadMs: stats(apply),
    issueToApplyTicks: stats(applyTicks),
    responseP95Exceeds33_3ms: (nearestRank(response, 0.95) ?? 0) > 33.3,
    applyP95Exceeds2ms: (nearestRank(apply, 0.95) ?? 0) > 2,
    snapshotPayloadBytes: requests.reduce((sum, request) => sum + request.snapshotBytes, 0),
  };
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PathScheduler, createSynchronousPathTransport } from "../../../../src/sim/path/scheduler";
import type { PathRequestMetric, ScenarioSpec } from "../types";
import fixtures from "../fixtures/scenarios.json";
import {
  canonicalLogical,
  createLoadSpecs,
  createPassability,
  nearestRank,
  stats,
  summarizeRequests,
  type AppliedLogicalRoute,
} from "./load-model";

const scenarios = fixtures as ScenarioSpec[];
const dense = scenarios.find((scenario) => scenario.name === "dense-open-120")!;
const mixed = scenarios.find((scenario) => scenario.name === "mixed-destinations-120")!;

describe("isolated browser runner artifacts", () => {
  it("creates deterministic concurrent member searches with exact goals", () => {
    const specs = createLoadSpecs(dense, 1000, "concurrent-burst");
    expect(specs).toHaveLength(1000);
    expect(specs[0]).toMatchObject({ startX: 10, startY: 10, goalX: 80, goalY: 60, issueTick: 1, seed: 167001 });
    expect(specs.at(-1)).toMatchObject({ goalX: 80, goalY: 60, issueTick: 1 });
    expect(new Set(specs.map((spec) => `${spec.startX},${spec.startY}`)).size).toBe(1000);
    expect(new Set(specs.map((spec) => spec.seed)).size).toBe(1000);
    expect(createLoadSpecs(dense, 1000, "concurrent-burst")).toEqual(specs);
  });

  it("staggers groups without changing population allocation or destinations", () => {
    const specs = createLoadSpecs(mixed, 1000, "staggered-groups");
    expect(specs).toHaveLength(1000);
    for (let group = 0; group < 8; group += 1) {
      const members = specs.filter((spec) => spec.groupId === `g${group}`);
      expect(members).toHaveLength(125);
      expect(new Set(members.map((spec) => spec.issueTick))).toEqual(new Set([group + 1]));
      expect(new Set(members.map((spec) => `${spec.goalX},${spec.goalY}`))).toEqual(
        new Set([`${Math.floor(mixed.groups[group]!.destination.x)},${Math.floor(mixed.groups[group]!.destination.y)}`]),
      );
    }
  });

  it("uses recorded blocked rectangles and nearest-rank timing statistics", () => {
    const narrow = scenarios.find((scenario) => scenario.name === "narrow-mutation-120")!;
    const passable = createPassability(narrow);
    expect(passable).toHaveLength(14_400);
    expect(passable[60]).toBe(0);
    expect(passable[59 * 120 + 60]).toBe(1);
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(nearestRank(values, 0.95)).toBe(95);
    expect(stats(values)).toMatchObject({ count: 100, min: 1, mean: 50.5, p50: 50, p95: 95, max: 100 });
  });

  it("separates wall-time and tick summaries and evaluates both thresholds", () => {
    const requests = Array.from({ length: 100 }, (_, index): PathRequestMetric => ({
      id: index + 1,
      issueTick: 1,
      dueTick: 3,
      issueToResponseMs: index + 1,
      issueToApplyTicks: 2,
      applyCostMs: (index + 1) / 100,
      snapshotBytes: 14_400,
      passableVersion: 0,
      outcome: "applied",
    }));
    const summary = summarizeRequests(requests);
    expect(summary.issueToResponseWallMs.p95).toBe(95);
    expect(summary.pathApplyMainThreadMs.p95).toBe(0.95);
    expect(summary.issueToApplyTicks.p95).toBe(2);
    expect(summary.responseP95Exceeds33_3ms).toBe(true);
    expect(summary.applyP95Exceeds2ms).toBe(false);
    expect(summary.snapshotPayloadBytes).toBe(1_440_000);
  });

  it("hashes logical routes and target ticks, not transport timing", () => {
    const response = { kind: "path" as const, id: 1, ok: true, waypoints: new Int16Array([1, 2, 3, 4]), cost: 2828 };
    const route: AppliedLogicalRoute = { id: 1, issueTick: 1, dueTick: 3, applyTick: 3, response };
    expect(canonicalLogical([route])).toBe(canonicalLogical([{ ...route, response: { ...response, waypoints: response.waypoints.slice() } }]));
    expect(canonicalLogical([route])).not.toBe(canonicalLogical([{ ...route, applyTick: 4 }]));
    expect(canonicalLogical([route])).not.toBe(canonicalLogical([{ ...route, response: { ...response, cost: 3000 } }]));
  });

  it("preserves scheduler due-tick and ascending application in a local smoke", () => {
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const applied: number[] = [];
    for (const spec of createLoadSpecs(dense, 20, "concurrent-burst")) {
      scheduler.requestPath(spec, {
        issueTick: 1,
        seed: spec.seed,
        passability: createPassability(dense),
        onApply: (response) => applied.push(response.id),
      });
    }
    expect(scheduler.pump(1)).toBe(true);
    expect(scheduler.pump(2)).toBe(true);
    expect(applied).toEqual([]);
    expect(scheduler.pump(3)).toBe(true);
    expect(applied).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(scheduler.blockedTicks).toBe(0);
  });

  it("ships a browser page and real-worker launchers without external services", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("./browser-main.ts", import.meta.url), "utf8");
    const launcher = readFileSync(new URL("./run-browser.mjs", import.meta.url), "utf8");
    expect(html).toContain('type="module" src="./browser-main.ts"');
    expect(main).toContain("createPathWorkerFactory()");
    expect(main).toContain('new URL("./flow.worker.ts", import.meta.url)');
    for (const browser of ["chrome", "chromium", "firefox", "webkit", "safari"]) expect(launcher).toContain(`\"${browser}\"`);
  });
});

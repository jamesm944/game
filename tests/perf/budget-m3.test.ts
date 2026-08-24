/**
 * M3 sign-off perf budget gate — SPEC §7 / M3-T10 (issue #55).
 *
 * Re-runs the §7 CPU gates at the M3 workload
 * (tests/helpers/budget-scenario-m3.ts): 305 fully deep-simmed Pops
 * (needs/skills/lifecycle/social active) on the compressed fixture
 * clock, measured across the daily transition zoo — evening release,
 * leisure planning, bedding, dawn births and wake refills all land
 * inside the window. Asserts:
 *
 *   - p95 sim tick < 8 ms   (unchanged hard cap)
 *   - mirror snapshot copy < 2 ms @500 instances
 *
 * CI TOLERANCE (documented contract, same as the M1/M2 gates):
 * budgets ×4 under process.env.CI; vitest runs perf files serially so
 * gates measure the sim, not worker contention. Local runs assert the
 * raw §7 numbers recorded in docs/m3-budget.md via
 * `npx tsx tools/perf-record.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  approximateDrawCalls,
  CI_TOLERANCE_MULTIPLIER,
  MIRROR_COPY_BUDGET_MS,
  TICK_P95_BUDGET_MS,
} from "../helpers/budget-scenario";
import { runBudgetScenarioM3 } from "../helpers/budget-scenario-m3";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const IN_CI =
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.CI === "yes";

function effectiveBudget(ms: number): number {
  return IN_CI ? ms * CI_TOLERANCE_MULTIPLIER : ms;
}

describe("M3 perf budget gate (SPEC §7, deep-sim + schedules active)", () => {
  it("keeps p95 tick under 8 ms with 300+ deep-simmed Pops through the transition zoo", () => {
    const run = runBudgetScenarioM3();
    console.log(
      `budget-m3 ${String(run.villagerCount)}v/${String(run.measuredTicks)}t: ` +
        `tick mean ${run.meanTickMs.toFixed(3)} · p95 ${run.p95TickMs.toFixed(3)} · ` +
        `max ${run.maxTickMs.toFixed(3)} ms · mirror copy ${run.mirrorCopyMs.toFixed(3)} ms · ` +
        `households ${String(run.householdsFormed)} · population ${String(run.populationEnd)}`,
    );
    // The deep-sim must have been LIVE while measuring: households
    // formed at the dawn boundary inside the window (lifecycle +
    // households active) and the full deep census was maintained
    // throughout.
    expect(run.householdsFormed).toBeGreaterThan(0);
    expect(run.populationEnd).toBeGreaterThanOrEqual(run.villagerCount);
    expect(run.p95TickMs).toBeLessThan(effectiveBudget(TICK_P95_BUDGET_MS));
    expect(run.mirrorCopyMs).toBeLessThan(
      effectiveBudget(MIRROR_COPY_BUDGET_MS),
    );
  }, 240_000);

  it("approximated draw calls stay inside the §7 table", () => {
    // M3 composition today: villager billboards (military unchanged).
    expect(approximateDrawCalls(1)).toBeLessThanOrEqual(90); // §7 "typical"
    expect(approximateDrawCalls(8)).toBeLessThan(150); // full roster worst
  });
});

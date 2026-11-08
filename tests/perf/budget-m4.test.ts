/**
 * M4 sign-off perf budget gate — SPEC §7 / M4-T7 (issue #62).
 *
 * Re-runs the §7 CPU gates at the M4 workload
 * (tests/helpers/budget-scenario-m4.ts): the full M3 deep-sim village
 * (305 Pops, compressed-clock transition zoo) PLUS the delegation and
 * companies layers live — a chartered mining company whose branch
 * camps tithe every miner delivery, expansion thinks scanning and
 * siting proposals at the 1 Hz cadence, and branch foremen seated by
 * the staffing pass. Asserts:
 *
 *   - p95 sim tick < 8 ms   (unchanged hard cap)
 *   - mirror snapshot copy < 2 ms @500 instances
 *   - the M4 layers were demonstrably ON while measuring (company +
 *     branches + treasury accrual + seated foremen)
 *
 * CI TOLERANCE (documented contract, same as the M1/M2/M3 gates):
 * budgets ×4 under process.env.CI; vitest runs perf files serially so
 * gates measure the sim, not worker contention. Local runs assert the
 * raw §7 numbers recorded in docs/m4-budget.md via
 * `npx tsx tools/perf-record.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  approximateDrawCalls,
  effectiveBudget,
  MIRROR_COPY_BUDGET_MS,
  TICK_P95_BUDGET_MS,
} from "../helpers/budget-scenario";
import { runBudgetScenarioM4 } from "../helpers/budget-scenario-m4";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

describe("M4 perf budget gate (SPEC §7, management+companies active)", () => {
  it("keeps p95 tick under 8 ms with 300+ deep Pops plus delegation and companies", () => {
    const run = runBudgetScenarioM4();
    console.log(
      `budget-m4 ${String(run.villagerCount)}v/${String(run.measuredTicks)}t: ` +
        `tick mean ${run.meanTickMs.toFixed(3)} · p95 ${run.p95TickMs.toFixed(3)} · ` +
        `max ${run.maxTickMs.toFixed(3)} ms · mirror copy ${run.mirrorCopyMs.toFixed(3)} ms · ` +
        `companies ${String(run.companies)} · branches ${String(run.branches)} · ` +
        `foremen ${String(run.foremen)} · treasury ${String(run.treasuryMilli)} milli · ` +
        `households ${String(run.householdsFormed)} · population ${String(run.populationEnd)}`,
    );
    // The M4 layers must have been LIVE while measuring, or the run
    // silently degenerated into the M3 scenario.
    expect(run.companies).toBeGreaterThanOrEqual(1);
    expect(run.branches).toBeGreaterThanOrEqual(2);
    expect(run.foremen).toBeGreaterThan(0);
    expect(run.treasuryMilli).toBeGreaterThan(0);
    // The deep-sim must still be fully alive underneath.
    expect(run.householdsFormed).toBeGreaterThan(0);
    expect(run.populationEnd).toBeGreaterThanOrEqual(run.villagerCount);
    expect(run.p95TickMs).toBeLessThan(effectiveBudget(TICK_P95_BUDGET_MS));
    expect(run.mirrorCopyMs).toBeLessThan(
      effectiveBudget(MIRROR_COPY_BUDGET_MS),
    );
  }, 300_000);

  it("approximated draw calls stay inside the §7 table", () => {
    // M4 composition today: villager billboards (military unchanged).
    expect(approximateDrawCalls(1)).toBeLessThanOrEqual(90); // §7 "typical"
    expect(approximateDrawCalls(8)).toBeLessThan(150); // full roster worst
  });
});

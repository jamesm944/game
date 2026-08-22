/**
 * M1 sign-off perf budget gate — SPEC §7 / M1-T11.
 *
 * Runs the canonical headless budget workload (see
 * tests/helpers/budget-scenario.ts: 300 villagers, gather+move, 300
 * measured ticks on a seeded 120×120 map) and asserts the two CPU
 * gates of the §7 contract:
 *
 *   - p95 sim tick < 8 ms   (hard cap, 30 Hz budget)
 *   - mirror snapshot copy < 2 ms @300 instances (§7 allows 2 ms @500)
 *
 * CI TOLERANCE (documented contract): shared CI vCPUs time-slice
 * unpredictably, so assertions multiply every budget by ×4 when
 * process.env.CI is set. Deliberately generous — this suite is a
 * regression tripwire, not a certification; the nightly soak refines
 * the real envelope (SPEC §7). Local runs use the raw §7 numbers,
 * which are what get recorded in docs/m1-budget.md via
 * `npx tsx tools/perf-record.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  approximateDrawCalls,
  CI_TOLERANCE_MULTIPLIER,
  MIRROR_COPY_BUDGET_MS,
  runBudgetScenario,
  TICK_P95_BUDGET_MS,
} from "../helpers/budget-scenario";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const IN_CI =
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.CI === "yes";

function effectiveBudget(ms: number): number {
  return IN_CI ? ms * CI_TOLERANCE_MULTIPLIER : ms;
}

describe("M1 perf budget gate (SPEC §7)", () => {
  it("keeps p95 tick under 8 ms and mirror copy under 2 ms with 300 gathering villagers", () => {
    const run = runBudgetScenario();
    console.log(
      `budget ${String(run.villagerCount)}v/${String(run.measuredTicks)}t: ` +
        `tick mean ${run.meanTickMs.toFixed(3)} · p95 ${run.p95TickMs.toFixed(3)} · ` +
        `max ${run.maxTickMs.toFixed(3)} ms · mirror copy ${run.mirrorCopyMs.toFixed(3)} ms`,
    );
    expect(run.p95TickMs).toBeLessThan(effectiveBudget(TICK_P95_BUDGET_MS));
    expect(run.mirrorCopyMs).toBeLessThan(
      effectiveBudget(MIRROR_COPY_BUDGET_MS),
    );
  });

  it("approximated draw calls stay inside the §7 table", () => {
    // Current M1 composition: exactly one unit type (villager billboards).
    const typical = approximateDrawCalls(1);
    expect(typical).toBeLessThanOrEqual(90); // §7 "typical" cap
    // Even an 8-unit-type roster (post-M2 military) stays far under the
    // hard cap because instancing keeps draws per TYPE, not per unit.
    expect(approximateDrawCalls(8)).toBeLessThan(150);
  });
});

/**
 * M2 sign-off perf budget gate — SPEC §7 / M2-T11 (issue #45).
 *
 * Re-runs the §7 CPU gates at the M2 workload
 * (tests/helpers/budget-scenario-m2.ts): the canonical 300-villager
 * gather economy PLUS 200 knights in sustained melee PLUS real fog
 * planes stamping ~500 sight contributors per tick — everything the
 * milestone demo actually runs. Asserts:
 *
 *   - p95 sim tick < 8 ms   (unchanged hard cap)
 *   - mirror snapshot copy < 2 ms @500 instances
 *
 * CI TOLERANCE (documented contract, same as tests/perf/budget.test.ts):
 * budgets ×4 under process.env.CI; vitest runs perf files serially so
 * gates measure the sim, not worker contention. Local runs assert the
 * raw §7 numbers recorded in docs/m2-budget.md via
 * `npx tsx tools/perf-record.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  approximateDrawCalls,
  effectiveBudget,
  MIRROR_COPY_BUDGET_MS,
  TICK_P95_BUDGET_MS,
} from "../helpers/budget-scenario";
import { runBudgetScenarioM2 } from "../helpers/budget-scenario-m2";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

describe("M2 perf budget gate (SPEC §7, combat+fog active)", () => {
  it("keeps p95 tick under 8 ms and mirror copy under 2 ms with economy + melee + fog", () => {
    const run = runBudgetScenarioM2();
    console.log(
      `budget-m2 ${String(run.villagerCount)}v+${String(run.knightsPerSide * 2)}k/${String(run.measuredTicks)}t: ` +
        `tick mean ${run.meanTickMs.toFixed(3)} · p95 ${run.p95TickMs.toFixed(3)} · ` +
        `max ${run.maxTickMs.toFixed(3)} ms · mirror copy ${run.mirrorCopyMs.toFixed(3)} ms · ` +
        `survivors p/a ${run.survivorsPerSide[0]}/${run.survivorsPerSide[1]}`,
    );
    // The battle must still be live when measurement ends, or the run
    // silently degenerated into an economy-only scenario.
    expect(run.survivorsPerSide[0]).toBeGreaterThan(0);
    expect(run.survivorsPerSide[1]).toBeGreaterThan(0);
    expect(run.p95TickMs).toBeLessThan(effectiveBudget(TICK_P95_BUDGET_MS));
    expect(run.mirrorCopyMs).toBeLessThan(
      effectiveBudget(MIRROR_COPY_BUDGET_MS),
    );
  }, 240_000);

  it("approximated draw calls stay inside the §7 table", () => {
    // M2 composition: villager + knight billboards today.
    expect(approximateDrawCalls(2)).toBeLessThanOrEqual(90); // §7 "typical"
    expect(approximateDrawCalls(8)).toBeLessThan(150); // full roster worst
  });
});

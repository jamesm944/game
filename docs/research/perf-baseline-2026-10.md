# Perf baseline & flaky tick-budget gate (map 6 · #141)

Date: 2026-10-17 · Machine: Apple M1, 8 cores · Branch: `main` @ `53e72c2`

## Question

Is the `budget-m2` failure (p95 tick 10.3 ms vs 8 ms, seen in a full-suite run)
a real regression or load noise, and how should the gates behave under load?

## What was measured

`npx vitest run tests/perf` (12 files, 41 tests), dev server stopped first.
Run twice: default config, then `--no-file-parallelism`.

- [`vitest.config.ts`](../../vitest.config.ts) **already sets `fileParallelism: false`**, so
  cross-file worker contention is _not_ the cause (my first hypothesis was wrong).
- `uptime` during the runs: **load average 14.5 / 12.0 / 9.3 on 8 cores**.
  Top CPU consumers were Chrome helper processes (81 %, 66 %, 55 %), `replayd`
  (81 %, screen recording) and the IDE renderer — the machine was never idle.

| Gate (workload)           | Recorded quiet-machine p95 (`docs/m5-budget.md`) | This session | Budget |
| ------------------------- | ------------------------------------------------ | ------------ | ------ |
| M1 · 300 gatherers        | 2.2 – 3.0 ms                                     | 16.2 ms      | 8 ms   |
| M2 · melee + fog          | 7.0 – 7.6 ms                                     | 35.0 ms      | 8 ms   |
| M3 · deep-sim + schedules | 2.5 – 3.0 ms                                     | 17.2 ms      | 8 ms   |
| M4 · management + cos.    | 2.0 – 2.1 ms                                     | 17.5 ms      | 8 ms   |

Every workload reads **~5–8× its recorded value**, uniformly, including ones with
~4× headroom. A real code regression would not scale all four workloads by the same
factor; CPU starvation would. `schedules-budget` flipped between 1.02 ms (fail) and
pass across runs against a 1.0 ms limit.

## Findings

1. **Not a regression — unprovable either way on this machine state.** No clean
   number is obtainable while the browser/recorder load is present. Re-baseline
   must be run with Chrome and screen recording closed (`pmset`/Activity Monitor
   check: load < 2).
2. **The M2 budget has almost no headroom even when quiet.** `docs/m5-budget.md`
   records median p95 7.27 ms vs the 8 ms hard limit (~4 % at worst run). Every
   new sim system (mental breaks, temperature, fluids, z-levels…) lands on a
   budget that is already ~90 % spent in the combat+fog workload. **This is the
   binding constraint for the sim-depth ticket (#146)** — deeper sim needs either
   a budget renegotiation, tick tiering (SPEC §2.3 already staggers rare ticks),
   or moving the sim to a worker/WASM path (ADR-0004).
3. **Wall-clock p95 is the wrong instrument under shared CPU.** `performance.now()`
   deltas include time the process was descheduled.

## Decision (recommended; implementing it is a build ticket, not done here)

- Keep the 8 ms / 2 ms budgets as the _product_ contract.
- Replace load-sensitive wall-clock gating with a **calibrated relative gate**:
  run a fixed pure-JS spin kernel (~50 ms) before each gate, record its time vs a
  checked-in reference, and scale the budget by that ratio (clamped, e.g. ≤ 4×),
  printing the factor. Existing `effectiveBudget()` copies in `budget*.test.ts`
  and `fog.test.ts` (flat ×4 when `CI=1`) collapse into one shared helper.
- Keep a nightly idle-runner number as the source of truth for `docs/m*-budget.md`.

## Not done / open

- No code changed. Clean idle numbers still need to be captured (checklist above).

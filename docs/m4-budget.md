# M4 Performance Budget Run — SPEC §7 sign-off (M4-T7)

**Date:** 2026-08-25 · **Machine:** Apple M1, Node v22.16.0, macOS (local, no CI)
**Scenario (M4 workload):** the FULL M3 deep-sim village — 305 fully deep-simmed
Pops through the compressed-clock daily transition zoo (`LifecycleConfig`
dayTicks 600) — PLUS the whole §2.7 delegation + companies stack live and
loaded: a mining company chartered over two stamped camps beside rich iron
nodes at a 50% tithe, ~40 miners re-pointed onto its nodes so every drop-off
flushes a treasury accrual AND an economic-ledger credit on top of the
deposit, expansion thinks scanning unclaimed ground and siting always-ask
proposals at the 1 Hz cadence, and branch foremen seated by the staffing pass
from eight deliberately unordered villagers. Warm-up is extended to 2,400
ticks so JIT AND the first miner deliveries land before measurement begins;
the measured window stays 600 individually timed ticks spanning the daily
transition zoo; mirror copy = reusable-frame capture, best-of-7. Liveness is
asserted when measuring ends (company + 2 branches + seated foremen +
non-zero treasury), so the gate cannot silently degenerate into the M3
scenario. Reproduce with `npx tsx tools/perf-record.ts [runs]`; gate lives in
`tests/perf/budget-m4.test.ts` (+ shared scenario in
`tests/helpers/budget-scenario-m4.ts`).

## Budget table (SPEC §7 contract) — M4 workload

| Metric                            | Measured (5 runs: best / median / worst) | §7 cap             | Verdict |
| --------------------------------- | ---------------------------------------- | ------------------ | ------- |
| Sim tick mean                     | 1.320 / 1.327 / 1.345 ms                 | —                  | ✅      |
| **Sim tick p95**                  | **2.094 / 2.119 / 2.191 ms**             | **≤ 8 ms hard**    | ✅ ~3.8× headroom |
| Sim tick max                      | 6.221 / 6.267 / 6.852 ms                 | — (p95 is gated)   | note    |
| **Mirror snapshot copy** @500 inst| **0.0118 / 0.0135 / 0.0136 ms**          | ≤ 2 ms @500 inst   | ✅ ~145× headroom |
| Draw calls                        | 10 (static approximation: terrain + villager billboards + buildings + rings + markers + ghost) | ≤ 90 typ/≤150 hard | ✅      |
| Triangles/frame                   | not measured headlessly                  | ≤ 600 k typ        | manual  |
| Renderer frame time               | not measurable headlessly (GPU)          | ≤ 6 ms typ         | manual  |

Liveness at measurement end (every run): companies 1 · branches 2 · foremen
2 · treasury 40,000 milli-credits · households 13 · population 315 (births
landed). The delegation+companies layer costs ≈ nothing measurable over the
M3 baseline — company thinks ride the existing 30-tick stagger, accrual
flushes are integer adds on credit events already counted by gather, and the
management lock sweep walks rows the pop brain touched anyway.

Context from the same session's re-records: M1 economy p95 median 2.324 ms,
M2 combat+fog p95 median 7.273 ms, M3 deep-sim p95 median 2.555 ms. Note the
M4 scenario warms up 2,400 ticks before sampling (vs M3's 150) because the
gate additionally demands live company accruals — the calmer window also
explains its slightly lower p95/max.

## CI tolerance (documented contract)

Same contract as M1/M2/M3 (`docs/m1-budget.md`, `docs/m2-budget.md`,
`docs/m3-budget.md`): shared CI vCPUs time-slice unpredictably, so the perf
gates multiply every budget ×4 when `process.env.CI` is set, and vitest runs
test files serially (`vitest.config.ts` `fileParallelism: false`). Local runs
assert the raw §7 numbers recorded above.

## Demo checklist (M4 demo: "win via each path against the AI; charter a mining company and watch it expand itself")

Executed headlessly as ONE consolidated six-case suite:
`tests/e2e/m4-paths.test.ts` ✅ — every case boots the shared production
skirmish (`createSkirmishWorld`) with the real KnowledgeView-gated AI
playing its fast-castle-knights strategy through the same inbox, and a
scripted player winning via each §2.11 path on pinned seed 20260902:

- **Conquest at tick 16,800** (9.3 sim-minutes): dark-age militia mass off
  three barracks razes every AI military-production building (compact
  companion to the full FC→knights macro in `tests/e2e/m2-full-game.test.ts`).
- **Knowledge at tick 3,870** (2.1 sim-minutes, 2,000,000 milli-KP banked):
  real school lessons — teacher-scaled KP credits from fourteen pupils under
  a stamped Grand Academy, sustain timer banking across successive lesson
  windows on a compressed clock.
- **Culture at tick 960**: twin Monuments plus a festival season — every
  `hostFestival` command converts Food+Gold into a timed prestige burst
  through the atomic debit path under a stamped Grand Monument.
- **Wonder at tick 960**: the completed Wonder stands through its hold timer.
- **Relic at tick 960**: a monk banks BOTH relics ground → monk → monastery
  through the collect/deposit commands; ALL relics hold through the timer.
- **Economic at tick 4,380** (2.4 sim-minutes, 1,320,000 milli-value banked):
  a chartered mining company whose Branch camp receives real miner
  deliveries; the full market value of every branch credit event feeds the
  ledger the evaluator derives its sustained rate from.

And in `tests/e2e/m4-company-growth.test.ts` (extended this ticket): ONE run
demonstrates BOTH §2.7 origins back-to-back — the commissioned "Deepvein
Combine" self-expands to a second camp paid from its own treasury, then three
fresh directly-owned metal workplaces plus one rated unlocked Pop trigger an
ORGANIC founding at the next daily scan (FOUNDED entry in the public
expansion log, CompanyOrigin row stamped, all three workplaces absorbed as
seed Branches) with zero player commands beyond ordinary labor orders.

### Manual items remaining (browser-only; cannot execute headlessly)

See `docs/m4-manual.md`.

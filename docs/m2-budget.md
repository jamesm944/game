# M2 Performance Budget Run — SPEC §7 sign-off (M2-T11)

**Date:** 2026-08-24 · **Machine:** Apple M1, Node v22.16.0, macOS (local, no CI)
**Scenario (M2 workload):** the M1 economy load re-run on the shared production
skirmish bootstrap with COMBAT and REAL FOG active — seeded 120×120 map, full
M2 system roster (movement, gather, placement, construction, training,
production, age, combat, equipment, victory evaluator, KnowledgeView-gated AI
planner), 300 villagers on a full gather+move loop PLUS 100 knights per side
in a sustained attack-move melee (~500 sight contributors feeding real
per-player fog planes), 120 warm-up ticks then 300 individually timed ticks.
Mirror copy = reusable-frame snapshot capture, best-of-7. The battle is
asserted live when measurement ends (survivors > 0 per side), so the gate
cannot silently degenerate into an economy-only run. Reproduce with
`npx tsx tools/perf-record.ts [runs]`; gates live in `tests/perf/budget.test.ts`
(M1 workload) and `tests/perf/budget-m2.test.ts` (+ shared scenario in
`tests/helpers/budget-scenario-m2.ts`).

## Budget table (SPEC §7 contract) — M2 workload

| Metric                            | Measured (5 runs: best / median / worst) | §7 cap             | Verdict |
| --------------------------------- | ---------------------------------------- | ------------------ | ------- |
| Sim tick mean                     | 2.337 / 2.378 / 2.415 ms                 | —                  | ✅      |
| **Sim tick p95**                  | **6.377 / 6.580 / 6.682 ms**             | **≤ 8 ms hard**    | ✅      |
| Sim tick max                      | 12.345 / 12.860 / 13.029 ms              | — (p95 is gated)   | note    |
| **Mirror snapshot copy** @500 inst| **0.019 / 0.078 / 0.081 ms**             | ≤ 2 ms @500 inst   | ✅ ~25× headroom |
| Draw calls                        | 11 (static approximation: terrain + villager/knight billboards + buildings + rings + markers + ghost) | ≤ 90 typ/≤150 hard | ✅      |
| Triangles/frame                   | not measured headlessly                  | ≤ 600 k typ        | manual  |
| Renderer frame time               | not measurable headlessly (GPU)          | ≤ 6 ms typ         | manual  |

For comparison, the same session's M1-economy-only re-record (unchanged gate):
p95 best/median/worst = 1.849 / 2.608 / 3.156 ms. Combat + fog roughly 2.5×
the tick cost at the same population scale — the M2 envelope sits inside the
8 ms hard cap with ~1.4 ms of p95 headroom on this machine. The nightly soak
(10k+ ticks, SPEC §7) owns tail characterization.

## CI tolerance (documented contract)

Same contract as M1 (`docs/m1-budget.md`): shared CI vCPUs time-slice
unpredictably, so both perf gates multiply every budget ×4 when
`process.env.CI` is set, and vitest runs test files serially
(`vitest.config.ts` `fileParallelism: false`). Local runs assert the raw §7
numbers recorded above.

## Demo checklist (M2 demo: "beat the scripted AI by conquest on a 120×120")

Executed headlessly as one scripted macro game over the real command surface:
`tests/e2e/m2-full-game.test.ts` ✅ — Fast Castle off the opening ladder
(houses + barracks → Feudal → twin stables → Castle), six knights trained via
`trainUnit`, then an attack-push that razes every AI military-production
building. The AI plays its own fast-castle-knights strategy through the same
inbox on the same fog-honest KnowledgeView. Result on the pinned seed:

- **Conquest victory for the human player at tick 13,290** (~7.4 sim-minutes
  at 30 Hz); losers: `[AI_PLAYER, "conquest"]`; winner reached Castle age;
  3 AI military buildings observed standing and destroyed across the push
  (including one rebuild razed again — the conquest ledger catches the
  rebuild window).
- Scenario notes: both sides start from one symmetric scenario-grade FC bank
  written at bootstrap (documented privilege; everything after is paid through
  real costs). The seed (20260902) is pinned because outcomes are a pure
  function of it — other seeds can stalemate, and mapgen water at the mirrored
  start center rejects some seeds outright in the T10 bootstrap (known
  scenario-editor edge, tracked outside this ticket).

### Manual items remaining (browser-only; cannot execute headlessly)

See `docs/m2-manual.md`.

# M3 Performance Budget Run — SPEC §7 sign-off (M3-T10)

**Date:** 2026-08-24 · **Machine:** Apple M1, Node v22.16.0, macOS (local, no CI)
**Scenario (M3 workload):** 305 FULLY DEEP-SIMMED Pops (Identity/Traits/
Skills/Needs/Lessons/Body/Morale on every villager) on the shared production
skirmish bootstrap with the whole M3 stack live — needs decay + eating,
knowledge-vs-practice rust, lifecycle + households + births, school lessons,
day/night schedules, leisure/social bonds, morale recovery and the IAUS pop
brain. The measured window spans the DAILY TRANSITION ZOO on a compressed
fixture clock (LifecycleConfig dayTicks 600): evening-release storm, leisure
planning wave, 22:00 bedding storm, dawn household-formation + birth-roll
boundary and 05:00 wake refills all land inside it — the churniest recurring
M3 load a canonical-clock window would only sample occasionally. 120 warm-up
ticks then 600 individually timed ticks; mirror copy = reusable-frame capture,
best-of-7. Households are asserted formed when measurement ends so the gate
cannot silently degenerate into an economy-only run. Reproduce with
`npx tsx tools/perf-record.ts [runs]`; gate lives in
`tests/perf/budget-m3.test.ts` (+ shared scenario in
`tests/helpers/budget-scenario-m3.ts`).

## Budget table (SPEC §7 contract) — M3 workload

| Metric                            | Measured (5 runs: best / median / worst) | §7 cap             | Verdict |
| --------------------------------- | ---------------------------------------- | ------------------ | ------- |
| Sim tick mean                     | 1.310 / 1.323 / 1.387 ms                 | —                  | ✅      |
| **Sim tick p95**                  | **2.650 / 2.719 / 3.104 ms**             | **≤ 8 ms hard**    | ✅ ~2.6× headroom |
| Sim tick max                      | 14.418 / 15.968 / 16.945 ms              | — (p95 is gated)   | note    |
| **Mirror snapshot copy** @500 inst| **0.0107 / 0.0114 / 0.0123 ms**          | ≤ 2 ms @500 inst   | ✅ ~160× headroom |
| Draw calls                        | 10 (static approximation: terrain + villager billboards + buildings + rings + markers + ghost) | ≤ 90 typ/≤150 hard | ✅      |
| Triangles/frame                   | not measured headlessly                  | ≤ 600 k typ        | manual  |
| Renderer frame time               | not measurable headlessly (GPU)          | ≤ 6 ms typ         | manual  |

Context from the same session's re-records: M1 economy-only p95 median
2.965 ms, M2 combat+fog p95 median 7.205 ms. The M3 deep-sim stack adds
~1.3 ms/tick mean over bare movement+gather at equal population — needs/skill
rare ticks are staggered (§2.3 ticker tiering), the IAUS brain amortizes to
~10 scorer passes/tick, and schedule transitions ride the existing movement
stack — so the full deep-sim village sits well inside the §7 hard cap.

## CI tolerance (documented contract)

Same contract as M1/M2 (`docs/m1-budget.md`, `docs/m2-budget.md`): shared CI
vCPUs time-slice unpredictably, so the perf gates multiply every budget ×4
when `process.env.CI` is set, and vitest runs test files serially
(`vitest.config.ts` `fileParallelism: false`). Local runs assert the raw §7
numbers recorded above.

## Demo checklist (M3 demo: "watch one village week")

Executed headlessly as ONE fully unattended run:
`tests/e2e/m3-village-week.test.ts` ✅ — zero player commands for the entire
week (no AI opponent either; every assignment the week runs on was emitted by
the IAUS pop brain through the same command interface player orders use).
Scenario-editor founding before the first step (documented privilege, same
stance as every budget/e2e fixture): town center + church + tavern + school +
four houses stamped finished, a work-day gather ring scattered, census topped
up to 41 named settlers, two settlers given starter knowledge (a teacher on
duty from the first lesson window), and half the settlers opened the week on
low morale (the founding season was hard — which is what makes taverns
attractive: `moralePull` in systems/social.ts means contented villagers
rightly stay home). One week = 7 × 7,200-tick days (half-scale §2.4 days,
compressed LIFE thresholds) on pinned seed 20260814:

- **Kids graduate: 5 natural-born children** sat ≥3 daily lessons and paid
  the graduation credit on their exact adult boundary (Lessons.graduated).
- **Families form: 10 households**, homed two-per-house across the ring,
  with **5 births** landed into them (digest-visible Household.birthCount).
- **Tavern drama happens: 87 completed outings**, including **3 tavern
  rounds** at the documented 2-gold sink (SocialEvents VISIT entries,
  amount −2); Sunday kept its promise with **7 Mass completions** bonding
  8–26 co-attendees each (SocialEvents MASS entries).
- **Nobody clicks, the town still runs AND grows:** food 3000 → 5786, wood
  3000 → 3770, gold 400 → 494 despite birth costs and tavern sinks; census
  36 → 41 living named villagers at week's end.

### Manual items remaining (browser-only; cannot execute headlessly)

See `docs/m3-manual.md`.

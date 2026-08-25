# M5 Performance Budget Run — SPEC §7 final ship sign-off (M5-T6)

**Date:** 2026-08-25 · **Machine:** Apple M1, Node v22.16.0, macOS 14.6.1 (local, no CI)
**Scope:** the FINAL full-suite verification before ship. Every accumulated §7
workload was re-recorded fresh on this session's tree (M5-T5 balance pass
included) with `npx tsx tools/perf-record.ts 5` — 5 runs per workload, best /
median / worst below. The CI gates themselves live in `tests/perf/budget.test.ts`
(M1), `budget-m2.test.ts`, `budget-m3.test.ts`, and `budget-m4.test.ts`; all four
pass at raw (non-CI-tolerated) thresholds on this machine.

## Budget table (SPEC §7 contract) — all workloads, 5 runs each

### M1 economy workload (300 villagers · 300 ticks)

| Metric                            | Measured (best / median / worst) | §7 cap              | Verdict |
| --------------------------------- | -------------------------------- | ------------------- | ------- |
| Sim tick mean                     | 1.185 / 1.191 / 1.510 ms         | —                   | ✅      |
| **Sim tick p95**                  | **2.213 / 2.356 / 2.982 ms**     | **≤ 8 ms hard**     | ✅ ~3.4× headroom |
| **Mirror snapshot copy** @500 inst| **0.0316 / 0.0325 / 0.0411 ms**  | ≤ 2 ms @500 inst    | ✅ ~61× headroom  |
| Draw calls (static approximation) | 10                               | ≤ 90 typ/≤ 150 hard | ✅      |

### M2 workload — combat+fog active (300v + 200 knights · 300 ticks)

| Metric                            | Measured (best / median / worst) | §7 cap              | Verdict |
| --------------------------------- | -------------------------------- | ------------------- | ------- |
| Sim tick mean                     | 3.124 / 3.138 / 3.200 ms         | —                   | ✅      |
| **Sim tick p95**                  | **6.998 / 7.266 / 7.631 ms**     | **≤ 8 ms hard**     | ✅ tightest workload (~4% headroom at worst run; median clears by 0.73 ms) |
| **Mirror snapshot copy** @500 inst| **0.0157 / 0.0171 / 0.0769 ms**  | ≤ 2 ms @500 inst    | ✅ ~117× headroom |
| Draw calls (static approximation) | 11                               | ≤ 90 typ/≤ 150 hard | ✅      |

### M3 workload — deep-sim+schedules active (305 deep Pops · 600 ticks)

| Metric                            | Measured (best / median / worst) | §7 cap              | Verdict |
| --------------------------------- | -------------------------------- | ------------------- | ------- |
| Sim tick mean                     | 1.260 / 1.262 / 1.321 ms         | —                   | ✅      |
| **Sim tick p95**                  | **2.483 / 2.612 / 2.954 ms**     | **≤ 8 ms hard**     | ✅ ~3× headroom   |
| **Mirror snapshot copy** @500 inst| **0.0100 / 0.0104 / 0.0109 ms**  | ≤ 2 ms @500 inst    | ✅ ~190× headroom |
| Draw calls (static approximation) | 10                               | ≤ 90 typ/≤ 150 hard | ✅      |

Liveness (every M3 run): 12 households formed · population 305.

### M4 workload — management+companies active (305 deep Pops · 600 ticks)

The heaviest scenario: full M3 deep-sim PLUS delegation + companies live
(chartered mining company, 50% tithe, expansion thinks, seated foremen).

| Metric                            | Measured (best / median / worst) | §7 cap              | Verdict |
| --------------------------------- | -------------------------------- | ------------------- | ------- |
| Sim tick mean                     | 1.298 / 1.301 / 1.317 ms         | —                   | ✅      |
| **Sim tick p95**                  | **2.036 / 2.060 / 2.114 ms**     | **≤ 8 ms hard**     | ✅ ~3.9× headroom |
| **Mirror snapshot copy** @500 inst| **0.0117 / 0.0121 / 0.0133 ms**  | ≤ 2 ms @500 inst    | ✅ ~165× headroom |
| Draw calls (static approximation) | 10                               | ≤ 90 typ/≤ 150 hard | ✅      |

Liveness (every M4 run): companies 1 · branches 2 · foremen 2 · treasury
40,000 milli-credits · households 13 · population 316.

## Ship verdict vs the §7 contract

- **Sim tick p95 ≤ 8 ms:** PASS on every workload. The combat+fog M2 load is
  the binding constraint (median p95 7.27 ms); every management/social layer
  added since costs ≈ nothing against it.
- **Mirror+matrix writes ≤ 2 ms @500 instances:** PASS everywhere with two
  orders of magnitude of margin (worst single reading 0.077 ms).
- **Draw calls ≤ 150:** static approximation 10–11 per scene; the browser
  audit (`docs/m5-manual.md` §1) measured steady 5 real draws with overlays —
  far under even the typical cap.
- **Triangles/frame ≤ 600 k and renderer frame time ≤ 6 ms** are GPU numbers:
  not measurable headlessly; covered by the manual browser pass checklist in
  `docs/m5-manual.md` (§1–§2). No regression indicator: instance counts and
  draw-call approximations are unchanged since the M4 record.

Historical context (same-session medians): M1 p95 2.356 ms, M2 7.266 ms,
M3 2.612 ms, M4 2.060 ms — consistent with the M4-T7 record (p95 ≈ 2.09–2.19 ms
on its warmer window); no balance-pass regression.

## CI tolerance (documented contract)

Same contract as M1–M4: shared CI vCPUs time-slice unpredictably, so the perf
gates multiply every budget ×4 when `process.env.CI` is set, and vitest runs
test files serially (`vitest.config.ts` `fileParallelism: false`). Local runs
assert the raw §7 numbers recorded above.

## Ship demo checklist (M5 demo: "the shipped URL with saves, replays, sound, and all victory paths")

Executed headlessly across M5:

- Saves round-trip byte-exactly through the `.ageof` container with digest
  verification (`tests/saveRoundTrip.test.ts`), IndexedDB slots + rolling
  autosaves behind `game/saveManager.ts`.
- Replays record/export/import and reproduce digests exactly
  (`tests/replay.test.ts`); bug-report → fixture conversion ships as
  `npm run replay:to-fixture` (`tools/replay-to-fixture.ts`).
- Audio buses/voice pool/positional pan/jingles/ambient intents are golden-
  tested without an AudioContext (`tests/audio-intents.test.ts`,
  `tests/audio-scheduler.test.ts`).
- All six §2.11 victory paths still decided for the scripted player against
  the real AI on pinned seed 20260902 after the M5-T5 balance pass
  (`tests/e2e/m4-paths.test.ts`).
- Release channel: `.github/workflows/release.yml` runs the full gate
  (lint → typecheck → suite < 60 s) then builds with relative base and
  deploys `dist/` to GitHub Pages + attaches the zip as a release asset.

### Manual items remaining (browser-only; cannot execute headlessly)

See `docs/m5-manual.md` — GPU frame-time/triangle readings, LOD band feel,
audio mix by ear, and the itch.io upload steps (download the release zip,
unzip, drag the folder to a new itch.io project as a *shared HTML* build... or
zip-upload via butler later; no repackaging needed thanks to the relative
base).

# M1 Performance Budget Run — SPEC §7 sign-off (M1-T11)

**Date:** 2026-08-22 · **Machine:** Apple M1, Node v22.16.0, macOS (local, no CI)
**Scenario:** seeded 120×120 map, 300 villagers on a full gather+move
workload (walk → chop → haul → auto-repeat; steering, slot claims,
A*-costed drop-off choice, deposits), 120 warm-up ticks then 300
individually timed ticks. Mirror copy = reusable-frame snapshot capture,
best-of-7. Reproduce with `npx tsx tools/perf-record.ts [runs]`; the perf
gate lives in `tests/perf/budget.test.ts` (+ shared scenario in
`tests/helpers/budget-scenario.ts`).

## Budget table (SPEC §7 contract)

| Metric                            | Measured (5 runs: best / median / worst) | §7 cap            | Verdict |
| --------------------------------- | ---------------------------------------- | ----------------- | ------- |
| Sim tick mean                     | 1.17 / 1.28 / 1.49 ms                    | —                 | ✅      |
| **Sim tick p95**                  | **2.53 / 2.82 / 4.31 ms**                | **≤ 8 ms hard**   | ✅      |
| Sim tick max (GC spikes)          | 19.6 / 20.7 / 26.7 ms                    | — (p95 is gated)  | note    |
| **Mirror snapshot copy** @300 inst| **0.026 / 0.028 / 0.029 ms**             | ≤ 2 ms @500 inst  | ✅ ~70× headroom |
| Draw calls                        | 10 (static approximation)                | ≤ 90 typ/≤150 hard| ✅      |
| Triangles/frame                   | not measured headlessly                  | ≤ 600 k typ       | manual  |
| Renderer frame time               | not measurable headlessly (GPU)          | ≤ 6 ms typ        | manual  |

The occasional ~20 ms single-tick max is a GC/scheduler spike (~1 tick in
300); the p95 gate absorbs it by design. Nightly soak (10k+ ticks) will
characterize the tail distribution properly.

## CI tolerance (documented contract)

CI runners share noisy vCPUs; a 300-villager p95 of ~2.5–3 ms standalone
read ~15 ms next to a busy worker. Therefore `tests/perf/budget.test.ts`
multiplies every budget ×4 when `process.env.CI` is set, and vitest runs
test files serially (`vitest.config.ts` `fileParallelism: false`) so perf
gates measure the sim, not worker contention. The multiplier is a
regression tripwire, NOT a certification; local runs assert the raw §7
numbers recorded above.

## Draw calls — headless approximation method

`renderer.info.render.calls` needs a GL context, so the gate asserts a
STATIC composition count (`approximateDrawCalls` in budget-scenario.ts),
verified against current `render/` sources:

merged terrain splat (1) + one instanced billboard atlas per unit type
(1 today) + buildings/sites InstancedMesh (1) + selection-ring
InstancedMesh (1) + move-marker pool all-visible worst case (5) + build
ghost (1) = **10 draws**, vs ≤ 90 typical / ≤ 150 hard cap. Fog
DataTextures are uploads, not draws. Real GPU numbers below are manual.

## Demo checklist (M1 demo: "drag-box villagers, send them to chop/build")

Executed headlessly as a scripted e2e over the real command surface:
`tests/e2e/m1-demo.test.ts` ✅ — villagers chop & deposit wood, construct
two houses + a barracks to completion, TC training fills to the pop cap
(15), including a housed-pause under the TC-only cap of 5. All orders use
the same command kinds the UI emits.

### Manual items remaining (browser-only; cannot execute headlessly)

1. **Visual 60 fps under load** — run `npm run dev`, drag-box ~300+
   units (dev seed), verify frame time stays < 16 ms with the browser
   FPS meter / three.js stats. GPU-side rows of the table above get
   filled from this session (draw calls via `renderer.info.render.calls`,
   triangles, frame time).
2. **Drag-box feel** — selection rectangle renders and selects the right
   units; formation move rings + order feedback appear same-frame.
3. **Build ghost flow** — green/red validity follows the mouse; placement
   click issues the command that the e2e test exercises directly.
4. **Minimap + control groups** — dots/click-to-move/Ctrl-1..4 chips.
5. **Tab-switch safety** — 250 ms clamp + max-steps cap keep the loop
   alive after backgrounding (§2.1).

Any failure here gets filed against M1 follow-ups before M2 starts.

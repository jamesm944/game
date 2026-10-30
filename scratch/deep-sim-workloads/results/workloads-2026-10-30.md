# #164 completion runs — raw output (2026-10-30, Apple M1, load 5–15)

Probe: `scratch/deep-sim-workloads/workloads.ts` (`node --expose-gc --import tsx …`).
Original probe rerun: `npx tsx scratch/deep-sim-workloads/scaling.ts 300 1000 2000 3000`.
Gates: `npx vitest run tests/perf/…` (16/16 pass), `npx tsx tools/perf-record.ts 1`.

Key lines (full JSON in session transcript):

- perf-record 1× @ load ~6–8: m1 mean 3.811 p95 11.527 · m2 mean 7.545 p95 17.481 survivors 87/85 · m3 mean 3.445 p95 9.010 · m4 mean 3.051 p95 7.273. Quiet anchors (docs/m5-budget.md): p95 m1 2.356, m2 7.266, m3 2.612, m4 2.060 ms.
- fog (honest resolver): cpuMean 300→0.656ms, 1000→2.102, 2000@192→4.087, 5000@256→11.454, 20000@384→42.823 ms; ≈2.1–3.2 µs/contributor (wall). Flawed-resolver control: 300→wall mean 0.04 ms (≈16–22× undercount).
- brain isolated: 300p/60n wall mean 0.101 (10 thinks/tick, 600 scores) · 1000/200→0.258 (6,667) · 2000/400→0.812 (26,667) · 5000/1000→4.649 (166,667) · 5000/60→0.693 (10,000). ≈28 ns/score.
- combat: 300v+100/side cpu mean 5.517 (movement 2.58, aiPlanner 0.76, combat 0.48, fogFlush 0.12) · 300v+300/side cpu 11.423 (6.39/2.75/1.51/0.34) · 1000v+300/side cpu 22.276 (14.44/3.23/1.75/0.40). Snapshot counts 482/810/1531 → 11,086/18,630/35,213 logical bytes (23 B/unit).
- tail 1000: cpu mean 10.949 p95 25.87 max 113.7; worst-30 dominant: movement 17, popbrain 10, gather 2, households 1 (tick 600, 53.9 ms households). tail 2000: cpu mean 29.834 p95 95.9 max 278.4; popbrain 18, movement 11, households 1 (tick 600, 199.1 ms); evening storm ticks 450–454 (popbrain 140–179 ms); movement storms ticks 187/233/279/325/371 (93–209 ms). Mirror p50: 0.20 ms @1010 units, 1.32 ms @2010. Heap post-GC 23.8 MB @1k, 27.0 MB @2k (baseline ≈18–23 MB).
- tail 300: wall mean 2.74 p95 8.16; households tick-600 spike 10.6 ms even at T0.
- latency: 19/20 probes at 300/1000/2000 Pops — ticksToApplied = ticksToVisible = 1 (mean/p50/p95/p99/max all 1). Wall-to-visible mean 3.0/13.9/30.8 ms (loaded machine; = one tick's wall cost).
- scaling rerun @ load 11–13: 300 mean 3.767 p95 11.358 · 1000 mean 10.777 p95 26.829 · 2000 mean 24.085 p95 88.944 · 3000 mean 32.402 p95 167.829 (top: movement 16.7, popbrain 8.8). 3000 runs unpatched (name overflow fix live).
- Calibration kernel (2M sqrt): 3.1–15.5 ms across runs ⇒ wall percentiles not comparable across runs; CPU means + within-run ratios are the evidence.

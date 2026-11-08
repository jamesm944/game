# Wayfinder #168 — Recast corridor/gate prototype

## Decision

**Replace the old Recast conversion in the prototype lane with this supercover/gate candidate, but retain production integer A\* as the default.** The new candidate fixes the measured one-tile-gate failure and eliminates the 531 narrow conversion rejections without an A* planner fallback, partial paths, or production edits. It does not yet justify production adoption: narrow was slower than both preserved candidates in one run, dense was slower than A*, full snapshot rebuilds remain, and no browser worker was tested.

The candidate performs actual Recast/Detour 0.43.0 `findClosestPoint` → `findPath` → `findStraightPath` corridor queries. Production `World.step`, Activity/group continuation, formation slots, steering, collision, scheduler, mutation handling, and replay instrumentation are imported unchanged from the existing harness. [Candidate adapter](corridor-candidate.ts), [query engine](corridor-engine.ts), [existing harness](../../full-game-movement/harness/runner.ts), [production movement](../../../src/sim/systems/movement.ts).

## Semantic changes from #167

### Conservative continuous-segment supercover

The old adapter floored isolated straight-path points, deduplicated them, appended the goal, and rejected the result when a segment failed grid LOS. The new adapter instead walks every actual float segment through every crossed tile using parametric boundary crossings. Simultaneous axis crossings require both orthogonal tiles and the diagonal destination; all cells must be passable. It then greedily removes raw cells only when the production `hasLineOfSight` accepts the replacement segment. Exact requested start/goal tiles are mandatory. [New conversion](corridor-grid.ts), [production LOS](../../../src/sim/path/astar.ts), [old conversion and its documented limitations](../../full-game-movement/recast-integration/recast-engine.ts), [#167 report](../../full-game-movement/recast-integration/report.md).

This is a deterministic geometry adapter, **not a grid search**. It imports `hasLineOfSight`, never `findPath`, and has no A* or hybrid fallback. Response cost remains rounded geometric length ×1000 for telemetry, not native Detour cost or optimal integer-A* cost. The existing integer `PathResponse` protocol is preserved. [Protocol](../../../src/sim/path/protocol.ts).

### One-tile gate rasterization

Recast cell size changed from 0.5 to **0.25**, with `maxSimplificationError=0.25`; `walkableRadius=0` remains unchanged because production movement owns unit-body steering and collision. Focused one- and two-tile vertical gates now both return exact, grid-legal successful routes. This adjusts raster resolution, not game clearance rules. [Generation configuration](corridor-engine.ts), [gate tests](corridor.test.ts).

### Replay and application contract

Requests still use snapshot copies and revision staleness; responses still apply in ascending ID order at `dueTick = issueTick + 2`, with late responses blocking the same logical tick. Every applied inline path in both large runs had issue→apply = 2 ticks and both runs had zero blocked ticks. Narrow retained revision sequence `0→1→5→6`, initial stale cancellation, and tick-182 recovery. [Scheduler](../../../src/sim/path/scheduler.ts), [mutation/replay tests](corridor.test.ts).

## Verification

Strict TypeScript passed:

```sh
npx tsc -p scratch/phase2-navigation/recast-corridor/tsconfig.json
```

All new and relevant existing suites passed: **5 files, 33/33 tests**. The seven new tests cover one-/two-tile gates, exact Activity arrival through `World.step`, shallow-slope float conversion, exact/unreachable/impassable goals, corner legality, close/reopen and same-version snapshot isolation, production due-tick/stale/mutation recovery, and repeated plus delayed/out-of-order replay.

```sh
npx vitest run \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/harness/harness.test.ts \
  scratch/full-game-movement/harness/flow-integration/flow-integration.test.ts \
  scratch/full-game-movement/recast-integration/recast-integration.test.ts \
  scratch/phase2-navigation/recast-corridor/corridor.test.ts \
  --testTimeout=30000 --hookTimeout=30000
```

## Full-game 1,000-unit results

Environment: Apple M1, macOS arm64 14.6.1, Node 24.21.0. Both new runs used the unchanged recorded 120 × 120 scenarios and completed 3,600 ticks/frames. These are single Node runs, not statistically robust timing distributions. “No-path activities” is distinct from failed individual path responses; narrow has 1,000 initial stale-cancelled activity records in every candidate. [Validated derived comparison](results/corridor-comparison.json).

### Completion, correctness counters, and churn

| Scenario | Candidate | Wall s | Completed / active | No-path activities | Failed responses | Geometry rejects | Requests | Repaths |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Narrow + mutation | A* | 24.965 | 487 / 513 | 0 | 16 | — | 53,709 | 53,705 |
| Narrow + mutation | Old Recast | **22.006** | **558 / 442** | 0 | 547 | **531** | 17,913 | 17,909 |
| Narrow + mutation | New corridor | 31.062 | 500 / 500 | 0 | **16** | **0** | 53,098 | 53,094 |
| Dense | A* | **24.340** | 528 / 472 | 0 | 0 | — | 46,289 | 46,288 |
| Dense | Old Recast | 27.262 | **547 / 453** | 0 | 0 | 0 | 46,109 | 46,108 |
| Dense | New corridor | 27.848 | 528 / 472 | 0 | 0 | 0 | 46,289 | 46,288 |

Narrow's remaining 16 failed responses are pre-query impassable-endpoint rejections, also present in A*. New Recast recorded zero partial-path, endpoint-projection, native-query, navmesh-generation, path/cache/agent/obstacle-capacity, and TileCache-update failures in both large traces. The old Recast narrow row's high completion and low churn coincide with 531 conservative route rejections and must not be treated as semantic parity or a clean performance win. [A* narrow](../../full-game-movement/harness/results/narrow-mutation-120-p1000-sync.json), [old Recast narrow](../../full-game-movement/recast-integration/results/narrow-mutation-120-p1000-recast.json), [new narrow](results/narrow-mutation-120-p1000-corridor.json).

The new dense run matched preserved A* in completions, active count, requests, repaths, all final crowd rows, world digest, and full-state hash. This is an observed identical result on this scenario/host, not a general cross-architecture hash requirement or proof for other maps. [A* dense](../../full-game-movement/harness/results/dense-open-120-p1000-sync.json), [old Recast dense](../../full-game-movement/recast-integration/results/dense-open-120-p1000-recast.json), [new dense](results/dense-open-120-p1000-corridor.json).

### Tick, apply, response, and queue costs

Issue→response is inline Node timing, not browser-worker turnaround. Apply measures the production callback. Queue columns are mean / max / final.

| Scenario | Candidate | Mean / p95 / max tick ms | Apply p95 / max ms | Response p95 ms | Queue |
|---|---|---:|---:|---:|---:|
| Narrow | A* | 6.324 / **12.185** / 255.020 | **0.00550** / 2.607 | **0.124** | 29.837 / 915 / **10** |
| Narrow | Old Recast | **5.455** / 10.747 / **156.654** | 0.01058 / 4.340 | 0.165 | **9.951** / 919 / 4 |
| Narrow | New corridor | 7.911 / 15.565 / 181.559 | 0.00888 / 7.607 | 0.155 | 29.498 / 915 / 12 |
| Dense | A* | **6.134** / **9.460** / **210.795** | **0.00475** / **2.212** | 0.180 | 25.716 / 1,000 / 2 |
| Dense | Old Recast | 6.846 / 14.643 / 235.337 | 0.00545 / 3.556 | **0.096** | **25.616** / 1,000 / 3 |
| Dense | New corridor | 7.016 / 13.284 / 227.328 | 0.00683 / 3.819 | 0.123 | 25.716 / 1,000 / 2 |

### Recast builds, native queries, and conversion

| Scenario | Candidate | Initial / mutation rebuild ms | Native queries | Query total / max ms | Conversion total / max ms |
|---|---|---:|---:|---:|---:|
| Narrow | Old Recast | 137.676 / **80.022** | 17,894 | **663.468** / 53.501 | **40.821** / **0.999** |
| Narrow | New corridor | 157.788 / 116.011 | 53,051 | 1,244.090 / 7.387 | 328.171 / 9.452 |
| Dense | Old Recast | **115.225** / — | 46,058 | **678.687** / 13.374 | **46.133** / **1.671** |
| Dense | New corridor | 213.038 / — | 46,205 | 829.107 / 6.043 | 269.900 / 22.053 |

The finer raster and complete supercover/string-pull work increase measured CPU cost. Narrow's revision-6 full rebuild was 116.011 ms; dense's sole build was 213.038 ms. Single maxima include host/JIT/GC effects and are not stable tail estimates.

## Replay evidence

Two inline 100-unit, 600-tick narrow/mutation runs and one deterministic delayed/out-of-order mock produced identical logical state and the same full-state hash `c43dd03ccbb699c05faa336e85e00610e0be55d927a20136e3647efbe1804b17`. Each issued 1,049 requests and 1,045 repaths. Frames were 600 / 600 / 806 and blocked ticks 0 / 0 / 206; delivery timing changed, committed logical results did not. [Repeat A](results/narrow-mutation-120-p100-t600-corridor-a.json), [repeat B](results/narrow-mutation-120-p100-t600-corridor-b.json), [delayed mock](results/narrow-mutation-120-p100-t600-corridor-mock.json), [replay validation](results/corridor-comparison.json).

This is same-host Node/scripted-mock evidence only. It is not real worker, browser, cross-CPU, or independent-WASM determinism evidence.

## Commands and raw evidence

Run from the repository root. Commands write only inside this new directory and read preserved baselines without rewriting them.

```sh
npx tsx scratch/phase2-navigation/recast-corridor/run.ts --scenario narrow-mutation-120 --population 1000 --mode sync --output scratch/phase2-navigation/recast-corridor/results/narrow-mutation-120-p1000-corridor.json
npx tsx scratch/phase2-navigation/recast-corridor/run.ts --scenario dense-open-120 --population 1000 --mode sync --output scratch/phase2-navigation/recast-corridor/results/dense-open-120-p1000-corridor.json

npx tsx scratch/phase2-navigation/recast-corridor/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/phase2-navigation/recast-corridor/results/narrow-mutation-120-p100-t600-corridor-a.json
npx tsx scratch/phase2-navigation/recast-corridor/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/phase2-navigation/recast-corridor/results/narrow-mutation-120-p100-t600-corridor-b.json
npx tsx scratch/phase2-navigation/recast-corridor/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode mock --output scratch/phase2-navigation/recast-corridor/results/narrow-mutation-120-p100-t600-corridor-mock.json
python scratch/phase2-navigation/recast-corridor/compare.py
```

[Comparison/validation script](compare.py) checks identical scenarios, populations, map hashes, final ticks/frames, unit/crowd totals, request IDs, snapshot sizes, and two-tick application. It also validates repeat/mock logical equality and explicitly does not require cross-architecture hash equality.

## Production contract and remaining gaps

**No production contract change is required for this integer-supercover prototype.** If a future faithful float protocol is preferred, it needs an explicit versioned response representation for finite world-coordinate waypoints, structured-clone/worker encoding, exact final-slot handling in both group continuation and individual repath, deterministic live-segment validation, and replay tests. Those production changes were outside this ticket and were not simulated by hiding floats inside integer fields.

Remaining evidence gaps:

1. Supercover is conservative, not a completeness proof for every possible float corridor. Exact corner contacts with a blocked orthogonal cell still reject; zero measured narrow/dense geometry rejections do not clear all maps.
2. Mutations still use full TileCache/navmesh rebuilds from exact snapshots. Acknowledged incremental revisioned updates, obstacle bursts, destruction, >512 obstacles, and multi-tile capacity behavior remain unmeasured. `dynamicObstacleAdds=0`.
3. No real Recast browser worker, structured clone, Firefox/Safari, x64, or alternate WASM build was run.
4. One large run per candidate is insufficient for warmed timing distributions or small completion-delta claims. Repeat narrow, dense, opposing, mixed, and 2,000-unit runs before adoption.
5. The full-game candidate still creates zero DetourCrowd agents and uses production steering/collision; it is not isolated Crowd capacity evidence.

**Recommendation:** keep A* as production control; use this candidate as the semantically stronger Recast baseline for incremental-mutation and browser work. Adoption requires retaining zero semantic regressions while improving repeated full-game timing and completion evidence.

No production, existing harness/result, donor, package, issue, or commit files were changed.

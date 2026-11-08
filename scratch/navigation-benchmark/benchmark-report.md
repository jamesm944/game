# Wayfinder #162 — navigation path-request benchmark

## Scope and verdict

This benchmark compares the current project's integer grid/group A*, qiao/PathFinding.js 0.4.18, and Recast/Detour 0.43.0 through Voidstrike's `RecastNavigation` integration on one shared JSON fixture set. It measures synchronous path requests, native returned-path quality, exact-goal outcomes, repeated group orders, dynamic mutation updates, full Recast rebuilds, and repeated-run logical stability.

**Evidence for revisiting ADR-0003:** the existing A* remains competitive on these 64 × 64 fixtures and its group cache is a large measured advantage. PathFinding.js did not show a latency or path-quality advantage. Recast produced shorter smooth routes on the maze and choke-point traces, but Voidstrike's native smoothing made maze queries much slower, and its `found` flag reports partial paths as successful on unreachable targets. Recast therefore is not a drop-in semantic replacement without an exact-goal/partial-path contract and smoothing-cost work. No crowd winner can be inferred from these path-query results.

The phase-2 flow-field route is **not implemented** in the current project (`src/sim/path` contains A*, protocol, engine/cache, and worker code, but no flow-field implementation), so it is marked not measured rather than represented by a new benchmark-only algorithm.

## Verified measurements

All values below come from `results/run-02.json`; `results/summary.json` is generated from it. Latency is milliseconds. Each map row pools 50 samples per request across that map's requests (200 for four-request maps, 150 for unreachable, 100 for dynamic mutation). Percentiles are nearest-rank. Setup, worker transport, rendering, and movement are excluded.

### Aggregate path latency and exact-goal success

| Fixture | Engine | p50 ms | p95 ms | p99 ms | Exact successes / samples | Expected outcomes |
|---|---|---:|---:|---:|---:|---|
| Open | Project integer A* | 0.0526 | 0.1909 | 0.5625 | 200 / 200 | All matched |
| Open | PathFinding.js | 0.0652 | 0.2018 | 0.3290 | 200 / 200 | All matched |
| Open | Voidstrike Recast | 0.0141 | 0.0797 | 0.2783 | 200 / 200 | All matched |
| Maze | Project integer A* | 0.3186 | 0.6422 | 2.1868 | 200 / 200 | All matched |
| Maze | PathFinding.js | 0.3471 | 1.8785 | 3.8089 | 200 / 200 | All matched |
| Maze | Voidstrike Recast | 9.7140 | 23.9043 | 40.4596 | 200 / 200 | All matched |
| Dense choke points | Project integer A* | 0.3511 | 0.8118 | 2.8414 | 200 / 200 | All matched |
| Dense choke points | PathFinding.js | 0.4065 | 1.1817 | 3.1760 | 200 / 200 | All matched |
| Dense choke points | Voidstrike Recast | 2.1415 | 4.4284 | 5.8398 | 200 / 200 | All matched |
| Ramps/elevation | Project integer A* (2D) | 0.0313 | 0.0840 | 0.1579 | 200 / 200 | All matched, 2D only |
| Ramps/elevation | PathFinding.js (2D) | 0.0515 | 0.0688 | 0.1088 | 200 / 200 | All matched, 2D only |
| Ramps/elevation | Voidstrike Recast (3D mesh) | 0.0063 | 0.1434 | 0.2049 | 200 / 200 | All matched |
| Unreachable | Project integer A* | 0.6177 | 1.5314 | 4.0463 | 50 / 150 | 100 expected failures + 50 successes |
| Unreachable | PathFinding.js | 0.6599 | 0.8842 | 2.9902 | 50 / 150 | 100 expected failures + 50 successes |
| Unreachable | Voidstrike Recast | 0.2637 | 0.9187 | 3.8228 | 50 / 150 | Exact outcomes matched, reported successes did not |
| Dynamic gate | Project integer A* | 0.0247 | 0.0918 | 0.1384 | 100 / 100 | All matched |
| Dynamic gate | PathFinding.js | 0.0548 | 0.1543 | 0.7196 | 100 / 100 | All matched |
| Dynamic gate | Voidstrike Recast | 0.0276 | 0.2165 | 0.2889 | 100 / 100 | All matched |

“Exact success” means the engine reported success **and** its final waypoint was within 0.05 world units of the requested goal center. This separate check matters: on `unreachable/sealed-center`, Recast returned `found: true`, a two-waypoint 31.752953-unit partial path, and a 10.012492-unit endpoint error. Project A* and PathFinding.js returned no path. `unreachable/sealed-small` showed the same Recast partial-path behavior. Treating Voidstrike's `found` as exact reachability would therefore produce false success.

### Native returned-path quality

Length is two-dimensional Euclidean length of each engine's native returned polyline, not an optimal-path ratio. Waypoint counts and smoothing differ by design. The ramp's vertical distance is not included for any engine.

| Trace | Project A*: length / waypoints | PathFinding.js: length / waypoints | Recast: length / waypoints |
|---|---:|---:|---:|
| `open/diagonal` | 73.593478 / 2 | 74.710678 / 55 | 73.593478 / 2 |
| `maze/opposite` | 136.367086 / 27 | 140.769553 / 131 | 124.308032 / 16 |
| `dense-chokepoints/all-gates` | 103.653994 / 8 | 110.568542 / 95 | 102.734337 / 7 |
| `ramps-elevation/up-ramp` (2D length) | 53 / 2 | 53 / 54 | 53 / 2 |
| `unreachable/sealed-center` | no path / 0 | no path / 0 | partial 31.752953 / 2; exact failure |

Project A* uses integer octile A* plus greedy line-of-sight string-pulling. PathFinding.js is its native unsmoothed eight-direction result. Recast uses Voidstrike's Detour path plus sampling-based smoothing. These are native consumer-visible paths, not a controlled comparison of identical post-processing.

### Repeated group orders

A batch issues 32 identical orders for the map's first trace. Each project batch creates a fresh production `createPathEngine`, giving one cold query and **31 same-key LRU hits by construction**. PathFinding.js and Recast execute 32 native queries. There were 5 warmup batches and 20 measured batches. “Mean/order” is mean batch time divided by 32; batch p50 is not divided.

| Fixture | Engine | Batch p50 ms | Mean/order ms | Cache hits/batch |
|---|---|---:|---:|---:|
| Open | Project integer A* + LRU | 0.0891 | 0.0031 | 31 |
| Open | PathFinding.js | 2.4520 | 0.0808 | None |
| Open | Voidstrike Recast | 0.3818 | 0.0184 | None |
| Maze | Project integer A* + LRU | 0.2221 | 0.0175 | 31 |
| Maze | PathFinding.js | 4.3455 | 0.1586 | None |
| Maze | Voidstrike Recast | 332.2875 | 10.6443 | None |
| Dense choke points | Project integer A* + LRU | 0.6037 | 0.0250 | 31 |
| Dense choke points | PathFinding.js | 19.7237 | 0.6375 | None |
| Dense choke points | Voidstrike Recast | 86.7686 | 2.7354 | None |
| Unreachable (first trace is unreachable) | Project integer A* + LRU | 0.7222 | 0.0269 | 31 |
| Unreachable (first trace is unreachable) | PathFinding.js | 32.8572 | 1.1837 | None |
| Unreachable (first trace is unreachable) | Voidstrike Recast | 0.3107 | 0.0144 | None; partial paths |

All other repeated-group measurements are in `results/summary.json`.

### Dynamic building/terrain mutation

The `dynamic-mutation` fixture has one wall with an eight-tile gate. The mutation blocks a 6 × 12-cell rectangle covering the gate, making the first trace unreachable; removal restores the original map. Grid engines write the same 72 cells. Recast uses Voidstrike's native `addBoxObstacle` / `removeObstacle` (including its 0.1-unit expansion and up to eight tile-cache update calls). Query timing is outside mutation timing.

| Engine | Add/update p50 ms | Add p95 ms | Remove p50 ms | Remove p95 ms | Post-add exact failure | Post-remove baseline restored |
|---|---:|---:|---:|---:|---|---|
| Project integer A* grid | 0.000375 | 0.008334 | 0.000750 | 0.015209 | 20 / 20 | 20 / 20 |
| PathFinding.js grid | 0.000834 | 0.010250 | 0.003000 | 0.007292 | 20 / 20 | 20 / 20 |
| Voidstrike Recast TileCache | 0.093167 | 0.390666 | 0.091584 | 0.604333 | 20 / 20 | 20 / 20 |

A separate full Recast terrain rebuild on the mutated walkable-cell mesh took **22.604083, 28.405834, and 38.976041 ms** (one warmup, three measured iterations). This includes resetting the prior adapter and running `generateFromGeometry`, including tile-cache and crowd construction. Three samples are only a smoke-scale rebuild estimate, not a robust distribution. Grid mutation above already represents their terrain/building passability update; no additional grid rebuild is needed.

### Output stability

- Every engine's normalized output was identical across all 50 measured repetitions of every request.
- Every repeated-group batch had stable normalized outputs.
- Every post-mutation output was stable, and all removals restored the exact baseline output.
- Two independent Node processes produced the same complete logical-result SHA-256: `f8699c528fb2fea92a2514835b9b6a9e3e96c0b533be914554514dc23558b527`.
- `node src/summarize.mjs` independently asserts exact outcomes, within-run stability, mutation restoration, and cross-process digest equality; it passed.

This verifies same-host repeated-run output stability only. It is **not** evidence of cross-browser, cross-architecture, or multiplayer lockstep determinism.

## Fixtures and adaptation contract

`fixtures/fixtures.json` is the language-neutral source consumed unchanged by all adapters. `src/generate-fixtures.mjs` deterministically regenerates it. Coordinates are row-major integer tile indices; query points are tile centers `(x + 0.5, y + 0.5)` with tile size 1. Recast receives `(x, height, z=y)`. Walkability is an explicit flat 0/1 array. Heights are explicit per-vertex values in a `(width+1) × (height+1)` array.

| Fixture | Definition | Requests |
|---|---|---:|
| `open` | Open 64 × 64 floor, two-cell blocked perimeter | 4 |
| `maze` | Perfect maze on a 12 × 12 logical grid, five-tile cells, three-tile corridors; recursive backtracker with xorshift32 seed `0x162a57a1` | 4 |
| `dense-chokepoints` | Three full-height partitions with staggered five-tile gates and six rectangular obstacle blocks | 4 |
| `ramps-elevation` | Flat approaches; height increases 0.15/tile from x=12 to x=40; 4.2-high plateau | 4 |
| `unreachable` | Two sealed but internally walkable target islands plus one reachable control | 3 |
| `dynamic-mutation` | Full-height wall, eight-tile gate, and a 6 × 12 mutation sealing that gate | 2 |

Three-tile maze corridors avoid silently erasing one-tile passages under Voidstrike's configured static `walkableRadius = 0.8`. This is an adaptation choice, not proof that arbitrary project maps with narrower corridors will work. Recast geometry is generated from horizontal walkable-cell quads with the fixture's vertex heights; blocked cells have no geometry. Grid engines consume the passability bytes directly. Recast alone consumes elevation; Project A* and PathFinding.js run the equivalent 2D passability problem and cannot validate ramp slope or height semantics.

The Recast adapter imports Voidstrike's actual `RecastNavigation` implementation, configuration, WASM initialization, navmesh generation, `findPath`, smoothing, and box-obstacle methods. PathFinding.js uses `AStarFinder` with `DiagonalMovement.OnlyWhenNoObstacles`; its required `grid.clone()` is inside query timing. Project single-query timing imports `findPath` directly; repeated orders use the production path engine and cache. Worker messaging and scheduling are outside all measurements.

## Environment, iterations, and exact commands

Environment recorded in both raw runs and the summary:

- Apple M1, 8 logical CPUs, 16 GiB RAM; Darwin arm64, kernel 23.6.0.
- Node v24.21.0; V8 `15.0.245.31-electron.0`.
- Project commit `c462f54952490e61441612606b86410d85a4c6c6`.
- Voidstrike donor commit `4df0235116b78bf9232105486738e64b2e6905cb` (verified clean before and after).
- PathFinding.js 0.4.18; recast-navigation 0.43.0.
- 10 warmups and 50 measured iterations per path request.
- 5 warmup and 20 measured batches of 32 repeated group orders.
- 5 warmup and 20 measured mutation add/remove cycles.
- 1 warmup and 3 measured full Recast terrain rebuilds.

Run from `/Users/jamesmoss/Documents/game/scratch/navigation-benchmark`:

```bash
npm install --ignore-scripts --no-audit --no-fund
mkdir -p fixtures results
node src/generate-fixtures.mjs
../../node_modules/.bin/tsx --tsconfig ../donor-audit/browser/voidstrike/tsconfig.json src/run.ts results/run-01.json
../../node_modules/.bin/tsx --tsconfig ../donor-audit/browser/voidstrike/tsconfig.json src/run.ts results/run-02.json
node src/summarize.mjs
```

Artifact inventory:

- `fixtures/fixtures.json` — complete shared maps, heights, traces, and mutation rectangles.
- `src/generate-fixtures.mjs` — deterministic fixture definitions.
- `src/adapters.ts` — three native engine adapters and geometry conversion.
- `src/run.ts` — measurement, correctness, mutation, and stability harness.
- `src/summarize.mjs` — independent assertions and compact derived summary.
- `results/run-01.json`, `results/run-02.json` — complete raw per-request/group/mutation samples and logical outputs.
- `results/summary.json` — second-run aggregates plus cross-run verification.
- `package-lock.json` — pinned PathFinding.js dependency resolution.

## Limitations and unmeasured metrics

1. **Crowd completion time, stuck count, and crowd density are unmeasured.** No fair shared movement/collision simulation was run. DetourCrowd was constructed by Voidstrike setup but not used to claim movement performance. Path latency is not a substitute for crowd throughput or completion.
2. **Flow field is unmeasured because it is not implemented.** No benchmark-only substitute was introduced.
3. **Fixtures are deterministic synthetic recordings, not live gameplay captures.** They provide identical reproducible maps/traces but do not establish performance on the project's full 120 × 120 production maps or real command distributions.
4. **Headless synchronous scope.** These numbers exclude Web Worker transfer, FIFO/due-tick behavior, browser WASM differences, main-thread application cost, rendering, and end-to-end command latency.
5. **Native pipelines differ.** PathFinding.js returns unsmoothed grid paths; Project A* and Voidstrike Recast include their native smoothing. Recast maze latency includes many `findClosestPoint` checks in Voidstrike's smoothing, so this measures the integration rather than bare Detour `computePath` alone.
6. **Clearance and geometry semantics differ.** Recast uses Voidstrike's 0.8 static walkable radius, 0.5 default query agent radius, and 0.1 obstacle expansion; grid A* is point-tile passability with diagonal corner-cut prevention. Equivalent logical obstacles do not imply equivalent agent clearance.
7. **Elevation is Recast-only.** The ramp trace verifies Recast path success on actual sloped geometry, while the other engines prove only 2D connectivity. Reported lengths intentionally exclude vertical distance for comparability.
8. **Unreachable semantics require adaptation.** Voidstrike's `found` can mean a partial corridor. Consumers needing exact arrival must check endpoint error or use a stricter query contract.
9. **Timing sample limits.** Per-request p99 uses 50 samples; aggregate p99 pools 100–200. Mutation rows use 20 cycles and full rebuild only 3. GC and host scheduling can affect tails. Timings vary across the two runs; only logical outputs are expected to match exactly.
10. **Stability scope is narrow.** Same-machine determinism was verified; floating-point/WASM behavior across browsers and CPU architectures was not.

## Artifact isolation

All created files are under `scratch/navigation-benchmark/`. Production `src/` remained unchanged according to Git. The existing Voidstrike donor remained at the requested commit with a clean status. No production code or existing donor files were modified.

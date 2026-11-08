# Wayfinder #167 — flow-field versus current A* on full-game traces

## Scope and verdict

The existing `scratch/full-game-movement/flow-field/flow-field.ts` implementation is now attached to the unchanged full-game harness. The same recorded scenarios, populations, command ticks, mutations, scheduler, production movement loop, and cutoff used for current A* were run with the flow-field candidate. Existing A* raw results and `harness/report.md` were not rewritten.

**In this integration, current A* completed more units and ran faster on every measured 1,000-unit trace.** Flow field used 6.46–8.61× the measured wall time and completed 77–140 fewer units at the 3,600-tick cutoff. This is evidence about this raw-route, 32-entry-field-cache integration on this same-host Node run; it is not a universal ranking of pathfinding architectures or a browser phase-2 decision.

All large runs are `node-inline`, 120 × 120, 1,000 units, and 3,600 committed ticks (120 simulated seconds), on Node 24.21.0, Apple M1 arm64, 16 GiB RAM. Each large configuration has one measured run, not a timing distribution. Unfinished activity at the cutoff is not proof of permanent deadlock.

Flow dense 2,000 is **unmeasured**. The existing A* dense 2,000 result remains available, but no flow timing or scaling result is inferred from the 1,000-unit runs.

## Integration and semantic boundary

`flow-integration/flow-candidate.ts` implements `MovementCandidateAdapter` without introducing another movement stack:

- `FlowFieldRouteEngine` caches fields by `(goalTile, passabilityRevision)` through `FlowFieldCache`, with 32 entries. Each request still supplies its own start; the candidate traces that start through the shared goal field (`flow-candidate.ts:56-132`).
- Reverse Dijkstra builds the integration and direction arrays, including no-corner-cutting diagonal rules and deterministic descent (`flow-field/flow-field.ts:228-307`). The production cache canonicalizes goals, maintains LRU order, and clears fields on revision increase (`flow-field/flow-field.ts:321-386`).
- A response contains the raw descent route as tile-center waypoints. It goes through the existing `PathScheduler`; due-tick application, ascending response order, stale-revision rejection, and snapshot behavior remain production behavior (`src/sim/path/scheduler.ts:155-231`).
- Initial group orders still make one leader request and use the production group continuation for formation/member application (`src/sim/systems/movement.ts:599-686`). Individual stall repaths still request their exact formation-slot destinations (`src/sim/systems/movement.ts:877-956`).
- Arrival tolerance, Activity queues, steering, collision, sidestep/repath, stall counting, and propagated Parked behavior remain production code (`src/sim/systems/movement.ts:1477-1504,1606-1807`). Exact route endpoints and production arrival tolerance are tested separately; the latter is not an assertion of bit-identical final floating-point positions across architectures.
- An older delayed snapshot is built ephemerally and cannot reinsert an old field or move the cache revision backward (`flow-candidate.ts:72-105`). Inline and scripted delayed/out-of-order mock transports share the same field engine (`flow-candidate.ts:149-227`).

This is **not an algorithm-only exchange with identical route geometry**. Current A* returns its existing string-pulled route; the flow candidate returns raw tile-descent waypoints. It does not bypass steering or collision, but the changed geometry can change congestion, stalls, repaths, and completion. Those behavioral differences are part of the measured result.

Only routes cross the candidate transport. `fieldTransferBytes` is therefore exactly **0**; this is not a browser structured-clone measurement. `responseWaypointBytes` is the summed `Int16Array` waypoint payload, four bytes per route tile. Cached-field memory counts the integration and direction arrays only: 120 × 120 × 5 = 72,000 bytes per field, hence 2,304,000 bytes for 32 fields. It excludes snapshots, cache/adapter overhead, routes, and the rest of the world.

## Correctness and determinism checks

The integration tests cover identical short exact-goal A*/flow scenarios, sealed-map no-path behavior, exact route endpoints, cache hits and revision rebuilds, stale group cancellation, mutation recovery at tick 182, and flow-only repeat/delayed replay equality.

Strict TypeScript and all three relevant test files passed: **3 files, 20/20 tests**.

The 100-unit narrow/mutation, 600-tick flow candidate was run twice inline and once through the deterministic delayed/out-of-order mock:

- milestones, completions, final unit rows, crowd states, movement diagnostics, and logical path records were equal in all three runs;
- final full-state hash in all three: `1845a6adaf54bb6f23715875ae7ef1509d221a7e0daa312492c8e4807156f264`;
- each run recorded 913 path requests and 909 repaths;
- inline used 600 frames and 0 blocked ticks; mock used 659 frames and 59 blocked ticks while preserving 600 committed ticks.

This is same-host Node and scripted-mock evidence only. The three determinism processes were run concurrently, so their wall times are excluded from performance conclusions. A* and flow have different full-state hashes because their route geometry and subsequent crowd evolution differ; cross-architecture hash equality is not required.

## Measured 1,000-unit results

### Completion, timing, and churn

“Completed / active” counts command/activity outcomes. Narrow additionally has 1,000 initial stale-cancelled records for both candidates; those are not unique extra units. Completion p50/p95 includes completed records only. Wall time is one run; tick times are milliseconds per committed tick.

| Scenario | Candidate | Wall s | Completed / active | Completion tick p50 / p95 | Requests | Repaths | Mean / p95 tick ms |
|---|---|---:|---:|---:|---:|---:|---:|
| Dense | A* | 24.340 | 528 / 472 | 2,171 / 3,223 | 46,289 | 46,288 | 6.134 / 9.460 |
| Dense | Flow | 159.465 | **424 / 576** | 2,206 / 3,354 | 51,293 | 51,292 | 43.070 / 19.805 |
| Opposing | A* | 20.458 | 533 / 467 | 2,256 / 3,114 | 51,031 | 51,029 | 5.126 / 7.316 |
| Opposing | Flow | 176.138 | **443 / 557** | 2,413 / 3,344 | 55,552 | 55,550 | 47.644 / 18.541 |
| Mixed | A* | 19.257 | 571 / 429 | 2,023 / 2,931 | 46,807 | 46,799 | 4.783 / 7.486 |
| Mixed | Flow | 124.403 | **494 / 506** | 2,289 / 3,110 | 51,439 | 51,431 | 33.276 / 17.617 |
| Narrow+mutation | A* | 24.965 | 487 / 513 | 1,883 / 3,314 | 53,709 | 53,705 | 6.324 / 12.185 |
| Narrow+mutation | Flow | 178.587 | **347 / 653** | 2,098 / 3,168 | 54,195 | 54,191 | 48.632 / 121.286 |

The preserved A* dense 2,000 baseline is 51.968 s, 973 completed / 1,027 active, 90,903 repaths, and 13.167 / 18.838 mean/p95 tick ms. There is no paired flow value at that scale.

### Final crowd states

States are at tick 3,600. Columns are completed, moving, stalled (`stalledTicks > 0`), and propagated-Parked; all other state counts were zero in these eight runs.

| Scenario | A* C / M / S / P | Flow C / M / S / P |
|---|---:|---:|
| Dense | 528 / 26 / 435 / 11 | 424 / 23 / 529 / 24 |
| Opposing | 533 / 19 / 428 / 20 | 443 / 24 / 515 / 18 |
| Mixed | 571 / 15 / 398 / 16 | 494 / 23 / 467 / 16 |
| Narrow+mutation | 487 / 16 / 490 / 7 | 347 / 13 / 626 / 14 |

### Queueing and application cost

Issue→apply remained at p50/p95/max = 2/2/2 ticks for every applied inline path in both architectures. Inline blocked ticks were zero. Queue mean/max are sampled pending requests. Apply p95/max measure the production callback only, not search. Issue→response p95 is included to expose candidate compute/transport cost in Node; it is not real worker latency.

| Scenario | Candidate | Queue mean / max | Apply p95 / max ms | Issue→response p95 ms | Final queue |
|---|---|---:|---:|---:|---:|
| Dense | A* | 25.716 / 1,000 | 0.00475 / 2.212 | 0.180 | 2 |
| Dense | Flow | 28.496 / 1,000 | 0.00708 / 8.064 | 5.436 | 1 |
| Opposing | A* | 28.351 / 1,000 | 0.00271 / 1.481 | 0.214 | 4 |
| Opposing | Flow | 30.862 / 1,000 | 0.00592 / 5.215 | 5.652 | 1 |
| Mixed | A* | 26.003 / 1,000 | 0.00317 / 2.759 | 0.158 | 5 |
| Mixed | Flow | 28.577 / 1,000 | 0.00762 / 5.032 | 4.854 | 4 |
| Narrow+mutation | A* | 29.837 / 915 | 0.00550 / 2.607 | 0.124 | 10 |
| Narrow+mutation | Flow | 30.108 / 920 | 0.00704 / 1.376 | 5.439 | 3 |

Flow max tick times were 2,904.913 ms dense, 3,137.568 ms opposing, 2,588.904 ms mixed, and 2,574.011 ms narrow. These whole-tick maxima include host/JIT/GC outliers and explain why a mean can exceed p95; they are not isolated field-build timings.

### Field construction, cache, route, and memory metrics

Hit rate is hits / (hits + misses). Build and trace totals are candidate-measured milliseconds. Route bytes are decimal MB. Cached/peak bytes are field arrays only. All four runs reached the 32-field cache capacity.

| Scenario | Builds | Hits / misses | Hit rate | Build total / mean ms | Trace total ms | Route MB | Cached / peak fields | Cached / peak bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Dense | 40,358 | 10,935 / 40,358 | 21.32% | 134,938.170 / 3.344 | 292.071 | 5.953 | 32 / 32 | 2,304,000 / 2,304,000 |
| Opposing | 43,880 | 11,672 / 43,880 | 21.01% | 152,032.627 / 3.465 | 316.128 | 6.655 | 32 / 32 | 2,304,000 / 2,304,000 |
| Mixed | 32,879 | 18,560 / 32,879 | 36.08% | 101,551.760 / 3.089 | 242.366 | 6.668 | 32 / 32 | 2,304,000 / 2,304,000 |
| Narrow+mutation | 45,812 | 8,383 / 45,812 | 15.47% | 151,483.816 / 3.307 | 325.290 | 5.005 | 32 / 32 | 2,304,000 / 2,304,000 |

The initial leader destinations are shared, but subsequent production stall repaths target exact formation-slot destinations. Those distinct slot goals create distinct cache keys. The recorded low hit rates, full 32-entry caches, and 32,879–45,812 builds directly demonstrate churn in these traces; field-build totals account for most measured flow wall time. This does not establish that every possible field-sharing or cache policy would behave the same way.

Large inline runs recorded zero stale-snapshot builds. Narrow recorded one adapter-level cache invalidation: multiple map revisions had already accumulated before the next newer request advanced the cache, so this counter is not a count of individual mutation commands. It recorded 16 unreachable route traces; dense, opposing, and mixed recorded zero. Max single field builds were 166.127, 176.794, 277.599, and 202.499 ms respectively; max route traces were 3.400, 3.867, 4.365, and 4.980 ms.

### Mutation recovery

Both candidates preserved the recorded revision sequence:

1. tick 2 gate close: `0→1`, four changed tiles;
2. tick 2 four production house placements: `1→5`, sixteen changed tiles;
3. tick 120 gate reopen: `5→6`, four changed tiles.

Both initial group responses were stale-discarded, producing 1,000 initial stale-cancelled activity records at population 1,000. After the tick-180 reissue, the first revision-qualified applications occurred at tick 182 for both candidates. This verifies recovery through the existing scheduler/group contract, not completion of every affected activity.

## Reproduction

Run from the repository root. The A* commands and baseline evidence remain in `harness/report.md`; the following commands reproduce the new candidate evidence and derived comparisons without overwriting A* files.

```sh
npx tsc -p scratch/full-game-movement/harness/tsconfig.json
npx vitest run \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/harness/harness.test.ts \
  scratch/full-game-movement/harness/flow-integration/flow-integration.test.ts

npx tsx scratch/full-game-movement/harness/run.ts --scenario dense-open-120 --population 1000 --mode flow --output scratch/full-game-movement/harness/results/dense-open-120-p1000-flow.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario opposing-open-120 --population 1000 --mode flow --output scratch/full-game-movement/harness/results/opposing-open-120-p1000-flow.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario mixed-destinations-120 --population 1000 --mode flow --output scratch/full-game-movement/harness/results/mixed-destinations-120-p1000-flow.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 1000 --mode flow --output scratch/full-game-movement/harness/results/narrow-mutation-120-p1000-flow.json

npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode flow --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-flow-a.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode flow --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-flow-b.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode flow-mock --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-flow-mock.json
python scratch/full-game-movement/harness/flow-integration/compare.py
```

`compare.py` pairs each flow result with the existing same-scenario/population A* JSON, validates scenario/tick/evidence metadata, and separately checks flow repeat/mock logical and hash equality. It never requires A* and flow hashes to match and never rewrites a raw run.

## Raw evidence

Derived evidence: [paired comparison](results/flow-field-comparison.json), [flow determinism](results/flow-field-determinism.json).

Flow raw runs: [dense 1,000](results/dense-open-120-p1000-flow.json), [opposing 1,000](results/opposing-open-120-p1000-flow.json), [mixed 1,000](results/mixed-destinations-120-p1000-flow.json), [narrow 1,000](results/narrow-mutation-120-p1000-flow.json), [repeat A](results/narrow-mutation-120-p100-t600-flow-a.json), [repeat B](results/narrow-mutation-120-p100-t600-flow-b.json), [delayed mock](results/narrow-mutation-120-p100-t600-flow-mock.json).

Preserved A* raw runs: [dense 1,000](results/dense-open-120-p1000-sync.json), [dense 2,000](results/dense-open-120-p2000-sync.json), [opposing 1,000](results/opposing-open-120-p1000-sync.json), [mixed 1,000](results/mixed-destinations-120-p1000-sync.json), [narrow 1,000](results/narrow-mutation-120-p1000-sync.json).

## Limitations and next evidence

1. Flow dense 2,000 was not run; no timing, completion, or scaling claim is made at that population. The other scenarios also lack 2,000-unit flow runs.
2. There is one large run per configuration. Whole-tick maxima and wall time include host/JIT/GC effects; multiple warmed runs are needed for stable distributions.
3. No real browser worker was created. Inline and mock Node runs do not measure browser scheduling, structured clone, or cross-engine behavior.
4. Fields are not transferred; only route waypoint payload is counted. Cached-field memory excludes snapshots and other runtime allocations.
5. Raw descent routes change geometry relative to current A* string pulling. These results therefore combine path computation and downstream crowd behavior; they do not isolate field construction as the sole cause of every completion difference.
6. Determinism is established only for each flow run's own same-host Node repeat and scripted delayed/out-of-order mock. Cross-architecture state hashes are expected to differ.
7. Cutoff-active, stalled, and propagated-Parked states are observed at tick 3,600, not proof of permanent deadlock.
8. The next useful optimization experiment is to reduce slot-destination field churn—while preserving exact group-slot and revision semantics—and then rerun these same traces before considering any broader architectural conclusion.

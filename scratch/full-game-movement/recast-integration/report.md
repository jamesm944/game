# Wayfinder #167 — Recast/Detour full-game candidate

## Scope and verdict

This directory adds an actual **Recast/Detour 0.43.0 corridor-query candidate** below the existing full-game `PathTransport` contract. It uses the unchanged world step, Activity queues, one-leader group route continuation, formation slots, movement, steering, collision, stall/repath FSM, placement mutations, scheduler, instrumentation, and replay digests. It does **not** call isolated `updateCrowd` or substitute a point-to-point benchmark. The unchanged harness executes those systems at `scratch/full-game-movement/harness/runner.ts:161-198,242-283`; the candidate CLI only constructs the adapter and calls `runBenchmark` (`recast-integration/run.ts:23-35`).

All four recorded 120 × 120, 1,000-unit traces reached **3,600 committed ticks**. Relative to preserved current-A* runs, this candidate completed **19 more** dense units, **5 more** opposing units, **11 more** mixed-destination units, and **71 more** narrow/mutation command records at the cutoff. Wall time was **12.0%, 22.2%, and 28.6% slower** on dense/opposing/mixed, but **11.9% faster** on narrow/mutation, where Repaths fell by 35,796 and 531 routes were conservatively rejected during grid conversion.

This is a **mixed single-run Node result, not an architecture-winner declaration**. Route geometry differs from A* string pulling, timing has one sample per large configuration, 2,000-unit Recast runs were not performed, and no real browser worker was run.

Environment: Apple M1, macOS arm64 14.6.1, Node 24.21.0. Large runs were sequential. Dependency provenance is the pinned Voidstrike clone at commit `4df0235116b78bf9232105486738e64b2e6905cb`; its installed `recast-navigation`, `@recast-navigation/core`, and `@recast-navigation/generators` packages are 0.43.0 (`scratch/donor-audit/browser/voidstrike/node_modules/recast-navigation/package.json:20-22`; `.../@recast-navigation/core/package.json:9-11`; `.../@recast-navigation/generators/package.json:9-11`). The package records MIT as its license; this is provenance only. No packages were installed.

## Integration contract preserved

- `createRecastCandidate` implements the existing `MovementCandidateAdapter` and returns ordinary `PathResponse` objects through the supplied transport (`recast-integration/recast-candidate.ts:14-43`; contract at `harness/types.ts:53-70`). Inline and scripted-mock adapters share `RecastRouteEngine`.
- Group commands still select one leader and issue one request; the production continuation creates formation/member destinations and final slots (`src/sim/systems/movement.ts:502-522,569-686`). The candidate has no group or formation implementation of its own.
- Scheduler-owned snapshot copies, ascending-ID response application, two-tick `dueTick`, blocked ticks, and stale-revision discards are unchanged (`src/sim/path/scheduler.ts:155-231`). Individual stale repaths still release their holds and retry (`src/sim/systems/movement.ts:877-956`). Group stale cancellation is deliberately not repaired.
- Arrival tolerance, final Activity removal, live-segment validation, steering, collision, sidestep/repath, and Parked behavior remain production code (`src/sim/systems/movement.ts:1420-1523,1606-1807`). `crowdAgentsCreated` is zero: no DetourCrowd agents exist in this candidate.
- Existing scheduler decoration still records request, response, compute, application, queue, and stale outcomes (`harness/instrumentation.ts:71-159`). Candidate metrics add rebuild/query/route/capacity telemetry without changing the result schema.

## Actual Recast/Detour work and mutation strategy

`RecastRouteEngine` creates two triangles for every passable tile and calls `generateTileCache` (`recast-integration/recast-engine.ts:146-172,246-275`). A query performs `findClosestPoint`, `findPath`, and `findStraightPath`; this is the native Detour corridor/string-pulling API, whose ownership and capacity contracts are declared at `@recast-navigation/core/dist/nav-mesh-query.d.ts:337-440`. WASM arrays are destroyed after use (`recast-engine.ts:306-356`).

The transport supplies snapshots, not mutation events. The candidate therefore uses an **honest full TileCache/navmesh rebuild from each newly observed revision's exact bytes**, with an eight-entry revision LRU (`recast-engine.ts:12,214-243`). It does not fabricate obstacle add/remove acknowledgements. Several world revisions can collapse into the next requested snapshot: the recorded narrow run built revision 0 and revision 6 only. Rebuild time is charged synchronously to the request that first needs the snapshot, not to the earlier placement command.

A cache hit also compares every passability byte. If a caller reuses a revision with different bytes, the candidate builds and destroys an ephemeral exact mesh rather than querying stale geometry (`recast-engine.ts:214-228`; tested at `recast-integration.test.ts:152-177`). LRU eviction is not counted as a failure. `revisionCacheCapacityFailures`, `navmeshGenerationFailures`, `pathCapacityFailures`, `tileCacheUpdateFailures`, `obstacleCapacityFailures`, and `agentCapacityFailures` were all zero in the four large runs; no cache evictions occurred.

Generation uses donor-style `cs=0.5`, `ch=0.2`, tile size 32, four expected layers, and 512 configured obstacles, but **`walkableRadius=0`** (`recast-engine.ts:17-28`). This deliberately differs from Voidstrike's 0.8 radius (`src/data/pathfinding.config.ts:61-83,189-200` in the donor) because current game A* does not erode passability by agent radius and production steering/collision owns unit bodies. The maps are flat; no elevation semantics are added.

### Exact-goal and geometry policy

1. Off-grid or impassable request endpoints return `ok:false` before projection (`recast-engine.ts:183-200`).
2. Start/goal projection and final straight-path endpoints must be within 0.05 world units of requested tile centers (`recast-engine.ts:13,289-300,333-341`).
3. `DT_PARTIAL_RESULT` is explicitly rejected (`recast-engine.ts:306-322`). Detour success alone is not treated as exact reachability.
4. The existing protocol stores integer tile coordinates, so float straight-path points are floored/deduplicated into tile centers. Every resulting segment must pass the production `hasLineOfSight`, including no-corner-cutting; otherwise the response is `ok:false` (`recast-engine.ts:362-405`; grid rule at `src/sim/path/astar.ts:168-217`). There is no A* fallback.
5. Response `cost` is rounded geometric tile-center length ×1000 for telemetry. It is **not** an optimal integer-A* cost or native Detour cost (`recast-engine.ts:399-410`). Production movement consumes `ok` and waypoints, not this cost (`src/sim/systems/movement.ts:615-627,924-947`).

### Semantic mismatches and observed limits

- **Tile-center quantization is lossy.** Recast's float corridor and current A*'s string-pulled grid route are not identical geometry. This can change downstream congestion and replay hashes; cross-architecture hash equality is neither expected nor required.
- **Conservative conversion can reject a valid continuous Detour route.** Narrow/mutation recorded 531 geometry rejections. These are no-path responses, not silently repaired paths.
- **One-tile gates are not preserved by this Recast rasterization.** A focused 12 × 12 probe with `cs=0.5`, radius zero, and a one-cell doorway returned no path; the corresponding two-cell doorway succeeded (`recast-integration.test.ts:113-149`). The recorded narrow scenario's four-tile gate did connect. This is a real semantic difference from grid A*, not a claim that all Recast configurations must behave this way.
- **Full rebuild is not incremental TileCache obstacle mutation.** `dynamicObstacleAdds=0`, so the configured 512-obstacle limit and TileCache update queues were not stressed. No obstacle-513 claim is made.
- **No Crowd capacity is consumed.** The previously audited isolated Recast crowd capacity is 2,000 agents and obstacle capacity is 512 (`scratch/donor-audit/recast-navigation-report.md:92-107`; donor `pathfinding.config.ts:164-200`). Those limits are recorded in candidate metrics, but this full-game candidate creates zero agents and adds zero obstacles. Dense 2,000 was not run.
- **Node module loading is deliberate.** `recast-runtime.ts:1-13` uses Node 24 `createRequire` against the pinned installed ESM/WASM modules. It is not browser packaging or a real worker implementation.

## Correctness and determinism verification

Strict TypeScript passed:

```sh
npx tsc -p scratch/full-game-movement/recast-integration/tsconfig.json
```

All new and relevant existing tests passed: **4 files, 26/26 tests**.

```sh
npx vitest run \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/harness/harness.test.ts \
  scratch/full-game-movement/harness/flow-integration/flow-integration.test.ts \
  scratch/full-game-movement/recast-integration/recast-integration.test.ts \
  --testTimeout=30000 --hookTimeout=30000
```

The six Recast tests cover short exact-goal completion against the same A* scenario, sealed/unreachable behavior and partial rejection, corner and one-/two-tile geometry, exact gate rebuild/restoration, same-revision snapshot mismatch isolation, production stale group cancellation and tick-182 recovery, and repeated plus delayed/out-of-order determinism (`recast-integration.test.ts:61-215`).

### Replay scope

The recorded 100-unit narrow/mutation, 600-tick candidate was run twice inline and once with deterministic delayed/out-of-order frame delivery:

- repeated inline committed logical results: **equal**;
- inline versus mock milestones, completions, final unit rows, crowd states, diagnostics, and committed path records: **equal**;
- final full-state hash in all three: `c0d14d3e92015e07a29b8571a6689361d02a4ad05d3064c11c766488394074a8`;
- each run: 837 requests and 833 repaths;
- inline: 600 frames, 0 blocked ticks; mock: 820 frames, 220 blocked ticks, 600 committed ticks.

At the cutoff, inline delivery had received two responses that were still in flight in the mock. Their `ok` metadata is excluded only while `outcome=pending`; no applied path or world-state evidence is excluded (`recast-integration/compare.py:111-124`). This is same-host Node/scripted-mock determinism only. It says nothing about Chrome/Firefox/Safari, x64, independent WASM builds, or real asynchronous worker scheduling.

## Full-game paired results

“Completed / active” counts command/activity outcomes. Narrow additionally has 1,000 initial stale-cancelled records for each candidate. Completion percentiles include completed records only. Unfinished activity is a cutoff observation, not proof of permanent deadlock. Full precision is in `results/recast-comparison.json` and the raw runs.

### Completion, timing, and churn

| Scenario | Candidate | Wall s | Completed / active | Completion tick p50 / p95 | Requests | Repaths | Mean / p95 tick ms |
|---|---|---:|---:|---:|---:|---:|---:|
| Dense | A* | 24.340 | 528 / 472 | 2,171 / 3,223 | 46,289 | 46,288 | 6.134 / 9.460 |
| Dense | Recast | 27.262 | **547 / 453** | 2,151 / 3,188 | 46,109 | 46,108 | 6.846 / 14.643 |
| Opposing | A* | 20.458 | 533 / 467 | 2,256 / 3,114 | 51,031 | 51,029 | 5.126 / 7.316 |
| Opposing | Recast | 24.994 | **538 / 462** | 2,301 / 3,085 | 51,071 | 51,069 | 6.241 / 12.838 |
| Mixed | A* | 19.257 | 571 / 429 | 2,023 / 2,931 | 46,807 | 46,799 | 4.783 / 7.486 |
| Mixed | Recast | 24.764 | **582 / 418** | 2,028 / 2,859 | 46,673 | 46,665 | 6.091 / 10.961 |
| Narrow+mutation | A* | 24.965 | 487 / 513 | 1,883 / 3,314 | 53,709 | 53,705 | 6.324 / 12.185 |
| Narrow+mutation | Recast | 22.006 | **558 / 442** | 229 / 2,548 | 17,913 | 17,909 | 5.455 / 10.747 |

Every applied inline path in both architectures had issue→apply p50/p95/max = **2/2/2 ticks**. Inline blocked ticks were zero. Whole-tick times include path computation, production simulation, instrumentation, JIT/GC, and host outliers; they are not isolated native query times.

### Final crowd states at tick 3,600

Columns are completed, moving, stalled (`stalledTicks>0`), and propagated-Parked. Parked-without-activity, awaiting-group, and other-activity counts were zero in all eight runs.

| Scenario | A* C / M / S / P | Recast C / M / S / P |
|---|---:|---:|
| Dense | 528 / 26 / 435 / 11 | 547 / 17 / 416 / 20 |
| Opposing | 533 / 19 / 428 / 20 | 538 / 23 / 420 / 19 |
| Mixed | 571 / 15 / 398 / 16 | 582 / 16 / 393 / 9 |
| Narrow+mutation | 487 / 16 / 490 / 7 | 558 / 16 / 409 / 17 |

### Queue and production route-application cost

Apply timings measure the production callback, not native search. Issue→response is non-browser inline timing and excludes real worker scheduling/structured clone.

| Scenario | Candidate | Queue mean / max | Apply p95 / max ms | Issue→response p95 ms | Final queue |
|---|---|---:|---:|---:|---:|
| Dense | A* | 25.716 / 1,000 | 0.00475 / 2.212 | 0.180 | 2 |
| Dense | Recast | 25.616 / 1,000 | 0.00546 / 3.556 | 0.096 | 3 |
| Opposing | A* | 28.351 / 1,000 | 0.00271 / 1.481 | 0.214 | 4 |
| Opposing | Recast | 28.373 / 1,000 | 0.00358 / 12.642 | 0.094 | 5 |
| Mixed | A* | 26.003 / 1,000 | 0.00317 / 2.759 | 0.158 | 5 |
| Mixed | Recast | 25.929 / 1,000 | 0.00571 / 10.663 | 0.115 | 6 |
| Narrow+mutation | A* | 29.837 / 915 | 0.00550 / 2.607 | 0.124 | 10 |
| Narrow+mutation | Recast | 9.951 / 919 | 0.01058 / 4.340 | 0.165 | 4 |

### Recast rebuild, native query, and route conversion costs

Query mean is total native query time / native query count; same-tile requests do not call Detour. Route conversion includes quantization and grid validation, not production application.

| Scenario | Initial / mutation rebuild ms | Native queries | Query total / mean / max ms | Route total / max ms | Geometry rejects |
|---|---:|---:|---:|---:|---:|
| Dense | 115.225 / — | 46,058 | 678.687 / 0.0147 / 13.374 | 46.133 / 1.671 | 0 |
| Opposing | 128.879 / — | 50,999 | 728.237 / 0.0143 / 90.874 | 54.785 / 2.701 | 0 |
| Mixed | 110.380 / — | 46,622 | 695.255 / 0.0149 / 5.606 | 57.524 / 2.921 | 0 |
| Narrow+mutation | 137.676 / 80.022 | 17,894 | 663.468 / 0.0371 / 53.501 | 40.821 / 0.999 | 531 |

Narrow returned 547 `ok:false` routes: 531 grid-geometry rejections and 16 pre-query impassable-endpoint rejections. Partial-path, endpoint-projection, native-query, generation, path-capacity, cache-capacity, agent-capacity, and obstacle-capacity failure counters were zero. The large max query values are single-run maxima, not distributions.

### Mutation recovery

The production trace retained revisions `0→1` gate close at tick 2 (four tiles), `1→5` four house placements at tick 2 (16 tiles), and `5→6` gate reopen at tick 120 (four tiles). Both initial group responses were stale-discarded; 1,000 initial activity records were `stale-cancelled`. After the recorded tick-180 reissue, every mutation's first revision-qualified path application was tick **182**. The candidate observed 16 net changed bytes between its initial and revision-6 snapshot; the closed/reopened gate nets to zero. Its revision-6 full rebuild cost **80.022 ms**. This verifies recovery through the scheduler/group contract, not incremental mutation latency or completion of every affected activity.

## Reproduction and raw evidence

Run from the repository root. These commands write only inside `scratch/full-game-movement/recast-integration/`; existing A* raw results are read, never rewritten.

```sh
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario dense-open-120 --population 1000 --mode sync --output scratch/full-game-movement/recast-integration/results/dense-open-120-p1000-recast.json
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario opposing-open-120 --population 1000 --mode sync --output scratch/full-game-movement/recast-integration/results/opposing-open-120-p1000-recast.json
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario mixed-destinations-120 --population 1000 --mode sync --output scratch/full-game-movement/recast-integration/results/mixed-destinations-120-p1000-recast.json
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario narrow-mutation-120 --population 1000 --mode sync --output scratch/full-game-movement/recast-integration/results/narrow-mutation-120-p1000-recast.json

npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/full-game-movement/recast-integration/results/narrow-mutation-120-p100-t600-recast-a.json
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/full-game-movement/recast-integration/results/narrow-mutation-120-p100-t600-recast-b.json
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode mock --output scratch/full-game-movement/recast-integration/results/narrow-mutation-120-p100-t600-recast-mock.json
python scratch/full-game-movement/recast-integration/compare.py
```

Derived evidence: [paired comparison](results/recast-comparison.json), [determinism](results/recast-determinism.json).

Raw large runs: [dense 1,000](results/dense-open-120-p1000-recast.json), [opposing 1,000](results/opposing-open-120-p1000-recast.json), [mixed 1,000](results/mixed-destinations-120-p1000-recast.json), [narrow/mutation 1,000](results/narrow-mutation-120-p1000-recast.json).

Raw replay runs: [repeat A](results/narrow-mutation-120-p100-t600-recast-a.json), [repeat B](results/narrow-mutation-120-p100-t600-recast-b.json), [delayed mock](results/narrow-mutation-120-p100-t600-recast-mock.json).

`compare.py` validates identical scenario objects, populations, map hashes, 3,600-tick cutoffs, and evidence classes before pairing. It compares Recast only with the preserved matching A* result and explicitly does not require their full-state hashes to match (`compare.py:65-99`).

## Unresolved work

1. Run Recast dense and other traces at 2,000 before making any capacity or scaling claim; current 2,000 A* data has no Recast pair.
2. Replace full snapshot rebuilds with acknowledged, revisioned local TileCache obstacle/tile updates, then measure >512 obstacles and bursty/multi-tile failure behavior.
3. Reduce conservative quantization rejections without using A* as a hidden planner; a float waypoint protocol or a formally validated corridor-to-grid conversion needs separate contract work.
4. Decide whether one-tile doorways must be supported and tune/rasterize accordingly without silently changing game clearance rules.
5. Repeat large timings with warmup and multiple samples. Single max values, especially native query and application maxima, are not stable tails.
6. Implement a real browser worker transport and run Chrome/Firefox/Safari on arm64 and x64. No browser, structured-clone, cross-CPU, or cross-WASM determinism claim is made here.
7. Add building destruction and more revision orderings. The current trace exercises production placement plus harness terrain mutation, not production building destruction or terrain-editing commands.

No production, existing harness, package, issue, donor, or commit files were changed.

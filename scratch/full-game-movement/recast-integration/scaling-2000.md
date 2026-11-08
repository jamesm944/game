# Wayfinder #167 — dense 2,000-unit scaling evidence

## Outcome and decision

Recast dense 2,000 completed the identical 120 × 120, 3,600-tick full-game trace. It recorded **995 completed / 1,005 active** in **44.213 s**, versus preserved current-A* **973 / 1,027** in **51.968 s**. Recast therefore completed 22 more units and was 14.9% faster in this single Node run, with 1,126 fewer requests and repaths.

Flow dense 2,000 was invoked with the same scenario, population, and requested cutoff, but the execution was killed at the **300 s deadline** before `runBenchmark` returned and before its raw JSON could be written. Its final tick, completions, timings, queue/apply costs, candidate metrics, and hash are **unmeasured**. No partial values or 1,000→2,000 extrapolation are reported.

**This does not change the current default: retain current integer A* for now.** Recast's dense 2,000 result strengthens the prototype evidence, but one dense single run does not resolve its route-quantization semantics, narrow-terrain geometry rejections, full-rebuild mutation strategy, missing browser-worker evidence, or lack of repeated large-run timing distributions. Flow has no completed 2,000 result with which to revise its prior comparison.

Environment remains Apple M1, macOS arm64 14.6.1, Node 24.21.0. Runs were sequential and used the unchanged production Activity/movement/steering/collision/scheduler harness. No browser or cross-platform claim is made.

## Exact commands and artifacts

Run from the repository root.

### Recast 2,000 — completed

```sh
npx tsx scratch/full-game-movement/recast-integration/run.ts --scenario dense-open-120 --population 2000 --mode sync --output scratch/full-game-movement/recast-integration/results/dense-open-120-p2000-recast.json
```

Raw result: [dense-open-120-p2000-recast.json](results/dense-open-120-p2000-recast.json).

### Flow 2,000 — timed out before result write

```sh
/usr/bin/time -p npx tsx scratch/full-game-movement/harness/run.ts --scenario dense-open-120 --population 2000 --mode flow --output scratch/full-game-movement/harness/results/dense-open-120-p2000-flow.json
```

The outer execution limit was 300 s. The command was killed by that deadline; no matching process remained afterward. The runner writes output only after the full benchmark returns, so `scratch/full-game-movement/harness/results/dense-open-120-p2000-flow.json` does **not** exist. The attempted run was observed at `2026-10-25T19:41:01Z`.

Failure evidence, not a fake `BenchmarkResult`: [dense-open-120-p2000-flow-timeout.json](results/dense-open-120-p2000-flow-timeout.json).

### Validation and comparison

```sh
python scratch/full-game-movement/recast-integration/compare-scaling-2000.py
```

The script completed successfully and wrote [scaling-2000-comparison.json](results/scaling-2000-comparison.json). It reads but never rewrites raw benchmark results. It validates:

- exact scenario object, 120 × 120 size, candidate ID, `node-inline` evidence class, population, and 3,600 requested/final ticks for every completed run;
- 3,600 frames, completion and final-unit totals equal to population, unique unit IDs, outcome totals, and final crowd-state totals;
- one production group application, zero blocked ticks, queue bounds, finite/nonnegative tick/apply metrics, 14,400-byte snapshots, unique request IDs, and two-tick application for every applied path;
- matching initial/final map hashes against the preserved A* baseline and correctly formatted world/full-state hashes;
- Recast candidate build/query/failure metrics and zero Crowd-agent/dynamic-obstacle use;
- the flow failure record and absence of a flow 2,000 raw result.

Different architectures' full-state hashes are retained for replay identity but are **not** required or expected to match.

## Dense 2,000 paired results

“Completed / active” counts the 2,000 command/activity records. Completion percentiles include completed records only. Cutoff-active and stalled states are observations at tick 3,600, not proof of permanent deadlock. Flow has no measured row values because no completed raw result exists.

| Candidate | Wall s | Completed / active | Completion tick p50 / p95 | Requests | Repaths | Mean / p95 tick ms |
|---|---:|---:|---:|---:|---:|---:|
| Current A* | 51.968 | 973 / 1,027 | 2,148 / 3,190 | 90,904 | 90,903 | 13.167 / 18.838 |
| Flow field | **Unmeasured: killed at 300 s** | — | — | — | — | — |
| Recast/Detour | 44.213 | **995 / 1,005** | 2,136 / 3,314 | 89,778 | 89,777 | 11.007 / 16.405 |

Final crowd states (completed / moving / stalled / propagated-Parked) were:

- A*: **973 / 51 / 925 / 51**.
- Recast: **995 / 43 / 925 / 37**.
- Parked-without-activity, awaiting-group, and other-activity counts were zero in both completed runs.

### Queue, application, response, and max-tick costs

Issue→response is inline Node timing, not browser-worker turnaround. Apply cost is the production callback only. A single maximum is not a stable tail estimate.

| Candidate | Queue mean / max / final | Apply p95 / max ms | Issue→response p95 ms | Max tick ms |
|---|---:|---:|---:|---:|
| Current A* | 50.501 / 2,000 / 13 | 0.00354 / 3.059 | 0.169 | 379.303 |
| Flow field | — | — | — | — |
| Recast/Detour | 49.876 / 2,000 / 5 | 0.00354 / 6.193 | 0.0795 | 331.274 |

Every applied inline path in both completed runs had issue→apply p50/p95/max = **2/2/2 ticks**. A* had 90,891 applied and 13 pending requests at cutoff; Recast had 89,773 applied and 5 pending.

### Recast native/candidate metrics

Recast built one revision mesh for 115.989 ms. It executed 89,643 native queries for 1,036.531 ms total, approximately 0.0116 ms mean and 7.538 ms max. Route conversion took 97.975 ms total and 6.141 ms max. Its final queue contained five requests.

The dense run recorded zero unreachable routes, partial-path rejections, endpoint-projection rejections, geometry rejections, native query failures, navmesh generation failures, path/cache capacity failures, snapshot mismatches, TileCache update failures, obstacle capacity failures, and agent capacity failures. `crowdAgentsCreated=0` and `dynamicObstacleAdds=0`.

Replay identities were:

- A*: world digest `fnv1a64:41f35df02dbc381c`; full-state hash `7d52151e8e80a62979850a0c9de865b36be07694be4b3203a2806d06ea47c915`.
- Recast: world digest `fnv1a64:2f2764545d8b32cf`; full-state hash `f63008e628df6daf6ad20e8cdbe196f9be9c927c60fc9d57ca37cebeef052ed1`.
- Both retained initial/final map hash `fnv1a64:7e485b06ec4fd0a5`.

## Observed 1,000→2,000 scaling

These ratios compare the actual preserved 1,000 runs with the actual 2,000 runs on this host. They are observed pairs, not fitted scaling laws or statistically robust timing distributions. Flow is excluded because its 2,000 run did not complete.

| Candidate | Wall s 1,000→2,000 (ratio) | Mean tick ms (ratio) | p95 tick ms (ratio) | Completed (ratio) | Requests (ratio) | Repaths (ratio) |
|---|---:|---:|---:|---:|---:|---:|
| Current A* | 24.340→51.968 (**2.135×**) | 6.134→13.167 (2.146×) | 9.460→18.838 (1.991×) | 528→973 (1.843×) | 46,289→90,904 (1.964×) | 46,288→90,903 (1.964×) |
| Recast/Detour | 27.262→44.213 (**1.622×**) | 6.846→11.007 (1.608×) | 14.643→16.405 (1.120×) | 547→995 (1.819×) | 46,109→89,778 (1.947×) | 46,108→89,777 (1.947×) |

For context only, preserved flow 1,000 took 159.465 s, built 40,358 fields, and spent 134,938.170 ms in field construction with a full 32-field cache. These observations explain why its 2,000 runtime was a risk; they do **not** provide a 2,000 estimate.

## Capacity, geometry, and mutation caveats

1. **Recast Crowd capacity was not exercised.** The prior isolated crowd limit is 2,000, but this full-game candidate creates zero DetourCrowd agents and keeps production steering/collision. The completed 2,000-unit run therefore must not be reported as an isolated `updateCrowd` 2,000 test.
2. **Obstacle capacity and mutation scaling were not exercised.** Dense has no terrain/building revisions. Recast used one full navmesh build, zero dynamic obstacles, and zero mutation rebuilds. The configured 512-obstacle capacity and prior narrow/mutation full-rebuild caveats remain unchanged.
3. **Dense geometry succeeded; other geometry is not cleared.** Recast dense 2,000 had zero geometry/partial/endpoint failures. Prior narrow 1,000 evidence still contains 531 conservative grid-conversion rejections, and the focused one-tile gate semantic mismatch remains. Dense success does not resolve those cases.
4. **Flow cache churn remains relevant but unscaled here.** The preserved 1,000 run reached its 32-field capacity and built fields for distinct slot destinations. No 2,000 cache, memory, or build-cost claim is available.
5. **No new determinism or browser evidence.** The 2,000 runs were not repeated under delayed/out-of-order delivery. Hashes above are recorded identities, not cross-architecture equality or cross-platform determinism evidence. No real browser worker, structured clone, x64, or alternate WASM build was tested.
6. **Timing scope is limited.** There is one completed run per candidate/population. Whole-tick and callback maxima include host/JIT/GC effects; the 300 s flow timeout is an execution outcome, not a latency percentile.

## Remaining evidence gaps

- Complete flow dense 2,000 with a runtime/checkpoint strategy that can preserve an honest result; until then it remains unmeasured.
- Repeat Recast and A* dense 2,000 for warmed timing distributions and same-candidate delayed/out-of-order replay checks.
- Run 2,000-unit narrow/mutation before making dense-to-mutating scaling claims. Additional 2,000 scenarios were not run in this pass.
- Resolve Recast quantization/one-tile-gate semantics and measure incremental, revisioned TileCache mutation rather than full snapshot rebuilds.
- Execute the real browser-worker and CPU/browser matrix before any adoption or cross-platform determinism decision.

Preserved inputs: [A* 2,000 baseline](../harness/results/dense-open-120-p2000-sync.json), [A* 1,000](../harness/results/dense-open-120-p1000-sync.json), [flow 1,000](../harness/results/dense-open-120-p1000-flow.json), [Recast 1,000](results/dense-open-120-p1000-recast.json). Existing raw results and reports were not overwritten.

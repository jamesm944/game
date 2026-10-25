# Phase-2 navigation optimization evidence

Wayfinder: **“Can phase-2 navigation optimization preserve exact slots, narrow gates, and replay budgets?”** (#168)

## Decision

**Retain current integer A* as the production default. Do not promote the destination-shared flow hybrid. Replace the old Recast prototype with the new supercover/gate baseline, but keep Recast out of production pending incremental-mutation and browser evidence.**

The measured response-side phase-2 condition is real but intermittent. Five fresh full-game Chrome samples of the actual eight-leader mixed A* order produced one per-sample p95 above 33.3 ms; pooled leader p95 was 48.0 ms. Production application did not exceed roughly 2 ms at p95. No tested alternative demonstrated a production-bound win.

The next bottleneck investigation should emphasize **snapshot/version transport and incremental revisioned updates**, not another wholesale pathfinder migration. Each full-game mixed A* sample transferred 674,020,800 snapshot bytes across 46,807 requests. That makes snapshot ownership and worker protocol prime suspects alongside search computation.

## Evidence and verification

This record consolidates:

1. [Destination-shared exact-slot flow corridors](../../scratch/phase2-navigation/shared-flow/report.md)
2. [Recast supercover corridor and narrow-gate prototype](../../scratch/phase2-navigation/recast-corridor/report.md)
3. [Five-sample real-Chrome leader/apply distribution](../../scratch/phase2-navigation/browser-distribution/report.md)

Independent verification passed strict TypeScript and the reported suites: 40/40 tests for the shared-flow set, 33/33 for the Recast set, and 4/4 focused distribution tests. These suites overlap; the prototypes added 18 new focused tests. Derived scripts revalidated paired metadata, cache/search accounting, geometry counters, replay hashes, and browser/Node equivalence.

All large comparisons remain single-run Node timings except the five Chrome A* distribution samples. Firefox, WebKit, Safari, and x64 remain unmeasured.

## Destination-shared flow: churn fixed, no production win

The new hybrid maps exact goals to deterministic 24×24 regions, shares one reverse-Dijkstra field per region/revision, uses the field only for a corridor prefix, and explicitly runs production A* from the chosen handoff to the exact requested slot. Combined routes use production LOS string pulling. Disconnected anchors/suffixes use separately measured full-A* fallback. Exact endpoints and no-corner-cutting are preserved.

| Scenario | Old-flow builds → shared builds | Shared cache-hit rate | A* wall s | Shared wall s | Completed A* → shared |
|---|---:|---:|---:|---:|---:|
| Dense | 40,358 → 4 | 99.991% | 24.340 | 26.737 | 528 → 528 |
| Mixed | 32,879 → 11 | 99.976% | 19.257 | 19.822 | 571 → 571 |
| Narrow + mutation | 45,812 → 5 | 99.990% | 24.965 | 27.342 | 487 → 495 |

This reduces field builds by 99.97–99.99%, and dense/mixed matched A* request counts and final full-state hashes exactly. Narrow gained eight completions with 1,552 fewer repaths. Nevertheless, shared flow was 2.9–9.8% slower and did not improve mean/p95 tick cost.

The remaining cost is structural: every successful request still performs an exact A* suffix. The hybrid removes field churn, not per-request exact-route work. It should not be promoted unless a future design also eliminates or tightly bounds that suffix and demonstrates repeated full-game wins.

## Recast corridor: semantic baseline improved, performance not established

The new Recast candidate retains actual Detour corridor queries and exact endpoints, with no partial paths or hidden A* fallback. It replaces isolated-point flooring with conservative continuous-segment supercover conversion followed by production-LOS string pulling. Raster cell size falls from 0.5 to 0.25, restoring one-tile gates without adding agent-radius erosion.

| Scenario | Candidate | Wall s | Completed / active | Failed responses | Geometry rejects | Repaths |
|---|---|---:|---:|---:|---:|---:|
| Narrow + mutation | A* | 24.965 | 487 / 513 | 16 | — | 53,705 |
| Narrow + mutation | Old Recast | **22.006** | **558 / 442** | 547 | 531 | 17,909 |
| Narrow + mutation | New corridor | 31.062 | 500 / 500 | **16** | **0** | 53,094 |
| Dense | A* | **24.340** | 528 / 472 | 0 | — | 46,288 |
| Dense | Old Recast | 27.262 | **547 / 453** | 0 | 0 | 46,108 |
| Dense | New corridor | 27.848 | 528 / 472 | 0 | 0 | 46,288 |

The old narrow Recast result is not a clean performance win: its low churn coincided with 531 conservative route rejections. The new candidate removes those conversion rejects and preserves only the 16 impassable-endpoint failures also seen in A*. Its dense run matched A* requests, final crowd rows, world digest, and full-state hash on this trace.

Correctness cost is measurable: finer rasterization and complete conversion made narrow slower than both preserved candidates and increased the revision-6 rebuild to 116.011 ms. Dense was slower than A*. Full snapshot rebuilds and absent browser-worker evidence still block adoption.

The new supercover/gate candidate is therefore the correct **research baseline**, not a production selection.

## Repeated full-game Chrome phase-2 distribution

Five independent headless Chrome 156 runs executed the actual mixed 1,000-unit trace on Apple M1 arm64. Each had a fresh browser/page/worker, one warmup, and 3,600 committed ticks. Every sample matched preserved Node A* logically and by final full-state hash.

### Eight concurrent production leader requests

| Sample | Leader p50 ms | Leader p95/max ms | Above 33.3 ms |
|---|---:|---:|:---:|
| 1 | 46.0 | **48.6** | Yes |
| 2 | 30.6 | 32.7 | No |
| 3 | 24.0 | 26.5 | No |
| 4 | 26.6 | 30.3 | No |
| 5 | 22.4 | 24.7 | No |
| Pooled, n=40 | 26.6 | **48.0 / 48.6** | Pooled p95 yes |

Each per-sample p95 is the maximum of only eight correlated requests. Five runs remain a small distribution, not a breach-probability estimate. The proper conclusion is that response breaches occur in this workload and host, not that every run breaches.

Pooled individual-repath response p95 was 115.5 ms across 233,995 requests, with 706–867 blocked frames per run. This is separate from the ADR's leader-specific wording and confirms substantial real-worker pressure during actual movement.

### Production path application

- Initial eight-group callback totals ranged from **0.8 to 1.5 ms**; none exceeded roughly 2 ms.
- Per-active-tick apply p95 was **0.1 ms in every sample and pooled** across 9,145 active ticks.
- Apply maxima were 1.8, 1.9, 5.5, 1.8, and 2.8 ms. Two samples had tail breaches without a p95 breach.
- Chrome's 0.1 ms timer quantization means displayed zero is below resolution, not no work.

The apply-side phase-2 condition is not established at p95. Tail behavior should remain visible in future budgets.

## Interpretation

1. **Response latency does not automatically imply a new pathfinder.** Snapshot copying, structured clone, queue ownership, request coalescing, and revision sharing can be optimized while retaining A*.
2. **Flow sharing must eliminate exact-suffix work.** Canonical regions solved cache identity but not total route cost.
3. **Recast correctness comes before its benchmark advantage.** The supercover/gate baseline removes the old result's most obvious semantic confound.
4. **Replay scheduling is working.** Repeated real async Chrome delivery changed frames/blocked counts but preserved committed logical results and full-state hashes.
5. **No cross-platform claim.** The executed evidence is Chrome arm64 plus prior Node/mock results; unexecuted browsers and CPU architectures remain gaps.

## Next evidence gate

1. Introduce versioned shared passability snapshots or delta/update protocols so every request does not clone 14,400 bytes. Measure snapshot-copy/transfer CPU, worker queueing, leader/repath response, memory, and deterministic application.
2. Coalesce compatible searches/requests only where group and exact-slot semantics remain unchanged; compare against the A* control before considering a new navigator.
3. Add acknowledged, revisioned incremental TileCache updates to the new Recast corridor baseline. Stress mutation bursts, destruction, large obstacles, >512 obstacles, and multi-tile queues.
4. Run the new Recast corridor through a real browser worker and repeat dense/narrow/2,000-unit distributions. Require semantic and replay correctness before timing comparisons.
5. Preserve the existing full-game harness and current A* control. Promote a change only for repeated improvements in response budgets and full-game outcomes without semantic regressions.

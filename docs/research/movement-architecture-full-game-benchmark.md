# Full-game movement architecture benchmark

Wayfinder: **“Which movement architecture wins full-game crowd and flow-field benchmarks?”** (#167)

## Decision

**Retain the current authoritative integer A* as the production default for now. No candidate wins every measured correctness, crowd-quality, performance, mutation, and portability criterion.**

- **Current A*** remains the safest default: it preserves existing grid/gate semantics, has the simplest integration, and avoids Recast's route-quantization and navmesh-rebuild issues.
- **The current flow-field integration is rejected for production adoption.** It was slower and completed fewer units on every measured 1,000-unit full-game trace because exact formation-slot repaths destroyed destination sharing. Its 2,000-unit run did not finish within the 300 s execution limit. This does not prove every possible flow-field design is inferior.
- **Recast/Detour is the strongest challenger and should remain in the prototype lane.** It completed more units on all four 1,000-unit traces and beat A* in the single dense 2,000-unit run, but narrow-gate semantics, conservative route rejection, full snapshot rebuilds, browser integration, and repeated timing distributions remain unresolved.
- **ADR-0003's response-side phase-2 concern now has direct full-game evidence.** In one Chrome full-game mixed-destination run, the actual eight concurrent A* leader requests had 39.4 ms response p95, exceeding 33.3 ms. This is one measured trace, not a stable trigger distribution or proof that flow fields are the remedy.
- **The production apply-side trigger did not breach at p95 in the measured browser configurations.** The eight mixed A* group/Activity callbacks totaled 1.0 ms at their shared application tick. Overall per-active-tick apply p95 was 0.1 ms for large A* traces; maxima are reported separately below.

The next effort should optimize the measured bottleneck without weakening exact slots, narrow-gate connectivity, mutation correctness, or deterministic application. It should not migrate the production navigator on the current evidence.

## Evidence set

This record consolidates the following primary-code audits and raw benchmark reports:

1. [Flow-field implementation and microbenchmark](../../scratch/full-game-movement/flow-field/report.md)
2. [Full-game harness and current-A* baseline](../../scratch/full-game-movement/harness/report.md)
3. [Flow-field full-game comparison](../../scratch/full-game-movement/harness/flow-field-comparison.md)
4. [Recast full-game integration](../../scratch/full-game-movement/recast-integration/report.md)
5. [Dense 2,000-unit scaling](../../scratch/full-game-movement/recast-integration/scaling-2000.md)
6. [Direct real browser-worker loads](../../scratch/full-game-movement/harness/browser/report.md)
7. [Asynchronous full-game Chrome evidence](../../scratch/full-game-movement/harness/browser/full-game/report.md)

Independent verification during the research included strict TypeScript checks and **38/38 tests** across flow-field correctness, the full-game harness, flow integration, Recast integration, direct-browser artifacts, and asynchronous full-game browser equivalence. Derived scripts validated paired metadata, crowd/outcome totals, cache accounting, capacity failures, scaling artifacts, and replay comparisons.

## Harness fidelity

The full-game runner executes actual `World.step`, recorded commands, Activity queues, production one-leader group orders, formation/final slots, individual stall repaths, steering, collision, Parked/stall behavior, placement mutations, passability revisions, the production scheduler, and full-state digests.

All candidates use the same recorded 120 × 120 scenarios:

- dense open movement;
- opposing flows;
- eight mixed destinations;
- narrow four-tile gate with terrain close/reopen and four production house placements.

The scheduler preserves ascending request IDs, `dueTick = issueTick + 2`, stale-revision rejection, and blocked target ticks. The candidates differ in route geometry, so their world hashes are not expected to match each other. Each candidate must instead reproduce its own logical state across repeated and asynchronous schedules.

The harness runs real movement and placement loops, not combat, gathering, rendering, or a complete production session. Large Node configurations have one measured run each. Cutoff-active/stalled states are observations at tick 3,600, not proof of permanent deadlock.

## Full-game Node results at 1,000 units

All rows are 120 × 120, 3,600 committed ticks, Apple M1 arm64, Node 24.21.0. “Completed” means the trace-linked Activity completed; narrow additionally has 1,000 initial stale-cancelled records for every candidate.

| Scenario | Candidate | Wall s | Completed / active | Repaths | Mean / p95 tick ms |
|---|---|---:|---:|---:|---:|
| Dense | A* | 24.340 | 528 / 472 | 46,288 | 6.134 / 9.460 |
| Dense | Flow | 159.465 | 424 / 576 | 51,292 | 43.070 / 19.805 |
| Dense | Recast | 27.262 | **547 / 453** | 46,108 | 6.846 / 14.643 |
| Opposing | A* | 20.458 | 533 / 467 | 51,029 | 5.126 / 7.316 |
| Opposing | Flow | 176.138 | 443 / 557 | 55,550 | 47.644 / 18.541 |
| Opposing | Recast | 24.994 | **538 / 462** | 51,069 | 6.241 / 12.838 |
| Mixed | A* | 19.257 | **571 / 429** | 46,799 | 4.783 / 7.486 |
| Mixed | Flow | 124.403 | 494 / 506 | 51,431 | 33.276 / 17.617 |
| Mixed | Recast | 24.764 | **582 / 418** | 46,665 | 6.091 / 10.961 |
| Narrow + mutation | A* | 24.965 | 487 / 513 | 53,705 | 6.324 / 12.185 |
| Narrow + mutation | Flow | 178.587 | 347 / 653 | 54,191 | 48.632 / 121.286 |
| Narrow + mutation | Recast | **22.006** | **558 / 442** | **17,909** | **5.455 / 10.747** |

Recast's narrow improvement coincided with 531 conservative grid-geometry route rejections and 16 impassable-endpoint rejections. Fewer repaths and more completions are desirable measured outcomes, but the rejected routes are also a semantic hazard that must be fixed rather than hidden.

## Why the flow-field integration lost

The standalone candidate is a real deterministic reverse-Dijkstra implementation with straight/diagonal costs 1000/1414, no corner cutting, multiple goals, O(1) cost/direction lookup, and a revision-keyed 32-entry LRU. Exact raw route costs matched production A* in correctness tests.

The full-game workload did not resemble the successful shared-destination microbenchmark:

| Scenario | Field builds | Cache-hit rate | Field-build total |
|---|---:|---:|---:|
| Dense | 40,358 | 21.32% | 134.938 s |
| Opposing | 43,880 | 21.01% | 152.033 s |
| Mixed | 32,879 | 36.08% | 101.552 s |
| Narrow + mutation | 45,812 | 15.47% | 151.484 s |

Initial group orders share a leader destination, but subsequent production stall repaths request exact formation slots. Those distinct goals created cache churn. The flow candidate also returned raw tile-descent routes rather than A* string-pulled routes, changing downstream congestion.

Therefore the evidence rejects **this destination-per-exact-slot, raw-route, 32-field integration**. A future prototype must increase legitimate destination sharing or decouple shared corridor guidance from exact final-slot arrival while preserving current game semantics.

## Dense 2,000-unit scaling

| Candidate | Result | Completed / active | Repaths | Mean / p95 tick ms |
|---|---|---:|---:|---:|
| A* | 51.968 s | 973 / 1,027 | 90,903 | 13.167 / 18.838 |
| Recast | **44.213 s** | **995 / 1,005** | **89,777** | **11.007 / 16.405** |
| Flow | **Unmeasured: killed at 300 s before result write** | — | — | — |

Recast completed 22 more units and was 14.9% faster than A* in this single dense Node run. This strengthens the prototype case but does not resolve other traces, geometry semantics, mutations, browser behavior, or timing distributions.

The full-game Recast candidate uses production steering/collision and creates zero DetourCrowd agents. The dense run therefore does not test the isolated 2,000-agent Crowd capacity. It also has no mutations and does not test the 512-obstacle limit.

## Recast integration boundaries

The candidate performs actual Detour `findClosestPoint` → `findPath` → `findStraightPath` queries and returns paths through the existing scheduler and movement loops. It rejects partial results, projected/off-goal endpoints, impassable endpoints, and grid-invalid quantized segments.

Current limitations that block adoption:

1. **Lossy tile-center quantization.** Continuous corridors are floored/deduplicated into the existing integer waypoint protocol. Valid continuous routes can be rejected.
2. **One-tile gate mismatch.** A focused probe failed a one-cell doorway while the corresponding two-cell doorway succeeded. Current A* preserves the one-tile passage.
3. **Full revision rebuilds.** The transport supplies snapshots, so the candidate rebuilds TileCache/navmesh state from exact revision bytes through an eight-entry LRU. Narrow's revision-6 rebuild cost 80.022 ms.
4. **No incremental obstacle evidence.** This candidate creates zero dynamic obstacles; acknowledged, revisioned TileCache updates and >512-obstacle behavior remain unmeasured.
5. **No Recast browser-worker run.** Node WASM results do not establish browser turnaround, packaging, or cross-WASM determinism.
6. **Single large samples.** More warmed repetitions are required before treating timing tails or small completion deltas as stable.

## Real full-game Chrome evidence

The asynchronous browser driver executes actual `World.step` and yields after every committed or blocked attempt so real module-Worker messages can arrive. It uses the production A* worker and the existing flow worker, the actual leader/repath mix, and production group/Activity callbacks.

Executed on headless Chrome 156.0.8078.47, Apple M1 arm64:

| Candidate / trace | Completed | Requests | Frames / blocked | Individual-repath response p95 |
|---|---:|---:|---:|---:|
| A* dense 1,000 | 528 | 46,289 | 4,316 / 716 | 110.9 ms |
| A* mixed 1,000 | 571 | 46,807 | 4,344 / 744 | 121.0 ms |
| Flow dense 1,000 | 424 | 51,293 | 26,252 / 22,652 | 2,223.4 ms |

All five browser configurations—A* dense/mixed, flow dense, and repeated A*/flow mutation traces—matched their preserved same-candidate Node results logically and by final full-state hash. Async timing changed frames and blocked counts, not committed results.

### ADR-0003 phase-2 reading

| Evidence | Measured result | Interpretation |
|---|---|---|
| A* dense initial leader | 30.6 ms | One request; does not establish a concurrent-leader breach |
| A* mixed eight initial leaders | **39.4 ms p95** | Direct response-side breach on this measured full-game trace |
| A* mixed initial group/Activity apply | **1.0 ms total at shared tick** | No initial-group apply-side breach |
| A* large per-active-tick apply | **0.1 ms p95** | Below roughly 2 ms at p95 |
| A* mixed apply maximum | 2.4 ms | Tail observation, not a p95 breach |
| Flow dense per-active-tick apply | 0.4 ms p95; 10.7 ms max | Below p95 threshold but substantial tail |
| Flow dense initial leader | 46.1 ms response; 2.1 ms apply | Single quantized observation, not a sustained apply conclusion |

The appropriate response is targeted phase-2 research, not an automatic flow-field migration. The current flow candidate made real browser repath turnaround dramatically worse.

Direct real-worker stress also ran in Chrome 156 and Chromium 153: 15/16 configurations exceeded 33.3 ms response p95, with an overall range of 25.5–246.7 ms. Those per-member loads support the queueing concern but are not substitutes for the full-game leader evidence above.

## Replay and platform scope

- Current A*, flow, and Recast each matched their own same-host Node repeat and delayed/out-of-order mock logical state and final hashes on the 100-unit mutation trace.
- Real Chrome asynchronous full-game runs matched preserved same-candidate Node logical state and final hashes.
- Direct Chrome/Chromium matched logical route hashes for all eight paired configurations.
- Mutation recovery occurred at tick 182 after the recorded tick-180 reissue, with revision sequence `0→1→5→6` and the expected initial stale group cancellations.

These are strong schedule-equivalence results within the executed environments. They are not general cross-platform determinism claims. Firefox and Playwright WebKit binaries were unavailable, Safari refused automation because remote automation is disabled, and x64 was not executed. Recast also lacks browser-worker evidence.

## Required next work

1. Repeat the actual eight-leader mixed A* browser trace to establish a stable leader-response distribution rather than relying on one p95 over eight requests.
2. Prototype destination-shared flow guidance that preserves exact final slots while reducing field churn; compare against the same full-game traces and browser leader/repath mix.
3. Replace Recast's lossy waypoint quantization with a validated float/corridor protocol or formally correct grid conversion; restore one-tile gate connectivity without silently changing clearance rules.
4. Implement acknowledged, revisioned incremental TileCache mutation and measure mutation bursts, large obstacles, and capacity failures.
5. Add a real Recast browser worker and repeat Recast/A* 2,000-unit and narrow/mutation runs for warmed distributions and replay equality.
6. Expand browser and CPU coverage before any cross-platform claim. Missing browsers/architectures are evidence gaps, not failures inferred from Chrome.
7. Keep current A* as the control throughout. Adoption requires better full-game completion and budgets without semantic or replay regressions.

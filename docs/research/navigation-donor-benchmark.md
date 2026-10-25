# Navigation donor benchmark and crowd evidence

Wayfinder: **“Which navigation donor best survives crowd load and terrain mutation?”** (#162)

## Decision

**Keep the current authoritative integer A* as the default for now. Do not migrate to PathFinding.js or adopt Recast/Detour yet. ADR-0003 remains in force.**

- **Current integer A*** remains competitive on path requests, has a large measured advantage for repeated group orders through its production LRU, and preserves the existing deterministic tick/application contract.
- **PathFinding.js 0.4.18** showed no path-latency or path-quality advantage over the current implementation on the shared fixtures. There is no evidence-based reason to adopt it.
- **Recast/Detour 0.43.0 through Voidstrike** is a promising candidate for elevated connectivity and isolated crowd movement, but not a drop-in replacement. Its current integration has partial-path semantics, costly maze smoothing, capacity bookkeeping defects, duplicated worker/main navmeshes, and unresolved replay determinism.
- **No full-game crowd winner has been established.** The shared benchmark measured path requests, not the complete Activity/steering/collision loops. Recast's isolated crowd tests bypassed the rest of its movement stack.
- **Phase-2 flow fields remain unimplemented and unmeasured.** Existing performance tests do not measure either ADR-0003 phase-2 trigger. This ticket cannot declare flow fields necessary or unnecessary.

The next evidence gate is a full-game comparison of current A*, a real flow-field implementation, and Recast under identical recorded maps and commands, including the real browser worker and replay hashes.

## Evidence base

This record consolidates three independently produced audits:

1. [Shared path-request benchmark](../../scratch/navigation-benchmark/benchmark-report.md): shared fixtures and native adapters for project A*, PathFinding.js, and Voidstrike Recast.
2. [Current navigation audit](../../scratch/donor-audit/current-navigation-report.md): implementation/ADR comparison, reusable tests, contract hazards, and missing phase-2 measurements.
3. [Recast donor audit](../../scratch/donor-audit/recast-navigation-report.md): existing donor tests, isolated crowd stress, capacity limits, worker integration, and determinism sensitivity.

Verification completed during the audits:

- Current navigation: **122/122 targeted tests passed** across 13 files.
- Recast elevated/obstacle/connectivity suites: **5/5 tests passed**.
- Recast PathfindingSystem coordination: **19/19 tests passed**.
- Recast repeated mutation stress: **25/25 reroutes and 25/25 exact path restorations**.
- Shared benchmark assertions: exact-goal outcomes, within-run stability, mutation restoration, and cross-process logical digest equality all passed.

These results validate the scoped harnesses; they do not turn microbenchmarks into full-game evidence.

## Shared path-request benchmark

### Method

All three engines consumed the same generated JSON fixtures on a 64 × 64 grid: open ground, maze, dense choke points, ramps/elevation, unreachable targets, and a dynamic gate. Recast received actual vertex heights; the grid engines received the equivalent 2D passability problem.

Environment: Apple M1, 8 logical CPUs, 16 GiB RAM, macOS arm64, Node 24.21.0. The donor was Voidstrike commit `4df0235116b78bf9232105486738e64b2e6905cb`; the project baseline was `c462f54952490e61441612606b86410d85a4c6c6`. PathFinding.js was 0.4.18 and recast-navigation was 0.43.0.

Each request had 10 warmups and 50 measured iterations. Reported rows pool samples across each map's requests. Values below are from `run-02`; latency is milliseconds. Setup, worker transport, rendering, and movement are excluded. Native pipelines differ: PathFinding.js returns unsmoothed grid paths, while project A* and Voidstrike Recast apply their native smoothing.

### Latency and path quality

| Fixture | Engine | p50 ms | p95 ms | Native path-quality observation |
|---|---|---:|---:|---|
| Open | Project A* | 0.0526 | 0.1909 | Diagonal route length 73.593478 |
| Open | PathFinding.js | 0.0652 | 0.2018 | Diagonal route length 74.710678 |
| Open | Recast | 0.0141 | 0.0797 | Diagonal route length 73.593478 |
| Maze | Project A* | 0.3186 | 0.6422 | Opposite route length 136.367086 |
| Maze | PathFinding.js | 0.3471 | 1.8785 | Opposite route length 140.769553 |
| Maze | Recast | 9.7140 | 23.9043 | Opposite route length 124.308032 |
| Dense choke points | Project A* | 0.3511 | 0.8118 | All-gates route length 103.653994 |
| Dense choke points | PathFinding.js | 0.4065 | 1.1817 | All-gates route length 110.568542 |
| Dense choke points | Recast | 2.1415 | 4.4284 | All-gates route length 102.734337 |
| Dynamic gate | Project A* | 0.0247 | 0.0918 | All exact outcomes matched |
| Dynamic gate | PathFinding.js | 0.0548 | 0.1543 | All exact outcomes matched |
| Dynamic gate | Recast | 0.0276 | 0.2165 | All exact outcomes matched |

Recast's shorter smooth maze route came with much slower queries in Voidstrike's integration, whose smoothing performs many `findClosestPoint` checks. These are consumer-visible native paths, not an identical-post-processing or optimal-length comparison.

The ramp trace only proves elevated connectivity for Recast. Current A* and PathFinding.js solved 2D connectivity and cannot validate slope or height semantics. Current game elevation affects combat/range/sight, not navigation; adding cliff or slope rules would be a game-rules change rather than donor parity.

### Exact-goal semantics

Exact success required reported success and a final waypoint within 0.05 world units of the requested goal center.

Project A* and PathFinding.js returned no path for sealed goals. Voidstrike Recast returned `found: true` with partial paths. On `unreachable/sealed-center`, it returned a 31.752953-unit, two-waypoint partial path ending 10.012492 units from the goal. Its `found` flag therefore cannot be treated as exact reachability; an adoption candidate needs an explicit exact-goal/partial-path contract and endpoint validation.

### Repeated group orders

Each batch issued 32 identical orders. Project batches used the production path engine, producing one cold request and **31 same-key LRU hits by construction**. PathFinding.js and Recast executed 32 native queries. There were 5 warmup and 20 measured batches.

| Fixture | Engine | Batch p50 ms | Mean/order ms |
|---|---|---:|---:|
| Maze | Project A* + LRU | 0.2221 | 0.0175 |
| Maze | PathFinding.js | 4.3455 | 0.1586 |
| Maze | Recast | 332.2875 | 10.6443 |

This is a measured advantage of the current integration for repeated identical group orders, not proof that every possible Recast cache would be slower. Any replacement benchmark must include equivalent group/cache semantics.

### Dynamic mutation

A 6 × 12 rectangle sealed an eight-tile gate; removal restored the original map. Grid engines updated the same 72 cells. Recast used native TileCache box obstacles. Query timing was outside mutation timing. There were 5 warmup and 20 measured cycles.

| Engine | Add/update p50 ms | Remove p50 ms | Post-add exact failure | Post-remove baseline restored |
|---|---:|---:|---:|---|
| Project A* grid | 0.000375 | 0.000750 | 20 / 20 | 20 / 20 |
| PathFinding.js grid | 0.000834 | 0.003000 | 20 / 20 | 20 / 20 |
| Recast TileCache | 0.093167 | 0.091584 | 20 / 20 | 20 / 20 |

Three full Recast terrain rebuild samples took **22.604, 28.406, and 38.976 ms**. This is only a smoke-scale estimate. Recast building mutation normally rebuilds affected TileCache tiles, not the full navmesh; grid passability mutation does not require a mesh rebuild.

### Repeatability, not cross-platform determinism

Normalized outputs were stable within runs, and all mutation removals restored exact baseline outputs. Two independent Node processes produced the same complete logical-result SHA-256:

`f8699c528fb2fea92a2514835b9b6a9e3e96c0b533be914554514dc23558b527`

This establishes same-host repeated-run logical stability only. It is not evidence of cross-browser, cross-architecture, or multiplayer lockstep determinism.

## Current-system audit

ADR-0003 phase 1 is substantially implemented: integer-cost group A*, deterministic neighbor/tie ordering, two-tick `dueTick` scheduling, a dedicated worker, versioned passability snapshots, a 32-entry LRU, string pulling, steering/collision, formations, and separate land/naval/owner-specific passability planes.

Flow fields and elevation-aware navigation are absent. Existing load tests use synchronous path transport and whole-tick timings; they do not measure concurrent real-worker turnaround against one 30 Hz tick or real path-application cost against roughly 2 ms/tick. Therefore neither phase-2 trigger has demonstrated evidence.

Important hazards for any follow-up benchmark or migration:

1. **Stale in-flight group orders can disappear.** Individual stale repaths release holds and retry; stale group responses are discarded without equivalent automatic reissue.
2. **Line of sight is not a general supercover.** Shallow-slope segments can skip intersected cells or reject clear ones. Path parity needs an independent traversal oracle and an explicit preserve-versus-fix decision.
3. **Mixed land/naval groups inherit the leader's medium.** They are not independently correct for every member.
4. **Full-grid snapshots can dominate real worker cost.** Requests copy and post the full plane. Search-only timings omit this and can misrank integrations.
5. **Cache correctness depends on version discipline.** The LRU key omits raw grid bytes and medium/owner identity, relying on unique snapshot versions for every semantic mutation.
6. **Gather work is not wholly off-thread.** Drop-off candidate selection can run exact A* synchronously on the main thread and must appear in recorded workloads.

## Recast crowd and integration evidence

### Isolated crowd results

The stress harness called `RecastNavigation.addAgent`, `setAgentTarget`, `updateCrowd`, and `getAgentState` directly. It bypassed Voidstrike's MovementOrchestrator, worker queries, physics pushing, flocking, building avoidance, zero-velocity fallback, and arrival handling.

| Scenario | Agents | Cutoff | Arrived | Stuck at end | Mean crowd update ms |
|---|---:|---:|---:|---:|---:|
| Dense parallel movement | 1,000 | 10 s | 980 | 0 | 1.366 |
| Opposing flows | 400 | 12 s | 395 | 0 | 0.510 |

“Arrived” meant within 1.5 world units at the cutoff; “stuck at end” meant distance >2 and final speed <0.01. Neither scenario reached 100% arrival. These encouraging isolated numbers do not establish full-game completion time, frame cost, narrow-terrain robustness, or deadlock freedom.

Voidstrike's actual crowd flags enable anticipated turns but disable Detour obstacle avoidance and separation. Its JS/WASM flocking and fallback remain part of effective behavior, so the isolated crowd result cannot be attributed to a complete RVO-based replacement.

### Capacity limits and defects

- One ground crowd accepted **2,000 agents** and rejected agent 2,001.
- The rejected agent had index `-1` but was still inserted into `agentMap`, so `getAgentCount()` incorrectly reported **2,001**.
- One TileCache accepted **512 obstacles**; obstacle 513 was not tracked.
- The integration lacks a robust public capacity-failure/telemetry path.
- Upstream structural limits and the eight-update TileCache cap require stress testing for large or bursty mutations.

A roadmap requiring dense battles at or above 2,000 ground units cannot assume the current donor wrapper scales safely without partitioning, capacity handling, and full-game tests.

### Worker and replay risks

Voidstrike independently generates and mutates worker-side and owner-side navmeshes. Crowd updates do not run in the path worker. Obstacle mutations have no acknowledgment or revision barrier, and worker path results apply immediately on message arrival rather than at deterministic target ticks.

Identical direct crowd runs matched exactly on the same host. Reversing insertion order and changing timestep subdivision changed final state. Fixed stepping is necessary but not sufficient. No Chrome/Firefox/Safari, arm64/x64, or independent-WASM-build determinism evidence was produced.

These issues do not prove Recast cannot be adapted; they mean its existing worker and crowd integration cannot replace the current authoritative replay contract unchanged.

## Interpretation and limits

1. **Retain, don't freeze.** Keeping A* is the current default, not a permanent rejection of better movement architecture.
2. **Reject PathFinding.js on this evidence.** It offered no compensating advantage for an integration/migration cost.
3. **Keep Recast in the prototype lane.** Its elevation and isolated crowd results justify a controlled full-game candidate, not adoption.
4. **Implement flow fields before judging them.** ADR-0003 names them as the phase-2 candidate, but no real implementation exists to benchmark.
5. **Measure the actual bottleneck.** Include snapshot copy/transfer, worker queueing, due-tick application, Activity completion, steering, repaths, and rendering-independent simulation cost.
6. **Preserve game semantics.** Group leader/slot behavior, owner gates, naval planes, mutation invalidation, fixed ticks, and exact replay digests are part of the candidate contract.
7. **Do not overgeneralize synthetic fixtures.** The shared maps are deterministic 64 × 64 microbenchmarks, not live 120 × 120 gameplay captures. Timing tails are based on limited samples, and full rebuilds on only three measurements.

## Required next evidence

Create a real flow-field candidate and run current A*, flow fields, and Recast through identical recorded 120 × 120 maps and command traces using the full Activity/steering/collision loops. Measure:

- real browser worker issue-to-response wall time and issue-to-apply ticks;
- path-application main-thread cost and queue depth;
- activity completion ticks, stuck/repath counts, and arrival classification;
- 1,000- and 2,000-agent density, opposing flows, narrow passages, and mixed destinations;
- mutation bursts, mutation-to-visibility latency, capacity failures, and recovery;
- full-state replay hashes under repeated runs and asynchronous delivery patterns.

Before any cross-platform determinism claim, repeat on Chrome, Firefox, and Safari and on at least two CPU architectures. Compare simulated completion separately from wall-clock timing, and do not require different engines to choose identical equal-cost paths unless their geometry and tie-breaking are deliberately unified.

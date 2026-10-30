# Wayfinder #167 — full-game movement harness and current-A* baseline

## Verdict and evidence boundary

This directory contains an isolated, reusable full-game crowd/mutation benchmark for the **current authoritative integer-A\*** stack. It executes the real `World.step`, Activity queues, group route application, steering, collision, stall/Parked FSM, placement mutations, and scheduler; it does not substitute a point-to-point path microbenchmark.

The measured baseline is **Node 24.21.0, Apple M1 arm64, 16 GiB RAM**. Synchronous results are labelled `node-inline`; delayed results are labelled `node-mock-transport`. Neither is real browser-worker evidence. No architecture winner is declared: flow-field and Recast candidates have not yet been attached.

No production, package, issue, donor, or commit files were changed. Both requested scales ran to the full recorded cutoff: **1,000 and 2,000 units, 120 × 120, 3,600 committed ticks (120 simulated seconds)**. There was no scale/API blocker for the dense scenario.

## Why this is full-game evidence

- `createWorld` accepts authored layers and a scheduler; `step` pumps due paths before incrementing the tick, draining commands, and running systems (`src/sim/core/world.ts:100-171,252-275`). The harness uses those paths directly.
- `spawnUnit` creates the production Position, Velocity, UnitTag, MoveTarget, and ActivityQueue rows (`src/sim/components/index.ts:699-775`). Activity decoding is read through `readActivityQueue` (`src/sim/components/index.ts:598-622`).
- A group order makes one leader request and applies formation/member waypoints in the production continuation (`src/sim/systems/movement.ts:444-470,502-522,599-686`).
- The run includes real steering, spatial-hash collision, separation, live-segment validation, sidestep/repath, stall counting, and Parked propagation (`src/sim/systems/movement.ts:802-867,959-1003,1027-1604,1606-1807`). Movement diagnostics provide the actual sidestep/repath/group-application counters (`src/sim/systems/movement.ts:316-329`).
- The unchanged scheduler copies each passability snapshot, applies responses in ascending ID order, holds late due ticks, and discards stale revisions (`src/sim/path/scheduler.ts:155-231`). Current A*/LRU behavior comes from the production engine (`src/sim/path/engine.ts:61-107`).
- Building mutations use actual `placeBuilding` commands and `createPlacementSystem`; placement blocks footprints and bumps revisions (`src/sim/systems/placement.ts:442-449,452-509,569-583`). Synthetic terrain bursts use the public layer arrays plus `setPassabilityVersion`; they are explicitly not represented as a production terrain-editing command.
- Production world digests cover all registered component rows (`src/sim/core/world.ts:277-295`). Canonical layer bytes/hashes and serializable four-word PRNG state are defined at `src/sim/world/layers.ts:133-190` and `src/sim/core/prng.ts:9-19,70-85`.

## Files

| File | Purpose |
|---|---|
| `fixtures/scenarios.json` | Recorded 120 × 120 map recipes, spawn rectangles, destinations, absolute command ticks, and mutations. |
| `types.ts` | Scenario/result schemas, candidate adapter, evidence classes, and unit/path/mutation metrics. |
| `candidates.ts` | Current-A* inline adapter and deterministic delayed/out-of-order mock adapter. |
| `instrumentation.ts` | Runtime-only decoration of public scheduler methods; request/response/apply/discard instrumentation. |
| `runner.ts` | World construction, trace expansion, real movement/placement loops, completion/crowd classification, replay hashes, and raw metrics. |
| `run.ts` | CLI runner and raw JSON writer. |
| `harness.test.ts` | Correctness, completion, mutation, opposing/mixed smoke, and determinism tests. |
| `browser-runner.ts` | Real Chrome/Firefox/Safari runner contract and minimum browser/CPU matrix; intentionally no fake implementation. |
| `summarize.py` | Reproducible percentile/outcome summaries and repeat/mock comparison from raw JSON. |
| `results/` | Raw per-run JSON, `summary.json`, and `determinism.json`. |
| `tsconfig.json` | Isolated strict TypeScript checking. |

## Recorded scenarios and traces

All maps are grass except explicitly blocked rectangles. Spawns are row-major, one unit per passable tile. Population is allocated proportionally by group share with deterministic largest-remainder ties. Every initial group command is `groupMove`; there are no hidden AI commands.

| Scenario | Groups, spawns, and destinations | Command/mutation trace | Cutoff |
|---|---|---|---|
| `dense-open-120` | One group; spawn rectangle `(10,10,29×101)` → `(80.5,60.5)`. | One group order at tick 1. | 3,600 |
| `opposing-open-120` | West `(10,10,29×101)` → `(80.5,60.5)`; east `(82,10,29×101)` → `(39.5,60.5)`. Equal population shares. | Both orders at tick 1. | 3,600 |
| `narrow-mutation-120` | West `(38,42,20×37)` → `(80.5,60.5)`; east `(63,42,20×37)` → `(39.5,60.5)`. Wall `x=60`, except four-tile gate `y=59..62`. | Orders at ticks 1 and 180. Gate closes at tick 2 and reopens at 120. Four real 2×2 house sites at tick 2: `(52,50)`, `(52,68)`, `(66,50)`, `(66,68)`. | 3,600 |
| `mixed-destinations-120` | Eight equal-share groups in 29×12 spawn bands at `x=10`, `y=5+13g`; destinations `(75.5,20.5)`, `(90.5,20.5)`, `(105.5,40.5)`, `(75.5,55.5)`, `(90.5,65.5)`, `(105.5,80.5)`, `(75.5,95.5)`, `(90.5,100.5)`. | All eight orders at tick 1. | 3,600 |

The original 1,800-tick dense cutoff was too short for the farthest approximately 86-tile routes; it was corrected to 3,600 before accepting results. Raw final unit states remain in every result so a cutoff is auditable rather than being mistaken for arrival.

## Candidate and instrumentation contract

`MovementCandidateAdapter` accepts request/response observers and supplies a `PathTransport`; optional frame hooks and candidate-only metrics support delayed workers or donor-specific telemetry. A flow-field or Recast integration can therefore sit below the unchanged world/Activity/movement/scheduler contract. If a candidate cannot preserve that contract, that incompatibility must be reported rather than hidden by changing the workload.

Instrumentation wraps scheduler methods only in the harness process:

1. Transport send records request ID, issue/due ticks, snapshot bytes, and revision.
2. Response receipt records callback wall time and engine compute time.
3. `onApply` measures the actual production callback, including group slot/Activity writes, and records apply tick/cost.
4. Ordered pump removal distinguishes stale group requests even though production group orders have no `onDiscard` reissue. This records the known cancellation behavior; it does not repair it.
5. Only committed ticks produce replay milestones. This avoids treating a partially applied but subsequently blocked pump as a committed world state.

### Metric definitions

- **Completion:** after a trace-linked successful group application, the unit's ActivityQueue becomes empty; completion tick is that committed simulation tick. `no-path`, `stale-cancelled`, `replaced`, and `active-at-cutoff` are separate outcomes, never counted as completion.
- **Crowd state:** final Activity/Velocity rows classify completed, moving, stalled (`stalledTicks>0`), propagated-Parked, parked-without-activity, and other activity. `awaitingGroupPath` covers trace-linked group requests only. The movement system's private per-unit repath-await set is not publicly observable, so the harness does not invent per-unit awaiting-repath counts.
- **Repaths/sidesteps:** production `MovementDiagnostics` totals. High values are behavioral results, not automatically pathfinder failures.
- **Queue/blocked:** scheduler `pendingCount` sampled each frame and cumulative `blockedTicks`.
- **Issue→response:** callback wall time in the selected Node transport. **It excludes real browser scheduling/structured-clone turnaround and is not browser evidence.** The snapshot is already copied before transport send, so snapshot-copy wall time is not isolated; `snapshotBytes` is recorded.
- **Issue→apply:** simulated boundary difference. Late mock delivery holds the simulated tick, so logical apply remains at the due boundary while frame count and blocked ticks grow.
- **Apply cost:** wall time inside production `onApply`; it excludes search and rendering.
- **Mutation recovery:** first later applied path whose issue tick and revision are at/after the mutation. It is path recovery, not a claim that every activity completed.
- **Tick wall time:** synchronous `step` duration, reported separately from simulated seconds and activity completion ticks.
- **Full-state replay hash:** SHA-256 over `[tick, productionWorldDigest, layersHash, serializedPrngState]`. Milestones also retain the two production hashes separately.

## Measured current-A* results

All rows below are `node-inline`, 120 × 120, 3,600 committed ticks. Wall clock is one measured run, not a statistically stable benchmark distribution. Completion percentiles include completed records only. Apply max is milliseconds; queue max includes the stall-repath storm, not just initial group commands.

| Scenario / population | Wall s | Completed / active at cutoff | Completion tick p50 / p95 | Repaths | Mean / p95 tick ms | Apply max ms | Queue max |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dense / 1,000 | 24.340 | 528 / 472 | 2,171 / 3,223 | 46,288 | 6.134 / 9.460 | 2.212 | 1,000 |
| Dense / 2,000 | 51.968 | 973 / 1,027 | 2,148 / 3,190 | 90,903 | 13.167 / 18.838 | 3.059 | 2,000 |
| Opposing / 1,000 | 20.458 | 533 / 467 | 2,256 / 3,114 | 51,029 | 5.126 / 7.316 | 1.481 | 1,000 |
| Mixed / 1,000 | 19.257 | 571 / 429 | 2,023 / 2,931 | 46,799 | 4.783 / 7.486 | 2.759 | 1,000 |
| Narrow+mutation / 1,000 | 24.965 | 487 / 513 latest orders | 1,883 / 3,314 | 53,705 | 6.324 / 12.185 | 2.607 | 915 |

The narrow row additionally has 1,000 `stale-cancelled` records from the two initial group orders at tick 1 (500 units per group). Thus its 2,000 completion records comprise 1,000 initial cancellations plus 487 completed and 513 active reissued orders. These are command/activity records, not unique-unit arrival percentages.

At the dense cutoff, final states were:

- 1,000: 528 completed, 26 moving, 435 stalled, 11 propagated-Parked; 46,289 total requests (46,287 applied, 2 pending).
- 2,000: 973 completed, 51 moving, 925 stalled, 51 propagated-Parked; 90,904 total requests (90,891 applied, 13 pending).

Unfinished units are not asserted to be permanently stuck beyond the measured cutoff. The results do demonstrate substantial repath/stall churn and incomplete activity under these recorded workloads.

### Mutation recovery

At both 100 and 1,000 population, revision transitions were exactly:

1. tick 2 terrain gate close: `0→1`, four changed tiles;
2. tick 2 four real house placements: `1→5`, sixteen changed tiles;
3. tick 120 gate reopen: `5→6`, four changed tiles.

Both initial group responses were stale-discarded. After the recorded tick-180 reissue, the first revision-qualified path applications occurred at tick 182. This directly exercises the group-stale cancellation hazard described in `src/sim/systems/movement.ts:599-686` and stale scheduler behavior in `src/sim/path/scheduler.ts:222-230`.

### Determinism findings

The recorded narrow/mutation trace at population 100, cutoff 600, was run twice inline and once with deterministic delayed/out-of-order mock delivery:

- repeated inline logical results: **equal**;
- inline versus mock milestones, completions, final unit rows, crowd states, and diagnostics: **equal**;
- final full-state hash in all three: `6947072dea89e2d9bf4d792930c7de81c61e718e3d37eaca755d8333cd891ba7`;
- inline: 600 frames, 0 blocked ticks;
- mock: 816 frames, 216 blocked ticks, same 600 committed simulation ticks.

This is same-host Node/mock replay evidence only. It says nothing about real Chrome/Firefox/Safari workers, x64, WASM, or independent browser builds.

## Exact commands

Run from the repository root:

```sh
npx tsc -p scratch/full-game-movement/harness/tsconfig.json
npx vitest run scratch/full-game-movement/harness/harness.test.ts

npx tsx scratch/full-game-movement/harness/run.ts --scenario dense-open-120 --population 1000 --mode sync --output scratch/full-game-movement/harness/results/dense-open-120-p1000-sync.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario dense-open-120 --population 2000 --mode sync --output scratch/full-game-movement/harness/results/dense-open-120-p2000-sync.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario opposing-open-120 --population 1000 --mode sync --output scratch/full-game-movement/harness/results/opposing-open-120-p1000-sync.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario mixed-destinations-120 --population 1000 --mode sync --output scratch/full-game-movement/harness/results/mixed-destinations-120-p1000-sync.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 1000 --mode sync --output scratch/full-game-movement/harness/results/narrow-mutation-120-p1000-sync.json

npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-sync-a.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-sync-b.json
npx tsx scratch/full-game-movement/harness/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mode mock --output scratch/full-game-movement/harness/results/narrow-mutation-120-p100-t600-mock.json
python scratch/full-game-movement/harness/summarize.py
```

Final verification: **4/4 tests passed**; isolated TypeScript checking passed.

Raw evidence: [summary](results/summary.json), [determinism](results/determinism.json), [dense 1,000](results/dense-open-120-p1000-sync.json), [dense 2,000](results/dense-open-120-p2000-sync.json), [opposing 1,000](results/opposing-open-120-p1000-sync.json), [mixed 1,000](results/mixed-destinations-120-p1000-sync.json), [narrow 1,000](results/narrow-mutation-120-p1000-sync.json).

## Limitations

1. These are deterministic synthetic recorded maps/traces, not captured live matches. They exercise full movement and placement loops but not gather, combat, training, rendering, or the entire production session system set.
2. Terrain mutation is a harness-owned command over public layer arrays with correct revision bumps. Building addition is production placement; building destruction/navmesh-equivalent rebuild and terrain-restoration via a production edit command are not measured.
3. Only dense was run at 2,000. Other scenarios currently have 1,000-unit baselines and smaller smoke/determinism runs.
4. One run per large configuration is enough for a baseline, not robust timing distributions or a phase-2 trigger decision. Whole-tick maxima include JIT/GC/host outliers.
5. Synchronous response wall time is not concurrent worker turnaround. Mock delays are frame scripts, not measured worker latency. No real browser claim is made.
6. Scheduler snapshot bytes are measured, but snapshot-copy cost and real structured clone are not isolated. Apply timing includes callback instrumentation overhead.
7. Trace-linked awaiting-group state is exact; private per-unit awaiting-repath state is unavailable without a production telemetry seam. Final stalled/Parked states are cutoff classifications, not proof of permanent deadlock.
8. Runtime monkey-patching is deliberately isolated. A future production telemetry interface would be cleaner, but this task made no production edits.

## Evidence still required

### Flow field

Implement an actual candidate behind `MovementCandidateAdapter`, preserving exact-goal/group-slot behavior, revision invalidation, due-tick application, owner/medium views, and deterministic recovery. Add field-build/application/cache metrics through `candidateMetrics`; do not compare start-independent field cost directly with start-dependent A* LRU without equivalent group/cache semantics. Run all traces at 1,000 and 2,000 and compare completion, stalls/repaths, queue/apply cost, and replay hashes.

### Recast

Attach the real candidate to the same Activity/steering/collision loops, not isolated `updateCrowd`. Define exact-goal versus partial-path behavior, equivalent radii/speeds, capacity failure reporting, mutation acknowledgements/revisions, deterministic due-tick application, and cache semantics. Validate 2,000-agent and mutation-burst capacity, then run repeat/mock/browser replay equality. Different equal-cost geometry need not produce A*-identical paths, but each architecture must be internally replay-deterministic.

### Real browser workers

Implement `BrowserWorkerRunner` in a page using `createPathWorkerFactory` (`src/game/paths.ts:10-29`) and the production module worker. Use warmup plus multiple measured runs; retain raw per-request issue/response/apply timestamps and frame holds. Execute the matrix in `browser-runner.ts`: Chrome, Firefox, Safari on arm64 and x64. Compare real issue→response wall time against 33.3 ms, real path-apply main-thread cost against approximately 2 ms, and committed completion/replay results separately.

### Multi-architecture decision

Only after identical raw traces exist for current A*, flow field, and Recast should #167 rank architectures. The comparison must include activity completion/cutoff outcomes, repath/stuck/Parked classifications, queue and apply tails, mutation recovery/capacity, full-state replay equality, and browser worker behavior. The current baseline alone cannot establish a winner or prove either ADR phase-2 trigger.

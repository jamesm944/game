# Wayfinder #168 — destination-shared corridors with exact final slots

## Verdict

**The prototype fixes field churn and preserves exact-slot correctness, but does not deserve production-bound work in this form.** Across the identical 1,000-unit dense, mixed, and narrow/mutation traces it built only 4–11 fields with 99.976–99.991% cache hits, versus 32,879–45,812 builds and 15.47–36.08% hits for old flow. Dense and mixed exactly matched A* completions, request/repath counts, and final full-state hashes. Narrow completed eight more units than A* with 1,552 fewer repaths.

However, shared-corridor wall time was **2.9–9.8% slower than preserved A* on all three traces**, and mean/p95 tick time did not improve. Every successful corridor request still performs an explicit exact-slot A* suffix. The results justify rejecting this hybrid as a production optimization, not rejecting all destination-shared navigation. No 2,000-unit run was justified or attempted.

## Primary contracts and prior failure

- Production group movement issues one leader path, then deals exact formation-slot destinations (`src/sim/systems/movement.ts:445-452`, `src/sim/systems/movement.ts:599-681`). Members may reuse the leader corridor, but each final waypoint is replaced by that member's exact slot (`src/sim/systems/movement.ts:634-669`).
- Stall repaths request the current tile to the exact `MoveTarget`; application preserves the exact sub-tile destination (`src/sim/systems/movement.ts:869-956`). This is the source of old flow's per-slot field explosion.
- Production A* uses integer costs, no corner cutting, deterministic neighbors/heap ties, and returns exact raw cost with separately string-pulled waypoints (`src/sim/path/astar.ts:17-23`, `src/sim/path/astar.ts:45-53`, `src/sim/path/astar.ts:295-334`).
- The preserved benchmark executes real `World.step`, Activity queues, group/slot logic, steering/collision, scheduler due ticks, revisions, and mutations; it is not a complete production session and large runs have one timing sample (`docs/research/movement-architecture-full-game-benchmark.md:31-44`).
- Old flow lost because exact-slot repaths caused 32,879–45,812 builds and raw descent geometry changed congestion (`docs/research/movement-architecture-full-game-benchmark.md:67-82`; `scratch/full-game-movement/harness/flow-field-comparison.md:90-103`).

## Implementation

Files:

- `shared-corridor-candidate.ts` — route engine, inline adapter, and delayed/out-of-order mock adapter.
- `shared-corridor.test.ts` — seven correctness/replay tests.
- `run.ts` — isolated full-game runner importing the unchanged harness.
- `compare.py` — read-only pairing against preserved A*/old-flow JSON.
- `results/` — three raw 1,000-unit runs, three raw replay runs, and derived comparison JSON.
- `test-results.txt` — final strict TypeScript/Vitest evidence.

### Cache identity and route invariants

1. Exact goals map to fixed 24×24-tile regions. The cache key is **(region index, current passability revision)**; revision advance clears the LRU. Capacity is 32, enough for all 25 regions on a 120×120 map. Each region's canonical anchor is the passable tile nearest its clamped center, with row-major deterministic ties (`shared-corridor-candidate.ts:7-8`, `shared-corridor-candidate.ts:77-112`, `shared-corridor-candidate.ts:142-205`).
2. A single-goal reverse-Dijkstra field is built to that canonical anchor. It is **not** a multi-goal field and never designates the anchor as the requested endpoint.
3. The start→anchor route is scanned for the minimum of exact prefix cost plus admissible octile suffix estimate. Later equal-cost handoffs win so the corridor performs useful work (`shared-corridor-candidate.ts:208-236`).
4. Production `findPath` explicitly computes handoff→requested exact slot. Its search count/time is recorded as `localSearches`/`totalLocalSearchMs`; no hybrid A* work is hidden (`shared-corridor-candidate.ts:238-255`).
5. Prefix and suffix are composed and greedily string-pulled through production `hasLineOfSight`, preserving passability and no-corner-cutting. The last pair is overwritten with the original requested goal tile, never the anchor (`shared-corridor-candidate.ts:114-134`, `shared-corridor-candidate.ts:257-277`). Production repath then restores the exact floating slot offset as before.
6. If the canonical anchor is disconnected or the suffix fails, production A* runs from the original start to the original goal. These calls are separately counted/timed as `directFallbacks`/`fullAstarFallbackSearches`/`totalFallbackSearchMs`; null remains null (`shared-corridor-candidate.ts:280-300`).
7. Older snapshots build ephemerally and cannot reinsert stale fields or move the cache revision backward. Inline and delayed transports share the same route engine (`shared-corridor-candidate.ts:150-205`, `shared-corridor-candidate.ts:319-384`).

This sharing is semantic rather than workload-changing: scenario commands, request starts/goals, exact endpoints, passability snapshots, scheduler, and revision rules are unchanged. Region identity affects only internal corridor guidance; exact A* suffix/fallback preserves destination semantics. Dense/mixed matching A* request counts and final hashes is strong observed confirmation. Narrow's different legal geometry changes subsequent crowd evolution, so an A* hash match is not required there.

The composed route is guaranteed legal and exact-endpoint, **not globally cost-optimal**. A suffix can cost more than its octile estimate around obstacles. Worst-case request complexity remains A* plus corridor tracing; field construction is O(V log V) per missing region/revision. Cached field arrays remain 72,000 bytes each at 120×120, at most 2,304,000 bytes for 32 fields, excluding snapshots and route allocations.

## Correctness and determinism

Final command:

```sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution bundler --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --skipLibCheck --types node,vite/client \
  scratch/phase2-navigation/shared-flow/shared-corridor-candidate.ts \
  scratch/phase2-navigation/shared-flow/shared-corridor.test.ts \
  scratch/phase2-navigation/shared-flow/run.ts

./node_modules/.bin/vitest run \
  tests/path/astar.test.ts \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/harness/harness.test.ts \
  scratch/full-game-movement/harness/flow-integration/flow-integration.test.ts \
  scratch/phase2-navigation/shared-flow/shared-corridor.test.ts
```

Result: strict TypeScript exited 0; **5 files and 40/40 tests passed**, including all seven new tests. See `test-results.txt`.

New tests cover different exact goals sharing one field; exact endpoints and every pulled segment's line of sight; blocked goals; disconnected maps; disconnected canonical-anchor fallback; diagonal pinches and legal detours; revision invalidation; stale snapshot isolation; real `World.step` exact arrival; mutation recovery at tick 182; stale group cancellation; and repeated/delayed deterministic state.

The preserved 100-unit, 600-committed-tick replay A/B/mock artifacts have identical milestones, completions, units, diagnostics, applied/stale path records, and final hash `6947072dea89e2d9bf4d792930c7de81c61e718e3d37eaca755d8333cd891ba7`. Inline used 600 frames/zero blocked ticks; delayed mock used 816 frames/216 blocked ticks. Fourteen future-due pending requests had no delivered `ok` value in the mock; the derived comparison excludes only that unavailable pending-response field, while still comparing request identity, outcome, tick, and snapshot version. This is same-host Node/mock evidence, not browser or cross-platform proof.

## Full-game reproduction

```sh
./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario dense-open-120 --population 1000 --ticks 3600
./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario mixed-destinations-120 --population 1000 --ticks 3600
./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario narrow-mutation-120 --population 1000 --ticks 3600

./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --label replay-a
./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --label replay-b
./node_modules/.bin/tsx scratch/phase2-navigation/shared-flow/run.ts --scenario narrow-mutation-120 --population 100 --ticks 600 --mock --label replay-mock
python scratch/phase2-navigation/shared-flow/compare.py
```

The runner uses unchanged `runBenchmark`, scenarios, production scheduler/world/Activity/group/steering loops. A* and old-flow controls are the preserved harness artifacts, not rewritten or rerun here. All large configurations are 120×120, 1,000 units, 3,600 committed ticks, Node inline, Apple M1 arm64.

## Raw results

### Outcomes and tick/wall metrics

| Scenario | Candidate | Wall s | Completed / active | Repaths | Mean / p95 tick ms | Max tick ms |
|---|---|---:|---:|---:|---:|---:|
| Dense | A* | 24.340 | 528 / 472 | 46,288 | 6.134 / 9.460 | 210.795 |
| Dense | Old flow | 159.465 | 424 / 576 | 51,292 | 43.070 / 19.805 | 2,904.913 |
| Dense | Shared corridor | **26.737** | 528 / 472 | 46,288 | 6.621 / 12.828 | 153.786 |
| Mixed | A* | 19.257 | 571 / 429 | 46,799 | 4.783 / 7.486 | 187.184 |
| Mixed | Old flow | 124.403 | 494 / 506 | 51,431 | 33.276 / 17.617 | 2,588.904 |
| Mixed | Shared corridor | **19.822** | 571 / 429 | 46,799 | 4.790 / 8.758 | 254.623 |
| Narrow+mutation | A* | 24.965 | 487 / 513 | 53,705 | 6.324 / 12.185 | 255.020 |
| Narrow+mutation | Old flow | 178.587 | 347 / 653 | 54,191 | 48.632 / 121.286 | 2,574.011 |
| Narrow+mutation | Shared corridor | **27.342** | **495 / 505** | **52,153** | 6.945 / 14.621 | 108.318 |

Shared/A* wall ratios are 1.0985 dense, 1.0294 mixed, and 1.0952 narrow. Shared/old-flow wall ratios are 0.168, 0.159, and 0.153: the new design is dramatically better than old flow, but that is not sufficient for adoption. Narrow has 1,000 initial stale-cancelled records for every candidate; active-at-cutoff is not proof of permanent deadlock.

Dense and mixed shared-corridor final hashes equal preserved A*. Narrow differs, with eight more completions and 1,552 fewer repaths; this is a legal-geometry/crowd outcome, not evidence of a timing win. Narrow preserves revision sequence `0→1→5→6` and first revision-qualified recovery at tick 182.

### Sharing and explicit hybrid search costs

Hit rate is hits/(hits+misses), excluding stale ephemeral builds. Build, local-search, corridor-trace, and composition totals are candidate-measured milliseconds.

| Scenario | Builds old → shared | Shared hits / misses | Hit rate | Field build ms | Local A* searches / total ms | Full fallbacks | Corridor trace / compose ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dense | 40,358 → **4** | 46,285 / 4 | 99.9914% | 28.794 | 46,289 / 2,885.253 | 0 | 156.898 / 38.443 |
| Mixed | 32,879 → **11** | 46,796 / 11 | 99.9765% | 55.076 | 46,807 / 2,469.710 | 0 | 158.375 / 40.648 |
| Narrow | 45,812 → **5** | 52,152 / 5 | 99.9904% | 34.448 | 52,141 / 3,135.493 | 16 | 152.241 / 54.916 |

Build reduction versus old flow is 99.9901% dense, 99.9665% mixed, and 99.9891% narrow. Total path compute (including instrumented candidate work) versus A* was 3.297 s versus 4.120 s dense, 2.901 s versus 3.758 s mixed, and 3.595 s versus 3.605 s narrow. Those isolated savings did not become wall/tick wins in these single runs.

Narrow's 16 fallbacks are the 16 unreachable/no-path requests; local searches plus fallbacks equal all 52,157 requests. Dense/mixed local searches equal all requests. This explicit accounting prevents presenting the hybrid as field-only pathfinding.

### Scheduler, apply, queue, and response metrics

Issue→apply remained p50/p95/max = 2/2/2 ticks for applied inline paths. Blocked ticks and final queue behavior remain production scheduler behavior.

| Scenario | Candidate | Queue mean / max | Apply p95 / max ms | Issue→response p95 ms (Node, non-browser) |
|---|---|---:|---:|---:|
| Dense | A* | 25.716 / 1,000 | 0.00475 / 2.212 | 0.180 |
| Dense | Old flow | 28.496 / 1,000 | 0.00708 / 8.064 | 5.436 |
| Dense | Shared | 25.716 / 1,000 | 0.00538 / 22.676 | 0.125 |
| Mixed | A* | 26.003 / 1,000 | 0.00317 / 2.759 | 0.158 |
| Mixed | Old flow | 28.577 / 1,000 | 0.00762 / 5.032 | 4.854 |
| Mixed | Shared | 26.003 / 1,000 | 0.00383 / 2.591 | 0.105 |
| Narrow | A* | 29.837 / 915 | 0.00550 / 2.607 | 0.124 |
| Narrow | Old flow | 30.108 / 920 | 0.00704 / 1.376 | 5.439 |
| Narrow | Shared | 28.973 / 915 | 0.00583 / 6.846 | 0.122 |

The dense 22.676 ms apply maximum is a tail observation in one run; p95 remains small, but it is not evidence of meeting a broader replay budget distribution. No real browser response or structured-clone measurement was made.

## Raw artifact index

- `results/dense-open-120-p1000-t3600-shared-flow.json`
- `results/mixed-destinations-120-p1000-t3600-shared-flow.json`
- `results/narrow-mutation-120-p1000-t3600-shared-flow.json`
- `results/narrow-mutation-120-p100-t600-replay-a.json`
- `results/narrow-mutation-120-p100-t600-replay-b.json`
- `results/narrow-mutation-120-p100-t600-replay-mock.json`
- `results/shared-corridor-comparison.json` — derived metrics, deltas, hashes, replay validation, and explicit 2,000-unit unmeasured reason.

Preserved controls remain at `scratch/full-game-movement/harness/results/<scenario>-p1000-sync.json` and `<scenario>-p1000-flow.json`.

## Limitations and recommendation

1. One large run per candidate; preserved controls came from earlier same-host runs. Timing tails and the narrow completion delta need repeated warmed distributions before generalization.
2. No opposing 1,000-unit run was required for this bounded follow-up; dense, mixed, and narrow were the requested decisive traces. No browser worker, transfer, or cross-engine run was performed.
3. Every corridor request still invokes local A*. The design removes field churn, not per-request exact-route work; worst-case latency remains at least the A* control plus corridor overhead.
4. Fixed regions have boundary and anchor-connectivity effects. Fallbacks preserve correctness, but a poor anchor can eliminate sharing benefit or change route geometry.
5. Exact endpoints and legal gates are tested; globally optimal composed cost is not guaranteed. No dynamic/incremental field update is implemented.
6. Harness scope excludes combat, gathering, rendering, and a complete production session. Replay evidence is same-host Node plus scripted delivery only.

**Recommendation: do not promote this candidate.** Keep production A* as control. The useful research result is narrower: canonical region sharing can eliminate exact-slot field churn, and exact A* suffixes plus string pulling can restore dense/mixed behavior. A future prototype must also eliminate or substantially bound the per-request exact suffix work and demonstrate repeated full-game wall/tick/replay-budget improvements before production integration is reconsidered.

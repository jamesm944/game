# Recast/Detour evidence audit — Wayfinder #162

## Scope and verdict

Ticket: **#162, “Which navigation donor best survives crowd load and terrain mutation?”** The ticket asks for identical-map/trace comparisons, path latency, stuck count, completion time, crowd density, dynamic-obstacle cost, and deterministic replay evidence. This audit covers only the Recast/Detour donor and its Voidstrike integration; it does not claim a comparison with integer A*/flow fields or PathFinding.js.

**Verified conclusion:** Recast/Detour is credible evidence for elevated static connectivity and local TileCache obstacle rerouting in the tested Node.js environment. The focused existing tests pass, 25 repeated add/remove obstacle cycles rerouted and restored correctly, and synthetic crowd updates were inexpensive at the tested sizes. This is **not yet sufficient evidence to select the donor for the full game**: the real browser worker was not executed, dense tests bypassed Voidstrike's movement/flocking/fallback stack, capacity bookkeeping has a defect, and exact crowd state changed with insertion order and timestep.

**Determinism conclusion:** identical direct crowd runs matched exactly on one macOS arm64 Node.js process. Reversing agent insertion order changed final state, and splitting the same simulated duration into different timesteps changed final state. There is **no cross-browser or cross-platform determinism evidence** in this audit. The production asynchronous worker-to-game path result path also remains untested for replay determinism.

No production or other tracked files were modified. Scratch harnesses, logs, this report, and the separate upstream clone are the only created artifacts.

## Revisions and environment

- Voidstrike clone: `scratch/donor-audit/browser/voidstrike`
- Voidstrike commit: `4df0235116b78bf9232105486738e64b2e6905cb` (`2026-04-28T19:18:51+00:00`)
- Installed packages: `recast-navigation`, `@recast-navigation/generators`, and `@recast-navigation/three` **0.43.0** (`package.json:22-32`; `package-lock.json:1801-1826,7048-7056`)
- Host: macOS 14.6.1, Darwin 23.6.0, arm64
- Runtime: Node.js v24.21.0, npm 11.12.1; Vitest 4.0.18
- Upstream source-only clone: `scratch/donor-audit/navigation/recastnavigation`
- Upstream revision: `9f4ce64458dfae86e1239c525ddc219c4e9e06f1` (`v1.6.0-367-g9f4ce64`, `2026-02-27T02:16:52-05:00`)
- The upstream revision is useful for implementation limits and control flow, but it is **not proven to be the exact native source revision embedded in the 0.43.0 WASM binary**. Runtime results above come from the installed 0.43.0 package, not the upstream clone.

All commands below were run from `scratch/donor-audit/browser/voidstrike` unless stated otherwise. Vitest test and hook timeouts were explicitly 30,000 ms. The outer tool deadlines were 120 s for existing tests and 240 s for the stress harness. Timing results are single-run microbenchmarks, not statistically stable cross-machine benchmarks.

## Existing tests: exact commands and results

### Focused Recast obstacle/elevation/ramp/connectivity suites

```bash
/usr/bin/time -p npx vitest run \
  tests/engine/pathfinding/recastDynamicObstacleElevation.test.ts \
  tests/engine/pathfinding/recastRampConnectivity.test.ts \
  --testTimeout=30000 --hookTimeout=30000 --reporter=verbose \
  2>&1 | tee ../../navigation/focused-tests.log
```

Result: **PASS; exit 0**. Two files and five tests passed. Vitest duration 16.04 s; wall time 17.33 s.

| Existing case | Result | Test time |
|---|---:|---:|
| Elevated building reroute on Crystal Caverns | Pass | 1,367 ms |
| Synthetic editor-style ramp | Pass | 32 ms |
| Contested Frontier base exits over degenerate bundled ramps | Pass | 6,430 ms |
| Crystal Caverns and Titans Colosseum spawn-to-spawn routes | Pass | 6,100 ms |
| Scorched Basin and Void Assault local elevated moves | Pass | 2,650 ms |

Evidence boundaries:

- `recastDynamicObstacleElevation.test.ts:25-63` generates the actual `RecastNavigation` TileCache path, adds one elevated cylinder obstacle, and checks that a later **path query** reroutes. It does not add or move a crowd agent and does not test obstacle removal.
- `recastRampConnectivity.test.ts:17-91` uses `generateSoloNavMesh` plus `NavMeshQuery.findPath`/`findStraightPath`, checks `DT_PARTIAL_RESULT` is absent, and checks the final straight-path point is within one unit of the destination. These are path-query connectivity tests, not TileCache or `DetourCrowd` movement tests.
- The four map cases are selected routes, not exhaustive map connectivity, all-pairs spawn coverage, clearance tests for every unit radius, or terrain mutation tests.

Raw log: `scratch/donor-audit/navigation/focused-tests.log`.

### PathfindingSystem coordination tests

```bash
/usr/bin/time -p npx vitest run \
  tests/engine/systems/pathfindingSystem.test.ts \
  --testTimeout=30000 --hookTimeout=30000 --reporter=verbose \
  2>&1 | tee ../../navigation/pathfinding-system-tests.log
```

Result: **PASS; exit 0**. One file and 19 tests passed. Vitest duration 418 ms; wall time 1.21 s.

The first two tests exercise the real class with mocked worker objects: late obstacle replay (`pathfindingSystem.test.ts:25-113`) and elevated request heights (`:123-217`). No real `Worker`, WASM instance in a worker, asynchronous message timing, or worker/main result equivalence is exercised. Most remaining tests define local simplified queue/cache/stuck/clamp implementations inside the test file (`:220-468`), so they do not validate the production implementations of those behaviors.

Raw log: `scratch/donor-audit/navigation/pathfinding-system-tests.log`.

## Scratch stress harness: exact command and results

Harness: `scratch/donor-audit/navigation/recast-stress.ts`. It imports the unmodified donor integration. It creates synthetic flat navmeshes for capacity/crowd tests and uses Crystal Caverns for path and obstacle tests. No test file or production source was changed.

An initial invocation without donor root/config failed before running the harness because `@/utils/math` could not be resolved:

```bash
/usr/bin/time -p npx --no-install vite-node \
  ../../navigation/recast-stress.ts 2>&1 | tee ../../navigation/recast-stress.log
```

The corrected, successful final invocation was:

```bash
/usr/bin/time -p npx --no-install vite-node \
  --root . --config vitest.config.ts ../../navigation/recast-stress.ts \
  2>&1 | tee ../../navigation/recast-stress.log
```

Result: **completed; exit 0**. Wall time 11.58 s. Raw log: `scratch/donor-audit/navigation/recast-stress.log`.

### Capacity

| Probe | Observed result | Interpretation |
|---|---|---|
| Add 2,001 ground agents to one crowd | Requests 1–2,000 accepted; request 2,001 rejected; 28.33 ms total | The configured 2,000-agent hard capacity is real. |
| Wrapper count after the 2,001st request | `accepted=2000`, `rejected=1`, but `getAgentCount()=2001` | **Bookkeeping defect:** `RecastNavigation.addAgent` records an agent whenever the JS wrapper returns an object, even when its `agentIndex` is `-1` (`RecastNavigation.ts:1123-1129`). `getAgentCount` returns map size (`:1843-1848`), so it overcounts the failed insertion. |
| Add 513 obstacles to one TileCache | `getObstacleCount()=512`; 69.34 ms total | The configured 512-obstacle hard capacity is real. The 513th is not tracked. |

The capacity probes intentionally reuse a valid position/obstacle location to isolate allocation limits. They do not show that 2,000 densely moving agents or 512 geographically distributed obstacles perform adequately.

Relevant configured limits:

- 2,000 agents per constructed crowd and maximum radius 2.0 (`pathfinding.config.ts:164-179,218-221`). Ground and water have separate `Crowd` objects (`RecastNavigation.ts:355-359,576-580`). The comment's estimate of about 3,200 possible units (`pathfinding.config.ts:164-169`) exceeds one ground crowd's actual limit.
- 512 dynamic obstacles (`pathfinding.config.ts:102-105,189-200`), shared by buildings and qualifying decorations (`PathfindingSystem.ts:1125-1141,1280-1322`). There is no user-visible capacity error or telemetry result from `addObstacle`, which returns `void` (`RecastNavigation.ts:1653-1703`).
- At most 16 new path requests dispatched per frame (`PathfindingSystem.ts:28-30,946-960`) and 200 failed-path cache entries (`:37-39,933-944`). The pending worker-request map has no explicit size bound (`:207-216,971-988`).
- Upstream source has six neighbors per crowd agent (`DetourCrowd/Include/DetourCrowd.h:29-32`), a 256-polygon crowd path-result allocation (`DetourCrowd/Source/DetourCrowd.cpp:420-426`), 64 queued TileCache obstacle requests and 64 queued tile updates (`DetourTileCache/Include/DetourTileCache.h:241-250`), and at most eight touched tiles per obstacle (`:62-79`). These are structural upstream limits; the first three were not all independently stressed against the exact WASM build.

The stale capacity warning in `PathfindingMovement.ts:176-183` says “500 agents,” but the actual configured value is 2,000.

### Crystal Caverns path and dynamic-obstacle stress

The harness performs 25 add/query/remove/query cycles using the same elevated 5×5 building obstacle as the existing test, then issues 500 identical unobstructed path queries.

| Measurement | Result |
|---|---:|
| Successful reroutes | 25 / 25 |
| Exact restoration of the original path after removal | 25 / 25 |
| Cycle failures | 0 |
| Obstacle add + TileCache update, mean / p95 / max | 0.0968 / 0.1460 / 0.1530 ms |
| Obstacle remove + TileCache update, mean / p95 / max | 0.0482 / 0.0867 / 0.1063 ms |
| Identical short path queries found | 500 / 500 |
| Unique query result hashes | 1 |
| Path query mean / p95 / max | 0.0138 / 0.0230 / 1.0956 ms |

Scope: this is one short route `(39,39) → (59,39)` on one map, after warm-up, in one process. It is not a recorded-map/query corpus, a worker-latency measurement, a worst-case long-path benchmark, or evidence for multi-tile obstacle mutation cost. The direct path result SHA-256 was `99d45366510f0e1cf40a16c3ed7cb123cc4ac8fc52fcb0faa312198a00a5f920`.

### Synthetic DetourCrowd movement stress

The harness calls `RecastNavigation.addAgent`, `setAgentTarget`, `updateCrowd`, and `getAgentState` directly. It does **not** run `MovementOrchestrator`, worker path queries, unit physics pushing, JS/WASM boids, building avoidance, zero-velocity fallback, or arrival handling. “Arrived” means final distance ≤1.5 world units at the fixed cutoff. “Stuck at end” means distance >2 and final speed <0.01; it is not an all-time stuck counter.

| Scenario | Agents | Simulated steps | Arrived at cutoff | Stuck at end | Mean distance remaining | Crowd update mean / p95 / max |
|---|---:|---:|---:|---:|---:|---:|
| Dense parallel movement | 1,000 | 200 × 0.05 s = 10 s | 980 | 0 | 0.3981 | 1.366 / 3.286 / 5.046 ms |
| Opposing flows | 400 | 240 × 0.05 s = 12 s | 395 | 0 | 0.2406 | 0.510 / 0.878 / 3.418 ms |

Additional results: 1,000-agent registration took 5.76 ms and all 200 updates took 273.24 ms; 400-agent registration took 0.94 ms and all 240 updates took 122.52 ms.

These are encouraging isolated native/WASM crowd numbers, but neither scenario reached 100% arrival by its cutoff. They do not establish full-game completion time, frame cost, robustness in narrow terrain, long-term deadlock freedom, or 2,000-agent dense movement.

### Same-host determinism sensitivity

All determinism probes used 100 agents on a flat navmesh and hashed full floating-point state, sorted by entity ID.

| Comparison | Exact match? |
|---|---:|
| Two identical fresh runs, 120 × 0.05 s, per-tick trace hash | **Yes** |
| Same initial entity positions/targets but reverse insertion order, final state | **No** |
| 120 × 0.05 s versus 240 × 0.025 s (both 6 simulated seconds), final state | **No** |

Hashes:

- Identical run A/B trace: `9d3ba35d41af5c8e33d37063c8f0ee05f9ca5231cb19a20a8cc670ef8e70e652` for both.
- Normal insertion final: `c2b52f315d504c59ddde85e9344abfb10310f757f59f555c864295bb5c751498`.
- Reverse insertion final: `710e2b3f0bcfdb1a9a471a0e0f42bd7ffdbf8cb9f41f6f0d7d985533aa630fa1`.
- Fine timestep final: `c6259e7ab3fd98a3355a1b75c219cdeddb8d08d470589b0521ca5063934f859d`.

The current game loops normally use fixed updates (`GameLoop.ts:112-151`; `GameWorker.ts:805-835`), so timestep sensitivity is a robustness result, not proof that the normal configured loop varies its `dt`. Insertion-order sensitivity remains directly relevant if entity lifecycle/order is not identical on every peer. Neither result tests CPU/browser/WASM builds across platforms.

## Integration audit

### 1. Worker/main-thread split: two navmesh/query instances; crowd is outside the path worker

- `PathfindingSystem` creates an ES-module `pathfinding.worker.ts` and initializes its WASM separately (`PathfindingSystem.ts:207-216,230-261`). Ground queries use the worker only when it is ready; water/amphibious and worker-unavailable cases use the main-side `RecastNavigation` fallback (`:962-1000`).
- Initial geometry is generated once through the main-side `RecastNavigation.generateFromGeometry` (`:553-603`) and sent as geometry to the worker (`:300-320`). The worker independently calls `generateTileCache`/`generateSoloNavMesh` (`pathfinding.worker.ts:225-306`). Thus it is **not one navmesh shared across threads**; generation work and state are duplicated. The arrays are posted without a transfer list (`PathfindingSystem.ts:310-319`).
- The path worker imports `NavMesh`, `NavMeshQuery`, and `TileCache`, but not `Crowd` (`pathfinding.worker.ts:24-35`). `Crowd` lives in `RecastNavigation` and is updated from `MovementOrchestrator` on the game simulation side (`MovementOrchestrator.ts:398-419`; `RecastNavigation.ts:1446-1466`). Off-thread path queries therefore do not offload DetourCrowd movement.
- The game can itself run in `GameWorker`, which also initializes a navmesh (`GameWorker.ts:1603-1617`), while the renderer-side game can initialize another (`useWebGPURenderer.ts:545-565`). “Main thread” in this report means the `RecastNavigation` owner relative to `pathfinding.worker`, not necessarily the browser UI thread.
- Worker obstacle mutations have no acknowledgment/result messages (`pathfinding.worker.ts:722-735`), and the system's message handler only processes initialization, navmesh load, and path results (`PathfindingSystem.ts:267-298`). There is no obstacle failure or “worker is up to date” barrier.
- Worker path results are applied immediately when their message arrives (`PathfindingSystem.ts:294-296,364-425`), with no target-tick scheduling. Whether results arrive on the same simulation tick on every peer is not established.

### 2. Initial rebuild versus TileCache mutation

- Initial terrain geometry uses TileCache first, then a solo-navmesh fallback (`RecastNavigation.ts:450-527`). The worker duplicates that policy (`pathfinding.worker.ts:257-305`). The solo fallback has no dynamic-obstacle support and logs that limitation (`RecastNavigation.ts:480-525`).
- Building placement/destruction adds/removes obstacles on both independent navmesh owners (`PathfindingSystem.ts:674-715`). `TileCache.update(navMesh)` rebuilds affected tiles; the game does not regenerate the whole navmesh per building (`RecastNavigation.ts:1653-1703,1770-1800`; upstream `DetourTileCache.cpp:523-592`).
- Each mutation calls at most eight TileCache updates and stops early if `upToDate` (`RecastNavigation.ts:240-250`; worker `pathfinding.worker.ts:341-350`). The wrapper does not return or log a still-pending state after eight iterations. Small tested obstacles converged; a large multi-tile mutation/backlog remains unverified.
- Imported navmeshes in the path worker explicitly set `tileCache=null`; the source notes that TileCache state is not serialized (`pathfinding.worker.ts:188-218`). Pre-exported static data is therefore not equivalent to runtime TileCache generation for destructible buildings.
- No production terrain-deformation rebuild path or dynamic terrain mutation benchmark was found or tested. Existing ramp tests rebuild fresh solo meshes from static terrain; they do not mutate a live TileCache terrain surface.

### 3. Path queries are not DetourCrowd movement

- `findPath` projects start/end with `findClosestPoint`, calls `computePath`, drops Y altitude to 2D waypoints, and applies custom sampled-line smoothing (`RecastNavigation.ts:609-680,788-852`). The ramp suite similarly exercises `NavMeshQuery.findPath`/`findStraightPath` directly.
- `DetourCrowd` instead receives an on-mesh agent and target, maintains a corridor, and produces velocity/position over repeated updates (`RecastNavigation.ts:1081-1136,1160-1223,1360-1466`; upstream `DetourCrowd.cpp:1046-1063,1098-1135,1178-1210,1314-1321`). A successful `NavMeshQuery` path says nothing by itself about crowd completion, local congestion, or actual unit arrival.
- The movement stack consumes crowd velocity but adds separate arrival spreading and other flocking forces (`MovementOrchestrator.ts:1086-1201`), applies a direct fallback if crowd velocity is zero (`:1099-1144`), and separately accelerates unit state (`:1045-1064`). Isolated crowd timings therefore cannot be presented as full movement timings.

### 4. Avoidance configuration is narrower than high-level comments imply

`DEFAULT_AGENT_PARAMS` sets `updateFlags: 0x1` and `separationWeight: 0`, explicitly enabling only `DT_CROWD_ANTICIPATE_TURNS` and disabling obstacle avoidance (`RecastNavigation.ts:41-57`). Upstream flags confirm obstacle avoidance, separation, and topology/visibility optimization are distinct bits (`DetourCrowd/Include/DetourCrowd.h:182-192`).

Consequences:

- Detour's sampled obstacle-avoidance velocity planning is off; desired velocity is used directly (`DetourCrowd.cpp:1257-1311`).
- Detour separation and topology/visibility optimization flags are off, although corridor following, neighbor collection, and iterative agent collision resolution still run (`:1064-1096,1323-1399`).
- `obstacleAvoidanceType: 0` selects parameter slot zero; it is the absent `DT_CROWD_OBSTACLE_AVOIDANCE` update flag that disables the velocity planner. Setting type zero alone would not prove avoidance is disabled.
- Voidstrike's own physics/flocking/building fallback remains part of effective crowd behavior. Claims such as “DetourCrowd for RVO-based collision avoidance” in file headers do not describe the actual enabled flag set.

### 5. Floating point and determinism assumptions

- Native crowd positions, desired/actual velocities, displacements, targets, radii, and `dt` are floats (`DetourCrowd/Include/DetourCrowd.h:74-100,114-171`; `DetourCrowd.cpp:1046`). The integration reads those positions/velocities directly (`RecastNavigation.ts:1378-1411`).
- Voidstrike's quantized/integer-square-root helpers are used for selected distances and game-side steering (`DeterministicMath.ts:108-132,196-213,291-318`), but they do not quantize Recast generation, path search, crowd integration, or collision resolution. The worker uses ordinary `distance` from `utils/math` for its smoothing (`pathfinding.worker.ts:33,405-483`), unlike the main-side deterministic distance import (`RecastNavigation.ts:27-30`).
- The installed library README explicitly says variable timestep produces non-deterministic behavior and documents fixed-step options (`node_modules/recast-navigation/README.md:267-310`). Fixed stepping is necessary but not sufficient: the scratch insertion-order result and async worker application show additional unresolved ordering risks.
- The upstream corridor documentation itself acknowledges floating-point errors and locomotion inaccuracies (`DetourCrowd/Source/DetourPathCorridor.cpp:180`). No source or test inspected here supplies a cross-platform bitwise determinism guarantee.

## What is verified versus still unresolved

### Verified

1. The selected existing elevated/ramp/connectivity tests pass at the recorded donor revision.
2. One elevated Crystal Caverns obstacle reroutes path queries; 25 repeated cycles all rerouted and exactly restored the original path after removal.
3. The configured limits of 2,000 agents per crowd and 512 obstacles per TileCache are enforced in the installed WASM runtime.
4. The 2,001st agent exposes an integration bookkeeping error: returned index `-1` is still inserted into `agentMap`, inflating `getAgentCount`.
5. Isolated synthetic crowd updates completed at the measured costs; 980/1,000 and 395/400 agents met the chosen arrival threshold at the respective cutoffs.
6. Identical same-process direct crowd runs were exactly repeatable; insertion-order and timestep variants were not.
7. The path worker handles queries and TileCache obstacles, not crowd simulation. Main-side and worker navmeshes are independently generated and mutated.

### Unresolved crowd questions

1. What are full-game latency, stuck count, and completion time under identical recorded maps/traces for Recast versus integer A*/flow fields and PathFinding.js? This audit did not run those donors or the complete Voidstrike movement loop.
2. Can the actual game finish dense commands in narrow ramps, doorways, elevated bases, and around multiple simultaneous building mutations without deadlock or excessive fallback movement?
3. What happens at 2,000 actively moving ground agents, at mixed ground/water totals, and when agent 2,001 or obstacle 513 is encountered during play? Capacity rejection currently lacks a robust public result/telemetry path.
4. Does the main/worker duplication produce identical paths for a broad recorded corpus, including partial routes, elevated overlapping layers, large radii, fallback solo meshes, and obstacle-update timing?
5. How quickly do worker obstacle updates become visible to queued queries, and can stale worker/main states diverge? There is no mutation acknowledgment or revision number.
6. Do large obstacles touching many tiles or bursts of mutations ever remain pending after the eight-update cap? What is worst-case rebuild latency across real maps?
7. How much of effective avoidance comes from Detour corridor/collision handling versus Voidstrike's JS/WASM flocking, physics pushing, and direct zero-velocity fallback? Those components need ablation benchmarks, not comments or isolated `Crowd.update()` numbers.
8. What are browser main-thread and worker frame timings under Safari/Firefox/Chrome, including WASM initialization and duplicated navmesh generation? Node.js measurements do not answer this.

### Unresolved determinism questions

1. Can two peers produce the same full-game state hash when worker path results are scheduled by asynchronous message arrival rather than a deterministic target tick?
2. Is entity insertion/removal order guaranteed identical across peers and replay restore? The direct crowd final state changed when only insertion order changed.
3. Do all gameplay paths use fixed simulation `dt` in every runtime mode, including initialization, catch-up, replay, and fallback? Current loops are fixed-step, but all integration modes were not exercised.
4. Do identical paths, crowd traces, and full-game replay hashes hold across arm64/x64, operating systems, browsers, and WASM builds? No such evidence was produced; do not infer it from same-host repeatability or quantized helper math.
5. Should replay record authoritative paths and/or crowd state instead of relying on independent asynchronous query timing? This needs a design decision and a replay test corpus.

## Recommended evidence gate before revisiting ADR-0003

1. Build a read-only benchmark runner around the real game loop and real browser path worker; replay identical recorded maps and commands for all three donor candidates.
2. Log per-tick path dispatch/result ticks, queue depth, mutation revisions, agent capacity failures, actual full-game stuck count, completion time, and full-state replay hashes.
3. Include at least 1,000 and 2,000 moving ground agents, opposing flows, narrow elevated connections, repeated construction/destruction, and a >512-obstacle scenario.
4. Repeat on at least two CPU architectures and Chrome/Firefox/Safari before making any cross-platform determinism claim. Until then, describe determinism only as same-environment repeatability with the exact scope recorded above.

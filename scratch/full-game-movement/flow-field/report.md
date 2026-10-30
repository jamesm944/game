# Deterministic flow-field candidate — Wayfinder #167

## Scope and verdict

This directory contains a real, reusable TypeScript flow-field candidate and isolated validation. It is suitable for a follow-up integration/full-game benchmark; it is **not** evidence that flow fields already win the full game, browser frame budget, or crowded steering workload.

In the recorded Node microbenchmark, eight cold fields plus 256 O(1) queries beat 256 individual A* searches by 1.94× (open), 16.75× (maze), and 3.30× (choke). Eight cumulative mutation revisions still favored fields by 1.92×, 23.54×, and 2.24× respectively. These ratios cover the stated synthetic shared-destination workload only. Production currently issues one leader search per move-order group, not one search per Pop (`src/sim/systems/movement.ts:4-20`; `docs/adr/0003-unit-movement-and-pathfinding.md:7-12`).

## Production contract read before design

- Production A* is `src/sim/path/astar.ts`. Its public `findPath` result exposes an exact optimal **raw-path** integer cost and separately string-pulled waypoints (`src/sim/path/astar.ts:45-53`, `src/sim/path/astar.ts:295-305`). The candidate therefore compares integration and raw traced-route costs, never pulled-polyline length.
- Straight and diagonal costs are 1000 and 1414; the eight clockwise directions begin at east (`src/sim/path/astar.ts:17-23`). Diagonal movement requires both adjacent orthogonal tiles to be passable (`src/sim/path/astar.ts:310-323`). The candidate pins the same constants, order, binary passability, and corner rule (`flow-field.ts:9-17`, `flow-field.ts:253-274`, `flow-field.ts:279-305`).
- A* heap ties use `(f, insertionCounter)` (`src/sim/path/astar.ts:55-108`). Reverse Dijkstra has no heuristic and ties on `(integrationCost, insertionCounter)` (`flow-field.ts:41-95`).
- ADR-0003 phase 2 calls for fields per unique destination, keyed by `(goalTile, passabilityVersion)`, when group-search cost becomes a measured problem (`docs/adr/0003-unit-movement-and-pathfinding.md:9-12`). Version bumps drop cached artifacts, and stale responses must not be applied (`docs/adr/0003-unit-movement-and-pathfinding.md:60-62`). The scratch cache follows that snapshot/revision model.
- The permanent steering layer supplies separation, push-apart, impassable clamping, and the movement FSM (`docs/adr/0003-unit-movement-and-pathfinding.md:54-58`; `src/sim/systems/movement.ts:9-20`). A direction field does not replace it.

## Files and API

- `flow-field.ts` — candidate implementation, with no production imports.
- `flow-field.test.ts` — 11 Vitest correctness tests.
- `benchmark.ts` — deterministic Node microbenchmark and pre-timing A* cost validation.
- `benchmark-methodology.md` — exact workload, normalization, and interpretation.
- `benchmark-results.json` — raw samples, normalized metrics, tile lists, configuration, and host/runtime metadata.
- `test-results.txt` — captured final test run.
- `report.md` — this report.

Public API (`flow-field.ts:19-39`, `flow-field.ts:142-228`, `flow-field.ts:314-386`):

```ts
buildFlowField({ passability, width, goals, revision? }): FlowField
field.costAt(x, y): number                 // FLOW_UNREACHABLE if no route
field.directionAt(x, y): number            // 0..7, -1 unreachable, -2 goal
field.traceRoute(x, y): FlowRoute | null   // raw Int32 tile indices + cost

new FlowFieldCache(passability, width, revision?, maxEntries?)
cache.getField(goals): FlowField
cache.updatePassability(snapshot, strictlyGreaterRevision): void
```

Goals are deduplicated and sorted in row-major order, so caller order and duplicates cannot alter output or cache identity. Passable goals seed cost zero; blocked goals are ignored. If every goal is blocked, the field consistently reports every tile unreachable. A goal tile has zero cost and `FLOW_AT_GOAL` direction. `traceRoute` follows strict cost descent and includes the reached goal.

### Algorithm and complexity

For `V = width × height`, `E ≤ 8V`, and `G` requested goals:

1. Reverse Dijkstra seeds every passable goal at zero and relaxes legal reverse edges with integer costs (`flow-field.ts:228-275`). Time is `O((V + E) log V)`, conventionally `O(V log V)` on this bounded-degree grid; field storage is `O(V)`, with transient heap storage also `O(V)` in the worst case. No integration-cost floating point is used.
2. Direction extraction scans tiles in row-major order and chooses the first clockwise neighbor satisfying exact cost descent (`flow-field.ts:277-305`). This is `O(V)` and avoids dependence on heap tie order. The same no-corner-cutting test is repeated here so an equal-cost coincidence cannot select an illegal diagonal.
3. `costAt` and `directionAt` are O(1). `traceRoute` is O(route tiles) time and allocation. Each stored field has one Int32 integration entry and one Int8 direction entry per tile, approximately `5V` bytes before goals/object overhead: about 72,000 bytes per 120×120 field, excluding transient construction allocations.
4. Cache lookup canonicalizes goals in `O(G log G)`, then uses a deterministic LRU. A hit avoids field construction; a miss adds `O(V log V)`. Revision update copies the `O(V)` snapshot and clears all cached fields. The default capacity is 32. In-place mutation without `updatePassability` is intentionally not observable; the caller must advance the revision.

This is rebuild-on-revision behavior, not an incremental dynamic shortest-path algorithm. It is appropriate for benchmarking repeated shared destinations; frequent global rebuilds may erase its advantage.

## Correctness validation

Run from the repository root:

```sh
./node_modules/.bin/vitest run scratch/full-game-movement/flow-field/flow-field.test.ts
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution bundler --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --skipLibCheck --types node \
  scratch/full-game-movement/flow-field/flow-field.ts \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/flow-field/benchmark.ts
```

Final result: **1 test file passed, 11 tests passed, 0 failed**; captured in `test-results.txt`. Strict standalone TypeScript checking exited 0. The scratch directory is outside the repository's normal `tsconfig.json` include set (`tsconfig.json:19`), hence the explicit file list.

Coverage includes:

- Exact raw route and integration cost equality against production `findPath` for every start on four hand-built grids, including blocked and disconnected starts (`flow-field.test.ts:88-115`).
- Exact 1000/1414 constants, zero-cost goal behavior, unreachable cells, all-blocked goals, and no diagonal corner cutting (`flow-field.test.ts:117-142`).
- Multiple destinations, duplicate/order canonicalization, deterministic nearest-goal ties, and blocked members of goal sets (`flow-field.test.ts:144-176`).
- Byte-equal integration/direction arrays across repeated builds and reversed goal order (`flow-field.test.ts:170-176`).
- Cache reuse, LRU eviction, immutable stale results, snapshot copying, opening and blocking mutations, and rejection of non-increasing revisions (`flow-field.test.ts:179-233`).
- Two 120×120 maps (open and deterministic obstacles), with 160 deterministic probe starts per map checked against A* and each flow route checked for legal walkable descent (`flow-field.test.ts:236-276`).
- Independently, the benchmark checks all 256 assigned pairs on each of its three maps for exact A* cost equality before timing (`benchmark.ts:282-301`).

## Microbenchmark results

Reproduce with:

```sh
./node_modules/.bin/tsx scratch/full-game-movement/flow-field/benchmark.ts
```

Recorded environment: Node v24.21.0, macOS arm64, Apple M1, eight logical CPUs. Nine measured rounds followed two warm-ups. Cached query batches ran 100 repetitions/sample and raw-route batches ten; all other operations ran once/sample. Numbers below are means of batch-normalized results, rounded for readability. Full raw samples and operation definitions are in `benchmark-results.json` and `benchmark-methodology.md`.

| Map | 256 A* searches (ms) | Build 8 fields (ms) | Cold 8 fields + 256 queries (ms) | Cold ratio A*/flow | Cached 256 cost+direction queries (ms) | Cached 256 raw routes (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Open | 48.805 | 23.752 | 25.122 | 1.94× | 0.00547 | 0.386 |
| Maze | 214.967 | 10.324 | 12.834 | 16.75× | 0.00156 | 1.103 |
| Choke | 74.098 | 21.359 | 22.422 | 3.30× | 0.00296 | 0.430 |

Average construction per destination was 2.969 ms open, 1.291 ms maze, and 2.670 ms choke. Cached cost+direction lookup cost per agent was 21.4 ns open, 6.11 ns maze, and 11.6 ns choke in this JIT-warm harness; these tiny values should be treated as relative implementation data, not portable latency guarantees.

| Map | Flow: 8 revisions × (rebuild 8 + query 256) (ms) | A*: 8 revisions × 256 searches (ms) | Mutation ratio A*/flow |
|---|---:|---:|---:|
| Open | 208.805 | 400.587 | 1.92× |
| Maze | 83.913 | 1975.656 | 23.54× |
| Choke | 222.508 | 498.368 | 2.24× |

Map generation is defined at `benchmark.ts:72-143`; agents/goals at `benchmark.ts:145-161`; measurement and warm-ups at `benchmark.ts:183-205`; A* and flow operations at `benchmark.ts:208-280`; JSON environment/configuration capture at `benchmark.ts:351-379`.

### Interpretation limits

- Cold A* includes production string-pulling; cold flow includes integration, direction extraction, and O(1) lookups but no route extraction. The separate raw-route row measures allocation and full path following, still without string-pulling. Cached direction lookup versus a complete A* call is intentionally an amortization comparison, not equivalent work per call.
- The 256-A* baseline deliberately measures repeated searches to shared destinations. It does not reproduce production's one-leader-per-group optimization or formation-slot reuse.
- These are synchronous Node numbers. There is no browser JIT/cross-worker transfer, scheduler latency, due-tick behavior, rendering contention, or full-tick measurement.
- No agents physically move in the benchmark. It says nothing about conga lines, local avoidance, formation behavior, stall/repath rates, or crowd quality.

## Integration work still required

1. Add a worker request/response variant for goal sets and typed integration/direction arrays, with deterministic IDs and due-tick application. Preserve the existing FIFO/stale-version protocol; do not apply responses merely on arrival (`docs/adr/0003-unit-movement-and-pathfinding.md:14-44`).
2. Define ownership and lifetime of the revision-keyed LRU across worker and sim snapshots. Bound memory by destination count and measure transfers versus constructing fields inside the worker.
3. Adapt movement activities to follow raw directions or convert them into suitable waypoints. Decide whether to retain smoothing/string-pulling and how to validate the next segment against live passability. Current movement consumes continuous pulled waypoints (`src/sim/systems/movement.ts:618-679`, `src/sim/systems/movement.ts:1361-1520`).
4. Preserve formation slots, individual repaths, separation/push-apart, stall sidesteps, and arrival behavior. Multi-goal fields may help slots/work slots, but destination assignment and exact arrival semantics need explicit design.
5. Add integration golden tests through the real scheduler/worker, then run deterministic full-game crowd/flow benchmarks. Measure per-tick application cost, turnaround under mass orders, rebuild frequency, memory, and crowd quality before choosing an architecture.

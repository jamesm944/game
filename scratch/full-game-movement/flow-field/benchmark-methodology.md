# Flow-field microbenchmark methodology

## Reproduction

From the repository root, with the repository's existing dependencies:

```sh
./node_modules/.bin/tsx scratch/full-game-movement/flow-field/benchmark.ts
```

The script overwrites `benchmark-results.json` in this directory. Use `--rounds N` to change the nine measured rounds; two unrecorded warm-up rounds are fixed. Timing is synchronous and serial in Node with `performance.now()`. No packages are installed and no browser or game loop is started.

## Workload

- Maps are deterministic 120×120 binary grids: fully open; an odd-coordinate recursive-backtracker maze with deterministic extra openings; and a choke map with vertical walls at x=40/80, gaps every 24 rows, and a horizontal wall at y=60 with periodic gaps.
- Each case has 256 agents and eight shared single-tile destinations. Agent assignment cycles through destinations in stable order. Exact tile lists and map walkable counts are preserved in the JSON.
- Before timing, every agent/destination pair is checked for exact cost equality between production `findPath` and the corresponding field. A mismatch aborts the run.
- `astar_per_agent_256`: one production A* call per agent, including its existing string-pulling. This is a library comparison for repeated shared-destination work, not a model of the current group-leader policy.
- `flow_build_8_fields`: eight complete reverse-Dijkstra integrations and direction extractions.
- `flow_cold_build_8_and_query_256`: those eight builds plus one cost and direction lookup per agent.
- `flow_cached_cost_direction_query_256`: prebuilt fields, one `costAt` and one `directionAt` per agent. Each timed sample repeats the batch 100 times to reduce timer noise.
- `flow_cached_raw_route_256`: prebuilt fields, one allocating raw tile route trace per agent. Each sample repeats the batch ten times. This is closer to A* route construction, but still has no string-pulling.
- Mutation cases apply eight cumulative, deterministic single-tile toggles. Flow timing includes snapshot copying, revision-keyed cache invalidation, eight destination rebuilds per revision, and 256 queries per revision. A* timing runs all 256 searches on each snapshot. Tile indices are recorded in JSON.

## Result interpretation

Each operation stores all raw sample totals in milliseconds. `batchMeanMs` divides by batch repetitions (100 for cached queries, ten for route traces, one otherwise); `perAgentMeanNs` additionally divides by the number of agent queries/searches in the batch. Speedup ratios in `report.md` use unrounded `batchMeanMs` values.

The recorded environment is Node v24.21.0 on arm64 macOS, Apple M1, eight logical CPUs, 16 GiB memory. Results are sensitive to runtime, CPU, load, and JIT state. This harness provides no full-game, browser, worker-protocol, crowd, steering, memory-bandwidth, or multi-tick latency evidence.

# Wayfinder #169 — real Chrome Recast browser-worker transport

## Decision

**The real browser-worker baseline is implemented and semantically validated on Chrome arm64. Keep production integer A\*; do not promote Recast yet.** Actual Recast/Detour 0.43.0 WASM ran in a Vite-built module Worker through the unchanged production scheduler and full-game `World.step` loops. Both requested 1,000-unit / 3,600-tick traces completed. Every returned route, logical replay surface, and final full-state hash matched the corrected Node Recast candidate. The remaining blockers are performance and transport ownership: the initial dense leader response was 174.8 ms with a 169.1 ms full rebuild, repath response p95 was 70.4 ms dense / 33.5 ms narrow, and full per-request snapshots transferred 666.6 MB / 764.6 MB. These are single full-scale samples with route-capture instrumentation, not timing distributions.

## Implementation and primary-code citations

- [`recast.worker.ts`](recast.worker.ts) initializes `@recast-navigation/core` asynchronously inside the worker, posts an explicit readiness message, queues request handling behind that one initialization promise, and reports initialization/request failures. It returns real worker compute timings and final engine counters.
- [`worker-adapter.ts`](worker-adapter.ts) constructs `new Worker(new URL("./recast.worker.ts", import.meta.url), { type: "module" })`. Event handlers are installed at construction, before awaiting readiness, so an early ready/error event cannot be lost. A 30-second readiness timeout and per-frame fatal-error check fail deterministically rather than hanging the simulation.
- [`recast-engine.ts`](recast-engine.ts) is the corrected baseline engine body unchanged outside browser imports. It uses `findClosestPoint` → `findPath` → `findStraightPath`, rejects `DT_PARTIAL_RESULT`, enforces endpoint tolerance, and generates with `cs=0.25`, `walkableRadius=0`. The artifact parity test compares the complete engine body against the preserved baseline. [Corrected baseline](../../phase2-navigation/recast-corridor/corridor-engine.ts).
- Conversion imports the corrected continuous-segment supercover + production-LOS string pull directly; there is no A* planner fallback and no partial-path acceptance. [Conversion](../../phase2-navigation/recast-corridor/corridor-grid.ts), [production LOS](../../../src/sim/path/astar.ts).
- Mutations are explicitly labeled **full `generateTileCache` rebuilds from exact passability snapshots**. No incremental implementation or unfinished file from another agent is used.
- [`browser-main.ts`](browser-main.ts) awaits worker readiness before each run, invokes the existing asynchronous benchmark, and captures each response route for exact Node comparison. [Existing async runner](../../full-game-movement/harness/browser/full-game/async-runner.ts), [production movement](../../../src/sim/systems/movement.ts).
- Production request IDs, snapshot copying, due ticks, ascending-ID application, blocked ticks, and stale-revision discard remain in the unchanged scheduler. [Scheduler](../../../src/sim/path/scheduler.ts), [protocol](../../../src/sim/path/protocol.ts), [instrumentation](../../full-game-movement/harness/instrumentation.ts). Production Activity/group continuation, steering, and collision are therefore the real loops, not DetourCrowd substitutes.
- [`vite.config.ts`](vite.config.ts) resolves the existing 0.43.0 donor dependencies without modifying them and sets `worker.format="es"`. The production artifact contains a 46.28 kB worker chunk and a 727.10 kB wasm-compat chunk. Packaging is provenance only.

## Environment and executed coverage

Host: Apple M1, 8 logical CPUs, 16 GiB, macOS arm64 (`darwin 23.6.0`), Node 24.21.0. Browser: **headless Google Chrome 156.0.8078.47, arm64 host**, automated by Playwright. All reported smoke/full-game measurements used the **Vite production build**, not Node or a mocked transport. No Firefox, Safari, WebKit, or x64 test was run and no such claim is made.

WASM provenance: all four Recast packages report 0.43.0; `@recast-navigation/wasm/dist/recast-navigation.wasm.wasm` is 339,385 bytes, SHA-256 `6fe3c90073fb734bd98eb0a38daec269552aa8564f639ec458219d72d09c6bc9`. Browser and Node comparison runs used the same hash. Raw metadata is embedded in every result.

Executed:

1. Production-artifact Chrome smoke: async WASM ready + actual one-tile-gate Detour query, exact route `[0,4,11,4]`.
2. Narrow/mutation, 40 units / 400 ticks, **two** fresh worker samples: 199 requests each; repeated logical results and full-state hashes equal.
3. Dense, 1,000 units / 3,600 ticks: 46,289 requests; completed in 4,096 frames.
4. Narrow/mutation, 1,000 units / 3,600 ticks: 53,098 requests; completed in 3,755 frames.
5. Matching corrected Node Recast route-capture runs for all three configurations.
6. Strict TypeScript, four artifact tests, production Vite build, and derived comparison/protocol validation.

## Correctness and replay validation

[`compare.mjs`](compare.mjs) checks Chrome/arm64 metadata, identical WASM hash, every ordered route record (`id`, `ok`, `cost`, every `Int16` waypoint), the existing logical replay surface, final full-state hashes, and preserved corrected-Node logical results. It also validates monotonic request IDs, `dueTick=issueTick+2`, 14,400-byte snapshots, and two-tick application. **Zero protocol violations occurred.**

| Trace | Exact route streams | Logical + full state vs Node | Final full-state SHA-256 |
|---|---:|---|---|
| Narrow 40 / 400, both samples | 199 / 199 each | Equal | `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f` |
| Dense 1,000 / 3,600 | 46,289 / 46,289 | Equal | `3bebb849de0d8e623875dfa594d13629e7468e5524fedcdc56f87cb32d1f1038` |
| Narrow 1,000 / 3,600 | 53,098 / 53,098 | Equal | `9b81f04fbfb6a91a836f486bcce365e5f2aad6ec6f07b44795a565697df230dc` |

Fresh Node route-capture runs also matched the preserved corrected Node large-result logical surfaces. This is observed same-candidate replay on one host with identical route/WASM outputs, not a general cross-architecture determinism claim. Delivery timing changed frames and blocked counts without changing committed state.

Dense completed 528 units with 472 active and zero failed responses. Narrow completed 500 with 500 active, 16 failed responses (the preserved impassable-endpoint cases), and 1,000 stale-cancelled activity records. Both full runs had zero geometry rejections, partial paths, endpoint-projection rejects, native-query failures, navmesh-generation failures, path-capacity failures, and snapshot mismatches. The one-tile-gate smoke passed exactly. [Derived validation](results/comparison-validation.json).

## Chrome measurements

Response is main-thread issue→worker-response wall time; worker compute is measured inside the worker. Leader p95 is only the maximum of 1 dense or 4 narrow correlated orders, not a robust tail estimate. Apply p95 below Chrome's 0.1 ms timer resolution is displayed as 0. Queue is mean / max / final. Snapshot totals count request payload bytes, not a claim about unique bytes retained.

| Metric | Dense 1,000 / 3,600 | Narrow + mutation 1,000 / 3,600 |
|---|---:|---:|
| Wall s | 37.583 | 35.866 |
| Frames / blocked frames | 4,096 / 496 | 3,755 / 155 |
| Leader response p50 / p95 / max ms | 174.8 / 174.8 / 174.8 | 126.0 / 158.7 / 158.7 |
| Repath response p50 / p95 / max ms | 28.0 / **70.4** / 95.8 | 2.4 / **33.5** / 77.0 |
| Repath worker compute p95 / max ms | 0.2 / 12.2 | 0.2 / 6.7 |
| Production apply p95 / max ms | 0.0 / 2.4 | 0.0 / 1.1 |
| Queue mean / max / final | 58.789 / 1,000 / 2 | 34.316 / 915 / 12 |
| Snapshot bytes | **666,561,600** | **764,611,200** |
| WASM initialization ms | 53.3 | 48.0 |
| Revision builds / total / max ms | 1 / 169.1 / 169.1 | 2 / 280.5 / 155.4 |
| Native queries / total / max ms | 46,205 / 1,032.6 / 12.2 | 53,051 / 1,355.8 / 6.5 |
| Route conversions / total / max ms | 46,205 / 227.5 / 3.0 | 53,051 / 246.1 / 2.5 |
| Response waypoint bytes | 369,976 | 600,116 |
| Completed / active | 528 / 472 | 500 / 500 |
| Repaths | 46,288 | 53,094 |

The large gap between end-to-end repath response and worker compute shows that queueing/main-thread scheduling remains material. Full revision generation is directly exposed in initial leader latency. Apply tails remain visible even though p95 is below timer resolution.

For the repeated short trace, sample wall times were 3.092 / 2.353 s, blocked frames 72 / 66, repath response p95 5.9 / 3.1 ms, and both retained identical routes/logical/full-state results. Its first sample had an 864.5 ms leader maximum during cold rebuild activity; with only four leader requests this is an observed outlier, not a distribution estimate.

## Exact commands

Run from repository root:

```sh
npx tsc -p scratch/navigation-protocol/recast-browser/tsconfig.json
npx vitest run --config scratch/navigation-protocol/recast-browser/vitest.config.ts
npx vite build --config scratch/navigation-protocol/recast-browser/vite.config.ts
node scratch/navigation-protocol/recast-browser/run-browser.mjs --smoke --built --name smoke-built-final

node scratch/navigation-protocol/recast-browser/run-browser.mjs --built --scenario narrow-mutation-120 --population 40 --ticks 400 --samples 2 --name recast-mutation-p40-t400-replay
node scratch/navigation-protocol/recast-browser/run-browser.mjs --built --scenario dense-open-120 --population 1000 --ticks 3600 --samples 1 --name recast-dense-p1000-t3600
node scratch/navigation-protocol/recast-browser/run-browser.mjs --built --scenario narrow-mutation-120 --population 1000 --ticks 3600 --samples 1 --name recast-narrow-mutation-p1000-t3600

npx tsx scratch/navigation-protocol/recast-browser/run-node.ts --scenario narrow-mutation-120 --population 40 --ticks 400 --name node-recast-mutation-p40-t400
npx tsx scratch/navigation-protocol/recast-browser/run-node.ts --scenario dense-open-120 --population 1000 --ticks 3600 --name node-recast-dense-p1000-t3600
npx tsx scratch/navigation-protocol/recast-browser/run-node.ts --scenario narrow-mutation-120 --population 1000 --ticks 3600 --name node-recast-narrow-mutation-p1000-t3600
node scratch/navigation-protocol/recast-browser/compare.mjs
```

## Raw evidence

- [Built Chrome smoke](results/chrome-smoke-built-final.json)
- [Repeated short Chrome mutation](results/chrome-recast-mutation-p40-t400-replay.json), [matching Node](results/node-recast-mutation-p40-t400.json)
- [Full Chrome dense](results/chrome-recast-dense-p1000-t3600.json), [matching Node](results/node-recast-dense-p1000-t3600.json)
- [Full Chrome narrow/mutation](results/chrome-recast-narrow-mutation-p1000-t3600.json), [matching Node](results/node-recast-narrow-mutation-p1000-t3600.json)
- [Comparison and validation](results/comparison-validation.json)

## Integration errors found and resolved

The initial Vite build failed with `Invalid value "iife" for option "worker.format" - UMD and IIFE output formats are not supported for code-splitting builds`; setting ES-module worker output resolved it. The first built smoke then exposed a readiness race because the adapter installed `onmessage` only after awaiting readiness; it timed out after 30,000 ms. Moving handler installation to worker construction fixed the race, and the final built smoke plus all full-game runs passed. The exact timeout is preserved in [`chrome-smoke-built-retry-error.json`](results/chrome-smoke-built-retry-error.json). A development-server diagnostic was abandoned after Vite reloaded on result-file writes; all reported measurements therefore use the production build. There is no unresolved WASM/browser blocker.

## Limitations and production recommendation

1. One full-scale sample per scenario is insufficient for latency distributions or promotion. Dense has only one initial leader request and narrow four. No warmups were used for the full-scale samples.
2. Route capture copies every waypoint array on the main thread before response instrumentation; it adds measurement overhead. Timings are real for this instrumented build but are not an uninstrumented production estimate. Node route-capture wall times are for validation, not clean performance comparisons.
3. Snapshot payload remains one 14,400-byte copy/structured clone per request. This baseline does not test shared snapshots or delta transport.
4. Mutation handling remains full revision rebuild, not acknowledged incremental TileCache updates. Burst/destruction/>512-obstacle/multi-tile behavior is outside this run.
5. Conservative supercover is not a completeness proof for every float corridor. Zero observed rejects clears these traces only.
6. Only Chrome arm64 was executed. No Firefox/Safari/x64, alternate WASM build, or 2,000-unit claim is made.

**Recommendation:** retain A* as production default. Treat this as the validated real-browser Recast baseline, but optimize versioned snapshot ownership and full-rebuild/queue latency, then repeat uninstrumented and instrumented multi-sample dense/narrow/2,000-unit distributions before reconsidering adoption. No production, existing harness/result, donor, package, issue, or commit files were changed.

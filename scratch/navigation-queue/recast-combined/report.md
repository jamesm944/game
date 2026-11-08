# NEW Wayfinder #170 — combined Recast candidate report

## Verdict

**Node-only correctness prototype; not a completed #170 integration and not ready for production adoption.**

The new `CombinedRecastEngine` passed the narrow-mutation Node parity gate against corrected full-rebuild Recast: **199/199 path responses matched exactly** by request ID, status, cost, and waypoint array, and the 400-tick final full-state hash matched. The revision-6 build reused 221 unchanged compressed layers and re-rasterized four touched nav tiles, with zero geometry rejections and zero obstacle operations.

The versioned full/delta worker transport, real module-WASM worker adapter, asynchronous snapshot runner, browser route recording, production Vite artifact, stress matrix, and real-Chrome validation were **not completed**. Consequently this report makes no worker, browser, cross-browser, CPU, throughput, latency-distribution, or production-scheduler-interface claim. No 1,000-unit/3,600-tick benchmark was run, because the required integrated candidate does not exist yet.

## Authoritative implementation and evidence

- Candidate engine: `combined-engine.ts`.
- Exact compressed-layer builder: `exact-tile-cache.ts`.
- Corridor conversion: `corridor-grid.ts` (continuous supercover plus production LOS string pulling; no A* planner).
- Node parity runner: `verify-parity.ts`.
- Final parity result: `results/combined-parity-p40-t400.json`.
- Untouched-#169 fallback diagnostic: `diagnose-original.ts` and `results/original-169-geometry-diagnosis-p40-t400.json`.
- Mesh probe: `results/mesh-diagnosis.json`.
- Experimental route-parity diagnosis: `results/parity-diagnosis.json`.

The copied `incremental-engine.ts`, `incremental-candidate.ts`, `tile-cache-state.ts`, `run.ts`, and `diagnose.ts` are experimental legacy material, not the combined candidate entry point. In particular, `run.ts` still targets the old #169 output namespace and was not used or modernized. `results/geometry-diagnosis-p40-t400.json` is from that modified experimental copy and is **not** evidence for the untouched #169 failure.

## Geometry diagnosis

The two original geometry failures were request **1**, revision **0**, and request **3**, revision **6**, both from `(47,42)` to `(80,60)`. The current untouched #169 engine detects both bad corridors and performs guarded full-rebuild fallbacks; its final routes therefore match corrected full Recast despite two geometry rejections. This fallback behavior and the exact request IDs are recorded in `results/original-169-geometry-diagnosis-p40-t400.json`.

The failing incremental straight corridor was:

```text
(47.5,42.5) -> (56,48) -> (72,56) -> (80.5,60.5)
```

The `(56,48) -> (72,56)` segment crosses blocked wall cell `(60,50)`. The mesh probe found that incremental nav tile `(7,6)` had one four-vertex polygon and one triangle covering `(60.5,50.5)`. Corrected full rebuild had two polygons/eight vertices and no covering triangle. Thus the defect was stale or uncarved TileCache geometry around the long thin obstacle, not an overly strict supercover rejection. See `results/mesh-diagnosis.json`.

Two attempted alternatives were rejected as parity strategies: splitting obstacle rectangles at nav-tile boundaries and seeding from an exact full base before obstacle deltas both changed legal routes/final state. The preserved experimental comparison also shows that equal `ok` outcomes are insufficient: for example, request 5 at revision 6 chose waypoint `x=55` incrementally versus `x=56` in corrected full Recast. That experiment compared 201 requests and ended with hash `3de9c3046b020f77c1b1acb7bd3957bebf32555d7b9060fcd5872eaaa0d26f15`, not the corrected hash. See `results/parity-diagnosis.json`.

## Combined strategy

`buildExactTileCache` diffs exact passability snapshots, identifies touched 8×8-world-unit nav tiles (`tileSize=32`, `cs=0.25`), deletes only those tiles' compressed layers, and re-rasterizes them from the new exact snapshot. Unchanged compressed layers are retained byte-for-byte. Layers are then added and navmesh tiles built in the same deterministic order as the donor full generator.

The query path preserves the corrected corridor gates: `walkableRadius=0`, exact endpoint tolerance `0.05`, closest-point checks, no partial paths, path/straight-path capacity checks, final endpoint verification, continuous supercover conversion, and production LOS string pulling. No dynamic obstacles, crowd model, A* fallback, or approximate route repair is used.

The engine keeps an LRU of two immutable revisions. Cache misses for newer revisions build from the latest snapshot; older or same-version/different-byte requests use ephemeral exact builds. Those race branches are implemented but were not exercised by focused tests in this validation.

This is **incremental rasterization**, not a fully incremental navmesh container update. Every revision still regenerates passability geometry and chunky-triangle input, creates a fresh TileCache/NavMesh, copies/adds all compressed layers, builds all navmesh tiles, and performs the initial cache update. Native lifecycle and allocator behavior beyond this run have not been audited.

## Executed validation

Commands were run from `/Users/jamesmoss/Documents/game`.

### Final strict TypeScript check

```sh
npx tsc -p scratch/navigation-queue/recast-combined/tsconfig.json
```

Final result: **passed**, no output/errors. Earlier compile failures in the new builder (untyped donor ESM entries and API/signature mismatches) were fixed before this pass.

### Untouched #169 fallback diagnosis

```sh
npx tsx scratch/navigation-queue/recast-combined/diagnose-original.ts
```

Result: 199 compared responses, zero final route mismatches after #169's guarded fallback, and exactly two geometry fallback events at IDs 1 and 3. Final hash: `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f`. Raw result: `results/original-169-geometry-diagnosis-p40-t400.json`.

### Combined Node parity gate

```sh
npx tsx scratch/navigation-queue/recast-combined/verify-parity.ts
```

Scenario: `narrow-mutation-120`, population 40, 400 ticks, Node inline evidence only.

| Check | Result |
|---|---:|
| Responses compared | 199 |
| Exact route mismatches | 0 |
| Expected final full-state hash | `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f` |
| Actual final full-state hash | `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f` |
| Revision builds | 2 (1 initial, 1 incremental) |
| Revision-cache hits / misses | 197 / 2 |
| Peak revision entries | 2 |
| Mutation changed cells | 16 |
| Initial rasterized nav tiles | 225 |
| Revision-6 rasterized nav tiles | 4 |
| Reused compressed layers at revision 6 | 221 |
| Geometry rejections | 0 |
| Partial paths rejected | 0 |
| Endpoint projections rejected | 0 |
| Native query failures | 0 |
| Dynamic obstacle adds/removes | 0 / 0 |
| Navmesh generation failures | 0 |

The run also recorded response waypoint bytes (2,588), compressed layer bytes (29,555), path/conversion counts, and single-run timings in `results/combined-parity-p40-t400.json`. Those timings are diagnostic instrumentation from one sample, **not a benchmark or distribution**, and support no speed claim.

Development failures were not hidden: the first parity attempt initialized a different Node Recast module instance and failed before any comparison with `Cannot read properties of undefined (reading 'RecastBuildContextJsImpl')`. After adding explicit combined-module initialization, the next attempt failed before comparison with `tile add failed at 0,6,0`; correcting TileCache's ownership of added `TileCacheData` led to the passing run above. Neither failed run was used for performance evidence.

## Coverage not achieved

- No versioned full/delta snapshot protocol/store/worker handler was integrated with the combined engine.
- No async snapshot scheduler adapter or main-cache `slice()` shim was added; therefore there is no validated production scheduler transport interface here.
- No real Chrome module-WASM worker, readiness/error handling, Vite production build, built-worker smoke test, or browser route/logical replay was produced.
- No worker post/main-delivery timing, transfer-byte accounting, queue timing, leader-versus-repath telemetry, or browser comparison was collected.
- No focused automated tests were completed for one-tile gates, 104×104 multi-tile mutations, 576 isolated blocked cells, cache eviction, stale/out-of-order/same-version races, delayed delivery, or native failure injection.
- No mutation stress matrix, Node A* comparison, 1,000-unit/3,600-tick Chrome narrow run, dense run, or statistical performance comparison was run.
- Only the narrow p40/t400 full-state hash was checked. No separate logical-state hash field exists in the harness result used here, so no independent logical-hash claim is made.
- No production files, packages, issues, commits, donor clones, old harnesses, or old result directories were modified.

## Recommendation

Do **not** treat this directory as a finished #170 candidate or integrate it into production yet. The exact-tile strategy is supported by one meaningful Node correctness gate and directly addresses the diagnosed stale geometry, but the required transport/browser/replay/stress evidence is absent. The next valid step is to wire this engine behind the acknowledged two-revision full/delta protocol with focused race/capacity tests, then require exact Node and real-Chrome route/replay parity before any scale or performance run.

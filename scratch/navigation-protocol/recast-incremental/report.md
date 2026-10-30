# Wayfinder #169: revisioned incremental TileCache mutations

## Recommendation

**Retain production integer A*. Keep this candidate as the Recast mutation research baseline; do not adopt it yet.**

The isolated candidate implements acknowledged incremental TileCache mutations and matches the corrected full-rebuild Recast candidate on the narrow mutation trace and replay. In one Node-inline 1,000-unit run it was 4.03% faster than corrected full-rebuild Recast by wall time, but still 19.41% slower than preserved A*. Two route-geometry validation failures still required exact full-Recast meshes, so this is not yet a fully incremental or production-bound result. This follows the phase-2 direction to add revisioned TileCache updates while preserving A* and the existing harness. [Phase-2 research](../../../docs/research/phase2-navigation-optimization.md#L95-L100)

All new implementation, tests, commands, and generated evidence are confined to `scratch/navigation-protocol/recast-incremental/`. Production code, prior candidates, and preserved results were not modified.

## Implementation and safety contract

The starting point is the corrected supercover corridor candidate, including its continuous-segment supercover conversion, production line-of-sight string pulling, endpoint gates, and lack of an A* planner fallback. [Corridor adapter](corridor-grid.ts) [Incremental engine](incremental-engine.ts#L254-L370)

The mutation implementation has these properties:

- It generates an all-walkable base mesh, then computes a deterministic greedy rectangle cover of **every** blocked cell. Adding or removing those boxes therefore restores the actual binary base geometry on reopen; it does not treat arbitrary terrain as merely an obstacle annotation. [Tile-cache state](tile-cache-state.ts#L64-L121) [Mesh construction](tile-cache-state.ts#L256-L293)
- Each newer revision computes sorted rectangle removals and additions, queues at most 32 requests before a drain, and calls `update(navMesh)` until `upToDate`. Only a completely successful drain commits the snapshot bytes and visible revision. [Revision barrier](tile-cache-state.ts#L139-L253)
- The installed TileCache API documents a maximum of 64 queued obstacle requests, up to 64 touched tiles per update, and an `upToDate` result that must be checked before assuming completion. The candidate deliberately stays below the request-queue limit with 32-request batches. [TileCache API](../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/tile-cache.d.ts#L53-L107)
- The configured live-obstacle capacity is 512. Add/update failure destroys invalid incremental state and selects an exact full-Recast rebuild; failure is counted rather than hidden. [Generation configuration](tile-cache-state.ts#L12-L26) [Guarded acquisition](incremental-engine.ts#L185-L251)
- Every unsuccessful incremental route query is checked against an exact full-Recast mesh. A false no-path promotes that exact mesh for the current revision while retaining the acknowledged incremental ancestor, allowing a later revision to apply a real delta. A confirmed no-path discards the temporary fallback. No A* planner fallback exists. [Query guard](incremental-engine.ts#L147-L182)
- Out-of-order requests and same-version/different-bytes requests use ephemeral exact rebuilds. The latest entry plus a retained incremental ancestor have a measured peak of two cache entries. [Revision acquisition](incremental-engine.ts#L185-L251)
- Instrumentation covers revision barriers and visibility, changed cells, requested touched nav tiles, update calls/drains, obstacle requests and live counts, cache snapshots, query/conversion costs, and each fallback category. [Metrics](incremental-engine.ts#L22-L110) [Runtime snapshot](incremental-engine.ts#L372-L395)

This is a binary, flat-passability implementation. It does not claim arbitrary heightfield or topology mutation support.

## Validation

### Automated checks

Final strict TypeScript and all six relevant suites passed: **6 files, 40/40 tests**. The focused incremental suite has 7 tests, including multi-tile drain acknowledgement, a third large-obstacle reopen revision after fallback, >512 live obstacles, stale cancellation, due-tick recovery, exact gate visibility, and delayed/out-of-order replay. [Incremental tests](incremental.test.ts)

```sh
npx tsc -p scratch/navigation-protocol/recast-incremental/tsconfig.json
npx vitest run \
  scratch/full-game-movement/flow-field/flow-field.test.ts \
  scratch/full-game-movement/harness/harness.test.ts \
  scratch/full-game-movement/harness/flow-integration/flow-integration.test.ts \
  scratch/full-game-movement/recast-integration/recast-integration.test.ts \
  scratch/phase2-navigation/recast-corridor/corridor.test.ts \
  scratch/navigation-protocol/recast-incremental/incremental.test.ts \
  --testTimeout=30000 --hookTimeout=30000
```

### Comparison validator

`compare.py` reads the preserved A* and corrected Recast artifacts without rewriting them. It validates identical scenario definitions and map hashes, 1,000 unique units and crowd rows, 3,600 committed ticks/frames, unique request IDs, 14,400-byte snapshots, and two-tick applied-path latency. It compares logical state while excluding timing and pending-response transport metadata. It explicitly does **not** require cross-architecture A*/Recast hashes. [Comparison script](compare.py) [Validated comparison](results/incremental-comparison.json)

The incremental and corrected Recast narrow runs have identical logical state, final world digest, and final full-state hash:

```text
9b81f04fbfb6a91a836f486bcce365e5f2aad6ec6f07b44795a565697df230dc
```

A* remains a different logical architecture on this trace: 487 completions versus 500 and final hash `f464e6b5623762912687c852432c00180945b16c6dd821e9be54882b3d422966`. That difference is reported, not treated as a failed cross-architecture hash assertion.

## Narrow mutation, population 1,000

All rows are single Node-inline runs over the same 120×120 scenario, 3,600 ticks/frames, with 1,000 stale cancellations and zero blocked ticks. [Preserved A* raw result](../../full-game-movement/harness/results/narrow-mutation-120-p1000-sync.json) [Corrected Recast raw result](../../phase2-navigation/recast-corridor/results/narrow-mutation-120-p1000-corridor.json) [Incremental raw result](results/narrow-mutation-120-p1000-incremental.json)

| Candidate | Wall s | Mean / p95 tick ms | Max tick ms | Completed / active | Requests / repaths | Failed responses |
|---|---:|---:|---:|---:|---:|---:|
| Preserved integer A* | **24.964908** | **6.323562 / 12.184958** | 255.020417 | 487 / 513 | 53,709 / 53,705 | 16 |
| Corrected full-rebuild Recast | 31.062398 | 7.911299 / 15.565084 | **181.559167** | **500 / 500** | 53,098 / 53,094 | 16 |
| Incremental TileCache Recast | 29.810450 | 7.605187 / **14.094583** | 293.317291 | **500 / 500** | 53,098 / 53,094 | 16 |

The incremental run's wall-time change was **−4.0304% versus corrected Recast** and **+19.4094% versus A***. These are descriptive ratios from one large run each, not statistically robust timing distributions.

Additional scheduler and response costs are preserved in the comparison artifact:

| Candidate | Apply p95 / max ms | Response p95 / max ms | Queue mean / max / final |
|---|---:|---:|---:|
| Preserved integer A* | 0.005500 / 2.607375 | 0.123675 / 12.698750 | 29.836944 / 915 / 10 |
| Corrected full-rebuild Recast | 0.008875 / 7.607417 | 0.155340 / 164.759167 | 29.497500 / 915 / 12 |
| Incremental TileCache Recast | 0.007292 / 3.040041 | 0.181512 / 278.708000 | 29.497500 / 915 / 12 |

### Proof of a real acknowledged mutation

The narrow run did not merely rename full rebuilds:

- Two incremental revision barriers completed; the last acknowledged revision was **6**, with zero revision-visibility failures.
- Changed cells totaled **132 = 116 initial blocked cells + one real 16-cell revision-6 delta**.
- Six box obstacles were added, 19 nav-tile touches were requested in total (maximum 15 per revision), and 20 update calls formed two drains (maximum 16 calls per revision).
- Total measured incremental update time was **2.668041 ms**.
- Peak cache occupancy was two entries, and peak live obstacles was six.

There were also **two geometry-validation fallbacks**. They caused two exact full-Recast rebuilds (`revisionBuilds=3`, `mutationRebuilds=2`) and **392.453251 ms** total full-build time. Corrected Recast used two total builds and 273.798792 ms. Thus the narrow wall-time improvement cannot be attributed to eliminating all rebuild work. [Narrow metrics](results/narrow-mutation-120-p1000-incremental.json) [Comparison metrics](results/incremental-comparison.json)

The two `geometryRejections` were rejected internal incremental attempts that triggered exact Recast retries; they were not additional final failed responses. Final failed responses remained the same 16 impassable-endpoint cases as corrected Recast and A*. `unreachableRoutes=18` includes those two internal attempts. Query and conversion totals were 1,162.635296 ms and 281.201645 ms respectively, versus 1,244.090337 ms and 328.171074 ms for corrected Recast.

The harness disposes the candidate before serializing final metrics. Consequently final `visibleRevision=-1`, `revisionCacheEntries=0`, and `snapshotCacheBytes=0` are disposed-runtime values; cumulative counters and `peakRevisionCacheEntries=2` remain valid. `snapshotCacheBytes` counts retained JavaScript passability arrays, not native WASM memory.

### Replay and delayed transport

Two synchronous repeats and one delayed mock-transport run all committed tick 600, issued 1,049 requests and 1,045 repaths, and matched corrected Recast logical state and full-state hash:

```text
c43dd03ccbb699c05faa336e85e00610e0be55d927a20136e3647efbe1804b17
```

Frames were **600 / 600 / 806** and blocked ticks **0 / 0 / 206**. Delayed transport therefore changed scheduling, not committed logical state. [Replay A](results/narrow-mutation-120-p100-t600-incremental-a.json) [Replay B](results/narrow-mutation-120-p100-t600-incremental-b.json) [Delayed mock replay](results/narrow-mutation-120-p100-t600-incremental-mock.json)

## Mutation capacity and queue stress

Every stress revision asserts equal `ok` outcomes between incremental and exact full-rebuild Recast. Waypoint equality was not required. Stress metadata records Node v24.21.0 on darwin/arm64. [Stress runner](stress.ts) [Stress raw result](results/mutation-stress.json)

“Touched tiles” below means requested touches derived from the changed rectangles, not an undocumented native internal counter. Timings are single-run wall measurements.

| Case | Revisions | Wall ms | Update calls (max/revision) | Requested touched tiles, total (max/revision) | Guard/fallback outcome |
|---|---:|---:|---:|---:|---|
| Repeated one-tile gate close/reopen | 20 | 78.282 | 80 (4) | 40 (2) | 10 confirmed-unreachable exact validations; 0 geometry/capacity failures |
| Building add/remove | 3 | 49.982 | 8 (4) | 2 (1) | 0 fallbacks |
| Five-rectangle burst | 3 | 481.454 | 40 (20) | 10 (5) | 0 fallbacks |
| Large 104×104 obstacle | 3 | 418.399 | 16 (8) | 338 (169) | 1 geometry fallback; later reopen incremental and acknowledged |
| 576 isolated obstacle requests | 1 attempted | 522.422 | 132 (132) | 36 (36) | 1 capacity failure and 1 exact full-rebuild fallback |

The large-obstacle case proves both multi-tile draining and retained-ancestor behavior: the exact fallback serves the problematic revision, then revision 2 applies a subsequent reopen delta to the retained incremental ancestor and acknowledges revision 2. [Large-obstacle test](incremental.test.ts)

The capacity case reaches **512 live obstacles** and fails on the attempted **513th live obstacle**. It uses 32-request drains, so this is the configured live-obstacle capacity rather than the API's 64-request queue limit. The failed incremental revision is not acknowledged; visible revision 0 is served by the exact fallback. No capacity or update failure is reported as success.

## Reproduction commands

Run from the repository root:

```sh
npx tsx scratch/navigation-protocol/recast-incremental/run.ts \
  --scenario narrow-mutation-120 --population 1000 --mode sync \
  --output scratch/navigation-protocol/recast-incremental/results/narrow-mutation-120-p1000-incremental.json

npx tsx scratch/navigation-protocol/recast-incremental/run.ts \
  --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync \
  --output scratch/navigation-protocol/recast-incremental/results/narrow-mutation-120-p100-t600-incremental-a.json

npx tsx scratch/navigation-protocol/recast-incremental/run.ts \
  --scenario narrow-mutation-120 --population 100 --ticks 600 --mode sync \
  --output scratch/navigation-protocol/recast-incremental/results/narrow-mutation-120-p100-t600-incremental-b.json

npx tsx scratch/navigation-protocol/recast-incremental/run.ts \
  --scenario narrow-mutation-120 --population 100 --ticks 600 --mode mock \
  --output scratch/navigation-protocol/recast-incremental/results/narrow-mutation-120-p100-t600-incremental-mock.json

npx tsx scratch/navigation-protocol/recast-incremental/stress.ts
python scratch/navigation-protocol/recast-incremental/compare.py
```

## Limitations and next evidence required

1. **Not fully incremental on the measured trace.** Two narrow geometry failures still promoted exact full meshes; repeated unreachable gate queries also require exact no-path validation. Eliminate or sharply bound these fallbacks before adoption.
2. **Timing evidence is not a distribution.** The 1,000-unit and stress figures are single runs. No confidence interval, variance, or robust performance claim is made.
3. **No browser or cross-platform evidence.** There is no real browser-worker, independent-WASM, or x64 run. Results must not be extrapolated to those environments.
4. **Binary flat geometry only.** Box-cover mutations preserve this protocol's flat passability semantics. Arbitrary heights, slopes, off-mesh topology, or layered geometry require exact tile/geometry update support and new correctness tests.
5. **Native memory is unmeasured.** JavaScript snapshot bytes and before/after heap values do not measure native WASM navmesh/TileCache ownership or establish leak safety.
6. **Snapshot transport remains unchanged.** Every request still carries a 14,400-byte passability snapshot. This ticket does not implement the separate shared-snapshot/delta transport optimization.
7. **Stress equality is narrow.** Stress requires route-outcome equality, not identical waypoints. Full logical-state equality is established for the narrow full-game trace and replay, not for every possible mutation sequence.
8. **Dense regression was not rerun.** The preserved dense scenario has no mutations and was not useful for isolating this ticket's mutation behavior; this is not a new dense performance claim.

The next useful engineering step is to diagnose the two supercover/geometry false no-path cases and remove those exact full-mesh promotions, then repeat distributions before investing in browser-worker validation.

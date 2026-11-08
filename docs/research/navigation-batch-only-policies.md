# Batch-only navigation policies and integrated Recast correctness

Wayfinder: **“Which batch-only navigation worker policy reduces queueing without priority regressions?”** (#171)

## Decision

**Advance batch-only 32 as the challenger; retain versioned FIFO as the current production control. Reject batch-only 8, 16, and 64 for this trace. Do not use leader priority or request-class reordering.**

Four rotated, interleaved, same-session real-Chrome samples per policy show that batch 32 improved leader response p95, repath response p95, and blocked frames against the same-iteration FIFO control **4/4 times**. Every batch-32 run kept leader p95 below the 33.3 ms budget. This is a repeated response win, not a uniform performance win: repath p50 worsened, wall time improved in only 1/4 runs, and mean wall time increased about 1%.

Batch 32 therefore earns renderer-paced production-workload validation, not immediate adoption. The clean snapshot-handle/provider API remains the required production seam; the scratch `Uint8Array.slice()` compatibility adaptation must not be productionized. Current A* remains the production pathfinder.

The combined exact-tile Recast candidate also passed its integrated narrow correctness gate behind a real Vite-built module-WASM worker. It is now eligible for a separate full-scale performance study, but this ticket makes no Recast performance or production-adoption claim.

## Evidence and independent verification

This record consolidates:

1. [Batch-only A* policy study](../../scratch/navigation-batch-only/report.md)
2. [Integrated combined Recast correctness checkpoint](../../scratch/navigation-queue/recast-combined/report-171.md)

Independent verification passed:

- production and experiment strict TypeScript;
- **46/46** batch/provider/coalescing/A*/engine/scheduler/full-game tests;
- **20/20** real-Chrome full-game logical/final-hash/application-timing replay comparisons;
- integrated Recast strict TypeScript and **8/8** focused tests;
- original and delayed integrated Node Replay: **199/199 exact routes**;
- built-worker real-Chrome replay: **199/199 exact routes**, logical/final-hash equality, zero protocol violations;
- Recast mutation stress: **30/30 exact responses across 5/5 cases**;
- Vite production build and built-worker one-tile Chrome smoke.

Coverage remains headless Chrome arm64 and Node/mock. No non-Chrome, x64, or independent-WASM performance evidence was collected.

## Batch-only policy contract

The five compared policies are:

- **FIFO:** immediate one-request messages in transport arrival order.
- **Batch 8/16/32/64:** collect one synchronous flush, require strictly increasing request IDs, and split without sorting or class-based reordering. Every batch preserves request order and due ticks; worker results contain individual responses in the same order.

The production scheduler remains the response authority: missing due responses block, responses apply in ascending ID order, duplicates are safe, and stale revisions discard. Snapshot registration/update remains ordered before dependent requests. Production A* and its 32-entry LRU are unchanged.

A compute-coalescing compatibility key is the exact tuple:

`(requester groupKey, snapshotId, snapshot revision, plane, dueTick, startX, startY, goalX, goalY, seed, requestClass)`

Known leader commands receive `order:<stable order ID>`. The existing seam exposes no safe shared repath identity, so each repath receives `unshared-repath:<request ID>`; missing metadata receives unique `unknown:<request ID>`. Unknown or incompatible requests never share.

Across all 20 measured full-game runs, **eligible = 0 and coalesced = 0**. No full-game deduplication speedup is claimed. Focused tests prove legal identical-key sharing and rejection for different groups, endpoints, seeds, due ticks, classes, and unknown keys.

## Chrome method

Environment: headless Chrome 156.0.8078.47, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0.

Each policy used a fresh page with one 400-tick warmup worker followed by a fresh measured worker. Every measured run executed the real mixed `p1000/t3600` trace: eight initial leaders, **46,807 requests**, 46,799 repaths, and 3,600 committed ticks. Diagnostic probes ran afterward on another fresh worker.

Four same-session rotations were measured:

1. FIFO → 8 → 16 → 32 → 64
2. 8 → 16 → 32 → 64 → FIFO
3. 16 → 32 → 64 → FIFO → 8
4. 32 → 64 → FIFO → 8 → 16

A superseded partial attempt with full-length warmups hit its command timeout and is preserved but excluded. All reported samples share the same 400-tick warmup and full-length measured trace.

Response is main-thread issue→worker-response. Queue is post-to-worker-receipt diagnostic telemetry; compute is production `engine.handle`. Per-run leader distributions have n=8; pooled leader n=32. Pooled repath n=187,196 per policy.

## Per-iteration headline results

Milliseconds except wall seconds. Lower is better. These rows, not pooled tails alone, drive selection.

| Policy / iteration | Leader response p95 | Repath response p95 | Wall s | Blocked frames |
|---|---:|---:|---:|---:|
| FIFO 1 | 22.0 | 113.3 | 31.678 | 786 |
| FIFO 2 | 24.6 | 111.9 | 31.873 | 786 |
| FIFO 3 | 23.3 | 112.3 | 31.278 | 775 |
| FIFO 4 | 32.4 | 113.6 | 31.975 | 799 |
| Batch 8 / 1 | 67.2 | 144.9 | 34.028 | 815 |
| Batch 8 / 2 | 39.9 | 108.1 | 33.385 | 637 |
| Batch 8 / 3 | 27.7 | 105.2 | 31.952 | 657 |
| Batch 8 / 4 | 21.3 | 109.1 | 32.229 | 665 |
| Batch 16 / 1 | 22.8 | 114.9 | 32.960 | 689 |
| Batch 16 / 2 | 27.3 | 103.2 | 32.123 | 627 |
| Batch 16 / 3 | 21.1 | 111.2 | 32.209 | 665 |
| Batch 16 / 4 | 30.6 | 112.8 | 32.642 | 653 |
| **Batch 32 / 1** | **21.2** | **112.4** | **32.220** | **622** |
| **Batch 32 / 2** | **21.1** | **106.9** | **32.007** | **599** |
| **Batch 32 / 3** | **22.5** | **110.2** | **32.001** | **599** |
| **Batch 32 / 4** | **23.6** | **109.1** | **31.854** | **621** |
| Batch 64 / 1 | 22.2 | 102.6 | 32.969 | 529 |
| Batch 64 / 2 | 21.6 | 109.5 | 33.503 | 566 |
| Batch 64 / 3 | 24.0 | 117.3 | 32.022 | 629 |
| Batch 64 / 4 | 27.9 | 109.9 | 33.651 | 567 |

Batch 32 minus same-iteration FIFO:

| Iteration | Leader p95 Δ ms | Repath p95 Δ ms | Blocked Δ | Wall Δ s |
|---|---:|---:|---:|---:|
| 1 | −0.8 | −0.9 | −164 | +0.542 |
| 2 | −3.5 | −5.0 | −187 | +0.134 |
| 3 | −0.8 | −2.1 | −176 | +0.723 |
| 4 | −8.8 | −4.5 | −178 | −0.121 |

Batch 8 leader p95 is worse 3/4 times and has a severe first-iteration outlier. Batch 16 leader p95 is worse 2/4 and repath p95 worse 1/4. Batch 64 leader p95 is worse 2/4, repath p95 worse 1/4, and wall time worse 4/4. Batch 32 is the only repeatable response winner.

## Pooled distributions

| Policy | Leader response p50 / p95 | Repath response p50 / p95 | Leader queue p95 | Repath queue p95 | Leader compute p95 | Repath compute p95 | Mean wall s | Apply/tick p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FIFO | 21.9 / 32.1 | 31.4 / 112.8 | 31.5 | 112.8 | 2.0 | 0.2 | 31.701 | 0.1 |
| Batch 8 | 27.7 / 66.9 | 35.6 / 115.3 | 53.1 | 111.3 | 2.9 | 0.2 | 32.898 | 0.1 |
| Batch 16 | 22.8 / 30.3 | 35.6 / 110.4 | 17.4 | 105.8 | 2.6 | 0.2 | 32.483 | 0.1 |
| **Batch 32** | **21.2 / 23.4** | **35.0 / 109.9** | **13.8** | **103.2** | **2.0** | **0.2** | **32.020** | **0.1** |
| Batch 64 | 22.2 / 26.9 | 36.7 / 109.5 | 14.3 | 99.8 | 1.9 | 0.2 | 33.036 | 0.1 |

Batch 32's pooled leader/repath response p95 is **23.4 / 109.9 ms**, versus FIFO **32.1 / 112.8 ms**. Its repath p50 is 35.0 ms versus FIFO 31.4 ms, and mean wall time increases 0.319 s. These trade-offs remain explicit adoption risks.

Every run finished with **571 completed / 429 cutoff-active**, the same logical replay, and final full-state hash:

`3f162961d59884df56ffb38836f6f2bd3e0bae2a785ca87c3dfad3b082f6c2bb`

All recorded applications retained issue→apply = 2 ticks. Production apply p95 was 0.1 ms for every policy.

## Transport and message counts

Counts are per measured run and identical across all four iterations of each policy.

| Policy | Request messages | Result messages | Message reduction | Eligible | Coalesced | Full snapshot bytes | Delta bytes | Result waypoint bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FIFO | 46,807 | 46,807 | 0% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 8 | 7,171 | 7,171 | 84.68% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 16 | 4,489 | 4,489 | 90.41% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 32 | 3,145 | 3,145 | 93.28% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 64 | 2,466 | 2,466 | 94.73% | 0 | 0 | 14,400 | 0 | 374,216 |

Main/worker retained land snapshot occupancy was one / 14,400 bytes; path-cache occupancy remained bounded at 32. Scalar structured-clone wire bytes and total browser heap/GC were not measured.

## Honest delivery diagnostic

After headline measurement, each page ran 64 sequential probe/acknowledgment round trips on a fresh worker. Both timestamps use main-thread `performance.now()`; the worker returns only handling time. RTT is nonnegative by construction and includes outbound post, worker handling, and inbound acknowledgment. It is **not one-way response delivery**, is outside headline policy timings, and was not used for selection.

Pooled diagnostic RTT p95 was 0.2 ms FIFO and 0.1 ms for every batch size, with 256 probes per policy. Maxima were 33.2 / 27.6 / 18.5 / 22.7 / 20.6 ms for FIFO/8/16/32/64. Queue telemetry still crosses agent clocks; raw negative values are retained rather than treated as physical durations.

## Integrated Recast correctness gate

The combined exact-tile engine now runs behind the acknowledged full/delta snapshot protocol in a real Vite-built module-WASM worker. It preserves request IDs, due ticks, stale/out-of-order handling, ascending application, delayed delivery, independent planes, and bounded two-revision snapshot/mesh caches. Corrected full-rebuild Recast is the only route oracle; there is no A* route fallback.

A new 104×104 mutation test exposed a false no-path in the original exact-tile builder. Recast's three-cell rasterization border means a boundary mutation can affect neighboring compressed layers. The corrected builder re-rasterizes directly touched tiles plus a one-tile neighbor halo.

Consequently, narrow replay revision 6 now rasterizes **25 tiles** and reuses **200 layers**, superseding the old implementation's 4-tile/221-layer counters. Exact routes and final state are unchanged. This remains incremental rasterization with a fresh TileCache/NavMesh container per revision, not a fully incremental navmesh container update.

### Exact validation

| Gate | Result |
|---|---:|
| Original Node replay | 199/199 exact routes |
| Delayed integrated Node replay | 199/199 exact routes, logical/final-hash equality |
| Built-worker Chrome replay | 199/199 exact routes, logical/final-hash equality |
| Final full-state hash | `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f` |
| Protocol violations | 0 |
| Snapshot sends / acknowledgments | 2 / 2 |
| Maximum worker snapshot count / bytes | 2 / 28,800 |
| Mutation stress | 30/30 exact across 5/5 cases |
| Geometry rejections | 0 |

The stress matrix covers repeated one-tile gate close/reopen, building add/remove, a five-rectangle burst, 104×104 multi-tile obstacle/reopen, and 576 isolated blocked cells. Focused tests also cover cache eviction, stale/out-of-order/same-version races, independent planes, delayed delivery, ascending application, duplicate suppression, and visible native-engine failure injection.

The browser and Node oracle used the same WASM SHA-256:

`6fe3c90073fb734bd98eb0a38daec269552aa8564f639ec458219d72d09c6bc9`

Failure injection proves visible protocol handling of an engine/native-style exception, not recovery from every WASM trap, browser-process crash, OOM, or detached-message failure. Native memory/allocator behavior and total browser heap/GC remain unaudited.

## Next gates

1. **Validate batch 32 on renderer-paced production workloads.** Require repeated leader/repath and blocked-frame wins without unacceptable wall-time, repath-median, gameplay, or replay regressions before adoption.
2. **Implement the clean production handle/provider API separately.** Do not promote the harness-only `slice()` adaptation.
3. **Benchmark the corrected integrated Recast candidate at full scale.** Use repeated dense and narrow p1000/t3600 Chrome comparisons against current A*, with exact route/replay gates and native-memory telemetry. The old 4-tile/221-layer implementation must not be used.
4. **Retain FIFO and current A* as production controls until those gates pass.**

## Limitations

1. Four samples and eight leaders per policy remain small; rotation reduces but does not eliminate order, thermal, and session effects.
2. Batch 32 does not improve repath p50 or wall time consistently. The harness is not a renderer-paced production session and uses a 400-tick warmup.
3. Full-game compute coalescing is exactly zero because stable shared repath identity is unavailable.
4. Only headless Chrome arm64 and the land mixed trace produced headline A* timings. Other browsers, x64, naval/owner performance, multiple workers, and other workloads remain unmeasured.
5. RTT probes are not one-way delivery; queue telemetry retains cross-agent clock limitations. Scalar wire bytes and total heap/GC were not measured.
6. Recast browser coverage is one narrow p40/t400 built-worker sample. Dense, p1000/t3600, repeated/interleaved, non-Chrome, x64, and independent-WASM runs remain unvalidated.
7. Recast supports binary flat passability, not arbitrary heightfields, slopes, off-mesh topology, or layered geometry.

## Reproduction

From the repository root:

```sh
npx tsc --noEmit
npx tsc -p scratch/navigation-batch-only/tsconfig.json
npx vitest run scratch/navigation-batch-only/queue.test.ts \
  tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts \
  scratch/full-game-movement/harness/browser/full-game/full-game.test.ts
npx tsx scratch/navigation-batch-only/analyze.mts
npx tsx scratch/navigation-batch-only/verify-replay.mts

npx tsc -p scratch/navigation-queue/recast-combined/integrated/tsconfig.json
npx vitest run scratch/navigation-queue/recast-combined/integrated/integrated.test.ts
npx tsx scratch/navigation-queue/recast-combined/verify-parity.ts
npx tsx scratch/navigation-queue/recast-combined/integrated/stress.ts
npx vite build --config scratch/navigation-queue/recast-combined/integrated/vite.config.ts
node scratch/navigation-queue/recast-combined/integrated/run-browser.mjs --built --smoke --name smoke-built
npx tsx scratch/navigation-queue/recast-combined/integrated/run-node.ts \
  --scenario narrow-mutation-120 --population 40 --ticks 400 \
  --name node-combined-oracle-p40-t400
node scratch/navigation-queue/recast-combined/integrated/run-browser.mjs \
  --built --scenario narrow-mutation-120 --population 40 --ticks 400 \
  --samples 1 --name combined-p40-t400-built
node scratch/navigation-queue/recast-combined/integrated/validate-replay.mjs
```

The detailed reports link all raw Chrome samples, derived distributions, stress outputs, build/smoke evidence, and reproduction commands for the rotated benchmark iterations.

# Navigation worker queue and coalescing policy evidence

Wayfinder: **“Which navigation worker queue and coalescing policy meets replay and latency budgets?”** (#170)

## Decision

**Retain versioned FIFO as the production-default control. Reject leader-priority alone for this workload. Keep bounded batching as a promising research candidate, not a selected policy. Advance the clean snapshot-handle/provider design, never the legacy `Uint8Array.slice()` compatibility shim. Current A* remains the production control.**

Three rotated, interleaved real-Chrome samples per policy found no challenger with a repeatable latency and full-game outcome win. Leader priority improved pooled leader p95 but increased wall time and blocked frames in all three iterations while damaging or leaving unchanged the repath tail. Priority plus batching greatly reduced message traffic and reduced blocked frames in every iteration, but its leader and wall-time improvements were not repeatable.

The next discriminating experiment is **batch-only**, without leader priority, across batch sizes 8/16/32/64 and more rotated samples. The current combined candidate cannot separate batching benefits from priority costs.

## Evidence and verification

This record consolidates:

1. [A* queue, priority, batching, and coalescing study](../../scratch/navigation-queue/report.md)
2. [Combined exact-tile Recast Node checkpoint](../../scratch/navigation-queue/recast-combined/report.md)

Independent verification passed strict TypeScript, 40/40 queue/A*/engine/scheduler/full-game artifact tests, derived metric analysis, and all nine full-game replay comparisons. The combined Recast checkpoint separately passed strict TypeScript and exact Node parity verification.

Coverage remains headless Chrome arm64 and Node/mock. No Firefox, WebKit, Safari, x64, or independent WASM performance evidence was collected.

## Clean production protocol direction

The clean scratch protocol replaces embedded passability with `SnapshotHandle { snapshotId, revision, plane, width }`. A scheduler-owned provider prepares one current private snapshot per plane, copies or diffs only when the required revision changes, and returns the handle plus registration/update payload.

Clean worker requests carry request ID, due tick, exact endpoints, seed, handle, request class, explicit group key, and send timestamp. They contain no `Uint8Array` and no slice behavior. Snapshot registration/update stays ordered ahead of dependent requests; independent land/naval/owner stores and production A* engines retain two immutable revisions per plane.

Production still needs the narrow scheduler API change: current `PathRequest` embeds passability and `requestPath` calls `passability.slice()`. The production scheduler should request a provider handle directly and construct the clean request union. The isolated scratch `slice()` override exists only to run against today's scheduler and must not be productionized.

The response-authority contract is unchanged: worker execution may be reordered, but the scheduler buffers by ID, blocks a missing due response, applies strictly ascending IDs, and discards stale revisions. `World.step` retains its blocked-boundary behavior. Production A* and its 32-entry LRU remain unchanged.

## Compared queue policies

### Versioned FIFO control

- One immediate scalar path message per production request.
- Worker handles transport arrival order; one result message per request.
- No priority, defer, batching, or compute coalescing.
- Snapshot registration/update precedes dependent requests on the same FIFO channel.

### Stable leader-aware priority

- Requests issued during one synchronous `World.step` flush in a microtask before the driver's macrotask yield.
- Stable order is leader first, then request ID; repaths retain relative ID order.
- One request and one result message per request; no batching or coalescing.

This changes worker execution order, not authoritative application order. The eight initial leaders are already first in the mixed trace, so priority cannot remove preexisting work ahead of them.

### Leader priority plus bounded batching

- The same stable leader-first/ID order, split into batches of at most 64 requests.
- One request message per batch and one result message containing every individual response.
- Different requests in a batch are not compute-coalesced.

Compute sharing is legal only when snapshot ID/revision/plane, due tick, exact start/goal, seed, request class, and explicit group key all match. Unknown groups are never shared. Production does not expose a safe shared repath group identity at this seam, so the full-game runner assigned a unique group key to every repath: **zero full-game responses were compute-coalesced**. Focused tests prove legal sharing and rejection semantics, not a full-game deduplication speedup.

## Interleaved Chrome method

Environment: headless Chrome 156.0.8078.47, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0.

Each policy ran one warmup followed by one measured sample with a fresh page and worker. Policies ran sequentially in one browser session per iteration, with rotated order:

1. FIFO → priority → priority-batch
2. Priority → priority-batch → FIFO
3. Priority-batch → FIFO → priority

Every run executed the real eight initial leaders, 46,807 requests, and 46,799 production repaths over 3,600 committed ticks. Three iterations reduce session/order confounding but are not causal proof or a breach-probability estimate.

## Latency and queue results

Values are milliseconds. Response is authoritative main-thread issue→worker-response. Queue is post-to-worker-receipt; compute is production `engine.handle` or exact legal same-group response copying. Each per-run leader p95 has n=8; pooled leader n=24.

| Policy / iteration | Leader response p50 / p95 / max | Leader queue / compute p95 | Repath response p50 / p95 / max | Repath queue / compute p95 |
|---|---|---:|---|---:|
| FIFO 1 | 43.6 / 46.6 / 46.6 | 47.2 / 5.5 | 32.1 / 117.0 / 187.8 | 117.9 / 0.2 |
| FIFO 2 | 25.1 / 28.2 / 28.2 | 28.6 / 1.9 | 32.4 / 120.2 / 176.0 | 121.0 / 0.2 |
| FIFO 3 | 27.9 / 29.8 / 29.8 | 30.8 / 2.3 | 31.0 / 107.0 / 153.4 | 107.9 / 0.2 |
| **FIFO pooled** | **28.2 / 46.3 / 46.6** | **47.2 / 2.3** | **31.9 / 115.3 / 187.8** | **116.1 / 0.2** |
| Priority 1 | 27.7 / 30.2 / 30.2 | 24.8 / 3.5 | 40.3 / 143.0 / 297.3 | 139.6 / 0.2 |
| Priority 2 | 36.3 / 38.1 / 38.1 | 34.6 / 7.1 | 38.1 / 120.2 / 151.4 | 117.1 / 0.2 |
| Priority 3 | 24.4 / 25.1 / 25.1 | 20.0 / 3.9 | 42.5 / 128.4 / 298.5 | 125.3 / 0.2 |
| **Priority pooled** | **27.7 / 37.8 / 38.1** | **34.4 / 3.9** | **40.2 / 130.1 / 298.5** | **126.9 / 0.2** |
| Batch 1 | 28.5 / 29.5 / 29.5 | 15.5 / 1.8 | 35.8 / 109.7 / 230.1 | 101.5 / 0.2 |
| Batch 2 | 35.7 / 36.2 / 36.2 | 19.1 / 3.6 | 38.3 / 109.2 / 162.1 | 99.6 / 0.2 |
| Batch 3 | 34.5 / 34.9 / 34.9 | 21.6 / 3.9 | 36.1 / 112.0 / 142.0 | 104.1 / 0.2 |
| **Batch pooled** | **34.5 / 35.9 / 36.2** | **21.6 / 3.6** | **36.8 / 110.3 / 230.1** | **101.8 / 0.2** |

All pooled leader p95 values exceed the 33.3 ms budget. Batch pooled leader p50 is higher than FIFO even though its pooled p95 is lower, so the result is not a uniform leader improvement.

### Per-iteration challenger minus FIFO

Negative values favor the challenger. Wall differences are seconds.

| Iteration | Policy | Leader p95 Δ ms | Repath p95 Δ ms | Blocked frames Δ | Wall Δ s |
|---|---|---:|---:|---:|---:|
| 1 | Priority | −16.4 | +26.0 | +141 | +1.185 |
| 2 | Priority | +9.9 | 0.0 | +17 | +0.505 |
| 3 | Priority | −4.7 | +21.4 | +139 | +1.411 |
| 1 | Batch | −17.1 | −7.3 | −200 | +0.313 |
| 2 | Batch | +8.0 | −11.0 | −207 | +0.864 |
| 3 | Batch | +5.1 | +5.0 | −123 | −0.260 |

Priority increases wall time and blocked frames 3/3 times; its repath p95 is worse twice and unchanged once. Batch reduces blocked frames 3/3 times and repath p95 2/3 times, but leader p95 only 1/3 and wall time only 1/3.

## Scheduling, transport, and replay

| Policy / iteration | Wall s | Frames / blocked | Initial group apply ms | Apply/tick p95 / max ms | Completed / active |
|---|---:|---:|---:|---:|---:|
| FIFO 1 | 32.502 | 4,370 / 770 | 0.8 | 0.1 / 3.0 | 571 / 429 |
| FIFO 2 | 32.730 | 4,390 / 790 | 1.1 | 0.1 / 2.1 | 571 / 429 |
| FIFO 3 | 32.864 | 4,320 / 720 | 1.0 | 0.1 / 1.7 | 571 / 429 |
| Priority 1 | 33.687 | 4,511 / 911 | 0.9 | 0.1 / 2.0 | 571 / 429 |
| Priority 2 | 33.235 | 4,407 / 807 | 1.3 | 0.1 / 2.4 | 571 / 429 |
| Priority 3 | 34.275 | 4,459 / 859 | 1.1 | 0.1 / 2.0 | 571 / 429 |
| Batch 1 | 32.815 | 4,170 / 570 | 1.2 | 0.1 / 1.8 | 571 / 429 |
| Batch 2 | 33.594 | 4,183 / 583 | 1.5 | 0.1 / 1.7 | 571 / 429 |
| Batch 3 | 32.603 | 4,197 / 597 | 1.1 | 0.1 / 2.2 | 571 / 429 |

Pooled apply p95 was 0.1 ms for every policy. Each run used exactly one 14,400-byte full land snapshot, zero mixed deltas, and 374,216 response waypoint bytes. Main/worker snapshot occupancy was one / 14,400 bytes; path-cache occupancy remained bounded at 32.

FIFO and priority each sent 46,807 request messages and received 46,807 result messages per run. Batch sent/received **2,466 / 2,466**, a **94.73% reduction**, with identical path results.

All nine samples ended with 571 completed and 429 cutoff-active units and final full-state hash:

`3f162961d59884df56ffb38836f6f2bd3e0bae2a785ca87c3dfad3b082f6c2bb`

Every sample matched preserved Node mixed A* logically and by final hash. Every recorded application retained issue→apply = 2 ticks.

## Delivery-clock limitation

Raw response-delivery estimates used main receipt epoch minus worker send epoch and contained physically impossible negative values down to **−1.2 ms**. Signed p95 values were FIFO leader/repath −0.7/4.7 ms, priority −0.7/0.2 ms, and batch −0.2/0.6 ms. These are diagnostic clock outputs, not physical durations or selection evidence.

Total response remains the authoritative main-thread measurement. A delivery-specific follow-up needs an explicit clock-offset handshake or main-only acknowledgment round trip. Queue values have the same general cross-agent limitation, although they closely track total response and remain useful diagnostically.

## Combined Recast checkpoint: correctness only

The separate combined Recast prototype passed a narrow Node correctness gate against corrected full-rebuild Recast:

- **199/199 path responses matched exactly** by request ID, status, cost, and waypoint array.
- The 400-tick final full-state hash matched: `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f`.
- Revision 6 changed 16 cells, re-rasterized four touched nav tiles, reused 221 unchanged compressed layers, and had zero geometry rejections.

The strategy diffs exact passability snapshots, deletes only touched 8×8-world-unit nav tiles' compressed layers, re-rasterizes those tiles, retains unchanged layers byte-for-byte, and deterministically rebuilds the TileCache/NavMesh. It preserves corrected corridor gates, continuous supercover conversion, and production LOS string pulling. It is incremental rasterization, not a fully incremental navmesh container update.

The checkpoint diagnosed the two old incremental failures as stale or uncarved TileCache geometry on requests 1 and 3, both `(47,42) → (80,60)`. The untouched #169 implementation's guarded full rebuilds already preserved corrected routes.

**No versioned worker transport, Vite build, stress matrix, real-Chrome run, or scale benchmark was completed for this combined candidate.** Race branches were not covered by focused tests. Its single-run instrumentation is not a benchmark. No worker, browser, CPU, throughput, latency, or production-readiness claim is supported.

## Production recommendation and next gates

1. **Use the clean handle/provider design for the production proposal.** Preserve due-tick, ascending-application, stale, plane, and memory semantics; do not productionize the compatibility override.
2. **Keep FIFO as the default.** Priority alone is rejected for this workload because it sacrifices repaths, blocking, and wall time without a repeatable leader win.
3. **Research batch-only next.** Compare sizes 8/16/32/64 with more rotated/interleaved Chrome samples and no leader priority. Selection requires repeated response and full-game outcome improvements.
4. **Require stable group/compatibility keys before compute coalescing.** Unique per-request keys are safe but provide no deduplication; focused correctness tests are not performance evidence.
5. **Add a dedicated delivery-clock diagnostic** before optimizing delivery tails.
6. **Complete the combined Recast transport/browser/race/stress gate before any Recast performance claim.** Wire it behind the acknowledged two-revision full/delta protocol, then require exact Node and real-Chrome route/replay parity before scale benchmarking.
7. **Retain current A* as the production control.**

## Limitations

1. Three measured samples per policy and eight leaders per sample remain small; rotated order reduces but does not eliminate thermal/session/order effects.
2. Only combined priority+batch was measured. Batch-only, sizes other than 64, and multiple workers were not tested.
3. Full-game compute coalescing was zero because safe shared repath group identity is unavailable at the existing seam.
4. Cross-agent delivery values contain clock skew; scalar structured-clone wire bytes and total browser heap/GC were not measured.
5. Only headless Chrome arm64 and the land mixed trace produced headline timings. Revision/plane correctness is covered by Node/mock tests.
6. The trace runs real movement/placement loops but not combat, gathering, rendering, or a full production session. `setTimeout(0)` is an event-loop yield, not a 30 Hz renderer.
7. The combined Recast result is one narrow p40/t400 Node checkpoint with no integrated transport/browser/stress evidence.

## Reproduction

From the repository root:

```sh
npx tsc -p scratch/navigation-queue/tsconfig.json
npx vitest run scratch/navigation-queue/queue.test.ts \
  tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts \
  scratch/full-game-movement/harness/browser/full-game/full-game.test.ts
npx tsx scratch/navigation-queue/analyze.mts
npx tsx scratch/navigation-queue/verify-replay.mts

npx tsc -p scratch/navigation-queue/recast-combined/tsconfig.json
npx tsx scratch/navigation-queue/recast-combined/verify-parity.ts
```

The queue study also records the three `run-policies.mjs` iterations and links every raw Chrome sample and derived result.

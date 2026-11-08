# Wayfinder #171 — batch-only navigation worker policies

## Decision

**Select batch-only 32 as the challenger to advance; retain versioned FIFO as the current production control until the narrow production handle/provider API lands. Reject batch-only 8, 16, and 64 for this trace.** No policy uses leader priority or request-class reordering.

Four rotated, interleaved, same-session real-Chrome samples per policy show that batch 32 improved per-iteration leader response p95, repath response p95, and blocked frames against that iteration's FIFO control **4/4 times**. Its per-run leader p95 was 21.1–23.6 ms, below the 33.3 ms budget in all four runs. Pooled leader/repath response p95 was **23.4 / 109.9 ms**, versus FIFO **32.1 / 112.8 ms**. Request and result messages each fell from 46,807 to 3,145 per run (**93.28%** reduction).

This is not a uniform win: batch 32's repath response p50 was 35.0 ms versus FIFO 31.4 ms, and wall time was faster only 1/4 times (mean +0.319 s, about +1.0%). Selection rests on repeated per-iteration response and blocked-frame results, not pooled tails or delivery diagnostic RTT. Full-game outcomes and authoritative replay were unchanged.

Implementation and evidence are isolated here. Production A*, the clean snapshot-handle/provider design, due ticks, monotonic IDs, ascending application, and stale discard remain the controls. The runnable-only `Uint8Array.slice` compatibility shim is not a production recommendation.

## Policy and compatibility specification

The five policies are implemented in [adapter.ts](adapter.ts), [protocol.ts](protocol.ts), and [worker-handler.ts](worker-handler.ts):

- **FIFO:** immediate one-request messages in transport arrival order.
- **Batch 8/16/32/64:** collect one synchronous flush, require strictly increasing request IDs, and split without sorting or class-based reordering. Every batch preserves request order and due ticks; worker results contain individual responses in the same order.
- The production scheduler remains the response authority: missing due responses block, responses apply in ascending ID order, duplicates are safe, and stale revisions discard.
- Current production A* and its 32-entry LRU are unchanged. Snapshot registration/update remains ordered before dependent requests.

A compute-coalescing compatibility key is the exact tuple:

`(requester groupKey, snapshotId, snapshot revision, plane, dueTick, startX, startY, goalX, goalY, seed, requestClass)`.

The requester supplies `order:<stable order ID>` for known leader commands. The existing seam exposes no safe shared repath identity, so each repath receives `unshared-repath:<request ID>`; missing metadata receives unique `unknown:<request ID>`. Unknown or incompatible requests therefore never share. “Eligible” means a response after the first occurrence of the identical full key within the same batch. The worker records that count and actual copied responses separately.

Across all 20 measured full-game runs, **eligible = 0 and coalesced = 0**. No full-game deduplication speedup is claimed. Focused tests prove one legal duplicate is eligible/coalesced and that different groups, endpoints, seeds, due ticks, classes, and unique unknown keys do not share.

## Method

Environment: headless Chrome 156.0.8078.47, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0. Each policy ran on a fresh page with one 400-tick warmup worker followed by a fresh measured worker. Each measured run executed the real mixed `p1000/t3600` trace: eight initial leaders, **46,807 requests**, 46,799 repaths, and 3,600 committed ticks. Diagnostic probes ran afterward on another fresh worker.

Four policies-plus-control rotations were run in one browser session per iteration:

1. FIFO → 8 → 16 → 32 → 64
2. 8 → 16 → 32 → 64 → FIFO
3. 16 → 32 → 64 → FIFO → 8
4. 32 → 64 → FIFO → 8 → 16

An initial attempt using full-length warmups hit the 300 s command limit during iteration 1 after FIFO, 8, and 16 completed. Those partial files are preserved under [superseded-full-warmup](results/superseded-full-warmup/) and excluded. The reported matrix restarted with the same 400-tick warmup for every policy/sample; all measured traces remain full length.

Response is main-thread issue→worker-response. Queue remains post-to-worker-receipt diagnostic telemetry and compute is production `engine.handle`. Wall, frames, blocked frames, production apply, messages, and binary payload counts come from each complete run. Per-run leader distributions have n=8; pooled leader n=32. Pooled repath n=187,196 per policy.

## Per-iteration headline results

Milliseconds except wall seconds. Lower is better. These rows, rather than pooled tails alone, drive selection.

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

## Pooled distributions and scheduling

| Policy | Leader response p50 / p95 | Repath response p50 / p95 | Leader queue p95 | Repath queue p95 | Leader compute p95 | Repath compute p95 | Mean wall s | Apply/tick p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FIFO | 21.9 / 32.1 | 31.4 / 112.8 | 31.5 | 112.8 | 2.0 | 0.2 | 31.701 | 0.1 |
| Batch 8 | 27.7 / 66.9 | 35.6 / 115.3 | 53.1 | 111.3 | 2.9 | 0.2 | 32.898 | 0.1 |
| Batch 16 | 22.8 / 30.3 | 35.6 / 110.4 | 17.4 | 105.8 | 2.6 | 0.2 | 32.483 | 0.1 |
| **Batch 32** | **21.2 / 23.4** | **35.0 / 109.9** | **13.8** | **103.2** | **2.0** | **0.2** | **32.020** | **0.1** |
| Batch 64 | 22.2 / 26.9 | 36.7 / 109.5 | 14.3 | 99.8 | 1.9 | 0.2 | 33.036 | 0.1 |

All apply distributions exclude zero-apply ticks. Full per-iteration and pooled p50/p95/max/mean distributions for response, queue, compute, tick wall, apply, and diagnostic RTT are in [distribution.json](results/distribution.json); per-active-tick apply rows are in [apply-ticks.json](results/apply-ticks.json).

Every run finished with **571 completed / 429 cutoff-active**, the same logical replay, and final full-state hash `3f162961d59884df56ffb38836f6f2bd3e0bae2a785ca87c3dfad3b082f6c2bb`. All recorded applications retained issue→apply = 2 ticks. All 20 comparisons passed logical equality, final hash equality, and application timing against preserved Node A* in [replay-equivalence.json](results/replay-equivalence.json).

## Transport and exact coalescing counts

Counts are per measured run and identical across all four iterations of each policy.

| Policy | Request messages | Result messages | Message reduction | Eligible | Coalesced | Full snapshot bytes | Delta bytes | Result waypoint bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FIFO | 46,807 | 46,807 | 0% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 8 | 7,171 | 7,171 | 84.68% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 16 | 4,489 | 4,489 | 90.41% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 32 | 3,145 | 3,145 | 93.28% | 0 | 0 | 14,400 | 0 | 374,216 |
| Batch 64 | 2,466 | 2,466 | 94.73% | 0 | 0 | 14,400 | 0 | 374,216 |

Main/worker retained land snapshot occupancy was one / 14,400 bytes; path cache occupancy reached but did not exceed 32. Scalar structured-clone wire bytes and total browser heap/GC were not measured.

## Honest response-delivery diagnostic

After headline measurement, each page ran 64 sequential probe/acknowledgment round trips on a fresh worker. Both timestamps use main-thread `performance.now()`; the worker returns only a handling-time field. Thus RTT is physically nonnegative by construction and includes outbound post, worker handling, and inbound acknowledgment. It is **not one-way response delivery**, is outside headline policy timings, and was not used for selection.

Pooled diagnostic RTT p95 was 0.2 ms FIFO and 0.1 ms for every batch size, with 256 probes per policy. Maxima were 33.2 / 27.6 / 18.5 / 22.7 / 20.6 ms for FIFO/8/16/32/64, showing outliers that p95 hides. Raw probes are in each Chrome file and distributions are derived separately. No #170 signed cross-agent delivery values are reused. Queue telemetry still crosses agent clocks; a tiny negative batch-32 queue value is retained raw and not treated as a physical duration.

## Correctness and validation

Passed:

- production strict TypeScript: `npx tsc --noEmit`;
- isolated strict TypeScript, including browser runner, analysis, and verifier;
- **12/12** focused provider/coalescing/batch/race/replay tests;
- **34/34** existing A*/engine/scheduler/full-game artifact tests;
- **46/46 total tests**, five test files;
- **20/20** Chrome replay logical/hash/application-timing comparisons.

Focused coverage includes legal coalescing and incompatible/unknown rejection, registration races, revision immutability, two-revision eviction, independent planes, delayed and out-of-order delivery for every batch size, duplicate-safe ascending application, revision/update stale discard, two-tick application, and two delayed full-game repeats for FIFO plus every batch size.

## Exact commands

From the repository root:

```sh
npx tsc --noEmit
npx tsc -p scratch/navigation-batch-only/tsconfig.json
npx vitest run scratch/navigation-batch-only/queue.test.ts \
  tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts \
  scratch/full-game-movement/harness/browser/full-game/full-game.test.ts

node scratch/navigation-batch-only/run-policies.mjs --iteration 1
node scratch/navigation-batch-only/run-policies.mjs --iteration 2
node scratch/navigation-batch-only/run-policies.mjs --iteration 3
node scratch/navigation-batch-only/run-policies.mjs --iteration 4

npx tsx scratch/navigation-batch-only/analyze.mts
npx tsx scratch/navigation-batch-only/verify-replay.mts
```

## Raw evidence

Derived: [distribution.json](results/distribution.json), [apply-ticks.json](results/apply-ticks.json), [replay-equivalence.json](results/replay-equivalence.json), [analysis console](results/analysis-console.json), and [replay console](results/replay-console.json).

- FIFO: [1](results/chrome-fifo-mixed-iteration-1.json), [2](results/chrome-fifo-mixed-iteration-2.json), [3](results/chrome-fifo-mixed-iteration-3.json), [4](results/chrome-fifo-mixed-iteration-4.json).
- Batch 8: [1](results/chrome-batch-8-mixed-iteration-1.json), [2](results/chrome-batch-8-mixed-iteration-2.json), [3](results/chrome-batch-8-mixed-iteration-3.json), [4](results/chrome-batch-8-mixed-iteration-4.json).
- Batch 16: [1](results/chrome-batch-16-mixed-iteration-1.json), [2](results/chrome-batch-16-mixed-iteration-2.json), [3](results/chrome-batch-16-mixed-iteration-3.json), [4](results/chrome-batch-16-mixed-iteration-4.json).
- Batch 32: [1](results/chrome-batch-32-mixed-iteration-1.json), [2](results/chrome-batch-32-mixed-iteration-2.json), [3](results/chrome-batch-32-mixed-iteration-3.json), [4](results/chrome-batch-32-mixed-iteration-4.json).
- Batch 64: [1](results/chrome-batch-64-mixed-iteration-1.json), [2](results/chrome-batch-64-mixed-iteration-2.json), [3](results/chrome-batch-64-mixed-iteration-3.json), [4](results/chrome-batch-64-mixed-iteration-4.json).

## Limitations

1. Four samples and eight leaders per sample remain small; rotation reduces but does not eliminate order, thermal, and session effects. This is not a causal or breach-probability estimate.
2. Batch 32 does not improve repath p50 or wall time consistently. Its mean wall cost is about 1%; validate on a renderer-paced production session before adoption.
3. Full-game compute coalescing is exactly zero because stable shared repath identity is unavailable. No deduplication benefit is claimed.
4. Only headless Chrome arm64 and the land mixed trace produced headline timings. Firefox, WebKit, Safari, x64, naval/owner performance, multiple workers, and other workloads remain unmeasured.
5. The trace runs movement/placement loops, not combat, gathering, rendering, or a full production session. `setTimeout(0)` is an event-loop yield, not a 30 Hz renderer. Warmup is 400 ticks, not the full measured trace.
6. RTT probes measure acknowledgment round trips, not one-way delivery. Queue still has cross-agent clock limitations. Chrome's 0.1 ms quantization makes displayed zero below resolution.
7. Binary payload and message counts are exact; scalar structured-clone wire bytes and total heap/GC are not measured.
8. The clean provider/protocol remains the production direction. The isolated legacy compatibility shim exists only to drive today's scheduler and must never be productionized.

# Wayfinder #170 — navigation worker queue and coalescing policies

## Decision

**Retain versioned FIFO as the production-default control. Do not select leader-aware priority alone or the combined priority/batch policy yet.**

Three interleaved same-session samples per policy show:

- **FIFO:** pooled leader/repath response p95 **46.3 / 115.3 ms**.
- **Leader priority:** **37.8 / 130.1 ms**. It improves some leader runs but consistently damages the repath stream or leaves it unchanged, increases blocked frames, and increases wall time in every iteration.
- **Leader priority + bounded batching:** **35.9 / 110.3 ms**. It reduces request/result messages by 94.73%, lowers blocked frames in every iteration, and improves pooled repath p95, but leader p95 remains above 33.3 ms. Per-iteration leader response and wall-time improvements are not repeatable.

All nine real-Chrome mixed A* 1,000/3,600 samples matched preserved Node A* logically and by final full-state hash. Every recorded application retained issue→apply = 2 ticks. Production apply p95 was 0.1 ms for every policy. No semantic regression was observed, but the repeated-latency gate is not met by a challenger.

## Clean production design versus runnable compatibility

The recommended design is implemented directly in [protocol.ts](protocol.ts) and [provider.ts](provider.ts):

- `SnapshotHandle {snapshotId, revision, plane, width}` replaces embedded passability in the clean path request.
- `SchedulerOwnedSnapshotProvider.prepare(revision, plane, source)` owns one current private snapshot per plane, copies/diffs only when the required revision changes, and returns the handle plus registration/update payload.
- Clean worker requests contain request ID, due tick, exact endpoints, seed, handle, request class, explicit group key, and send timestamp. They contain no `Uint8Array` and no slice behavior.
- Snapshot registration/update messages and two-immutable-revision worker stores retain the #169 ownership model. Land/naval/owner planes have independent stores and production A* engines.

Production still needs the narrow scheduler API change because current `PathRequest` embeds passability ([protocol.ts](../../src/sim/path/protocol.ts#L18-L38)) and current `requestPath` calls `passability.slice()` before transport ([scheduler.ts](../../src/sim/path/scheduler.ts#L155-L193)). The production scheduler should request a provider handle directly and construct the clean request union; it should not adopt a `slice()` override.

Only the runnable path through today's scheduler uses [legacy-compat.ts](legacy-compat.ts). That isolated file maps the provider's private array to the old request shape and overrides its `slice()` to return the same revision. The clean provider, worker, queue policy, and recommended production request union do not depend on that compatibility file.

The experiment leaves production response authority unchanged: responses may execute/arrive out of order, but the existing scheduler buffers by ID, blocks a missing due response, applies strictly ascending IDs, and discards stale revisions ([scheduler.ts](../../src/sim/path/scheduler.ts#L196-L231)). `World.step` retains the blocked-boundary behavior ([world.ts](../../src/sim/core/world.ts#L261-L267)). Production A* and its 32-entry LRU remain unchanged ([engine.ts](../../src/sim/path/engine.ts#L61-L114)).

## Policy specifications

### 1. Versioned FIFO control

- One immediate scalar `path` message per production request.
- Worker handles requests in transport arrival order and returns one result message per request.
- No priority, defer, batching, or compute coalescing.
- Snapshot registration/update remains ahead of dependent requests on the same FIFO channel.

### 2. Stable leader-aware priority

- Requests issued during one synchronous `World.step` are collected and flushed in a microtask before the driver's macrotask yield.
- Stable order is **leader first, then request ID**. Repaths retain relative ID order.
- One request message and one result message per request; no batching/coalescing.
- Maximum observed main pending queue: 1,000 requests.

This can change worker execution order but not authoritative application order. In the mixed trace, the eight initial leaders are already the first requests, so priority cannot be expected to remove preexisting work ahead of them.

### 3. Leader priority + bounded batching

- The same stable leader-first/ID order, split into batches of at most **64 requests**.
- One request message per batch and one result message containing every individual response. Different requests in a batch are **not** coalesced.
- Compute coalescing is legal only when snapshot ID/revision/plane, due tick, exact start/goal, seed, request class, and explicit `groupKey` all match. Each original ID receives its own exact `PathResponse` and waypoint array.
- Unknown groups are never shared. The full-game compatibility runner assigns a unique group key to every repath because production does not expose a safe shared-group identity at this seam. Therefore **zero full-game responses were coalesced**; measured full-game improvement is from batching, not compute deduplication. Focused tests exercise legal same-group coalescing and reject different groups/endpoints/seeds.
- Maximum observed main pending queue: 1,000; maximum actual batch: 64.

No multiple-worker policy was added. One worker is sufficient to isolate these queue semantics without introducing another scheduling variable.

## Interleaved Chrome method

Environment: **headless Chrome 156.0.8078.47, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0**. Each policy configuration ran one warmup followed by one measured sample with a fresh page and worker. Policies ran sequentially in one browser session per iteration, with rotated order:

1. FIFO → priority → priority-batch
2. Priority → priority-batch → FIFO
3. Priority-batch → FIFO → priority

This controls session/order better than comparing only with historical runs, but three iterations are still not causal proof or a breach-probability estimate. Every run executed the real eight initial leaders, 46,807 requests, and 46,799 production repaths over 3,600 committed ticks.

Headline telemetry avoids per-request JSON byte accounting, request-post probes, and extra response-timing messages. Each worker result carries queue/compute/send-time fields; binary snapshot/waypoint bytes and retained-object counts are exact. Response-delivery clock limitations are reported below rather than hidden.

## Response, queue, and compute results

Values are milliseconds. Response is authoritative main-thread issue→worker-response. Queue is post-to-worker-receipt; compute is production `engine.handle` (or exact same-group response copying when legally coalesced). Each per-run leader p95 has n=8; pooled leader n=24.

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

All pooled leader p95 values exceed 33.3 ms. Priority has one per-run leader p95 above budget; batch has two; FIFO has one. Batch pooled leader p50 is higher than FIFO even though its pooled p95 is lower, another reason not to claim uniform improvement.

Historical context only: #169 versioned FIFO pooled leader/repath p95 was 34.8/111.8 ms, and #168 per-request-snapshot A* was 48.0/115.5 ms. The new FIFO differs from #169 despite equivalent policy, illustrating session/sample variability. These non-identical sample sets are not used as causal A/B evidence.

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

Batch reduces blocked frames 3/3 times and repath p95 2/3 times, but leader p95 only 1/3 times and wall time only 1/3 times. Priority increases wall time 3/3 times and blocked frames 3/3 times; its repath p95 is worse twice and unchanged once.

## Response-delivery measurement limitation

Raw response-delivery estimates were computed as main receipt epoch minus worker send epoch. They contain physically impossible negative values down to **−1.2 ms**, showing that epoch-adjusted cross-agent clocks still have creation/quantization skew. Raw signed values are preserved; they are not clamped or presented as real negative delivery.

For transparency, signed p95 values were: FIFO leader/repath **−0.7 / 4.7 ms**, priority **−0.7 / 0.2 ms**, and batch **−0.2 / 0.6 ms**. These are diagnostic clock outputs, not reliable additive latency components. Total response remains the authoritative main-thread measurement. A future delivery-specific diagnostic needs an explicit clock-offset handshake or a main-only acknowledgment round trip; policy selection here does not use these signed delivery values.

## Scheduling, apply, bytes, and memory

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

Per-active-tick apply percentiles exclude zero-apply ticks. Pooled apply p95 was 0.1 ms for all policies; pooled maxima were 3.0 ms FIFO, 2.4 ms priority, and 2.2 ms batch. Tail maxima do not establish an apply p95 breach.

All policies used exactly one 14,400-byte full land snapshot per run, zero mixed deltas, and 374,216 response waypoint bytes. Main/worker snapshot occupancy was one / 14,400 bytes, and path-cache occupancy reached but did not exceed 32. FIFO and priority sent 46,807 request messages and received 46,807 result messages per run. Batch sent/received **2,466 / 2,466**, a **94.73% message reduction**, with identical path results.

## Replay and authoritative application

Every sample ended with 571 completed and 429 cutoff-active units, with the same final crowd rows and final full-state hash:

`3f162961d59884df56ffb38836f6f2bd3e0bae2a785ca87c3dfad3b082f6c2bb`

The verifier compared every sample to preserved Node mixed A* using `logicalBenchmarkString`, covering milestones, completions, units, crowd states, diagnostics, mutations, and logical path/application records. It separately checked final hash and that every recorded application had issue→apply = 2 ticks. **All nine passed all three checks.**

## Correctness tests and validation

Six new focused tests cover:

- clean provider behavior versus isolated legacy compatibility;
- exact same-group coalescing and rejection of different groups, starts, and seeds;
- registration-before-request races, revision immutability, and two-revision eviction;
- independent land/naval/owner planes and bounded memory;
- leader-first execution races with duplicate-safe ascending scheduler application;
- revision/update batches, stale discard, and authoritative two-tick application;
- delayed/out-of-order full-game replay, repeated twice for each of FIFO, priority, and batch.

Validation passed:

- strict TypeScript for protocol, provider, worker, policies, runner, tests, analysis, and verifier;
- **6/6** new queue/replay tests;
- **34/34** existing production A*/engine/scheduler and full-game browser artifact tests.

## Exact commands

Run from the repository root:

```sh
npx tsc -p scratch/navigation-queue/tsconfig.json
npx vitest run scratch/navigation-queue/queue.test.ts
npx vitest run tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts scratch/full-game-movement/harness/browser/full-game/full-game.test.ts

node scratch/navigation-queue/run-policies.mjs --iteration 1
node scratch/navigation-queue/run-policies.mjs --iteration 2
node scratch/navigation-queue/run-policies.mjs --iteration 3

npx tsx scratch/navigation-queue/analyze.mts
npx tsx scratch/navigation-queue/verify-replay.mts
```

## Raw and derived evidence

Derived: [policy distributions](results/distribution.json), [per-active-tick apply rows](results/apply-ticks.json), and [nine-run replay verification](results/replay-equivalence.json).

FIFO: [iteration 1](results/chrome-fifo-mixed-iteration-1.json), [iteration 2](results/chrome-fifo-mixed-iteration-2.json), [iteration 3](results/chrome-fifo-mixed-iteration-3.json).

Priority: [iteration 1](results/chrome-priority-mixed-iteration-1.json), [iteration 2](results/chrome-priority-mixed-iteration-2.json), [iteration 3](results/chrome-priority-mixed-iteration-3.json).

Priority batch: [iteration 1](results/chrome-priority-batch-mixed-iteration-1.json), [iteration 2](results/chrome-priority-batch-mixed-iteration-2.json), [iteration 3](results/chrome-priority-batch-mixed-iteration-3.json).

Implementation: [clean protocol](protocol.ts), [scheduler-owned provider](provider.ts), [isolated legacy compatibility](legacy-compat.ts), [queue adapter](adapter.ts), [worker policy handler](worker-handler.ts), [worker shell](queue.worker.ts), and [full-game runner](async-runner.ts).

Baselines: [#169 versioned snapshots](../navigation-protocol/snapshots/report.md) and [#168 preserved A* distribution](../phase2-navigation/browser-distribution/report.md).

## Production recommendation and next gate

1. **Use the clean handle/provider design for the production proposal.** Keep all due-tick, ascending-application, stale, plane, and memory semantics. Do not productionize the legacy compatibility override.
2. **Keep FIFO as the default queue policy.** Priority alone is rejected for this workload: it sacrifices repaths, blocking, and wall time without a repeatable leader win.
3. **Retain bounded batching as a research candidate, not the selected policy.** Its message and blocked-frame reductions justify one follow-up, but pooled leader p95 is still 35.9 ms and leader/wall improvements are not repeated.
4. The next discriminating experiment should be **batch-only without leader priority**, with more interleaved samples and batch-size sensitivity (for example 8/16/32/64). The current combined candidate cannot separate batching gains from priority costs.
5. Do not enable compute coalescing in production until requesters supply an explicit stable group/compatibility key. This full game exercised batching only; same-group coalescing correctness tests are not performance evidence.
6. Add a dedicated response-delivery clock diagnostic before optimizing delivery tails. Do not use the current signed cross-agent values for selection.

## Limitations

1. Three measured samples per policy and eight leaders per sample remain small. Rotated same-session order reduces but does not eliminate thermal/session/order effects.
2. Only the combined priority+batch candidate executed; batch-only and batch sizes other than 64 were not measured. Multiple workers were not tested.
3. Full-game compute coalescing was zero because safe shared repath group identity is unavailable at the existing seam. No deduplication speedup is claimed.
4. Cross-agent response-delivery values contain negative clock skew and are not valid physical durations. Queue values have the same general cross-agent limitation, although they closely track total response and are useful diagnostically.
5. Binary snapshot/waypoint sizes and message counts are exact; scalar structured-clone wire bytes and total browser heap/GC were not measured in this slice. Memory claims are retained-object counts and queue/batch bounds.
6. Only headless Chrome arm64 and the land mixed trace executed for headline timings. Firefox, WebKit, Safari, x64, and naval/owner browser performance remain unmeasured. Revision/plane correctness is covered by Node/mock tests.
7. The trace runs real movement/placement loops but not combat, gathering, rendering, or a full production session. `setTimeout(0)` is an event-loop yield, not a 30 Hz renderer. Chrome's 0.1 ms timer quantization means displayed zero is below resolution.

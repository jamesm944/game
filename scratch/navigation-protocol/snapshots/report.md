# Wayfinder #169 — versioned A* snapshots and incremental worker updates

## Verdict

**Versioned snapshots eliminate the per-request 14,400-byte passability clones and preserve exact production A*/replay semantics, but they do not remove worker latency.**

Three fresh real-Chrome mixed 1,000/3,600 runs reduced full snapshot payload from **674,020,800 bytes to 14,400 bytes per run**, a 99.998% reduction. Including scalar request and registration accounting, main→worker payload was 9.20–9.25 MB per run, approximately 98.63% below the baseline snapshot bytes alone. A real mutation smoke used one full registration plus an 80-byte delta for 16 changed tiles.

Pooled eight-leader response p95 improved descriptively from the preserved five-sample baseline's 48.0 ms to **34.8 ms**, but remained above 33.3 ms. Individual-repath p95 moved only from 115.5 to **111.8 ms**. One of three versioned per-sample leader p95 values exceeded 33.3 ms. Worker queueing, not A* compute, remains dominant: pooled queue p95 was **34.4 ms leaders / 112.7 ms repaths**, versus compute p95 **2.7 ms / 0.2 ms**.

All three mixed samples and the mutation sample matched preserved Node A* in the complete logical replay comparison and final full-state hash. Production application p95 stayed 0.1 ms. These are three instrumented samples compared with five earlier, non-interleaved baseline samples; they do not establish a universal latency improvement or breach rate.

## Production behavior and the forced seam

Production currently makes snapshot copying unavoidable before the transport:

- `PathRequest` contains a `Uint8Array` snapshot and revision ([protocol.ts](../../../src/sim/path/protocol.ts#L18-L38)).
- `PathScheduler.requestPath()` performs `options.passability.slice()` for every request ([scheduler.ts](../../../src/sim/path/scheduler.ts#L155-L193)). Thus a transport-only change can avoid worker `postMessage` cloning but cannot remove the main-thread per-request copy.
- The same scheduler owns monotonic IDs, due ticks, ascending application, due-response blocking, and stale-version discard ([scheduler.ts](../../../src/sim/path/scheduler.ts#L196-L231)); `World.step` holds the boundary when `pump` blocks ([world.ts](../../../src/sim/core/world.ts#L261-L267)).
- Production A* and its bounded 32-entry LRU remain in `createPathEngine` ([engine.ts](../../../src/sim/path/engine.ts#L61-L114)). The normal worker simply invokes that engine ([path.worker.ts](../../../src/sim/path.worker.ts#L19-L30)), and the normal browser glue posts the entire request without transfer ([paths.ts](../../../src/game/paths.ts#L10-L29)).

The scratch adaptation leaves that scheduler machinery in place. `installVersionedSnapshotScheduler` wraps only `requestPath` and supplies a private same-revision array whose `slice()` returns itself. The array is copied from live passability once per prepared revision, never written afterward, and resolved by the scratch transport through a `WeakMap`. This is explicitly a **research shim**, not a recommended production monkey patch.

The full-game runner is a scratch copy of the existing asynchronous `World.step` driver. It retains the existing scheduler instrumentation, real group/Activity callbacks, movement-generated repaths, mutations, steering, collision, milestones, and replay records. The original driver and results are unchanged.

## Protocol design

Main→worker messages are explicit and revisioned:

1. **`snapshot-register`**: `{snapshotId, revision, plane, width, passable: ArrayBuffer}`. The full buffer is **structured-cloned once** at registration. No transfer list is used for this message, so it is not described as zero-copy.
2. **`snapshot-update`**: `{snapshotId, baseSnapshotId, revision, baseRevision, plane, width, indices, values}`. Changed indices are `Uint32Array`, values are `Uint8Array`, and both buffers are transferred. The worker copies the base once per new revision before applying the delta, preserving the old revision's immutability.
3. **`versioned-path`**: production request ID, due tick, endpoints, seed, revision, plane, and `snapshotId`, with no passability array. Scalar requests are structured-cloned. FIFO registration/update before each dependent request avoids a startup race without waiting for acknowledgment.
4. **Worker acknowledgments/results**: registration/update acknowledgments report handling time and snapshot occupancy. Path results use production `PathResponse`; waypoint buffers are transferred. Worker telemetry reports post-to-receipt queue time, actual engine handle time, path-cache occupancy, and snapshot memory counts.

`plane` is `"land" | "naval" | "owner"`; the worker keeps independent snapshot maps and production path engines per plane. The executed traces use only the land `derivedPassability` plane, so no naval/owner performance claim is made. The scratch main cache is one land snapshot per scheduler.

### Immutable ownership and memory bounds

- Main thread: one current private land snapshot, **14,400 bytes** on these traces. Previous main records are not strongly retained.
- Worker: at most two immutable revisions per plane. Mixed used one revision / 14,400 bytes; mutation used two / 28,800 bytes.
- Path cache: production maximum 32 entries per plane. All observed runs reached but did not exceed 32.
- Revision changes with no intervening path request coalesce into the next required update. In the mutation trace, the next request after the revision sequence prepared **0→6 directly**, with the exact 16-tile net delta. Pending old-revision responses remain ordered and are discarded by the unchanged production scheduler when stale.

## Byte and copy/transfer evidence

Scalar sizes are deterministic UTF-8 JSON payload accounting; binary sizes are exact `byteLength`. Browser structured-clone wire size is not exposed and is not claimed. The conservative total below compares new scalar + registration/update accounting with the old snapshot bytes alone.

| Mixed sample | Baseline per-request snapshots | Full registrations | Scalar requests | Registration + scalar total | Snapshot reduction |
|---|---:|---:|---:|---:|---:|
| 1 | 674,020,800 B | 14,400 B | 9,182,857 B | 9,197,340 B | 99.998% |
| 2 | 674,020,800 B | 14,400 B | 9,210,987 B | 9,225,470 B | 99.998% |
| 3 | 674,020,800 B | 14,400 B | 9,237,971 B | 9,252,454 B | 99.998% |

Every mixed run had 46,807 requests: one initial snapshot preparation and **46,806 same-revision reuses**. There were no mixed revision updates. Across the three runs, full snapshot payload totaled 43,200 bytes versus 2,022,062,400 baseline snapshot bytes.

Chrome quantizes `performance.now()` to 0.1 ms, so zero means below resolution rather than no work.

| Operation | Measured result |
|---|---|
| Mixed main snapshot copy | One per run, 0.0 ms displayed |
| Mixed full registration post | 0.0–0.1 ms; one structured clone per run |
| Scalar request `postMessage` | Pooled p50/p95 0.0/0.0 ms, max 0.4 ms |
| Sampled response transfer post | n=549, p50/p95 0.0/0.1 ms, max 2.3 ms |
| Mutation main revision copy | 0.0 ms displayed |
| Mutation 14,400-cell diff | 0.2 ms |
| Mutation update post / worker handling | 0.0 / 0.0 ms displayed |

Response-post timing is sampled for request 1 and every 256th response to avoid doubling the real message stream with telemetry. Queue, compute, request-post, registration/update, and response/apply timings remain in the raw evidence.

## Mixed full-game response distribution

Each versioned launch used a fresh headless Chrome browser/page and one warmup followed by one measured run on the same Apple M1 arm64, 8-logical-CPU, 16-GiB, Darwin 23.6.0 host, Chrome 156.0.8078.47. Each run used a fresh worker. All runs had 46,807 requests and 46,799 production repaths.

Values are milliseconds. Queue is postMessage-to-worker-onmessage using epoch-adjusted high-resolution clocks; compute is actual production `engine.handle` time.

| Sample | Leader response p50 / p95 / max | Leader queue / compute p95 | Repath response p50 / p95 / max | Repath queue / compute p95 |
|---|---|---:|---|---:|
| 1 | 32.3 / **36.0** / 36.0 | 35.8 / 1.9 | 30.9 / 108.9 / 203.6 | 109.7 / 0.2 |
| 2 | 29.0 / **31.0** / 31.0 | 31.6 / 2.7 | 31.1 / 116.1 / 194.9 | 117.0 / 0.2 |
| 3 | 28.5 / **30.0** / 30.0 | 31.0 / 3.1 | 30.9 / 109.8 / 167.7 | 110.8 / 0.2 |
| **Versioned pooled** | **30.0 / 34.8 / 36.0** (n=24) | **34.4 / 2.7** | **31.0 / 111.8 / 203.6** (n=140,397) | **112.7 / 0.2** |
| **Preserved A* pooled** | **26.6 / 48.0 / 48.6** (n=40) | Not measured | **32.9 / 115.5 / 247.7** (n=233,995) | Not measured |

The p95 changes are **−13.2 ms leaders** and **−3.7 ms repaths**. They are not uniform latency removal: pooled leader p50 increased from 26.6 to 30.0 ms, mean leader response was essentially unchanged (30.3 versus 30.1 ms), and versioned pooled p95 still exceeded 33.3 ms. Queue p95 closely tracks response p95, while compute p95 is small. Cross-agent queue values are separate-clock measurements and can differ slightly from end-to-end response durations; they should not be treated as an exact additive decomposition.

## Scheduling, apply, and replay outcomes

| Sample | Wall s | Frames | Blocked frames | Initial eight-group apply ms | Apply/tick p95 / max ms | Completed / active |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 32.369 | 4,365 | 765 | 1.1 | 0.1 / 2.9 | 571 / 429 |
| 2 | 32.062 | 4,366 | 766 | 0.9 | 0.1 / 1.9 | 571 / 429 |
| 3 | 32.162 | 4,347 | 747 | 1.1 | 0.1 / 2.0 | 571 / 429 |
| **Pooled apply** | — | — | — | — | **0.1 / 2.9** across 5,487 active ticks | — |

Preserved baseline ranges were 31.687–32.817 s wall time and 706–867 blocked frames. Versioned ranges of 32.062–32.369 s and 747–766 blocked frames therefore do not demonstrate a meaningful wall-time or blocking improvement. Per-active-tick apply percentiles exclude zero-apply ticks. The initial callbacks shared tick 3 and issue→apply remained two ticks. Final crowd rows were identical: 571 completed, 15 moving, 398 stalled, 16 propagated-Parked, and 429 cutoff-active overall.

All mixed samples had final full-state hash `3f162961d59884df56ffb38836f6f2bd3e0bae2a785ca87c3dfad3b082f6c2bb` and matched the preserved Node mixed A* logical result.

## Real incremental mutation smoke

The Chrome narrow+mutation smoke used population 100 and 600 committed ticks, one warmup and one measured run. It completed 1,069 requests / 1,065 repaths in 605 frames with 5 blocked frames.

| Metric | Result |
|---|---:|
| Baseline per-request snapshot bytes | 15,393,600 B |
| Full registration protocol / binary payload | 14,483 / 14,400 B |
| Update | revision 0→6, 16 changed cells |
| Delta binary payload | 80 B (16 × 4-byte index + 1-byte value) |
| Update protocol including scalar accounting | 197 B |
| Scalar requests | 208,136 B |
| Total registration + update + scalar requests | 222,816 B |
| Main / maximum worker snapshot memory | 14,400 / 28,800 B |
| Repath response p50 / p95 / max | 1.8 / 9.3 / 12.2 ms |
| Apply/tick p95 / max | 0.1 / 0.3 ms |

The initial two leader responses became stale under the unchanged production gate, as in the control; no initial-group apply total is reported for this smoke. The final hash was `6947072dea89e2d9bf4d792930c7de81c61e718e3d37eaca755d8333cd891ba7`, with full logical equality to preserved Node mutation A*.

## Correctness and validation

The seven new tests cover:

- repeated same-revision requests and source-mutation isolation;
- revision deltas and exact production A* response equality, including cache hits;
- out-of-order responses, due blocking, ascending application, stale discard, and duplicate suppression through the production scheduler;
- registration-before-request races and missing update bases;
- independent land/naval planes and bounded two-revision eviction;
- full-game synchronous versus versioned asynchronous replay with real incremental revisions;
- two delayed async full-game repeats with equal logical results and hashes.

Validation passed:

- strict TypeScript for the complete scratch runner, worker, protocol, tests, verifier, and analysis;
- **7/7** new snapshot/replay tests;
- **5/5** existing full-game browser artifact tests;
- **29/29** existing production A* engine/cache/scheduler tests.

## Exact commands

Run from the repository root:

```sh
npx tsc -p scratch/navigation-protocol/snapshots/tsconfig.json
npx vitest run scratch/navigation-protocol/snapshots/snapshots.test.ts
npx vitest run scratch/full-game-movement/harness/browser/full-game/full-game.test.ts
npx vitest run tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts

node scratch/navigation-protocol/snapshots/run-snapshots.mjs --scenario mixed --sample 1
node scratch/navigation-protocol/snapshots/run-snapshots.mjs --scenario mixed --sample 2
node scratch/navigation-protocol/snapshots/run-snapshots.mjs --scenario mixed --sample 3
node scratch/navigation-protocol/snapshots/run-snapshots.mjs --scenario mutation --sample 1

npx tsx scratch/navigation-protocol/snapshots/analyze.mts
npx tsx scratch/navigation-protocol/snapshots/verify-replay.mts
```

## Evidence files

Derived:

- [Distribution, bytes, queue, compute, apply, and baseline comparison](results/distribution.json)
- [Every mixed per-active-tick apply row](results/apply-ticks.json)
- [Mixed and mutation Node replay equality](results/replay-equivalence.json)

Raw Chrome samples:

- [Mixed sample 1](results/chrome-versioned-mixed-p1000-t3600-sample-01.json)
- [Mixed sample 2](results/chrome-versioned-mixed-p1000-t3600-sample-02.json)
- [Mixed sample 3](results/chrome-versioned-mixed-p1000-t3600-sample-03.json)
- [Mutation smoke](results/chrome-versioned-mutation-p100-t600-sample-01.json)

Primary scratch implementation: [protocol](protocol.ts), [main snapshot cache/scheduler seam](snapshot-cache.ts), [worker snapshot store](worker-handler.ts), [real worker shell](versioned.worker.ts), [transport/telemetry adapter](adapter.ts), and [full-game runner](async-runner.ts).

Baseline: [five-sample A* distribution](../../phase2-navigation/browser-distribution/report.md). Preserved Node references: [mixed](../../full-game-movement/harness/results/mixed-destinations-120-p1000-sync.json) and [mutation](../../full-game-movement/harness/results/narrow-mutation-120-p100-t600-sync-a.json).

## Production recommendation

**Advance the versioned-snapshot design as the next production transport seam, but do not promote this scratch shim or describe it as a latency fix.** The byte and memory result is large and exact-replay evidence is strong; the latency result is modest, variable, and still above the leader budget.

A narrow production implementation should:

1. Introduce a snapshot handle (`snapshotId`, plane, revision) in a versioned request union rather than embedding `Uint8Array` in every path request.
2. Add a scheduler-owned snapshot provider that prepares/copies/diffs once per required revision. Keep ID assignment, outstanding maps, due ticks, ascending pump, and stale discard unchanged. Do not override `Uint8Array.slice` in production.
3. Register before dependent requests on the same FIFO worker channel, acknowledge updates, retain two immutable worker revisions per plane, and bound path caches per plane. Preserve old snapshots until older queued searches cannot remain.
4. Use explicit structured clone for full registration or transfer ownership with a documented detached-buffer contract; never call an untransferred clone zero-copy. Transfer delta and response buffers where ownership permits.
5. Evaluate queue ownership/coalescing next. The remaining p95 is dominated by post-to-worker queueing, not snapshot bytes or measured A* compute.

Before making it the default, run interleaved same-session A/B samples with minimal telemetry and repeat mutation bursts/multi-plane traces. Require repeated leader/repath response improvement, not only byte savings.

## Limitations

1. Only three mixed measured samples and one mutation smoke executed. Baseline and versioned runs were not interleaved, have n=5 versus n=3 leader groups, and carry different worker telemetry. Percentile deltas are descriptive, not controlled causal estimates.
2. Each per-sample leader p95 has only eight correlated requests; versioned pooled leader n=24 remains small. Chrome's 0.1 ms quantization limits copy/apply/post resolution.
3. JSON scalar accounting is not browser wire size. Actual binary snapshot/delta/waypoint sizes are exact. No total-browser-heap or GC measurement is claimed; memory evidence is retained-object counts and bytes.
4. Queue timing uses epoch-adjusted clocks across main/worker agents. It is useful for locating pressure but is not an exact additive decomposition of main-thread response latency.
5. Only headless Chrome arm64 executed. Firefox, WebKit, Safari, and x64 remain unmeasured. Naval/owner planes have correctness coverage only; the traces exercise land.
6. The mutation smoke coalesced to revision 6 because no requests required intermediate revisions. Large mutation bursts, delta-overflow fallback, >512 obstacles, dense full-game, and multi-plane browser distributions remain future gates.
7. The workload runs the real movement/placement loops but not combat, gathering, rendering, or a complete production session. `setTimeout(0)` yields honestly but is not a 30 Hz renderer.

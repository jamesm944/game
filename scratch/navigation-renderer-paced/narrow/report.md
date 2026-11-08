# Wayfinder #172 — renderer-paced FIFO vs batch32, narrow/mutation p1000/t3600

## Decision

**Do not adopt batch32.** The required five same-session rotated pairs per policy are complete, and correctness checks pass on simulation-observable state. However, batch32 increased repath-response p50 in **all five pairs** (+0.8, +1.5, +3.6, +1.4, and +2.2 ms). The pooled repath p50 increased from 4.1 ms FIFO to 5.8 ms batch32 (+1.7 ms, about 41%), and pooled p95 increased from 42.6 to 49.7 ms.

Batch32 was faster on wall clock in four pairs and slower in one. Mean paired wall difference was only **−92.1 ms over a roughly 120.8 s run** (−0.076%); median difference was −70.6 ms. Mean blocked frames fell from 23.4 to 20.6, but pair 3 reversed both wall and blocked-frame directions. The approximately 95% request-message reduction does not offset the consistent response-latency regression.

The workload issued combat orders and ran production combat systems, but recorded **zero combat-damage events in every run**. Thus actual combat engagement is not covered. This limitation remains even though the five-pair sampling requirement is now met.

## Evidence inventory

- Analysis: [`results/distribution.json`](./results/distribution.json)
- Replay verification: [`results/replay-equivalence.json`](./results/replay-equivalence.json)
- Orchestrator: [`run-policies.mjs`](./run-policies.mjs)
- Browser entry: [`browser-main.ts`](./browser-main.ts)
- Full-game runner: [`runner.ts`](./runner.ts)
- Production Three.js renderer adapter: [`renderer.ts`](./renderer.ts)
- Clean scheduler/provider/transport: [`handle-scheduler.ts`](./handle-scheduler.ts), [`provider.ts`](./provider.ts), [`adapter.ts`](./adapter.ts), [`protocol.ts`](./protocol.ts)
- Worker: [`worker-handler.ts`](./worker-handler.ts), [`queue.worker.ts`](./queue.worker.ts)
- Focused checks: [`scheduler-focused.test.ts`](./scheduler-focused.test.ts)
- Analysis and verification scripts: [`analyze.mts`](./analyze.mts), [`verify-replay.mts`](./verify-replay.mts)

Raw measured runs (smoke runs are excluded everywhere below):

| Pair | FIFO raw | batch32 raw |
|-:|:-|:-|
| 1 | [`chrome-fifo-iteration-1.json`](./results/chrome-fifo-iteration-1.json) | [`chrome-batch-32-iteration-1.json`](./results/chrome-batch-32-iteration-1.json) |
| 2 | [`chrome-fifo-iteration-2.json`](./results/chrome-fifo-iteration-2.json) | [`chrome-batch-32-iteration-2.json`](./results/chrome-batch-32-iteration-2.json) |
| 3 | [`chrome-fifo-iteration-3.json`](./results/chrome-fifo-iteration-3.json) | [`chrome-batch-32-iteration-3.json`](./results/chrome-batch-32-iteration-3.json) |
| 4 | [`chrome-fifo-iteration-4.json`](./results/chrome-fifo-iteration-4.json) | [`chrome-batch-32-iteration-4.json`](./results/chrome-batch-32-iteration-4.json) |
| 5 | [`chrome-fifo-iteration-5.json`](./results/chrome-fifo-iteration-5.json) | [`chrome-batch-32-iteration-5.json`](./results/chrome-batch-32-iteration-5.json) |

## Method and compliance

- Scenario: `narrow-mutation-120`, population 1000, 3600 measured ticks at 30 Hz (120 simulated seconds).
- Five AB/BA pairs: FIFO → batch32 on odd pairs; batch32 → FIFO on even pairs.
- Each pair was run sequentially by one orchestrator invocation. Pairs 1–2 have matching iteration/order/host metadata and sequential capture times; pairs 3–5 additionally share an explicit per-pair `sessionId` in their raw files.
- Every policy run used a fresh browser page and fresh measured worker. A 60-tick rendered warmup preceded the measured run; the measured candidate/worker was newly constructed after warmup.
- All ten runs completed exactly 3600 measured ticks. Raw JSON was parsed during analysis and replay verification. New runs used temporary-file-plus-rename writes and explicit warmup/final-tick checks; no temporary output remains.
- Browser: real Chrome 156.0.8078.47, headless, Playwright, `--enable-unsafe-swiftshader`; actual WebGL rendering through the production Three.js path. This is not a synthetic rAF timer or an accelerated simulation.
- Pacing: production-style `requestAnimationFrame` wall-clock accumulator, 250 ms frame clamp, 30 Hz steps, at most five catch-up steps per frame, and backlog shedding after five steps.
- Rendering: production terrain meshes, building models, unit sprite layer, simulation/render mirror, interpolation, and terrain rebuild on passability revision changes.
- Host for all runs: Apple M1, 8 logical CPUs, 16 GiB, macOS arm64. Results are specific to this headless software-WebGL environment.

### Production versus experimental boundary

Production `PathScheduler` continues to own request IDs, outstanding state, due ticks, response buffering, stale discard, blocking, and ascending application. Production A* computes every non-coalesced path. Production movement, gather, combat, placement, world stepping, PRNG, digest, rendering, and mirror code are reused.

The scratch-only `HandlePathScheduler` subclass selects a `SchedulerOwnedSnapshotProvider` preparation. The ordinary production `Uint8Array.slice()` request copy still occurs. The clean transport sends an explicit `SnapshotHandle`, not the telemetry-only copied array. There is no `Uint8Array` method override, monkey patch, or legacy slice shim. Snapshot registration sends one full 14,400-byte plane and later revisions send deltas. The worker retains at most two snapshots (28,800 bytes).

FIFO posts one path request per message. Batch32 accumulates requests during the synchronous issuance turn, flushes in a microtask, preserves strictly increasing request IDs, and splits the stream into chunks of at most 32. Results still enter the unchanged production scheduler and apply strictly in ascending ID order at due boundaries. This experiment does not implement or evaluate deduplication as an optimization: repath group keys are unique, and both eligible and actual coalescing counts are exactly zero.

## Workload

Each run contained:

- 1000 surviving units: 900 villagers and 100 combat units.
- 16 resource nodes and 900 gather commands.
- Two attack commands and four group-move commands.
- Two terrain mutations and four building-placement commands.
- 90,472 path requests; 90,470 reused the current snapshot revision; two snapshot preparations.
- Final crowd states: 68 completed, 30 moving, 902 stalled, zero propagated-parked, zero parked-without-activity, zero awaiting-group-path, zero other-activity.
- **Zero combat-damage events.** Attack orders and combat systems were present, but engagement/damage was not demonstrated.

Every run produced final full-state hash:

`40e0fe31e150f6935fdcf5413f69f2ee915eeb718b254330c36a7bed310f01eb`

The Node A* oracle produced the same final hash, world digest `fnv1a64:34ff6633b61b5db6`, map hash `fnv1a64:0b953a55d8cf5de5`, request count, workload composition, and crowd states.

## Paired wall, blocked-frame, and repath-p50 results

`Δ` is batch32 minus FIFO. Blocked frames are the scheduler's held-boundary count (`blockedTicks`), incremented on frame-paced pump attempts when a due response is missing. Percentiles use nearest rank: `sorted[ceil(n*p)-1]`.

| Pair | Order | FIFO wall s | B32 wall s | Δ ms | FIFO blocked | B32 blocked | Δ blocked | FIFO repath p50 ms | B32 repath p50 ms | Δ p50 ms |
|-:|:-|-:|-:|-:|-:|-:|-:|-:|-:|-:|
| 1 | fifo → batch-32 | 120.9564 | 120.8858 | −70.6 | 28 | 26 | −2 | 4.6 | 5.4 | +0.8 |
| 2 | batch-32 → fifo | 120.9547 | 120.5267 | −428.0 | 28 | 15 | −13 | 3.7 | 5.2 | +1.5 |
| 3 | fifo → batch-32 | 120.4887 | 120.9160 | +427.3 | 14 | 27 | +13 | 3.3 | 6.9 | +3.6 |
| 4 | batch-32 → fifo | 120.6188 | 120.5572 | −61.6 | 18 | 16 | −2 | 4.0 | 5.4 | +1.4 |
| 5 | fifo → batch-32 | 120.9866 | 120.6590 | −327.6 | 29 | 19 | −10 | 4.1 | 6.3 | +2.2 |
| **Mean** | — | **120.8010** | **120.7089** | **−92.1** | **23.4** | **20.6** | **−2.8** | — | — | **+1.9** |

## Per-run response, worker, render, and apply distributions

Each cell is **p50/p95/max, milliseconds**. Response is main-thread issue-to-receipt. Queue is worker receipt minus send timestamp using the shared epoch. Compute is production A* worker time. rAF is actual frame interval; render CPU excludes waiting for the next frame. Apply/tick sums callback cost within each run-local tick and includes only ticks with at least one application.

| Policy | Run | Leader response | Repath response | Worker queue | Worker compute | Actual rAF interval | Render CPU | Apply/tick |
|:-|-:|:-|:-|:-|:-|:-|:-|:-|
| FIFO | 1 | 6.20/8.40/8.40 | 4.60/50.70/153.70 | 1.10/49.20/153.50 | 0.10/0.30/31.00 | 16.70/16.70/100.00 | 0.60/1.10/85.50 | 0.00/0.20/1.70 |
| batch32 | 1 | 9.70/10.90/10.90 | 5.40/53.50/186.90 | 0.20/41.70/180.60 | 0.00/0.20/22.10 | 16.70/16.80/83.30 | 0.60/1.10/84.90 | 0.10/0.20/1.80 |
| FIFO | 2 | 6.00/8.20/8.20 | 3.70/44.40/160.90 | 1.00/44.20/160.80 | 0.10/0.20/38.00 | 16.70/16.70/83.30 | 0.50/1.10/91.00 | 0.10/0.20/2.90 |
| batch32 | 2 | 8.20/8.70/8.70 | 5.20/43.10/188.70 | 0.40/32.40/185.60 | 0.00/0.20/34.60 | 16.70/16.80/66.70 | 0.50/1.00/77.00 | 0.10/0.20/1.90 |
| FIFO | 3 | 5.80/9.10/9.10 | 3.30/34.10/169.10 | 0.70/32.40/168.10 | 0.00/0.20/38.80 | 16.70/16.70/83.40 | 0.50/1.00/82.80 | 0.10/0.20/2.10 |
| batch32 | 3 | 9.10/17.40/17.40 | 6.90/59.80/134.90 | 0.60/45.90/131.50 | 0.10/0.30/28.60 | 16.70/16.70/83.40 | 0.50/1.00/85.50 | 0.00/0.20/1.70 |
| FIFO | 4 | 7.60/9.60/9.60 | 4.00/44.50/132.70 | 1.30/44.40/132.80 | 0.10/0.20/33.70 | 16.70/16.70/83.30 | 0.50/1.10/79.50 | 0.10/0.20/2.00 |
| batch32 | 4 | 12.10/12.90/12.90 | 5.40/47.80/104.70 | 0.30/35.00/100.60 | 0.00/0.20/41.70 | 16.70/16.70/83.30 | 0.60/1.10/82.10 | 0.10/0.20/1.90 |
| FIFO | 5 | 4.80/8.10/8.10 | 4.10/43.90/269.50 | 1.10/43.50/269.50 | 0.10/0.30/67.70 | 16.70/16.80/100.00 | 0.50/0.90/81.50 | 0.00/0.20/1.90 |
| batch32 | 5 | 11.60/158.50/158.50 | 6.30/47.00/104.40 | 0.30/34.50/146.70 | 0.10/0.30/39.90 | 16.70/16.70/83.30 | 0.50/0.90/89.30 | 0.00/0.20/1.70 |

There are only four leader responses per run (20 pooled per policy), so leader tail statistics are fragile. Batch32 pair 5 contains a 158.5 ms leader outlier; it should not be interpreted as a stable leader-p95 estimate.

## Pooled distributions and pacing

Pooling concatenates per-run observations; it does not average percentiles. Apply ticks remain run-local and are not summed across runs sharing a tick number.

| Metric | FIFO | batch32 |
|:-|:-|:-|
| Leader response p50/p95/max ms, n=20 | 7.60/9.30/9.60 | 10.90/158.00/158.50 |
| Repath response p50/p95/max ms, n=452,240 | 4.10/42.60/269.50 | 5.80/49.70/188.70 |
| Worker queue p50/p95/max ms, n=452,260 | 1.10/41.90/269.50 | 0.40/37.20/185.60 |
| Worker compute p50/p95/max ms, n=452,260 | 0.10/0.20/67.70 | 0.10/0.20/41.70 |
| Actual rAF p50/p95/max ms | 16.70/16.70/100.00 | 16.70/16.70/83.40 |
| Render CPU p50/p95/max ms | 0.50/1.10/91.00 | 0.50/1.00/89.30 |
| Applied-request callback p50/p95/max ms | 0.00/0.00/2.70 | 0.00/0.00/1.60 |
| Nonzero-apply-tick p50/p95/max ms, n=16,980 | 0.00/0.20/2.90 | 0.10/0.20/1.90 |
| Mean frames | 7,233.8 | 7,233.0 |
| Total/mean blocked frames | 117/23.4 | 103/20.6 |
| Max applications on one run-local tick | 913 | 913 |

Sub-millisecond values reflect browser timer resolution; zero does not imply literally zero work.

## Messages, binary payloads, cache, and outcomes

Counts below are per run; both policies have identical request, binary, snapshot, and outcome totals.

| Measure | FIFO | batch32 |
|:-|-:|-:|
| Path requests | 90,472 | 90,472 |
| Path request messages | 90,472 | 4,578 |
| Path result messages | 90,452 | 4,577 |
| Maximum batch size | 1 | 32 |
| Maximum requests queued for microtask flush | 0 | 913 |
| Joined request/response telemetry | 90,452 | 90,452 |
| Response waypoint bytes | 872,240 | 872,240 |
| Full-snapshot bytes | 14,400 | 14,400 |
| Delta bytes | 80 | 80 |
| Same-revision requests | 90,470 | 90,470 |
| Max worker snapshots / bytes | 2/28,800 | 2/28,800 |
| Max A* cache entries | 32 | 32 |
| Coalescing eligible / actual | 0/0 | 0/0 |
| Applied / stale-discarded / pending | 90,419/2/51 | 90,419/2/51 |

Across five runs per policy, request messages fell from 452,360 to 22,890 (**94.94% fewer**), and result messages fell from 452,260 to 22,885. Binary payload totals were unchanged: 4,361,200 response-waypoint bytes, 72,000 full-snapshot bytes, and 400 delta bytes per policy pool.

At cutoff, each run had 51 pending requests: 20 had no response and 31 had responses buffered for future/not-yet-applied boundaries. The 20 unanswered requests explain the request/result count difference. No response telemetry was unmatched or duplicated in the analysis join.

## Replay and correctness verification

`verify-replay.mts` ran the preserved production Node A* oracle through the clean handle scheduler/local FIFO worker and checked every one of the ten browser runs.

- Simulation-observable logical projection: **10/10 equal**.
- Stored browser logical projection equals its raw sample projection: **10/10 equal**.
- Final full-state hash: **10/10 equal to Node**.
- Every applied or stale-discarded request (90,421 per run): **issue-to-apply/discard = exactly two ticks**.
- All ten browser runs also have identical final world and crowd outcomes.

The unmodified raw `logicalBenchmark` projection is **not** equal to Node for all ten runs, solely at zero-based `paths[90452].ok` (request ID 90,453): Node has `ok: true`, while Chrome has no `ok` because the response has not arrived at cutoff. That request is pending and unapplied. The simulation comparison removes `ok` only for pending, unapplied requests because it is response-arrival telemetry, not state visible to the simulation. Both the raw mismatch and normalized result are retained in [`replay-equivalence.json`](./results/replay-equivalence.json); no applied/discarded field was normalized or ignored.

Focused tests cover ordinary request `.slice()` copying, monotonic IDs, FIFO chunks of 32, delayed/out-of-order responses, duplicate-safe ascending application, stale-revision discard, and the two-tick due contract. Existing production path and full-game tests were also run.

Final commands and results:

```sh
npx tsc -p scratch/navigation-renderer-paced/narrow/tsconfig.json
npx tsc --noEmit
# Both passed.

npx vitest run \
  scratch/navigation-renderer-paced/narrow/scheduler-focused.test.ts \
  tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts \
  scratch/full-game-movement/harness/browser/full-game/full-game.test.ts
# 5 files passed; 38/38 tests passed.

npx tsx scratch/navigation-renderer-paced/narrow/verify-replay.mts
# Passed simulation logical/final-hash/application checks for all 10 runs.

npx tsx scratch/navigation-renderer-paced/narrow/analyze.mts
# Wrote results/distribution.json.
```

Measurement commands, run separately to avoid a long-lived/orchestrated write being truncated by a command cap:

```sh
node scratch/navigation-renderer-paced/narrow/run-policies.mjs --iteration 1
node scratch/navigation-renderer-paced/narrow/run-policies.mjs --iteration 2
node scratch/navigation-renderer-paced/narrow/run-policies.mjs --iteration 3
node scratch/navigation-renderer-paced/narrow/run-policies.mjs --iteration 4
node scratch/navigation-renderer-paced/narrow/run-policies.mjs --iteration 5
```

## Limitations and required follow-up

1. **Adoption fails on observed response latency.** Five pairs are complete, but batch32's repath-p50 regression is consistent; this is not an inconclusive sample-count result.
2. **Combat engagement remains unverified.** Zero damage events means this study cannot claim combat-heavy behavior coverage. A corrected workload must demonstrate actual engagement before any combat-inclusive adoption claim.
3. **One narrow scenario and one environment.** No wide map, population scaling, hardware-GPU browser, visible-browser session, or alternative browser was measured.
4. **Headless software WebGL.** Production rendering code ran, but SwiftShader/headless performance is not a universal rendering-performance proxy.
5. **No coalescing benefit.** Unique repath keys caused zero eligible/actual coalescing. This study evaluates batching and handle snapshots, not deduplication.
6. **Experimental integration only.** The scheduler/provider/transport seam is isolated scratch code, not a production patch. No production integration or rollout recommendation is made.
7. **Small wall effect and run variance.** Four-of-five wall wins average 92.1 ms, with one reversal; this does not establish a robust user-visible frame-pacing improvement.

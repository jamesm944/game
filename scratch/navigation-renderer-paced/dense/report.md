# Wayfinder #172 — dense renderer-paced FIFO versus batch-only 32

## Decision

**Do not adopt batch-only 32 on this evidence. The requested renderer-paced production-session gate is incomplete.** There are **2 valid FIFO samples and 1 valid batch-32 sample**, but **0 valid same-session AB/BA pairs** and neither policy has the required 5 samples. The one ordered iteration-2 comparison is encouraging for batch 32 on leader/repath p95, blocked frames, and wall time, but its repath response p50 worsens by **2.0 ms (51.3%)**. It cannot establish repeated wins or clear the explicit wall-time/repath-p50 adoption gates.

This is real rAF/WebGL evidence, not a `setTimeout(0)` renderer claim. It is nevertheless an **adapted production-components harness**, not the unmodified `src/main.ts` application session. The full production system roster and production rendering modules run, but the scheduler/session seam, scripted workload, and browser loop/render composition are scratch adaptations detailed below.

All valid Chrome runs match their equivalent delayed full-length Node A* runs in milestones, final hash, request count, per-unit outcomes, and recorded issue→apply timing. Strict TypeScript and **37/37** relevant tests pass. These correctness results do not substitute for the missing performance samples.

## Evidence inventory and sample validity

| Raw file | Status | Use |
|---|---|---|
| [FIFO iteration 1](results/chrome-fifo-iteration-1.json) | Complete, valid | Unpaired FIFO sample |
| [Batch 32 iteration 1, killed write](results/partial-killed-chrome-batch-32-iteration-1.json) | **Truncated JSON at 524,288 bytes** | Failure evidence only; excluded from every metric |
| [Batch 32 iteration 2](results/chrome-batch-32-iteration-2.json) | Complete, valid | Ordered comparison with FIFO 2, separate browser process |
| [FIFO iteration 2](results/chrome-fifo-iteration-2.json) | Complete, valid | Ordered comparison with batch 32 2, separate browser process |
| [Delayed Node FIFO](results/node-fifo-delayed-full.json) | Complete, valid | Full-length logical oracle |
| [Delayed Node batch 32](results/node-batch32-delayed-full.json) | Complete, valid | Full-length logical oracle |
| [Browser smoke](results/smoke-browser.json) | Complete 30-tick smoke | Pipeline validation only; not headline evidence |
| [Node smoke](results/smoke-node.json) | Complete 30-tick smoke | Pipeline validation only; not headline evidence |

The initial combined iteration-1 process reached the 300 s command limit after FIFO completed and while batch 32 was finishing/writing. The partial batch file is preserved but is not parseable and has no usable result. Iteration 2 used BA order (`batch-32 → fifo`) but separate one-policy browser invocations to avoid another process timeout. Consequently it is **not a same-session measured pair**.

Derived evidence: [analysis.json](results/analysis.json) and [analysis console](results/analysis-console.json). Percentiles use nearest-rank; response n excludes requests without a response by cutoff. Pooled FIFO n=2 and batch-32 n=1 are descriptive only, not a balanced comparison.

## What is production and what is adapted

### Production code actually executed

- Production `createPathEngine` A* and its bounded 32-entry cache execute in a real module Worker through [worker-handler.ts](worker-handler.ts).
- Production `step()` and the complete `createSkirmishWorld` system roster execute: AI, movement, gathering, placement, construction, combat, lifecycle, economy, and related systems. [session.ts](session.ts) is a scratch copy of `src/game/session.ts`; its system roster is retained, with only transport/scheduler construction and import paths adapted.
- Production rendering modules execute from `src/render`: `WebGLRenderer`, `buildTerrainMesh`, `RtsCamera`, unit billboard atlas layers, building GLTF instances, resource GLTF instances, sim snapshot capture, and double-buffered mirror interpolation. See [browser-main.ts](browser-main.ts).
- The frame constants and accumulator behavior mirror `src/main.ts`: wall delta clamp 250 ms, fixed 30 Hz ticks, at most 5 steps per frame, and backlog shedding. Actual rAF timestamps and intervals are recorded in every raw sample.

### Explicit scratch adaptations

- [clean-scheduler.ts](clean-scheduler.ts) is a `PathScheduler` subclass/fork with independent scratch state. Request construction uses `SchedulerOwnedSnapshotProvider`; receive, duplicate suppression, due-tick blocking, ascending application, and stale discard copy production semantics. The superclass transport is inert.
- [adapter.ts](adapter.ts) implements only `fifo` and `batch-32`; batching is one microtask flush, strictly increasing IDs, chunks of at most 32 without sorting or class reorder. Snapshot register/update messages are ordered before dependent requests. There is no priority/class reorder and no legacy payload request accepted by the clean transport.
- [runner.ts](runner.ts) instruments requests/responses/application and scripts the dense workload. Dynamic placement selection submits one tick ahead so production placement validation sees current occupancy.
- [browser-main.ts](browser-main.ts) reproduces the production accumulator contract and calls production rendering functions. It is not the `src/main.ts` entry: UI, audio, post-processing, production fog culling, and several overlays are omitted; dense render capacity is 1,200 rather than production's 512. Thus this is not full application-render parity.
- There is **no `Uint8Array.slice` override, prototype patch, or `LegacySnapshotCompatibility` anywhere in the new TypeScript run path**. Ordinary snapshot copies remain in the provider/worker. `setTimeout(0)` occurs only in the explicitly unpaced Node oracle, never in Chrome frame scheduling.

## Workload and actual pacing

Every measured run used seed `20260822`, population 1,000, and 3,600 committed ticks (120 simulated seconds), after a fresh 120-tick warmup in the same page but with a fresh world/worker. Each policy invocation used a fresh page and Worker.

Workload composition per run:

- 604 villagers, 198 friendly militia, 198 enemy militia;
- 64 wood nodes and 604 gather commands;
- 24 scripted group/attack-move leader orders; 23 leader path requests reached the scheduler by cutoff;
- 2 direct attack commands, 3,797 retained combat events, and 315 dead units at cutoff;
- 6 successful scripted production placements plus production AI activity;
- 125,867 total requests: 125,844 repaths and 23 leaders.

Actual rendering was nonempty: per-frame median 13 draw calls and 180,060 triangles; p95 was 14 calls and 181,568 triangles in every valid run. rAF interval p50/p95 was 16.7/16.7 ms for all valid runs. This is genuine 60 Hz display callback pacing feeding a 30 Hz fixed-step simulation; wall clock was not accelerated.

## Per-iteration response results

Milliseconds; lower is better. Each run has 23 leader responses and 125,835 measured repath responses.

| Policy / iteration | Leader p50 / p95 / max | Repath p50 / p95 / max | Wall s | Blocked frames | Blocked attempts |
|---|---:|---:|---:|---:|---:|
| FIFO 1 | 6.4 / 10.7 / 10.8 | 4.3 / 36.6 / 234.4 | 121.128 | 26 | 28 |
| FIFO 2 | 6.3 / 36.1 / 40.3 | 3.9 / 52.0 / 297.9 | 122.152 | 58 | 59 |
| Batch 32 / 2 | 8.9 / 21.1 / 21.3 | 5.9 / 46.6 / 241.7 | 121.525 | 38 | 39 |

Ordered iteration-2 delta, batch 32 minus FIFO 2:

| Leader p95 | Repath p95 | Repath p50 | Blocked frames | Wall |
|---:|---:|---:|---:|---:|
| −15.0 ms | −5.4 ms | **+2.0 ms** | −20 | −0.627 s |

This single ordered comparison shows the desired tail/blocked-frame response shape, but also shows the median repath cost. There is no repeated-win claim. FIFO 1 is unpaired because its batch-32 counterpart is truncated.

## Pooled descriptive distributions

These pools are unbalanced (FIFO 2 samples, batch 32 1 sample) and are not adoption evidence.

| Policy | Leader response p50 / p95 / max | Repath response p50 / p95 / max | Mean wall s | Blocked frames |
|---|---:|---:|---:|---:|
| FIFO | 6.3 / 10.8 / 40.3 | 4.1 / 42.9 / 297.9 | 121.640 | 84 |
| Batch 32 | 8.9 / 21.1 / 21.3 | 5.9 / 46.6 / 241.7 | 121.525 | 38 |

## Queue, compute, apply, frame, and render CPU

Per-iteration p95 / max, milliseconds. Worker queue is diagnostic cross-agent-clock telemetry; raw negative values, if any, remain unclamped in raw data. Render CPU is main-thread snapshot/render preparation plus WebGL submission, **not GPU duration**.

| Policy / iteration | Leader queue | Repath queue | Leader compute | Repath compute | Apply | Frame interval | Render CPU |
|---|---:|---:|---:|---:|---:|---:|---:|
| FIFO 1 | 1.2 / 1.2 | 32.8 / 234.7 | 0.3 / 0.8 | 0.2 / 20.0 | 0 / 1.5 | 16.7 / 300.0 | 1.5 / 299.2 |
| FIFO 2 | 32.6 / 36.3 | 51.4 / 297.6 | 0.3 / 0.4 | 0.3 / 50.5 | 0 / 3.4 | 16.7 / 299.9 | 1.4 / 295.4 |
| Batch 32 / 2 | 5.5 / 5.5 | 31.8 / 232.5 | 0.9 / 1.0 | 0.3 / 33.0 | 0 / 3.4 | 16.7 / 333.3 | 1.6 / 344.6 |

Chrome's 0.1 ms timer quantization makes displayed zero apply p95 below resolution, not proof of zero work. Long max frame/render outliers are retained rather than hidden by p95.

## Transport, snapshots, and coalescing

| Policy / run | Request messages | Result messages | Full snapshot bytes | Delta bytes | Result waypoint bytes | Eligible | Coalesced |
|---|---:|---:|---:|---:|---:|---:|---:|
| FIFO, each valid run | 125,867 | 125,858 | 14,400 | 185 | 1,010,744 | 0 | 0 |
| Batch 32 / 2 | 5,878 | 5,877 | 14,400 | 185 | 1,010,744 | 0 | 0 |

Batch 32 reduces request messages by **95.33%** in the valid sample. Result-message counts are lower than total requests because not-yet-due requests can remain outstanding at the tick-3,600 cutoff; final queue depth is 16 in every valid run. No response loss is inferred from that difference.

Every repath group key is `unshared-repath:<request ID>`; therefore eligible=0 and coalesced=0 exactly. **No deduplication benefit is claimed.** Maximum worker snapshot occupancy is 2 snapshots / 28,800 bytes and maximum path-cache occupancy is 32.

## Gameplay, replay, and correctness

All valid runs have exactly:

- 567 active-at-cutoff, 315 dead, 118 completed;
- final full-state hash `ddafe92c5839f9c087f8606d711e6aee604928babe096c48610764037dd765c1`;
- final pending queue depth 16;
- issue→apply = 2 ticks for every recorded application/discard.

The two full-length delayed Node A* oracles have that same hash and outcomes. All **3/3 valid Chrome runs** match their corresponding Node run for all 600-tick milestones, final hash, request count, per-unit outcomes, and recorded application timing. The 30-tick browser/Node smoke hashes also match.

Focused [clean-scheduler.test.ts](clean-scheduler.test.ts) covers 34 delayed/out-of-order/duplicated requests with ascending application for each policy, clean handle-only requests, revision stale discard, and two-tick application. Existing A*/engine/scheduler/full-game tests also pass.

Passed commands:

```sh
npx tsc --noEmit
npx tsc -p scratch/navigation-renderer-paced/dense/tsconfig.json
npx vitest run scratch/navigation-renderer-paced/dense/clean-scheduler.test.ts \
  tests/path/astar.test.ts tests/path/engine.test.ts tests/path/scheduler.test.ts \
  scratch/full-game-movement/harness/browser/full-game/full-game.test.ts
# 5 files, 37/37 tests passed
```

## Exact measurement and analysis commands

From repository root:

```sh
# Full delayed logical oracles
npx tsx scratch/navigation-renderer-paced/dense/run-node.ts \
  --policy fifo --ticks 3600 --delay 10 --name node-fifo-delayed-full
npx tsx scratch/navigation-renderer-paced/dense/run-node.ts \
  --policy batch-32 --ticks 3600 --delay 10 --name node-batch32-delayed-full

# Combined same-browser rotation (may exceed a 300 s outer process cap)
node scratch/navigation-renderer-paced/dense/run-browser.mjs --iteration 1

# One-policy continuation; fresh page/worker, 120-tick warmup, 3,600 measured ticks
node scratch/navigation-renderer-paced/dense/run-browser.mjs --iteration 2 --policy batch-32
node scratch/navigation-renderer-paced/dense/run-browser.mjs --iteration 2 --policy fifo

# Derive tables and replay checks from complete raw files only
python scratch/navigation-renderer-paced/dense/analyze.py \
  > scratch/navigation-renderer-paced/dense/results/analysis-console.json
```

Environment: headless Chrome 156.0.8078.47, Playwright, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0, Node 24.21.0, 1280×720 viewport. Warmup and measured walls exclude session/renderer setup, as in the prior harness.

## Missing evidence and limitations

1. **Five samples per policy and five same-session rotated pairs are missing.** Valid counts are FIFO 2, batch 32 1, compliant same-session pairs 0. No adoption or repeated-win conclusion is possible.
2. Wall and repath-p50 are unresolved adoption gates. The sole ordered comparison improves wall by 0.627 s but worsens repath p50 by 2.0 ms; no acceptable-tradeoff threshold or repetition requirement is met.
3. This is an adapted production-components session, not the unmodified application entry. Full UI/audio/post-processing/fog-culling/render-overlay composition and production render capacity are not covered.
4. Raw request metrics preserve IDs, due ticks, revisions, classes, group keys, outcomes, and timing; deterministic source defines endpoints/seeds/planes and replay verifies resulting state. However the valid raw files do **not** export every request's endpoint and seed, so a standalone request-by-request endpoint/seed audit remains missing.
5. Only headless Chrome arm64 is measured. No Firefox/WebKit/Safari, x64, visible-browser, GPU-time, heap/GC, naval/owner-plane, or multi-worker performance evidence exists.
6. Render CPU excludes GPU completion. Queue crosses agent clocks and remains diagnostic. Scalar structured-clone wire bytes are not measured; binary snapshot/delta/waypoint bytes are exact.
7. Failed workload-development attempts (initial static placement occupancy and edge formation endpoints) were not performance samples and are not included. The final inward/dynamic-placement workload is the only full-length oracle/Chrome workload analyzed here.

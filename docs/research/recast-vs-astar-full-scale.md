# Corrected integrated Recast versus A* at full scale

Wayfinder: **“Does corrected integrated Recast beat A* at full scale?”** (#173)

## Decision

**No. Do not promote Recast. Retain current A\* and versioned FIFO as the production controls.**

The corrected integrated exact-tile Recast candidate is exactly correct at full scale and is faster in wall time in **12/12** paired Chrome samples (mean wall −2.0 s dense, −2.5 s mixed, −2.1 s across the three uncontaminated narrow pairs). It also improves repath response p95 in **8/8** dense and mixed samples. But it fails the promotion rule on latency where it matters most:

- **Leader response is far worse in 11/12 samples** (+104 to +223 ms versus same-iteration A\*). The first leader request pays for the initial 225-tile navmesh build (130–250 ms of compute on that one request); the remaining leaders queue behind it. A\* leaders answer in 17–32 ms. Recast leaders answer in 132–251 ms.
- **Repath response p50 is worse** in 3/4 mixed and 4/4 narrow samples.
- **On the narrow/mutation workload Recast is worse on repath p95 in the 3 uncontaminated samples** (49.8–54.5 ms versus 33.8–43.7 ms) and blocks roughly twice as many frames (~296–314 versus 130–177). The one incremental revision build (65.6–74.4 ms, 25 halo-inclusive tiles, 200 reused layers) stalls the FIFO worker queue, and steady-state queueing is slightly higher than A\* throughout.

Full-game outcomes do not rescue the trade: dense and mixed finish with the **identical** logical replay and final full-state hash as A\*; narrow completes 500 units versus A\*'s 487, but on a different, oracle-exact request stream. Recast therefore earns no production adoption. The precise loss points are the lazy initial build charged to the first query, and narrow-workload queueing. Any future Recast re-gate must first move the initial build off the first leader's critical path (for example build-on-registration) and then re-run this gate; that change was not made or measured here. The clean handle/provider production direction is unchanged; the harness-only `slice()` adaptation remains non-production. No production scheduler change and no A\* route fallback were made.

## Evidence base (primary sources)

All measurements are this ticket's own runs. Raw artifacts and the code that produced them:

- Gate driver: [`scratch/navigation-queue/gate-173/run-gate.mjs`](../../scratch/navigation-queue/gate-173/run-gate.mjs) (new in this ticket; drives both existing harnesses in one Chrome session per scenario).
- A\* arm: [`scratch/navigation-batch-only/`](../../scratch/navigation-batch-only/) harness (the #171 batch-only study harness), policy `fifo`, served by a Vite dev server exactly as in #171. Candidate `queue-fifo-snapshot-astar` over production A\* with its 32-entry LRU.
- Recast arm: [`scratch/navigation-queue/recast-combined/integrated/`](../../scratch/navigation-queue/recast-combined/integrated/) (the #171 integrated candidate, unmodified source), served from a fresh Vite production build preview exactly as in #171. Candidate `combined-exact-tile-recast-versioned-snapshots`, corrected one-tile neighbor-halo builder in [`exact-tile-cache.ts`](../../scratch/navigation-queue/recast-combined/exact-tile-cache.ts).
- Raw Chrome samples: `scratch/navigation-queue/gate-173/results/chrome-{astar,recast}-{dense,mixed,narrow}-iter{1..4}.json` (24 files).
- Derived distributions: [`scratch/navigation-queue/gate-173/analyze.mts`](../../scratch/navigation-queue/gate-173/analyze.mts) → `results/distribution-173.json`. Percentiles are nearest-rank; leaders are requests with `commandTick === 1`, repaths those with no `commandTick` (definitions imported from [`scratch/phase2-navigation/browser-distribution/metrics.mts`](../../scratch/phase2-navigation/browser-distribution/metrics.mts), same as #171).
- Verification: [`scratch/navigation-queue/gate-173/verify.mts`](../../scratch/navigation-queue/gate-173/verify.mts) → `results/verification-173.json` (`allPassed: true`).
- Node Recast oracles (corrected full-rebuild Recast, `recast-corridor-supercover-cs0.25-full-rebuild` via `integrated/run-node.ts`): `results/node-recast-oracle-{dense,mixed,narrow}-p1000-t3600.json`.
- Preserved Node A\* references: `scratch/full-game-movement/harness/results/{scenario}-p1000-sync.json` (candidate `current-integer-astar`, p1000/t3600, pre-existing files, unmodified).
- Node WASM-memory probe: [`scratch/navigation-queue/gate-173/memory-probe.ts`](../../scratch/navigation-queue/gate-173/memory-probe.ts) → `results/node-memory-probe.json`.
- Baselines: [`docs/research/navigation-batch-only-policies.md`](navigation-batch-only-policies.md) (#171) and [`scratch/navigation-queue/recast-combined/report-171.md`](../../scratch/navigation-queue/recast-combined/report-171.md).

Environment: headless Chrome **156.0.8078.76**, Apple M1 arm64, 8 logical CPUs, 16 GiB RAM, Darwin 23.6.0, Node v24.22.1 (host block recorded in every raw sample). The machine was shared during the runs (recorded load average 7.1 at gate start, observed 7–11 on 8 CPUs); rotation/interleaving is the control for that, and one visibly contaminated sample is flagged below rather than silently pooled.

## Method

- **Workloads.** Three versioned scenario fixtures (`scratch/full-game-movement/harness/fixtures/scenarios.json`), each at population 1000, 3600 ticks, 120×120:
  - `dense-open-120` (dense congestion: 1 group, open map, 46,289 requests/sample);
  - `mixed-destinations-120` (the #171 headline trace: 8 groups, open map, 46,807 requests/sample);
  - `narrow-mutation-120` (2 groups crossing a 4-tile gate in a wall; gate closes at tick 2 and reopens at tick 120; 4 building placements at tick 2; Recast 53,098 requests/sample, A\* 53,709).
- **Queue policy.** FIFO single-request messages for both engines — the primary controlled comparison the ticket specifies. A\* `maxBatchSize` is verified = 1 in every sample. Batch 32 was **not** run as a secondary arm: the integrated Recast transport has no batch mode (its adapter posts one `versioned-path` message per request), and the ticket allows batch only if applied equally to both engines. See Limitations.
- **Transport.** Both arms use the versioned full/delta snapshot protocol family from #171: one full registration (14,400 bytes), then revision deltas ahead of dependent requests, acknowledgments, monotonic IDs, `dueTick = issueTick + 2`, scheduler-owned ascending application and stale discard. The two adapters are sibling implementations (batch-only adapter for A\*, integrated adapter for Recast) over the same production `World.step` async-runner lineage and the same scheduler instrumentation; they are not literally one shared transport file. That is the comparison the baselines define.
- **Sampling.** Per scenario: 4 iterations in one Chrome session, engine order alternating A\*→Recast, Recast→A\*, A\*→Recast, Recast→A\*. Fresh page per sample. Each sample runs one 400-tick warmup on a fresh worker, then the measured p1000/t3600 run on another fresh worker (the #171 warmup shape for both arms).
- **Artifact modes.** A\* via Vite dev server, Recast via Vite production-build preview — each matching its own #171 evidence mode. Disclosed as a residual confound in Limitations.
- **Timing fields.** Response = main-thread issue→worker-response `performance.now()` (single clock, comparable). Queue = post→worker-receipt telemetry (crosses agent clocks; diagnostic). Compute = worker `engine.handle` time. “Delivery residual” below = response − queue − compute; because queue crosses clocks it mixes true one-way delivery with clock error and is never used for selection (same honesty rule as #171). A\* samples also carry the #171 64-probe main-clock RTT diagnostic (pooled p95 0.1 ms in these runs; not one-way delivery, not used for selection).

A pre-driver pilot (`integrated/results/chrome-pilot173-narrow-p1000.json`, one Recast narrow sample, no warmup) was used only to prove runnability and is excluded from all numbers below.

## Correctness gate (all 24 samples)

Verified by `gate-173/verify.mts` against independent oracles (`verification-173.json`, exit 0):

| Check | Dense | Mixed | Narrow |
|---|---:|---:|---:|
| Recast routes exact vs full-rebuild Node Recast (ordered id/ok/cost/every waypoint) | 46,289/46,289 ×4 | 46,807/46,807 ×4 | 53,098/53,098 ×4 |
| Recast logical replay + final hash = Node Recast oracle | ✓ ×4 | ✓ ×4 | ✓ ×4 |
| A\* logical replay + final hash = preserved Node A\* | ✓ ×4 | ✓ ×4 | ✓ ×4 |
| False no-path (Recast no-path where oracle found a route) | 0 | 0 | 0 (16 true no-paths per sample, both engines) |
| Protocol violations (IDs 1..n, due = issue+2, applied ⇒ issue→apply = 2 ticks, ack/send match, register-then-updates) | 0 | 0 | 0 |
| Bounded stores (Recast worker snapshots ≤ 2 / ≤ 28,800 B, revision cache ≤ 2; A\* snapshots ≤ 2, path cache ≤ 32) | ✓ | ✓ | ✓ |
| Geometry rejections / native query failures / worker errors (Recast) | 0 | 0 | 0 |
| Repeat stability (all 4 iterations same final hash per engine) | ✓ | ✓ | ✓ |
| WASM SHA-256 browser = Node (`6fe3c900…c6bc9`) | ✓ | ✓ | ✓ |

Final full-state hashes: dense `3bebb849…f1038` and mixed `3f162961…6c2bb` are **the same for Recast, A\*, and both Node oracles** — on the open maps the two engines produce logically identical games. Narrow differs by engine as expected from different route geometry: Recast `9b81f04f…30dc`, A\* `f464e6b5…` (each equal to its own Node oracle).

Named mutation/churn cases, re-run in this ticket:

- Mutation stress matrix (`integrated/stress.ts`, engine-level vs full-rebuild oracle): **30/30 exact** — repeated one-tile gate close/reopen ×20 revisions, building add/remove, five-rectangle burst, 104×104 multi-tile obstacle/reopen (the halo case), 576 isolated blocked cells. Output: `integrated/results/mutation-stress.json` re-generated, `passed: true`.
- Focused protocol/race tests (`integrated/integrated.test.ts`): **8/8 passed** — includes reversed/out-of-order delivery against the bounded two-revision store, same-version/different-byte ephemeral builds, delayed (20 ms) delivery with blocked-frame recovery, and injected native-engine failure surfacing as a visible fatal worker error with no fabricated no-path.
- Strict TypeScript (`tsc -p …/integrated/tsconfig.json`): passed.
- In-game narrow mutations at full scale are covered by the 8 narrow Chrome samples above (gate close/reopen + 4 buildings, one coalesced revision update per Recast sample, exact routes throughout).
- Built-worker Chrome smoke after the fresh build: passed (`integrated/results/chrome-gate173-smoke-built.json`, route `(0,4) → (11,4)`, one clean acknowledgment, zero worker errors).

Endpoints/gates are exact by construction of the check: route equality compares the complete ordered waypoint arrays, including first and last points, plus `ok` and cost, for every one of the ~584k Recast routes across the 12 samples.

## Per-iteration headline results

Milliseconds except wall seconds. Lower is better. Leader n per sample: dense 1, mixed 8, narrow 2 (initial `commandTick === 1` requests; narrow also has 2 later-command requests per sample, counted as neither class — see distribution file). With n = 1–2, leader “p95” is effectively the maximum; the leader effect size is nevertheless two orders of magnitude and is mechanistically explained by the compute column in the pooled diagnostics.

### Dense (`dense-open-120`, 46,289 requests/sample, both engines)

| Sample | Leader resp p95 | Repath resp p50 / p95 / max | Wall s | Blocked |
|---|---:|---:|---:|---:|
| A\* 1 | 28.2 | 40.8 / 146.2 / 222.3 | 33.863 | 1030 |
| A\* 2 | 26.1 | 35.7 / 124.3 / 220.2 | 33.036 | 900 |
| A\* 3 | 28.9 | 40.0 / 133.6 / 227.5 | 33.664 | 964 |
| A\* 4 | 17.2 | 29.7 / 98.2 / 163.6 | 30.831 | 676 |
| Recast 1 | 250.9 | 37.7 / 97.8 / 154.9 | 30.371 | 882 |
| Recast 2 | 173.8 | 36.7 / 101.4 / 153.2 | 30.750 | 873 |
| Recast 3 | 185.0 | 38.2 / 97.7 / 143.7 | 32.760 | 880 |
| Recast 4 | 151.1 | 31.6 / 88.6 / 237.7 | 29.573 | 762 |

Recast − A\* per iteration: leader p95 **+222.7 / +147.7 / +156.1 / +133.9**; repath p95 −48.4 / −22.9 / −35.9 / −9.6; repath p50 −3.1 / +1.0 / −1.8 / +1.9; wall −3.49 / −2.29 / −0.90 / −1.26 s; blocked −148 / −27 / −84 / +86. Completed 528/1000, identical both engines.

### Mixed (`mixed-destinations-120`, 46,807 requests/sample, both engines)

| Sample | Leader resp p95 | Repath resp p50 / p95 / max | Wall s | Blocked |
|---|---:|---:|---:|---:|
| A\* 1 | 32.2 | 29.6 / 149.3 / 209.2 | 30.258 | 900 |
| A\* 2 | 25.9 | 26.5 / 95.8 / 126.6 | 28.347 | 670 |
| A\* 3 | 19.2 | 30.7 / 146.2 / 193.3 | 29.654 | 896 |
| A\* 4 | 24.1 | 25.1 / 90.6 / 116.3 | 28.483 | 592 |
| Recast 1 | 136.6 | 29.3 / 77.4 / 96.3 | 26.366 | 705 |
| Recast 2 | 145.0 | 30.1 / 80.4 / 111.5 | 26.204 | 749 |
| Recast 3 | 159.6 | 31.1 / 82.8 / 157.1 | 26.368 | 764 |
| Recast 4 | 161.0 | 30.4 / 82.7 / 118.4 | 27.935 | 723 |

Recast − A\* per iteration: leader p95 **+104.4 / +119.1 / +140.4 / +136.9**; repath p95 −71.9 / −15.4 / −63.4 / −7.9; repath p50 −0.3 / +3.6 / +0.4 / +5.3; wall −3.89 / −2.14 / −3.29 / −0.55 s; blocked −195 / +79 / −132 / +131. Completed 571/1000, identical both engines.

Cross-check: this run’s A\* FIFO mixed numbers are consistent with #171’s FIFO control (pooled leader p95 32.2 vs 32.1 ms; repath p50/p95 27.4/120.2 vs 31.4/112.8 ms; mean wall 29.19 vs 31.70 s), which supports the harness being the same instrument.

### Narrow/mutation (`narrow-mutation-120`; Recast 53,098 req, A\* 53,709 req)

| Sample | Leader resp p95 | Repath resp p50 / p95 / max | Wall s | Blocked |
|---|---:|---:|---:|---:|
| A\* 1 | 19.5 | 2.1 / 43.7 / 97.7 | 32.162 | 177 |
| A\* 2 † | 2721.2 † | 2.3 / 66.2 / 183.8 | 36.539 | 878 |
| A\* 3 | 29.1 | 2.0 / 33.8 / 80.3 | 31.285 | 130 |
| A\* 4 | 18.3 | 2.1 / 40.3 / 93.3 | 32.026 | 166 |
| Recast 1 | 163.0 | 2.7 / 52.4 / 89.7 | 30.146 | 296 |
| Recast 2 | 173.3 | 3.3 / 49.4 / 94.0 | 31.179 | 309 |
| Recast 3 | 153.4 | 2.9 / 54.5 / 97.0 | 29.251 | 307 |
| Recast 4 | 132.0 | 3.2 / 49.8 / 103.2 | 29.814 | 314 |

† A\* iteration 2 is environmentally contaminated: both leaders show ~2,720 ms of pre-worker queue time with 0.5–2.2 ms compute — a single ~2.7 s delivery stall at run start on a machine running at load 7–11, not A\* compute. It is preserved in the raw data and in pooled numbers (flagged), but no conclusion rests on it: Recast loses narrow leader p95 by +143.5 / +124.3 / +113.7 ms in the three clean iterations, loses repath p50 by +0.6…+1.1 ms in 4/4, and loses repath p95 by +8.7 / +20.7 / +9.5 ms in the three clean iterations. Wall: Recast faster 4/4 (−2.02 / −5.36† / −2.03 / −2.21 s). Completed: Recast 500/1000 vs A\* 487/1000 in every iteration (+13), with 611 fewer requests — a real but second-order outcome difference from different gate-approach geometry; both streams are exact against their own oracles. Outcomes per sample: Recast 53,084 applied / 2 stale-discarded / 12 pending at cutoff; A\* 53,697 / 2 / 10. Dense: 46,287 applied / 2 pending (both). Mixed: 46,802 applied / 5 pending (both).

## Pooled distributions

Pooled over the 4 iterations per engine/scenario. Leader n: dense 4, mixed 32, narrow 8 per engine. Repath n: dense 185,152; mixed 187,196; narrow Recast 212,376 / A\* 214,820.

| Scenario / engine | Leader resp p50 / p95 / max | Repath resp p50 / p95 / max | Mean wall s | Blocked (4 samples) |
|---|---:|---:|---:|---|
| Dense A\* | 26.1 / 28.9 / 28.9 | 35.9 / 127.6 / 227.5 | 32.849 | 1030/900/964/676 |
| Dense Recast | 173.8 / 250.9 / 250.9 | 35.7 / 97.6 / 237.7 | 30.864 | 882/873/880/762 |
| Mixed A\* | 23.5 / 32.2 / 32.2 | 27.4 / 120.2 / 209.2 | 29.185 | 900/670/896/592 |
| Mixed Recast | 145.0 / 161.0 / 161.0 | 30.2 / 80.7 / 157.1 | 26.719 | 705/749/764/723 |
| Narrow A\* | 19.5 / 2721.2† / 2721.2† | 2.1 / 44.0 / 183.8 | 33.003 | 177/878†/130/166 |
| Narrow Recast | 153.4 / 173.3 / 173.3 | 3.0 / 51.5 / 103.2 | 30.097 | 296/309/307/314 |

† Narrow A\* pooled leader p95/max and blocked include the contaminated iteration 2; with n = 8 the nearest-rank p95 is that single stalled value. The per-iteration table is the honest read.

Pooled queue/compute/delivery-residual diagnostics (queue and residual are cross-clock diagnostics, not selection evidence):

| Scenario / engine | Leader queue p95 | Leader compute p50 / p95 / max | Repath queue p50 / p95 | Repath compute p50 / p95 / max | Repath residual p95 |
|---|---:|---:|---:|---:|---:|
| Dense A\* | 26.3 | 2.2 / 3.4 / 3.4 | 35.9 / 127.7 | 0.1 / 0.3 / 11.8 | 3.2 |
| Dense Recast | 1.4 | 172.9 / 249.6 / 249.6 | 35.7 / 97.6 | 0.1 / 0.2 / 16.3 | 5.5 |
| Mixed A\* | 31.2 | 0.5 / 1.7 / 2.1 | 30.0 / 125.3 | 0.1 / 0.2 / 7.1 | 4.2 |
| Mixed Recast | 161.1 | 0.1 / 156.2 / 159.5 | 30.3 / 81.0 | 0.1 / 0.2 / 15.0 | 5.5 |
| Narrow A\* | 2720.4† | 0.5 / 2.2 / 2.2 | 1.3 / 44.0 | 0.0 / 0.2 / 8.0 | 3.9 |
| Narrow Recast | 170.9 | 0.5 / 168.2 / 168.2 | 2.1 / 51.4 | 0.1 / 0.2 / 39.5 | 4.4 |

Reading: response time is queue-dominated for repaths in both engines (compute p95 is 0.2–0.3 ms everywhere); Recast’s repath-p95 win on dense/mixed is a queue-depth/throughput effect, not a per-query compute win. The leader rows show the mechanism of the loss exactly: dense Recast’s single leader carries 172.9–249.6 ms of **compute** (the initial build inside the first `handle` call); in mixed/narrow, one leader carries 130–168 ms of compute and the other leaders show the same figure as **queue**. A\* leader compute never exceeds 3.4 ms. Main-thread tick wall p95 (2.4–6.1 ms) and production apply per active tick p95 (0.1 ms) are effectively identical between engines in every scenario; the simulation side is not where either engine wins or loses. Two stale-discarded narrow rows per sample have an apply tick but no recorded apply cost in both harnesses; the analyzer excludes and counts them (`applyExcludedWithoutCost = 2`) instead of crashing — apply distributions are over the remaining rows.

One A\* sample (mixed iteration 3) shows negative delivery residuals at p50 (−11.5 ms), i.e. its queue telemetry clock offset drifted; its main-clock response numbers are unaffected and its queue/residual values should be read only as “offset by roughly −11 ms”. Raw values are preserved unadjusted, per #171 practice.

## Rebuild and incremental-update costs (Recast)

Per measured sample (engine counters in each raw file; ranges over the 4 iterations):

| Scenario | WASM init ms | Initial full build | Incremental revision build | Total build ms | Rasterized tiles (total) | Reused layers |
|---|---:|---:|---:|---:|---:|---:|
| Dense | 26.6–48.2 | 148.1–247.6 ms (225 tiles) | — (no mutations) | 148.1–247.6 | 225 | 0 |
| Mixed | 24.2–30.4 | 130.1–156.0 ms (225 tiles) | — (no mutations) | 130.1–156.0 | 225 | 0 |
| Narrow | 24.4–34.1 | 127.9–165.7 ms (225 tiles) | 65.6–74.4 ms (25 tiles: 4 directly changed nav tiles + one-tile halo) | 193.5–239.7 | 250 | 200 |

The halo-inclusive counters are the corrected ones (25 rasterized / 200 reused at the narrow revision); the superseded 4-tile/221-layer figures from the pre-fix implementation are not used anywhere in this study. Rasterization dominates build time (narrow totals: rasterize 69.2–94.3 ms, navmesh build 12.3–14.8 ms, geometry 5.1–7.1 ms across both builds). Steady-state Recast per-query work is small: total path-query time 0.65–1.26 s and route-conversion 0.15–0.25 s per ~46–53k-query sample (mean ≈ 0.02 ms/query), revision-cache hits ≥ 99.99%, zero evictions, zero ephemeral/out-of-order rebuilds in all Chrome samples. A\* has no build step; its per-revision cost is snapshot preparation only (2 preparations on narrow, 1 elsewhere), which is precisely the asymmetry the leader numbers expose.

## Transport: messages and bytes

Per measured sample; identical across iterations of a scenario (wire counts are deterministic given the request stream):

| Scenario | Engine | Request msgs | Result msgs | Full snapshot B | Delta B | Response waypoint B | Request protocol B |
|---|---|---:|---:|---:|---:|---:|---:|
| Dense | A\* | 46,289 | 46,289 | 14,400 | 0 | 369,976 | — (not instrumented) |
| Dense | Recast | 46,289 | 46,289 | 14,400 | 0 | 369,976 | 9,063,341–9,119,122 |
| Mixed | A\* | 46,807 | 46,807 | 14,400 | 0 | 374,216 | — |
| Mixed | Recast | 46,807 | 46,807 | 14,400 | 0 | 374,216 | 9,182,971–9,211,219 |
| Narrow | A\* | 53,709 | 53,709 | 14,400 | 80 | 599,936 | — |
| Narrow | Recast | 53,098 | 53,098 | 14,400 | 80 | 600,116 | 10,406,153–10,469,811 |

Binary payload burden is effectively at parity: identical snapshot traffic (one 14,400-byte registration; one 80-byte delta on narrow) and response-waypoint bytes within 180 bytes of each other (identical on dense/mixed, where the logical streams match). Recast additionally ships the WASM binary once per worker (339,385 bytes, SHA-256 `6fe3c90073fb734bd98eb0a38daec269552aa8564f639ec458219d72d09c6bc9`, recorded in each sample’s provenance) plus 24–48 ms initialization per fresh worker. Scalar structured-clone request bytes are instrumented only on the Recast side (~195 B/request); the A\* harness does not expose the equivalent counter, so no cross-engine scalar-byte claim is made.

## Memory

Exact, engine-reported occupancy (from `candidateMetrics` in every raw sample):

- Recast worker snapshot store: ≤ 2 revisions, ≤ 28,800 bytes (verified per-response, not just at end of run). Main thread retains 1 snapshot / 14,400 bytes.
- Recast compressed tile layers: 28,143 bytes (open maps), 29,555 bytes (narrow). Revision cache: ≤ 2 entries (capacity 2). A\*: worker snapshots ≤ 2 / ≤ 28,800 bytes on narrow (1 / 14,400 elsewhere), path cache ≤ 32 entries.

Native WASM memory/allocator occupancy inside Chrome is **not directly measurable through this harness**, and this study proves the gap instead of asserting a number: the driver polled `performance.memory` inside every live worker every ~2 s during all 24 samples (~19–24 polls per sample, recorded in each file’s `memoryProbe`); every successful poll in both engines’ workers returned `hasMemory: false` — Chrome 156 does not expose `performance.memory` in these dedicated workers — and a worker-global scan found no exported WASM `Module`/memory handle on `globalThis` (only unrelated `GPU*` names). Workers are terminated by `candidate.dispose()` at run end, so post-run probing is impossible. Main-thread `performance.memory` after each measured run is recorded in the raw files (used JS heap 9–121 MB, dominated by the retained ~40–60 MB result object graph and GC timing); it is not an engine cost and is not compared.

What can be bounded is bounded, in Node (`gate-173/memory-probe.ts`, `process.memoryUsage()` around the real combined engine on a 120×120 walled map): WASM initialization grows Node `external` by 71.3 MB (module + linear-memory reservation under Node’s accounting; `arrayBuffers` +3.0 MB) and RSS from 96 MB to 110 MB; the initial 225-tile build adds only +0.10 MB external (+1.16 MB arrayBuffers); the first halo-inclusive incremental revision adds +2.6 KB external; after 10 gate-revision churn cycles and 1,000 further queries, `external` is within ±1.2 MB of its post-build value and ends **below** it (74.74 MB vs 75.66 MB) — no per-revision or per-query growth trend in Node. That is a Node-process bound, not a Chrome allocator measurement; total in-browser native footprint beyond the exact snapshot/layer counts above remains unmeasured. (The probe’s build-time fields are 0 because it passes a zero clock; only its memory rows are cited.)

Visible-failure handling is present and re-verified, with one bounded residual gap: worker `onerror`/`onmessageerror` and protocol `error` messages propagate as fatal candidate errors (adapter `fail()`), native/engine exceptions are posted as errors rather than converted to no-path, and the injected-native-failure test (8/8 suite above) proves a request-scoped fatal error with no fabricated route. All 24 Chrome samples recorded zero worker errors. Not tested here (same bound as report-171): a forced WASM trap, worker-process crash, or OOM inside real Chrome, and recovery/restart after such a failure.

## Where Recast loses, precisely

1. **First-query build charge (the decisive loss).** The engine builds a revision’s navmesh lazily inside the first path query that needs it. At 120×120 that is a 148–248 ms full build (225 tiles) billed to leader #1’s compute, with every other tick-1 leader queued behind it. A\* answers the same leaders in 17–32 ms total. No queue policy can fix this within FIFO; batching would not either (the build is compute, not message overhead).
2. **Revision builds stall the FIFO queue.** On narrow, the single halo-inclusive incremental build costs 65.6–74.4 ms of worker time during which no queued request progresses; narrow repath p95 and blocked frames are worse than A\* in every clean sample, and repath queue p50 is higher even away from the mutation (2.1 vs 1.3 ms pooled).
3. **Median repath latency.** Even where Recast wins the p95 queue battle (mixed), its p50 is 0.4–5.3 ms worse in 3/4 samples; on narrow it is worse 4/4. Steady-state per-request overhead (query + supercover route conversion + protocol) is slightly higher than A\*’s cached grid search at this map size.
4. **Cold-start and footprint costs A\* does not have:** 339,385-byte WASM download/compile per worker (24–48 ms init), native memory that cannot be fully accounted in-browser with current tooling, and a fresh TileCache/NavMesh container per revision (incremental rasterization only).

Where Recast genuinely wins, for the record: wall time 12/12 (−0.5 to −3.9 s per sample), repath p95 on dense/mixed 8/8 (pooled 97.6 vs 127.6 ms dense; 80.7 vs 120.2 ms mixed), blocked frames on dense 3/4, and +13 completions on narrow. Under the ticket’s promotion rule — repeated latency **and** full-game outcome wins with exact correctness — a 5–8× leader-latency regression and a narrow-repath regression disqualify it despite those wins.

## Limitations and skipped clauses

1. **Batch-32 secondary arm: not run.** The Recast integrated transport implements FIFO only; the ticket permits batch 32 solely as an equal arm on both engines (“may”). Adding batching to the Recast worker would measure a new harness feature, not the candidate as corrected in #171, so the primary FIFO comparison stands alone. Batch 32’s own production gate remains #172’s question, not this ticket’s.
2. **Artifact-mode asymmetry.** A\* ran from a Vite dev server and Recast from a production-build preview (each as in its #171 baseline). Worker compute is the dominant term in response timings and is unaffected by page bundling; wall time includes main-thread simulation, where minified Recast page code could confer a small advantage. Read Recast’s wall wins with that caveat; the leader/repath response conclusions do not depend on it.
3. **Shared-machine noise.** Load averaged 7–11 on 8 CPUs during the matrix (a second research workload was active). Rotation balances order effects, and A\*’s mixed numbers reproduce #171’s closely, but absolute latencies are inflated versus an idle machine. One sample (A\* narrow iteration 2) absorbed a ~2.7 s stall and is flagged wherever it appears; it was neither re-run nor deleted.
4. **Leader sample sizes are tiny** (1–8 per run, by scenario design). Leader percentiles are therefore coarse; the conclusion rests on per-iteration direction (11/12, margins ≥ 104 ms) plus the compute-field mechanism, not on percentile precision.
5. **In-browser native WASM allocator occupancy unmeasured** — proven unavailable via `performance.memory` in these workers and no exposed memory handle; bounded instead by exact snapshot/layer byte counts and the Node probe (see Memory).
6. **No forced WASM trap / worker crash / OOM test in Chrome.** Visible-error plumbing and engine-exception injection are verified; crash recovery is not claimed.
7. Headless Chrome arm64 only, one map size (120×120), binary flat passability only (as in #171). No renderer-paced production session, no naval/owner-plane performance run, no x64 or non-Chrome evidence, no independent WASM build.
8. Delivery is reported as a cross-clock residual (plus A\*’s main-clock RTT diagnostic); there is still no honest one-way delivery number for either engine in this harness family. One A\* sample’s queue clock offset drifted ≈11 ms (noted above).
9. The Recast transport retains the harness-only `slice()` snapshot adaptation from #171. It is part of the measured candidate and is still explicitly not the production design; the clean handle/provider API remains future work. No production files were changed by this ticket.

## Reproduction

From `/Users/jamesmoss/Documents/game` (branch `research/df-rw-deep-sim`):

```sh
# Fresh production worker bundle for the Recast arm.
npx vite build --config scratch/navigation-queue/recast-combined/integrated/vite.config.ts

# Chrome matrix (fresh page/worker per sample, 400-tick warmup, 4 rotated iterations each).
node scratch/navigation-queue/gate-173/run-gate.mjs --scenario dense-open-120 --iterations 4
node scratch/navigation-queue/gate-173/run-gate.mjs --scenario mixed-destinations-120 --iterations 4
node scratch/navigation-queue/gate-173/run-gate.mjs --scenario narrow-mutation-120 --iterations 4

# Corrected full-rebuild Node Recast oracles (one per scenario).
npx tsx scratch/navigation-queue/recast-combined/integrated/run-node.ts --scenario dense-open-120 --population 1000 --ticks 3600 --name gate173-node-recast-dense-open-120
npx tsx scratch/navigation-queue/recast-combined/integrated/run-node.ts --scenario mixed-destinations-120 --population 1000 --ticks 3600 --name gate173-node-recast-mixed-destinations-120
npx tsx scratch/navigation-queue/recast-combined/integrated/run-node.ts --scenario narrow-mutation-120 --population 1000 --ticks 3600 --name gate173-node-recast-narrow-mutation-120
cp scratch/navigation-queue/recast-combined/integrated/results/gate173-node-recast-dense-open-120.json scratch/navigation-queue/gate-173/results/node-recast-oracle-dense-p1000-t3600.json
cp scratch/navigation-queue/recast-combined/integrated/results/gate173-node-recast-mixed-destinations-120.json scratch/navigation-queue/gate-173/results/node-recast-oracle-mixed-p1000-t3600.json
cp scratch/navigation-queue/recast-combined/integrated/results/gate173-node-recast-narrow-mutation-120.json scratch/navigation-queue/gate-173/results/node-recast-oracle-narrow-p1000-t3600.json

# Exactness + protocol verification, then distributions.
npx tsx scratch/navigation-queue/gate-173/verify.mts
npx tsx scratch/navigation-queue/gate-173/analyze.mts

# Mutation/churn correctness, focused races, typecheck, smoke, memory bound.
npx tsc -p scratch/navigation-queue/recast-combined/integrated/tsconfig.json
npx vitest run scratch/navigation-queue/recast-combined/integrated/integrated.test.ts
npx tsx scratch/navigation-queue/recast-combined/integrated/stress.ts
node scratch/navigation-queue/recast-combined/integrated/run-browser.mjs --built --smoke --name gate173-smoke-built
NODE_OPTIONS=--expose-gc npx tsx scratch/navigation-queue/gate-173/memory-probe.ts
```

Note: `run-gate.mjs` refuses to overwrite existing sample files; move `gate-173/results/chrome-*.json` aside before a fresh matrix. The driver imports `playwright` from `~/node_modules` (as the #171 runners do) and launches the installed Chrome channel.


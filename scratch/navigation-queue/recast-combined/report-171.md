# Wayfinder #171 — integrated combined Recast correctness checkpoint

## Verdict

**The requested integrated correctness gate passes for the tested narrow mutation replay and focused mutation/race matrix.** The combined exact-tile engine now runs behind the acknowledged full/delta snapshot protocol in a real Vite-built module-WASM worker. Corrected full-rebuild Recast remains the only route oracle; there is no A* route fallback.

Evidence completed in this checkpoint:

- Strict TypeScript: passed.
- Focused automated tests: **8/8 passed**.
- Original Node replay: **199/199 exact routes**, zero mismatches.
- Integrated delayed-delivery Node replay: **199/199 exact routes**, logical equality, final-hash equality.
- Built-worker real-Chrome replay: **199/199 exact routes**, logical equality, final-hash equality.
- Final full-state hash in all three p40/t400 comparisons: `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f`.
- Mutation stress matrix: **30/30 exact route responses across 5/5 cases**.
- Vite production build and built-worker one-tile Chrome smoke: passed.

This remains a research candidate, not a production integration or performance result. No production scheduler/source file was modified. The snapshot cache's private-array `slice()` override is retained only as the acknowledged scratch adaptation to today's scheduler; it is not presented as the clean production design. No scale benchmark, latency comparison, throughput claim, CPU claim, or A*/Recast performance comparison was run.

## Integrated implementation

All new integration work is under `scratch/navigation-queue/recast-combined/integrated/`. The one correctness fix to the existing exact-tile builder is in `scratch/navigation-queue/recast-combined/exact-tile-cache.ts`. The prior `report.md` is unchanged.

### Protocol and worker

- `protocol.ts`: full registration, base-revision delta update, versioned path request, snapshot acknowledgment, path result, readiness, post telemetry, and visible error messages.
- `worker-handler.ts`: independent land/naval/owner stores; two immutable snapshot revisions per plane; dimension/base/revision validation; exact snapshot bytes passed to `CombinedRecastEngine`; bounded occupancy and disposal.
- `combined.worker.ts`: real module-worker wiring, asynchronous Recast/WASM initialization, readiness gate, FIFO handling after readiness, waypoint transfer, and request/initialization error events. Native/engine exceptions are posted as errors rather than converted into no-path responses.
- `adapter.ts`: scheduler-facing transport, snapshot registration/update ahead of dependent requests, request IDs and due ticks, route capture, telemetry, readiness timeout, fatal-error propagation, and real browser worker construction.
- `snapshot-cache.ts`: donor main-thread one-current-snapshot cache and full/delta preparation. Its `slice()` adaptation is harness-only.
- `async-runner.ts`: donor asynchronous production `World.step` harness, restricted to the combined candidate; scheduling, due-tick blocking, ascending application, stale discard, movement, placement, and collision behavior remain unchanged.

### Exact-tile correctness fix

The first integrated 104×104 mutation test exposed a false no-path. The combined candidate returned `ok=false` with one geometry rejection, while corrected full Recast returned:

```text
(0,0) -> (112,7) -> (119,119), cost 224437
```

Raw before/after diagnosis: `integrated/results/large-mutation-diagnosis.json`; diagnostic command/source: `integrated/diagnose-large.ts`.

The obstacle ends on nav-tile boundaries. Recast's three-cell rasterization border means a mutation can affect a neighboring tile's compressed layer even when that neighbor owns no changed passability byte. `buildExactTileCache` now re-rasterizes the directly touched tiles plus their one-tile neighbor halo. `changedNavTiles` records direct changes; `rasterizedNavTiles` records the actual halo-inclusive work.

This changes the original narrow replay's revision-6 counters from the old report's 4 rasterized/221 reused to **25 rasterized/200 reused** (225 total layers). Four nav tiles contain directly changed cells; the halo expands actual rasterization to 25. Exact routes and final state are unchanged. The new counters supersede the old implementation's counters, not the old report's historical record.

This is still incremental rasterization with a fresh TileCache/NavMesh container per revision, not a fully incremental navmesh container update.

## Focused automated gate

Source: `integrated/integrated.test.ts`. Raw final Vitest output: `integrated/results/vitest.json`.

The eight tests cover:

1. Ten one-tile gate close/reopen cycles with exact ID/status/cost/waypoint equality and repeated-route equality.
2. A 104×104 multi-tile obstacle and reopen, including the border-halo case.
3. 576 isolated blocked cells with exact parity and no dynamic-obstacle/capacity fallback.
4. Two-entry mesh LRU eviction, cached stale requests, evicted out-of-order requests, same-version/different-byte ephemeral builds, and bounded snapshot bytes.
5. Independent planes and two-immutable-revision full/delta worker storage/eviction.
6. Reversed response delivery, a missing due response blocking the pump, ascending application, stale discard, duplicate suppression, and preserved IDs/due ticks.
7. Injected native-engine failure visibility at the local worker engine seam: an `injected native findPath failure` becomes a request-scoped fatal worker error and produces no route/no-path response.
8. A delayed (20 ms) local-transport p40/t400 replay against corrected Node Recast: exact route stream, logical replay, final hash, full/delta acknowledgments, bounded snapshots, IDs/due ticks, and blocked-frame recovery.

The native failure injection is deliberately at the engine boundary in the real protocol handler; it is not a forced WASM memory corruption or browser-process crash test.

## Mutation stress matrix

Source: `integrated/stress.ts`. Raw result: `integrated/results/mutation-stress.json`.

Every response compares exact request ID, `ok`, cost, and every waypoint against corrected full-rebuild Recast.

| Case | Revisions | Exact | Geometry rejections |
|---|---:|---:|---:|
| Repeated one-tile gate close/reopen | 20 | 20/20 | 0 |
| Building add/remove | 3 | 3/3 | 0 |
| Five-rectangle mutation burst | 3 | 3/3 | 0 |
| 104×104 multi-tile obstacle and reopen | 3 | 3/3 | 0 |
| 576 isolated blocked cells | 1 | 1/1 | 0 |
| **Total** | **30** | **30/30** | **0** |

The stress output explicitly sets `performanceComparison: false`; its purpose is correctness only.

## Vite and real-Chrome evidence

Environment recorded in the raw artifacts: headless Chrome **156.0.8078.47**, macOS arm64, Apple M1. The browser and Node oracle used the same WASM SHA-256:

`6fe3c90073fb734bd98eb0a38daec269552aa8564f639ec458219d72d09c6bc9`

### Production build and smoke

The Vite production build emitted the combined module worker and WASM compatibility bundle under `integrated/dist/`. The only build diagnostic was Vite's chunk-size warning for the 727.10 kB WASM compatibility chunk; the build succeeded.

Built-worker smoke raw result: `integrated/results/chrome-smoke-built.json`.

- Readiness: true.
- Route: `(0,4) -> (11,4)` through the one-tile gate.
- One registration and one acknowledgment.
- Worker error count: zero.

### Built-worker p40/t400 replay

Raw browser run: `integrated/results/chrome-combined-p40-t400-built.json`.
Raw corrected Node oracle: `integrated/results/node-combined-oracle-p40-t400.json`.
Derived validator/source: `integrated/validate-replay.mjs` and `integrated/results/replay-validation.json`.

| Check | Result |
|---|---:|
| Browser / Node ordered routes | 199 / 199 |
| Exact route mismatches | 0 |
| Logical replay equal | true |
| Final full-state hash equal | true |
| Final hash | `e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f` |
| Protocol violations | 0 |
| Snapshot sends / acknowledgments | 2 / 2 |
| Maximum worker snapshot count / bytes | 2 / 28,800 |
| Aggregate rasterized nav tiles (initial + revision 6) | 250 |
| Reused compressed layers at revision 6 | 200 |
| Geometry rejections | 0 |

The validator checks monotonic request IDs, `dueTick = issueTick + 2`, two-tick application when applied, registration followed by deltas, acknowledgment counts, worker/main snapshot retention, worker errors, exact route streams, logical replay, and final hash. Browser frames/wall timings exist in the raw harness output but were not used as performance evidence.

## Failed attempts and corrections

No failed attempt was used as passing evidence.

1. The first strict test compile stopped on two optional `candidate.dispose` invocations in the new test. These were corrected to optional calls before tests ran.
2. The first full test execution passed 3/8 and failed 5/8. The large mutation had the false no-path described above; readiness timed out because the adapter created its worker only in `createTransport` while callers awaited readiness first; the stale test had not actually evicted the requested revision; and the delayed-replay test was blocked by readiness.
3. The adapter now creates and wires the worker immediately, handles early readiness/errors, and later attaches the transport context. The race test now forces eviction before the out-of-order request and distinguishes cached stale requests from ephemeral rebuilds.
4. A 2 ms local delay still completed in exactly 400 frames, so it did not prove out-of-frame delayed delivery. The focused replay uses 20 ms and completes with blocked frames; route/logical/hash assertions remained mandatory.
5. The first standalone large-mutation diagnostic initialized only the combined module and failed before comparison because the full oracle's generator also required initialization. Both module initializations are now explicit.
6. After the halo fix, the large-mutation route matched exactly. A subsequent test failure was only an assertion reading `maxChangedTilesPerBuild` (which includes the initial 14,400-cell build) instead of the mutation counter; it now asserts 2×10,816 mutation changes.
7. The final complete suite, original parity replay, stress matrix, build, smoke, and browser replay were rerun after these corrections.

## Exact reproduction commands

Run from `/Users/jamesmoss/Documents/game`.

```sh
# Strict integration check and focused tests; final run also writes results/vitest.json.
npx tsc -p scratch/navigation-queue/recast-combined/integrated/tsconfig.json
npx vitest run scratch/navigation-queue/recast-combined/integrated/integrated.test.ts \
  --reporter=json \
  --outputFile=scratch/navigation-queue/recast-combined/integrated/results/vitest.json

# Original exact Node parity, updated with the halo-corrected builder.
npx tsx scratch/navigation-queue/recast-combined/verify-parity.ts

# Large-mutation diagnosis and exact mutation stress matrix.
npx tsx scratch/navigation-queue/recast-combined/integrated/diagnose-large.ts
npx tsx scratch/navigation-queue/recast-combined/integrated/stress.ts

# Production module-worker bundle.
npx vite build --config scratch/navigation-queue/recast-combined/integrated/vite.config.ts

# Real-Chrome built-worker readiness/route smoke.
node scratch/navigation-queue/recast-combined/integrated/run-browser.mjs \
  --built --smoke --name smoke-built

# Corrected full-rebuild Node Recast oracle and built-worker Chrome replay.
npx tsx scratch/navigation-queue/recast-combined/integrated/run-node.ts \
  --scenario narrow-mutation-120 --population 40 --ticks 400 \
  --name node-combined-oracle-p40-t400
node scratch/navigation-queue/recast-combined/integrated/run-browser.mjs \
  --built --scenario narrow-mutation-120 --population 40 --ticks 400 \
  --samples 1 --name combined-p40-t400-built
node scratch/navigation-queue/recast-combined/integrated/validate-replay.mjs
```

## Remaining limitations and next gates

1. **No scale or performance comparison was run.** Correctness now permits that next experiment, but this checkpoint supplies no latency, throughput, memory-bandwidth, CPU, or superiority claim.
2. Browser replay coverage is one narrow-mutation p40/t400 built-worker sample on headless Chrome arm64. Dense, p1000/t3600, repeated/interleaved samples, other browsers, x64, and independent WASM builds remain unvalidated.
3. The clean production scheduler handle/provider API is still future work. No production scheduler modification was made, and the harness `slice()` adaptation must not be productionized.
4. Failure injection proves visible protocol handling of an engine/native-style exception, not recovery from every possible WASM trap, worker crash, OOM, or detached-message failure.
5. Native WASM memory/allocator behavior and total browser heap/GC were not audited. Snapshot and mesh revision counts are bounded, but that is not a total native-memory bound.
6. The model remains binary flat passability. Arbitrary heightfields, slopes, off-mesh topology, and layered geometry are outside this gate.
7. The halo improves correctness at the cost of additional rasterization near tile boundaries. Any subsequent performance study must use this corrected implementation and must not quote the old 4-tile/221-layer counters.

## Scope confirmation

No commit, push, GitHub issue/comment, production file, documentation file, donor directory, or unrelated scratch directory was modified. All generated source, build, diagnostic, test, and result artifacts are confined to `scratch/navigation-queue/recast-combined/`, with the integrated candidate in its `integrated/` subdirectory.

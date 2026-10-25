# Navigation snapshot and incremental-update protocol evidence

Wayfinder: **“Can versioned navigation snapshots and incremental updates remove worker latency?”** (#169)

## Decision

**Advance the versioned-snapshot design into a narrow production implementation proposal, but do not promote the scratch shim or call it a latency fix. Retain current A* and investigate worker queue ownership next. Keep the new Recast incremental/browser implementations as validated research baselines, not production candidates yet.**

Versioned snapshots achieved their exact transport and replay goals: full snapshot payload fell by 99.998%, and every measured full-game result matched preserved Node A* logically and by final state hash. Latency improved only modestly and remained above budget at pooled leader p95. Actual A* compute is now small relative to measured worker queueing.

Recast also crossed two important evidence gates: acknowledged incremental TileCache revisions and real Chrome/WASM full-game execution with exact route and replay parity. It still does not beat A* on the corrected narrow comparison and has rebuild, fallback, and queue costs.

## Evidence and verification

This record consolidates:

1. [Versioned A* snapshots and delta updates](../../scratch/navigation-protocol/snapshots/report.md)
2. [Revision-acknowledged incremental Recast TileCache](../../scratch/navigation-protocol/recast-incremental/report.md)
3. [Real Recast Chrome/WASM full-game worker](../../scratch/navigation-protocol/recast-browser/report.md)

Independent verification passed strict TypeScript and the reported suites: 41/41 snapshot/A*/scheduler tests, 40/40 incremental/Recast regression tests, and 4/4 Recast browser artifact tests. The Recast production Vite build and built-worker one-tile-gate smoke passed. Derived validators checked raw metrics, replay equality, exact Recast route streams, request IDs, due ticks, snapshot sizes, and application timing.

Coverage remains Chrome arm64 and Node/mock. Firefox, WebKit, Safari, x64, and independent WASM builds were not executed.

## Versioned A* snapshot transport

### Protocol

The scratch protocol replaces per-request embedded passability with explicit messages:

- `snapshot-register`: one immutable full snapshot per plane/revision, structured-cloned once;
- `snapshot-update`: base snapshot/revision plus changed indices and values, with delta buffers transferred;
- `versioned-path`: request ID, due tick, endpoints, revision, plane, and snapshot handle, without a passability array;
- worker acknowledgments/results: revision handling, queue/compute telemetry, bounded occupancy, and transferred waypoint buffers.

Land, naval, and owner planes have independent stores and path engines. Worker retention is bounded to two immutable revisions per plane; the executed traces used land only. The production scheduler still owns monotonic IDs, due ticks, ascending application, blocked target ticks, and stale discard.

The scratch implementation overrides a private same-revision array's `slice()` to satisfy the current scheduler. This proves the design but is explicitly **not** suitable for production. The production seam must instead introduce a snapshot handle/provider in the request union and scheduler.

### Exact payload reduction

Three real-Chrome mixed 1,000-unit runs each issued 46,807 requests:

| Metric per sample | Preserved A* | Versioned snapshots |
|---|---:|---:|
| Full snapshot payload | 674,020,800 B | **14,400 B** |
| Scalar requests + registration/update accounting | Not separately measured | **9.20–9.25 MB** |
| Same-revision snapshot reuse | 0 | **46,806 requests** |
| Full snapshot reduction | — | **99.998%** |

The conservative new total, including scalar protocol accounting, is approximately 98.63% below baseline snapshot bytes alone. Scalar sizes are deterministic JSON accounting, not browser wire size; binary snapshot/delta/waypoint sizes are exact.

A real mutation smoke used one 14,400-byte registration plus an **80-byte delta for 16 changed cells**. Worker snapshot memory was bounded at 28,800 bytes for two revisions. Revision changes with no intervening request coalesced directly from revision 0 to 6.

### Real Chrome latency

| Metric | Preserved five-sample A* | Three-sample versioned A* |
|---|---:|---:|
| Initial leader response p95 | 48.0 ms | **34.8 ms** |
| Individual-repath response p95 | 115.5 ms | **111.8 ms** |
| Leader worker queue p95 | Not measured | **34.4 ms** |
| Repath worker queue p95 | Not measured | **112.7 ms** |
| Leader actual A* compute p95 | Not measured | **2.7 ms** |
| Repath actual A* compute p95 | Not measured | **0.2 ms** |
| Production apply/tick p95 | 0.1 ms | **0.1 ms** |

Versioned per-sample leader p95 values were 36.0, 31.0, and 30.0 ms: 1 of 3 exceeded 33.3 ms. Blocked frames were 747–766, within the preserved baseline's 706–867 range. Wall time likewise showed no meaningful improvement.

The leader p50 increased from 26.6 to 30.0 ms, mean leader response was essentially unchanged, and baseline/versioned runs were not interleaved. Therefore the p95 changes are descriptive, not controlled causal estimates.

All three mixed samples and the mutation smoke matched preserved Node A* logically and by final full-state hash. Production apply remained at 0.1 ms p95.

### Interpretation

Snapshot cloning is a real avoidable cost and the versioned design is worth a clean production seam. It is not the remaining latency bottleneck: queue p95 closely tracks end-to-end response, while actual compute p95 is small. The next work should target worker queue ownership, scheduling, batching/coalescing, and main-thread delivery rather than another pathfinder migration.

## Incremental Recast TileCache

### Correctness and mutation model

The incremental candidate starts from the corrected supercover/cs0.25 Recast baseline. It generates an all-walkable base and deterministically covers blocked cells with rectangles. Revision deltas add/remove boxes, drain TileCache queues to `upToDate`, and only then acknowledge the visible revision. Batches stay below the native request-queue limit.

Failed updates or capacity operations are visible and select exact full-Recast rebuilds. Every unsuccessful incremental route query is checked against an exact Recast mesh; false no-paths promote the exact mesh. No A* planner fallback exists. Out-of-order or same-version/different-byte snapshots use ephemeral exact meshes.

This supports binary flat passability, not arbitrary heightfields, slopes, off-mesh topology, or layered geometry. Native WASM memory is not measured.

### Full-game narrow comparison

| Candidate | Wall s | Mean / p95 tick ms | Completed / active | Failed responses |
|---|---:|---:|---:|---:|
| A* | **24.965** | **6.324 / 12.185** | 487 / 513 | 16 |
| Corrected full-rebuild Recast | 31.062 | 7.911 / 15.565 | **500 / 500** | 16 |
| Incremental Recast | 29.810 | 7.605 / 14.095 | **500 / 500** | 16 |

Incremental was 4.03% faster than corrected Recast but 19.41% slower than A* in these single runs. It exactly matched corrected Recast logical state and final full-state hash.

The real revision-6 delta contained 16 changed cells. Two acknowledged barriers, 20 update calls, two drains, 19 requested nav-tile touches, and six box additions took 2.668 ms of measured incremental update time.

However, two geometry-validation failures caused exact full-Recast rebuilds. Total full-build time was 392.453 ms across three builds. The candidate is therefore not fully incremental on the measured trace, and its wall improvement cannot be attributed to eliminating rebuild work.

### Stress evidence

- Twenty gate close/reopen revisions matched full-rebuild route outcomes, with acknowledged updates and confirmed unreachable validations.
- Building add/remove and five-rectangle bursts completed without fallback.
- A 104×104 obstacle exercised multi-tile draining and one geometry fallback; a later reopen succeeded incrementally.
- The configured capacity reached 512 live obstacles; request 513 failed visibly and triggered exact rebuild.
- Repeated and delayed/mock replay matched corrected Recast logical state and final hash.

The remaining geometry false no-path cases must be diagnosed and bounded before adoption.

## Real Recast Chrome/WASM worker

The corrected Recast candidate now runs in a Vite-built real module Worker with recast-navigation 0.43.0 WASM. Async initialization and readiness races are handled explicitly. The production scheduler and full-game Activity/group/steering/collision loops remain unchanged.

Both 1,000-unit, 3,600-tick traces completed in headless Chrome 156 on Apple M1 arm64:

| Metric | Dense | Narrow + mutation |
|---|---:|---:|
| Requests | 46,289 | 53,098 |
| Wall / blocked frames | 37.583 s / 496 | 35.866 s / 155 |
| Leader response p95 | 174.8 ms | 158.7 ms |
| Repath response p95 | 70.4 ms | 33.5 ms |
| Repath worker compute p95 | 0.2 ms | 0.2 ms |
| Production apply p95 / max | 0.0 / 2.4 ms | 0.0 / 1.1 ms |
| Snapshot payload | 666.6 MB | 764.6 MB |
| Revision rebuild total / max | 169.1 / 169.1 ms | 280.5 / 155.4 ms |
| Completed / active | 528 / 472 | 500 / 500 |

Every ordered route—ID, status, cost, and every waypoint—matched corrected Node Recast exactly. Logical replay and final full-state hashes also matched for both large traces and two additional 40-unit samples. Protocol validation found zero ID, due-tick, snapshot-size, or application-timing violations.

This resolves the question of basic real-browser semantic viability. It does not establish performance superiority or cross-platform determinism. Initial rebuild latency, repath queue tails, and per-request snapshots remain adoption blockers. Full-scale timings are single instrumented samples without warmups.

## Production direction

1. **Specify a clean snapshot-handle request union and scheduler-owned provider.** Copy/diff once per required revision; do not override `Uint8Array.slice` in production.
2. **Keep scheduler correctness unchanged.** Preserve monotonic IDs, due ticks, ascending pump, stale discard, plane identity, and bounded old-revision lifetime.
3. **Make queue ownership the next primary experiment.** Measure worker FIFO batching, main-thread message delivery, request coalescing, and backpressure using interleaved same-session A/B samples with minimal telemetry.
4. **Combine proven Recast pieces only after their joint correctness gate.** The corrected corridor, incremental revision store, versioned snapshots, and real browser worker must be tested together; their separate successes do not prove the combination.
5. **Diagnose incremental geometry fallbacks.** Require bounded/no false no-path promotions before considering Recast production-bound.
6. **Retain A* as the control.** Promotion requires repeated response and full-game outcome improvements without exact-slot, gate, mutation, or replay regressions.

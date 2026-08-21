# Unit movement, pathfinding & crowd handling (hybrid A* → flow fields)

Pops need to move AoE2-style: click, walk, converge on a lumber camp without merging into a conga line, and queue move → gather → return. We decided on a **phased hybrid**: **Phase 1 ships grid A\* (8-directional, octile) computed per move-order _group leader_ in a Web Worker, string-pulled into waypoints, with boid separation + positional push-apart + a Moving/Stalled/Parked FSM underneath. Phase 2 adds flow fields per destination when group-move cost bites. Portal-graph sector tiling is deferred until maps exceed ~256².** Command queuing follows OpenRA's Activity model: each Pop owns an activity queue consumed on tick boundaries.

## The decision in detail

### Pathfinding core (phase 1)

- One A\* search **per move-order group**, not per Pop: the group leader (Pop nearest the group centroid, ties broken by ascending entity id) gets the search; followers reuse its waypoint list offset by their formation slot.
- Search runs on the derived passability `Uint8Array` from ADR 0002 (120×120 = 14,400 nodes; worst case < 1 ms in JS). Costs are integers ×1000 (straight 1000, diagonal 1414) — no float drift, no transcendentals in the search.
- **String-pulling** (greedy line-of-sight walk over the raw tile path, raycast against cost ≥ wall threshold) converts jagged 8-dir paths into sparse waypoints.
- Phase 2 trigger (measured, not vibes): flow fields per unique goal (cost field → integration field → 4-bit direction field, Emerson ch. 23 pipeline) when concurrent leader searches push path-worker turnaround past one tick budget or path-application past ~2 ms/tick on main thread. Fields keyed by `(goalTile, passabilityVersion)` and shared — order cost stops scaling with Pop count. Portal-sector tiling only beyond ~256² maps.

### Worker protocol & determinism

Single dedicated path worker, strictly FIFO. Requests carry everything needed to be a **pure function**:

```ts
// main → worker
type PathRequest = {
  kind: "path";
  id: number; // monotonic, assigned in issue order
  dueTick: number; // issueTick + PATH_LATENCY (=2 ticks)
  startX: number;
  startY: number;
  goalX: number;
  goalY: number;
  passable: Uint8Array; // snapshot, transferred; worker transfers back
  passableVersion: number;
  seed: number; // child of the sim PRNG stream
};
// worker → main
type PathResult = {
  kind: "path";
  id: number;
  ok: boolean;
  waypoints: Int16Array; // flat [x0,y0,x1,y1,…] after string-pull
  cost: number;
};
```

Determinism contract: results depend only on request contents; the sim consumes responses from an inbox **at tick boundaries, in `id` order, applying any whose `dueTick ≤ currentTick`**. If a response is late (GC pause, slow tab), the sim blocks before stepping past the due tick — the moral equivalent of the existing 250 ms frame clamp, and the price of replay-exact movement. In practice a 14k-node search answers inside one 33 ms tick, so blocking is rare. While a path is pending (<66 ms) the group sits in Stalled — imperceptible.

Inside the worker: seeded PRNG only (seed arrives in the request); binary heap tie-broken by `(f, insertionCounter)` with neighbor expansion in a fixed 8-direction clockwise order; no `Date`, no `Math.random`, no `Math.sin/cos` (startup LUTs instead). The search module exports its functions directly so golden tests run it headless without a Worker.

### Group moves & formation slots

Multi-select move: slots are assigned as concentric rings around the destination — ring radii grow by unit spacing, positions at integer angles stepped through a precomputed 256-entry sin/cos LUT. Selected Pops sorted once by ascending entity id (bitecs stable order), dealt onto slots in that order. Followers steer toward `waypointᵢ + slotOffset`; a follower that ends up blocked makes its own individual re-path request rather than triggering a group rebuild.

### Gather convergence (dozens of Pops, one lumber camp)

Resource-node entities expose **work slots**: the passable tiles adjacent to the node (up to 8 for a tree/mine), claimed in `(slotIndex, entityId)` order via a claim component. A Pop ordered to gather enqueues `[Move(slot), Gather(node), Return(nearest Drop-off point)]` as an Activity chain that auto-repeats until the node depletes. No free slot → park in a holding ring one tile out and mill (AoE2-authentic crowding) until a slot frees. On `Carry capacity` full, return to the cheapest known Drop-off point (path cost cached per building), then resume the remembered slot.

### Collision avoidance (mandatory layer under any path plan)

- **Boid separation**: repulsion from Pops within ~1 tile via a spatial hash rebuilt each tick (cell = 2 tiles).
- **Positional resolution**: after integration, overlapping pairs split apart symmetrically; hard clamp against impassable tiles.
- **FSM**: _Moving_ → normal steering; _Stalled_ (blocked > N ticks) → seeded sidestep jitter, then individual re-path; _Parked_ (idle/working/gathered-in) → acts as a soft obstacle others flow around, and Parked status propagates backwards through contact so columns behind a saturated camp halt cleanly instead of shoving eternally.

### Repath & invalidation

Passability grid carries a monotonically increasing `version`; building placement, depletion, re-seeding bump it. Cached artifacts are keyed by version: worker holds an LRU (32 entries) of `(goalTile, version) → waypoints` so repeat group orders to the same camp are cache hits; phase-2 fields are dropped on version bump unless still referenced. Every Pop validates its next waypoint segment against live passability each tick (cheap short raycast); failure ⇒ new path request. In-flight requests carrying stale versions are answered normally but flagged; the sim discards them on arrival if the version changed.

### Command queues

OpenRA-style Activity objects per Pop, advanced only inside `step()` at tick boundaries, reading nothing external: `Move`, `Gather`, `Return`, `Build`, plus a repeat flag for gather loops. Right-clicking a Resource enqueues the whole chain in one user command, which keeps replays trivially reproducible.

## Considered Options

- Per-Pop A\*: correct but N searches per order and N repairs per terrain change; the exact scaling trap Supreme Commander 2 documented.
- Pure flow fields from day one: best asymptotics, but more machinery before the game exists, and corner-conga artifacts without the same steering layer phase 1 needs anyway.
- Navmesh / Theta*: smoother paths, but mesh maintenance on a mutating entity-occupancy grid is complexity we don't need at 120×120.
- Main-thread A\*: simplest, but risks hitching during mass orders; worker costs little given the pure-function protocol above.

## Consequences

- Two extra seams to test: the worker protocol (pure-function property makes it golden-testable headless) and the steering layer (testable as pure vector math per tick).
- Determinism survives the Worker only via the dueTick/blocking contract — violating it (applying results whenever they arrive) silently breaks replays.
- Phase-2 flow fields slot in behind the same inbox/version-keying machinery; no phase-1 code is thrown away, the steering layer is permanent either way.

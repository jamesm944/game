# Rust native sim core, shipyard ECS, FlatBuffers bridge & deterministic parallel tick

- **ADR:** 0008
- **Date:** 2026-10-18
- **Status:** Accepted
- **Supersedes:** [ADR-0004 — Single-threaded deterministic simulation](./0004-threading-model.md)
- **Context Issues:** [jamesm944/game#159](https://github.com/jamesm944/game/issues/159), [jamesm944/game#158](https://github.com/jamesm944/game/issues/158) (Wayfinder Map 6: AAA Supremacy)

## Context

ADR-0004 established a single-threaded authoritative simulation tick running in TypeScript on the main thread. That decision was correct for the original 300–500 Pop target where determinism risk and porting cost outweighed the performance benefit of parallelism.

The project now targets **1,000–5,000 Pops at 30 Hz** as the production ceiling, with a stretch goal of **5,000–20,000 Pops** for large-map marathon scenarios (matching Dwarf Fortress / Victoria 3 depth). Profiling of the TypeScript bitecs sim shows that the mood-ledger rollup, economic distribution, and pathfinding reservation systems will saturate a single JavaScript thread well before 1,000 Pops under the deeper simulation requirements locked in ADR-0007 and issues #146, #151, #153, #154, #155.

TypeScript's single-threaded event loop and 64-bit float heap impose a hard ceiling. WASM threads via `SharedArrayBuffer` are viable but cap at 128-bit SIMD and share a 4 GB linear memory budget with the rendering heap — insufficient for the 20k stretch goal and marginal for 5k+ with fat Per-Pop structs (mood ledger, social class, wealth, housing, employment, health, religion, ideology).

## Decision

### 1. Rust native binary (Tauri sidecar)

The authoritative simulation is rewritten as a **standalone Rust binary** bundled as a Tauri sidecar. It owns all game rules: pathfinding, movement, combat, economy, Pop simulation, era progression, political events, and save state.

- Full native threads via **Rayon** — no browser threading restrictions
- **AVX2 / NEON SIMD** available for SoA kernel loops (mood rollup, economic summation, combat math)
- No 4 GB memory ceiling — Pop structs can be fat without compromise
- Determinism is enforced structurally via sorted entity ID iteration and phase-barrier reduction (see §3)

The Rust binary communicates with the renderer process over a **Unix socket (macOS/Linux) or Windows named pipe**. FlatBuffers frames are length-prefixed. Round-trip cost is <0.2 ms on localhost; acceptable for the 33 ms tick budget.

A separate `--target wasm32-unknown-unknown` compile target is maintained for the **browser demo build**. The WASM build uses single-threaded shipyard (no Rayon), drops AVX2 SIMD to `wasm-simd128`, and caps Pop count at ~1,000. One Rust codebase, two backends — the same model used by Figma and Photoshop Web.

### 2. shipyard ECS

The Rust sim uses **[shipyard](https://github.com/leudz/shipyard)** as the ECS library.

- Designed for data-parallel workloads: built-in `Workload` scheduler with explicit system dependency declarations
- SoA (Structure of Arrays) component storage — cache-friendly iteration, directly SIMD-addressable
- Zero-cost `View` / `ViewMut` borrows with compile-time uniqueness checking
- Active maintenance (2025–2026), no Bevy engine dependency

### 3. Fully data-parallel ECS architecture (SoA + SIMD kernel loops)

Each 30 Hz tick runs in sequential **phases**. Within each phase, independent systems run concurrently via Rayon parallel iterators over entity ranges. Entity iteration order is deterministic: all parallel reductions are sorted by ascending `u32` entity ID before application.

```
Tick N:
  Phase 1 — Input: consume commands from inbox (single-threaded, ordered by receipt tick)
  Phase 2 — Movement: A* reservations, velocity integration        [parallel by entity shard]
  Phase 3 — Combat: attack resolution, damage, morale              [parallel by entity shard]
  Phase 4 — Economy: wage payment, market clearing, inflation      [parallel by entity shard]
  Phase 5 — Pop Simulation: mood ledger, fertility, migration      [parallel by entity shard]
  Phase 6 — Events: storyteller rolls, council votes, era checks   [single-threaded, sorted]
  Phase 7 — Snapshot: serialise FlatBuffers snapshot, write to socket
```

**Deterministic event ordering:** Events generated within parallel phases are collected into per-worker vectors and sorted by `(entity_id, event_type)` before being applied at the phase boundary. All RNG calls consume a per-entity seeded `SmallRng` (PCG64 family) initialised from `(global_seed XOR entity_id XOR tick)`. This guarantees same-seed/same-command replay across any worker count.

**Read/write ownership:** Each system declares its component borrows via shipyard's `View<T>` / `ViewMut<T>`. Systems with non-overlapping borrows within the same phase run concurrently; conflicting borrows are serialised. The Workload scheduler enforces this at compile time.

### 4. FlatBuffers snapshot/command protocol

**Wire format:** [FlatBuffers](https://flatbuffers.dev/) — a `.fbs` schema is the single source of truth. `flatc` generates Rust builders and TypeScript/JS accessors. Zero-copy read on the consumer side (renderer accesses fields directly from the raw buffer without deserialisation).

**Snapshot:** Published once per tick (after Phase 7). Contains the full renderable state: entity positions, animations, health, ownership, visibility (fog of war). Does **not** contain internal sim state (mood ledger internals, economic ledgers, etc.) — those are sim-private.

**Commands:** Sent by the renderer to the Rust sim at any time. Buffered in the sim's `inbox` (bounded ring buffer, capacity = 256 commands). Consumed at Phase 1 of the next tick, in arrival order. Commands are stamped with the renderer's `last_seen_tick` for replay attribution.

**Entity IDs:** The Rust sim owns canonical `u32` entity IDs assigned at spawn. The renderer maintains a `Map<u32, Object3D>` (Three.js) or equivalent (Unity). Despawned entities are absent from the snapshot; the renderer frees their visual object.

### 5. Golden fixture versioning — hard break

The existing TypeScript golden fixtures (v1.x) are **archived** at the last TypeScript-only commit and tagged `fixtures/v1-final`. They are removed from the CI gate. The v1.x fixtures document the TypeScript sim's final behaviour for historical reference only.

The v2.x fixture suite starts from the first Rust sim tick. Fixtures are produced by `cargo test --test golden` in the Rust crate, using the same command-stream / seed / assertion model as the TypeScript suite. Replay reproducibility is required across 1, 2, 4, and 8 Rayon worker configurations — CI runs all four.

This is a deliberate, reviewed compatibility boundary. Save files from v1.x are not loadable in the v2.x Rust sim without an explicit migration path (a separate migration ADR if/when campaign saves require continuity).

### 6. Migration plan

**Phase 0 — Spike (no production code):** Implement a throwaway Rust crate running the Pop mood-ledger rollup, economic summation, and pathfinding reservation at 5k and 20k entities using shipyard + Rayon + AVX2. Target: <8 ms wall time for the full hot loop on M2. If the spike misses the target, revisit the ECS design before committing to the greenfield.

**Phase 1 — Greenfield alongside:** Begin the production Rust sim crate on `research/df-rw-deep-sim`, initially covering only the new deeper systems (#146, #151, #153): Pop simulation, mood ledgers, social class, taxation, housing tiers, era progression. The TypeScript sim continues running all existing systems (movement, combat, economy) unchanged.

**Phase 2 — Bridge handoff:** Establish the FlatBuffers protocol and Unix socket transport. The renderer reads from the Rust sim for Pop/political state; the TypeScript sim still owns movement/combat. Both sims run in the same process test harness.

**Phase 3 — Full migration:** Port movement, combat, and remaining systems to Rust one system at a time, each accompanied by a v2.x golden fixture. TypeScript sim is feature-frozen at the start of this phase.

## Considered Options

- **TypeScript + SharedArrayBuffer workers:** Rejected — 4 GB ceiling, 128-bit SIMD only, browser-controlled thread pool caps Rayon parallelism; cannot reach 20k Pop stretch target.
- **Rust → WASM (wasm32-unknown-unknown, single target):** Rejected as the production target — same 4 GB / SIMD limitations as TypeScript+SAB. Retained as the *browser demo compile target* only.
- **C++ native process (Flecs / EnTT):** Considered — maximum raw perf, best-in-class ECS options (Flecs parallel scheduler is excellent). Rejected because it adds C++ to the toolchain and loses Rust's type safety and ownership guarantees. Flecs is a close second; revisit if Rust SIMD proves insufficient.
- **C# Unity Jobs / Burst:** Considered only if Unity wins the engine choice (#158). Rejected as the primary path because it ties the sim to the Unity process model and requires porting all determinism guarantees into a new runtime. Hybrid architecture (ADR-0008 sim + Unity renderer) is preferred over a C# sim port.
- **Single-threaded Rust (no Rayon):** A viable Phase 0 stepping-stone (5–15× over TypeScript single-threaded). Not the final architecture — Q4 locked fully data-parallel SoA for the production sim.

## Consequences

- **ADR-0004 is superseded.** The single-threaded authoritative tick restriction is lifted. Determinism is now guaranteed by sorted entity ID reduction at phase boundaries, not by single-threaded execution.
- **Rust is now a required build dependency.** CI must install a pinned `rustup` toolchain. The `flatc` binary is a required codegen dependency.
- **Two sim runtimes exist during Phase 1–2.** The TypeScript sim continues to own movement/combat until Phase 3. Engineers must not make incompatible changes to the TypeScript sim's entity schema during this window without coordinating with the Rust sim's FlatBuffers schema.
- **Browser demo requires a separate `wasm32` build target.** The Tauri desktop build and the browser demo are distinct artifacts from the same Rust source.
- **v1.x save files are not forward-compatible** unless a migration path is explicitly authored. Single-player only; no multiplayer saves exist.
- **Replay reproducibility across worker counts is a CI requirement.** `cargo test --test golden` must pass with `RAYON_NUM_THREADS=1`, `=2`, `=4`, `=8` in CI. This is the machine-verifiable proof that determinism holds under parallelism.

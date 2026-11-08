# Save and Replay Compatibility Boundary for the Deep Simulation

Wayfinder: **"Choose the save and replay compatibility boundary for the deep simulation"** ([#165](https://github.com/jamesm944/game/issues/165))  
Date: 2026-10-27  
Status: **Resolved (User HITL Selection: Option A — Reviewed v2 Hard Break & Archive v1)**

---

## 1. Decision Summary

1. **Reviewed v2 Hard Break for Saves:**
   - No backward compatibility with v1 `.ageof` save files.
   - Private single-player scope: no external players or long-term campaign saves exist that require preservation.
   - Attempting to load a v1 save in the v2 runtime will fail immediately and loudly with an explicit user-facing error (`"Unsupported v1 save format: v2 engine requires fresh save"`), preventing silent state corruption.

2. **Replay & Golden Digest Strategy (Archive & Fresh Baseline):**
   - Existing TypeScript v1.x golden fixtures and replay hashes are archived at git tag `fixtures/v1-final` as read-only historical reference.
   - They are decoupled from the v2 CI gate.
   - The deep simulation runtime (Rust native sidecar / parallel ECS per ADR-0008) starts a fresh v2 golden fixture suite (`tests/golden/v2/`).
   - The core invariant for v2 replays is **deterministic parallelism**: identical commands and seed must produce byte-identical world digests across **1, 2, 4, and 8 worker threads** (`RAYON_NUM_THREADS`).

3. **Maximum Code & Logic Reuse Without Binary Shackles:**
   - Maximally harvest and reuse game rules, balance tables, state machines, building/unit definitions, needs formulas, and donor algorithms (from Generals TS port, Voidstrike, Widelands, DFHack, OpenRA).
   - Reject any constraint that requires matching v1 JavaScript float-rounding quirks, byte-exact array packing, or legacy data layouts.

4. **Coexistence & Rollback Policy:**
   - The TypeScript sim is **feature-frozen** upon commencement of the v2 sim pipeline.
   - Containers and replays carry strict engine and schema identifiers. Dual-engine cross-loading is prohibited.
   - Rollback is strictly operational via git tag/branch checkout, never runtime fallback within a hybrid save file.

---

## 2. `.ageof` Container Specification (v2)

The `.ageof` container evolves to format version 2 to cleanly separate legacy and new runtimes:

### 2.1 Header Format (Uncompressed)

```
Offset  Size  Field            Type     Description
0       4     Magic            ASCII    "AOF2" (v1 was "AOF1")
4       4     FormatVersion    u32      2 (v1 was 1)
8       4     EngineId         u32      0x52555354 ("RUST") or 0x5453494D ("TSIM")
12      4     Seed             u32      World seed
16      4     Tick             u32      Authoritative tick count
20      8     PlaytimeSeconds  f64      Elapsed wall playtime
28      8     MapHash          u64      FNV-1a-64 of map passability/elevation
36      8     StateDigest      u64      FNV-1a-64 canonical world digest
44      4     PayloadLength    u32      Byte length of compressed payload
48      ...   Payload          gzip     Compressed FlatBuffers / ECS state
```

### 2.2 Rejection & Error Handling Contract

- **Magic mismatch:** If file starts with `"AOF1"`, the loader aborts immediately:
  `Error: Save file was created by legacy engine v1. Format version 1 is unsupported in the deep-sim runtime.`
- **Engine mismatch:** If `EngineId` does not match the active runtime (e.g., TS loader opening a native Rust save or vice-versa), abort immediately:
  `Error: Save file was created by engine '${saveEngine}', but current build is '${activeEngine}'.`
- **Corruption check:** Upon decompressing, the canonical world digest is calculated and compared against `StateDigest`. Any discrepancy triggers a hard validation error.

---

## 3. Replay & Fixture Ownership

### 3.1 Archival of v1 Fixtures (`fixtures/v1-final`)

- Commit the final TypeScript simulation state and tag as `fixtures/v1-final`.
- Existing `tests/golden/` files are preserved under `fixtures/v1-final/` for regression reference.
- CI workflows for the v2 pipeline do not run v1 golden fixtures.

### 3.2 v2 Fixture Contract & Multi-Worker Validation

- Replay files retain the command-stream + seed model:
  ```json
  {
    "formatVersion": 2,
    "engine": "rust-shipyard",
    "seed": 20260902,
    "mapHash": "fnv1a64:...",
    "commands": [...],
    "milestones": [
      { "tick": 300, "digest": "..." },
      { "tick": 600, "digest": "..." }
    ]
  }
  ```
- **CI Determinism Suite:**
  Every PR modifying simulation logic executes the golden suite under:
  ```sh
  RAYON_NUM_THREADS=1 cargo test --test golden
  RAYON_NUM_THREADS=2 cargo test --test golden
  RAYON_NUM_THREADS=4 cargo test --test golden
  RAYON_NUM_THREADS=8 cargo test --test golden
  ```
  All four runs must output the **exact same milestone digests**. Any difference indicates a non-deterministic parallel reduction or unseeded iteration order, which immediately fails CI.

---

## 4. Migration & Code Reuse Strategy

Since binary save migration is explicitly rejected, engineering resources are concentrated on **algorithmic and code reuse**:

1. **Directly Reusable Assets & Data Schemas:**
   - JSON definitions in `src/data/definitions/` (units, buildings, technologies, traits).
   - Audio manifests and event mappings.
   - Elevation, terrain generation noise tables, and passability rules.

2. **Porting & Harvesting Donor Logic:**
   - **Pop & Needs formulas:** Port the satisfaction, morale, health, and schedule models directly from the TS implementation into Rust SoA kernels.
   - **Generals TS Port:** Reuse the determinism validation harness, ring-buffer command scheduling, and bridge patterns.
   - **Widelands / DFHack:** Extract logistics transport-network routing and warehouse management logic.
   - **OpenRA / Voidstrike:** Reuse steering behaviors, combat target-acquisition heuristics, and tactical stance logic.

3. **Zero Legacy Shims:**
   - No `LegacySnapshotCompatibility` or compatibility wrappers.
   - Clean break enables lean, idiomatic FlatBuffers protocols and cache-aligned SoA layouts without technical debt from early prototypes.

---

## 5. Rollback & Coexistence Policy

1. **Feature Freeze on TypeScript Sim:**
   - No new gameplay features or mechanics are added to `src/sim/`.
   - Bug fixes to the TypeScript sim are permitted only if strictly necessary for testing or comparative benchmarking.

2. **Branch & Repository Hygiene:**
   - The native/deep-sim core is developed on `research/df-rw-deep-sim`.
   - If rollback is ever required due to insurmountable native integration hurdles, the rollback target is `fixtures/v1-final` or `main` at the pre-native baseline.
   - Saves created during native testing are never carried backward to the TypeScript codebase.

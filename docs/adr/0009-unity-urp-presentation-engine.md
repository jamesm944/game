# Unity URP presentation engine with Rust simulation (hybrid)

- **ADR:** 0009
- **Date:** 2026-10-30
- **Status:** Accepted
- **Supersedes:** the renderer/platform direction in [ADR-0008 §renderer bridge assumptions](./0008-rust-native-sim-core-and-renderer-bridge.md) insofar as it left the presentation engine open; ADR-0008's Rust simulation decision is unchanged.
- **Context Issues:** [jamesm944/game#178](https://github.com/jamesm944/game/issues/178) (Wayfinder Map 7: 3D Prototype), superseding #158/#156 (Map 6)

## Context

Three presentation clients were prototyped against the same Rust simulation slice, assets, and camera modes (`codex/hybrid-engine-prototype`, `33621e4`): three.js WebGPU, Unity URP, and Godot Forward+. All three rendered the identical reference frame (digest `68c9dc948474e127`, 500 Pops, 1600×1000).

Fresh measurements on Apple M1 (2026-10-30, view B): Unity frame p50 8.41 ms / p95 8.93 ms uncapped; Godot p50 16.70 ms / p95 19.30 ms at the vsync cap (headroom unknown until a vsync-off run, ticket #177); WebGPU frame distribution not freshly extracted. Unity's equal-asset look initially trailed the WebGPU study (dark, striped water); a labelled tool-assisted pass (`fbb3396`) closed that gap at no measured frame cost.

James's standing preferences: desktop-first, "as good as possible" visuals, private local use (licensing is provenance metadata, not a selection filter), freely reusable code/assets where practical.

## Decision

**Presentation moves to Unity (URP) on desktop, hybrid with the Rust simulation core from ADR-0008.**

- Unity owns rendering, camera modes (all three: tactical / settlement / coastal), presentation UI, animation, and cosmetic effects.
- The Rust binary remains solely authoritative for rules, pathfinding, movement, economy, combat, Pops, saves, and replays, per ADR-0008. Unity consumes tick-stamped snapshots/events and issues commands over the local bridge; it holds no game rules.
- The TypeScript/three.js game remains the behavioral reference during migration; no production system is ported by this decision. Migration scope and sequencing are implementation work beyond Map 7.
- A browser demo, if kept, is a reduced WebGPU/WASM build per ADR-0008 §1, not the primary target.

## Trade-offs considered

- **Godot + Rust** was the strongest alternative: MIT engine, real free-code donors (Terrain3D, Phantom Camera, Open RTS), working prototype. Rejected for lower rendering ceiling per unit effort and unproven frame headroom. Flip condition: if Unity's licence terms or version churn become a practical blocker, revisit — the Godot prototype is preserved and runnable.
- **Staying on three.js/WebGPU** avoided a presentation rewrite, but every engine tool (terrain, post, animation, editor) would be hand-built, against the "as good as possible" bar.
- **Costs accepted:** proprietary engine terms and pricing risk, editor version churn (prototype pinned 6000.3.11f1; rebuilt on 6000.6.6f1), a C# presentation codebase to maintain, and Unity shader-variant stripping pitfalls for runtime-created materials (hit during prototyping).

## Evidence

- Matched captures and run instructions: `prototypes/hybrid/` on `codex/hybrid-engine-prototype` (`33621e4` baseline, `fbb3396` improved Unity).
- Decision tickets: #175 (terrain look), #176 (head-to-head), #177 (matched frame-time, still open — this decision was taken on visual judgement plus measured headroom, ahead of the full matched protocol), #178 (this choice).

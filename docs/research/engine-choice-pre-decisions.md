# Engine Choice Pre-Decisions (Awaiting #157 Prototype)

**Issue:** [jamesm944/game#158](https://github.com/jamesm944/game/issues/158)  
**Date:** 2026-10-18  
**Status:** Decisions locked; final engine selection blocked on HITL prototype #157

---

## What this document is

All design questions that can be answered *before* the Unity prototype (#157) have been grilled and locked here. The actual engine selection (TypeScript/Three.js/WebGPU vs Unity hybrid vs Unity full port) cannot be made until James has seen matched screenshots/video from #157 and the performance measurements.

---

## Pre-locked decisions

### Engine switch trigger

Both of the following must be true simultaneously to justify migrating away from Three.js/WebGPU:

1. **Visual quality gap (both dimensions):**
   - Unity URP with the *same asset set* (no additional art effort) produces noticeably better **lighting and material depth** than the current Three.js prototype — a difference a non-developer would notice in side-by-side screenshots at the three camera views (tactical, settlement, coastal panorama).
   - Unity URP also demonstrates better **tactical readability**: units and buildings are easier to distinguish at the default 45° tactical camera with 500 visible entities. Less visual noise, cleaner silhouettes.

2. **Performance gap:**
   - Unity hits **60 fps (≤16.7 ms frame)** at 500 visible Pops with soft shadows and SSAO enabled, on the same declared machine as the WebGPU baseline (M2, same resolution).
   - The 1,000 Pop case is measured and labelled as a stretch result (not the headline comparison).

If Unity passes visual but not performance, or performance but not visual — Three.js/WebGPU continues and the Unity investigation is closed.

### If Unity wins — preferred path: hybrid architecture

Do **not** port the simulation to C#. The preferred migration is a hybrid:

- **Unity** owns: rendering, camera, presentation UI, animation, cosmetic effects
- **Rust native sidecar** (ADR-0008) owns: all authoritative simulation rules, movement/pathfinding, economy, combat, Pop state, saves, replays
- **Bridge:** FlatBuffers snapshots over Unix socket (same protocol as ADR-0008 specifies for the Three.js renderer)

The Unity renderer reads tick-stamped FlatBuffers snapshots and sends commands back to the Rust sim via the same socket. The bridge must prove: live round-trip, command ordering/acknowledgement, interpolation, bounded buffering, lifecycle/recovery, and unchanged sim digests for a pinned command stream.

A full C# sim port is **not authorised** by this decision ticket. If Unity wins, the Rust sim (ADR-0008) still ships.

### If Three.js/WebGPU wins — renderer improvement plan

Both tracks proceed in parallel:

1. **TSL shader migration:** Port the 12 existing `onBeforeCompile` GLSL shader files to TSL (Three.js Shading Language). This unlocks WebGPU compute shaders, GPU culling, instanced skinning upgrades, and all WebGPU-native features.
2. **Post-processing wins:** Ship SSAO, cascaded shadow maps, ACES filmic tone mapping, and volumetric fog via the `postprocessing` library. These are quick visual wins that don't require touching shaders.

TSL migration begins on a background branch; post-processing improvements ship to main incrementally.

### Delivery

- **Desktop-primary:** Tauri + Steam. No WebGL2 fallback for the desktop build.
- **Browser demo:** Separate `wasm32` Rust sim build (single-threaded, capped at ~1k Pops) + Three.js WebGPU or WebGL2 renderer. Same visual assets, lower preset. Used for marketing/demos without requiring the Tauri install.

---

## What the prototype (#157) must produce

Evidence required before engine selection (#158) can proceed:

- [ ] Matched screenshots and video at tactical, settlement, and coastal panorama views — equal-asset comparison clearly labelled
- [ ] Any additional art/tool-assisted improvement labelled separately from the equal-asset baseline
- [ ] Native player build profiled on M2: frame-time distribution, CPU/GPU split, memory, at 500 visible Pops (headline) and 1,000 Pops (stretch)
- [ ] Hybrid bridge prototype: live round-trip of tick-stamped snapshots and commands between Unity renderer and the TypeScript (or Rust) sim backend. Static trace alone is not sufficient.
- [ ] Record all custom code, packages, licences, remaining asset/import issues

---

## What this document is NOT

This document does not select the engine. It records the decision criteria and the pre-locked consequences of each outcome. The selection happens in a follow-up comment on #158 after James has reviewed the #157 evidence.

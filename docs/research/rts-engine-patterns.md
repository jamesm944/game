# Research: Proven Architecture Patterns for a Browser RTS (TypeScript + Three.js)

- **Issue:** [jamesm944/game#2](https://github.com/jamesm944/game/issues/2)
- **Date:** 2026-08-21
- **Question:** What are proven architecture patterns for a browser RTS in TypeScript + Three.js?
- **Scope:** Single-player only; all implementation done by coding agents; AoE2-like (grid map, buildings, large-ish armies).
- **Method:** Primary sources only — library docs/repos, benchmark suites, canonical engineering articles (Gaffer on Games, Game AI Pro, Game Programming Patterns), GDC/Gamasutra postmortems, and the source/architecture docs of shipping open-source RTS engines.
- **Location note:** No research-notes convention existed in this repo yet; this file establishes `docs/research/`.

---

## TL;DR

1. **ECS:** [bitecs](https://github.com/NateTheGreatt/bitECS) is the strongest library candidate (tiny, fast, actively maintained). "tesla" does not exist as a TS ECS — the issue presumably meant [koota](https://github.com/pmndrs/koota). Hand-rolled remains viable at AoE2-like unit counts.
2. **Loop:** Fiedler's fixed-timestep **accumulator pattern** with a frame-time clamp (~250 ms) and render interpolation is the settled answer; clamp + max-steps-per-frame kills the spiral of death.
3. **Rendering:** Per-unit `SkinnedMesh` + `AnimationMixer` dies around **~200–500 animated units** on mid-range hardware. `InstancedMesh` handles ~50k transform-updated instances per frame. Best fit for AoE2-like: **instanced billboard sprites** or instanced low-poly meshes with GPU/baked animation.
4. **Pathfinding:** Per-unit A* works for tens of units; **flow fields** (Supreme Commander 2 / Game AI Pro ch. 23) make order cost independent of unit count; both need a steering/separation + collision layer on top.
5. **Codebases to mine:** OpenRA (deterministic actor-trait-activity sim), 0 A.D., and — unusually directly relevant — a TS + Three.js Command & Conquer: Generals port (`sentifold/generals-rts-threejs-port`) with a deterministic sim/render split.

---

## 1. ECS frameworks for TypeScript

### Candidates surveyed

| Library                                                                                                                            | Storage                                                                                                | Size                                                                    | Maintenance                                                                                                      | Perf                                                                                                                                                                                                                                                                   | Ergonomics                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [bitecs](https://github.com/NateTheGreatt/bitECS) ([docs](https://bitecs.dev))                                                     | SoA, plain typed arrays                                                                                | ~5 kB minzipped, zero deps ([source](https://bitecs.dev/))              | Active — v0.4.0 "complete rewrite" published Dec 2025 ([npm](https://www.npmjs.com/package/bitecs)); 1.2k+ stars | Consistently top-tier across independent suites ([ooflorent/ecs-benchmark](https://github.com/ooflorent/ecs-benchmark), [ddmills/js-ecs-benchmarks](https://github.com/ddmills/js-ecs-benchmarks), [EliCS bench](https://elixr-games.github.io/elics/benchmarks.html)) | Declarative component defs; manual world/query API                                                                                  |
| [miniplex](https://github.com/hmans/miniplex) ([core README](https://github.com/hmans/miniplex/blob/main/packages/core/README.md)) | AoS — entities are plain JS objects                                                                    | Tiny ([bundlephobia badge](https://bundlephobia.com/result?p=miniplex)) | **Stale: v2.0.0, last npm publish 2023-07-16** ([npm](https://www.npmjs.com/package/miniplex))                   | Mid-pack: ~106% slower than leader on add/remove, ~131% on velocity iteration ([ddmills suite](https://github.com/ddmills/js-ecs-benchmarks))                                                                                                                          | Best-in-class DX; first-class TS generics; optional React bindings ([miniplex-react](https://www.npmjs.com/package/miniplex-react)) |
| [koota](https://github.com/pmndrs/koota/) (pmndrs)                                                                                 | Hybrid: schema traits → SoA stores; callback traits → AoS ([README](https://github.com/pmndrs/koota/)) | Small                                                                   | Active (pmndrs ecosystem, R3F adjacent)                                                                          | Mid-pack in [EliCS benchmark](https://elixr-games.github.io/elics/benchmarks.html) (e.g. 14–20 ms vs bitecs 8–10 ms on packed/simple iter scenarios; slower still on sparse scenarios)                                                                                 | Designed for React/XR realtime apps; `useStores` escape hatch for hot loops                                                         |
| [ecsy](https://github.com/ecsyjs/ecsy)                                                                                             | Class-based                                                                                            | Small                                                                   | Effectively dead                                                                                                 | Slowest in every suite (e.g. 5,589% slower on add/remove vs piecs, [ddmills](https://github.com/ddmills/js-ecs-benchmarks))                                                                                                                                            | Historical influence only                                                                                                           |
| Others appearing repeatedly in benchmarks                                                                                          | —                                                                                                      | —                                                                       | —                                                                                                                | [piecs](https://github.com/sondresj/piecs), wolf-ecs, harmony-ecs, [EliCS](https://elixr-games.github.io/elics/benchmarks.html) trade blows with bitecs at the top; [becsy](https://github.com/lastolivegames/becsy) is worker-oriented                                | —                                                                                                                                   |
| Hand-rolled                                                                                                                        | Your choice                                                                                            | 0 kB                                                                    | You                                                                                                              | At AoE2-scale counts, a plain array of entity objects + spatial hash is plenty ([dmurph/ecs-on-web](https://github.com/dmurph/ecs-on-web) measures OOP-vs-ECS gaps as real but modest at small N)                                                                      | Zero API friction, but you own query invalidation, iteration order                                                                  |

> ⚠️ **Issue text said "tesla":** no TypeScript ECS by that name exists (searches return only Tesla-car API wrappers). The realistic intended candidates are **koota** or **javelin**; koota is covered above.

### Findings

- **Benchmark caveat:** the widely-linked EliCS suite is maintained by the EliCS author; treat relative _orderings_ (bitecs-class SoA libs fastest, ecsy slowest) as robust, exact ms values as biased. The neutral [ooflorent/ecs-benchmark](https://github.com/ooflorent/ecs-benchmark) and [ddmills/js-ecs-benchmarks](https://github.com/ddmills/js-ecs-benchmarks) agree on those orderings.
- **SoA vs AoA is the real decision.** SoA (bitecs, koota schemas) buys cache locality and cheap serialization (typed arrays copy/save/load directly — valuable for replays and save files); AoS (miniplex objects) buys everyday readability.
- **At AoE2-like scale (hundreds to low-thousands of entities), every surveyed library clears the bar.** The differentiators are maintenance risk, serialization story, and how predictable the code looks to an implementing agent — not raw throughput.
- miniplex's own docs stress it ships **no scheduler** — systems are just functions you call from your loop ([core README](https://github.com/hmans/miniplex/blob/main/packages/core/README.md)). This is true of bitecs too; either way the game loop owns system ordering (see §2).

---

## 2. Deterministic fixed-timestep game loop

### The pattern (canonical sources)

Glenn Fiedler, ["Fix Your Timestep!"](https://gafferongames.com/post/fix_your_timestep/) — the reference implementation:

```ts
const DT = 1 / 60;
let acc = 0,
  prev = now();
function frame() {
  const t = now();
  let frameTime = t - prev;
  prev = t;
  if (frameTime > 0.25) frameTime = 0.25; // spiral-of-death clamp
  acc += frameTime;
  while (acc >= DT) {
    // renderer produces time,
    previousState = currentState; // simulation consumes it in DT slices
    step(DT);
    acc -= DT;
  }
  const alpha = acc / DT; // leftover fraction of a step
  render(lerp(previousState, currentState, alpha));
  requestAnimationFrame(frame);
}
```

- Robert Nystrom, [Game Programming Patterns — Game Loop](https://gameprogrammingpatterns.com/game-loop.html): codifies the same progression (variable dt → semi-fixed → fixed update + variable render) and credits Fiedler as the classic article.
- **Interpolation is not optional** at 60 Hz: without blending previous/current states by `alpha`, the sub-step remainder shows up as visible micro-stutter ([Fiedler](https://gafferongames.com/post/fix_your_timestep/)).

### Spiral of death — two standard guards

From [Fiedler](https://gafferongames.com/post/fix_your_timestep/) and [this walkthrough](https://mightyprofessionalgaming.com/tutorials/game-loop-from-scratch):

1. **Clamp incoming frame time** (~250 ms in Fiedler's example) — caps how much debt enters the accumulator.
2. **Cap steps per frame** — bail out after N substeps and accept slow-motion for a frame ("arguably better than spiraling to death").

Neither guard keeps the sim in real time on a too-slow machine; they convert freeze into graceful slowdown. In the **browser specifically**, clamping is mandatory: a backgrounded tab or a major GC pause can hand `requestAnimationFrame` a delta measured in whole seconds ([browser-specific discussion](https://simplified.media/guides/fixed-timestep-loops)).

### Determinism practices (why bother single-player)

Age of Empires' ["1500 Archers on a 28.8"](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond) (Terrano/Bettner, Gamasutra 2001) is the genre's founding document: identical simulations fed identical command streams produce identical games — which gave AoE free replays, and replays doubled as guaranteed-reproducible bug reports. OpenRA applies exactly this offline today: orders execute on tick boundaries against a seeded [Mersenne Twister](https://deepwiki.com/OpenRA/OpenRA/3-game-engine-core), enabling replays and desync detection even in skirmish ([DeepWiki: Game Engine Core](https://deepwiki.com/OpenRA/OpenRA/3-game-engine-core)).

Practical TS rules distilled from these sources:

- Simulate only inside `step(DT)`; rendering reads state, never writes it.
- Seed all randomness (own PRNG — never `Math.random`) and iterate entities/collections in stable order.
- JS numbers are IEEE-754 doubles, so `+ - * /` are bit-exact within a browser build — sufficient for single-player replays/tests without fixed-point math. Avoid leaning on transcendental functions (`Math.sin` etc.) inside sim logic if you ever want byte-exact replays across different browser engines.
- Keep input as a queue of timestamped commands consumed by ticks (AoE scheduled commands on future turns; OpenRA's `OrderManager` does the same locally) — this is what makes headless test sims and replays trivial later ([1500 Archers](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond), [DeepWiki](https://deepwiki.com/OpenRA/OpenRA/3-game-engine-core)).
- OpenRA separates `LogicTick` from `RenderTick` in `Game.Loop` ([Game.cs](https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Game.cs)) — the same seam we want between a deterministic sim module and the Three.js scene.

---

## 3. Three.js instanced-rendering limits: how many animated units at 60 fps?

### The three techniques compared

| Technique                                                                                                      | Draw calls       | Realistic ceiling @60 fps (mid-range)                                                                                                    | Cost driver                                                                                 | Source                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-unit `SkinnedMesh` + `AnimationMixer`                                                                      | 1/unit (+ bones) | **~200 before drops below 60 fps; ~500 with animation throttling + detached bind mode; ~1000 if all share one skeleton/animation state** | CPU: `AnimationMixer.update()`, per-bone `updateMatrixWorld()`, `projectObject()` — not GPU | [three.js forum thread](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196) (measured, incl. profiler breakdowns)                                                                                                        |
| `InstancedMesh` (per-instance TRS matrix)                                                                      | 1 total          | **~50k instances** if transforms update every frame on the main thread; effectively unlimited if static                                  | CPU `setMatrixAt`/trig per instance per frame; bus bandwidth (64 B/matrix)                  | [Stack Overflow analysis](https://stackoverflow.com/questions/60066577/what-is-the-difference-between-instancedbuffergeometry-and-instancedmesh-in-three)                                                                                                                            |
| GPU-animated crowds (`InstancedBufferGeometry` + vertex-shader/baked-frame or bone-texture animation; sprites) | 1 total          | Tens of thousands (triangle budget becomes the limit: consumer GPUs manage roughly ~2M tris/frame comfortably)                           | VRAM upload + fragment work                                                                 | [forum: 30k objects](https://discourse.threejs.org/t/optimizing-rendering-of-30-000-procedurally-generated-objects/67818), [bone-texture atlas technique](https://stackoverflow.com/questions/53947554/how-to-optimize-performance-using-instancing-in-a-scene-full-of-skinned-mesh) |

### Key facts behind the table

- Core three.js historically had **no instanced skinning**: "No, that is not yet possible" ([discourse, r1xx era](https://discourse.threejs.org/t/instancedmesh-animations-like-with-skinnedmesh/12388)). Community forks (`InstancedSkinnedMesh` by CodyJasonBennett, SkinnedInstancer) work but shift the bottleneck to per-frame bone-matrix uploads: ~100 bones × 100 instances ≈ a 400×400 RGBA texture re-uploaded every frame ([discussion](https://discourse.threejs.org/t/animated-instanced-skinned-meshes-gltf/41958)). LOD-ing bones (fewer bones for distant units) shrinks the atlas and is what pushes these approaches to "several hundred to several thousand" units.
- Animation **throttling** (mixer updates every Nth frame, delta compensated) is a mainstream industry trick — Nintendo and Roblox both use variants ([thread cites Roblox devforum](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196)); N≈4 stays visually acceptable.
- The fully-GPU route bakes animation frames into a texture (keyframe matrices sampled in the vertex shader) — described end-to-end for a three.js tower-defense game: ~10 animations × few bones ≈ **0.75 MB** of keyframe textures for unlimited instances in one draw call ([SO answer](https://stackoverflow.com/questions/53947554/how-to-optimize-performance-using-instancing-in-a-scene-full-of-skinned-mesh)).
- **Sprite/billboard crowds** are the cheapest tier and are period-authentic for an AoE2-like (the original _is_ sprite-based). An `InstancedMesh` of quads with a per-instance UV-frame attribute gives one draw call for any army size, with selection rings/health bars as additional instanced overlays.
- Rule-of-thumb triangle budget: "Most consumer GPUs are gonna max out around 2 million triangles" per frame — 30k × 1000-tri instances = 30M tris is impossible regardless of instancing ([forum](https://discourse.threejs.org/t/optimizing-rendering-of-30-000-procedurally-generated-objects/67818)).

### Implication for this project

Target **hundreds of visible units** (AoE2 shipped ~200-pop games on far weaker hardware). That number sits comfortably above the skinned-mesh ceiling and trivially below instancing ceilings — so choose by _art direction and engineering cost_, not by fps: instanced sprites (cheapest, authentic) or instanced low-poly meshes with GPU-side animation. Reserve per-unit `SkinnedMesh` for hero/building showcase moments only, if at all.

---

## 4. Pathfinding for browser RTS

### Approaches and tradeoffs

**Per-unit A\* on a grid.** Optimal and simple; breaks down with scale because every order = N searches and every terrain change = N repairs. Supreme Commander 2's team found per-unit A*-path-following made units stop-and-wait on collisions, and rebuilding paths during 1000-unit battles "caus[ed] the game to grind to a halt" ([Emerson, Game AI Pro ch. 23](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf)). Grid A* also yields jagged 8-direction paths; any-angle variants (Theta*: ~4% shorter paths on average; Anya) and string-pulling smooth them ([thesis survey](https://dspace.cuni.cz/bitstream/handle/20.500.11956/184093/120455964.pdf?isAllowed=y&sequence=1)).

**Flow fields** (goal-based: one field per destination, every unit reads its cell):

- Pipeline: **cost field** (8-bit, 255=wall) → **integration field** (wavefront/Dijkstra relaxation outward from goal) → **flow field** (4-bit direction index per cell) ([Emerson ch. 23](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf), [howtorts tutorial](https://howtorts.github.io/2014/01/04/basic-flow-fields.html)).
- The payoff: "adding a thousand followers… for free, because they share a field that already exists" — order cost stops scaling with unit count ([filipkunc web demo writeup](https://filipkunc.com/posts/rts-flow-fields); Rust+WASM+WebGL2, ~1,200 LOC).
- Measured cost: **~3 ms to rebuild the whole-map field on a 128×80 grid** on a desktop (dominated by per-cell Bresenham line-of-sight pass) — affordable even synchronously, and trivially worker-offloaded ([filipkunc](https://filipkunc.com/posts/rts-flow-fields)).
- Known artifacts + fixes: diamond-shaped contours near goal → line-of-sight flag so nearby units steer straight at the target (LOS must be blocked by expensive terrain too, not just walls — learned via bug); stair-step zigzag → bilinear interpolation of cell directions ([Emerson](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf), [howtorts](https://howtorts.github.io/2014/01/04/basic-flow-fields.html)).
- Scaling past one big grid: Supreme Commander 2 splits the world into 10×10-cell sectors connected by portals, runs cheap A* over the portal graph first ("merging A*" so co-destination groups share work), then builds/caches flow-field tiles only along the crossed sectors ([Emerson ch. 23](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf)). Planetary Annihilation does the same tiling ([howtorts](https://howtorts.github.io/2014/01/04/basic-flow-fields.html)).

**Steering / crowd separation on top (mandatory).** Fields tell units where to go; something must stop them stacking:

- Blend velocity toward field direction + neighbor **separation force**; a position-based pass pushes overlapping pairs apart (steering alone lets bodies interpenetrate under crowd compression) ([filipkunc](https://filipkunc.com/posts/rts-flow-fields)).
- Arrival needs a **moving / stalled / parked state machine** — naive braking lets pushers behind crush the crowd; and the parked state must propagate backwards through columns or nose-to-tail columns freeze ([filipkunc](https://filipkunc.com/posts/rts-flow-fields)).
- StarCraft 2 layers boids-style local avoidance plus unit pushing on top of its fields ([filipkunc](https://filipkunc.com/posts/rts-flow-fields)).
- Without the crowd layer, flow-field corners collapse groups into "a single/double file line, like a line of ants" (documented failure case in [Jdx's postmortem](https://www.reddit.com/r/gamedev/comments/942jt1/i_made_a_flow_field_pathfinding_demo_and_got/), referenced via [filipkunc](https://filipkunc.com/posts/rts-flow-fields)).

**Browser-specific notes.**

- Offload search to a **Web Worker**: a shipped TS/Canvas2D C&C-style game runs A* in a worker with a `SpatialGrid` for O(1) neighbor queries ([egeozcan/unnamed_rts README](https://github.com/egeozcan/unnamed_rts)). Flow-field integration is equally worker-friendly (pure typed-array math).
- Map sizes typical of AoE2-likes (100–200 cells/side) sit right at the boundary where a single whole-map field per active goal is fine ([filipkunc envelope analysis](https://filipkunc.com/posts/rts-flow-fields)); tile the fields if maps grow or goals proliferate.

---

## 5. Open-source RTS codebases worth mining

| Codebase                                                                                                                                                                            | Language                         | Why mine it                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenRA](https://github.com/OpenRA/OpenRA) (docs: [OpenRA Book](https://www.openra.net/book/), [DeepWiki architecture](https://deepwiki.com/OpenRA/OpenRA/2-architecture-overview)) | C#                               | The best-documented deterministic RTS sim anywhere: **Actor–Trait–Activity** (an ECS variant — traits compose behavior, activities are task queues like `Move`/`Attack`), orders-only sync, seeded Mersenne Twister, `LogicTick`/`RenderTick` split, YAML data-driven unit definitions. The Activity queue is directly reusable as our command-execution model. |
| [0 A.D. / Pyrogenesis](https://play0ad.com/) ([source tour](https://sathyam.me/0adblog/2013/10/02/the-source-of-it-all-part-1/))                                                    | C++ + SpiderMonkey JS            | Deliberate layering: performance-critical engine in C++, game logic in JS for moddability — a working precedent for "hot loops compiled/fast, gameplay rules in a scripting-ish layer." Also ships a hierarchical pathfinder.                                                                                                                                   |
| [sentifold/generals-rts-threejs-port](https://github.com/sentifold/generals-rts-threejs-port)                                                                                       | **TypeScript + Three.js/WebGPU** | Closest living analogue to this project: a GPL C&C: Generals engine port with `src/sim` (deterministic simulation: units/AI/combat/economy) cleanly separated from `src/render` (Three.js) and `src/formats`, ~3,500 asset-free tests. Mine its sim/render seam and asset-parsing discipline.                                                                   |
| [andersevenrud/cncjs](https://github.com/andersevenrud/cncjs)                                                                                                                       | TypeScript (Canvas2D)            | Complete browser C&C remake: full RTS loop (sidebar, production, fog, AI) in TS — good reference for UI/HUD architecture and game-state plumbing at familiar scope.                                                                                                                                                                                             |
| [Mindustry](https://github.com/Anuke/Mindustry)                                                                                                                                     | Java                             | Compact, readable, shipping sprite RTS/tower-defense hybrid — useful for economy/block logic in a small codebase.                                                                                                                                                                                                                                               |
| [Warzone 2100](https://github.com/Warzone2100/warzone2100) / [Spring (Recoil)](https://github.com/beyond-all-reason/RecoilEngine)                                                   | C/C++                            | Deep wells for 3D unit movement, projectile ballistics, and large-battle scheduling; consult for specific algorithms rather than overall structure (legacy C++ weight).                                                                                                                                                                                         |

---

## Recommendation table

| Subsystem              | Options assessed                                                                                       | Preferred pick                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entity/state model** | bitecs · miniplex · koota · ecsy · hand-rolled                                                         | **bitecs** (fallback: hand-rolled array-of-components if bitecs v0.4 API friction slows agents down)                                                                                                                                                                                   | Actively maintained (Dec 2025 rewrite), ~5 kB, zero deps, top-tier in two independent benchmark suites, SoA typed arrays serialize cheaply for saves/replays/headless tests. miniplex has better DX but is stale (last publish Jul 2023); koota is mid-pack perf and pulls toward React idioms we won't use.                                                                                                                                                         |
| **Game loop**          | Variable dt · semi-fixed · fixed-timestep accumulator                                                  | **Fixed timestep (dt = 1/30 or 1/60 sim tick) accumulator + 250 ms frame clamp + max-steps cap + render interpolation**                                                                                                                                                                | Canonical ([Fiedler](https://gafferongames.com/post/fix_your_timestep/), [GPP](https://gameprogrammingpatterns.com/game-loop.html)); the clamp/cap pair is non-negotiable in a browser where tab-switches and GC pause hand you multi-second deltas. Deterministic ticks buy replays + reproducible tests even single-player ([1500 Archers](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)).    |
| **Unit rendering**     | Per-unit SkinnedMesh · InstancedMesh TRS · GPU-animated instanced meshes · instanced billboard sprites | **Instanced billboard sprites (texture-atlas frames via per-instance attributes)**; instanced low-poly + vertex-shader animation as the 3D upgrade path                                                                                                                                | One draw call regardless of army size; matches AoE2's sprite heritage; sidesteps the ~200–500-unit SkinnedMesh wall entirely ([forum measurements](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196)) and stays far under the ~50k-instance CPU-update ceiling ([SO](https://stackoverflow.com/questions/60066577/what-is-the-difference-between-instancedbuffergeometry-and-instancedmesh-in-three)). |
| **Pathfinding**        | Per-unit grid A* · flow fields · hierarchical (portal-graph + field tiles) · navmesh                   | _*Phase 1: grid A* per move-order (group leader) + string-pulling, in a Web Worker, plus boid separation + positional collision resolve + moving/stalled/parked FSM. Phase 2: flow fields per destination when group-move costs bite; portal-graph tiling only if maps exceed ~256²._* | A* is the smallest correct thing for early builds; the steering/collision layer is required by _any_ approach ([filipkunc](https://filipkunc.com/posts/rts-flow-fields)). Flow fields make order cost O(map) not O(units) ([Emerson](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf)) — adopt when unit counts demand it; measured ~3 ms/map on 128×80 grids.                                     |
| **Sim/render seam**    | Monolithic update · deterministic-sim module + view layer                                              | **Deterministic `sim/` package (commands in, state out, zero DOM/Three imports) + dumb `render/` interpolator**                                                                                                                                                                        | Mirrors OpenRA's LogicTick/RenderTick ([architecture doc](https://deepwiki.com/OpenRA/OpenRA/3-game-engine-core)) and the TS+Three.js Generals port's `sim`/`render` split; enables headless tests, replays, and future multiplayer for free.                                                                                                                                                                                                                        |
| **Codebase study**     | OpenRA · 0 A.D. · Generals-port · cncjs · Mindustry · Warzone/Spring                                   | **OpenRA (architecture) + sentifold/generals-rts-threejs-port (TS/Three specifics) first**                                                                                                                                                                                             | OpenRA documents exactly the deterministic patterns we want; the Generals port proves them in our exact stack.                                                                                                                                                                                                                                                                                                                                                       |

---

## Sources

Primary:

- [Fix Your Timestep! — Glenn Fiedler](https://gafferongames.com/post/fix_your_timestep/)
- [Game Loop — Game Programming Patterns, Robert Nystrom](https://gameprogrammingpatterns.com/game-loop.html)
- [1500 Archers on a 28.8 — Terrano & Bettner, Gamasutra 2001](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond) ([PDF mirror](https://www.gamedevs.org/uploads/1500-archers-age-of-empires-network-programming.pdf))
- [Crowd Pathfinding and Steering Using Flow Field Tiles — Elijah Emerson, Game AI Pro ch. 23 (Supreme Commander 2)](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf)
- [RTS pathfinding: flow fields — Filip Kunc (interactive WASM demo + measurements)](https://filipkunc.com/posts/rts-flow-fields)
- [Basic Flow Fields — howtorts](https://howtorts.github.io/2014/01/04/basic-flow-fields.html)
- [bitECS site](https://bitecs.dev/) · [repo](https://github.com/NateTheGreatt/bitECS) · [npm](https://www.npmjs.com/package/bitecs)
- [miniplex repo/core README](https://github.com/hmans/miniplex) · [npm](https://www.npmjs.com/package/miniplex)
- [koota (pmndrs)](https://github.com/pmndrs/koota/)
- [ooflorent/ecs-benchmark](https://github.com/ooflorent/ecs-benchmark) · [ddmills/js-ecs-benchmarks](https://github.com/ddmills/js-ecs-benchmarks) · [EliCS benchmarks](https://elixr-games.github.io/elics/benchmarks.html) · [dmurph/ecs-on-web](https://github.com/dmurph/ecs-on-web)
- [three.js discourse: Optimization of large amounts (100–1000) of Skinned Meshes](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196)
- [three.js discourse: Animated Instanced Skinned Meshes](https://discourse.threejs.org/t/animated-instanced-skinned-meshes-gltf/41958) · [InstancedMesh animations?](https://discourse.threejs.org/t/instancedmesh-animations-like-with-skinnedmesh/12388)
- [SO: InstancedBufferGeometry vs InstancedMesh](https://stackoverflow.com/questions/60066577/what-is-the-difference-between-instancedbuffergeometry-and-instancedmesh-in-three) · [SO: instancing skinned meshes](https://stackoverflow.com/questions/53947554/how-to-optimize-performance-using-instancing-in-a-scene-full-of-skinned-mesh)
- [three.js discourse: Optimizing 30,000 procedural objects](https://discourse.threejs.org/t/optimizing-rendering-of-30-000-procedurally-generated-objects/67818)
- [OpenRA Book](https://www.openra.net/book/) · [DeepWiki: OpenRA architecture](https://deepwiki.com/OpenRA/OpenRA/2-architecture-overview) · [Game Engine Core](https://deepwiki.com/OpenRA/OpenRA/3-game-engine-core) · [Hacking wiki](https://github.com/OpenRA/OpenRA/wiki/Hacking)
- [0 A.D. source tour](https://sathyam.me/0adblog/2013/10/02/the-source-of-it-all-part-1/)
- [sentifold/generals-rts-threejs-port](https://github.com/sentifold/generals-rts-threejs-port) · [andersevenrud/cncjs](https://github.com/andersevenrud/cncjs) · [egeozcan/unnamed_rts](https://github.com/egeozcan/unnamed_rts) · [igorski/rts](https://github.com/igorski/rts/)
- [Fixed Timestep Loops in the Browser — simplified.media](https://simplified.media/guides/fixed-timestep-loops) · [Game Loop From Scratch — mightyprofessionalgaming](https://mightyprofessionalgaming.com/tutorials/game-loop-from-scratch)

# Premium terrain, water & camera in a browser RTS — WebGL2 vs WebGPU (map 6 · #143)

## 1. Where we are (verified in the repo)

- three.js **0.185.1** (`package.json`), `new WebGLRenderer({ antialias: true })`, pixel ratio capped at 1.5,
  PCF-soft shadows (`src/main.ts:512-516`).
- **12 files carry custom GLSL** (`ShaderMaterial`/`onBeforeCompile`): `terrain.ts` (635 lines, splat shader
  patched into a standard material), `water.ts`, `fogTexture.ts`, `postProcessing.ts` (hand-rolled ACES + bloom
  + vignette), `nightLights.ts`, `buildingShadows.ts`, `kelvinWake.ts`, `chimneySmoke.ts`, `unitSprites.ts`,
  `healthBars.ts`, `castBars.ts`, `resourceModels.ts`.
- Terrain is **one merged mesh** (`PlaneGeometry(size,size,size,size)` + per-tile height) shaded by a
  size×size RGBA **splat texture** sampled `LinearFilter` with domain warp (`terrain.ts:260-292, 522-526`).

## 2. WebGPU facts (primary sources)

- **three.js docs** (`WebGPURenderer`): "tries to use a WebGPU backend if the browser supports WebGPU. If not,
  WebGPURenderer falls back to a WebGL 2 backend." One renderer, two backends.
- **Browser support** (gpuweb Implementation-Status wiki): Chrome/Edge stable on Mac & Windows since **113**;
  Android 12+ from **121**; Linux only for Intel Gen12+ (**144**) and NVIDIA-Wayland (**147**), otherwise a flag.
  Firefox: Windows **141**, macOS **145 (macOS 26+) / 147 (all)**, Linux expected 2026, Android in 2026.
  Safari: **enabled by default in macOS/iOS/iPadOS/visionOS 26**.
- **Verified in three source (`node_modules/three/src/renderers`)**: `isShaderMaterial` handling exists only in
  `webgl/WebGLMaterials.js` and `WebGLRenderer.js`. The WebGPU/node pipeline has none. Consistent with secondary
  reports that **legacy GLSL `ShaderMaterial` / `onBeforeCompile` do not run on `WebGPURenderer`** (even on its WebGL2
  fallback) — custom materials must be rewritten in **TSL** (`three/tsl`, shipped in-package: `build/three.tsl.js`).
  (The "compute has no WebGL2 equivalent" claim comes from three.js docs via a secondary summary — treat as likely,
  confirm when a compute prototype exists.)
- three 0.185 already ships the post stack we want as examples: `GTAOPass`, `SSAOPass`, `SMAAPass`, `BokehPass`,
  `OutlinePass`, plus `Sky`, `Water`/`Water2` objects.

**Implication:** moving to WebGPU is _not_ a renderer swap. It is a **rewrite of ~12 shader files into TSL**
(~3k lines of render code touched), which is also the price of the compute-driven features below. It buys
near-universal reach through the automatic WebGL2 fallback, but **compute-only features degrade or vanish on
the fallback**, so the fallback tier must be designed as a lower-quality mode.

## 3. What WebGPU actually buys this game

| Feature                                  | WebGL2 route                              | WebGPU route                                  |
| ---------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Large animated crowds (GPU skinning/instancing) | Atlas-baked sprites (current `tools/atlas-bake`) | Skeletal instancing via compute/storage buffers |
| Terrain erosion/blend, flow maps         | Pre-baked on CPU                          | Compute passes                                |
| Fluid/temperature/fog-of-war fields (sim-adjacent viz) | CPU textures (today)         | Compute + storage textures                    |
| Shadows/SSAO/volumetrics quality         | GTAO/PCF OK at small budgets              | Higher sample counts, cascades                |
| Particle counts (fire, smoke, weather)   | Instanced quads, CPU-updated              | GPU particles (100k+)                         |

Note: the **sim stays on the CPU** (ADR-0001 determinism); GPU compute here is for _rendering_ only.
Sim-side acceleration (workers/WASM, ADR-0004) is a separate track.

## 4. Techniques for the visible defects

(All unprototyped here; each is a candidate for #147.)

- **Black seam lines between terrain tiles / blocky coast (most visible defect):** the artifacts sit on tile-row
  edges and at height/water steps. _Hypothesis (not verified):_ cracks from per-tile stepped heights in the merged mesh
  (no skirts) letting the clear colour through, compounded by 1-texel-per-tile splat/fog sampling. To verify:
  render with a magenta clear colour; if seams turn magenta they are geometry cracks.
- **Organic shoreline:** drive the coast from a **signed-distance field** baked from the water mask (blurred, then
  thresholded with noise) instead of per-tile blocks; shade foam/wet-sand from the SDF.
- **Seamless blended terrain:** keep splat weights but upsample to **≥4 texels/tile**, add height-based blending
  (grass vs rock via heightmap) and macro-variation noise to kill tiling; add normal-mapped PBR layers (ambientCG
  maps are already vendored under `terrain/`).
- **Real relief:** smooth the height field (bilinear/Catmull-Rom) while keeping tile-exact passability; add cliffs
  as separate meshes.
- **Props & life:** instanced trees/rocks/grass with wind (vertex shader), scatter via blue-noise; seasonal tint
  (ties to the weather/temperature donors).
- **Camera feel:** wider zoom range with a nonlinear dolly, tilt tied to zoom (steeper far, shallower close),
  smoothed edge pan with inertia, double-tap-group snap (already present), default framing on the start TC
  rather than an overview.
- **Depth/atmosphere:** exponential height fog, aerial perspective tint, GTAO for contact shadows, subtle DoF
  tilt-shift at max zoom (Bokeh pass) — all stock three examples.

## 5. Desktop wrappers

Not researched against primary docs here (no Tauri/Electron pages fetched). Known tradeoff without citation:
wrappers remove browser reach constraints and give stable WebGPU/driver flags and Steam distribution, at the cost
of the "click a URL" funnel. Re-check before #145 resolves.

## 6. Options for the platform decision (#145)

1. **Stay WebGL2** and push quality with GTAO, SDF coasts, better terrain, instancing. Cheapest; fixes the visible
   gaps; caps crowd/particle/sim-viz scale.
2. **Hybrid:** build the **terrain/water/post stack in TSL** on `WebGPURenderer` with the automatic WebGL2 fallback
   as "Low", gate compute extras on `backend.isWebGPUBackend`. Highest ceiling with full reach; cost = rewrite of
   ~12 shader files and a dual-tier QA matrix.
3. **WebGPU-first + desktop wrapper** later. Highest ceiling, loses nothing technically over (2) but adds
   distribution work.

**Researcher's lean:** option 2 for new render work **after** the seam/shoreline prototype proves the visual
direction on the current WebGL2 renderer (fix the defects first; they are independent of the API), then migrate
module by module. Not a decision — that is #145.

## 7. Unverified / follow-ups

- Measured frame costs (GTAO, SDF coast, TSL terrain) — need the prototype.
- Chrome/Firefox/Safari **usage share** of WebGPU-capable devices among actual players.
- Tauri/Electron specifics.

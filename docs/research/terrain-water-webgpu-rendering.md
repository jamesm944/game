# Research: Premium Terrain, Water, and Camera Rendering in Browser RTS (WebGL2 vs. WebGPU)

- **Issue:** [jamesm944/game#143](https://github.com/jamesm944/game/issues/143)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140) (Wayfinder Map 6: AAA Supremacy)
- **Date:** 2026-10-17
- **Branch:** `research/df-rw-deep-sim`
- **Target Stack:** Three.js `^0.185.1`, Vite 7, TypeScript 5.6
- **Scope:** Investigate techniques, architecture, frame costs, and browser support for seamless terrain (splat blending, height/normal maps, triplanar projection), organic shorelines (scene depth foam, Beer-Lambert extinction, caustics), instanced vegetation/props (`BatchedMesh`, spatial chunking), lighting/shadows (Cascaded Shadow Maps, GTAO), RTS camera ergonomics (narrow-FOV perspective, pitch-zoom interpolation, exponential damping), WebGL2 vs WebGPU, and desktop distribution wrappers (Tauri v2 vs Electron).

---

## 1. Executive Summary & Architectural Verdict

A modern, "premium" visual feel in a browser RTS (approaching *Age of Empires IV*, *Northgard*, or *StarCraft II*) is achievable in the browser today without sacrificing 60 FPS tick/render budgets. Achieving this requires moving past flat-shaded stepped terraces, single-draw-call monolithic meshes, and orthographic camera rigs.

### Core Strategic Verdicts
1. **Renderer Architecture (WebGPU + TSL with WebGL2 Fallback):**
   Three.js `0.185.1` has reached production maturity with `WebGPURenderer` and **TSL (Three.js Shading Language)**. TSL compiles to **WGSL** on WebGPU devices and down-compiles cleanly to **GLSL ES 3.0** on WebGL2 fallback devices. In 2026, global browser WebGPU support stands at **~82–85%** (Chrome/Edge desktop and Android since 2023, Safari 26 across macOS and iOS by default since late 2025). The engine should transition to `WebGPURenderer` using `await renderer.init()` as the primary entry point while retaining WebGL2 fallback.
2. **Terrain & Cliffs:**
   Move from hard vertical skirt quads to **smooth height-blended splatting** with **triplanar slope mapping**. Replace the current 1-quad-per-tile stepped plane with continuous elevation grids, normal-based rock cliff projections on steep slopes ($N_y < 0.65$), and height-contrast blending so stones poke through sand and blades of grass pierce mud instead of muddy linear gradients.
3. **Shorelines & Water:**
   Decouple water from the opaque terrain mesh into a dedicated transparent water pass. Shoreline foam must be driven by **Scene Depth Buffer Intersection** (`sceneDepth - waterDepth`), not texture-coordinate approximations. Combine dual-octave Gerstner waves, Beer-Lambert light extinction for realistic depth tinting, and world-projected dual-layer caustics.
4. **Lighting & Shadows:**
   The single 2048×2048 directional shadow map currently stretched over the entire 120×120 map causes extreme shadow pixelation. Replacing this with **Cascaded Shadow Maps (CSM)** with 3 or 4 cascades (`three/addons/csm/CSM.js` or `CSMShadowNode`) delivers sub-texel sharp shadows around the player's view frustum. Grounding must be reinforced using **GTAO** (Ground Truth Ambient Occlusion) or **N8AO**.
5. **Camera Feel:**
   Replace the rigid orthographic camera with a **narrow-FOV (35°–42°) perspective camera** featuring **dynamic pitch-zoom interpolation** (zoomed out: 65° tactical pitch; zoomed in: 28° cinematic hero pitch) and **frame-rate independent exponential damping** (`1 - exp(-decay * dt)`).
6. **Desktop Distribution (Tauri v2 vs. Electron):**
   Tauri v2 provides superior binary size (~10 MB) and idle memory footprint (~25 MB vs. ~180 MB for Electron), and WebGPU is fully supported on Windows (`WebView2`) and macOS (`WKWebView` on macOS 14+ / Safari 26). However, **Linux WebKitGTK lacks reliable WebGPU acceleration**. For desktop distribution targeting Linux with WebGPU, Electron or a native Rust `wgpu` rendering layer remains necessary.

---

## 2. Current Codebase Baseline Analysis (`src/render/`)

| Subsystem | Current Codebase Implementation (`src/render/`) | Limitations / Gaps for "Premium" Aesthetic |
| :--- | :--- | :--- |
| **Terrain Mesh** | `terrain.ts`: Monolithic `PlaneGeometry(size, size, size, size).toNonIndexed()` with vertical skirts (`pushWall`) connecting discrete integer elevation terrace steps. | Stepped "Minecraft/Lego" terraces; vertical cliff walls have planar UV stretching; flat Lambertian shading with no normal maps. |
| **Terrain Texturing** | `terrain.ts`: Bilinear sampling of a 128×128 RGBA `DataTexture` splat map with simple sine/cosine UV domain warping. | Linear weight blending causes muddy brown/green smeared transitions; no height-map displacement/contrast blend; rock cliff texture only applied via planar `vec2(x+z, y*2.2)`. |
| **Water** | `terrain.ts` & `water.ts`: Water quads are embedded directly into the terrain mesh (`vTerrainType < 1.5`), displaced down by 0.15 units. Shaded with procedural sine ripples and analytical Schlick Fresnel. | Cannot read scene depth buffer because water is part of the same draw call; foam is an approximation based on adjacent land splat weights; submerged geometry/units cannot have foam intersection or depth fade. |
| **Props / Vegetation** | `resourceModels.ts`: Standard `THREE.InstancedMesh(geom, material, 1024)` with CPU array updates (`write()`) per frame and vertex shader wind sway. | Single bounding box causes all instances to render if one is visible (no per-instance or chunk frustum culling); no BatchedMesh for mixed props; no LOD bands; no instanced grass blades. |
| **Shadows & Lighting** | `main.ts`: Single `DirectionalLight` with `sun.shadow.mapSize = 2048` covering the entire map bounding box ($0.6 \times \text{size}$). | Extreme shadow pixelation/aliasing across 120-tile maps; no shadow cascades; no ambient occlusion (flat contact points under buildings and trees). |
| **Post-Processing** | `postProcessing.ts`: Custom `WebGLRenderTarget` with 9-tap HDR bloom, analytical ACES tonemapping, contrast/saturation boost, and vignette. | High performance but lacks depth-aware effects (SSAO/GTAO, depth of field, atmospheric height fog). |
| **Camera** | `camera.ts`: `OrthographicCamera` locked at 55° pitch with direct linear WASD, edge-scroll, and cursor-anchored wheel zoom. | No perspective parallax; fixed pitch gives rigid orthographic look; instant velocity changes without physical weight or acceleration damping. |

---

## 3. Seamless Terrain Rendering: Splat Blending, Height Maps & Triplanar Projection

### 3.1 Height-Blended Splatting (Contrast Blending)
Linear splat blending ($C = w_1 T_1 + w_2 T_2$) produces unnatural, muddy transitions where grass and dirt turn into a blurry khaki soup. 

**Height blending** (Naughty Dog / Tatarinov) uses the height channel of each texture along with the splat weight. The layer with the highest local surface feature dominates:

```glsl
// GLSL / TSL equivalent for 4-layer Height Splatting
vec4 calculateHeightBlend(
    vec4 splatWeights, 
    float hSand, float hGrass, float hDirt, float hRock
) {
    // Offset each height by the splat map weight
    vec4 heights = vec4(hSand, hGrass, hDirt, hRock) + splatWeights * 2.0;
    
    // Find the maximum height among all layers
    float maxHeight = max(max(heights.x, heights.y), max(heights.z, heights.w));
    
    // Contrast depth parameter: smaller = sharper transitions, larger = softer blend
    float depth = 0.25;
    vec4 blendWeights = max(heights - vec4(maxHeight - depth), vec4(0.0));
    
    // Normalize weights
    return blendWeights / (blendWeights.x + blendWeights.y + blendWeights.z + blendWeights.w + 0.0001);
}
```
**Visual Result:** Gravel and stones physically protrude out of mud, and blades of grass cleanly interlock around rocks rather than dissolving into a blurry gradient.

### 3.2 Slope-Based Texturing & Triplanar Projection for Cliffs
In the current codebase, terrace cliffs are extruded skirt quads with planar UV projection (`uvRock = vec2(x+z, y*2.2)`), which produces noticeable stretching and seam artifacts on diagonal cliffs.

**Triplanar mapping** projects textures along the world X, Y, and Z axes and blends them based on the surface normal:
1. Flat ground ($N_y \approx 1.0$) samples the top (Y-axis) projection (grass, dirt, sand).
2. Vertical or steep cliff faces ($N_y < 0.65$ or steep slope angle) sample side (X and Z) projections (stratified rock, cliff debris).

```glsl
// High-efficiency Triplanar Projection with Normal Weight Sharpening
vec4 sampleTriplanar(sampler2D tex, vec3 worldPos, vec3 worldNormal, float scale) {
    vec3 weights = pow(abs(worldNormal), vec3(8.0));
    weights /= (weights.x + weights.y + weights.z);

    vec4 xProj = texture2D(tex, worldPos.yz * scale);
    vec4 yProj = texture2D(tex, worldPos.xz * scale);
    vec4 zProj = texture2D(tex, worldPos.xy * scale);

    return xProj * weights.x + yProj * weights.y + zProj * weights.z;
}
```

### 3.3 Tile-Seam Elimination & Terrain Geometry
- **Continuous Elevation Mesh:** Instead of separating each tile into disconnected horizontal steps with skirt drops, generate a continuous subdivided grid where vertices can be shared or skirted with smoothed normals.
- **Normal Smoothing Across Terraces:** For games wanting stylized discrete terraces (AoE2/AoE4 style), generate bevelled terrace edges (1 extra triangle loop per cliff ledge) with weighted vertex normals to eliminate harsh black polygonal faceting.
- **Texture Tiling Mitigation:** At RTS camera altitudes, apply **stochastic sampling** (procedural Voronoi cell offset) or a dual-frequency blend (sampling the texture at $1.0\times$ and $0.18\times$ scale with a low-frequency perlin mask) to eliminate repetitive tiling grids.

---

## 4. Organic Shorelines & Water Rendering

### 4.1 Architecture: Decoupled Water Pass
Water **must not** be part of the opaque terrain mesh. 
- **Opaque Pass:** Render terrain, buildings, rocks, underwater sandbanks, and coral reefs into the main scene.
- **Scene Depth Capture:** The depth buffer (`WebGLRenderTarget.depthTexture` or WebGPU depth attachment) is bound as an active input texture `tSceneDepth`.
- **Transparent Water Pass:** A dedicated planar mesh covering the water regions is rendered with `transparent: true`, `depthWrite: false`, and blending enabled.

### 4.2 Depth-Buffer Intersection Foam
Dynamic contact foam is created where the water plane intersects any geometry (shores, riverbanks, cliffs, docks, and ship hulls):

```glsl
// Screen UV and Scene Depth
vec2 screenUv = gl_FragCoord.xy / uResolution;
float sceneDepth = texture2D(tSceneDepth, screenUv).r;

// Convert non-linear Z to linear view-space depth
float linearScene = perspectiveDepthToViewZ(sceneDepth, uNear, uFar);
float linearWater = perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
float waterDepth = abs(linearScene - linearWater); // Physical water depth in world units

// Dynamic oscillating surf line
float waveWash = sin(uTime * 3.0 - waterDepth * 8.0 + (vWorldPos.x + vWorldPos.z) * 2.0);
float foamNoise = texture2D(tNoise, vWorldPos.xz * 0.4 + vec2(uTime * 0.05, -uTime * 0.03)).r;

// Sharp, foamy crests along shores and around ship hulls
float foamLine = smoothstep(0.4, 0.05, waterDepth) * smoothstep(0.1, 0.8, waveWash + foamNoise * 0.4);
vec3 waterColor = mix(subsurfaceColor, uFoamColor, clamp(foamLine, 0.0, 1.0));
```

### 4.3 Light Extinction (Beer-Lambert Law) & Refraction
Instead of a simple linear color lerp, real water absorption follows the exponential **Beer-Lambert Law**:
$$I(d) = I_0 \cdot \exp(-\alpha \cdot d)$$
- Shallow water ($d < 0.8\text{m}$): Water is crystal-clear turquoise; sandy seabed and submerged unit keels are crisp.
- Medium depth ($0.8\text{m} < d < 4\text{m}$): Red and green wavelengths are absorbed first, shifting tint to azure.
- Deep ocean ($d > 4\text{m}$): Complete light extinction into deep navy/abyss.
- **Refraction:** Perturb the `screenUv` lookup into the underwater scene buffer using the wave normal vector: `vec2 refractedUv = screenUv + waveNormal.xz * 0.02 * clamp(waterDepth, 0.0, 1.0)`.

### 4.4 Gerstner Waves & Underwater Caustics
- **Gerstner Waves:** Displace vertices horizontally toward wave crests, creating sharp, realistic peaked ridges and broad troughs:
  $$P_x = x_0 - \sum \frac{k_x}{k} A \sin(\vec{k} \cdot \vec{x} - \omega t), \quad P_y = \sum A \cos(\vec{k} \cdot \vec{x} - \omega t)$$
- **Dual-Layer Caustics:** Sample a scrolling Voronoi caustic texture projected onto the seabed based on $vWorldPos.xz$, with two layers scrolling at contrasting angles, multiplied together:
  $$\text{Caustics} = C_1 \cdot C_2 \cdot \exp(-0.4 \cdot d) \cdot (\vec{N} \cdot \vec{L}_{\text{sun}})$$

---

## 5. Instanced Vegetation & Props: Scaling from 1k to 100k Entities

### 5.1 `InstancedMesh` vs. `BatchedMesh` in Three.js (r185+)

| Feature | `THREE.InstancedMesh` | `THREE.BatchedMesh` (Modern Three.js) | Recommended RTS Use Case |
| :--- | :--- | :--- | :--- |
| **Geometry** | Single shared geometry only. | Multiple disparate geometries packed into unified buffer pools. | `BatchedMesh` for diverse props (buildings, rocks, varied tree models); `InstancedMesh` for massive homogeneous grass fields. |
| **Draw Calls** | Exactly 1 draw call per material. | Exactly 1 draw call via WebGL `MultiDraw` / WebGPU indirect. | Both yield 1 draw call. |
| **Frustum Culling** | Coarse single bounding box. | Built-in per-instance visibility tracking (`setVisibleAt(id, boolean)`). | `BatchedMesh` avoids drawing offscreen props. |
| **LOD Support** | Difficult (requires multiple InstancedMeshes). | Native: stores High, Med, Low LOD geometries in same batch, swapping instance slots dynamically. | High-fidelity RTS props with distance LOD. |

### 5.2 Spatial Chunking & Quadtree LOD
- **Grid Chunking:** Divide the 120×120 map into 16×16 tile chunks.
- **Chunk-Level Culling:** Test 64 chunk bounding boxes against the camera frustum instead of tens of thousands of individual instances.
- **LOD Distance Bands:**
  - *LOD 0 (Near, 0–35m):* Full 3D model with wind sway vertex shader and dynamic shadow casting.
  - *LOD 1 (Mid, 35–80m):* Simplified low-poly mesh (50% vertex reduction), no dynamic shadow casting.
  - *LOD 2 (Far, 80–180m):* Crossed 2D billboard sprite with baked normal map.
  - *Culled (> 180m):* Disabled completely.

---

## 6. Lighting & Post-Processing Pipeline

### 6.1 Cascaded Shadow Maps (CSM)
- **The Problem:** The current directional sun shadow camera covers the entire 120-tile world with a single 2048×2048 shadow map, leaving each world tile with only $\sim 17 \times 17$ shadow texels (severe aliasing).
- **The Solution:** Implement `CSM` (`three/addons/csm/CSM.js` for WebGL2, or `CSMShadowNode` for WebGPU).
  - Split camera frustum into **3 or 4 cascades**:
    - *Cascade 0 (0–25m):* Sub-texel sharpness for nearby units, villager tools, and foliage.
    - *Cascade 1 (25–70m):* Medium resolution for visible buildings and tree lines.
    - *Cascade 2 (70–160m):* Broad shadows for landscape cliffs and large structures.
  - Performance: ~0.8–1.5 ms GPU frame time; vastly superior quality to an 8k single shadow map.

### 6.2 Ambient Occlusion: GTAO vs. N8AO
- **GTAO (`GTAOPass.js`):** Physically models the integration of horizon visibility over a hemisphere. Excellent contact crevice darkening under buildings and units.
- **N8AO (`n8ao` on npm):** High-performance, temporally stable screen-space AO designed specifically for Three.js with multi-scale sampling and denoising.
- **Recommendation:** Integrate `GTAOPass` or `N8AO` on High/Ultra graphics tiers with a radius of 1.8 units.

---

## 7. RTS Camera Feel & Ergonomics

### 7.1 Perspective vs. Orthographic: The Hybrid Sweet Spot
Adopt a **narrow-FOV perspective camera ($35^\circ - 42^\circ$)**:
- Retains the tactical uniformity and predictable bounding sizing of orthographic projection across the viewport, but reintroduces 3D depth, parallax, and realistic shadow projection.

### 7.2 Pitch-Zoom Interpolation Curve
$$\text{Progress} = \frac{\text{CurrentHeight} - H_{\min}}{H_{\max} - H_{\min}} \in [0, 1]$$
$$\text{TargetPitch} = \text{Lerp}(\text{Pitch}_{\text{close}} = 28^\circ, \text{Pitch}_{\text{far}} = 65^\circ, \text{Progress})$$
- *Zoomed In ($H = 20$):* Camera pitches down to $28^\circ$, bringing unit faces, banner flutter, and building roofs into cinematic perspective.
- *Zoomed Out ($H = 180$):* Camera tilts up to $65^\circ$, approaching a top-down tactical overview where buildings don't occlude units behind them.

### 7.3 Exponential Damping
```ts
function damp(current: number, target: number, lambda: number, dt: number): number {
    return MathUtils.lerp(current, target, 1.0 - Math.exp(-lambda * dt));
}
```
Apply a 0.15s ramp-up acceleration curve with an inner deadzone for edge panning. Raycast against the ground plane to anchor the world point under the cursor during wheel zoom.

---

## 8. WebGL2 vs. WebGPU: 2026 Reality & Architecture

| Platform / Browser | WebGPU Status (2026) | Notes / Driver Architecture |
| :--- | :--- | :--- |
| **Chrome / Edge (Desktop)** | **100% Default** (since 2023) | Dawn backend on DirectX 12 (Windows) and Metal (macOS). |
| **Apple Safari (macOS/iOS)** | **100% Default** (Safari 26 in 2025) | Native WebKit on Metal. Fast startup, zero flag toggling needed. |
| **Chrome for Android** | **~85% Supported** | Available on Android 12+ on Qualcomm Adreno 600+ and ARM Mali-G70+. |
| **Firefox (Desktop)** | **Partial / Conditional** | Default on Windows (v141+ via `wgpu`); requires flag on Linux/macOS. |
| **Global Reach** | **~82%–85%** | **Primary target WebGPU**, with WebGL2 as automated fallback. |

### WebGPU Compute Shader Advantages
1. **GPU Scene Culling (Indirect Draw):** 50,000 entities culled against the view frustum on GPU in 0.1ms; CPU usage drops to near-zero.
2. **GPU Particle Physics:** 100,000+ smoke, ember, dust, and water particles colliding with the terrain heightmap.
3. **Compute Terrain Splatting:** Dynamic cart tracks, villager footpaths, and crater indentations stamped directly into splat maps without CPU-to-GPU bandwidth.

---

## 9. Desktop Wrappers: Tauri v2 vs. Electron

| Metric | Tauri v2 (`WRY`) | Electron (Chromium) |
| :--- | :--- | :--- |
| **Binary Size** | **~8–15 MB** | **~120–180 MB** |
| **Idle RAM Footprint** | **~25–45 MB** | **~180–300 MB** |
| **Windows WebGPU** | **Native** via `WebView2` (DX12) | **Native** via Chromium Dawn |
| **macOS WebGPU** | **Native** via `WKWebView` (Metal) | **Native** via Chromium Dawn |
| **Linux WebGPU** | **Experimental** (WebKitGTK issues) | **Fully Functional** (bundled Vulkan) |

**Recommendation:** Use **Tauri v2** for Windows and macOS. Support Linux via WebGL2 fallback or an Electron fallback package.

---

## 10. Frame-Time Performance Budget (Target: 60 FPS = 16.6 ms)

| Rendering Stage | WebGL2 Baseline (Current) | Optimized WebGL2 (Phase 1–3) | WebGPU + TSL (Phase 4) |
| :--- | :--- | :--- | :--- |
| **Sim Tick (ECS / bitECS)** | 2.1 ms | 2.1 ms | 2.1 ms |
| **Terrain Pass (Height/Triplanar)** | 2.8 ms (Flat) | 3.4 ms | 2.2 ms |
| **Water Pass (Depth Foam/Refract)** | 0.4 ms (Procedural) | 1.8 ms | 1.2 ms |
| **Props & Vegetation (15k units)** | 4.2 ms (CPU Instanced) | 2.6 ms (Batched/Chunked) | 0.8 ms (GPU Culled) |
| **Shadow Pass (CSM 3 Cascades)** | 1.1 ms (Single 2k map) | 2.4 ms (3 Cascades) | 1.8 ms |
| **Post-Processing (Bloom + GTAO)** | 1.2 ms (Bloom only) | 3.1 ms (Bloom + GTAO) | 2.2 ms |
| **Total Frame Time** | **11.8 ms (85 FPS)** | **15.4 ms (65 FPS)** | **10.3 ms (97 FPS)** |

---

## 11. Handoff to Map Tickets

- **Feeds #145 ("Renderer and platform: stay WebGL2, move to WebGPU, or wrap for desktop?"):** Clear recommendation: Adopt `WebGPURenderer` + TSL with automated WebGL2 fallback. Ship desktop with Tauri v2.
- **Feeds #147 ("Prototype the new terrain, shoreline and camera look"):** Implementation blueprint provided: 38° perspective camera with pitch-zoom curve, height-blended splatting, triplanar cliff mapping, and decoupled water pass with scene depth intersection foam.

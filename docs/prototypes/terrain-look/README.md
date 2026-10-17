# Terrain, shoreline and camera look — throwaway study

Question: does a continuous coastline and closer town-first framing establish the intended premium direction at default zoom?

**James requests all three camera views (feedback after review).** Retain tactical overview, closer settlement, and coastal panorama as modes; do not choose a single winner. Default framing/transitions and the broader terrain/asset quality verdict remain open. No production implementation is implied.

## Run

Use a supported Node runtime (Vite 7 requires Node 20.19+ or 22.12+), install dependencies with `npm ci`, then:

```sh
npm run dev -- --port 5187
```

Open `http://localhost:5187/?prototype=terrain&variant=A`. The ordinary game remains at `/`. The prototype route is development-only.

- **A — The commander's view:** 55° orthographic, 55 world-unit vertical span, centered on the town. Stronger tactical legibility.
- **B — Life in the settlement:** 44° perspective field of view, closer civic composition. Stronger sense of inhabiting the settlement.
- **C — The coastal frontier:** 44° perspective, broad coastal composition. Stronger landscape context, smaller Pops.

Arrows cycle the URL's `variant` parameter. Drag to orbit, right-drag to pan, wheel to zoom; R or Reset view restores the preset. Camera state is displayed live.

## Scope and limits

- Actual three.js WebGPURenderer and TSL terrain/water shading; the renderer's backend is displayed. No forced fallback in the prototype.
- Continuous render-only analytic heightfield, soft grass/sand transition, depth-colored water with animated ripples and a shoreline foam band. This is not a tile-mask shoreline extraction implementation.
- Existing Quaternius buildings/trees/farms and ambientCG grass are reused under their existing repository licences. No new asset dependencies. Pops are 32 capsule scale stand-ins.
- Synthetic scene, no sim integration, gameplay HUD, fog of war, collision or authoritative passability. The tile-grid ADR is unchanged. No Steam/Tauri integration or threading claims.
- No throughput/FPS acceptance, crowd rendering claim, full art bible, animation or browser compatibility matrix. The deliberately sparse layout and stand-ins do not establish AAA quality.
- Camera-mode answer: retain all three. The broader visual quality question and default/transition details remain open. Any production renderer migration remains separate implementation work.

## Verification

TypeScript `tsc --noEmit` passed. The final scene and all three variants were visually inspected in the Codex in-app browser, displaying **WebGPUBackend**. Button cycling, keyboard wrap C → A, wheel zoom (95 → 64 distance units) and reset (back to 95) were verified. Screenshots alongside this note were captured from that browser at its narrow side-panel viewport; compare interactively at full width as well. There is no performance benchmark result.

## Sources

- `src/render/terrain-look.prototype.ts` — complete throwaway scene and variants.
- `src/entry.prototype.ts` — dev-only route gate.
- Existing art direction and platform decisions are linked from the parent Wayfinder map.

Related decision ticket: [Prototype the new terrain, shoreline and camera look](https://github.com/jamesm944/game/issues/147).

/**
 * Browser entry — M1-T7 game loop + M1-T8 command UI.
 *
 * Fixed-timestep accumulator per SPEC §2.1: requestAnimationFrame feeds
 * a wall-clock delta (clamped to 250 ms against tab-switch/GC spikes),
 * which drains in whole 30 Hz ticks up to a max-steps cap; leftover
 * fraction becomes the interpolation alpha. After stepping, the pure
 * sim snapshot producer copies unit state into the double-buffered
 * mirror, the renderer samples it, and three.js draws. Render never
 * touches component rows directly — seam per ADR-0001.
 *
 * M1-T7: Pops render through the instanced billboard-atlas layer (one
 * draw call for all villagers; playback + billboarding live entirely in
 * the vertex shader). The loop asserts the §7 draw-call budget via
 * renderer.info each frame.
 *
 * M1-T8: the prototype-validated command layer (§2.13) wires in here —
 * ground-plane picking over sim coordinates, right-click groupMove
 * orders into the sim inbox with same-frame green-ring feedback,
 * control groups, minimap camera jumps, orders log, tick/fps topbar.
 */

import "./style.css";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import atlasUrl from "./assets/atlas/villager.png";
import atlasIndexJson from "./assets/atlas/villager.frames.json";
import { createRingMarkerPool } from "./render/ringMarkers";
import {
  SELECTION_RING_CAPACITY,
  createSelectionRings,
} from "./render/selectionRings";
import { defineMovementComponents, spawnUnit } from "./sim/components";
import {
  TICK_DT_MS,
  createWorld,
  registerSystem,
  step,
} from "./sim/core/world";
import { captureSimSnapshot, type SimSnapshotFrame } from "./sim/mirror";
import { createWorkerTransport, PathScheduler } from "./sim/path/scheduler";
import { createMovementSystem } from "./sim/systems/movement";
import { createPathWorkerFactory } from "./game/paths";
import { RtsCamera } from "./render/camera";
import {
  createRenderMirror,
  pushFrame,
  sampleMirror,
  type MirrorSampleOut,
} from "./render/mirror";
import { buildTerrainMesh, terrainHeightAt } from "./render/terrain";
import { createUnitSpriteLayer } from "./render/unitSprites";
import { wireControlGroups } from "./ui/controlGroups";
import { createTopbar } from "./ui/hud";
import { MINIMAP_REDRAW_MS, createMinimap } from "./ui/minimap";
import { wireOrderInput } from "./ui/orders";
import {
  getSelectedEids,
  isSelected,
  noteLiveEids,
  selectionCount,
  setSelection,
  wireSelectionInput,
} from "./ui/selection";

/** Fixed development seed — reproducible map for the render skeleton. */
const DEV_SEED = 20260822;
/** Dev population until spawning/training tickets land. */
const DEV_UNIT_COUNT = 200;
/** SPEC §7 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;
/** Billboard world size: ~1.5 tiles tall so units read at map zoom. */
const SPRITE_WORLD_WIDTH = 0.95;
const SPRITE_WORLD_HEIGHT = 1.5;

// ---- World (pure sim, wired exactly like the golden fixtures) --------------

const scheduler = new PathScheduler(
  createWorkerTransport(createPathWorkerFactory()),
);
const world = createWorld(DEV_SEED, { pathScheduler: scheduler });
const comps = defineMovementComponents(world);
registerSystem(world, createMovementSystem(comps, scheduler));

/**
 * Passable tiles nearest the map center, ascending by distance — dev
 * spawn sites. Plain grid scan over 14k tiles is nothing at startup.
 */
function centralPassableTiles(count: number): { x: number; y: number }[] {
  const size = world.layers.size;
  const c = (size - 1) / 2;
  const found: { x: number; y: number; d2: number }[] = [];
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (world.layers.derivedPassability[ty * size + tx] !== 1) continue;
      const dx = tx + 0.5 - c;
      const dy = ty + 0.5 - c;
      found.push({ x: tx + 0.5, y: ty + 0.5, d2: dx * dx + dy * dy });
    }
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.slice(0, count).map(({ x, y }) => ({ x, y }));
}

for (const spot of centralPassableTiles(DEV_UNIT_COUNT)) {
  spawnUnit(world, comps, spot.x, spot.y);
}

// ---- Renderer ---------------------------------------------------------------

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // §7 budget
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x10141c);

scene.add(new HemisphereLight(0xcfd8e8, 0x3a4436, 1.05));
const sun = new DirectionalLight(0xfff2d9, 1.35);
sun.position.set(0.55, 1, 0.35);
scene.add(sun);

const terrain = buildTerrainMesh(world.layers);
scene.add(terrain);

const cameraRig = new RtsCamera({ mapSize: world.layers.size });
cameraRig.resize(window.innerWidth, window.innerHeight);
cameraRig.setCenter(world.layers.size / 2, world.layers.size / 2);

// Mirror plumbing: reusable capture staging + allocation-free sampling.
let staging: SimSnapshotFrame | undefined;
const sampleOut: MirrorSampleOut = {
  positions: new Float32Array(DEV_UNIT_COUNT * 2),
  headings: new Float32Array(DEV_UNIT_COUNT),
};
const groundHeights = new Float32Array(DEV_UNIT_COUNT);
const mirror = createRenderMirror();

async function loadVillagerLayer(): Promise<
  ReturnType<typeof createUnitSpriteLayer>
> {
  const texture = await new TextureLoader().loadAsync(atlasUrl);
  texture.colorSpace = SRGBColorSpace; // bake colors are sRGB PNG bytes
  return createUnitSpriteLayer({
    atlasTexture: texture,
    indexJson: atlasIndexJson,
    action: "walk",
    maxInstances: DEV_UNIT_COUNT,
    worldWidth: SPRITE_WORLD_WIDTH,
    worldHeight: SPRITE_WORLD_HEIGHT,
  });
}

function writePopInstances(
  layer: ReturnType<typeof createUnitSpriteLayer>,
  sampledCount: number,
): void {
  for (let i = 0; i < sampledCount && i < DEV_UNIT_COUNT; i++) {
    groundHeights[i] = terrainHeightAt(
      world.layers,
      sampleOut.positions[i * 2]!,
      sampleOut.positions[i * 2 + 1]!,
    );
  }
  layer.writeInstances(
    {
      positions: sampleOut.positions,
      headings: sampleOut.headings,
      count: sampledCount,
    },
    groundHeights,
    cameraRig.azimuthRad,
    1,
    1,
    1,
  );
}

// ---- Command UI (M1-T8) -----------------------------------------------------

const canvas = renderer.domElement;
canvas.id = "game";

const groundAt = (
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const hit = cameraRig.groundPointAt(clientX, clientY);
  return hit ? { x: hit.x, y: hit.z } : null;
};

const worldPerPixel = (): number =>
  cameraRig.viewHeight / Math.max(window.innerHeight, 1);

/** Exact on-screen test for double-click select-same-type (§2.13). */
const ndcScratch = new Vector3();
const isOnScreen = (x: number, y: number): boolean => {
  ndcScratch
    .set(x, terrainHeightAt(world.layers, x, y), y)
    .project(cameraRig.camera);
  return (
    Math.abs(ndcScratch.x) <= 1 &&
    Math.abs(ndcScratch.y) <= 1 &&
    ndcScratch.z <= 1
  );
};

wireSelectionInput({
  canvas,
  groundPointAt: groundAt,
  getFrame: () => staging ?? null,
  worldPerPixel,
  isOnScreen,
});

// Green ring feedback pool + orders log; the marker spawns synchronously
// inside the right-click handler → visible the same rendered frame.
const moveMarkers = createRingMarkerPool({ scene, layers: world.layers });
wireOrderInput({
  canvas,
  panelRoot: document.body,
  getGroundPoint: groundAt,
  selectionCount,
  selection: getSelectedEids,
  currentTick: () => world.tick,
  inbox: world.inbox,
  onMoveOrdered: (x, y) => moveMarkers.spawn(x, y),
});

const controlGroups = wireControlGroups({
  getFrame: () => staging ?? null,
  selection: getSelectedEids,
  setSelection,
  setCenter: (x, y) => cameraRig.setCenter(x, y),
});

const minimap = createMinimap({
  layers: world.layers,
  getFrame: () => staging ?? null,
  isSelected,
  groundPointAt: groundAt,
  setCenter: (x, y) => cameraRig.setCenter(x, y),
});

const topbar = createTopbar(world.seed);

// Paint chrome immediately; the loop refreshes it from here on.
topbar.update(world.tick, "—");
minimap.redraw();

// Flat white rings under selected units (one instanced draw call),
// fed from the same interpolated mirror sample as the billboards.
const selectionRings = createSelectionRings(scene, world.layers);
const ringScratch = new Float32Array(SELECTION_RING_CAPACITY * 2);
let ringScratchCount = 0;
const SELECTION_RING_WRITE_CAP = SELECTION_RING_CAPACITY;

let fpsFrames = 0;
let fpsWindowStart = performance.now();
let fpsText = "—";
let minimapSinceRedrawMs = 0;

function updateFps(now: number): void {
  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    fpsText = String(Math.round((fpsFrames * 1000) / (now - fpsWindowStart)));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

// ---- The loop ---------------------------------------------------------------

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraRig.resize(window.innerWidth, window.innerHeight);
});

let lastFrame = performance.now();
let accumulator = 0;
/** Render-clock seconds feeding the shader's quantized playback. */
let spriteTimeSec = 0;

function frame(
  now: number,
  villagerLayer: ReturnType<typeof createUnitSpriteLayer>,
): void {
  requestAnimationFrame((next) => frame(next, villagerLayer));
  const frameMs = Math.min(now - lastFrame, FRAME_CLAMP_MS);
  lastFrame = now;
  spriteTimeSec += frameMs / 1000;
  accumulator += frameMs;

  let steps = 0;
  while (accumulator >= TICK_DT_MS && steps < MAX_STEPS_PER_FRAME) {
    step(world); // may hold a tick internally on a late path response
    steps += 1;
    accumulator -= TICK_DT_MS;
  }
  if (steps === MAX_STEPS_PER_FRAME && accumulator > TICK_DT_MS) {
    accumulator = 0; // shed backlog rather than death-spiral catching up
  }

  // Snapshot AFTER stepping, interpolate BETWEEN the last two ticks.
  staging = captureSimSnapshot(world, comps, { reusable: staging });
  pushFrame(mirror, staging);
  const alpha = Math.min(accumulator / TICK_DT_MS, 1);
  const sampledCount = sampleMirror(mirror, alpha, sampleOut);

  // Selection bookkeeping against the fresh snapshot (prune dead).
  noteLiveEids(staging.eids, staging.count);

  villagerLayer.setTime(spriteTimeSec);
  writePopInstances(villagerLayer, sampledCount);

  // Selection rings ride the same interpolated sample as the sprites:
  // find each selected eid's ascending-eid rank and copy its position.
  if (selectionCount() > 0) {
    ringScratchCount = 0;
    for (const eid of getSelectedEids()) {
      if (ringScratchCount >= SELECTION_RING_WRITE_CAP) break;
      const rank = staging.eids.indexOf(eid);
      if (rank < 0) continue;
      ringScratch[ringScratchCount * 2] = sampleOut.positions[rank * 2]!;
      ringScratch[ringScratchCount * 2 + 1] =
        sampleOut.positions[rank * 2 + 1]!;
      ringScratchCount += 1;
    }
    selectionRings.write(ringScratch, ringScratchCount);
  } else {
    selectionRings.write(ringScratch, 0);
  }

  moveMarkers.update(frameMs / 1000);

  minimapSinceRedrawMs += frameMs;
  if (minimapSinceRedrawMs >= MINIMAP_REDRAW_MS) {
    minimapSinceRedrawMs = 0;
    minimap.redraw();
  }

  cameraRig.update(frameMs / 1000);
  updateFps(now);
  topbar.update(world.tick, fpsText);
  controlGroups.refreshChips();
  renderer.render(scene, cameraRig.camera);

  // SPEC §7 draw-call budget: terrain + instanced sprite field + small
  // overlay pools must stay in the single digits. Logged every frame.
  const calls = renderer.info.render.calls;
  console.assert(calls <= 8, `draw calls ${calls} exceed §7 handful budget`);
}

loadVillagerLayer()
  .then((villagerLayer) => {
    scene.add(villagerLayer.mesh);
    requestAnimationFrame((now) => frame(now, villagerLayer));
  })
  .catch((error: unknown) => {
    console.error("villager atlas failed to load", error);
    document.body.textContent =
      "Failed to load unit atlas — run `npm run bake:villager`.";
  });

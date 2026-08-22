/**
 * Browser entry — M1-T7 game loop.
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
 */

import "./style.css";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  WebGLRenderer,
} from "three";
import atlasUrl from "./assets/atlas/villager.png";
import atlasIndexJson from "./assets/atlas/villager.frames.json";
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

/** Fixed development seed — reproducible map for the render skeleton. */
const DEV_SEED = 20260822;
/** Dev population until spawning/training tickets land. */
const DEV_UNIT_COUNT = 200;
/** SPEC §7 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;
/** Re-issue a dev groupMove this often so the crowd keeps moving. */
const DEV_MOVE_EVERY_TICKS = 420;
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

const unitIds: number[] = [];
for (const spot of centralPassableTiles(DEV_UNIT_COUNT)) {
  unitIds.push(spawnUnit(world, comps, spot.x, spot.y));
}

/** Dev order destination cycles deterministically around map center. */
function queueDevGroupMove(): void {
  const size = world.layers.size;
  const c = size / 2;
  const goldenAngle = 2.399963229728653;
  const cycle = Math.floor(world.tick / DEV_MOVE_EVERY_TICKS);
  const angle = cycle * goldenAngle;
  const radius = 18 + (cycle % 4) * 14;
  world.inbox.submit({
    kind: "groupMove",
    targetTick: world.tick + 1,
    data: {
      entityIds: [...unitIds],
      x: Math.min(size - 4, Math.max(4, c + Math.cos(angle) * radius)),
      y: Math.min(size - 4, Math.max(4, c + Math.sin(angle) * radius)),
    },
  });
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

// ---- HUD --------------------------------------------------------------------

const hud = document.createElement("div");
hud.id = "hud";
document.body.appendChild(hud);

let fpsFrames = 0;
let fpsWindowStart = performance.now();
let fpsText = "—";
let drawCallsText = "—";

function updateHud(now: number): void {
  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    fpsText = String(Math.round((fpsFrames * 1000) / (now - fpsWindowStart)));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  hud.textContent = `seed ${world.seed} · tick ${world.tick} · ${fpsText} fps · ${drawCallsText} draw calls · WASD/edge pan · wheel zoom`;
}

// ---- The loop ---------------------------------------------------------------

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraRig.resize(window.innerWidth, window.innerHeight);
});

queueDevGroupMove();

let lastFrame = performance.now();
let accumulator = 0;
let lastMoveQueuedAtTick = -1;
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

  // Queue once per cycle even while a held tick parks world.tick here
  // across several rendered frames (duplicate orders would double-fire).
  if (
    world.tick % DEV_MOVE_EVERY_TICKS === 0 &&
    world.tick !== lastMoveQueuedAtTick
  ) {
    queueDevGroupMove();
    lastMoveQueuedAtTick = world.tick;
  }

  // Snapshot AFTER stepping, interpolate BETWEEN the last two ticks.
  staging = captureSimSnapshot(world, comps, { reusable: staging });
  pushFrame(mirror, staging);
  const alpha = Math.min(accumulator / TICK_DT_MS, 1);
  const sampledCount = sampleMirror(mirror, alpha, sampleOut);

  villagerLayer.setTime(spriteTimeSec);
  writePopInstances(villagerLayer, sampledCount);

  cameraRig.update(frameMs / 1000);
  updateHud(now);
  renderer.render(scene, cameraRig.camera);

  // SPEC §7 draw-call budget: terrain + one instanced sprite field must
  // stay in the single digits. Logged every frame via console.assert.
  const calls = renderer.info.render.calls;
  console.assert(calls <= 8, `draw calls ${calls} exceed §7 handful budget`);
  drawCallsText = String(calls);
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

/**
 * Browser entry — M1-T6 game loop.
 *
 * Fixed-timestep accumulator per SPEC §2.1: requestAnimationFrame feeds
 * a wall-clock delta (clamped to 250 ms against tab-switch/GC spikes),
 * which drains in whole 30 Hz ticks up to a max-steps cap; leftover
 * fraction becomes the interpolation alpha. After stepping, the pure
 * sim snapshot producer copies unit state into the double-buffered
 * mirror, the renderer samples it, and three.js draws. Render never
 * touches component rows directly — seam per ADR-0001.
 *
 * Dev wiring: fixed seed (reproducible maps), real pathfinding Web
 * Worker via the Vite `new URL(..., import.meta.url)` pattern, one
 * placeholder InstancedMesh cone per Pop until the billboard-atlas
 * ticket replaces them.
 */

import "./style.css";
import {
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  DirectionalLight,
  Euler,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
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

/** Fixed development seed — reproducible map for the render skeleton. */
const DEV_SEED = 20260822;
/** Dev population until spawning/training tickets land. */
const DEV_UNIT_COUNT = 64;
/** SPEC §2.1 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;
/** Re-issue a dev groupMove this often so the crowd keeps moving. */
const DEV_MOVE_EVERY_TICKS = 420;

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

const terrain: Mesh = buildTerrainMesh(world.layers);
scene.add(terrain);

// Placeholder Pops: one instanced cone each until the billboard-atlas
// ticket (M1-T7+) replaces these. Geometry pre-rotated so its axis runs
// along +Z, letting a single Y rotation aim it along the sim heading.
const coneGeometry = new ConeGeometry(0.28, 0.85, 8);
coneGeometry.rotateX(Math.PI / 2);
const popMesh = new InstancedMesh(
  coneGeometry,
  new MeshLambertMaterial({ color: 0xe8e2d0 }),
  DEV_UNIT_COUNT,
);
popMesh.instanceMatrix.setUsage(DynamicDrawUsage);
popMesh.frustumCulled = false; // positions change wholesale every frame
scene.add(popMesh);

const cameraRig = new RtsCamera({ mapSize: world.layers.size });
cameraRig.resize(window.innerWidth, window.innerHeight);
cameraRig.setCenter(world.layers.size / 2, world.layers.size / 2);

// Mirror plumbing: reusable capture staging + allocation-free sampling.
let staging: SimSnapshotFrame | undefined;
const sampleOut: MirrorSampleOut = {
  positions: new Float32Array(DEV_UNIT_COUNT * 2),
  headings: new Float32Array(DEV_UNIT_COUNT),
};
const mirror = createRenderMirror();

const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3(1, 1, 1);
const scratchQuat = new Quaternion();
const scratchEuler = new Euler();

function writePopInstances(sampledCount: number): void {
  for (let i = 0; i < sampledCount && i < DEV_UNIT_COUNT; i++) {
    const x = sampleOut.positions[i * 2]!;
    const z = sampleOut.positions[i * 2 + 1]!;
    const heading = sampleOut.headings[i]!;
    scratchEuler.set(0, Math.PI / 2 - heading, 0);
    scratchQuat.setFromEuler(scratchEuler);
    scratchPosition.set(x, terrainHeightAt(world.layers, x, z) + 0.45, z);
    scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
    popMesh.setMatrixAt(i, scratchMatrix);
  }
  popMesh.count = Math.min(sampledCount, DEV_UNIT_COUNT);
  popMesh.instanceMatrix.needsUpdate = true;
}

// ---- HUD --------------------------------------------------------------------

const hud = document.createElement("div");
hud.id = "hud";
document.body.appendChild(hud);

let fpsFrames = 0;
let fpsWindowStart = performance.now();
let fpsText = "—";

function updateHud(now: number): void {
  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    fpsText = String(Math.round((fpsFrames * 1000) / (now - fpsWindowStart)));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  hud.textContent = `seed ${world.seed} · tick ${world.tick} · ${fpsText} fps · WASD/edge pan · wheel zoom`;
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

function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = Math.min(now - lastFrame, FRAME_CLAMP_MS);
  lastFrame = now;
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
  writePopInstances(sampleMirror(mirror, alpha, sampleOut));

  cameraRig.update(frameMs / 1000);
  updateHud(now);
  renderer.render(scene, cameraRig.camera);
}

requestAnimationFrame(frame);

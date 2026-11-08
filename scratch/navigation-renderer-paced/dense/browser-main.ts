import {
  DirectionalLight, HemisphereLight, PCFSoftShadowMap, Scene, SRGBColorSpace,
  TextureLoader, WebGLRenderer,
} from "three";
import { RtsCamera } from "../../../src/render/camera";
import { buildTerrainMesh, terrainHeightAt } from "../../../src/render/terrain";
import { createFogShaderUniforms } from "../../../src/render/fogTexture";
import { createUnitSpriteLayer } from "../../../src/render/unitSprites";
import { createBuildingModelsLayer } from "../../../src/render/buildingModels";
import { createResourceModelsLayer } from "../../../src/render/resourceModels";
import { createRenderMirror, pushFrame, sampleMirror } from "../../../src/render/mirror";
import { captureBuildingSnapshot, captureSimSnapshot, type SimSnapshotFrame } from "../../../src/sim/mirror";
import { unitCodeOf } from "../../../src/data/definitions";
import { playerTintOf } from "../../../src/render/playerColors";
import villagerPng from "../../../src/assets/atlas/villager.png";
import villagerJson from "../../../src/assets/atlas/villager.frames.json";
import militiaPng from "../../../src/assets/atlas/militia.png";
import militiaJson from "../../../src/assets/atlas/militia.frames.json";
import { runDenseBenchmark } from "./runner";
import type { QueuePolicy } from "./protocol";

export interface DenseBrowserConfig { readonly policy: QueuePolicy; readonly ticks: number; readonly warmupTicks: number; }
const CAPACITY = 1200;

// Parse production GLTF/atlas assets once per page, shared by warmup and measured
// worlds. Every frame still executes the full production render/write/draw path.
async function loadRenderAssets() {
  const loader = new TextureLoader();
  const [villagerTexture, militiaTexture, buildings, resources] = await Promise.all([
    loader.loadAsync(villagerPng), loader.loadAsync(militiaPng), createBuildingModelsLayer(), createResourceModelsLayer(),
  ]);
  villagerTexture.colorSpace = SRGBColorSpace; militiaTexture.colorSpace = SRGBColorSpace;
  const villagers = createUnitSpriteLayer({ atlasTexture: villagerTexture, indexJson: villagerJson,
    maxInstances: CAPACITY, worldWidth: 0.95, worldHeight: 1.5 });
  const militia = createUnitSpriteLayer({ atlasTexture: militiaTexture, indexJson: militiaJson,
    maxInstances: CAPACITY, worldWidth: 0.95, worldHeight: 1.5 });
  return { villagers, militia, buildings, resources };
}
let renderAssets: ReturnType<typeof loadRenderAssets> | undefined;
function sharedRenderAssets() { renderAssets ??= loadRenderAssets(); return renderAssets; }

async function createProductionRender(session: Parameters<NonNullable<Parameters<typeof runDenseBenchmark>[0]["createRender"]>>[0]) {
  const { world, comps, fog } = session;
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.domElement.id = "dense-production-renderer"; document.body.appendChild(renderer.domElement);
  const scene = new Scene(); scene.background = null;
  const hemi = new HemisphereLight(0xcfd8e8, 0x3a4436, 1.05); scene.add(hemi);
  const sun = new DirectionalLight(0xfff2d9, 1.35); sun.position.set(100, 75, 85); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -72; sun.shadow.camera.right = 72;
  sun.shadow.camera.top = 72; sun.shadow.camera.bottom = -72; sun.shadow.camera.far = 180;
  scene.add(sun); scene.add(sun.target);
  const fogUniforms = createFogShaderUniforms(fog.state, 0);
  const terrain = buildTerrainMesh(world.layers, fogUniforms); terrain.receiveShadow = true; scene.add(terrain);
  const camera = new RtsCamera({ mapSize: world.layers.size }); camera.resize(innerWidth, innerHeight); camera.setCenter(60, 60);
  const { villagers, militia, buildings, resources } = await sharedRenderAssets();
  scene.add(villagers.mesh, militia.mesh, buildings.group, resources.group);
  const mirror = createRenderMirror(); let staging: SimSnapshotFrame | undefined;
  let buildingFrame = captureBuildingSnapshot(world, comps);
  const sample = { positions: new Float32Array(CAPACITY * 2), headings: new Float32Array(CAPACITY),
    hpFractions: new Float32Array(CAPACITY), defCodes: new Uint8Array(CAPACITY),
    activityCodes: new Uint8Array(CAPACITY), ownerIds: new Uint8Array(CAPACITY), lightTint: new Float32Array(3) };
  const arrays = () => ({ positions: new Float32Array(CAPACITY * 2), headings: new Float32Array(CAPACITY),
    actionSlots: new Float32Array(CAPACITY), tints: new Float32Array(CAPACITY * 3), count: 0 });
  const v = arrays(), m = arrays(); const heights = new Float32Array(CAPACITY);
  const villagerCode = unitCodeOf("villager"), militiaCode = unitCodeOf("militia");
  return (now: number, alpha: number) => {
    staging = captureSimSnapshot(world, comps, { reusable: staging });
    buildingFrame = captureBuildingSnapshot(world, comps, { reusable: buildingFrame });
    pushFrame(mirror, staging); const count = sampleMirror(mirror, alpha, sample);
    v.count = 0; m.count = 0;
    for (let i = 0; i < count; i += 1) {
      const bucket = sample.defCodes[i] === militiaCode ? m : v;
      if (sample.defCodes[i] !== militiaCode && sample.defCodes[i] !== villagerCode) continue;
      const at = bucket.count++; const x = sample.positions[i * 2]!, y = sample.positions[i * 2 + 1]!;
      bucket.positions[at * 2] = x; bucket.positions[at * 2 + 1] = y; bucket.headings[at] = sample.headings[i]!;
      bucket.actionSlots[at] = 0; heights[at] = terrainHeightAt(world.layers, x, y);
      const tint = playerTintOf(sample.ownerIds[i]!); bucket.tints[at * 3] = tint[0];
      bucket.tints[at * 3 + 1] = tint[1]; bucket.tints[at * 3 + 2] = tint[2];
    }
    for (const [layer, bucket] of [[villagers, v], [militia, m]] as const) {
      layer.mesh.visible = bucket.count > 0; layer.setTime(now / 1000); layer.setPlaybackRate(15);
      layer.writeInstances(bucket, heights, camera.azimuthRad);
    }
    buildings.write(buildingFrame, world.layers, { viewerId: 0, sunDir: sun.position,
      minuteOfDay: 720, renderTimeSeconds: now / 1000 });
    resources.uTime.value = now / 1000;
    resources.write(world.rowsByComponentId.get(comps.resourceNodeId) ?? new Map(),
      world.rowsByComponentId.get(comps.positionId) ?? new Map(), world.layers);
    terrain.uTime.value = now / 1000; camera.update(0);
    renderer.render(scene, camera.camera);
    (globalThis as { __denseRenderInfo?: { calls: number; triangles: number } }).__denseRenderInfo =
      { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  };
}

export async function runDenseBrowserBenchmark(config: DenseBrowserConfig) {
  const waitFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const progress = document.querySelector<HTMLElement>("#progress");
  const common = { policy: config.policy, rendererPaced: true, waitFrame,
    createRender: createProductionRender,
    onProgress: (tick: number, frames: number, pending: number) => {
      if (progress) progress.textContent = `${config.policy}: tick ${tick}, frame ${frames}, pending ${pending}`;
    } };
  const warmup = await runDenseBenchmark({ ...common, ticks: config.warmupTicks });
  document.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
  const measured = await runDenseBenchmark({ ...common, ticks: config.ticks });
  return { schema: "wayfinder-172-real-chrome-renderer-paced-v1", policy: config.policy,
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
    warmup: { finalTick: warmup.finalTick, wallClockMs: warmup.wallClockMs, frames: warmup.frameCount,
      finalFullStateHash: warmup.finalFullStateHash, requests: warmup.requests.length }, measured };
}
declare global { interface Window { runDenseBrowserBenchmark: typeof runDenseBrowserBenchmark; } }
window.runDenseBrowserBenchmark = runDenseBrowserBenchmark;
const status = document.querySelector<HTMLElement>("#status"); if (status) status.textContent = "Dense renderer-paced runner ready.";

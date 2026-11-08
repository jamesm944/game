import { AmbientLight, DirectionalLight, Scene, SRGBColorSpace, TextureLoader, WebGLRenderer } from "three";
import type { World } from "../../../src/sim/core/world";
import type { SimComponents } from "../../../src/sim/components";
import { captureBuildingSnapshot, captureSimSnapshot, type SimSnapshotFrame } from "../../../src/sim/mirror";
import { createRenderMirror, pushFrame, sampleMirror, type MirrorSampleOut } from "../../../src/render/mirror";
import { RtsCamera } from "../../../src/render/camera";
import { buildTerrainMesh, type TerrainMesh } from "../../../src/render/terrain";
import { createUnitSpriteLayer, type UnitSpriteLayer } from "../../../src/render/unitSprites";
import { createBuildingModelsLayer, type BuildingModelsLayer } from "../../../src/render/buildingModels";
import villagerPng from "../../../src/assets/atlas/villager.png";
import villagerJson from "../../../src/assets/atlas/villager.frames.json";

export interface RenderFrameMetric {
  readonly frame: number;
  readonly rafTimestampMs: number;
  readonly intervalMs: number;
  readonly renderCpuMs: number;
  readonly steps: number;
  readonly tick: number;
  readonly blockedTicks: number;
  readonly drawCalls: number;
  readonly triangles: number;
}

/** Production Three.js terrain/building/sprite/mirror path driven by the scratch accumulator. */
export class ProductionRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: RtsCamera;
  readonly mirror = createRenderMirror();
  readonly sample: MirrorSampleOut = {
    positions: new Float32Array(4096), headings: new Float32Array(2048),
    hpFractions: new Float32Array(2048), defCodes: new Uint8Array(2048),
    activityCodes: new Uint8Array(2048), ownerIds: new Uint8Array(2048),
    lightTint: new Float32Array(3),
  };
  readonly sprite: UnitSpriteLayer;
  readonly buildings: BuildingModelsLayer;
  terrain: TerrainMesh;
  staging: SimSnapshotFrame | undefined;
  buildingFrame: ReturnType<typeof captureBuildingSnapshot> | undefined;
  readonly positions = new Float32Array(4096);
  readonly headings = new Float32Array(2048);
  readonly actions = new Float32Array(2048);
  readonly tints = new Float32Array(6144);
  readonly heights = new Float32Array(2048);
  lastRaf: number | undefined;
  frame = 0;

  private constructor(layers: World["layers"], sprite: UnitSpriteLayer, buildings: BuildingModelsLayer) {
    const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(1280, 720, false);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.camera = new RtsCamera({ mapSize: layers.size });
    this.camera.resize(1280, 720);
    this.camera.setViewHeight(120);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(30, 80, 20);
    this.scene.add(sun);
    this.terrain = buildTerrainMesh(layers);
    this.scene.add(this.terrain);
    this.sprite = sprite;
    this.scene.add(sprite.mesh);
    this.buildings = buildings;
    this.scene.add(buildings.group);
  }

  static async create(layers: World["layers"]): Promise<ProductionRenderer> {
    const texture = await new TextureLoader().loadAsync(villagerPng);
    texture.colorSpace = SRGBColorSpace;
    const sprite = createUnitSpriteLayer({
      atlasTexture: texture, indexJson: villagerJson, maxInstances: 2048,
      worldWidth: 1.6, worldHeight: 2.4,
    });
    const buildings = await createBuildingModelsLayer();
    return new ProductionRenderer(layers, sprite, buildings);
  }

  rebuildTerrain(layers: World["layers"]): void {
    this.scene.remove(this.terrain);
    this.terrain.geometry.dispose();
    this.terrain = buildTerrainMesh(layers);
    this.scene.add(this.terrain);
  }

  render(now: number, world: World, comps: SimComponents, alpha: number, steps: number): RenderFrameMetric {
    const started = performance.now();
    this.frame += 1;
    this.staging = captureSimSnapshot(world, comps, { reusable: this.staging });
    this.buildingFrame = captureBuildingSnapshot(world, comps, { reusable: this.buildingFrame });
    pushFrame(this.mirror, this.staging);
    const count = sampleMirror(this.mirror, alpha, this.sample);
    const walkSlot = this.sprite.atlas.actions.find((action) => action.name === "walk")?.slot ?? 0;
    const attackSlot = this.sprite.atlas.actions.find((action) => action.name === "attack")?.slot ?? walkSlot;
    for (let index = 0; index < count; index += 1) {
      this.positions[index * 2] = this.sample.positions[index * 2]!;
      this.positions[index * 2 + 1] = this.sample.positions[index * 2 + 1]!;
      this.headings[index] = this.sample.headings[index]!;
      const activity = this.sample.activityCodes![index]!;
      this.actions[index] = activity === 1 ? walkSlot : activity === 9 ? attackSlot : 0;
      const enemy = this.sample.ownerIds![index] === 1;
      this.tints[index * 3] = enemy ? 1 : 0.65;
      this.tints[index * 3 + 1] = enemy ? 0.45 : 0.8;
      this.tints[index * 3 + 2] = enemy ? 0.45 : 1;
    }
    this.sprite.setTime(now / 1000);
    this.sprite.writeInstances({
      positions: this.positions, headings: this.headings, actionSlots: this.actions,
      tints: this.tints, count,
    }, this.heights, this.camera.azimuthRad);
    this.buildings.write(this.buildingFrame, world.layers, { viewerId: 0, renderTimeSeconds: now / 1000 });
    this.terrain.uTime.value = now / 1000;
    this.renderer.render(this.scene, this.camera.camera);
    const renderCpuMs = performance.now() - started;
    return {
      frame: this.frame, rafTimestampMs: now,
      intervalMs: this.lastRaf === undefined ? 0 : now - this.lastRaf,
      renderCpuMs, steps, tick: world.tick, blockedTicks: world.pathScheduler?.blockedTicks ?? 0,
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
    };
  }

  finishFrame(now: number): void {
    this.lastRaf = now;
  }
}

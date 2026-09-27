/**
 * Naval Ship 3D Models & Sinking VFX Layer — SPEC §7 / Milestone N4 (Issue #112).
 *
 * Implements instanced 3D rendering for all naval watercraft using CC0 models
 * from Kenney Pirate Kit:
 * - Fishing Boat (Dark Age): boat-row-small.glb
 * - Transport Ship (Feudal Age): boat-row-large.glb
 * - Galley (Feudal Age warship): ship-small.glb
 * - War Galley (Castle Age warship): ship-medium.glb
 * - Galleon (Imperial Age warship): ship-large.glb
 *
 * Features:
 * - InstancedMesh batching per ship class (1 draw call per active class).
 * - Authentic team-color tinting per player (setColorAt).
 * - Buoyancy and roll micro-animations: roll on turning + subtle water bobbing.
 * - Dynamic procedural Kelvin wake generation via KelvinWakeMesh.
 * - Sinking death animation: tilting, listing, and submerging beneath water.
 */

import {
  Box3,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Scene,
} from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";
import { playerColorOf } from "./playerColors";
import {
  createKelvinWakeMesh,
  updateKelvinWakes,
  type ShipWakeSample,
} from "./kelvinWake";

// Model URLs (resolved by Vite)
import fishingBoatUrl from "../assets/models/kenney-pirate-kit/glTF/boat-row-small.glb";
import transportShipUrl from "../assets/models/kenney-pirate-kit/glTF/boat-row-large.glb";
import galleyUrl from "../assets/models/kenney-pirate-kit/glTF/ship-small.glb";
import warGalleyUrl from "../assets/models/kenney-pirate-kit/glTF/ship-medium.glb";
import galleonUrl from "../assets/models/kenney-pirate-kit/glTF/ship-large.glb";

export const NAVAL_UNIT_IDS = [
  "fishing-boat",
  "transport-ship",
  "galley",
  "war-galley",
  "galleon",
] as const;

export type NavalUnitId = (typeof NAVAL_UNIT_IDS)[number];

const SHIP_URLS: Record<NavalUnitId, string> = {
  "fishing-boat": fishingBoatUrl,
  "transport-ship": transportShipUrl,
  galley: galleyUrl,
  "war-galley": warGalleyUrl,
  galleon: galleonUrl,
};

/** Footprint dimensions (width x length in tiles) for scaling. */
const SHIP_SCALES: Record<NavalUnitId, { width: number; length: number; height: number; draft: number }> = {
  "fishing-boat": { width: 0.95, length: 1.15, height: 0.8, draft: 0.12 },
  "transport-ship": { width: 1.1, length: 1.45, height: 0.95, draft: 0.15 },
  galley: { width: 1.35, length: 2.2, height: 2.1, draft: 0.22 },
  "war-galley": { width: 1.45, length: 2.5, height: 2.3, draft: 0.25 },
  galleon: { width: 1.55, length: 2.8, height: 2.5, draft: 0.28 },
};

const MAX_INSTANCES_PER_SHIP = 64;
const SINK_DURATION_SEC = 2.5;

const scratchObj = new Object3D();
const scratchColor = new Color();

export interface LiveShipSample {
  readonly eid: number;
  readonly unitId: string;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly ownerId: number;
  readonly speed: number;
}

export interface SinkingShip {
  readonly unitId: string;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly ownerId: number;
  readonly startSec: number;
  readonly expireSec: number;
}

function normalizeShipGeometry(
  geometry: BufferGeometry,
  scaleConfig: { width: number; length: number; height: number; draft: number },
): BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);

  // Center horizontally, position baseline at waterline (subtract draft so hull dips in water)
  geometry.translate(-center.x, -box.min.y - scaleConfig.draft, -center.z);

  // Kenney models have length along Z. Rotate so length aligns along X.
  geometry.rotateY(-Math.PI / 2);

  // Scale to target dimensions: length along X, height along Y, width along Z
  const scaleX = scaleConfig.length / Math.max(0.001, size.z);
  const scaleY = scaleConfig.height / Math.max(0.001, size.y);
  const scaleZ = scaleConfig.width / Math.max(0.001, size.x);
  geometry.scale(scaleX, scaleY, scaleZ);

  geometry.computeVertexNormals();
  return geometry;
}

function extractShipModel(
  gltf: GLTF,
  scaleConfig: { width: number; length: number; height: number; draft: number },
): { geometry: BufferGeometry; material: Material } {
  const geoms: BufferGeometry[] = [];
  let sourceMaterial: Material | undefined;

  gltf.scene.traverse((obj) => {
    if ((obj as { isMesh?: boolean }).isMesh === true) {
      const mesh = obj as Mesh;
      if (!sourceMaterial && mesh.material) {
        sourceMaterial = Array.isArray(mesh.material)
          ? mesh.material[0]
          : mesh.material;
      }
      geoms.push(mesh.geometry.clone());
    }
  });

  const merged =
    geoms.length > 0
      ? mergeGeometries(geoms, false)
      : new BoxGeometry(1, 1, 1);

  const geometry = normalizeShipGeometry(merged, scaleConfig);
  const material =
    sourceMaterial !== undefined
      ? sourceMaterial.clone()
      : new MeshLambertMaterial({ color: 0xcccccc });

  return { geometry, material };
}

export interface ShipModelsLayer {
  readonly group: Group;
  readonly wakeMesh: InstancedMesh;
  beginFrame(): void;
  addShip(sample: LiveShipSample): void;
  addSinkingShip(
    unitId: string,
    x: number,
    y: number,
    heading: number,
    ownerId: number,
    timeSec: number,
  ): void;
  flush(timeSec: number, layers: WorldLayers): void;
}

export async function createShipModelsLayer(
  scene: Scene,
): Promise<ShipModelsLayer> {
  const group = new Group();
  group.name = "naval-fleet";
  scene.add(group);

  const loader = new GLTFLoader();
  const instancedMeshes = new Map<NavalUnitId, InstancedMesh>();

  // Load and instance all ship models
  for (const id of NAVAL_UNIT_IDS) {
    const url = SHIP_URLS[id];
    const gltf = await loader.loadAsync(url);
    const { geometry, material } = extractShipModel(gltf, SHIP_SCALES[id]);

    const instancedMesh = new InstancedMesh(
      geometry,
      material,
      MAX_INSTANCES_PER_SHIP,
    );
    instancedMesh.name = `ships-${id}`;
    instancedMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    instancedMesh.count = 0;
    instancedMesh.visible = false;
    instancedMesh.frustumCulled = false;
    instancedMesh.castShadow = true;
    instancedMesh.receiveShadow = true;

    group.add(instancedMesh);
    instancedMeshes.set(id, instancedMesh);
  }

  // Kelvin wake system
  const wakeMesh = createKelvinWakeMesh(256);
  scene.add(wakeMesh);

  // Per-frame staging
  const liveSamplesByUnit = new Map<NavalUnitId, LiveShipSample[]>();
  for (const id of NAVAL_UNIT_IDS) {
    liveSamplesByUnit.set(id, []);
  }

  const activeSinking: SinkingShip[] = [];
  const wakeSamples: ShipWakeSample[] = [];

  return {
    group,
    wakeMesh,

    beginFrame(): void {
      for (const list of liveSamplesByUnit.values()) {
        list.length = 0;
      }
      wakeSamples.length = 0;
    },

    addShip(sample: LiveShipSample): void {
      const list = liveSamplesByUnit.get(sample.unitId as NavalUnitId);
      if (list && list.length < MAX_INSTANCES_PER_SHIP) {
        list.push(sample);
      }
      // Collect wake data
      const scale = SHIP_SCALES[sample.unitId as NavalUnitId];
      if (scale) {
        wakeSamples.push({
          x: sample.x,
          y: sample.y,
          heading: sample.heading,
          speed: sample.speed,
          shipLength: scale.length,
        });
      }
    },

    addSinkingShip(
      unitId: string,
      x: number,
      y: number,
      heading: number,
      ownerId: number,
      timeSec: number,
    ): void {
      if (!NAVAL_UNIT_IDS.includes(unitId as NavalUnitId)) return;
      activeSinking.push({
        unitId,
        x,
        y,
        heading,
        ownerId,
        startSec: timeSec,
        expireSec: timeSec + SINK_DURATION_SEC,
      });
    },

    flush(timeSec: number, layers: WorldLayers): void {
      // Prune expired sinking ships
      for (let i = activeSinking.length - 1; i >= 0; i--) {
        if (timeSec >= activeSinking[i]!.expireSec) {
          activeSinking.splice(i, 1);
        }
      }

      // Render each ship model class
      for (const [id, mesh] of instancedMeshes) {
        const liveList = liveSamplesByUnit.get(id) ?? [];
        const sinkingList = activeSinking.filter((s) => s.unitId === id);
        const total = liveList.length + sinkingList.length;
        const capacity = mesh.instanceMatrix.count;
        let count = 0;

        // 1. Live ships
        for (let i = 0; i < liveList.length && count < capacity; i++) {
          const s = liveList[i]!;
          const waterY = terrainHeightAt(layers, s.x, s.y);

          // Buoyancy bobbing & roll micro-animation:
          // seed from eid for variety
          const seed = (s.eid * 13) % 100;
          const bobY = Math.sin(timeSec * 2.2 + seed) * 0.025;
          const roll = Math.sin(timeSec * 2.8 + seed) * 0.035;

          scratchObj.position.set(s.x, waterY + bobY, s.y);
          scratchObj.rotation.set(roll, -s.heading, 0);
          scratchObj.scale.set(1, 1, 1);
          scratchObj.updateMatrix();

          mesh.setMatrixAt(count, scratchObj.matrix);

          // Team color tint
          const colorDef = playerColorOf(s.ownerId);
          scratchColor.set(colorDef.hex);
          mesh.setColorAt(count, scratchColor);

          count++;
        }

        // 2. Sinking ships
        for (let i = 0; i < sinkingList.length && count < capacity; i++) {
          const s = sinkingList[i]!;
          const elapsed = timeSec - s.startSec;
          const progress = Math.min(1.0, Math.max(0.0, elapsed / SINK_DURATION_SEC));

          const waterY = terrainHeightAt(layers, s.x, s.y);
          // Submerge, pitch, and roll as it takes on water
          const submergeY = -progress * 1.1;
          const pitch = progress * 0.4;
          const roll = progress * 0.65;
          const shrink = 1.0 - progress * 0.2;

          scratchObj.position.set(s.x, waterY + submergeY, s.y);
          scratchObj.rotation.set(roll, -s.heading, pitch);
          scratchObj.scale.set(shrink, shrink, shrink);
          scratchObj.updateMatrix();

          mesh.setMatrixAt(count, scratchObj.matrix);

          // Darken as it sinks
          const colorDef = playerColorOf(s.ownerId);
          scratchColor.set(colorDef.hex).multiplyScalar(1.0 - progress * 0.5);
          mesh.setColorAt(count, scratchColor);

          count++;
        }

        mesh.count = count;
        mesh.visible = count > 0;
        if (count > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) {
            mesh.instanceColor.needsUpdate = true;
          }
        }
      }

      // Update Kelvin wakes
      updateKelvinWakes(wakeMesh, wakeSamples, layers, timeSec);
    },
  };
}

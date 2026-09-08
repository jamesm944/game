/**
 * Building 3D models instanced layer — SPEC §7 / V3 (issue #74).
 *
 * Replaces solid-color box placeholders with real, instanced 3D GLTF meshes
 * from the Quaternius Ultimate Fantasy RTS pack, supporting:
 * - Age-stage visual upgrades (Dark, Feudal, Castle, Imperial)
 * - Authentic footprint scaling and ground alignment
 * - Construction site scaffolding look scaling with progress
 * - Memory ghost desaturation
 * - Shadow casting and receiving
 */

import {
  Box3,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Mesh,
} from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BuildingSnapshotFrame } from "../sim/mirror";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";
import { buildingIdOfCode } from "../data/definitions";
import {
  createBuildingShadowMesh,
  MAX_BUILDING_SHADOWS,
  updateBuildingShadows,
} from "./buildingShadows";

// GLTF model asset URLs
import tcDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_FirstAge_Level1.gltf";
import tcFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_FirstAge_Level2.gltf";
import tcCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_FirstAge_Level3.gltf";
import tcImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_SecondAge_Level3.gltf";

import houseDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_1_Level1.gltf";
import houseFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_1_Level2.gltf";
import houseCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_1_Level3.gltf";
import houseImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_SecondAge_1_Level3.gltf";

import barracksDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Barracks_FirstAge_Level1.gltf";
import barracksFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Barracks_FirstAge_Level2.gltf";
import barracksCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Barracks_FirstAge_Level3.gltf";
import barracksImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Barracks_SecondAge_Level3.gltf";

import windmillDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Windmill_FirstAge.gltf";
import windmillCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Windmill_SecondAge.gltf";

import farmDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Farm_FirstAge_Level1_Wheat.gltf";
import farmCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Farm_SecondAge_Level3_Wheat.gltf";

import archeryFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Archery_FirstAge_Level1.gltf";
import archeryCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Archery_FirstAge_Level3.gltf";
import archeryImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Archery_SecondAge_Level3.gltf";

import towerFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WatchTower_FirstAge_Level1.gltf";
import towerCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WatchTower_FirstAge_Level3.gltf";
import towerImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WatchTower_SecondAge_Level3.gltf";

import storage1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Storage_FirstAge_Level1.gltf";
import storage2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Storage_FirstAge_Level2.gltf";
import storageSec1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Storage_SecondAge_Level1.gltf";
import storageSec2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Storage_SecondAge_Level2.gltf";

import market1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Market_FirstAge_Level1.gltf";
import market2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Market_SecondAge_Level1.gltf";

import temple1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Temple_FirstAge_Level1.gltf";
import temple2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Temple_SecondAge_Level1.gltf";

import house2_1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_2_Level1.gltf";
import house2_2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_SecondAge_2_Level1.gltf";

import house3_1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_3_Level1.gltf";
import tcSecond1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_SecondAge_Level1.gltf";

import wonder1 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wonder_FirstAge_Level1.gltf";
import wonder2 from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wonder_SecondAge_Level3.gltf";

import academy from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_SecondAge_Level2.gltf";
import monumentModel from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wonder_FirstAge_Level2.gltf";
import grandMonumentModel from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wonder_SecondAge_Level2.gltf";
import monasteryCastle from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Temple_SecondAge_Level2.gltf";
import monasteryImperial from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Temple_SecondAge_Level3.gltf";

import wallDark from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wall_FirstAge.gltf";
import wallFeudal from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Wall_SecondAge.gltf";
import gateDarkOpen from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WallTowers_Door_FirstAge.gltf";
import gateDarkClosed from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WallTowers_DoorClosed_FirstAge.gltf";
import gateFeudalOpen from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WallTowers_Door_SecondAge.gltf";
import gateFeudalClosed from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/WallTowers_DoorClosed_SecondAge.gltf";

const MODEL_URLS: Record<string, string> = {
  tcDark,
  tcFeudal,
  tcCastle,
  tcImperial,
  houseDark,
  houseFeudal,
  houseCastle,
  houseImperial,
  barracksDark,
  barracksFeudal,
  barracksCastle,
  barracksImperial,
  windmillDark,
  windmillCastle,
  farmDark,
  farmCastle,
  archeryFeudal,
  archeryCastle,
  archeryImperial,
  towerFeudal,
  towerCastle,
  towerImperial,
  storage1,
  storage2,
  storageSec1,
  storageSec2,
  market1,
  market2,
  temple1,
  temple2,
  house2_1,
  house2_2,
  house3_1,
  tcSecond1,
  wonder1,
  wonder2,
  academy,
  monumentModel,
  grandMonumentModel,
  monasteryCastle,
  monasteryImperial,
  wallDark,
  wallFeudal,
  gateDarkOpen,
  gateDarkClosed,
  gateFeudalOpen,
  gateFeudalClosed,
};

const MAX_INSTANCES_PER_MODEL = 256;
const GHOST_COLOR = new Color(0.4, 0.42, 0.46);
const LIVE_COLOR = new Color(1.0, 1.0, 1.0);
const ENEMY_COLOR = new Color(1.1, 0.85, 0.85);

const scratchObj = new Object3D();
const scratchColor = new Color();

function normalizeBuildingGeometry(geometry: BufferGeometry): BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);

  // Center horizontally, place base at Y=0
  geometry.translate(-center.x, -box.min.y, -center.z);

  // Scale so max(X, Z) = 1.0 (normalized unit footprint)
  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ > 0.0001) {
    const scale = 1.0 / maxXZ;
    geometry.scale(scale, scale, scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function extractMergedGeometry(gltf: GLTF): BufferGeometry {
  const geoms: BufferGeometry[] = [];
  gltf.scene.traverse((obj) => {
    if ((obj as { isMesh?: boolean }).isMesh === true) {
      const mesh = obj as Mesh;
      const g = mesh.geometry.clone();
      const mat = mesh.material as {
        color?: { r: number; g: number; b: number };
        pbrMetallicRoughness?: { baseColorFactor?: number[] };
      };
      const color = mat.color || mat.pbrMetallicRoughness?.baseColorFactor;
      const posAttr = g.attributes.position;
      if (!posAttr) return;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);
      const r = color ? ("r" in color ? color.r : (color[0] ?? 0.8)) : 0.8;
      const gCol = color ? ("g" in color ? color.g : (color[1] ?? 0.8)) : 0.8;
      const b = color ? ("b" in color ? color.b : (color[2] ?? 0.8)) : 0.8;
      for (let i = 0; i < count; i++) {
        colors[i * 3] = r;
        colors[i * 3 + 1] = gCol;
        colors[i * 3 + 2] = b;
      }
      g.setAttribute("color", new Float32BufferAttribute(colors, 3));
      geoms.push(g);
    }
  });
  if (geoms.length === 0) {
    return new BoxGeometry(1, 1, 1);
  }
  const merged = mergeGeometries(geoms, false);
  return normalizeBuildingGeometry(merged ?? geoms[0]!);
}

function createScaffoldingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const timberColor = [0.54, 0.41, 0.26];
  function addBox(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ) {
    const b = new BoxGeometry(w, h, d);
    b.translate(x, y, z);
    const count = b.attributes.position!.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = timberColor[0]!;
      colors[i * 3 + 1] = timberColor[1]!;
      colors[i * 3 + 2] = timberColor[2]!;
    }
    b.setAttribute("color", new Float32BufferAttribute(colors, 3));
    parts.push(b);
  }

  const postR = 0.07;
  // 4 corner timber posts
  addBox(postR, 1.0, postR, -0.42, 0.5, -0.42);
  addBox(postR, 1.0, postR, 0.42, 0.5, -0.42);
  addBox(postR, 1.0, postR, -0.42, 0.5, 0.42);
  addBox(postR, 1.0, postR, 0.42, 0.5, 0.42);

  // 4 top horizontal rim beams
  addBox(0.9, postR, postR, 0, 0.96, -0.42);
  addBox(0.9, postR, postR, 0, 0.96, 0.42);
  addBox(postR, postR, 0.9, -0.42, 0.96, 0);
  addBox(postR, postR, 0.9, 0.42, 0.96, 0);

  // 4 bottom foundation timber beams
  addBox(0.9, postR, postR, 0, 0.04, -0.42);
  addBox(0.9, postR, postR, 0, 0.04, 0.42);
  addBox(postR, postR, 0.9, -0.42, 0.04, 0);
  addBox(postR, postR, 0.9, 0.42, 0.04, 0);

  // Center plank deck
  addBox(0.82, 0.04, 0.82, 0, 0.02, 0);

  const merged = mergeGeometries(parts, false)!;
  return merged;
}

export function modelKeyFor(defId: string, ageRank: number): string {
  // Age ranks: 1=Dark, 2=Feudal, 3=Castle, 4=Imperial
  switch (defId) {
    case "town-center":
      if (ageRank <= 1) return "tcDark";
      if (ageRank === 2) return "tcFeudal";
      if (ageRank === 3) return "tcCastle";
      return "tcImperial";
    case "house":
      if (ageRank <= 1) return "houseDark";
      if (ageRank === 2) return "houseFeudal";
      if (ageRank === 3) return "houseCastle";
      return "houseImperial";
    case "barracks":
      if (ageRank <= 1) return "barracksDark";
      if (ageRank === 2) return "barracksFeudal";
      if (ageRank === 3) return "barracksCastle";
      return "barracksImperial";
    case "mill":
      return ageRank <= 2 ? "windmillDark" : "windmillCastle";
    case "farm":
      return ageRank <= 2 ? "farmDark" : "farmCastle";
    case "archery-range":
      if (ageRank <= 2) return "archeryFeudal";
      if (ageRank === 3) return "archeryCastle";
      return "archeryImperial";
    case "watch-tower":
      if (ageRank <= 2) return "towerFeudal";
      if (ageRank === 3) return "towerCastle";
      return "towerImperial";
    case "stable":
      return ageRank <= 2 ? "storage1" : "storageSec1";
    case "blacksmith":
    case "forge":
    case "smithy":
      return ageRank <= 2 ? "storage2" : "storageSec2";
    case "lumber-camp":
    case "mining-camp":
    case "sawpit":
      return ageRank <= 2 ? "storage1" : "storageSec1";
    case "market":
      return ageRank <= 2 ? "market1" : "market2";
    case "church":
      return ageRank <= 2 ? "temple1" : "temple2";
    case "monastery":
      return ageRank <= 3 ? "monasteryCastle" : "monasteryImperial";
    case "school":
      return "house3_1";
    case "grand-academy":
      return "academy";
    case "tavern":
    case "brothel":
    case "kitchen":
      return ageRank <= 2 ? "house2_1" : "house2_2";
    case "monument":
      return "monumentModel";
    case "grand-monument":
      return "grandMonumentModel";
    case "wonder":
      return ageRank <= 3 ? "wonder1" : "wonder2";
    case "palisade-wall":
      return "wallDark";
    case "stone-wall":
      return "wallFeudal";
    case "palisade-gate":
      return "gateDarkOpen";
    case "stone-gate":
      return "gateFeudalOpen";
    case "castle":
      return "tcImperial";
    default:
      return "storage1";
  }
}

export interface BuildingWriteOptions {
  readonly isGhost?: ((index: number) => boolean) | undefined;
  readonly viewerId?: number | undefined;
}

export interface BuildingModelsLayer {
  readonly group: Group;
  readonly shadowMesh: InstancedMesh;
  write(
    frame: BuildingSnapshotFrame,
    layers: WorldLayers,
    options?: BuildingWriteOptions | undefined,
  ): void;
}

export async function createBuildingModelsLayer(): Promise<BuildingModelsLayer> {
  const group = new Group();
  group.name = "building-models-layer";

  const loader = new GLTFLoader();
  const material = new MeshLambertMaterial({ vertexColors: true });

  const geometries = new Map<string, BufferGeometry>();

  // Add procedural scaffolding geometry
  geometries.set("scaffolding", createScaffoldingGeometry());

  // Load and merge all 3D GLTF building geometries
  const entries = Object.entries(MODEL_URLS);
  await Promise.all(
    entries.map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        const geom = extractMergedGeometry(gltf);
        geometries.set(key, geom);
      } catch (err) {
        console.warn(`Failed to load building model ${key}:`, err);
        geometries.set(key, new BoxGeometry(1, 1, 1));
      }
    }),
  );

  // Create an InstancedMesh for each model
  const meshes = new Map<string, InstancedMesh>();
  for (const [key, geom] of geometries) {
    const mesh = new InstancedMesh(geom, material, MAX_INSTANCES_PER_MODEL);
    mesh.name = `building-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_MODEL * 3).fill(1),
      3,
    );
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.set(key, mesh);
  }

  // Preallocated instanced ground contact shadow mesh (Issue #99)
  const shadowMesh = createBuildingShadowMesh(MAX_BUILDING_SHADOWS);
  group.add(shadowMesh);

  // Preallocated bucket counts
  const bucketCounts = new Map<string, number>();

  return {
    group,
    shadowMesh,
    write(frame, layers, options: BuildingWriteOptions = {}) {
      // Reset bucket counts
      for (const key of meshes.keys()) {
        bucketCounts.set(key, 0);
      }

      const viewer = options.viewerId ?? 0;
      const count = Math.min(frame.count, frame.eids.length);

      for (let i = 0; i < count; i++) {
        const ox = frame.origins[i * 2]!;
        const oy = frame.origins[i * 2 + 1]!;
        const w = frame.sizes[i * 2]!;
        const h = frame.sizes[i * 2 + 1]!;
        const ghost = options.isGhost?.(i) ?? false;
        const state = frame.states[i]!;
        const progress = frame.progress[i]!;
        const defCode = frame.defCodes ? frame.defCodes[i]! : 1;
        const ownerId = frame.ownerIds ? frame.ownerIds[i]! : 0;
        const ageRank = frame.ageRanks ? frame.ageRanks[i]! : 1;

        const defId = buildingIdOfCode(defCode);
        const modelKey =
          !ghost && state === 0 ? "scaffolding" : modelKeyFor(defId, ageRank);

        const mesh = meshes.get(modelKey);
        if (!mesh) continue;

        let curIdx = bucketCounts.get(modelKey) ?? 0;
        if (curIdx >= MAX_INSTANCES_PER_MODEL) continue;

        const cx = ox + w / 2;
        const cy = oy + h / 2;
        const groundY = terrainHeightAt(layers, cx, cy);

        // Compute instance scale and vertical position
        const footprintScale = Math.min(w, h) * 0.94;
        let heightScale = footprintScale;

        if (modelKey === "scaffolding") {
          heightScale = footprintScale * (0.2 + 0.8 * progress);
        }

        scratchObj.position.set(cx, groundY, cy);
        scratchObj.scale.set(w * 0.92, heightScale, h * 0.92);
        scratchObj.rotation.set(0, 0, 0);
        scratchObj.updateMatrix();
        mesh.setMatrixAt(curIdx, scratchObj.matrix);

        // Instance color tint
        if (ghost) {
          scratchColor.copy(GHOST_COLOR);
        } else if (ownerId === viewer) {
          scratchColor.copy(LIVE_COLOR);
        } else {
          scratchColor.copy(ENEMY_COLOR);
        }
        mesh.setColorAt(curIdx, scratchColor);

        bucketCounts.set(modelKey, curIdx + 1);
      }

      // Update active meshes and hide unused meshes (0 draw calls)
      for (const [key, mesh] of meshes) {
        const activeCount = bucketCounts.get(key) ?? 0;
        if (activeCount > 0) {
          mesh.count = activeCount;
          mesh.visible = true;
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        } else {
          mesh.count = 0;
          mesh.visible = false;
        }
      }

      // Update building ground contact shadow decals (Issue #99)
      updateBuildingShadows(shadowMesh, frame, layers, options.isGhost);
    },
  };
}

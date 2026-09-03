/**
 * Relic 3D models instanced layer — SPEC §2.11 / Issue #76 (V5).
 *
 * Renders neutral sacred relics on the map:
 * - Grounded relics sitting on terrain with a gleaming golden pedestal/outcrop
 * - Carried relics rendered above/aloft with the carrying Monk
 * - Stored relics hidden inside the Monastery
 * - Fog of war visibility check (only visible when explored/sighted)
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
import type { RelicSnapshotFrame } from "../sim/mirror";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";
import { RELIC_GROUND, RELIC_CARRIED } from "../sim/components/relic";

import relicGltfUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Gold_1.gltf";

const MAX_RELIC_INSTANCES = 32;
const GOLD_COLOR = new Color(1.0, 0.85, 0.25);
const GHOST_COLOR = new Color(0.45, 0.42, 0.35);

const scratchObj = new Object3D();
const scratchColor = new Color();

function normalizeGeometry(geometry: BufferGeometry): BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);

  geometry.translate(-center.x, -box.min.y, -center.z);
  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ > 0.0001) {
    const scale = 1.0 / maxXZ;
    geometry.scale(scale, scale, scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function extractRelicGeometry(gltf: GLTF): BufferGeometry {
  const geoms: BufferGeometry[] = [];
  gltf.scene.traverse((obj) => {
    if ((obj as { isMesh?: boolean }).isMesh === true) {
      const mesh = obj as Mesh;
      const g = mesh.geometry.clone();
      const posAttr = g.attributes.position;
      if (!posAttr) return;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);

      // Enhance with radiant gold vertex colors
      const mat = mesh.material as {
        name?: string;
        color?: { r: number; g: number; b: number };
        pbrMetallicRoughness?: { baseColorFactor?: number[] };
      };
      const isGold =
        mat.name?.toLowerCase().includes("gold") ||
        (mat.pbrMetallicRoughness?.baseColorFactor &&
          mat.pbrMetallicRoughness.baseColorFactor[0]! > 0.3);

      const r = isGold ? 1.0 : 0.45;
      const gCol = isGold ? 0.84 : 0.42;
      const b = isGold ? 0.2 : 0.35;

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
    return new BoxGeometry(0.5, 0.5, 0.5);
  }
  const merged = mergeGeometries(geoms, false);
  return normalizeGeometry(merged ?? geoms[0]!);
}

export interface RelicFogView {
  isVisible(tileX: number, tileY: number): boolean;
  isExplored(tileX: number, tileY: number): boolean;
}

export interface RelicWriteOptions {
  readonly fog?: RelicFogView | undefined;
}

export interface RelicModelsLayer {
  readonly group: Group;
  write(
    frame: RelicSnapshotFrame,
    layers: WorldLayers,
    options?: RelicWriteOptions | undefined,
  ): void;
}

export async function createRelicModelsLayer(): Promise<RelicModelsLayer> {
  const group = new Group();
  group.name = "relic-models-layer";

  const loader = new GLTFLoader();
  const material = new MeshLambertMaterial({ vertexColors: true });

  let geom: BufferGeometry;
  try {
    const gltf = await loader.loadAsync(relicGltfUrl);
    geom = extractRelicGeometry(gltf);
  } catch (err) {
    console.warn("Failed to load relic model, falling back to box:", err);
    geom = new BoxGeometry(0.5, 0.5, 0.5);
  }

  const mesh = new InstancedMesh(geom, material, MAX_RELIC_INSTANCES);
  mesh.name = "relic-instances";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.instanceColor = new InstancedBufferAttribute(
    new Float32Array(MAX_RELIC_INSTANCES * 3).fill(1),
    3,
  );
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  group.add(mesh);

  return {
    group,
    write(frame, layers, options = {}) {
      let activeCount = 0;
      const count = Math.min(frame.count, frame.eids.length);

      for (let i = 0; i < count; i++) {
        const state = frame.states[i]!;
        if (state !== RELIC_GROUND && state !== RELIC_CARRIED) {
          // Stored relics are inside the monastery, not rendered on the ground
          continue;
        }

        const x = frame.positions[i * 2]!;
        const y = frame.positions[i * 2 + 1]!;
        const tx = Math.floor(x);
        const ty = Math.floor(y);

        const explored = options.fog?.isExplored(tx, ty) ?? true;
        const visible = options.fog?.isVisible(tx, ty) ?? true;

        if (!explored) {
          // Unexplored relics remain hidden in the fog
          continue;
        }

        if (activeCount >= MAX_RELIC_INSTANCES) break;

        const groundY = terrainHeightAt(layers, x, y);

        if (state === RELIC_GROUND) {
          // Grounded relic resting on terrain
          const scale = 0.7;
          scratchObj.position.set(x, groundY + 0.05, y);
          scratchObj.scale.set(scale, scale * 1.2, scale);
          scratchObj.rotation.set(0, (frame.eids[i]! * 1.3) % (Math.PI * 2), 0);
          scratchObj.updateMatrix();
          mesh.setMatrixAt(activeCount, scratchObj.matrix);

          if (!visible) {
            scratchColor.copy(GHOST_COLOR);
          } else {
            scratchColor.copy(GOLD_COLOR);
          }
          mesh.setColorAt(activeCount, scratchColor);
        } else if (state === RELIC_CARRIED) {
          // Carried relic held aloft with the carrying monk
          const scale = 0.38;
          scratchObj.position.set(x, groundY + 1.25, y);
          scratchObj.scale.set(scale, scale, scale);
          scratchObj.rotation.set(0, (frame.eids[i]! * 0.7) % (Math.PI * 2), 0);
          scratchObj.updateMatrix();
          mesh.setMatrixAt(activeCount, scratchObj.matrix);

          scratchColor.copy(GOLD_COLOR);
          mesh.setColorAt(activeCount, scratchColor);
        }

        activeCount++;
      }

      if (activeCount > 0) {
        mesh.count = activeCount;
        mesh.visible = true;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      } else {
        mesh.count = 0;
        mesh.visible = false;
      }
    },
  };
}

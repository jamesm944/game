/**
 * 3D Resource Nodes & Tree Layer — SPEC §2.6 / Issue #75 (V4).
 *
 * Instanced 3D rendering for map resource nodes:
 * - Trees (Oak 1, Oak 2, Pine) with subtle vertex wind sway
 * - Stone & ore outcrops (Rock 1, Rock 2, Gold 1)
 * - Distinct tints for Iron (slate metallic), Coal (charcoal), Clay (terracotta)
 * - Depleted nodes vanish; unexplored nodes culled by fog of war
 */

import {
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
} from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";
import {
  RESOURCE_FOOD,
  RESOURCE_WOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_IRON,
  RESOURCE_COAL,
  RESOURCE_CLAY,
} from "../sim/components/economy";

import tree1Url from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Tree1.gltf";
import tree2Url from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Tree2.gltf";
import pineUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_PineTree.gltf";
import rock1Url from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Rock_1.gltf";
import rock2Url from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Rock_2.gltf";
import goldUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Gold_1.gltf";

const MAX_INSTANCES_PER_KIND = 1024;

const scratchObj = new Object3D();
const scratchColor = new Color();

function normalizeGeometry(
  geometry: BufferGeometry,
  targetSize = 1.0,
): BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);

  geometry.translate(-center.x, -box.min.y, -center.z);
  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ > 0.0001) {
    const scale = targetSize / maxXZ;
    geometry.scale(scale, scale, scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function extractModelGeometry(gltf: GLTF, targetSize = 1.0): BufferGeometry {
  const geoms: BufferGeometry[] = [];
  gltf.scene.traverse((obj) => {
    if ((obj as { isMesh?: boolean }).isMesh === true) {
      const mesh = obj as Mesh;
      const g = mesh.geometry.clone();
      const posAttr = g.attributes.position;
      if (!posAttr) return;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);

      const mat = mesh.material as {
        name?: string;
        color?: { r: number; g: number; b: number };
      };
      const r = mat.color?.r ?? 0.8;
      const gCol = mat.color?.g ?? 0.8;
      const b = mat.color?.b ?? 0.8;

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
    return new BufferGeometry();
  }
  const merged = mergeGeometries(geoms, false);
  return normalizeGeometry(merged ?? geoms[0]!, targetSize);
}

export interface ResourceFogView {
  isVisible(tileX: number, tileY: number): boolean;
  isExplored(tileX: number, tileY: number): boolean;
}

export interface ResourceModelsLayer {
  readonly group: Group;
  readonly uTime: { value: number };
  write(
    nodes: ReadonlyMap<number, readonly number[]>,
    positions: ReadonlyMap<number, readonly number[]>,
    layers: WorldLayers,
    options?: { fog?: ResourceFogView | undefined },
  ): void;
}

export async function createResourceModelsLayer(): Promise<ResourceModelsLayer> {
  const loader = new GLTFLoader();

  const [gltfTree1, gltfTree2, gltfPine, gltfRock1, gltfRock2, gltfGold] =
    await Promise.all([
      loader.loadAsync(tree1Url),
      loader.loadAsync(tree2Url),
      loader.loadAsync(pineUrl),
      loader.loadAsync(rock1Url),
      loader.loadAsync(rock2Url),
      loader.loadAsync(goldUrl),
    ]);

  const geomTree1 = extractModelGeometry(gltfTree1, 1.3);
  const geomTree2 = extractModelGeometry(gltfTree2, 1.3);
  const geomPine = extractModelGeometry(gltfPine, 1.2);
  const geomRock1 = extractModelGeometry(gltfRock1, 0.9);
  const geomRock2 = extractModelGeometry(gltfRock2, 0.9);
  const geomGold = extractModelGeometry(gltfGold, 0.9);

  const uTime = { value: 0 };

  // Tree material with subtle vertex wind sway
  const treeMaterial = new MeshLambertMaterial({ vertexColors: true });
  treeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      /* glsl */ `
      uniform float uTime;
      void main() {`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      float swayMask = max(0.0, position.y - 0.35);
      float sway = sin(uTime * 2.2 + position.x * 2.0 + position.z * 1.8) * 0.07 * swayMask;
      transformed.x += sway;
      transformed.z += sway * 0.6;`,
    );
  };

  const rockMaterial = new MeshLambertMaterial({ vertexColors: true });
  const goldMaterial = new MeshLambertMaterial({ vertexColors: true });

  const meshTree1 = new InstancedMesh(
    geomTree1,
    treeMaterial,
    MAX_INSTANCES_PER_KIND,
  );
  const meshTree2 = new InstancedMesh(
    geomTree2,
    treeMaterial,
    MAX_INSTANCES_PER_KIND,
  );
  const meshPine = new InstancedMesh(
    geomPine,
    treeMaterial,
    MAX_INSTANCES_PER_KIND,
  );
  const meshRock1 = new InstancedMesh(
    geomRock1,
    rockMaterial,
    MAX_INSTANCES_PER_KIND,
  );
  const meshRock2 = new InstancedMesh(
    geomRock2,
    rockMaterial,
    MAX_INSTANCES_PER_KIND,
  );
  const meshGold = new InstancedMesh(
    geomGold,
    goldMaterial,
    MAX_INSTANCES_PER_KIND,
  );

  const meshes = [
    meshTree1,
    meshTree2,
    meshPine,
    meshRock1,
    meshRock2,
    meshGold,
  ];
  for (const m of meshes) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = 0;
  }

  const group = new Group();
  for (const m of meshes) group.add(m);

  return {
    group,
    uTime,
    write(nodes, positions, layers, options) {
      let countTree1 = 0;
      let countTree2 = 0;
      let countPine = 0;
      let countRock1 = 0;
      let countRock2 = 0;
      let countGold = 0; // 1. Populate forest tiles with 3D trees
      const size = layers.size;
      for (let ty = 0; ty < size; ty++) {
        for (let tx = 0; tx < size; tx++) {
          const idx = ty * size + tx;
          if (layers.terrainType[idx] !== 5) continue; // 5 is TERRAIN_FOREST_FLOOR

          const explored = options?.fog ? options.fog.isExplored(tx, ty) : true;
          if (!explored) continue;

          const visible = options?.fog ? options.fog.isVisible(tx, ty) : true;
          const hash = (idx * 2654435761) >>> 0;

          const jx = tx + 0.2 + ((hash & 0xff) / 255) * 0.6;
          const jy = ty + 0.2 + (((hash >> 8) & 0xff) / 255) * 0.6;
          const groundY = terrainHeightAt(layers, jx, jy);
          const rotationY = (hash % 628) / 100;
          const scaleJitter = 0.95 + ((hash >> 16) % 25) * 0.015;

          scratchObj.position.set(jx, groundY, jy);
          scratchObj.rotation.set(0, rotationY, 0);
          scratchObj.scale.set(scaleJitter, scaleJitter, scaleJitter);
          scratchObj.updateMatrix();

          if (visible) {
            scratchColor.setRGB(1.0, 1.0, 1.0);
          } else {
            scratchColor.setRGB(0.52, 0.54, 0.62);
          }

          const kind = hash % 3;
          if (kind === 0 && countTree1 < MAX_INSTANCES_PER_KIND) {
            meshTree1.setMatrixAt(countTree1, scratchObj.matrix);
            meshTree1.setColorAt(countTree1, scratchColor);
            countTree1++;
          } else if (kind === 1 && countTree2 < MAX_INSTANCES_PER_KIND) {
            meshTree2.setMatrixAt(countTree2, scratchObj.matrix);
            meshTree2.setColorAt(countTree2, scratchColor);
            countTree2++;
          } else if (countPine < MAX_INSTANCES_PER_KIND) {
            meshPine.setMatrixAt(countPine, scratchObj.matrix);
            meshPine.setColorAt(countPine, scratchColor);
            countPine++;
          }
        }
      }

      // 2. Resource nodes (wood, food bushes, gold, stone, iron, coal, clay)
      for (const [eid, node] of nodes) {
        const remaining = node[1] ?? 0;
        if (remaining <= 0) continue; // Depleted node

        const pos = positions.get(eid);
        if (!pos || pos[0] === undefined || pos[1] === undefined) continue;
        const x = pos[0];
        const y = pos[1];
        const tx = Math.floor(x);
        const ty = Math.floor(y);

        const explored = options?.fog ? options.fog.isExplored(tx, ty) : true;
        if (!explored) continue;

        const visible = options?.fog ? options.fog.isVisible(tx, ty) : true;
        const groundY = terrainHeightAt(layers, x, y);

        const resCode = node[0] ?? 0;
        const hash = (eid * 2654435761) >>> 0;
        const rotationY = (hash % 628) / 100;
        const scaleJitter = 0.9 + ((hash >> 8) % 25) * 0.01;

        scratchObj.position.set(x, groundY, y);
        scratchObj.rotation.set(0, rotationY, 0);
        scratchObj.scale.set(scaleJitter, scaleJitter, scaleJitter);
        scratchObj.updateMatrix();

        if (visible) {
          scratchColor.setRGB(1.0, 1.0, 1.0);
        } else {
          scratchColor.setRGB(0.5, 0.52, 0.58);
        }

        if (resCode === RESOURCE_WOOD) {
          const kind = hash % 3;
          if (kind === 0 && countTree1 < MAX_INSTANCES_PER_KIND) {
            meshTree1.setMatrixAt(countTree1, scratchObj.matrix);
            meshTree1.setColorAt(countTree1, scratchColor);
            countTree1++;
          } else if (kind === 1 && countTree2 < MAX_INSTANCES_PER_KIND) {
            meshTree2.setMatrixAt(countTree2, scratchObj.matrix);
            meshTree2.setColorAt(countTree2, scratchColor);
            countTree2++;
          } else if (countPine < MAX_INSTANCES_PER_KIND) {
            meshPine.setMatrixAt(countPine, scratchObj.matrix);
            meshPine.setColorAt(countPine, scratchColor);
            countPine++;
          }
        } else if (resCode === RESOURCE_FOOD) {
          // Berry bush: compact shrub
          scratchObj.scale.set(
            0.45 * scaleJitter,
            0.4 * scaleJitter,
            0.45 * scaleJitter,
          );
          scratchObj.updateMatrix();
          if (countTree1 < MAX_INSTANCES_PER_KIND) {
            meshTree1.setMatrixAt(countTree1, scratchObj.matrix);
            scratchColor.setRGB(0.72, 0.85, 0.45);
            meshTree1.setColorAt(countTree1, scratchColor);
            countTree1++;
          }
        } else if (resCode === RESOURCE_GOLD) {
          if (countGold < MAX_INSTANCES_PER_KIND) {
            meshGold.setMatrixAt(countGold, scratchObj.matrix);
            if (visible) {
              scratchColor.setRGB(1.0, 0.88, 0.28);
            } else {
              scratchColor.setRGB(0.55, 0.48, 0.3);
            }
            meshGold.setColorAt(countGold, scratchColor);
            countGold++;
          }
        } else if (resCode === RESOURCE_STONE) {
          if (countRock1 < MAX_INSTANCES_PER_KIND) {
            meshRock1.setMatrixAt(countRock1, scratchObj.matrix);
            if (visible) {
              scratchColor.setRGB(0.85, 0.85, 0.88);
            } else {
              scratchColor.setRGB(0.5, 0.52, 0.58);
            }
            meshRock1.setColorAt(countRock1, scratchColor);
            countRock1++;
          }
        } else if (resCode === RESOURCE_IRON) {
          if (countRock2 < MAX_INSTANCES_PER_KIND) {
            meshRock2.setMatrixAt(countRock2, scratchObj.matrix);
            if (visible) scratchColor.setRGB(0.55, 0.58, 0.72);
            meshRock2.setColorAt(countRock2, scratchColor);
            countRock2++;
          }
        } else if (resCode === RESOURCE_COAL) {
          if (countRock1 < MAX_INSTANCES_PER_KIND) {
            meshRock1.setMatrixAt(countRock1, scratchObj.matrix);
            if (visible) scratchColor.setRGB(0.28, 0.28, 0.3);
            meshRock1.setColorAt(countRock1, scratchColor);
            countRock1++;
          }
        } else if (resCode === RESOURCE_CLAY) {
          if (countRock2 < MAX_INSTANCES_PER_KIND) {
            meshRock2.setMatrixAt(countRock2, scratchObj.matrix);
            if (visible) scratchColor.setRGB(0.78, 0.45, 0.32);
            meshRock2.setColorAt(countRock2, scratchColor);
            countRock2++;
          }
        }
      }

      meshTree1.count = countTree1;
      meshTree2.count = countTree2;
      meshPine.count = countPine;
      meshRock1.count = countRock1;
      meshRock2.count = countRock2;
      meshGold.count = countGold;

      if (countTree1 > 0) {
        meshTree1.instanceMatrix.needsUpdate = true;
        if (meshTree1.instanceColor) meshTree1.instanceColor.needsUpdate = true;
      }
      if (countTree2 > 0) {
        meshTree2.instanceMatrix.needsUpdate = true;
        if (meshTree2.instanceColor) meshTree2.instanceColor.needsUpdate = true;
      }
      if (countPine > 0) {
        meshPine.instanceMatrix.needsUpdate = true;
        if (meshPine.instanceColor) meshPine.instanceColor.needsUpdate = true;
      }
      if (countRock1 > 0) {
        meshRock1.instanceMatrix.needsUpdate = true;
        if (meshRock1.instanceColor) meshRock1.instanceColor.needsUpdate = true;
      }
      if (countRock2 > 0) {
        meshRock2.instanceMatrix.needsUpdate = true;
        if (meshRock2.instanceColor) meshRock2.instanceColor.needsUpdate = true;
      }
      if (countGold > 0) {
        meshGold.instanceMatrix.needsUpdate = true;
        if (meshGold.instanceColor) meshGold.instanceColor.needsUpdate = true;
      }
    },
  };
}

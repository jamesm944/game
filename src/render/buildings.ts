/**
 * Building instanced-mesh layer — SPEC §7 / M1-T10.
 *
 * ONE InstancedMesh draws every construction site and finished
 * building: per-instance scale carries footprint size, per-instance
 * color separates sites (timber brown, height growing with progress)
 * from finished buildings (stone). Fed exclusively from the pure
 * sim/mirror captureBuildingSnapshot — the seam stays one-directional.
 */

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from "three";
import type { BuildingSnapshotFrame } from "../sim/mirror";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

const SITE_COLOR = 0x8a6a42;
const DONE_COLOR = 0xb8bfc9;
const MAX_BUILDINGS = 128;

const scratch = new Object3D();
const color = new Color();

export interface BuildingLayer {
  mesh: InstancedMesh;
  write(frame: BuildingSnapshotFrame, layers: WorldLayers): void;
}

export function createBuildingLayer(): BuildingLayer {
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshLambertMaterial({ color: 0xffffff });
  const mesh = new InstancedMesh(geometry, material, MAX_BUILDINGS);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Instance colors start white; write() refreshes them every frame.
  mesh.instanceColor = new InstancedBufferAttribute(
    new Float32Array(MAX_BUILDINGS * 3).fill(1),
    3,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;

  return {
    mesh,
    write(frame, layers) {
      const count = Math.min(frame.count, MAX_BUILDINGS);
      for (let i = 0; i < count; i++) {
        const ox = frame.origins[i * 2]!;
        const oy = frame.origins[i * 2 + 1]!;
        const w = frame.sizes[i * 2]!;
        const h = frame.sizes[i * 2 + 1]!;
        const done = frame.states[i] === 1;
        const progress = done ? 1 : frame.progress[i]!;
        const bodyHeight = done ? 0.9 : 0.15 + 0.55 * progress;
        const cx = ox + w / 2;
        const cy = oy + h / 2;
        const groundY = terrainHeightAt(layers, cx, cy);
        scratch.position.set(cx, groundY + bodyHeight / 2, cy);
        scratch.scale.set(w - 0.12, bodyHeight, h - 0.12);
        scratch.rotation.set(0, 0, 0);
        scratch.updateMatrix();
        mesh.setMatrixAt(i, scratch.matrix);
        color.setHex(done ? DONE_COLOR : SITE_COLOR);
        if (!done && progress <= 0.001) color.multiplyScalar(0.75);
        mesh.setColorAt(i, color);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

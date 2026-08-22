/**
 * Selection rings — M1-T8 (SPEC §2.13).
 *
 * One InstancedMesh of thin white ground rings under every selected
 * unit (the prototype's selection ellipse, ported to the instanced
 * renderer). Positions come from the SAME interpolated mirror sample
 * the unit billboards use, so rings track units smoothly. A single
 * extra draw call, capacity-capped.
 */

import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const SELECTION_RING_CAPACITY = 256;

export interface SelectionRingsLayer {
  /**
   * Write ring instances for the first `count` entries of the packed
   * x,y arrays (sim coordinates, interpolated like the mirror sample).
   */
  write(positions: Float32Array, count: number): void;
}

export function createSelectionRings(
  scene: Scene,
  layers: WorldLayers,
): SelectionRingsLayer {
  const geometry = new RingGeometry(0.34, 0.44, 28);
  geometry.rotateX(-Math.PI / 2); // lie flat; instance matrices stay pure translates
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, SELECTION_RING_CAPACITY);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  const scratchMatrix = new Matrix4();

  return {
    write(positions: Float32Array, count: number): void {
      const visible = Math.min(count, SELECTION_RING_CAPACITY);
      for (let i = 0; i < visible; i++) {
        const x = positions[i * 2]!;
        const y = positions[i * 2 + 1]!;
        scratchMatrix.makeTranslation(
          x,
          terrainHeightAt(layers, x, y) + 0.05,
          y,
        );
        mesh.setMatrixAt(i, scratchMatrix);
      }
      mesh.count = visible;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

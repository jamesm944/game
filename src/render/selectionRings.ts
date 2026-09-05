/**
 * Selection rings — M1-T8 (SPEC §2.13) / V11 (#82).
 *
 * One InstancedMesh of segmented, pulsing, rotating white ground brackets
 * under every selected unit. Positions come from the SAME interpolated mirror
 * sample the unit billboards use, so rings track units smoothly.
 * Single extra draw call, capacity-capped.
 */

import {
  BufferGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const SELECTION_RING_CAPACITY = 256;

export interface SelectionRingsLayer {
  /**
   * Write ring instances for the first `count` entries of the packed
   * x,y arrays (sim coordinates, interpolated like the mirror sample).
   */
  write(positions: Float32Array, count: number, timeSec?: number): void;
}

function createSegmentedRingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const arc = (Math.PI * 2) / 4;
  const segmentLen = arc * 0.7;
  for (let b = 0; b < 4; b++) {
    const thetaStart = b * arc;
    const geom = new RingGeometry(0.34, 0.44, 8, 1, thetaStart, segmentLen);
    geom.rotateX(-Math.PI / 2);
    parts.push(geom);
  }
  return mergeGeometries(parts, false);
}

export function createSelectionRings(
  scene: Scene,
  layers: WorldLayers,
): SelectionRingsLayer {
  const geometry = createSegmentedRingGeometry();
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, SELECTION_RING_CAPACITY);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  const scratchMatrix = new Matrix4();
  const translationMatrix = new Matrix4();
  const rotationMatrix = new Matrix4();
  const scaleMatrix = new Matrix4();

  return {
    write(positions: Float32Array, count: number, timeSec = 0): void {
      const visible = Math.min(count, SELECTION_RING_CAPACITY);
      const pulse = 1.0 + 0.06 * Math.sin(timeSec * 5.0);
      scaleMatrix.makeScale(pulse, 1, pulse);
      rotationMatrix.makeRotationY(timeSec * 1.5);

      for (let i = 0; i < visible; i++) {
        const x = positions[i * 2]!;
        const y = positions[i * 2 + 1]!;
        translationMatrix.makeTranslation(
          x,
          terrainHeightAt(layers, x, y) + 0.05,
          y,
        );
        scratchMatrix.multiplyMatrices(translationMatrix, rotationMatrix);
        scratchMatrix.multiply(scaleMatrix);
        mesh.setMatrixAt(i, scratchMatrix);
      }
      mesh.count = visible;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

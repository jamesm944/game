/**
 * Conversion indicator rings — V14 Issue #101.
 *
 * Dedicated instanced overlay layer rendering pulsing golden/amber rune rings
 * under units currently being converted by monks.
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

export const CONVERSION_RING_CAPACITY = 64;

export interface ConversionRingsLayer {
  /**
   * Write ring instances for the first `count` entries of packed x,y arrays.
   */
  write(positions: Float32Array, count: number, timeSec?: number): void;
}

function createConversionRingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const segments = 6;
  const arc = (Math.PI * 2) / segments;
  const segmentLen = arc * 0.75;
  for (let b = 0; b < segments; b++) {
    const thetaStart = b * arc;
    const geom = new RingGeometry(0.38, 0.48, 8, 1, thetaStart, segmentLen);
    geom.rotateX(-Math.PI / 2);
    parts.push(geom);
  }
  // Inner concentric ring
  const innerRing = new RingGeometry(0.24, 0.28, 16);
  innerRing.rotateX(-Math.PI / 2);
  parts.push(innerRing);

  return mergeGeometries(parts, false);
}

export function createConversionRings(
  scene: Scene,
  layers: WorldLayers,
): ConversionRingsLayer {
  const geometry = createConversionRingGeometry();
  const material = new MeshBasicMaterial({
    color: 0xf59e0b, // Vibrant holy amber/gold
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, CONVERSION_RING_CAPACITY);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  scene.add(mesh);

  const scratchMatrix = new Matrix4();
  const translationMatrix = new Matrix4();
  const rotationMatrix = new Matrix4();
  const scaleMatrix = new Matrix4();

  return {
    write(positions: Float32Array, count: number, timeSec = 0): void {
      const visible = Math.min(count, CONVERSION_RING_CAPACITY);
      // Rapid rhythmic pulsing matching chanting monks
      const pulse = 1.0 + 0.12 * Math.sin(timeSec * 8.0);
      scaleMatrix.makeScale(pulse, 1, pulse);
      rotationMatrix.makeRotationY(timeSec * 2.5);

      for (let i = 0; i < visible; i++) {
        const x = positions[i * 2]!;
        const y = positions[i * 2 + 1]!;
        translationMatrix.makeTranslation(
          x,
          terrainHeightAt(layers, x, y) + 0.06,
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

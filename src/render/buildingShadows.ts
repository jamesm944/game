/**
 * Building Ambient Occlusion / Ground Contact Shadow Decals (Issue #99 / V14).
 *
 * Implements fake ambient occlusion / soft contact drop shadows under all
 * buildings (including walls, gates, towers, castles, town centers, and
 * production buildings) via a single InstancedMesh draw call.
 *
 * Design constraints:
 * - Single draw call for all building shadows (InstancedMesh).
 * - Soft elliptical falloff proportional to building footprint.
 * - Zero texture overhead (pure procedural GLSL fragment shader).
 * - Preserves GPU frame budget (depthWrite: false, transparent: true).
 */

import {
  DynamicDrawUsage,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { BuildingSnapshotFrame } from "../sim/mirror";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const MAX_BUILDING_SHADOWS = 512;

const scratchObj = new Object3D();

export function createBuildingShadowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        vec2 center = (vUv - vec2(0.5)) * 2.0;
        float dist = length(center);
        if (dist >= 1.0) discard;
        // Soft cubic ease-out falloff from dark core to transparent edge
        float alpha = smoothstep(1.0, 0.1, dist) * 0.65;
        gl_FragColor = vec4(0.02, 0.03, 0.05, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

export function createBuildingShadowMesh(
  capacity: number = MAX_BUILDING_SHADOWS,
): InstancedMesh {
  const geometry = new PlaneGeometry(1, 1);
  // Lay plane flat on ground (XZ plane)
  geometry.rotateX(-Math.PI / 2);

  const material = createBuildingShadowMaterial();
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = "building-ground-shadows";
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  return mesh;
}

/**
 * Updates instanced building contact shadows based on snapshot frame and terrain.
 * Returns active shadow count.
 */
export function updateBuildingShadows(
  shadowMesh: InstancedMesh,
  frame: BuildingSnapshotFrame,
  layers: WorldLayers,
  isGhost?: (index: number) => boolean,
): number {
  let shadowCount = 0;
  const count = Math.min(frame.count, frame.origins.length / 2);
  const maxShadows = shadowMesh.instanceMatrix.count;

  for (let i = 0; i < count; i++) {
    const ghost = isGhost?.(i) ?? false;
    if (ghost) continue;
    if (shadowCount >= maxShadows) break;

    const ox = frame.origins[i * 2]!;
    const oy = frame.origins[i * 2 + 1]!;
    const w = frame.sizes[i * 2]!;
    const h = frame.sizes[i * 2 + 1]!;

    const cx = ox + w / 2;
    const cy = oy + h / 2;
    const groundY = terrainHeightAt(layers, cx, cy);

    scratchObj.position.set(cx, groundY + 0.02, cy);
    scratchObj.scale.set(w * 1.15, 1, h * 1.15);
    scratchObj.rotation.set(0, 0, 0);
    scratchObj.updateMatrix();

    shadowMesh.setMatrixAt(shadowCount, scratchObj.matrix);
    shadowCount++;
  }

  if (shadowCount > 0) {
    shadowMesh.count = shadowCount;
    shadowMesh.visible = true;
    shadowMesh.instanceMatrix.needsUpdate = true;
  } else {
    shadowMesh.count = 0;
    shadowMesh.visible = false;
  }

  return shadowCount;
}

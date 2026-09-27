/**
 * Procedural Kelvin Wake Decal System — SPEC §7 / Milestone N4 (Issue #112).
 *
 * Implements procedural V-shaped Kelvin wake ribbons behind moving watercraft
 * using a single Three.js InstancedMesh draw call.
 *
 * Features:
 * - Single draw call for all ship wakes (InstancedMesh).
 * - Procedural GLSL Kelvin wake V-cone with animated breaking foam ripples.
 * - Dynamic motion coupling: wake scales with linear ship speed; idle ships omit wake.
 * - Minimal GPU overhead: depthWrite: false, transparent: true, renderOrder: 2.
 */

import {
  DynamicDrawUsage,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const MAX_SHIP_WAKES = 256;

const scratchObj = new Object3D();

export interface ShipWakeSample {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly speed: number;
  readonly shipLength: number;
}

export function createKelvinWakeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;

      void main() {
        // u goes from 0 (stern) to 1 (far wake tail)
        float u = vUv.x;
        // v goes from -1 to 1 across the wake
        float v = (vUv.y - 0.5) * 2.0;

        // V-shaped Kelvin wake cone boundary
        float vSpread = abs(v) - (u * 0.85);
        if (vSpread > 0.15) discard;

        // Soft lateral edge falloff
        float lateral = smoothstep(0.15, -0.2, vSpread);
        // Longitudinal falloff: soft entry from stern, gradual dissipation at tail
        float longitudinal = smoothstep(0.0, 0.12, u) * (1.0 - u);

        // Sinusoidal breaking foam ripples moving backwards
        float ripple = sin(u * 22.0 - uTime * 6.0) * 0.5 + 0.5;
        float foam = smoothstep(0.4, 0.9, ripple * lateral);

        float alpha = (lateral * longitudinal * 0.4 + foam * longitudinal * 0.5);
        if (alpha <= 0.01) discard;

        // Foamy aerated water tint
        vec3 foamColor = mix(vec3(0.72, 0.88, 0.98), vec3(0.96, 0.99, 1.0), foam);
        gl_FragColor = vec4(foamColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

export function createKelvinWakeMesh(
  capacity: number = MAX_SHIP_WAKES,
): InstancedMesh {
  const geometry = new PlaneGeometry(1, 1);
  // Lay flat on XZ plane
  geometry.rotateX(-Math.PI / 2);

  const material = createKelvinWakeMaterial();
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = "kelvin-wake-decals";
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2; // Above water plane (0) and shadows (1)

  return mesh;
}

/**
 * Updates instanced Kelvin wake decals based on active moving ships.
 * Returns active wake count.
 */
export function updateKelvinWakes(
  wakeMesh: InstancedMesh,
  samples: readonly ShipWakeSample[],
  layers: WorldLayers,
  timeSec: number,
): number {
  const mat = wakeMesh.material as ShaderMaterial;
  if (mat.uniforms?.uTime) {
    mat.uniforms.uTime.value = timeSec;
  }

  let count = 0;
  const maxCapacity = wakeMesh.instanceMatrix.count;

  for (let i = 0; i < samples.length && count < maxCapacity; i++) {
    const s = samples[i]!;
    // Only generate wakes for moving ships (speed > 0.15)
    if (s.speed < 0.15) continue;

    const speedFrac = Math.min(1.5, Math.max(0.2, s.speed / 1.43));
    const wakeLength = s.shipLength * 1.6 * speedFrac;
    const wakeWidth = s.shipLength * 0.95 * speedFrac;

    // Stern position is opposite heading direction
    // Heading 0 faces right (+X in Three.js coordinates)
    const sternOffset = s.shipLength * 0.45;
    const sternX = s.x - Math.cos(s.heading) * sternOffset;
    const sternZ = s.y - Math.sin(s.heading) * sternOffset;

    // Center of the wake ribbon is half the wakeLength behind the stern
    const centerX = sternX - (Math.cos(s.heading) * wakeLength) / 2;
    const centerZ = sternZ - (Math.sin(s.heading) * wakeLength) / 2;

    const groundY = terrainHeightAt(layers, s.x, s.y);
    const wakeY = groundY + 0.02; // Float slightly above water surface

    scratchObj.position.set(centerX, wakeY, centerZ);
    // Rotate to align with heading (heading = 0 points along +X)
    scratchObj.rotation.set(0, -s.heading, 0);
    scratchObj.scale.set(wakeLength, 1, wakeWidth);
    scratchObj.updateMatrix();

    wakeMesh.setMatrixAt(count, scratchObj.matrix);
    count++;
  }

  wakeMesh.count = count;
  wakeMesh.visible = count > 0;
  if (count > 0) {
    wakeMesh.instanceMatrix.needsUpdate = true;
  }

  return count;
}

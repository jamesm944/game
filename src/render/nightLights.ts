/**
 * Architectural Night Illumination & Torchlight Braziers — L1 (Issue #129).
 *
 * Renders warm, radiant lantern and torch glows on buildings during dusk and night
 * in a single instanced draw call:
 * - Town Centers: entrance & courtyard lanterns
 * - Castles: 4 corner parapet braziers
 * - Watch Towers: top beacon fire
 * - Docks: shoreline maritime navigation beacon
 * - Houses & Barracks: warm window & entrance torches
 *
 * Implements smooth time-of-day ignition (ignites at dusk, flickers with flame turbulence,
 * extinguishes after dawn) and camera-facing spherical billboard projection.
 */

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { BuildingSnapshotFrame } from "../sim/mirror";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const MAX_NIGHT_LIGHTS = 512;

/** Baseline warm amber torchlight color [R, G, B] */
export const TORCH_LIGHT_COLOR: readonly [number, number, number] = [
  1.0, 0.72, 0.32,
];

/**
 * Calculates global night light intensity based on minute of day (0..1439).
 * - 0..360 (Midnight to 6 AM): 1.0 (Full night)
 * - 360..480 (6 AM to 8 AM): 1.0 -> 0.0 (Dawn fade-out)
 * - 480..1080 (8 AM to 6 PM): 0.0 (Daylight)
 * - 1080..1260 (6 PM to 9 PM): 0.0 -> 1.0 (Dusk ignition)
 * - 1260..1440 (9 PM to Midnight): 1.0 (Full night)
 */
export function calculateNightLightIntensity(minuteOfDay: number): number {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  if (m >= 480 && m < 1080) {
    return 0.0;
  }
  if (m >= 360 && m < 480) {
    // Dawn fade out
    return 1.0 - (m - 360) / 120;
  }
  if (m >= 1080 && m < 1260) {
    // Dusk fade in
    return (m - 1080) / 180;
  }
  return 1.0;
}

/**
 * Analytical flame flicker factor for time `t` and random offset `seed`.
 * Returns intensity multiplier around [0.85, 1.15].
 */
export function calculateFlameFlicker(t: number, seed: number = 0): number {
  const f1 = Math.sin(t * 8.5 + seed * 3.7);
  const f2 = Math.cos(t * 14.2 + seed * 7.1);
  return 1.0 + f1 * 0.08 + f2 * 0.05;
}

export interface NightLightsHandle {
  readonly mesh: InstancedMesh;
  readonly material: ShaderMaterial;
  update(
    frame: BuildingSnapshotFrame,
    layers: WorldLayers,
    minuteOfDay: number,
    renderTimeSeconds: number,
    buildingDefs?: ReadonlyMap<
      number,
      { code: number; id: string; width?: number; height?: number }
    >,
  ): number;
  dispose(): void;
}

const scratchObj = new Object3D();

export function createNightLights(
  capacity: number = MAX_NIGHT_LIGHTS,
): NightLightsHandle {
  const geometry = new PlaneGeometry(1, 1);

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlobalIntensity: { value: 0 },
      uLightColor: {
        value: new Color(
          TORCH_LIGHT_COLOR[0],
          TORCH_LIGHT_COLOR[1],
          TORCH_LIGHT_COLOR[2],
        ),
      },
      uGlowRadius: { value: 2.2 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uGlowRadius;
      varying vec2 vUv;
      varying float vFlicker;

      void main() {
        vUv = uv;
        // Instance seed from translation position
        float seed = instanceMatrix[3][0] * 12.9898 + instanceMatrix[3][2] * 78.233;
        vFlicker = 1.0 + sin(uTime * 8.5 + seed) * 0.10 + cos(uTime * 14.2 + seed * 2.0) * 0.06;

        // Spherical billboard: rotate to face camera view
        vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        float scale = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
        mvPosition.xy += (uv - vec2(0.5)) * (uGlowRadius * scale * vFlicker);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uLightColor;
      uniform float uGlobalIntensity;
      varying vec2 vUv;
      varying float vFlicker;

      void main() {
        vec2 center = (vUv - vec2(0.5)) * 2.0;
        float dist = length(center);
        if (dist >= 1.0) discard;

        // Soft radial Gaussian glow with luminous core
        float glow = exp(-dist * dist * 3.8) * (1.0 - dist * 0.85);
        vec3 col = uLightColor * (0.9 + 0.15 * vFlicker);
        gl_FragColor = vec4(col, glow * uGlobalIntensity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = "architectural-night-lights";
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  function update(
    frame: BuildingSnapshotFrame,
    layers: WorldLayers,
    minuteOfDay: number,
    renderTimeSeconds: number,
    buildingDefs?: ReadonlyMap<
      number,
      { code: number; id: string; width?: number; height?: number }
    >,
  ): number {
    const globalIntensity = calculateNightLightIntensity(minuteOfDay);
    if (material.uniforms.uGlobalIntensity) {
      material.uniforms.uGlobalIntensity.value = globalIntensity;
    }
    if (material.uniforms.uTime) {
      material.uniforms.uTime.value = renderTimeSeconds;
    }

    if (globalIntensity <= 0.001) {
      mesh.count = 0;
      mesh.visible = false;
      return 0;
    }

    let lightCount = 0;
    const maxLights = capacity;
    const count = Math.min(frame.count, frame.origins.length / 2);

    for (let i = 0; i < count; i++) {
      if (lightCount >= maxLights) break;

      const ox = frame.origins[i * 2]!;
      const oy = frame.origins[i * 2 + 1]!;
      const w = frame.sizes[i * 2]!;
      const h = frame.sizes[i * 2 + 1]!;
      const code = frame.defCodes[i];

      const def = code !== undefined ? buildingDefs?.get(code) : undefined;
      const bId = def?.id ?? "";

      const cx = ox + w * 0.5;
      const cy = oy + h * 0.5;
      const groundY = terrainHeightAt(layers, cx, cy);

      if (bId === "castle" || (w >= 4 && h >= 4 && bId !== "town-center")) {
        // Castle: 4 corner parapet braziers
        const corners = [
          [ox + 0.5, oy + 0.5, groundY + 3.8],
          [ox + w - 0.5, oy + 0.5, groundY + 3.8],
          [ox + 0.5, oy + h - 0.5, groundY + 3.8],
          [ox + w - 0.5, oy + h - 0.5, groundY + 3.8],
        ];
        for (const [lx, ly, lz] of corners) {
          if (lightCount >= maxLights) break;
          scratchObj.position.set(lx!, lz!, ly!);
          scratchObj.scale.setScalar(1.2);
          scratchObj.updateMatrix();
          mesh.setMatrixAt(lightCount++, scratchObj.matrix);
        }
      } else if (bId === "watch-tower" || (w === 1 && h === 1)) {
        // Watch Tower: top beacon flame
        scratchObj.position.set(cx, groundY + 4.2, cy);
        scratchObj.scale.setScalar(1.4);
        scratchObj.updateMatrix();
        mesh.setMatrixAt(lightCount++, scratchObj.matrix);
      } else if (bId === "dock" || (w === 3 && h === 3)) {
        // Dock: harbour maritime lantern
        scratchObj.position.set(cx, groundY + 1.8, cy);
        scratchObj.scale.setScalar(1.3);
        scratchObj.updateMatrix();
        mesh.setMatrixAt(lightCount++, scratchObj.matrix);
      } else {
        // Town Center / Houses / Barracks: entrance or window light
        scratchObj.position.set(cx, groundY + 1.2, cy);
        scratchObj.scale.setScalar(w > 2 ? 1.4 : 1.0);
        scratchObj.updateMatrix();
        mesh.setMatrixAt(lightCount++, scratchObj.matrix);
      }
    }

    if (lightCount > 0) {
      mesh.count = lightCount;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
    } else {
      mesh.count = 0;
      mesh.visible = false;
    }

    return lightCount;
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    material,
    update,
    dispose,
  };
}

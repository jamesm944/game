/**
 * Chimney smoke particle layer — V11 (#82).
 *
 * Instanced billboarding smoke puffs rising from finished residential
 * and production buildings (House, Town Center, Blacksmith).
 * Fully GPU shader-driven: vertex shader rises, drifts, and expands puffs
 * from uTime; fragment shader produces soft circular volumetric alpha.
 * Single draw call for the entire world.
 */

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Scene,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export const MAX_CHIMNEYS = 64;
export const PUFFS_PER_CHIMNEY = 4;
export const TOTAL_SMOKE_INSTANCES = MAX_CHIMNEYS * PUFFS_PER_CHIMNEY;

const SMOKE_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPlumeHeight;

  attribute vec3 aOrigin;
  attribute float aPhase;

  varying vec2 vUv;
  varying float vLife;

  void main() {
    vUv = uv;

    // Continuous cycle [0.0, 1.0)
    float cycle = fract(uTime * 0.45 + aPhase);
    vLife = cycle;

    // Upward plume trajectory
    float rise = cycle * uPlumeHeight;
    // Gentle easterly wind drift + turbulent wobble
    float driftX = cycle * 0.75 + sin(uTime * 1.8 + aOrigin.x * 2.0 + cycle * 4.0) * 0.12;
    float driftZ = cycle * 0.35 + cos(uTime * 1.5 + aOrigin.z * 2.0 + cycle * 3.0) * 0.09;

    // Expansion as puff ascends
    float puffScale = 0.28 + cycle * 0.75;

    vec3 worldPos = aOrigin + vec3(driftX, rise, driftZ);

    // Camera-facing billboard in view space
    vec4 viewCenter = viewMatrix * vec4(worldPos, 1.0);
    viewCenter.xy += (position.xy) * puffScale;

    gl_Position = projectionMatrix * viewCenter;
  }
`;

const SMOKE_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying float vLife;

  void main() {
    // Soft circular puff
    vec2 center = vUv - vec2(0.5, 0.5);
    float dist = length(center) * 2.0;
    if (dist > 1.0) discard;

    // Quadratic feathering at circle edge
    float radialAlpha = smoothstep(1.0, 0.0, dist);

    // Life-envelope fade: gentle rise, subtle bell-curve fade
    float lifeAlpha = sin(vLife * 3.14159265);
    float finalAlpha = radialAlpha * lifeAlpha * 0.32;

    // Soft warm hearth smoke tone
    gl_FragColor = vec4(vec3(0.88, 0.86, 0.84), finalAlpha);
  }
`;

export interface ChimneySmokeLayer {
  readonly mesh: Mesh;
  setTime(timeSec: number): void;
  updateChimneys(
    chimneyCoords: ReadonlyArray<{ x: number; y: number; height: number }>,
    layers: WorldLayers,
  ): void;
  dispose(): void;
}

export function createChimneySmokeLayer(scene: Scene): ChimneySmokeLayer {
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));

  const origins = new Float32Array(TOTAL_SMOKE_INSTANCES * 3);
  const phases = new Float32Array(TOTAL_SMOKE_INSTANCES);

  const aOrigin = new InstancedBufferAttribute(origins, 3);
  aOrigin.setUsage(DynamicDrawUsage);
  const aPhase = new InstancedBufferAttribute(phases, 1);

  geometry.setAttribute("aOrigin", aOrigin);
  geometry.setAttribute("aPhase", aPhase);

  const material = new ShaderMaterial({
    vertexShader: SMOKE_VERTEX_SHADER,
    fragmentShader: SMOKE_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uPlumeHeight: { value: 2.4 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.count = 0;
  scene.add(mesh);

  return {
    mesh,

    setTime(timeSec: number): void {
      material.uniforms.uTime!.value = timeSec;
    },

    updateChimneys(chimneys, layers): void {
      const activeChimneys = Math.min(chimneys.length, MAX_CHIMNEYS);
      let instanceIdx = 0;

      for (let c = 0; c < activeChimneys; c++) {
        const chim = chimneys[c]!;
        const groundY = terrainHeightAt(layers, chim.x, chim.y);
        const startY = groundY + chim.height;

        for (let p = 0; p < PUFFS_PER_CHIMNEY; p++) {
          const i3 = instanceIdx * 3;
          origins[i3] = chim.x;
          origins[i3 + 1] = startY;
          origins[i3 + 2] = chim.y;

          // Staggered puff phases so the smoke flows continuously
          phases[instanceIdx] = p / PUFFS_PER_CHIMNEY;
          instanceIdx++;
        }
      }

      mesh.count = instanceIdx;
      aOrigin.needsUpdate = true;
      aPhase.needsUpdate = true;
    },

    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      quad.dispose();
      material.dispose();
    },
  };
}

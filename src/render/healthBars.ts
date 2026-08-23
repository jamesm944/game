/**
 * Instanced health bars — M2-T6 (SPEC §7 overlays = 2 extra draw
 * calls).
 *
 * ONE instanced draw call for every health bar on screen (selection
 * rings own the other overlay call). The mesh is an InstancedBuffer-
 * Geometry of camera-facing quads with a custom ShaderMaterial, fed by
 * render/overlayPack.packHealthBarAttributes:
 *
 * - aOrigin: world-space anchor above the unit's head;
 * - aFraction: health 0..1 — the fragment shader splits the quad into a
 *   dark background track and a green→red fill in one pass.
 *
 * Billboarding expands the quad in VIEW space exactly like the unit
 * sprites, so bars face the orthographic RTS camera under any azimuth.
 * Per-frame CPU work is only the packed attribute upload; playback/
 * layout math lives on the GPU or in the pure packer.
 */

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { Scene } from "three";
import { HEALTH_BAR_CAPACITY } from "./overlayPack";

export interface HealthBarLayer {
  readonly mesh: Mesh;
  /**
   * Upload instance attributes for `count` bars previously packed by
   * packHealthBarAttributes; returns instances drawn.
   */
  write(origins: Float32Array, fractions: Float32Array, count: number): number;
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOrigin;
  attribute float aFraction;

  varying vec2 vUv;
  varying float vFraction;

  uniform float uBarWidth;
  uniform float uBarHeight;

  void main() {
    vUv = uv;
    vFraction = aFraction;
    // View-space expansion = exact camera-facing billboard for the
    // orthographic rig (geometry centered like PlaneGeometry).
    vec4 center = viewMatrix * vec4(aOrigin, 1.0);
    center.xy += vec2(position.x * uBarWidth, position.y * uBarHeight);
    gl_Position = projectionMatrix * center;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying float vFraction;

  void main() {
    // Track: dark translucent backing; fill: green → red as hp drops.
    float filled = step(vUv.x, vFraction);
    vec3 fillColor = mix(
      vec3(0.78, 0.17, 0.12),
      vec3(0.24, 0.75, 0.25),
      vFraction
    );
    vec3 color = mix(vec3(0.06, 0.07, 0.09), fillColor, filled);
    float alpha = mix(0.55, 0.95, filled);
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createHealthBars(
  scene: Scene,
  capacity: number = HEALTH_BAR_CAPACITY,
): HealthBarLayer {
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.attributes.position = quad.attributes.position!;
  geometry.attributes.uv = quad.attributes.uv!;

  const originAttr = new InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  );
  originAttr.setUsage(DynamicDrawUsage);
  const fractionAttr = new InstancedBufferAttribute(
    new Float32Array(capacity),
    1,
  );
  fractionAttr.setUsage(DynamicDrawUsage);
  geometry.setAttribute("aOrigin", originAttr);
  geometry.setAttribute("aFraction", fractionAttr);
  geometry.instanceCount = 0;

  const material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  return {
    mesh,
    write(origins: Float32Array, fractions: Float32Array, count): number {
      const visible = Math.min(count, capacity);
      if (visible > 0) {
        (originAttr.array as Float32Array).set(
          origins.subarray(0, visible * 3),
        );
        (fractionAttr.array as Float32Array).set(
          fractions.subarray(0, visible),
        );
        originAttr.needsUpdate = true;
        fractionAttr.needsUpdate = true;
      }
      geometry.instanceCount = visible;
      return visible;
    },
  };
}

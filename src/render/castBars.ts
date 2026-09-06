/**
 * Instanced monk conversion cast bars — V14 Issue #101.
 *
 * Camera-facing billboard quad above any Monk actively converting a target.
 * Shows cast progress (0..1) with a distinct mystic golden-cyan glow.
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

export const CAST_BAR_CAPACITY = 64;
export const CAST_BAR_LIFT = 1.95;

export interface CastBarLayer {
  readonly mesh: Mesh;
  /**
   * Upload instance attributes for active monk conversions.
   */
  write(origins: Float32Array, progress: Float32Array, count: number): number;
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOrigin;
  attribute float aProgress;

  varying vec2 vUv;
  varying float vProgress;

  uniform float uBarWidth;
  uniform float uBarHeight;

  void main() {
    vUv = uv;
    vProgress = aProgress;
    vec4 center = viewMatrix * vec4(aOrigin, 1.0);
    center.xy += vec2(position.x * uBarWidth, position.y * uBarHeight);
    gl_Position = projectionMatrix * center;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying float vProgress;

  void main() {
    // Outer border / background track: dark mystical indigo
    float borderX = step(0.04, vUv.x) * step(vUv.x, 0.96);
    float borderY = step(0.15, vUv.y) * step(vUv.y, 0.85);
    float inside = borderX * borderY;

    float filled = step(vUv.x, vProgress) * inside;
    // Fill color: brilliant mystic golden cyan
    vec3 fillColor = mix(vec3(0.18, 0.85, 0.98), vec3(1.0, 0.88, 0.32), vProgress);
    vec3 trackColor = vec3(0.06, 0.08, 0.16);
    vec3 borderColor = vec3(0.3, 0.4, 0.65);

    vec3 color = mix(borderColor, trackColor, inside);
    color = mix(color, fillColor, filled);

    float alpha = inside > 0.5 ? (filled > 0.5 ? 0.95 : 0.65) : 0.8;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createCastBars(
  scene: Scene,
  capacity: number = CAST_BAR_CAPACITY,
): CastBarLayer {
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
  const progressAttr = new InstancedBufferAttribute(
    new Float32Array(capacity),
    1,
  );
  progressAttr.setUsage(DynamicDrawUsage);
  geometry.setAttribute("aOrigin", originAttr);
  geometry.setAttribute("aProgress", progressAttr);
  geometry.instanceCount = 0;

  const material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uBarWidth: { value: 0.9 },
      uBarHeight: { value: 0.12 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  scene.add(mesh);

  return {
    mesh,
    write(origins: Float32Array, progress: Float32Array, count: number): number {
      const visible = Math.min(count, capacity);
      if (visible > 0) {
        (originAttr.array as Float32Array).set(origins.subarray(0, visible * 3));
        (progressAttr.array as Float32Array).set(progress.subarray(0, visible));
        originAttr.needsUpdate = true;
        progressAttr.needsUpdate = true;
      }
      geometry.instanceCount = visible;
      return visible;
    },
  };
}

/**
 * RTS Post-Processing Pipeline — P1 (Issue #130).
 *
 * Implements calibrated post-processing tailored for RTS tactical clarity:
 * - Offscreen scene rendering (WebGLRenderTarget)
 * - Analytical ACES filmic tone mapping
 * - Selective 9-tap HDR bloom on high-energy emitters (fire, torches, sun glints, age-up)
 * - Contrast & saturation boost for vibrant AoE2 aesthetics
 * - Subtle vignette centering attention on the battlefield
 * - Dynamic resolution resize & clean resource disposal
 */

import {
  Camera,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { GraphicsQuality } from "../ui/settings";

export type { GraphicsQuality };

/**
 * Analytical ACES filmic tone mapping curve.
 * Maps high dynamic range radiance to [0, 1] with smooth shoulder and toe.
 */
export function calculateACESFilm(x: number): number {
  if (x <= 0) return 0;
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return Math.max(0, Math.min(1, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

/**
 * Smoothstep bloom weight extraction based on pixel luminance.
 */
export function calculateBloomWeight(
  luminance: number,
  threshold = 0.82,
): number {
  if (luminance <= threshold) return 0;
  const t = Math.max(0, Math.min(1, (luminance - threshold) / 0.45));
  return t * t * (3 - 2 * t);
}

/**
 * Analytical vignette factor at normalized coordinates (u, v).
 */
export function calculateVignette(
  u: number,
  v: number,
  intensity = 0.22,
): number {
  const dx = (u - 0.5) * 1.4;
  const dy = (v - 0.5) * 1.4;
  const d2 = dx * dx + dy * dy;
  return Math.max(0, Math.min(1, 1.0 - d2 * intensity));
}

export const POST_PROCESSING_FRAGMENT_GLSL = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uBloomIntensity;
  uniform float uVignetteIntensity;
  uniform float uContrast;
  uniform float uSaturation;
  varying vec2 vUv;

  vec3 ACESFilm(vec3 x) {
    x = max(vec3(0.0), x);
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec4 baseTex = texture2D(tDiffuse, vUv);
    vec3 color = baseTex.rgb;

    // 1. Selective 9-tap HDR bloom
    if (uBloomIntensity > 0.001) {
      vec2 texel = vec2(1.0) / max(vec2(1.0), uResolution);
      vec3 bloomAcc = vec3(0.0);

      // Radial cross-filter kernel taps
      vec2 offsets[8];
      offsets[0] = vec2(-1.5,  0.0) * texel;
      offsets[1] = vec2( 1.5,  0.0) * texel;
      offsets[2] = vec2( 0.0, -1.5) * texel;
      offsets[3] = vec2( 0.0,  1.5) * texel;
      offsets[4] = vec2(-3.0, -3.0) * texel;
      offsets[5] = vec2( 3.0, -3.0) * texel;
      offsets[6] = vec2(-3.0,  3.0) * texel;
      offsets[7] = vec2( 3.0,  3.0) * texel;

      for (int i = 0; i < 8; i++) {
        vec3 s = texture2D(tDiffuse, vUv + offsets[i]).rgb;
        float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));
        float w = smoothstep(0.80, 1.25, luma);
        bloomAcc += s * w;
      }
      color += (bloomAcc / 8.0) * uBloomIntensity;
    }

    // 2. ACES Filmic Tone Mapping
    color = ACESFilm(color);

    // 3. Contrast & Saturation Tuning (rich RTS look)
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);
    color = pow(max(vec3(0.0), color), vec3(uContrast));

    // 4. Subtle Vignette
    vec2 d = (vUv - vec2(0.5)) * 1.4;
    float vig = 1.0 - dot(d, d) * uVignetteIntensity;
    color *= clamp(vig, 0.0, 1.0);

    gl_FragColor = vec4(color, baseTex.a);
  }
`;

export interface PostProcessingPipeline {
  readonly renderTarget: WebGLRenderTarget;
  readonly material: ShaderMaterial;
  setSize(width: number, height: number): void;
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void;
  dispose(): void;
}

export function createPostProcessingPipeline(
  width: number,
  height: number,
): PostProcessingPipeline {
  const renderTarget = new WebGLRenderTarget(width, height, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    format: RGBAFormat,
  });

  const material = new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: renderTarget.texture },
      uResolution: { value: new Vector2(width, height) },
      uBloomIntensity: { value: 0.38 },
      uVignetteIntensity: { value: 0.18 },
      uContrast: { value: 1.04 },
      uSaturation: { value: 1.12 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: POST_PROCESSING_FRAGMENT_GLSL,
    depthTest: false,
    depthWrite: false,
  });

  const quadGeom = new PlaneGeometry(2, 2);
  const quadMesh = new Mesh(quadGeom, material);
  const quadScene = new Scene();
  quadScene.add(quadMesh);
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function setSize(w: number, h: number): void {
    const curW = renderTarget.width;
    const curH = renderTarget.height;
    if (curW !== w || curH !== h) {
      renderTarget.setSize(w, h);
      material.uniforms.uResolution?.value.set(w, h);
    }
  }

  function render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    // 1. Render primary 3D world scene into offscreen render target
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);

    // 2. Composite fullscreen post-processing pass directly to canvas
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCamera);
  }

  function dispose(): void {
    renderTarget.dispose();
    quadGeom.dispose();
    material.dispose();
  }

  return {
    renderTarget,
    material,
    setSize,
    render,
    dispose,
  };
}

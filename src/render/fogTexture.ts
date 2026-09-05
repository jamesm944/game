/**
 * Fog renderer handoff — SPEC §2.9 / M2-T8.
 *
 * One RGFormat UnsignedByteType DataTexture per human viewer (120×120,
 * LinearFilter, ClampToEdge, no mipmaps; ≤57 KB per upload): R =
 * explored, G = visible. The terrain shader derives
 *
 *   brightness = mix(EXPLORED_DIM, 1.0, texel.g) * step(0.5, texel.r)
 *
 * so unexplored tiles render black and explored-but-not-currently-
 * visible terrain dims. Temporal smoothing blends uFogPrev → uFogCurr
 * across the tick interval via uBlend — all smoothing stays render-side
 * while the sim planes stay binary.
 *
 * Headless-safe: only DataTexture/bytes live here; the shader injection
 * runs exclusively inside a real WebGL program compile.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  MeshLambertMaterial,
  RGFormat,
  UnsignedByteType,
  type Texture,
} from "three";
import type { FogState } from "../sim/systems/fog";

/** Brightness multiplier for explored-but-not-visible tiles (SPEC). */
export const FOG_EXPLORED_DIM = 0.55;

/** Allocate the fog DataTexture with the pinned sampler settings. */
export function createFogDataTexture(size: number): DataTexture {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `fog texture size must be a positive integer, got ${String(size)}`,
    );
  }
  const texture = new DataTexture(
    new Uint8Array(size * size * 2),
    size,
    size,
    RGFormat,
    UnsignedByteType,
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Copy one player's binary planes into the texture bytes: R = explored,
 * G = visible, row-major matching tile indexing (y·size + x).
 */
export function writeFogPlaneIntoTexture(
  texture: DataTexture,
  state: FogState,
  player: number,
): void {
  const plane = state.planes[player];
  if (!plane) throw new Error(`unknown fog player: ${String(player)}`);
  const data = texture.image.data as Uint8Array;
  const explored = plane.explored;
  const visible = plane.visible;
  const len = state.size * state.size;
  for (let i = 0; i < len; i++) {
    data[i * 2] = explored[i]!;
    data[i * 2 + 1] = visible[i]!;
  }
  texture.needsUpdate = true;
}

/** Byte-for-byte copy of one fog texture into another (ping-pong step). */
export function copyFogTexture(source: DataTexture, target: DataTexture): void {
  (target.image.data as Uint8Array).set(source.image.data as Uint8Array);
  target.needsUpdate = true;
}

/** Shader uniforms shared by the terrain material patch. */
export interface FogShaderUniforms {
  /** Fog sampled at this tick's boundary. */
  readonly uFogCurr: { value: Texture };
  /** Fog sampled at the previous boundary (temporal blend source). */
  readonly uFogPrev: { value: Texture };
  /** 0 = prev, 1 = curr; driven by the frame-loop interpolation alpha. */
  readonly uBlend: { value: number };
}

/**
 * Allocate the curr/prev texture pair plus blend uniform from a fog
 * state, both textures pre-filled with `player`'s current planes.
 */
export function createFogShaderUniforms(
  state: FogState,
  player: number,
): FogShaderUniforms {
  const curr = createFogDataTexture(state.size);
  const prev = createFogDataTexture(state.size);
  writeFogPlaneIntoTexture(curr, state, player);
  writeFogPlaneIntoTexture(prev, state, player);
  return {
    uFogCurr: { value: curr },
    uFogPrev: { value: prev },
    uBlend: { value: 1 },
  };
}

const FOG_SHADER_PREAMBLE = /* glsl */ `
uniform sampler2D uFogCurr;
uniform sampler2D uFogPrev;
uniform float uBlend;
uniform float uFogMapSize;
varying vec2 vFogUv;
`;

/**
 * Patch a MeshLambertMaterial so terrain brightness follows the fog
 * planes. Vertex stage derives vFogUv from local XZ (the terrain mesh
 * is untransformed, so position.xz spans [0, mapSize]); fragment stage
 * multiplies albedo by mix(EXPLORED_DIM, 1, blendedVisible) *
 * step(0.5, blendedExplored) after vertex colors apply — lighting then
 * scales the dimmed result naturally.
 */
export function injectTerrainFog(
  material: MeshLambertMaterial,
  uniforms: FogShaderUniforms,
  mapSize: number,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFogCurr = uniforms.uFogCurr;
    shader.uniforms.uFogPrev = uniforms.uFogPrev;
    shader.uniforms.uBlend = uniforms.uBlend;
    shader.uniforms.uFogMapSize = { value: mapSize };

    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `${FOG_SHADER_PREAMBLE}\nvoid main() {`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  vFogUv = position.xz / uFogMapSize;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${FOG_SHADER_PREAMBLE}\nvoid main() {`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  vec2 d = vec2(1.5 / uFogMapSize);
  vec2 cUv = vFogUv;

  vec4 s0 = mix(texture2D(uFogPrev, cUv), texture2D(uFogCurr, cUv), uBlend);
  vec4 s1 = mix(texture2D(uFogPrev, cUv + vec2(d.x, d.y)), texture2D(uFogCurr, cUv + vec2(d.x, d.y)), uBlend);
  vec4 s2 = mix(texture2D(uFogPrev, cUv + vec2(-d.x, d.y)), texture2D(uFogCurr, cUv + vec2(-d.x, d.y)), uBlend);
  vec4 s3 = mix(texture2D(uFogPrev, cUv + vec2(d.x, -d.y)), texture2D(uFogCurr, cUv + vec2(d.x, -d.y)), uBlend);
  vec4 s4 = mix(texture2D(uFogPrev, cUv + vec2(-d.x, -d.y)), texture2D(uFogCurr, cUv + vec2(-d.x, -d.y)), uBlend);

  vec2 smoothFog = (s0.rg * 2.0 + s1.rg + s2.rg + s3.rg + s4.rg) / 6.0;
  float rawExplored = smoothFog.r * 255.0;
  float rawVisible = smoothFog.g * 255.0;

  float exploredFactor = smoothstep(0.05, 0.95, rawExplored);
  float visibleFactor = smoothstep(0.05, 0.95, rawVisible);

  float exploredBrightness = mix(${FOG_EXPLORED_DIM.toFixed(2)}, 1.0, visibleFactor);
  vec3 exploredTerrain = diffuseColor.rgb * exploredBrightness;
  vec3 deepCharcoal = vec3(0.04, 0.05, 0.07);
  diffuseColor.rgb = mix(deepCharcoal, exploredTerrain, exploredFactor);`,
      );
  };
}

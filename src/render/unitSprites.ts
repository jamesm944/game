/**
 * Instanced billboard units — M1-T7 (SPEC §2.14 GPU guarantees, §7).
 *
 * ONE draw call per unit type: an InstancedBufferGeometry of screen-
 * facing quads driven by a custom ShaderMaterial. Everything hot runs
 * on the GPU:
 *
 * - Playback: the vertex shader advances frames from uTime alone,
 *   quantized to a zoom-derived playback rate (uPlaybackRate) — the
 *   §7 LOD bands: near band 15 fps, far band (>60% zoom-out) 7.5 fps,
 *   identical formula to atlasFrames.frameAtTime. CPU animation cost:
 *   zero.
 * - Frame lookup: two RGBA32F index textures built by parseAtlasIndex
 *   (per-frame uv rects + per-action base/count/duration); the shader
 *   resolves (action slot, directionIndex, quantized frame) → uv rect.
 * - Billboarding: quad corners expand in VIEW space around the
 *   instance origin, so every sprite faces the camera exactly under
 *   the orthographic RTS rig.
 * - Team tint: per-instance rgb multiplier over the neutral-gray bake.
 *
 * Per-frame CPU work is one linear attribute fill
 * (atlasFrames.writeSpriteAttributes: origins/directions/tints) — no
 * matrices, no per-instance playback math. The perf gate in
 * tests/perf/billboard.test.ts pins that path at 10k instances < 2 ms.
 */

import {
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  type Texture,
} from "three";
import {
  atlasActionSlot,
  PLAYBACK_QUANTUM_FPS,
  parseAtlasIndex,
  writeSpriteAttributes,
  type ParsedAtlasIndex,
  type SpriteAttributeArrays,
  type SpriteSampleInput,
} from "./atlasFrames";

export interface UnitSpriteLayerOptions {
  /** Decoded atlas page texture (flipY upload as usual for PNGs). */
  readonly atlasTexture: Texture;
  /** Bake tool's frames JSON (already object-parsed). */
  readonly indexJson: unknown;
  /** Which baked action this field loops (one layer per unit type). */
  readonly action?: string;
  readonly maxInstances: number;
  /** Sprite size in world units (feet anchored at the instance origin). */
  readonly worldWidth: number;
  readonly worldHeight: number;
}

export interface UnitSpriteLayer {
  readonly mesh: Mesh;
  readonly atlas: ParsedAtlasIndex;
  /**
   * Rewrite the instance attributes from a mirror sample and plant
   * every sprite on the ground. Returns the written count (clamped to
   * maxInstances).
   */
  writeInstances(
    samples: SpriteSampleInput,
    heights: Float32Array,
    camAzimuthRad: number,
    tintR?: number,
    tintG?: number,
    tintB?: number,
  ): number;
  /** Push wall-clock time forward (seconds, monotonically increasing). */
  setTime(timeSec: number): void;
  /**
   * Select playback rate (SPEC §7 zoom bands): snaps playback to the
   * quantization fps the vertex shader snaps uTime to before dividing
   * the loop. Near band 15, far band 7.5 — see atlasFrames.
   */
  setPlaybackRate(quantumFps: number): void;
  dispose(): void;
}

const VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uRects;    // RGBA32F per absolute frame: u0, v0, du, dv
  uniform sampler2D uActions;  // RGBA32F per action slot: base, count, duration, yawCount
  uniform float uTime;
  uniform float uPlaybackRate; // LOD zoom band: quantization fps (15 near / 7.5 far)
  uniform float uActionSlots;
  uniform float uRectFrames;
  uniform float uSpriteWidth;
  uniform float uSpriteHeight;

  attribute vec3 aOrigin;
  attribute float aDirectionIndex;
  attribute float aActionSlot;
  attribute vec3 aTeamTint;

  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vec4 am = texture2D(
      uActions,
      vec2((aActionSlot + 0.5) / uActionSlots, 0.5)
    );
    // Quantized playback (mirrors atlasFrames.frameAtTime): time snaps
    // to the zoom-derived quantum BEFORE dividing the loop, so a whole
    // type flips frames together on shared ticks — near band 15 fps,
    // far band (>60% zoom-out) throttled to 7.5 fps (SPEC §7).
    float tq = floor(uTime * uPlaybackRate) / uPlaybackRate;
    float wrapped = tq - floor(tq / am.z) * am.z;
    float local = min(floor(wrapped / am.z * am.y), am.y - 1.0);
    float absolute = am.x + aDirectionIndex * am.y + local;

    vec4 rect = texture2D(uRects, vec2((absolute + 0.5) / uRectFrames, 0.5));
    vUv = rect.xy + uv * rect.zw;
    vTint = aTeamTint;

    // View-space expansion = exact camera-facing billboard for the
    // orthographic rig (geometry y spans [0,1]: feet at the anchor).
    vec4 center = viewMatrix * vec4(aOrigin, 1.0);
    center.xy += vec2(position.x * uSpriteWidth, position.y * uSpriteHeight);
    gl_Position = projectionMatrix * center;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vec4 texel = texture2D(uAtlas, vUv);
    if (texel.a < 0.5) discard; // bake alpha is binary
    gl_FragColor = vec4(texel.rgb * vTint, 1.0);
  }
`;

function buildFloatTexture(
  texels: Float32Array,
  texelsWide: number,
): DataTexture {
  const texture = new DataTexture(texels, texelsWide, 1, RGBAFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createUnitSpriteLayer(
  options: UnitSpriteLayerOptions,
): UnitSpriteLayer {
  const atlas: ParsedAtlasIndex = parseAtlasIndex(options.indexJson);
  if (atlas.pageCount !== 1) {
    throw new Error(
      `unit sprites support single-page atlases (got ${String(atlas.pageCount)}); extend the runtime when a bake exceeds one page`,
    );
  }
  const defaultAction =
    options.action ??
    (atlas.actions.some((a) => a.name === "idle")
      ? "idle"
      : atlas.actions[0]?.name ?? "idle");
  const { slot: defaultSlot } = atlasActionSlot(atlas, defaultAction);

  const quad = new PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0); // feet at instance origin

  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));

  const capacity = options.maxInstances;
  const arrays: SpriteAttributeArrays = {
    origins: new Float32Array(capacity * 3),
    directions: new Float32Array(capacity),
    tints: new Float32Array(capacity * 3),
    actionSlots: new Float32Array(capacity),
  };
  const originAttr = new InstancedBufferAttribute(arrays.origins, 3);
  const directionAttr = new InstancedBufferAttribute(arrays.directions, 1);
  const tintAttr = new InstancedBufferAttribute(arrays.tints, 3);
  const actionAttr = new InstancedBufferAttribute(arrays.actionSlots!, 1);
  for (const attr of [originAttr, directionAttr, tintAttr, actionAttr]) {
    attr.setUsage(DynamicDrawUsage);
  }
  geometry.setAttribute("aOrigin", originAttr);
  geometry.setAttribute("aDirectionIndex", directionAttr);
  geometry.setAttribute("aTeamTint", tintAttr);
  geometry.setAttribute("aActionSlot", actionAttr);
  geometry.instanceCount = 0;

  const material = new ShaderMaterial({
    uniforms: {
      uAtlas: { value: options.atlasTexture },
      uRects: { value: buildFloatTexture(atlas.rectTexels, atlas.totalFrames) },
      uActions: {
        value: buildFloatTexture(atlas.actionTexels, atlas.actions.length),
      },
      uTime: { value: 0 },
      uPlaybackRate: { value: PLAYBACK_QUANTUM_FPS },
      uActionSlots: { value: atlas.actions.length },
      uRectFrames: { value: atlas.totalFrames },
      uSpriteWidth: { value: options.worldWidth },
      uSpriteHeight: { value: options.worldHeight },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false; // positions change wholesale every frame
  mesh.name = atlas.id;

  return {
    mesh,
    atlas,
    writeInstances(samples, heights, camAzimuthRad, tintR = 1, tintG = 1, tintB = 1) {
      const count = writeSpriteAttributes(
        arrays,
        samples,
        heights,
        { yawCount: atlas.yawCount, defaultActionSlot: defaultSlot },
        camAzimuthRad,
        tintR,
        tintG,
        tintB,
        capacity,
      );
      geometry.instanceCount = count;
      mesh.visible = count > 0;
      originAttr.needsUpdate = true;
      directionAttr.needsUpdate = true;
      tintAttr.needsUpdate = true;
      actionAttr.needsUpdate = true;
      return count;
    },
    setTime(timeSec: number) {
      const time = material.uniforms.uTime;
      if (time) time.value = timeSec;
    },
    setPlaybackRate(quantumFps: number) {
      const rate = material.uniforms.uPlaybackRate;
      if (rate && Number.isFinite(quantumFps) && quantumFps > 0) {
        rate.value = quantumFps;
      }
    },
    dispose() {
      quad.dispose();
      geometry.dispose();
      material.dispose();
      const rects = material.uniforms.uRects?.value;
      if (rects instanceof DataTexture) rects.dispose();
      const actions = material.uniforms.uActions?.value;
      if (actions instanceof DataTexture) actions.dispose();
    },
  };
}

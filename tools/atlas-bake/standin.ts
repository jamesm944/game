/**
 * Stand-in rigged "cube-human" — SWAP(gltf) source for the atlas bake.
 *
 * The SPEC's default bake source is Quaternius Universal Base
 * Characters (SPEC §6), but this ticket ships against an in-repo,
 * deterministically generated rig so the pipeline never blocks on a
 * network fetch. The rig is bone-parented rigid boxes with synthetic
 * AnimationClips (walk, idle) authored as dense per-frame keyframes,
 * so every sampled bake frame is an exact authored pose and output is
 * byte-stable run-to-run.
 *
 * SWAP(gltf): run the tool with --gltf <path> to load a real GLTF/GLB
 * instead (see loadRig in index.ts). The only contract a source must
 * satisfy is RigSource below — { root facing +Z at bind pose,
 * clips keyed by action name } — everything downstream (sampling,
 * rasterizing, layout, indexing) is identical for both sources.
 */

import {
  AnimationClip,
  BoxGeometry,
  Euler,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from "three";

export interface RigSource {
  readonly root: Object3D;
  readonly clips: Readonly<Record<string, AnimationClip>>;
}

/** Clip spec mirrored verbatim into the baked atlas index JSON. */
export interface BakeActionSpec {
  readonly name: string;
  readonly frameCount: number;
  readonly fps: number;
}

/** The two M1 actions; chop/mine/carry land with M2 content. */
export const BAKE_ACTIONS: readonly BakeActionSpec[] = [
  { name: "idle", frameCount: 4, fps: 6 },
  { name: "walk", frameCount: 8, fps: 12 },
];

const HIP_HEIGHT = 0.9;

function limb(
  name: string,
  w: number,
  h: number,
  x: number,
  y: number,
): Object3D {
  // Pivot sits at the joint; the box hangs below it like a limb.
  const pivot = new Object3D();
  pivot.name = name;
  pivot.position.set(x, y, 0);
  const geometry = new BoxGeometry(w, h, w);
  geometry.translate(0, -h / 2, 0);
  pivot.add(new Mesh(geometry, new MeshBasicMaterial()));
  return pivot;
}

function swingTrack(
  objectName: string,
  amplitudeDeg: number,
  frames: number,
  fps: number,
  phaseOffsetRad = 0,
): QuaternionKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < frames; k++) {
    times.push(k / fps);
    const angle =
      ((amplitudeDeg * Math.PI) / 180) *
      Math.sin((2 * Math.PI * k) / frames + phaseOffsetRad);
    const quat = new Quaternion().setFromEuler(new Euler(angle, 0, 0));
    values.push(quat.x, quat.y, quat.z, quat.w);
  }
  // Loop-seam key: pose at duration equals pose at 0 → no hold frame.
  times.push(frames / fps);
  values.push(...values.slice(0, 4));
  return new QuaternionKeyframeTrack(`${objectName}.quaternion`, times, values);
}

function bobTrack(
  objectName: string,
  baseY: number,
  amplitude: number,
  bouncesPerLoop: number,
  frames: number,
  fps: number,
): VectorKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < frames; k++) {
    times.push(k / fps);
    const rise =
      amplitude *
      (0.5 - 0.5 * Math.cos((2 * Math.PI * bouncesPerLoop * k) / frames));
    values.push(0, baseY + rise, 0); // position track: (x, y, z)
  }
  times.push(frames / fps);
  values.push(0, baseY, 0);
  return new VectorKeyframeTrack(`${objectName}.position`, times, values);
}

/**
 * Build the stand-in rig: pelvis-rooted skeleton, torso/head/limb
 * meshes parented to pivots, plus the walk/idle clips. Pure function —
 * every call produces identical objects.
 */
export function buildStandInRig(): RigSource {
  const root = new Object3D();
  root.name = "stand-in-cube-human"; // faces +Z at bind pose

  const hips = new Object3D();
  hips.name = "hips";
  hips.position.y = HIP_HEIGHT;
  root.add(hips);

  const torsoGeometry = new BoxGeometry(0.44, 0.52, 0.26);
  torsoGeometry.translate(0, 0.26, 0);
  hips.add(new Mesh(torsoGeometry, new MeshBasicMaterial()));

  const neck = new Object3D();
  neck.name = "neck";
  neck.position.y = 0.56;
  hips.add(neck);
  const headGeometry = new BoxGeometry(0.28, 0.28, 0.28);
  headGeometry.translate(0, 0.16, 0);
  neck.add(new Mesh(headGeometry, new MeshBasicMaterial()));

  hips.add(limb("arm-l", 0.13, 0.52, -0.295, 0.5));
  hips.add(limb("arm-r", 0.13, 0.52, 0.295, 0.5));
  hips.add(limb("leg-l", 0.15, HIP_HEIGHT, -0.115, 0));
  hips.add(limb("leg-r", 0.15, HIP_HEIGHT, 0.115, 0));

  const clips: Record<string, AnimationClip> = {};
  for (const spec of BAKE_ACTIONS) {
    const walking = spec.name === "walk";
    const legAmp = walking ? 42 : 0;
    const armAmp = walking ? 34 : 3;
    clips[spec.name] = new AnimationClip(
      spec.name,
      spec.frameCount / spec.fps,
      [
        swingTrack("leg-l", legAmp, spec.frameCount, spec.fps),
        swingTrack("leg-r", -legAmp, spec.frameCount, spec.fps),
        swingTrack("arm-l", armAmp, spec.frameCount, spec.fps, Math.PI),
        swingTrack("arm-r", -armAmp, spec.frameCount, spec.fps, Math.PI),
        bobTrack(
          "hips",
          HIP_HEIGHT,
          walking ? 0.05 : 0.02,
          walking ? 2 : 1,
          spec.frameCount,
          spec.fps,
        ),
      ],
    );
  }

  return { root, clips };
}

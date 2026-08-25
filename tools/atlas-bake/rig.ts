/**
 * Rig assembly for the atlas bake — turns a UnitBake manifest entry
 * into an animatable scene (change #3 of the ASSET-INVENTORY
 * 6-change list: the per-unit action manifest that replaced the old
 * two-clip BAKE_ACTIONS).
 *
 * Parts load fresh per unit — no shared mutation between bakes — rigid
 * vendor props are stripped when configured, part subtrees parent
 * together (the scout-cavalry mount+rider kitbash), and each action's
 * clips bind as simultaneous mixer actions so composites sample
 * coherently at identical mixer times.
 */

import * as path from "node:path";
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Object3D,
} from "three";
import { MODELS_ROOT, type UnitBake } from "./manifest";
import { loadGltfScene } from "./gltfLoad";

interface LoadedPart {
  scene: Object3D;
  clips: Map<string, AnimationClip>;
}

export interface AssembledAction {
  readonly name: string;
  /**
   * One mixer per action; every binding's AnimationAction lives on it
   * and is sampled by setting equal `.time` values before `update(0)`.
   */
  readonly mixers: readonly AnimationMixer[];
  readonly mixerActions: readonly AnimationAction[];
  /** Prop scenes for this action, detached until the action samples. */
  readonly propRoots: Object3D[];
  /** Bones the props parent back into (parallel to propRoots). */
  readonly propBones: string[];
}

export interface AssembledRig {
  /** Scene-graph root to hang on the bake turntable wrapper. */
  readonly root: Object3D;
  readonly actions: ReadonlyMap<string, AssembledAction>;
}

function stripRigidProps(root: Object3D): void {
  const doomed: Object3D[] = [];
  root.traverse((node) => {
    const m = node as Object3D & {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
    };
    if (m.isMesh && !m.isSkinnedMesh) doomed.push(node);
  });
  for (const d of doomed) d.removeFromParent();
}

/** Degrees→radians in one place so manifest comments stay honest. */
const DEG = Math.PI / 180;

/**
 * Assemble the unit's rig. Throws loudly on missing files, clips, or
 * bones — the SPEC load discipline applies at bake time too.
 */
export async function assembleRig(bake: UnitBake): Promise<AssembledRig> {
  const parts = new Map<string, LoadedPart>();
  let rootPart: Object3D | undefined;

  for (const spec of bake.parts) {
    const gltf = await loadGltfScene(path.join(MODELS_ROOT, spec.file));
    const sceneRoot = gltf.scene;
    if (spec.stripDefaultProps) stripRigidProps(sceneRoot);
    if (spec.scale !== undefined) sceneRoot.scale.setScalar(spec.scale);
    const clips = new Map<string, AnimationClip>();
    for (const clip of gltf.animations) {
      if (!clips.has(clip.name)) clips.set(clip.name, clip);
    }
    parts.set(spec.key, { scene: sceneRoot, clips });
    // Clip-source parts stay out of the rendered graph entirely: their
    // tracks retarget onto the rendered rigs by node name at play time.
    if (spec.clipsOnly) continue;
    if (spec.parent === undefined) {
      if (rootPart) {
        throw new Error(`unit ${bake.id} has multiple root parts`);
      }
      rootPart = sceneRoot;
    } else {
      const parent = parts.get(spec.parent);
      if (!parent) {
        throw new Error(
          `unit ${bake.id} part ${spec.key} references unknown parent ${spec.parent}`,
        );
      }
      parent.scene.add(sceneRoot);
      if (spec.position) sceneRoot.position.set(...spec.position);
      if (spec.rotationDegY) sceneRoot.rotation.y = spec.rotationDegY * DEG;
    }
  }
  if (!rootPart) throw new Error(`unit ${bake.id} lacks a root part`);

  // Facing normalization: every vendor rig is rotated once at the root
  // so yaw k·τ/8 about the wrapper means the same thing for all units.
  rootPart.rotation.y += bake.yawOffsetDeg * DEG;

  const wrapper = new Object3D();
  wrapper.name = `bake-${bake.id}`;
  wrapper.add(rootPart);

  const findBone = (name: string): Object3D => {
    const bone = wrapper.getObjectByName(name);
    if (!bone) {
      throw new Error(`unit ${bake.id} has no node named "${name}"`);
    }
    return bone;
  };

  const actions = new Map<string, AssembledAction>();
  for (const action of bake.actions) {
    const mixer = new AnimationMixer(wrapper);
    const mixerActions: AnimationAction[] = [];
    for (const binding of action.bindings) {
      const part = parts.get(binding.part);
      if (!part) {
        throw new Error(
          `unit ${bake.id} action ${action.name} binds unknown part ${binding.part}`,
        );
      }
      const clip = part.clips.get(binding.clip);
      if (!clip) {
        throw new Error(
          `unit ${bake.id} action ${action.name}: clip "${binding.clip}" not found ` +
            `(has: ${[...part.clips.keys()].sort().join(", ")})`,
        );
      }
      mixerActions.push(mixer.clipAction(clip).play());
    }

    const propRoots: Object3D[] = [];
    const propBones: string[] = [];
    for (const prop of action.props ?? []) {
      const bone = findBone(prop.bone);
      const propGltf = await loadGltfScene(path.join(MODELS_ROOT, prop.file));
      const propRoot = propGltf.scene;
      if (prop.scale !== undefined) propRoot.scale.setScalar(prop.scale);
      if (prop.position) propRoot.position.set(...prop.position);
      if (prop.rotationDeg) {
        propRoot.rotation.set(
          prop.rotationDeg[0]! * DEG,
          prop.rotationDeg[1]! * DEG,
          prop.rotationDeg[2]! * DEG,
        );
      }
      // Attach, then detach immediately: the sampler attaches exactly
      // one action's props for the duration of that action's sampling.
      bone.add(propRoot);
      propRoot.removeFromParent();
      propRoots.push(propRoot);
      propBones.push(prop.bone);
    }

    actions.set(action.name, {
      name: action.name,
      mixers: [mixer],
      mixerActions,
      propRoots,
      propBones,
    });
  }

  return { root: wrapper, actions };
}

/** Parent an action's props into its bones before sampling. */
export function attachProps(action: AssembledAction, rigRoot: Object3D): void {
  action.propRoots.forEach((propRoot, i) => {
    const bone = rigRoot.getObjectByName(action.propBones[i]!);
    if (!bone) {
      throw new Error(`prop bone "${action.propBones[i]}" vanished`);
    }
    bone.add(propRoot);
  });
}

/** Detach an action's prop scenes (called after the action finishes). */
export function detachProps(action: AssembledAction): void {
  for (const propRoot of action.propRoots) propRoot.removeFromParent();
}

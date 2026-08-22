/**
 * Build-ghost overlay — SPEC §2.13 prototype-validated placement UX.
 *
 * Grid-snapped footprint preview while the player arms a building from
 * the build menu: one translucent quad per tile, GREEN when the shared
 * sim validity function accepts the origin and RED when it rejects.
 * Pure three.js — main.ts feeds snapped origins + validity each frame.
 */

import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";
import type { FootprintRect } from "../sim/components/buildings";

const VALID_COLOR = new Color(0x4caf50);
const INVALID_COLOR = new Color(0xe05348);
const MAX_GHOST_TILES = 25; // covers a 5×5 footprint

const scratch = new Object3D();

export interface BuildGhost {
  mesh: InstancedMesh;
  /** Show the ghost for one candidate rect (tiles colored by validity). */
  show(rect: FootprintRect, valid: boolean, layers: WorldLayers): void;
  hide(): void;
}

export function createBuildGhost(): BuildGhost {
  const geometry = new PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2); // lie flat on the ground plane
  const material = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    color: 0xffffff,
  });
  const mesh = new InstancedMesh(geometry, material, MAX_GHOST_TILES);
  mesh.instanceColor = new InstancedBufferAttribute(
    new Float32Array(MAX_GHOST_TILES * 3).fill(1),
    3,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;

  const show = (
    rect: FootprintRect,
    valid: boolean,
    layers: WorldLayers,
  ): void => {
    const tiles = rect.width * rect.height;
    const count = Math.min(tiles, MAX_GHOST_TILES);
    let i = 0;
    for (let dy = 0; dy < rect.height && i < count; dy++) {
      for (let dx = 0; dx < rect.width && i < count; dx++) {
        const tx = rect.x + dx + 0.5;
        const ty = rect.y + dy + 0.5;
        scratch.position.set(tx, terrainHeightAt(layers, tx, ty) + 0.03, ty);
        scratch.rotation.set(0, 0, 0);
        scratch.scale.set(0.96, 1, 0.96);
        scratch.updateMatrix();
        mesh.setMatrixAt(i, scratch.matrix);
        mesh.setColorAt(i, valid ? VALID_COLOR : INVALID_COLOR);
        i++;
      }
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  return {
    mesh: mesh as InstancedMesh,
    show,
    hide() {
      mesh.count = 0;
    },
  };
}

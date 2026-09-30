/**
 * Rally Flag & Waypoint Line Layer — V11 (#82).
 *
 * Renders a 3D rally flag and connecting dotted waypoint line for
 * production buildings (Town Center, Barracks, Archery Range, Stable, Castle)
 * when selected or when an active rally point is designated.
 */

import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Scene,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export interface RallyPoint {
  buildingEid: number;
  buildingX: number;
  buildingY: number;
  rallyX: number;
  rallyY: number;
}

export interface RallyFlagLayer {
  setRally(
    buildingEid: number,
    buildingX: number,
    buildingY: number,
    rallyX: number,
    rallyY: number,
  ): void;
  getRally(buildingEid: number): [number, number] | undefined;
  clearRally(buildingEid: number): void;
  update(
    selectedBuildingEid: number | readonly number[] | undefined,
    timeSec: number,
  ): void;
  dispose(): void;
}

interface FlagInstance {
  readonly flagGroup: Group;
  readonly flagMesh: Mesh;
  readonly line: Line;
  readonly lineGeom: BufferGeometry;
}

export function createRallyFlagLayer(
  scene: Scene,
  layers: WorldLayers,
): RallyFlagLayer {
  const group = new Group();
  group.name = "rally-flags";
  scene.add(group);

  const poleGeom = new CylinderGeometry(0.04, 0.04, 1.8, 8);
  poleGeom.translate(0, 0.9, 0);
  const poleMat = new MeshLambertMaterial({ color: 0x8a633a });

  const finialGeom = new SphereGeometry(0.08, 8, 8);
  finialGeom.translate(0, 1.85, 0);
  const finialMat = new MeshLambertMaterial({ color: 0xf39c12 });

  const flagGeom = new PlaneGeometry(0.85, 0.5, 4, 1);
  flagGeom.translate(0.425, 1.5, 0);
  const flagMat = new MeshLambertMaterial({
    color: 0x2980b9, // Player 1 blue
    side: 2, // DoubleSide
  });

  const lineMat = new LineDashedMaterial({
    color: 0xf1c40f,
    dashSize: 0.35,
    gapSize: 0.25,
    scale: 1,
  });

  const pool: FlagInstance[] = [];

  function createInstance(): FlagInstance {
    const flagGroup = new Group();
    const poleMesh = new Mesh(poleGeom, poleMat);
    flagGroup.add(poleMesh);
    const finialMesh = new Mesh(finialGeom, finialMat);
    flagGroup.add(finialMesh);
    const flagMesh = new Mesh(flagGeom, flagMat);
    flagGroup.add(flagMesh);
    flagGroup.visible = false;
    group.add(flagGroup);

    const lineGeom = new BufferGeometry();
    lineGeom.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
    );
    const line = new Line(lineGeom, lineMat);
    line.computeLineDistances();
    line.visible = false;
    group.add(line);

    return { flagGroup, flagMesh, line, lineGeom };
  }

  const rallyMap = new Map<number, RallyPoint>();

  return {
    setRally(buildingEid, buildingX, buildingY, rallyX, rallyY): void {
      rallyMap.set(buildingEid, {
        buildingEid,
        buildingX,
        buildingY,
        rallyX,
        rallyY,
      });
    },

    getRally(buildingEid): [number, number] | undefined {
      const entry = rallyMap.get(buildingEid);
      return entry ? [entry.rallyX, entry.rallyY] : undefined;
    },

    clearRally(buildingEid): void {
      rallyMap.delete(buildingEid);
    },

    update(selectedBuildingEid, timeSec): void {
      const eids =
        selectedBuildingEid === undefined
          ? []
          : typeof selectedBuildingEid === "number"
            ? [selectedBuildingEid]
            : selectedBuildingEid;

      let instanceIdx = 0;
      for (const eid of eids) {
        const rally = rallyMap.get(eid);
        if (!rally) continue;

        if (instanceIdx >= pool.length) {
          pool.push(createInstance());
        }
        const inst = pool[instanceIdx]!;
        instanceIdx += 1;

        const groundY = terrainHeightAt(layers, rally.rallyX, rally.rallyY);
        const bGroundY = terrainHeightAt(
          layers,
          rally.buildingX,
          rally.buildingY,
        );

        inst.flagGroup.position.set(rally.rallyX, groundY, rally.rallyY);
        inst.flagGroup.visible = true;

        // Animate fluttering flag in wind
        inst.flagMesh.rotation.y = Math.sin(timeSec * 5.0 + instanceIdx) * 0.15;

        // Update connecting dotted line
        const positions = inst.lineGeom.attributes
          .position as Float32BufferAttribute;
        positions.setXYZ(0, rally.buildingX, bGroundY + 0.15, rally.buildingY);
        positions.setXYZ(1, rally.rallyX, groundY + 0.15, rally.rallyY);
        positions.needsUpdate = true;
        inst.line.computeLineDistances();
        inst.line.visible = true;
      }

      // Hide unused pool items
      for (let i = instanceIdx; i < pool.length; i++) {
        pool[i]!.flagGroup.visible = false;
        pool[i]!.line.visible = false;
      }
    },

    dispose(): void {
      scene.remove(group);
      poleGeom.dispose();
      poleMat.dispose();
      finialGeom.dispose();
      finialMat.dispose();
      flagGeom.dispose();
      flagMat.dispose();
      for (const inst of pool) {
        inst.lineGeom.dispose();
      }
      lineMat.dispose();
    },
  };
}

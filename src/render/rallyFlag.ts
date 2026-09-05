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
  update(selectedBuildingEid: number | undefined, timeSec: number): void;
  dispose(): void;
}

export function createRallyFlagLayer(
  scene: Scene,
  layers: WorldLayers,
): RallyFlagLayer {
  const group = new Group();
  group.name = "rally-flags";
  scene.add(group);

  // 1) Flagpole & Banner Mesh
  const flagGroup = new Group();

  // Wooden flagpole
  const poleGeom = new CylinderGeometry(0.04, 0.04, 1.8, 8);
  poleGeom.translate(0, 0.9, 0);
  const poleMat = new MeshLambertMaterial({ color: 0x8a633a });
  const poleMesh = new Mesh(poleGeom, poleMat);
  flagGroup.add(poleMesh);

  // Gold spearhead/sphere finial
  const finialGeom = new SphereGeometry(0.08, 8, 8);
  finialGeom.translate(0, 1.85, 0);
  const finialMat = new MeshLambertMaterial({ color: 0xf39c12 });
  const finialMesh = new Mesh(finialGeom, finialMat);
  flagGroup.add(finialMesh);

  // Triangular waving team pennant flag
  const flagGeom = new PlaneGeometry(0.85, 0.5, 4, 1);
  flagGeom.translate(0.425, 1.5, 0);
  const flagMat = new MeshLambertMaterial({
    color: 0x2980b9, // Player 1 blue
    side: 2, // DoubleSide
  });
  const flagMesh = new Mesh(flagGeom, flagMat);
  flagGroup.add(flagMesh);

  flagGroup.visible = false;
  group.add(flagGroup);

  // 2) Waypoint dotted line connecting building to flag
  const lineGeom = new BufferGeometry();
  lineGeom.setAttribute(
    "position",
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
  );
  const lineMat = new LineDashedMaterial({
    color: 0xf1c40f,
    dashSize: 0.35,
    gapSize: 0.25,
    scale: 1,
  });
  const line = new Line(lineGeom, lineMat);
  line.computeLineDistances();
  line.visible = false;
  group.add(line);

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
      if (selectedBuildingEid === undefined) {
        flagGroup.visible = false;
        line.visible = false;
        return;
      }

      const rally = rallyMap.get(selectedBuildingEid);
      if (!rally) {
        flagGroup.visible = false;
        line.visible = false;
        return;
      }

      const groundY = terrainHeightAt(layers, rally.rallyX, rally.rallyY);
      const bGroundY = terrainHeightAt(
        layers,
        rally.buildingX,
        rally.buildingY,
      );

      flagGroup.position.set(rally.rallyX, groundY, rally.rallyY);
      flagGroup.visible = true;

      // Animate fluttering flag in wind
      flagMesh.rotation.y = Math.sin(timeSec * 5.0) * 0.15;

      // Update connecting dotted line
      const positions = lineGeom.attributes.position as Float32BufferAttribute;
      positions.setXYZ(0, rally.buildingX, bGroundY + 0.15, rally.buildingY);
      positions.setXYZ(1, rally.rallyX, groundY + 0.15, rally.rallyY);
      positions.needsUpdate = true;
      line.computeLineDistances();
      line.visible = true;
    },

    dispose(): void {
      scene.remove(group);
      poleGeom.dispose();
      poleMat.dispose();
      finialGeom.dispose();
      finialMat.dispose();
      flagGeom.dispose();
      flagMat.dispose();
      lineGeom.dispose();
      lineMat.dispose();
    },
  };
}

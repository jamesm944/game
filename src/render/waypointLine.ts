/**
 * Waypoint Visual Layer — W1 (#132).
 *
 * Renders 3D dotted/dashed waypoint route lines and waypoint markers
 * connecting the current position of selected units through each intermediate
 * waypoint in their active/queued ActivityQueue.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export interface WaypointLayer {
  update(
    selectedEids: readonly number[],
    getUnitWaypoints: (eid: number) => readonly { x: number; y: number }[],
  ): void;
  dispose(): void;
}

interface WaypointLineInstance {
  readonly line: Line;
  readonly lineGeom: BufferGeometry;
}

interface WaypointMarkerInstance {
  readonly mesh: Mesh;
}

export function createWaypointLayer(
  scene: Scene,
  layers: WorldLayers,
): WaypointLayer {
  const group = new Group();
  group.name = "waypoint-lines";
  scene.add(group);

  const lineMat = new LineDashedMaterial({
    color: 0x00f0ff, // Vibrant tactical cyan / wayfinder marker
    dashSize: 0.35,
    gapSize: 0.2,
    scale: 1,
  });

  const markerGeom = new RingGeometry(0.12, 0.22, 16);
  markerGeom.rotateX(-Math.PI / 2); // Flat on ground
  const markerMat = new MeshBasicMaterial({
    color: 0x00f0ff,
    side: 2, // DoubleSide
    transparent: true,
    opacity: 0.85,
  });

  const linePool: WaypointLineInstance[] = [];
  const markerPool: WaypointMarkerInstance[] = [];

  function createLineInstance(): WaypointLineInstance {
    const lineGeom = new BufferGeometry();
    lineGeom.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
    );
    const line = new Line(lineGeom, lineMat);
    line.computeLineDistances();
    line.visible = false;
    group.add(line);
    return { line, lineGeom };
  }

  function createMarkerInstance(): WaypointMarkerInstance {
    const mesh = new Mesh(markerGeom, markerMat);
    mesh.visible = false;
    group.add(mesh);
    return { mesh };
  }

  return {
    update(selectedEids, getUnitWaypoints): void {
      let lineIdx = 0;
      let markerIdx = 0;

      for (const eid of selectedEids) {
        const waypoints = getUnitWaypoints(eid);
        if (waypoints.length < 2) continue;

        if (lineIdx >= linePool.length) {
          linePool.push(createLineInstance());
        }
        const inst = linePool[lineIdx]!;
        lineIdx += 1;

        const coords: number[] = [];
        for (let i = 0; i < waypoints.length; i++) {
          const pt = waypoints[i]!;
          const gy = terrainHeightAt(layers, pt.x, pt.y) + 0.12;
          coords.push(pt.x, gy, pt.y);

          // Place waypoint circle marker for each target waypoint (excluding current start pos)
          if (i > 0) {
            if (markerIdx >= markerPool.length) {
              markerPool.push(createMarkerInstance());
            }
            const marker = markerPool[markerIdx]!;
            markerIdx += 1;
            marker.mesh.position.set(pt.x, gy + 0.02, pt.y);
            marker.mesh.visible = true;
          }
        }

        inst.lineGeom.setAttribute(
          "position",
          new Float32BufferAttribute(coords, 3),
        );
        inst.line.computeLineDistances();
        inst.line.visible = true;
      }

      // Hide unused pool items
      for (let i = lineIdx; i < linePool.length; i++) {
        linePool[i]!.line.visible = false;
      }
      for (let i = markerIdx; i < markerPool.length; i++) {
        markerPool[i]!.mesh.visible = false;
      }
    },

    dispose(): void {
      scene.remove(group);
      for (const inst of linePool) {
        inst.lineGeom.dispose();
      }
      for (const inst of markerPool) {
        // Shared markerGeom disposed below
        inst.mesh.visible = false;
      }
      markerGeom.dispose();
      lineMat.dispose();
      markerMat.dispose();
    },
  };
}

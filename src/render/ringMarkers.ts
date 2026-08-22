/**
 * Order feedback rings — M1-T8 (SPEC §2.13).
 *
 * A small pooled overlay of flat ring meshes in the main scene. The
 * orders layer spawns one synchronously inside the click handler, so
 * the expanding green marker is visible on the very next render — the
 * same frame the user clicked (validated prototype behavior: 0.7 s
 * life, radius grows outward while fading).
 */

import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
} from "three";
import type { WorldLayers } from "../sim/world/layers";
import { terrainHeightAt } from "./terrain";

export interface RingMarkerPool {
  /** Spawn a marker at sim-coordinate (x, y) immediately. */
  spawn(x: number, y: number): void;
  /** Advance lifetimes; call once per rendered frame. */
  update(dtSeconds: number): void;
}

export interface RingMarkerOptions {
  readonly scene: Scene;
  readonly layers: WorldLayers;
  /** Marker lifetime seconds (prototype: 0.7). */
  readonly durationSec?: number | undefined;
  /** World-tile radius at spawn / at expiry. */
  readonly startRadius?: number | undefined;
  readonly endRadius?: number | undefined;
  readonly colorHex?: number | undefined;
  /** Pool size bounds worst-case concurrent markers (draw-call budget). */
  readonly max?: number | undefined;
}

const DEFAULT_DURATION_SEC = 0.7;
const DEFAULT_START_RADIUS = 0.35;
const DEFAULT_END_RADIUS = 1.9;
const DEFAULT_COLOR_HEX = 0x7ec46f; // prototype move-marker green
/**
 * Pool size bounds worst-case concurrent markers. Sized so terrain +
 * sprite field + this pool + selection rings stays within the §7
 * single-digit draw-call budget even under marker spam.
 */
const DEFAULT_MAX = 5;

interface PooledMarker {
  readonly mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  ageSec: number;
}

export function createRingMarkerPool(
  options: RingMarkerOptions,
): RingMarkerPool {
  const durationSec = options.durationSec ?? DEFAULT_DURATION_SEC;
  const startRadius = options.startRadius ?? DEFAULT_START_RADIUS;
  const endRadius = options.endRadius ?? DEFAULT_END_RADIUS;
  const max = options.max ?? DEFAULT_MAX;

  const markers: PooledMarker[] = [];
  for (let i = 0; i < max; i++) {
    const geometry = new RingGeometry(0.82, 1, 40);
    geometry.rotateX(-Math.PI / 2); // lie flat on the ground plane
    const material = new MeshBasicMaterial({
      color: options.colorHex ?? DEFAULT_COLOR_HEX,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    mesh.renderOrder = 2;
    options.scene.add(mesh);
    markers.push({ mesh, ageSec: Infinity });
  }

  let cursor = 0;

  return {
    spawn(x: number, y: number): void {
      // Round-robin: oldest marker is silently recycled on overflow.
      const marker = markers[cursor]!;
      cursor = (cursor + 1) % markers.length;
      marker.ageSec = 0;
      const groundY = terrainHeightAt(options.layers, x, y);
      marker.mesh.position.set(x, groundY + 0.07, y);
      marker.mesh.scale.setScalar(startRadius);
      marker.mesh.material.opacity = 0.95;
      marker.mesh.visible = true;
    },

    update(dtSeconds: number): void {
      for (const marker of markers) {
        if (!marker.mesh.visible) continue;
        marker.ageSec += dtSeconds;
        if (marker.ageSec >= durationSec) {
          marker.mesh.visible = false;
          continue;
        }
        const p = marker.ageSec / durationSec;
        marker.mesh.scale.setScalar(
          startRadius + (endRadius - startRadius) * p,
        );
        marker.mesh.material.opacity = 0.95 * (1 - p);
      }
    },
  };
}

/**
 * Order feedback markers — M1-T8 (SPEC §2.13) / V11 (#82).
 *
 * A small pooled overlay of flat ring + chevron marker meshes in the main scene.
 * The orders layer spawns one synchronously inside the click handler, so the
 * expanding green tactical marker is visible on the very next render.
 */

import {
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  type Scene,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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
  /** Marker lifetime seconds (default: 0.65). */
  readonly durationSec?: number | undefined;
  /** World-tile radius at spawn / at expiry. */
  readonly startRadius?: number | undefined;
  readonly endRadius?: number | undefined;
  readonly colorHex?: number | undefined;
  /** Pool size bounds worst-case concurrent markers. */
  readonly max?: number | undefined;
}

const DEFAULT_DURATION_SEC = 0.65;
const DEFAULT_START_RADIUS = 0.35;
const DEFAULT_END_RADIUS = 1.65;
const DEFAULT_COLOR_HEX = 0x48e05c; // vibrant AoE2 tactical move-marker green
const DEFAULT_MAX = 6;

interface PooledMarker {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  ageSec: number;
}

function createOrderMarkerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  // Outer circular ring
  const ring = new RingGeometry(0.82, 1.0, 32);
  ring.rotateX(-Math.PI / 2);
  parts.push(ring);

  // 4 directional chevron ticks
  const tickWidth = 0.08;
  const tickLength = 0.32;
  for (let i = 0; i < 4; i++) {
    const tick = new PlaneGeometry(tickWidth, tickLength);
    tick.rotateX(-Math.PI / 2);
    tick.rotateY((i * Math.PI) / 2);
    tick.translate(0, 0, 0.68);
    parts.push(tick);
  }

  return mergeGeometries(parts, false);
}

export function createRingMarkerPool(
  options: RingMarkerOptions,
): RingMarkerPool {
  const durationSec = options.durationSec ?? DEFAULT_DURATION_SEC;
  const startRadius = options.startRadius ?? DEFAULT_START_RADIUS;
  const endRadius = options.endRadius ?? DEFAULT_END_RADIUS;
  const max = options.max ?? DEFAULT_MAX;

  const geometry = createOrderMarkerGeometry();
  const markers: PooledMarker[] = [];
  for (let i = 0; i < max; i++) {
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
      const marker = markers[cursor]!;
      cursor = (cursor + 1) % markers.length;
      marker.ageSec = 0;
      const groundY = terrainHeightAt(options.layers, x, y);
      marker.mesh.position.set(x, groundY + 0.07, y);
      marker.mesh.scale.setScalar(startRadius);
      marker.mesh.material.opacity = 0.95;
      marker.mesh.rotation.y = 0;
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
        // Cubic ease-out for snappy expansion
        const easeOut = 1 - Math.pow(1 - p, 3);
        const currentRadius = startRadius + (endRadius - startRadius) * easeOut;
        marker.mesh.scale.setScalar(currentRadius);
        // Subtle rotational spin during expansion
        marker.mesh.rotation.y = easeOut * 0.4;
        marker.mesh.material.opacity = 0.95 * (1 - p * p);
      }
    },
  };
}

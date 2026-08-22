/**
 * Render-mirror snapshot producer — SPEC §2.1 seam / ADR-0001.
 *
 * The renderer never reaches into component rows; instead this PURE
 * module copies everything it needs into plain typed arrays AFTER each
 * step(). `render/` imports only this file (plus types), so the seam
 * stays one-directional: render reads, sim knows nothing of render.
 *
 * Frame layout is SoA, indexed by ascending-eid rank i (NOT by eid —
 * eids travel alongside for future id-keyed overlays):
 *   positions[2i], positions[2i + 1]  → x,y float tile coordinates
 *   headings[i]                       → facing radians (Velocity row [0])
 */

import type { MovementComponents } from "./components";
import type { World } from "./core/world";

/** One post-step frame of unit state, ready for the double buffer. */
export interface SimSnapshotFrame {
  /** World tick this frame was captured after. */
  readonly tick: number;
  /** Live units copied; arrays are valid up to this count. */
  readonly count: number;
  /** Ascending eids; index i ↔ positions[2i] / headings[i]. */
  readonly eids: Int32Array;
  /** Packed x,y pairs, capacity ≥ 2·count. */
  readonly positions: Float32Array;
  /** Facing radians, capacity ≥ count. */
  readonly headings: Float32Array;
}

export interface CaptureSnapshotOptions {
  /**
   * Preallocated frame to reuse across captures (zero steady-state
   * allocation). Grown transparently when the live population rises;
   * omit for a fresh allocation each call.
   */
  readonly reusable?: SimSnapshotFrame | undefined;
}

function growF32(array: Float32Array, needed: number): Float32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 64);
  while (capacity < needed) capacity *= 2;
  const grown = new Float32Array(capacity);
  grown.set(array);
  return grown;
}

function growI32(array: Int32Array, needed: number): Int32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 64);
  while (capacity < needed) capacity *= 2;
  const grown = new Int32Array(capacity);
  grown.set(array);
  return grown;
}

/**
 * Copy every live unit's position/heading out of the world. Pure:
 * reads component rows only, writes only into the returned frame, and
 * touches neither DOM nor three.js. Call once per rendered frame AFTER
 * all step()s, before sampling interpolation.
 */
export function captureSimSnapshot(
  world: World,
  comps: MovementComponents,
  options: CaptureSnapshotOptions = {},
): SimSnapshotFrame {
  // Live units ⊆ entities, so sizing to entityCount up front means no
  // growth can trigger inside the capture loop.
  const entityCount = world.entities.length;
  const needed = Math.max(entityCount, 1);
  let eids = growI32(options.reusable?.eids ?? new Int32Array(0), needed);
  let positions = growF32(
    options.reusable?.positions ?? new Float32Array(0),
    entityCount * 2,
  );
  let headings = growF32(
    options.reusable?.headings ?? new Float32Array(0),
    needed,
  );

  const positionRows = world.rowsByComponentId.get(comps.positionId);
  const velocityRows = world.rowsByComponentId.get(comps.velocityId);

  let count = 0;
  // world.entities ascends by construction (spawn order); a linear walk
  // keeps the mirror's index order stable frame-to-frame.
  for (let i = 0; i < entityCount; i++) {
    const eid = world.entities[i]!;
    const posRow = positionRows?.get(eid);
    const velRow = velocityRows?.get(eid);
    if (!posRow || !velRow) continue; // not a movable unit
    eids[count] = eid;
    positions[count * 2] = posRow[0]!;
    positions[count * 2 + 1] = posRow[1]!;
    headings[count] = velRow[0]!; // Velocity row layout: headingRad first
    count++;
  }

  return { tick: world.tick, count, eids, positions, headings };
}

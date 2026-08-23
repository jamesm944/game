/**
 * Render-mirror snapshot producer — SPEC §2.1 seam / ADR-0001.
 *
 * The renderer never reaches into component rows; instead this PURE
 * module copies everything it needs into plain typed arrays AFTER each
 * step(). `render/` imports only this file (plus types), so the seam
 * stays one-directional: render reads, sim knows nothing of render.
 *
 * Frame layout is SoA, indexed by ascending-eid rank i (NOT by eid —
 * eids travel alongside for id-keyed overlays):
 *   positions[2i], positions[2i + 1]  → x,y float tile coordinates
 *   headings[i]                       → facing radians (Velocity row [0])
 *   hpFractions[i]                    → hp / maxHp clamped to [0,1]
 *                                       (M2-T6 health-bar overlay feed;
 *                                       units without a Combat row
 *                                       report a full bar)
 */

import type { SimComponents } from "./components";
import { combatDefOf, getCombatRow } from "./components/combat";
import { getBuildingRow, getBuildingSiteRow } from "./components/buildings";
import { buildingDefOf, buildingIdOfCode } from "../data/definitions";
import { WORK_MILLI_SCALE } from "./systems/construction";
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
  /** Health 0..1 per rank, capacity ≥ count (M2-T6 overlays). */
  readonly hpFractions: Float32Array;
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
 * Copy every live unit's position/heading/health out of the world.
 * Pure: reads component rows only, writes only into the returned frame,
 * and touches neither DOM nor three.js. Call once per rendered frame
 * AFTER all step()s, before sampling interpolation. Takes SimComponents
 * because the M2-T6 overlay feed reads Combat rows; callers without a
 * combat registry simply get full-health bars everywhere.
 */
export function captureSimSnapshot(
  world: World,
  comps: SimComponents,
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
  let hpFractions = growF32(
    options.reusable?.hpFractions ?? new Float32Array(0),
    needed,
  );

  const positionRows = world.rowsByComponentId.get(comps.positionId);
  const velocityRows = world.rowsByComponentId.get(comps.velocityId);
  // maxHp per def code, memoized per capture (codes are dense u8s).
  const maxHpByDefCode = new Map<number, number>();

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

    const combatRow = getCombatRow(world, comps, eid);
    let fraction = 1;
    if (combatRow) {
      const defCode = combatRow[0]!;
      let maxHp = maxHpByDefCode.get(defCode);
      if (maxHp === undefined) {
        maxHp = combatDefOf(world, comps, eid)!.hp;
        maxHpByDefCode.set(defCode, maxHp);
      }
      fraction = Math.min(1, Math.max(0, combatRow[2]! / maxHp));
    }
    hpFractions[count] = fraction;
    count++;
  }

  return { tick: world.tick, count, eids, positions, headings, hpFractions };
}

/**
 * One post-step frame of building state (M1-T10): construction sites
 * AND finished buildings, ascending eid. Pure — same seam discipline
 * as captureSimSnapshot; render reads this, never component rows.
 */
export interface BuildingSnapshotFrame {
  /** Live buildings/sites copied; arrays valid up to this count. */
  readonly count: number;
  readonly eids: Int32Array;
  /** Footprint origin tiles packed x,y per index. */
  readonly origins: Float32Array;
  /** Footprint width,height in tiles packed per index. */
  readonly sizes: Float32Array;
  /** 0 = construction site, 1 = finished building. */
  readonly states: Uint8Array;
  /** Build progress clamped to [0,1]; finished buildings report 1. */
  readonly progress: Float32Array;
}

export interface CaptureBuildingOptions {
  readonly reusable?: BuildingSnapshotFrame | undefined;
}

export function captureBuildingSnapshot(
  world: World,
  comps: SimComponents,
  options: CaptureBuildingOptions = {},
): BuildingSnapshotFrame {
  const entityCount = world.entities.length;
  const grow = (array: Float32Array, stride: number): Float32Array => {
    const needed = entityCount * stride;
    if (array.length >= Math.max(needed, 1)) return array;
    let capacity = Math.max(array.length, 64 * stride);
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(array);
    return grown;
  };
  let eids = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.eids ?? new Int32Array(0);
    if (array.length >= needed) return array;
    let capacity = Math.max(array.length, 64);
    while (capacity < needed) capacity *= 2;
    const grown = new Int32Array(capacity);
    grown.set(array);
    return grown;
  })();
  let origins = grow(options.reusable?.origins ?? new Float32Array(0), 2);
  let sizes = grow(options.reusable?.sizes ?? new Float32Array(0), 2);
  let states = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.states ?? new Uint8Array(0);
    if (array.length >= needed) return array;
    return new Uint8Array(Math.max(needed, 64));
  })();
  let progress = grow(options.reusable?.progress ?? new Float32Array(0), 1);

  let count = 0;
  for (let i = 0; i < entityCount; i++) {
    const eid = world.entities[i]!;
    const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!posRow) continue;
    const site = getBuildingSiteRow(world, comps, eid);
    const built = getBuildingRow(world, comps, eid);
    if (!site && !built) continue;
    const defCode = (site ?? built)![1]!;
    const def = buildingDefOf(buildingIdOfCode(defCode));
    const centerX = posRow[0]!;
    const centerY = posRow[1]!;
    const w = def.footprint.width;
    const h = def.footprint.height;

    eids[count] = eid;
    origins[count * 2] = centerX - w / 2;
    origins[count * 2 + 1] = centerY - h / 2;
    sizes[count * 2] = w;
    sizes[count * 2 + 1] = h;
    if (built) {
      states[count] = 1;
      progress[count] = 1;
    } else {
      states[count] = 0;
      const total = def.buildTime * WORK_MILLI_SCALE;
      progress[count] = Math.min(1, Math.max(0, site![2]! / total));
    }
    count++;
  }

  return {
    count,
    eids: eids.subarray(0, Math.max(count, 1)),
    origins,
    sizes,
    states: states.subarray(0, Math.max(count, 1)),
    progress,
  };
}

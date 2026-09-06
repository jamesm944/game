/**
 * Entity spatial hash — SPEC §2.13 picking support.
 *
 * PURE TypeScript (ADR-0001): plain map/array arithmetic over sim tile
 * coordinates — no DOM, no three.js, no wall-clock or randomness — so
 * the browser UI and headless node tests share one exact implementation
 * of "which entities are inside this world rect / near this point".
 *
 * The UI rebuilds a hash from the latest post-step snapshot whenever an
 * interaction needs it (a few hundred inserts is nothing at interaction
 * rate); queries are allocation-light and return eids in ascending
 * order so results are deterministic regardless of insertion order.
 */

/**
 * Hash cell edge in tiles. Same value as the movement system's
 * per-tick steering hash (SPEC §2.2) so tuning stays in one family.
 */
export const PICK_HASH_CELL = 2;

/** Grids are ≤ 4096 cells across at this cell size; key = cx·4096+cy. */
const CELL_KEY_STRIDE = 4096;

function cellKey(cx: number, cy: number): number {
  return cx * CELL_KEY_STRIDE + cy;
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

export interface EntitySpatialHash {
  /** Entities inserted so far. */
  readonly count: number;
  /** Register one entity position during build (ignored if non-finite). */
  insert(eid: number, x: number, y: number): void;
  /**
   * Eids whose position lies inside the CLOSED rectangle
   * [minX..maxX] × [minY..maxY], ascending, fresh array.
   */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): number[];
  /**
   * The closest entity to (x, y) within `radius` tiles (inclusive),
   * or undefined when none qualifies. Exact-distance ties resolve to
   * the lower eid.
   */
  nearest(
    x: number,
    y: number,
    radius: number,
    minRadius?: number,
  ): { eid: number; distSq: number } | undefined;
}

export function createEntitySpatialHash(): EntitySpatialHash {
  /** Entry index → parallel SoA storage. */
  const eids: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  /** Cell key → entry indices whose position falls in that cell. */
  const cells = new Map<number, number[]>();

  const insert = (eid: number, x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const index = eids.length;
    eids.push(eid);
    xs.push(x);
    ys.push(y);
    const key = cellKey(
      floorDiv(x, PICK_HASH_CELL),
      floorDiv(y, PICK_HASH_CELL),
    );
    const bucket = cells.get(key);
    if (bucket) bucket.push(index);
    else cells.set(key, [index]);
  };

  const queryRect = (
    minXInput: number,
    minYInput: number,
    maxXInput: number,
    maxYInput: number,
  ): number[] => {
    // Normalize inverted corners so marquee drags in any direction work.
    const minX = Math.min(minXInput, maxXInput);
    const maxX = Math.max(minXInput, maxXInput);
    const minY = Math.min(minYInput, maxYInput);
    const maxY = Math.max(minYInput, maxYInput);

    const hits: number[] = [];
    for (
      let cy = floorDiv(minY, PICK_HASH_CELL);
      cy <= floorDiv(maxY, PICK_HASH_CELL);
      cy++
    ) {
      for (
        let cx = floorDiv(minX, PICK_HASH_CELL);
        cx <= floorDiv(maxX, PICK_HASH_CELL);
        cx++
      ) {
        const bucket = cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        // Each entry lives in exactly one cell, so candidates are unique.
        for (const index of bucket) {
          const x = xs[index]!;
          const y = ys[index]!;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
            hits.push(eids[index]!);
          }
        }
      }
    }
    hits.sort((a, b) => a - b);
    return hits;
  };

  const nearest = (
    x: number,
    y: number,
    radius: number,
    minRadius = 0,
  ): { eid: number; distSq: number } | undefined => {
    if (!(radius >= 0)) return undefined;
    const radiusSq = radius * radius;
    const minRadiusSq = minRadius > 0 ? minRadius * minRadius : 0;
    let bestEid: number | undefined;
    let bestDistSq = Infinity;
    for (
      let cy = floorDiv(y - radius, PICK_HASH_CELL);
      cy <= floorDiv(y + radius, PICK_HASH_CELL);
      cy++
    ) {
      for (
        let cx = floorDiv(x - radius, PICK_HASH_CELL);
        cx <= floorDiv(x + radius, PICK_HASH_CELL);
        cx++
      ) {
        const bucket = cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const index of bucket) {
          const dx = xs[index]! - x;
          const dy = ys[index]! - y;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq || distSq < minRadiusSq) continue;
          const eid = eids[index]!;
          if (
            distSq < bestDistSq ||
            (distSq === bestDistSq && (bestEid === undefined || eid < bestEid))
          ) {
            bestDistSq = distSq;
            bestEid = eid;
          }
        }
      }
    }
    return bestEid === undefined
      ? undefined
      : { eid: bestEid, distSq: bestDistSq };
  };

  return {
    get count(): number {
      return eids.length;
    },
    insert,
    queryRect,
    nearest,
  };
}

/** Minimal snapshot-shaped input (structurally SimSnapshotFrame). */
interface SnapshotPositions {
  readonly count: number;
  readonly eids: Int32Array;
  readonly positions: Float32Array;
}

/**
 * Build a hash over one post-step snapshot's live unit positions
 * (positions are packed x,y pairs aligned with eids by rank).
 */
export function buildEntitySpatialHash(
  frame: SnapshotPositions,
): EntitySpatialHash {
  const hash = createEntitySpatialHash();
  for (let i = 0; i < frame.count; i++) {
    hash.insert(
      frame.eids[i]!,
      frame.positions[i * 2]!,
      frame.positions[i * 2 + 1]!,
    );
  }
  return hash;
}

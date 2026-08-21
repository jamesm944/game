/**
 * Octile 8-direction grid A* — SPEC §2.2 / ADR-0003 phase 1.
 *
 * Pure exported functions: the search is a function of its request
 * contents only (passability snapshot + start/goal + optional seeded
 * PRNG), so golden tests run it headless and the future worker wraps it
 * unchanged. Costs are integers ×1000 (straight 1000, diagonal 1414) —
 * no float drift. The binary heap ties break on (f, insertionCounter)
 * and neighbors expand in a fixed clockwise order, making the search
 * fully canonical; the `rng` parameter exists for protocol uniformity
 * with the worker contract and is intentionally not drawn by the
 * canonical search.
 */

import type { Prng } from "../core/prng";

export const PATH_STRAIGHT_COST = 1000;
export const PATH_DIAGONAL_COST = 1414;
const NO_G_SCORE = 0x7fffffff;

/** Clockwise from east — pinned expansion order (ADR-0003). */
const NEIGHBOR_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const NEIGHBOR_DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

export interface PathRequest {
  /** Flat row-major passability grid, length width·height; 1 = walkable. */
  readonly passability: Uint8Array;
  /** Grid edge in tiles; height is derived as length ÷ width. */
  readonly width: number;
  /** Start tile x (column). */
  readonly startX: number;
  readonly startY: number;
  /** Goal tile x/y. */
  readonly goalX: number;
  readonly goalY: number;
  /**
   * Seeded PRNG reserved for tie-breaking randomness. The canonical
   * heap ordering already total-orders expansion deterministically,
   * so nothing draws from it today; workers still pass their request
   * seed here to keep call sites protocol-identical.
   */
  readonly rng?: Prng | undefined;
}

export interface PathResult {
  /**
   * String-pulled waypoints, flat [x0,y0,x1,y1,…], tile coordinates
   * (Int16), always beginning at the start tile and ending at the goal.
   */
  readonly waypoints: Int16Array;
  /** Exact optimal integer cost of the raw path (×1000 units). */
  readonly cost: number;
}

interface HeapItem {
  node: number;
  f: number;
  counter: number;
}

/** Binary min-heap ordered by (f, insertionCounter). */
class MinHeap {
  #items: HeapItem[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(item: HeapItem): void {
    const items = this.#items;
    items.push(item);
    let child = items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.#before(items[child]!, items[parent]!)) break;
      [items[child], items[parent]] = [items[parent]!, items[child]!];
      child = parent;
    }
  }

  pop(): HeapItem | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let best = parent;
        if (left < items.length && this.#before(items[left]!, items[best]!)) {
          best = left;
        }
        if (right < items.length && this.#before(items[right]!, items[best]!)) {
          best = right;
        }
        if (best === parent) break;
        [items[parent], items[best]] = [items[best]!, items[parent]!];
        parent = best;
      }
    }
    return top;
  }

  #before(a: HeapItem, b: HeapItem): boolean {
    return a.f < b.f || (a.f === b.f && a.counter < b.counter);
  }
}

/** Octile distance ×1000 between two tiles (admissible heuristic). */
export function octileHeuristic(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (
    PATH_STRAIGHT_COST * (dx + dy) +
    (PATH_DIAGONAL_COST - 2 * PATH_STRAIGHT_COST) * Math.min(dx, dy)
  );
}

function requireGrid(passability: Uint8Array, width: number): number {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(
      `path grid width must be a positive integer, got ${String(width)}`,
    );
  }
  if (passability.length % width !== 0 || passability.length === 0) {
    throw new Error(
      `passability length ${String(passability.length)} is not a multiple of width ${String(width)}`,
    );
  }
  return passability.length / width;
}

function requireCoord(
  value: number,
  label: string,
  max: number,
  gridLabel: string,
): void {
  if (!Number.isInteger(value) || value < 0 || value >= max) {
    throw new Error(`${label} out of range (${gridLabel}): ${String(value)}`);
  }
}

function requireStartGoal(
  request: { startX: number; startY: number; goalX: number; goalY: number },
  width: number,
  height: number,
): void {
  const dims = `grid ${String(width)}×${String(height)}`;
  requireCoord(request.startX, "startX", width, dims);
  requireCoord(request.startY, "startY", height, dims);
  requireCoord(request.goalX, "goalX", width, dims);
  requireCoord(request.goalY, "goalY", height, dims);
}

/**
 * True when every tile touched by the straight segment between two tile
 * centers is passable, including both orthogonal neighbors whenever the
 * segment crosses a grid corner diagonally (no corner clipping).
 */
export function hasLineOfSight(
  passability: Uint8Array,
  width: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const height = requireGrid(passability, width);
  const dims = `grid ${String(width)}×${String(height)}`;
  requireCoord(ax, "ax", width, dims);
  requireCoord(ay, "ay", height, dims);
  requireCoord(bx, "bx", width, dims);
  requireCoord(by, "by", height, dims);
  // Integer supercover walk: advance whichever axis lags, stepping one
  // tile at a time from (ax,ay) toward (bx,by).
  let x = ax;
  let y = ay;
  const dx = bx - x;
  const dy = by - y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  let remainingX = Math.abs(dx);
  let remainingY = Math.abs(dy);
  for (;;) {
    if (passability[y * width + x] !== 1) return false;
    if (x === bx && y === by) return true;
    if (remainingX === 0) {
      y += sy;
      remainingY -= 1;
      continue;
    }
    if (remainingY === 0) {
      x += sx;
      remainingX -= 1;
      continue;
    }
    // Corner crossing: diagonal step needs both orthogonal tiles open.
    if (
      passability[y * width + (x + sx)] !== 1 ||
      passability[(y + sy) * width + x] !== 1
    ) {
      return false;
    }
    x += sx;
    y += sy;
    remainingX -= 1;
    remainingY -= 1;
  }
}

/**
 * Greedy string-pull over the raw tile path: repeatedly jump to the
 * farthest waypoint visible from the anchor, producing sparse straight
 * segments (ADR-0003).
 */
function stringPull(
  passability: Uint8Array,
  width: number,
  raw: number[],
): Int16Array {
  const anchors: number[] = [];
  let anchorIndex = 0;
  anchors.push(raw[0]!, raw[1]!);
  while (anchorIndex < raw.length / 2 - 1) {
    let next = anchorIndex + 1;
    for (let probe = raw.length / 2 - 1; probe > next; probe--) {
      if (
        hasLineOfSight(
          passability,
          width,
          raw[anchorIndex * 2]!,
          raw[anchorIndex * 2 + 1]!,
          raw[probe * 2]!,
          raw[probe * 2 + 1]!,
        )
      ) {
        next = probe;
        break;
      }
    }
    anchors.push(raw[next * 2]!, raw[next * 2 + 1]!);
    anchorIndex = next;
  }
  return Int16Array.from(anchors);
}

/**
 * Run one octile A* search. Returns `null` when start/goal are off-grid
 * or impassable, or when no route exists (open set exhausted).
 */
export function findPath(request: PathRequest): PathResult | null {
  const { passability, width, startX, startY, goalX, goalY } = request;
  const height = requireGrid(passability, width);
  requireStartGoal(request, width, height);

  const startIndex = startY * width + startX;
  const goalIndex = goalY * width + goalX;
  if (passability[startIndex] !== 1 || passability[goalIndex] !== 1) {
    return null;
  }
  if (startIndex === goalIndex) {
    return {
      waypoints: Int16Array.from([startX, startY]),
      cost: 0,
    };
  }

  const nodeCount = width * height;
  const gScore = new Float64Array(nodeCount).fill(NO_G_SCORE);
  const parent = new Int32Array(nodeCount).fill(-1);
  const closed = new Uint8Array(nodeCount);
  const heap = new MinHeap();
  let insertionCounter = 0;

  gScore[startIndex] = 0;
  heap.push({
    node: startIndex,
    f: octileHeuristic(startX, startY, goalX, goalY),
    counter: insertionCounter++,
  });

  while (heap.size > 0) {
    const current = heap.pop()!;
    const node = current.node;
    if (closed[node]) continue;
    closed[node] = 1;
    if (node === goalIndex) {
      // Reconstruct the raw tile path, then string-pull it.
      const nodes: number[] = [];
      for (let n = goalIndex; n !== -1; n = parent[n]!) nodes.push(n);
      nodes.reverse();
      const raw: number[] = [];
      for (const n of nodes) raw.push(n % width, Math.floor(n / width));
      const optimalCost = gScore[goalIndex]!;
      return {
        waypoints: stringPull(passability, width, raw),
        cost: optimalCost,
      };
    }
    const nx = node % width;
    const ny = Math.floor(node / width);
    for (let dir = 0; dir < 8; dir++) {
      const mx = nx + NEIGHBOR_DX[dir]!;
      const my = ny + NEIGHBOR_DY[dir]!;
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      if (passability[my * width + mx] !== 1) continue;
      const diagonal = NEIGHBOR_DX[dir] !== 0 && NEIGHBOR_DY[dir] !== 0;
      if (
        diagonal &&
        (passability[ny * width + mx] !== 1 ||
          passability[my * width + nx] !== 1)
      ) {
        continue; // never squeeze between two blocked orthogonal tiles
      }
      const stepCost = diagonal ? PATH_DIAGONAL_COST : PATH_STRAIGHT_COST;
      const tentativeG = gScore[node]! + stepCost;
      const neighbor = my * width + mx;
      if (tentativeG < gScore[neighbor]!) {
        gScore[neighbor] = tentativeG;
        parent[neighbor] = node;
        heap.push({
          node: neighbor,
          f: tentativeG + octileHeuristic(mx, my, goalX, goalY),
          counter: insertionCounter++,
        });
      }
    }
  }
  return null; // exhausted: unreachable goal
}

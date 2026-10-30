/**
 * Deterministic reverse-Dijkstra flow fields for binary octile grids.
 *
 * Integration costs are integers matching production A* (straight 1000,
 * diagonal 1414). Directions are raw tile steps, not string-pulled paths.
 * This module is a benchmark candidate; it has no worker or steering code.
 */

export const FLOW_STRAIGHT_COST = 1000;
export const FLOW_DIAGONAL_COST = 1414;
export const FLOW_UNREACHABLE = 0x7fffffff;
export const FLOW_UNREACHABLE_DIRECTION = -1;
export const FLOW_AT_GOAL = -2;

/** Clockwise from east, identical to src/sim/path/astar.ts. */
export const FLOW_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const FLOW_DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

export interface FlowTile {
  readonly x: number;
  readonly y: number;
}

export interface FlowFieldRequest {
  /** Row-major binary grid; exactly 1 is walkable, every other value blocks. */
  readonly passability: Uint8Array;
  readonly width: number;
  /** One or more in-bounds destinations. Blocked destinations are ignored. */
  readonly goals: readonly FlowTile[];
  /** Caller-supplied passability revision, copied into the immutable field. */
  readonly revision?: number;
}

export interface FlowRoute {
  /** Raw row-major tile indices from start through the reached goal. */
  readonly tiles: Int32Array;
  /** Exact raw route cost, equal to integration cost at the start. */
  readonly cost: number;
}

interface HeapItem {
  node: number;
  cost: number;
  counter: number;
}

/** Min-heap ordered by (integration cost, insertion counter). */
class MinHeap {
  readonly #items: HeapItem[] = [];

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
    return a.cost < b.cost || (a.cost === b.cost && a.counter < b.counter);
  }
}

function gridHeight(passability: Uint8Array, width: number): number {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`flow grid width must be a positive integer: ${String(width)}`);
  }
  if (passability.length === 0 || passability.length % width !== 0) {
    throw new Error(
      `passability length ${String(passability.length)} is not a multiple of width ${String(width)}`,
    );
  }
  const cellCount = passability.length;
  if ((cellCount - 1) * FLOW_DIAGONAL_COST >= FLOW_UNREACHABLE) {
    throw new Error("flow grid is too large for the integer unreachable sentinel");
  }
  return cellCount / width;
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`flow revision must be a nonnegative safe integer: ${String(revision)}`);
  }
}

function canonicalGoals(
  goals: readonly FlowTile[],
  width: number,
  height: number,
): number[] {
  if (goals.length === 0) throw new Error("flow field requires at least one goal");
  const unique = new Set<number>();
  for (const goal of goals) {
    if (
      !Number.isInteger(goal.x) ||
      !Number.isInteger(goal.y) ||
      goal.x < 0 ||
      goal.x >= width ||
      goal.y < 0 ||
      goal.y >= height
    ) {
      throw new Error(`flow goal out of range: (${String(goal.x)},${String(goal.y)})`);
    }
    unique.add(goal.y * width + goal.x);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

/** Immutable integration/direction arrays for one grid snapshot and goal set. */
export class FlowField {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  /** Canonical row-major goal indices, including blocked goals. */
  readonly goals: Int32Array;
  readonly integration: Int32Array;
  /** Per tile: 0..7 clockwise direction, -1 unreachable, -2 at a goal. */
  readonly directions: Int8Array;

  constructor(
    width: number,
    height: number,
    revision: number,
    goals: readonly number[],
    integration: Int32Array,
    directions: Int8Array,
  ) {
    this.width = width;
    this.height = height;
    this.revision = revision;
    this.goals = Int32Array.from(goals);
    this.integration = integration;
    this.directions = directions;
  }

  /** O(1); returns FLOW_UNREACHABLE for blocked or disconnected tiles. */
  costAt(x: number, y: number): number {
    return this.integration[this.#index(x, y)]!;
  }

  /** O(1); returns -1 for unreachable and -2 when standing on any goal. */
  directionAt(x: number, y: number): number {
    return this.directions[this.#index(x, y)]!;
  }

  /**
   * Follow raw directions to a goal. O(route tiles) time and space; returns
   * null for blocked/unreachable starts. No smoothing or collision avoidance.
   */
  traceRoute(x: number, y: number): FlowRoute | null {
    const start = this.#index(x, y);
    const cost = this.integration[start]!;
    if (cost === FLOW_UNREACHABLE) return null;
    const route: number[] = [start];
    let current = start;
    // A correct integration field strictly descends. The bound also makes a
    // corrupted field fail explicitly rather than looping forever.
    for (let steps = 0; this.directions[current]! >= 0; steps++) {
      if (steps >= this.integration.length) {
        throw new Error("flow route exceeded grid cell count");
      }
      const direction = this.directions[current]!;
      const cx = current % this.width;
      const cy = Math.floor(current / this.width);
      const next = (cy + FLOW_DY[direction]!) * this.width + cx + FLOW_DX[direction]!;
      route.push(next);
      current = next;
    }
    if (this.directions[current] !== FLOW_AT_GOAL) {
      throw new Error("flow route terminated away from a goal");
    }
    return { tiles: Int32Array.from(route), cost };
  }

  #index(x: number, y: number): number {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= this.width ||
      y < 0 ||
      y >= this.height
    ) {
      throw new Error(`flow coordinate out of range: (${String(x)},${String(y)})`);
    }
    return y * this.width + x;
  }
}

/**
 * Build one field. Reverse Dijkstra is O(V log V + E log V) with a binary
 * heap (E ≤ 8V), plus O(V) direction extraction; memory is O(V). Seeding all
 * goals at zero computes the nearest-goal cost for every reachable tile.
 */
export function buildFlowField(request: FlowFieldRequest): FlowField {
  const { passability, width } = request;
  const height = gridHeight(passability, width);
  const revision = request.revision ?? 0;
  requireRevision(revision);
  const goals = canonicalGoals(request.goals, width, height);
  const cellCount = passability.length;
  const integration = new Int32Array(cellCount).fill(FLOW_UNREACHABLE);
  const directions = new Int8Array(cellCount).fill(FLOW_UNREACHABLE_DIRECTION);
  const heap = new MinHeap();
  let insertionCounter = 0;

  for (const goal of goals) {
    if (passability[goal] !== 1) continue;
    integration[goal] = 0;
    directions[goal] = FLOW_AT_GOAL;
    heap.push({ node: goal, cost: 0, counter: insertionCounter++ });
  }

  while (heap.size > 0) {
    const current = heap.pop()!;
    const node = current.node;
    if (current.cost !== integration[node]) continue; // stale heap entry
    const x = node % width;
    const y = Math.floor(node / width);
    for (let direction = 0; direction < 8; direction++) {
      const dx = FLOW_DX[direction]!;
      const dy = FLOW_DY[direction]!;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (passability[neighbor] !== 1) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (
        diagonal &&
        (passability[y * width + nx] !== 1 || passability[ny * width + x] !== 1)
      ) {
        continue;
      }
      const stepCost = diagonal ? FLOW_DIAGONAL_COST : FLOW_STRAIGHT_COST;
      const candidate = current.cost + stepCost;
      if (candidate < integration[neighbor]!) {
        integration[neighbor] = candidate;
        heap.push({ node: neighbor, cost: candidate, counter: insertionCounter++ });
      }
    }
  }

  // Strict descent guarantees termination. Equal-cost alternatives resolve
  // to the first clockwise direction, independently of heap insertion order.
  for (let node = 0; node < cellCount; node++) {
    const cost = integration[node]!;
    if (cost === FLOW_UNREACHABLE || cost === 0) continue;
    const x = node % width;
    const y = Math.floor(node / width);
    for (let direction = 0; direction < 8; direction++) {
      const dx = FLOW_DX[direction]!;
      const dy = FLOW_DY[direction]!;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      const diagonal = dx !== 0 && dy !== 0;
      if (
        diagonal &&
        (passability[y * width + nx] !== 1 || passability[ny * width + x] !== 1)
      ) {
        continue;
      }
      const stepCost = diagonal ? FLOW_DIAGONAL_COST : FLOW_STRAIGHT_COST;
      if (integration[neighbor]! + stepCost === cost) {
        directions[node] = direction;
        break;
      }
    }
    if (directions[node]! < 0) throw new Error(`reachable tile has no descent: ${String(node)}`);
  }

  return new FlowField(width, height, revision, goals, integration, directions);
}

function goalKey(goals: Int32Array): string {
  return Array.from(goals).join(",");
}

/**
 * Small deterministic LRU for shared destinations. Canonicalizing G goals
 * costs O(G log G); a miss additionally builds in O(V log V), while a hit
 * performs expected O(G) map work after canonicalization. A revision update
 * copies the new snapshot and invalidates every old field; stale in-flight
 * fields remain immutable but must not be applied to the new revision.
 */
export class FlowFieldCache {
  readonly maxEntries: number;
  #passability: Uint8Array;
  readonly width: number;
  readonly height: number;
  #revision: number;
  readonly #fields = new Map<string, FlowField>();

  constructor(passability: Uint8Array, width: number, revision = 0, maxEntries = 32) {
    this.height = gridHeight(passability, width);
    requireRevision(revision);
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`flow cache maxEntries must be positive: ${String(maxEntries)}`);
    }
    this.width = width;
    this.maxEntries = maxEntries;
    this.#revision = revision;
    this.#passability = passability.slice();
  }

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#fields.size;
  }

  /** Goal order and duplicates do not affect cache identity or output. */
  getField(goals: readonly FlowTile[]): FlowField {
    const normalized = canonicalGoals(goals, this.width, this.height);
    const key = goalKey(Int32Array.from(normalized));
    const cached = this.#fields.get(key);
    if (cached !== undefined) {
      this.#fields.delete(key);
      this.#fields.set(key, cached);
      return cached;
    }
    const field = buildFlowField({
      passability: this.#passability,
      width: this.width,
      goals: normalized.map((node) => ({ x: node % this.width, y: Math.floor(node / this.width) })),
      revision: this.#revision,
    });
    this.#fields.set(key, field);
    if (this.#fields.size > this.maxEntries) {
      const oldest = this.#fields.keys().next().value;
      if (oldest !== undefined) this.#fields.delete(oldest);
    }
    return field;
  }

  /** O(snapshot size + cached fields) invalidation; revisions must increase. */
  updatePassability(passability: Uint8Array, revision: number): void {
    const height = gridHeight(passability, this.width);
    if (height !== this.height) {
      throw new Error("flow cache cannot change grid height; construct a new cache");
    }
    requireRevision(revision);
    if (revision <= this.#revision) {
      throw new Error(`flow revision must increase beyond ${String(this.#revision)}`);
    }
    this.#passability = passability.slice();
    this.#revision = revision;
    this.#fields.clear();
  }
}

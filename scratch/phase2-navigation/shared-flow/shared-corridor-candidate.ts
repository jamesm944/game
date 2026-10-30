import { findPath, hasLineOfSight, octileHeuristic, PATH_DIAGONAL_COST, PATH_STRAIGHT_COST } from "../../../src/sim/path/astar";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { buildFlowField, type FlowField } from "../../full-game-movement/flow-field/flow-field";
import type { CandidateContext, MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import type { MockDelayScript } from "../../full-game-movement/harness/candidates";

export const SHARED_REGION_TILES = 24;
export const SHARED_FIELD_CAPACITY = 32;

interface RegionAnchor {
  readonly region: number;
  readonly anchor: number;
}

interface CorridorMetrics {
  fieldsBuilt: number;
  cacheHits: number;
  cacheMisses: number;
  staleSnapshotBuilds: number;
  cacheInvalidations: number;
  corridorRoutes: number;
  directFallbacks: number;
  unreachableRoutes: number;
  localSearches: number;
  zeroLengthLocalSearches: number;
  fullAstarFallbackSearches: number;
  corridorHandoffTiles: number;
  localRawCosts: number;
  routeTilesBeforePull: number;
  responseWaypoints: number;
  totalFieldBuildMs: number;
  maxFieldBuildMs: number;
  totalCorridorTraceMs: number;
  totalLocalSearchMs: number;
  maxLocalSearchMs: number;
  totalFallbackSearchMs: number;
  totalRouteComposeMs: number;
  responseWaypointBytes: number;
  peakCachedFields: number;
  peakCachedFieldBytes: number;
}

function initialMetrics(): CorridorMetrics {
  return {
    fieldsBuilt: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleSnapshotBuilds: 0,
    cacheInvalidations: 0,
    corridorRoutes: 0,
    directFallbacks: 0,
    unreachableRoutes: 0,
    localSearches: 0,
    zeroLengthLocalSearches: 0,
    fullAstarFallbackSearches: 0,
    corridorHandoffTiles: 0,
    localRawCosts: 0,
    routeTilesBeforePull: 0,
    responseWaypoints: 0,
    totalFieldBuildMs: 0,
    maxFieldBuildMs: 0,
    totalCorridorTraceMs: 0,
    totalLocalSearchMs: 0,
    maxLocalSearchMs: 0,
    totalFallbackSearchMs: 0,
    totalRouteComposeMs: 0,
    responseWaypointBytes: 0,
    peakCachedFields: 0,
    peakCachedFieldBytes: 0,
  };
}

function failed(request: PathRequest): PathResponse {
  return { kind: "path", id: request.id, ok: false, waypoints: new Int16Array(0), cost: 0 };
}

function regionForGoal(goalX: number, goalY: number, width: number): number {
  const rx = Math.floor(goalX / SHARED_REGION_TILES);
  const ry = Math.floor(goalY / SHARED_REGION_TILES);
  return ry * Math.ceil(width / SHARED_REGION_TILES) + rx;
}

/** Deterministic nearest-to-region-center passable tile; ties use row-major index. */
export function canonicalRegionAnchor(passability: Uint8Array, width: number, goalX: number, goalY: number): RegionAnchor {
  const height = passability.length / width;
  const region = regionForGoal(goalX, goalY, width);
  const rx = Math.floor(goalX / SHARED_REGION_TILES);
  const ry = Math.floor(goalY / SHARED_REGION_TILES);
  const minX = rx * SHARED_REGION_TILES;
  const minY = ry * SHARED_REGION_TILES;
  const maxX = Math.min(width, minX + SHARED_REGION_TILES);
  const maxY = Math.min(height, minY + SHARED_REGION_TILES);
  const centerX = Math.min(width - 1, minX + Math.floor(SHARED_REGION_TILES / 2));
  const centerY = Math.min(height - 1, minY + Math.floor(SHARED_REGION_TILES / 2));
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const node = y * width + x;
      if (passability[node] !== 1) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
  }
  if (best < 0) throw new Error("passable exact goal implies a passable region anchor");
  return { region, anchor: best };
}

/** Production-equivalent greedy string pull over an already legal tile sequence. */
export function pullLegalRoute(passability: Uint8Array, width: number, tiles: readonly number[]): Int16Array {
  const pulled: number[] = [tiles[0]! % width, Math.floor(tiles[0]! / width)];
  let anchor = 0;
  while (anchor < tiles.length - 1) {
    let next = anchor + 1;
    const ax = tiles[anchor]! % width;
    const ay = Math.floor(tiles[anchor]! / width);
    for (let probe = tiles.length - 1; probe > next; probe -= 1) {
      const bx = tiles[probe]! % width;
      const by = Math.floor(tiles[probe]! / width);
      if (hasLineOfSight(passability, width, ax, ay, bx, by)) {
        next = probe;
        break;
      }
    }
    pulled.push(tiles[next]! % width, Math.floor(tiles[next]! / width));
    anchor = next;
  }
  return Int16Array.from(pulled);
}

/**
 * Exact-slot hybrid: a region-shared field supplies only the corridor prefix.
 * Production A* explicitly supplies the handoff→requested-slot suffix. If the
 * canonical anchor is disconnected or the suffix fails, full production A*
 * from the original start is the measured correctness fallback.
 */
export class SharedCorridorRouteEngine {
  readonly metrics = initialMetrics();
  #cache = new Map<number, FlowField>();
  #passability: Uint8Array | undefined;
  #revision = -1;
  #width = 0;
  #fieldBytes = 0;

  handle(request: PathRequest, now: () => number): PathResponse {
    const width = Math.sqrt(request.passable.length);
    if (!Number.isInteger(width)) throw new Error("shared-corridor request grid must be square");
    this.#width = width;
    this.#fieldBytes = request.passable.length * 5;
    if (!this.#passability) {
      this.#passability = request.passable.slice();
      this.#revision = request.passableVersion;
    } else if (request.passableVersion > this.#revision) {
      this.#passability = request.passable.slice();
      this.#revision = request.passableVersion;
      this.#cache.clear();
      this.metrics.cacheInvalidations += 1;
    }

    const { region } = canonicalRegionAnchor(request.passable, width, request.goalX, request.goalY);
    let field: FlowField;
    if (request.passableVersion < this.#revision) {
      field = this.#build(request, width, true, now);
    } else {
      const cached = this.#cache.get(region);
      if (cached) {
        this.#cache.delete(region);
        this.#cache.set(region, cached);
        this.metrics.cacheHits += 1;
        field = cached;
      } else {
        this.metrics.cacheMisses += 1;
        field = this.#build(request, width, false, now);
        this.#cache.set(region, field);
        if (this.#cache.size > SHARED_FIELD_CAPACITY) {
          const oldest = this.#cache.keys().next().value;
          if (oldest !== undefined) this.#cache.delete(oldest);
        }
      }
    }
    this.metrics.peakCachedFields = Math.max(this.metrics.peakCachedFields, this.#cache.size);
    this.metrics.peakCachedFieldBytes = Math.max(this.metrics.peakCachedFieldBytes, this.#cache.size * this.#fieldBytes);
    return this.#route(request, field, now);
  }

  #build(request: PathRequest, width: number, stale: boolean, now: () => number): FlowField {
    const { anchor } = canonicalRegionAnchor(request.passable, width, request.goalX, request.goalY);
    const started = now();
    const field = buildFlowField({
      passability: request.passable,
      width,
      goals: [{ x: anchor % width, y: Math.floor(anchor / width) }],
      revision: request.passableVersion,
    });
    const elapsed = now() - started;
    this.metrics.fieldsBuilt += 1;
    if (stale) this.metrics.staleSnapshotBuilds += 1;
    this.metrics.totalFieldBuildMs += elapsed;
    this.metrics.maxFieldBuildMs = Math.max(this.metrics.maxFieldBuildMs, elapsed);
    return field;
  }

  #route(request: PathRequest, field: FlowField, now: () => number): PathResponse {
    const width = this.#width;
    const traceStarted = now();
    const corridor = field.traceRoute(request.startX, request.startY);
    this.metrics.totalCorridorTraceMs += now() - traceStarted;
    if (!corridor || corridor.tiles.length === 0) return this.#fallback(request, now);

    // Minimize exact prefix + admissible octile suffix estimate. On equal
    // estimates take the later handoff so the shared corridor does real work
    // and the measured exact suffix is shorter; correctness never depends on it.
    let handoff = 0;
    let prefixCost = 0;
    let bestScore = octileHeuristic(request.startX, request.startY, request.goalX, request.goalY);
    let runningCost = 0;
    for (let index = 1; index < corridor.tiles.length; index += 1) {
      const previous = corridor.tiles[index - 1]!;
      const tile = corridor.tiles[index]!;
      const dx = Math.abs(tile % width - previous % width);
      const dy = Math.abs(Math.floor(tile / width) - Math.floor(previous / width));
      runningCost += dx !== 0 && dy !== 0 ? PATH_DIAGONAL_COST : PATH_STRAIGHT_COST;
      const x = tile % width;
      const y = Math.floor(tile / width);
      const score = runningCost + octileHeuristic(x, y, request.goalX, request.goalY);
      if (score <= bestScore) {
        bestScore = score;
        handoff = index;
        prefixCost = runningCost;
      }
    }

    const handoffTile = corridor.tiles[handoff]!;
    const handoffX = handoffTile % width;
    const handoffY = Math.floor(handoffTile / width);
    const localStarted = now();
    const local = findPath({
      passability: request.passable,
      width,
      startX: handoffX,
      startY: handoffY,
      goalX: request.goalX,
      goalY: request.goalY,
    });
    const localMs = now() - localStarted;
    this.metrics.localSearches += 1;
    this.metrics.totalLocalSearchMs += localMs;
    this.metrics.maxLocalSearchMs = Math.max(this.metrics.maxLocalSearchMs, localMs);
    if (handoffTile === request.goalY * width + request.goalX) this.metrics.zeroLengthLocalSearches += 1;
    if (!local) return this.#fallback(request, now);

    const composeStarted = now();
    const tiles: number[] = [];
    for (let index = 0; index <= handoff; index += 1) tiles.push(corridor.tiles[index]!);
    for (let index = 2; index < local.waypoints.length; index += 2) {
      tiles.push(local.waypoints[index + 1]! * width + local.waypoints[index]!);
    }
    const waypoints = tiles.length === 1
      ? Int16Array.from([request.startX, request.startY])
      : pullLegalRoute(request.passable, width, tiles);
    // The protocol endpoint is the exact requested integer slot tile, never
    // the canonical region anchor. Production repath applies sub-tile offsets.
    waypoints[waypoints.length - 2] = request.goalX;
    waypoints[waypoints.length - 1] = request.goalY;
    this.metrics.totalRouteComposeMs += now() - composeStarted;
    this.metrics.corridorRoutes += 1;
    this.metrics.corridorHandoffTiles += handoff;
    this.metrics.localRawCosts += local.cost;
    this.metrics.routeTilesBeforePull += tiles.length;
    this.metrics.responseWaypoints += waypoints.length / 2;
    this.metrics.responseWaypointBytes += waypoints.byteLength;
    return { kind: "path", id: request.id, ok: true, waypoints, cost: prefixCost + local.cost };
  }

  #fallback(request: PathRequest, now: () => number): PathResponse {
    const started = now();
    const response = findPath({
      passability: request.passable,
      width: this.#width,
      startX: request.startX,
      startY: request.startY,
      goalX: request.goalX,
      goalY: request.goalY,
    });
    this.metrics.totalFallbackSearchMs += now() - started;
    this.metrics.fullAstarFallbackSearches += 1;
    this.metrics.directFallbacks += 1;
    if (!response) {
      this.metrics.unreachableRoutes += 1;
      return failed(request);
    }
    this.metrics.responseWaypoints += response.waypoints.length / 2;
    this.metrics.responseWaypointBytes += response.waypoints.byteLength;
    return { kind: "path", id: request.id, ok: true, waypoints: response.waypoints, cost: response.cost };
  }

  candidateMetrics(mockInFlight = 0): Readonly<Record<string, number | string | boolean>> {
    const hitTotal = this.metrics.cacheHits + this.metrics.cacheMisses;
    return {
      integration: "region-shared-corridor-plus-explicit-exact-slot-astar-suffix",
      ...this.metrics,
      cacheHitRate: hitTotal === 0 ? 0 : this.metrics.cacheHits / hitTotal,
      cachedFields: this.#cache.size,
      cachedFieldBytes: this.#cache.size * this.#fieldBytes,
      regionTiles: SHARED_REGION_TILES,
      fieldCapacity: SHARED_FIELD_CAPACITY,
      fieldTransferBytes: 0,
      transferModel: "exact-route-waypoints-only-no-browser-structured-clone",
      mockInFlight,
    };
  }
}

export function createSharedCorridorCandidate(): MovementCandidateAdapter {
  const engine = new SharedCorridorRouteEngine();
  return {
    id: "shared-corridor-exact-slot-hybrid",
    createTransport(context: CandidateContext) {
      let receive: ((response: PathResponse) => void) | undefined;
      return {
        attach(onReceive) { receive = onReceive; },
        send(request) {
          context.onRequest(request);
          const started = context.now();
          const response = engine.handle(request, context.now);
          const computeMs = context.now() - started;
          context.onResponse(response, computeMs);
          receive?.(response);
        },
        dispose() {},
      };
    },
    candidateMetrics() { return engine.candidateMetrics(); },
  };
}

export function createMockSharedCorridorCandidate(
  delayFor: MockDelayScript = (id) => (id * 7 + 1) % 5,
): MovementCandidateAdapter {
  const engine = new SharedCorridorRouteEngine();
  let frame = 0;
  let inFlight: { request: PathRequest; deliverAt: number }[] = [];
  let receive: ((response: PathResponse) => void) | undefined;
  let context: CandidateContext | undefined;
  return {
    id: "shared-corridor-exact-slot-hybrid-delayed-mock",
    createTransport(candidateContext) {
      context = candidateContext;
      frame = 0;
      inFlight = [];
      receive = undefined;
      return {
        attach(onReceive) { receive = onReceive; },
        send(request) {
          candidateContext.onRequest(request);
          inFlight.push({ request, deliverAt: frame + Math.max(0, delayFor(request.id)) + 1 });
        },
        dispose() { inFlight = []; },
      };
    },
    beforeFrame() {
      frame += 1;
      const due = inFlight
        .filter((entry) => entry.deliverAt <= frame)
        .sort((a, b) => a.deliverAt - b.deliverAt || b.request.id - a.request.id);
      inFlight = inFlight.filter((entry) => entry.deliverAt > frame);
      for (const entry of due) {
        if (!context) throw new Error("shared-corridor mock used before creation");
        const started = context.now();
        const response = engine.handle(entry.request, context.now);
        const computeMs = context.now() - started;
        context.onResponse(response, computeMs);
        receive?.(response);
      }
    },
    candidateMetrics() { return engine.candidateMetrics(inFlight.length); },
    dispose() { inFlight = []; },
  };
}

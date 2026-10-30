import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import {
  buildFlowField,
  FlowFieldCache,
  type FlowField,
} from "../../flow-field/flow-field";
import type { CandidateContext, MovementCandidateAdapter } from "../types";
import type { MockDelayScript } from "../candidates";

interface FlowMetrics {
  fieldsBuilt: number;
  cacheHits: number;
  cacheMisses: number;
  staleSnapshotBuilds: number;
  cacheInvalidations: number;
  routesTraced: number;
  unreachableRoutes: number;
  routeTiles: number;
  totalFieldBuildMs: number;
  maxFieldBuildMs: number;
  totalRouteTraceMs: number;
  maxRouteTraceMs: number;
  responseWaypointBytes: number;
  peakCachedFields: number;
  peakCachedFieldBytes: number;
}

/**
 * Shared-destination field adapter. Every scheduler request still has a
 * start, but field identity is only (goal, revision); starts query the
 * cached field. The response contains raw tile routes, never per-start A*.
 */
export class FlowFieldRouteEngine {
  readonly metrics: FlowMetrics = {
    fieldsBuilt: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleSnapshotBuilds: 0,
    cacheInvalidations: 0,
    routesTraced: 0,
    unreachableRoutes: 0,
    routeTiles: 0,
    totalFieldBuildMs: 0,
    maxFieldBuildMs: 0,
    totalRouteTraceMs: 0,
    maxRouteTraceMs: 0,
    responseWaypointBytes: 0,
    peakCachedFields: 0,
    peakCachedFieldBytes: 0,
  };
  #cache: FlowFieldCache | undefined;
  #revision = -1;
  #cachedGoalKeys: string[] = [];
  #fieldBytes = 0;

  handle(request: PathRequest, now: () => number): PathResponse {
    const width = Math.sqrt(request.passable.length);
    this.#fieldBytes = request.passable.length * 5;
    if (!Number.isInteger(width)) throw new Error("flow request grid must be square");
    const goal = { x: request.goalX, y: request.goalY };
    const goalKey = String(request.goalY * width + request.goalX);
    if (!this.#cache) {
      this.#cache = new FlowFieldCache(request.passable, width, request.passableVersion, 32);
      this.#revision = request.passableVersion;
    } else if (request.passableVersion > this.#revision) {
      this.#cache.updatePassability(request.passable, request.passableVersion);
      this.#revision = request.passableVersion;
      this.#cachedGoalKeys.length = 0;
      this.metrics.cacheInvalidations += 1;
    }

    let field: FlowField;
    const buildStarted = now();
    if (request.passableVersion < this.#revision) {
      // A delayed old snapshot must remain pure and must not move the LRU
      // backwards. Build it ephemerally; never serve it from the new cache.
      field = buildFlowField({
        passability: request.passable,
        width,
        goals: [goal],
        revision: request.passableVersion,
      });
      const elapsed = now() - buildStarted;
      this.metrics.fieldsBuilt += 1;
      this.metrics.staleSnapshotBuilds += 1;
      this.metrics.totalFieldBuildMs += elapsed;
      this.metrics.maxFieldBuildMs = Math.max(this.metrics.maxFieldBuildMs, elapsed);
    } else {
      const keyIndex = this.#cachedGoalKeys.indexOf(goalKey);
      const hit = keyIndex >= 0;
      field = this.#cache.getField([goal]);
      const elapsed = now() - buildStarted;
      if (hit) {
        this.#cachedGoalKeys.splice(keyIndex, 1);
        this.#cachedGoalKeys.push(goalKey);
        this.metrics.cacheHits += 1;
      } else {
        this.#cachedGoalKeys.push(goalKey);
        if (this.#cachedGoalKeys.length > 32) this.#cachedGoalKeys.shift();
        this.metrics.cacheMisses += 1;
        this.metrics.fieldsBuilt += 1;
        this.metrics.totalFieldBuildMs += elapsed;
        this.metrics.maxFieldBuildMs = Math.max(this.metrics.maxFieldBuildMs, elapsed);
      }
    }
    const cachedFields = this.#cache.size;
    this.metrics.peakCachedFields = Math.max(this.metrics.peakCachedFields, cachedFields);
    this.metrics.peakCachedFieldBytes = Math.max(
      this.metrics.peakCachedFieldBytes,
      cachedFields * (field.integration.byteLength + field.directions.byteLength),
    );

    const traceStarted = now();
    const route = field.traceRoute(request.startX, request.startY);
    const traceMs = now() - traceStarted;
    this.metrics.routesTraced += 1;
    this.metrics.totalRouteTraceMs += traceMs;
    this.metrics.maxRouteTraceMs = Math.max(this.metrics.maxRouteTraceMs, traceMs);
    if (!route) {
      this.metrics.unreachableRoutes += 1;
      return { kind: "path", id: request.id, ok: false, waypoints: new Int16Array(0), cost: 0 };
    }
    this.metrics.routeTiles += route.tiles.length;
    const waypoints = new Int16Array(route.tiles.length * 2);
    for (let index = 0; index < route.tiles.length; index += 1) {
      const tile = route.tiles[index]!;
      waypoints[index * 2] = tile % width;
      waypoints[index * 2 + 1] = Math.floor(tile / width);
    }
    this.metrics.responseWaypointBytes += waypoints.byteLength;
    return { kind: "path", id: request.id, ok: true, waypoints, cost: route.cost };
  }

  candidateMetrics(mockInFlight = 0): Readonly<Record<string, number | string | boolean>> {
    const cachedFields = this.#cache?.size ?? 0;
    return {
      integration: "shared-destination-field-to-raw-tile-route",
      ...this.metrics,
      cachedFields,
      cachedFieldBytes: cachedFields * this.#fieldBytes,
      fieldBytesPer120x120: 120 * 120 * 5,
      fieldTransferBytes: 0,
      transferModel: "route-waypoints-only-no-browser-structured-clone",
      mockInFlight,
    };
  }
}

export function createFlowFieldCandidate(): MovementCandidateAdapter {
  const engine = new FlowFieldRouteEngine();
  return {
    id: "flow-field-shared-destination",
    createTransport(context: CandidateContext) {
      let receive: ((response: PathResponse) => void) | undefined;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
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
    candidateMetrics() {
      return engine.candidateMetrics();
    },
  };
}

/** Same field engine with scripted delivery; no real worker is created. */
export function createMockFlowFieldCandidate(
  delayFor: MockDelayScript = (id) => (id * 7 + 1) % 5,
): MovementCandidateAdapter {
  const engine = new FlowFieldRouteEngine();
  let frame = 0;
  let inFlight: { request: PathRequest; deliverAt: number }[] = [];
  let receive: ((response: PathResponse) => void) | undefined;
  let context: CandidateContext | undefined;
  return {
    id: "flow-field-shared-destination-delayed-mock",
    createTransport(candidateContext) {
      context = candidateContext;
      frame = 0;
      inFlight = [];
      receive = undefined;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
        send(request) {
          candidateContext.onRequest(request);
          inFlight.push({ request, deliverAt: frame + Math.max(0, delayFor(request.id)) + 1 });
        },
        dispose() {
          inFlight = [];
        },
      };
    },
    beforeFrame() {
      frame += 1;
      const due = inFlight
        .filter((entry) => entry.deliverAt <= frame)
        .sort((a, b) => a.deliverAt - b.deliverAt || b.request.id - a.request.id);
      inFlight = inFlight.filter((entry) => entry.deliverAt > frame);
      for (const entry of due) {
        if (!context) throw new Error("flow mock used before creation");
        const started = context.now();
        const response = engine.handle(entry.request, context.now);
        const computeMs = context.now() - started;
        context.onResponse(response, computeMs);
        receive?.(response);
      }
    },
    candidateMetrics() {
      return engine.candidateMetrics(inFlight.length);
    },
    dispose() {
      inFlight = [];
    },
  };
}

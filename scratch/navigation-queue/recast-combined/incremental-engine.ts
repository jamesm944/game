import { recastCore } from "../../full-game-movement/recast-integration/recast-runtime";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { convertCorridorToGrid } from "./corridor-grid";
import {
  applyIncrementalRevision,
  buildMesh,
  destroyMesh,
  RECAST_GENERATION_CONFIG,
  sameBytes,
  type MeshEntry,
} from "./tile-cache-state";

const { Detour, statusDetail } = recastCore;
const EXACT_ENDPOINT_TOLERANCE = 0.05;
const QUERY_HALF_EXTENTS = { x: 2, y: 2, z: 2 } as const;

interface MeshLease {
  readonly entry: MeshEntry;
  readonly ephemeral: boolean;
}

export interface RecastMetrics {
  revisionBuilds: number;
  mutationRebuilds: number;
  revisionCacheHits: number;
  revisionCacheMisses: number;
  revisionCacheEvictions: number;
  peakRevisionCacheEntries: number;
  revisionCacheCapacityFailures: number;
  snapshotMismatches: number;
  ephemeralSnapshotBuilds: number;
  navmeshGenerationFailures: number;
  totalRevisionBuildMs: number;
  totalMutationRebuildMs: number;
  maxRevisionBuildMs: number;
  maxMutationRebuildMs: number;
  lastRevisionBuildMs: number;
  changedTilesObserved: number;
  mutationChangedTiles: number;
  maxChangedTilesPerBuild: number;
  incrementalRevisions: number;
  revisionBarriersCompleted: number;
  revisionVisibilityChanges: number;
  revisionVisibilityFailures: number;
  lastAcknowledgedRevision: number;
  totalIncrementalUpdateMs: number;
  maxIncrementalUpdateMs: number;
  navTilesTouchedRequested: number;
  maxNavTilesTouchedPerRevision: number;
  tileCacheUpdateCalls: number;
  maxUpdateCallsPerRevision: number;
  queueDrains: number;
  obstacleRequestBatches: number;
  peakObstacleRequestQueueDepth: number;
  obstacleRectanglesAdded: number;
  obstacleRectanglesRemoved: number;
  dynamicObstacleRemoves: number;
  peakLiveObstacles: number;
  guardedFallbacks: number;
  routeFailureFallbacks: number;
  geometryFallbacks: number;
  confirmedIncrementalNoPaths: number;
  capacityFallbacks: number;
  updateFailureFallbacks: number;
  nonIncrementalBaseFallbacks: number;
  outOfOrderRebuilds: number;
  snapshotMismatchRebuilds: number;
  pathQueries: number;
  pathCapacityFailures: number;
  totalPathQueryMs: number;
  maxPathQueryMs: number;
  routeConversions: number;
  totalRouteConversionMs: number;
  maxRouteConversionMs: number;
  responseWaypointBytes: number;
  unreachableRoutes: number;
  partialPathsRejected: number;
  endpointProjectionsRejected: number;
  geometryRejections: number;
  nativeQueryFailures: number;
  dynamicObstacleAdds: number;
  obstacleCapacityFailures: number;
  tileCacheUpdateFailures: number;
  crowdAgentsCreated: number;
  agentCapacityFailures: number;
}

function emptyMetrics(): RecastMetrics {
  return {
    revisionBuilds: 0, mutationRebuilds: 0, revisionCacheHits: 0, revisionCacheMisses: 0,
    revisionCacheEvictions: 0, peakRevisionCacheEntries: 0, revisionCacheCapacityFailures: 0,
    snapshotMismatches: 0, ephemeralSnapshotBuilds: 0, navmeshGenerationFailures: 0,
    totalRevisionBuildMs: 0, totalMutationRebuildMs: 0, maxRevisionBuildMs: 0,
    maxMutationRebuildMs: 0, lastRevisionBuildMs: 0, changedTilesObserved: 0,
    mutationChangedTiles: 0, maxChangedTilesPerBuild: 0, incrementalRevisions: 0,
    revisionBarriersCompleted: 0, revisionVisibilityChanges: 0, revisionVisibilityFailures: 0,
    lastAcknowledgedRevision: -1, totalIncrementalUpdateMs: 0, maxIncrementalUpdateMs: 0,
    navTilesTouchedRequested: 0, maxNavTilesTouchedPerRevision: 0, tileCacheUpdateCalls: 0,
    maxUpdateCallsPerRevision: 0, queueDrains: 0, obstacleRequestBatches: 0,
    peakObstacleRequestQueueDepth: 0, obstacleRectanglesAdded: 0, obstacleRectanglesRemoved: 0,
    dynamicObstacleRemoves: 0, peakLiveObstacles: 0, guardedFallbacks: 0,
    routeFailureFallbacks: 0, geometryFallbacks: 0, confirmedIncrementalNoPaths: 0,
    capacityFallbacks: 0, updateFailureFallbacks: 0, nonIncrementalBaseFallbacks: 0,
    outOfOrderRebuilds: 0, snapshotMismatchRebuilds: 0, pathQueries: 0,
    pathCapacityFailures: 0, totalPathQueryMs: 0, maxPathQueryMs: 0,
    routeConversions: 0, totalRouteConversionMs: 0, maxRouteConversionMs: 0,
    responseWaypointBytes: 0, unreachableRoutes: 0, partialPathsRejected: 0,
    endpointProjectionsRejected: 0, geometryRejections: 0, nativeQueryFailures: 0,
    dynamicObstacleAdds: 0, obstacleCapacityFailures: 0, tileCacheUpdateFailures: 0,
    crowdAgentsCreated: 0, agentCapacityFailures: 0,
  };
}

function noPath(request: PathRequest): PathResponse {
  return { kind: "path", id: request.id, ok: false, waypoints: new Int16Array(0), cost: 0 };
}

/**
 * Real Detour corridors over acknowledged incremental TileCache revisions.
 * Any incremental query failure is checked against an exact full Recast mesh;
 * a false no-path promotes that mesh, while confirmed no-path retains the base.
 */
export class RecastRouteEngine {
  readonly metrics = emptyMetrics();
  readonly geometryFailureSamples: {
    id: number;
    revision: number;
    start: readonly [number, number];
    goal: readonly [number, number];
    points: readonly { x: number; z: number }[];
  }[] = [];
  #latest: MeshEntry | undefined;
  #incrementalBase: MeshEntry | undefined;

  handle(request: PathRequest, now: () => number): PathResponse {
    const width = Math.sqrt(request.passable.length);
    if (!Number.isInteger(width) || width < 1) throw new Error("Recast request grid must be square");
    const { startX, startY, goalX, goalY } = request;
    if (
      startX < 0 || startY < 0 || goalX < 0 || goalY < 0 ||
      startX >= width || startY >= width || goalX >= width || goalY >= width ||
      request.passable[startY * width + startX] !== 1 ||
      request.passable[goalY * width + goalX] !== 1
    ) {
      this.metrics.unreachableRoutes += 1;
      return noPath(request);
    }
    if (startX === goalX && startY === goalY) {
      const waypoints = Int16Array.from([startX, startY]);
      this.metrics.responseWaypointBytes += waypoints.byteLength;
      return { kind: "path", id: request.id, ok: true, waypoints, cost: 0 };
    }

    const lease = this.#acquire(request, now, width);
    if (!lease) {
      this.metrics.unreachableRoutes += 1;
      return noPath(request);
    }
    try {
      if (lease.entry.revision !== request.passableVersion || !sameBytes(lease.entry.passable, request.passable)) {
        this.metrics.revisionVisibilityFailures += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }
      const geometryBefore = this.metrics.geometryRejections;
      const response = this.#query(lease.entry, request, now, width);
      if (response.ok || !lease.entry.incremental) return response;

      this.metrics.guardedFallbacks += 1;
      this.metrics.routeFailureFallbacks += 1;
      if (this.metrics.geometryRejections > geometryBefore) this.metrics.geometryFallbacks += 1;
      const fallback = buildMesh(request, now, width, false, true, this.metrics);
      if (!fallback) return response;
      const fallbackResponse = this.#query(fallback, request, now, width);
      if (fallbackResponse.ok && !lease.ephemeral) {
        // Serve this revision from the exact mesh, but retain the acknowledged
        // incremental ancestor so a later revision can still apply a real delta.
        this.#incrementalBase = lease.entry;
        this.#latest = fallback;
        this.metrics.peakRevisionCacheEntries = Math.max(this.metrics.peakRevisionCacheEntries, 2);
      } else {
        this.metrics.ephemeralSnapshotBuilds += 1;
        destroyMesh(fallback);
      }
      if (!fallbackResponse.ok) this.metrics.confirmedIncrementalNoPaths += 1;
      return fallbackResponse;
    } finally {
      if (lease.ephemeral) destroyMesh(lease.entry);
    }
  }

  #acquire(request: PathRequest, now: () => number, width: number): MeshLease | undefined {
    const cached = this.#latest;
    if (cached && cached.revision === request.passableVersion) {
      if (sameBytes(cached.passable, request.passable)) {
        this.metrics.revisionCacheHits += 1;
        return { entry: cached, ephemeral: false };
      }
      this.metrics.snapshotMismatches += 1;
      this.metrics.snapshotMismatchRebuilds += 1;
      this.metrics.guardedFallbacks += 1;
      const entry = buildMesh(request, now, width, false, true, this.metrics);
      if (entry) this.metrics.ephemeralSnapshotBuilds += 1;
      return entry ? { entry, ephemeral: true } : undefined;
    }
    if (cached && cached.revision > request.passableVersion) {
      this.metrics.revisionCacheMisses += 1;
      this.metrics.outOfOrderRebuilds += 1;
      this.metrics.guardedFallbacks += 1;
      const entry = buildMesh(request, now, width, false, true, this.metrics);
      if (entry) this.metrics.ephemeralSnapshotBuilds += 1;
      return entry ? { entry, ephemeral: true } : undefined;
    }

    this.metrics.revisionCacheMisses += 1;
    if (!cached) {
      const incremental = buildMesh(request, now, width, true, false, this.metrics);
      if (incremental) {
        this.#latest = incremental;
        this.#incrementalBase = incremental;
        this.metrics.peakRevisionCacheEntries = 1;
        return { entry: incremental, ephemeral: false };
      }
      this.metrics.guardedFallbacks += 1;
      if (this.metrics.obstacleCapacityFailures > 0) this.metrics.capacityFallbacks += 1;
      if (this.metrics.tileCacheUpdateFailures > 0) this.metrics.updateFailureFallbacks += 1;
      const fallback = buildMesh(request, now, width, false, false, this.metrics);
      if (fallback) {
        this.#latest = fallback;
        this.metrics.peakRevisionCacheEntries = 1;
      }
      return fallback ? { entry: fallback, ephemeral: false } : undefined;
    }

    const base = this.#incrementalBase;
    if (base && base.revision < request.passableVersion) {
      const capacityBefore = this.metrics.obstacleCapacityFailures;
      const updateFailuresBefore = this.metrics.tileCacheUpdateFailures;
      if (applyIncrementalRevision(base, request, now, width, this.metrics)) {
        if (cached !== base) destroyMesh(cached);
        this.#latest = base;
        return { entry: base, ephemeral: false };
      }
      this.metrics.guardedFallbacks += 1;
      if (this.metrics.obstacleCapacityFailures > capacityBefore) this.metrics.capacityFallbacks += 1;
      if (this.metrics.tileCacheUpdateFailures > updateFailuresBefore) this.metrics.updateFailureFallbacks += 1;
      destroyMesh(base);
      if (cached !== base) destroyMesh(cached);
    } else {
      this.metrics.nonIncrementalBaseFallbacks += 1;
      this.metrics.guardedFallbacks += 1;
      destroyMesh(cached);
    }
    this.#latest = undefined;
    this.#incrementalBase = undefined;
    const fallback = buildMesh(request, now, width, false, true, this.metrics);
    if (fallback) this.#latest = fallback;
    return fallback ? { entry: fallback, ephemeral: false } : undefined;
  }

  #query(entry: MeshEntry, request: PathRequest, now: () => number, width: number): PathResponse {
    const started = now();
    this.metrics.pathQueries += 1;
    let points: { x: number; z: number }[] = [];
    try {
      const start = { x: request.startX + 0.5, y: 0, z: request.startY + 0.5 };
      const end = { x: request.goalX + 0.5, y: 0, z: request.goalY + 0.5 };
      const startClosest = entry.query.findClosestPoint(start, { halfExtents: QUERY_HALF_EXTENTS });
      const endClosest = entry.query.findClosestPoint(end, { halfExtents: QUERY_HALF_EXTENTS });
      if (!startClosest.success || !endClosest.success) {
        this.metrics.nativeQueryFailures += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }
      const projectionError = Math.max(
        Math.hypot(startClosest.point.x - start.x, startClosest.point.z - start.z),
        Math.hypot(endClosest.point.x - end.x, endClosest.point.z - end.z),
      );
      if (projectionError > EXACT_ENDPOINT_TOLERANCE) {
        this.metrics.endpointProjectionsRejected += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }

      const path = entry.query.findPath(
        startClosest.polyRef,
        endClosest.polyRef,
        startClosest.point,
        endClosest.point,
        { maxPathPolys: 2048 },
      );
      try {
        if (path.polys.size >= 2048) this.metrics.pathCapacityFailures += 1;
        if (!path.success) {
          this.metrics.nativeQueryFailures += 1;
          this.metrics.unreachableRoutes += 1;
          return noPath(request);
        }
        if (statusDetail(path.status, Detour.DT_PARTIAL_RESULT)) {
          this.metrics.partialPathsRejected += 1;
          this.metrics.unreachableRoutes += 1;
          return noPath(request);
        }
        const straight = entry.query.findStraightPath(
          startClosest.point,
          endClosest.point,
          path.polys,
          { maxStraightPathPoints: 2048 },
        );
        try {
          if (straight.straightPathCount >= 2048) this.metrics.pathCapacityFailures += 1;
          if (!straight.success || straight.straightPathCount === 0) {
            this.metrics.nativeQueryFailures += 1;
            this.metrics.unreachableRoutes += 1;
            return noPath(request);
          }
          const last = (straight.straightPathCount - 1) * 3;
          if (Math.hypot(straight.straightPath.get(last) - end.x, straight.straightPath.get(last + 2) - end.z) > EXACT_ENDPOINT_TOLERANCE) {
            this.metrics.endpointProjectionsRejected += 1;
            this.metrics.unreachableRoutes += 1;
            return noPath(request);
          }
          for (let point = 0; point < straight.straightPathCount; point += 1) {
            points.push({
              x: straight.straightPath.get(point * 3),
              z: straight.straightPath.get(point * 3 + 2),
            });
          }
        } finally {
          straight.straightPath.destroy();
          straight.straightPathFlags.destroy();
          straight.straightPathRefs.destroy();
        }
      } finally {
        path.polys.destroy();
      }
    } finally {
      const elapsed = now() - started;
      this.metrics.totalPathQueryMs += elapsed;
      this.metrics.maxPathQueryMs = Math.max(this.metrics.maxPathQueryMs, elapsed);
    }
    return this.#convertRoute(request, points, now, width);
  }

  #convertRoute(
    request: PathRequest,
    points: readonly { x: number; z: number }[],
    now: () => number,
    width: number,
  ): PathResponse {
    const started = now();
    const waypoints = convertCorridorToGrid(
      points,
      request.passable,
      width,
      request.startX,
      request.startY,
      request.goalX,
      request.goalY,
    );
    if (!waypoints) {
      this.metrics.geometryRejections += 1;
      this.metrics.unreachableRoutes += 1;
      if (this.geometryFailureSamples.length < 16) this.geometryFailureSamples.push({
        id: request.id,
        revision: request.passableVersion,
        start: [request.startX, request.startY],
        goal: [request.goalX, request.goalY],
        points: points.map((point) => ({ ...point })),
      });
      return noPath(request);
    }
    let geometricCost = 0;
    for (let index = 2; index < waypoints.length; index += 2) {
      geometricCost += Math.hypot(waypoints[index]! - waypoints[index - 2]!, waypoints[index + 1]! - waypoints[index - 1]!);
    }
    const elapsed = now() - started;
    this.metrics.routeConversions += 1;
    this.metrics.totalRouteConversionMs += elapsed;
    this.metrics.maxRouteConversionMs = Math.max(this.metrics.maxRouteConversionMs, elapsed);
    this.metrics.responseWaypointBytes += waypoints.byteLength;
    // Telemetry only: not Detour's native cost or an optimal integer-A* cost.
    return { kind: "path", id: request.id, ok: true, waypoints, cost: Math.round(geometricCost * 1000) };
  }

  candidateMetrics(mockInFlight = 0): Readonly<Record<string, number | string | boolean>> {
    return {
      integration: "detour-corridor-supercover-cs0.25-incremental-tilecache-revision-barriers",
      gridConversion: "continuous-segment-supercover-production-los-string-pull-no-astar",
      generationCellSize: RECAST_GENERATION_CONFIG.cs,
      generationMaxSimplificationError: RECAST_GENERATION_CONFIG.maxSimplificationError,
      recastNavigationVersion: "0.43.0",
      generationWalkableRadius: RECAST_GENERATION_CONFIG.walkableRadius,
      revisionCacheEntries: this.#latest ? (this.#incrementalBase && this.#incrementalBase !== this.#latest ? 2 : 1) : 0,
      revisionCacheCapacity: 2,
      snapshotCacheBytes: (this.#latest?.passable.byteLength ?? 0) + (this.#incrementalBase && this.#incrementalBase !== this.#latest ? this.#incrementalBase.passable.byteLength : 0),
      liveObstacles: this.#incrementalBase?.obstacles.size ?? this.#latest?.obstacles.size ?? 0,
      tileCacheObstacleMapSize: this.#incrementalBase?.tileCache.obstacles.size ?? this.#latest?.tileCache.obstacles.size ?? 0,
      visibleRevision: this.#latest?.revision ?? -1,
      incrementalBaseRevision: this.#incrementalBase?.revision ?? -1,
      incrementalBaseActive: this.#incrementalBase !== undefined,
      maxObstacles: RECAST_GENERATION_CONFIG.maxObstacles,
      isolatedCrowdAgentCapacity: 2000,
      crowdModel: "none-production-activity-steering-collision",
      mutationStrategy: "exact-blocked-rectangle-cover-add-remove-drain-ack-with-guarded-full-rebuild",
      exactEndpointTolerance: EXACT_ENDPOINT_TOLERANCE,
      mockInFlight,
      ...this.metrics,
    };
  }

  dispose(): void {
    if (this.#latest) destroyMesh(this.#latest);
    if (this.#incrementalBase && this.#incrementalBase !== this.#latest) destroyMesh(this.#incrementalBase);
    this.#latest = undefined;
    this.#incrementalBase = undefined;
  }
}

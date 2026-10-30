import type * as RecastCore from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";
// @ts-expect-error the donor ESM entry is typed through its package declaration
import * as RecastCoreRuntime from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index.mjs";

const recast = RecastCoreRuntime as typeof RecastCore;
const { Detour, NavMeshQuery, statusDetail } = recast;
export function initializeCombinedRecast(): Promise<void> {
  return recast.init();
}
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import { convertCorridorToGrid } from "./corridor-grid";
import {
  RECAST_GENERATION_CONFIG,
  buildExactTileCache,
  destroyExactTileCache,
  type ExactTileCacheEntry,
} from "./exact-tile-cache";

const REVISION_CACHE_CAPACITY = 2;
const EXACT_ENDPOINT_TOLERANCE = 0.05;
const QUERY_HALF_EXTENTS = { x: 2, y: 2, z: 2 } as const;

interface MeshEntry extends ExactTileCacheEntry {
  readonly query: InstanceType<typeof NavMeshQuery>;
}

interface MeshLease {
  readonly entry: MeshEntry;
  readonly ephemeral: boolean;
}

function emptyMetrics() {
  return {
    revisionBuilds: 0,
    incrementalRevisionBuilds: 0,
    fullRasterRevisionBuilds: 0,
    mutationRebuilds: 0,
    revisionCacheHits: 0,
    revisionCacheMisses: 0,
    revisionCacheEvictions: 0,
    peakRevisionCacheEntries: 0,
    revisionCacheCapacityFailures: 0,
    snapshotMismatches: 0,
    ephemeralSnapshotBuilds: 0,
    outOfOrderRebuilds: 0,
    navmeshGenerationFailures: 0,
    revisionBarriersCompleted: 0,
    revisionVisibilityChanges: 0,
    revisionVisibilityFailures: 0,
    lastAcknowledgedRevision: -1,
    changedTilesObserved: 0,
    mutationChangedTiles: 0,
    maxChangedTilesPerBuild: 0,
    changedNavTiles: 0,
    rasterizedNavTiles: 0,
    maxRasterizedNavTilesPerRevision: 0,
    reusedCompressedLayers: 0,
    compressedLayerBytes: 0,
    totalRevisionBuildMs: 0,
    totalIncrementalUpdateMs: 0,
    totalGeometryMs: 0,
    totalRasterizeMs: 0,
    totalNavMeshBuildMs: 0,
    maxRevisionBuildMs: 0,
    lastRevisionBuildMs: 0,
    tileCacheUpdateCalls: 0,
    pathQueries: 0,
    pathCapacityFailures: 0,
    totalPathQueryMs: 0,
    maxPathQueryMs: 0,
    routeConversions: 0,
    totalRouteConversionMs: 0,
    maxRouteConversionMs: 0,
    responseWaypointBytes: 0,
    unreachableRoutes: 0,
    partialPathsRejected: 0,
    endpointProjectionsRejected: 0,
    geometryRejections: 0,
    nativeQueryFailures: 0,
    dynamicObstacleAdds: 0,
    dynamicObstacleRemoves: 0,
    obstacleCapacityFailures: 0,
    tileCacheUpdateFailures: 0,
    crowdAgentsCreated: 0,
    agentCapacityFailures: 0,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function noPath(request: PathRequest): PathResponse {
  return { kind: "path", id: request.id, ok: false, waypoints: new Int16Array(0), cost: 0 };
}

/** Exact compressed-layer incremental TileCache revisions and Detour corridors. */
export class CombinedRecastEngine {
  readonly metrics = emptyMetrics();
  readonly #cache = new Map<number, MeshEntry>();
  #latest: MeshEntry | undefined;

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
    try {
      if (lease.entry.revision !== request.passableVersion || !sameBytes(lease.entry.passable, request.passable)) {
        this.metrics.revisionVisibilityFailures += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }
      return this.#query(lease.entry, request, now, width);
    } finally {
      if (lease.ephemeral) this.#destroy(lease.entry);
    }
  }

  #acquire(request: PathRequest, now: () => number, width: number): MeshLease {
    const cached = this.#cache.get(request.passableVersion);
    if (cached) {
      if (sameBytes(cached.passable, request.passable)) {
        this.#cache.delete(request.passableVersion);
        this.#cache.set(request.passableVersion, cached);
        this.metrics.revisionCacheHits += 1;
        return { entry: cached, ephemeral: false };
      }
      this.metrics.snapshotMismatches += 1;
      return { entry: this.#build(request, now, width, undefined, true), ephemeral: true };
    }
    this.metrics.revisionCacheMisses += 1;
    const latest = this.#latest;
    if (latest && latest.revision > request.passableVersion) {
      this.metrics.outOfOrderRebuilds += 1;
      return { entry: this.#build(request, now, width, undefined, true), ephemeral: true };
    }
    const entry = this.#build(request, now, width, latest, false);
    this.#cache.set(entry.revision, entry);
    this.#latest = entry;
    this.metrics.revisionVisibilityChanges += 1;
    this.metrics.peakRevisionCacheEntries = Math.max(this.metrics.peakRevisionCacheEntries, this.#cache.size);
    while (this.#cache.size > REVISION_CACHE_CAPACITY) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const evicted = this.#cache.get(oldest.value)!;
      this.#cache.delete(oldest.value);
      this.#destroy(evicted);
      this.metrics.revisionCacheEvictions += 1;
    }
    return { entry, ephemeral: false };
  }

  #build(request: PathRequest, now: () => number, width: number, previous: MeshEntry | undefined, ephemeral: boolean): MeshEntry {
    try {
      const result = buildExactTileCache(request.passable, width, request.passableVersion, previous, now);
      const build = result.metrics;
      this.metrics.revisionBuilds += 1;
      if (previous) {
        this.metrics.incrementalRevisionBuilds += 1;
        this.metrics.mutationRebuilds += 1;
        this.metrics.totalIncrementalUpdateMs += build.totalMs;
        this.metrics.mutationChangedTiles += build.changedCells;
      } else {
        this.metrics.fullRasterRevisionBuilds += 1;
      }
      if (ephemeral) this.metrics.ephemeralSnapshotBuilds += 1;
      this.metrics.revisionBarriersCompleted += 1;
      this.metrics.lastAcknowledgedRevision = request.passableVersion;
      this.metrics.changedTilesObserved += build.changedCells;
      this.metrics.maxChangedTilesPerBuild = Math.max(this.metrics.maxChangedTilesPerBuild, build.changedCells);
      this.metrics.changedNavTiles += build.changedNavTiles;
      this.metrics.rasterizedNavTiles += build.rasterizedNavTiles;
      this.metrics.maxRasterizedNavTilesPerRevision = Math.max(this.metrics.maxRasterizedNavTilesPerRevision, build.rasterizedNavTiles);
      this.metrics.reusedCompressedLayers += build.reusedCompressedLayers;
      this.metrics.compressedLayerBytes = build.compressedLayerBytes;
      this.metrics.totalRevisionBuildMs += build.totalMs;
      this.metrics.totalGeometryMs += build.geometryMs;
      this.metrics.totalRasterizeMs += build.rasterizeMs;
      this.metrics.totalNavMeshBuildMs += build.navMeshBuildMs;
      this.metrics.maxRevisionBuildMs = Math.max(this.metrics.maxRevisionBuildMs, build.totalMs);
      this.metrics.lastRevisionBuildMs = build.totalMs;
      this.metrics.tileCacheUpdateCalls += 1;
      return { ...result.entry, query: new NavMeshQuery(result.entry.navMesh) };
    } catch (error) {
      this.metrics.navmeshGenerationFailures += 1;
      throw error;
    }
  }

  #query(entry: MeshEntry, request: PathRequest, now: () => number, width: number): PathResponse {
    const started = now();
    this.metrics.pathQueries += 1;
    const points: { x: number; z: number }[] = [];
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
      const path = entry.query.findPath(startClosest.polyRef, endClosest.polyRef, startClosest.point, endClosest.point, { maxPathPolys: 2048 });
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
        const straight = entry.query.findStraightPath(startClosest.point, endClosest.point, path.polys, { maxStraightPathPoints: 2048 });
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
            points.push({ x: straight.straightPath.get(point * 3), z: straight.straightPath.get(point * 3 + 2) });
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

  #convertRoute(request: PathRequest, points: readonly { x: number; z: number }[], now: () => number, width: number): PathResponse {
    const started = now();
    const waypoints = convertCorridorToGrid(points, request.passable, width, request.startX, request.startY, request.goalX, request.goalY);
    if (!waypoints) {
      this.metrics.geometryRejections += 1;
      this.metrics.unreachableRoutes += 1;
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
    return { kind: "path", id: request.id, ok: true, waypoints, cost: Math.round(geometricCost * 1000) };
  }

  candidateMetrics(mockInFlight = 0): Readonly<Record<string, number | string | boolean>> {
    return {
      integration: "detour-corridor-supercover-cs0.25-exact-compressed-layer-incremental-revisions",
      gridConversion: "continuous-segment-supercover-production-los-string-pull-no-astar",
      generationCellSize: RECAST_GENERATION_CONFIG.cs,
      generationMaxSimplificationError: RECAST_GENERATION_CONFIG.maxSimplificationError,
      recastNavigationVersion: "0.43.0",
      generationWalkableRadius: RECAST_GENERATION_CONFIG.walkableRadius,
      revisionCacheEntries: this.#cache.size,
      revisionCacheCapacity: REVISION_CACHE_CAPACITY,
      snapshotCacheBytes: [...this.#cache.values()].reduce((sum, entry) => sum + entry.passable.byteLength, 0),
      visibleRevision: this.#latest?.revision ?? -1,
      maxObstacles: RECAST_GENERATION_CONFIG.maxObstacles,
      obstacleStrategy: "none-exact-compressed-layer-regeneration",
      isolatedCrowdAgentCapacity: 2000,
      crowdModel: "none-production-activity-steering-collision",
      mutationStrategy: "exact-touched-tile-rasterization-unchanged-compressed-layer-reuse-atomic-ack",
      exactEndpointTolerance: EXACT_ENDPOINT_TOLERANCE,
      mockInFlight,
      ...this.metrics,
    };
  }

  #destroy(entry: MeshEntry): void {
    entry.query.destroy();
    destroyExactTileCache(entry);
  }

  dispose(): void {
    for (const entry of this.#cache.values()) this.#destroy(entry);
    this.#cache.clear();
    this.#latest = undefined;
  }
}

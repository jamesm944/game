import type {
  NavMesh,
  TileCache,
} from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";
import { recastCore, recastGenerators } from "./recast-runtime";
import { hasLineOfSight } from "../../../src/sim/path/astar";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";

const { Detour, NavMeshQuery, statusDetail } = recastCore;
const { generateTileCache } = recastGenerators;

const REVISION_CACHE_CAPACITY = 8;
const EXACT_ENDPOINT_TOLERANCE = 0.05;
const QUERY_HALF_EXTENTS = { x: 2, y: 2, z: 2 } as const;

/** Matches the donor's rasterization except radius: game A* has no agent-radius erosion. */
export const RECAST_GENERATION_CONFIG = {
  cs: 0.5,
  ch: 0.2,
  walkableSlopeAngle: 75,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 0,
  maxSimplificationError: 0.5,
  tileSize: 32,
  expectedLayersPerTile: 4,
  maxObstacles: 512,
} as const;

interface MeshEntry {
  readonly revision: number;
  readonly passable: Uint8Array;
  readonly navMesh: NavMesh;
  readonly tileCache: TileCache;
  readonly query: InstanceType<typeof NavMeshQuery>;
}

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
    revisionBuilds: 0,
    mutationRebuilds: 0,
    revisionCacheHits: 0,
    revisionCacheMisses: 0,
    revisionCacheEvictions: 0,
    peakRevisionCacheEntries: 0,
    revisionCacheCapacityFailures: 0,
    snapshotMismatches: 0,
    ephemeralSnapshotBuilds: 0,
    navmeshGenerationFailures: 0,
    totalRevisionBuildMs: 0,
    totalMutationRebuildMs: 0,
    maxRevisionBuildMs: 0,
    maxMutationRebuildMs: 0,
    lastRevisionBuildMs: 0,
    changedTilesObserved: 0,
    mutationChangedTiles: 0,
    maxChangedTilesPerBuild: 0,
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
    obstacleCapacityFailures: 0,
    tileCacheUpdateFailures: 0,
    crowdAgentsCreated: 0,
    agentCapacityFailures: 0,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function changedBytes(a: Uint8Array | undefined, b: Uint8Array): number {
  if (!a || a.length !== b.length) return b.length;
  let changed = 0;
  for (let index = 0; index < b.length; index += 1) {
    if (a[index] !== b[index]) changed += 1;
  }
  return changed;
}

function destroyMesh(entry: MeshEntry): void {
  entry.query.destroy();
  entry.tileCache.destroy();
  entry.navMesh.destroy();
}

function geometryFromPassability(passable: Uint8Array, width: number): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  let passableCells = 0;
  for (const value of passable) if (value === 1) passableCells += 1;
  const positions = new Float32Array(passableCells * 12);
  const indices = new Uint32Array(passableCells * 6);
  let vertex = 0;
  let index = 0;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (passable[y * width + x] !== 1) continue;
      const p = vertex * 3;
      positions.set([x, 0, y, x + 1, 0, y, x + 1, 0, y + 1, x, 0, y + 1], p);
      indices.set([vertex, vertex + 2, vertex + 1, vertex, vertex + 3, vertex + 2], index);
      vertex += 4;
      index += 6;
    }
  }
  return { positions, indices };
}

function noPath(request: PathRequest): PathResponse {
  return { kind: "path", id: request.id, ok: false, waypoints: new Int16Array(0), cost: 0 };
}

/**
 * Real Recast/Detour corridor queries with honest full snapshot rebuilds.
 * The transport has no mutation event stream, so a changed revision is
 * regenerated from its exact passability bytes instead of guessing obstacles.
 */
export class RecastRouteEngine {
  readonly metrics = emptyMetrics();
  readonly #cache = new Map<number, MeshEntry>();
  #latestSnapshot: Uint8Array | undefined;

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
      return this.#query(lease.entry, request, now, width);
    } finally {
      if (lease.ephemeral) destroyMesh(lease.entry);
    }
  }

  #acquire(request: PathRequest, now: () => number, width: number): MeshLease | undefined {
    const cached = this.#cache.get(request.passableVersion);
    if (cached) {
      if (sameBytes(cached.passable, request.passable)) {
        this.#cache.delete(request.passableVersion);
        this.#cache.set(request.passableVersion, cached);
        this.metrics.revisionCacheHits += 1;
        return { entry: cached, ephemeral: false };
      }
      // Version discipline is external to this adapter. Never query a mesh
      // built from different bytes merely because the revision number agrees.
      this.metrics.snapshotMismatches += 1;
      const entry = this.#build(request, now, width, true);
      return entry ? { entry, ephemeral: true } : undefined;
    }

    this.metrics.revisionCacheMisses += 1;
    const entry = this.#build(request, now, width, false);
    if (!entry) return undefined;
    this.#cache.set(request.passableVersion, entry);
    this.metrics.peakRevisionCacheEntries = Math.max(this.metrics.peakRevisionCacheEntries, this.#cache.size);
    while (this.#cache.size > REVISION_CACHE_CAPACITY) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const evicted = this.#cache.get(oldest.value)!;
      this.#cache.delete(oldest.value);
      destroyMesh(evicted);
      this.metrics.revisionCacheEvictions += 1;
    }
    return { entry, ephemeral: false };
  }

  #build(request: PathRequest, now: () => number, width: number, ephemeral: boolean): MeshEntry | undefined {
    const mutation = this.#latestSnapshot !== undefined;
    const started = now();
    const geometry = geometryFromPassability(request.passable, width);
    const generated = generateTileCache(geometry.positions, geometry.indices, RECAST_GENERATION_CONFIG);
    const elapsed = now() - started;
    this.metrics.revisionBuilds += 1;
    if (ephemeral) this.metrics.ephemeralSnapshotBuilds += 1;
    if (mutation) this.metrics.mutationRebuilds += 1;
    this.metrics.totalRevisionBuildMs += elapsed;
    if (mutation) this.metrics.totalMutationRebuildMs += elapsed;
    this.metrics.maxRevisionBuildMs = Math.max(this.metrics.maxRevisionBuildMs, elapsed);
    if (mutation) this.metrics.maxMutationRebuildMs = Math.max(this.metrics.maxMutationRebuildMs, elapsed);
    this.metrics.lastRevisionBuildMs = elapsed;
    const changed = changedBytes(this.#latestSnapshot, request.passable);
    this.#latestSnapshot = request.passable.slice();
    this.metrics.changedTilesObserved += changed;
    if (mutation) this.metrics.mutationChangedTiles += changed;
    this.metrics.maxChangedTilesPerBuild = Math.max(this.metrics.maxChangedTilesPerBuild, changed);
    if (!generated.success) {
      this.metrics.navmeshGenerationFailures += 1;
      return undefined;
    }
    return {
      revision: request.passableVersion,
      passable: request.passable.slice(),
      navMesh: generated.navMesh,
      tileCache: generated.tileCache,
      query: new NavMeshQuery(generated.navMesh),
    };
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
    const tiles: number[] = [request.startX, request.startY];
    for (const point of points) {
      const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
      const y = Math.max(0, Math.min(width - 1, Math.floor(point.z)));
      if (tiles[tiles.length - 2] !== x || tiles[tiles.length - 1] !== y) tiles.push(x, y);
    }
    if (tiles[tiles.length - 2] !== request.goalX || tiles[tiles.length - 1] !== request.goalY) {
      tiles.push(request.goalX, request.goalY);
    }
    for (let index = 0; index < tiles.length; index += 2) {
      if (request.passable[tiles[index + 1]! * width + tiles[index]!] !== 1) {
        this.metrics.geometryRejections += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }
    }
    for (let index = 2; index < tiles.length; index += 2) {
      if (!hasLineOfSight(
        request.passable,
        width,
        tiles[index - 2]!,
        tiles[index - 1]!,
        tiles[index]!,
        tiles[index + 1]!,
      )) {
        this.metrics.geometryRejections += 1;
        this.metrics.unreachableRoutes += 1;
        return noPath(request);
      }
    }
    const waypoints = Int16Array.from(tiles);
    let geometricCost = 0;
    for (let index = 2; index < tiles.length; index += 2) {
      geometricCost += Math.hypot(tiles[index]! - tiles[index - 2]!, tiles[index + 1]! - tiles[index - 1]!);
    }
    const elapsed = now() - started;
    this.metrics.routeConversions += 1;
    this.metrics.totalRouteConversionMs += elapsed;
    this.metrics.maxRouteConversionMs = Math.max(this.metrics.maxRouteConversionMs, elapsed);
    this.metrics.responseWaypointBytes += waypoints.byteLength;
    // Telemetry only: this is not Detour's native cost or an optimal A* cost.
    return { kind: "path", id: request.id, ok: true, waypoints, cost: Math.round(geometricCost * 1000) };
  }

  candidateMetrics(mockInFlight = 0): Readonly<Record<string, number | string | boolean>> {
    return {
      integration: "detour-corridor-full-snapshot-tilecache-rebuild-grid-quantized",
      recastNavigationVersion: "0.43.0",
      generationWalkableRadius: RECAST_GENERATION_CONFIG.walkableRadius,
      revisionCacheEntries: this.#cache.size,
      revisionCacheCapacity: REVISION_CACHE_CAPACITY,
      maxObstacles: RECAST_GENERATION_CONFIG.maxObstacles,
      isolatedCrowdAgentCapacity: 2000,
      crowdModel: "none-production-activity-steering-collision",
      mutationStrategy: "full-generateTileCache-rebuild-from-exact-snapshot",
      exactEndpointTolerance: EXACT_ENDPOINT_TOLERANCE,
      mockInFlight,
      ...this.metrics,
    };
  }

  dispose(): void {
    for (const entry of this.#cache.values()) destroyMesh(entry);
    this.#cache.clear();
  }
}

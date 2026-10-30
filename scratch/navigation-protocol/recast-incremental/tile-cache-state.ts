import type {
  BoxObstacle,
  NavMesh,
  TileCache,
} from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";
import { recastCore, recastGenerators } from "../../full-game-movement/recast-integration/recast-runtime";
import type { PathRequest } from "../../../src/sim/path/protocol";
import type { RecastMetrics } from "./incremental-engine";

const { NavMeshQuery } = recastCore;
const { generateTileCache } = recastGenerators;
const MAX_REQUESTS_PER_DRAIN = 32;
const MAX_UPDATE_CALLS_PER_DRAIN = 4096;

export const RECAST_GENERATION_CONFIG = {
  cs: 0.25,
  ch: 0.2,
  walkableSlopeAngle: 75,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 0,
  maxSimplificationError: 0.25,
  tileSize: 32,
  expectedLayersPerTile: 4,
  maxObstacles: 512,
} as const;

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MeshEntry {
  revision: number;
  passable: Uint8Array;
  readonly navMesh: NavMesh;
  readonly tileCache: TileCache;
  readonly query: InstanceType<typeof NavMeshQuery>;
  readonly obstacles: Map<string, BoxObstacle>;
  rectangles: Map<string, Rectangle>;
  incremental: boolean;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function changedBytes(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index < b.length; index += 1) if (a[index] !== b[index]) changed += 1;
  return changed;
}

export function destroyMesh(entry: MeshEntry): void {
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

function rectangleKey(rectangle: Rectangle): string {
  return `${rectangle.x},${rectangle.y},${rectangle.width},${rectangle.height}`;
}

/** Deterministic exact cover of blocked cells; no obstacle approximates open terrain. */
export function blockedRectangleCover(passable: Uint8Array, width: number): Map<string, Rectangle> {
  const visited = new Uint8Array(passable.length);
  const rectangles = new Map<string, Rectangle>();
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (passable[start] === 1 || visited[start] === 1) continue;
      let rectangleWidth = 1;
      while (
        x + rectangleWidth < width &&
        passable[start + rectangleWidth] === 0 &&
        visited[start + rectangleWidth] === 0
      ) rectangleWidth += 1;
      let rectangleHeight = 1;
      outer: while (y + rectangleHeight < width) {
        const row = (y + rectangleHeight) * width + x;
        for (let dx = 0; dx < rectangleWidth; dx += 1) {
          if (passable[row + dx] === 1 || visited[row + dx] === 1) break outer;
        }
        rectangleHeight += 1;
      }
      const rectangle = { x, y, width: rectangleWidth, height: rectangleHeight };
      rectangles.set(rectangleKey(rectangle), rectangle);
      for (let dy = 0; dy < rectangleHeight; dy += 1) {
        for (let dx = 0; dx < rectangleWidth; dx += 1) visited[(y + dy) * width + x + dx] = 1;
      }
    }
  }
  return rectangles;
}

function markTouchedNavTiles(rectangles: readonly Rectangle[], metrics: RecastMetrics): void {
  const tiles = new Set<number>();
  const worldPerNavTile = RECAST_GENERATION_CONFIG.cs * RECAST_GENERATION_CONFIG.tileSize;
  for (const rectangle of rectangles) {
    const minX = Math.floor(rectangle.x / worldPerNavTile);
    const minY = Math.floor(rectangle.y / worldPerNavTile);
    const maxX = Math.floor((rectangle.x + rectangle.width - 1) / worldPerNavTile);
    const maxY = Math.floor((rectangle.y + rectangle.height - 1) / worldPerNavTile);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) tiles.add(y * 4096 + x);
    }
  }
  metrics.navTilesTouchedRequested += tiles.size;
  metrics.maxNavTilesTouchedPerRevision = Math.max(metrics.maxNavTilesTouchedPerRevision, tiles.size);
}

function drain(
  entry: MeshEntry,
  metrics: RecastMetrics,
  revisionCalls: { value: number },
): boolean {
  let pending = false;
  do {
    const result = entry.tileCache.update(entry.navMesh);
    metrics.tileCacheUpdateCalls += 1;
    revisionCalls.value += 1;
    metrics.maxUpdateCallsPerRevision = Math.max(metrics.maxUpdateCallsPerRevision, revisionCalls.value);
    if (!result.success) {
      metrics.tileCacheUpdateFailures += 1;
      return false;
    }
    pending = !result.upToDate;
    if (revisionCalls.value > MAX_UPDATE_CALLS_PER_DRAIN) {
      metrics.tileCacheUpdateFailures += 1;
      return false;
    }
  } while (pending);
  metrics.queueDrains += 1;
  return true;
}

/** Apply and acknowledge one exact binary snapshot revision before any query. */
export function applyIncrementalRevision(
  entry: MeshEntry,
  request: PathRequest,
  now: () => number,
  width: number,
  metrics: RecastMetrics,
): boolean {
  const started = now();
  const changed = changedBytes(entry.passable, request.passable);
  const target = blockedRectangleCover(request.passable, width);
  const removals = [...entry.rectangles.keys()].filter((key) => !target.has(key)).sort();
  const additions = [...target.keys()].filter((key) => !entry.rectangles.has(key)).sort();
  const touched = [...removals.map((key) => entry.rectangles.get(key)!), ...additions.map((key) => target.get(key)!)];
  markTouchedNavTiles(touched, metrics);
  metrics.incrementalRevisions += 1;
  metrics.mutationChangedTiles += changed;
  metrics.changedTilesObserved += changed;
  metrics.maxChangedTilesPerBuild = Math.max(metrics.maxChangedTilesPerBuild, changed);
  metrics.obstacleRectanglesAdded += additions.length;
  metrics.obstacleRectanglesRemoved += removals.length;
  const revisionCalls = { value: 0 };
  let queued = 0;
  let succeeded = true;

  const barrier = (): boolean => {
    if (queued === 0) return true;
    metrics.obstacleRequestBatches += 1;
    metrics.peakObstacleRequestQueueDepth = Math.max(metrics.peakObstacleRequestQueueDepth, queued);
    queued = 0;
    return drain(entry, metrics, revisionCalls);
  };

  for (const key of removals) {
    const obstacle = entry.obstacles.get(key);
    if (!obstacle) {
      metrics.tileCacheUpdateFailures += 1;
      succeeded = false;
      break;
    }
    const result = entry.tileCache.removeObstacle(obstacle);
    if (!result.success) {
      metrics.tileCacheUpdateFailures += 1;
      succeeded = false;
      break;
    }
    entry.obstacles.delete(key);
    metrics.dynamicObstacleRemoves += 1;
    queued += 1;
    if (queued >= MAX_REQUESTS_PER_DRAIN && !barrier()) {
      succeeded = false;
      break;
    }
  }
  if (succeeded) {
    for (const key of additions) {
      const rectangle = target.get(key)!;
      const result = entry.tileCache.addBoxObstacle(
        { x: rectangle.x + rectangle.width / 2, y: 0, z: rectangle.y + rectangle.height / 2 },
        { x: rectangle.width / 2, y: 2, z: rectangle.height / 2 },
        0,
      );
      if (!result.success || !result.obstacle) {
        metrics.obstacleCapacityFailures += 1;
        succeeded = false;
        break;
      }
      entry.obstacles.set(key, result.obstacle);
      metrics.dynamicObstacleAdds += 1;
      metrics.peakLiveObstacles = Math.max(metrics.peakLiveObstacles, entry.obstacles.size);
      queued += 1;
      if (queued >= MAX_REQUESTS_PER_DRAIN && !barrier()) {
        succeeded = false;
        break;
      }
    }
  }
  if (succeeded) succeeded = barrier();
  metrics.totalIncrementalUpdateMs += now() - started;
  metrics.maxIncrementalUpdateMs = Math.max(metrics.maxIncrementalUpdateMs, now() - started);
  if (!succeeded) return false;

  entry.rectangles = target;
  entry.passable = request.passable.slice();
  if (entry.revision !== request.passableVersion) metrics.revisionVisibilityChanges += 1;
  entry.revision = request.passableVersion;
  metrics.revisionBarriersCompleted += 1;
  metrics.lastAcknowledgedRevision = request.passableVersion;
  metrics.maxUpdateCallsPerRevision = Math.max(metrics.maxUpdateCallsPerRevision, revisionCalls.value);
  return true;
}

export function buildMesh(
  request: PathRequest,
  now: () => number,
  width: number,
  incrementalBase: boolean,
  mutation: boolean,
  metrics: RecastMetrics,
): MeshEntry | undefined {
  const started = now();
  const passable = incrementalBase ? new Uint8Array(request.passable.length).fill(1) : request.passable;
  const geometry = geometryFromPassability(passable, width);
  const generated = generateTileCache(geometry.positions, geometry.indices, RECAST_GENERATION_CONFIG);
  const elapsed = now() - started;
  metrics.revisionBuilds += 1;
  if (mutation) metrics.mutationRebuilds += 1;
  metrics.totalRevisionBuildMs += elapsed;
  if (mutation) metrics.totalMutationRebuildMs += elapsed;
  metrics.maxRevisionBuildMs = Math.max(metrics.maxRevisionBuildMs, elapsed);
  if (mutation) metrics.maxMutationRebuildMs = Math.max(metrics.maxMutationRebuildMs, elapsed);
  metrics.lastRevisionBuildMs = elapsed;
  if (!generated.success) {
    metrics.navmeshGenerationFailures += 1;
    return undefined;
  }
  const entry: MeshEntry = {
    revision: incrementalBase ? -1 : request.passableVersion,
    passable: passable.slice(),
    navMesh: generated.navMesh,
    tileCache: generated.tileCache,
    query: new NavMeshQuery(generated.navMesh),
    obstacles: new Map(),
    rectangles: new Map(),
    incremental: incrementalBase,
  };
  if (!incrementalBase) return entry;
  if (applyIncrementalRevision(entry, request, now, width, metrics)) return entry;
  destroyMesh(entry);
  return undefined;
}

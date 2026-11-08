import type * as RecastCore from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";
import type * as RecastGenerators from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/generators/dist/index";
// The donor ESM entries have no colocated declarations; these casts restore their typed APIs.
// @ts-expect-error typed through the package declaration imports above
import * as RecastCoreRuntime from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index.mjs";
// @ts-expect-error typed through the package declaration imports above
import * as RecastGeneratorsRuntime from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/generators/dist/index.mjs";
import type { NavMesh as NavMeshType, TileCache as TileCacheType } from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";

const {
  ChunkIdsArray,
  Detour,
  DetourTileCacheParams,
  NavMesh,
  NavMeshParams,
  Raw,
  RecastBuildContext,
  RecastChunkyTriMesh,
  TileCache,
  TileCacheData,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocHeightfield,
  allocHeightfieldLayerSet,
  buildCompactHeightfield,
  buildHeightfieldLayers,
  buildTileCacheLayer,
  calcGridSize,
  cloneRcConfig,
  createHeightfield,
  createRcConfig,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeHeightfield,
  freeHeightfieldLayerSet,
  getHeightfieldLayerAreas,
  getHeightfieldLayerCons,
  getHeightfieldLayerHeights,
  markWalkableTriangles,
  rasterizeTriangles,
  statusFailed,
  vec3,
} = RecastCoreRuntime as typeof RecastCore;
const {
  createDefaultTileCacheMeshProcess,
  tileCacheGeneratorConfigDefaults,
} = RecastGeneratorsRuntime as typeof RecastGenerators;

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

export interface ExactTileCacheEntry {
  readonly revision: number;
  readonly passable: Uint8Array;
  readonly navMesh: NavMeshType;
  readonly tileCache: TileCacheType;
  readonly compressedLayers: ReadonlyMap<string, Uint8Array>;
  /** Keep native allocator/compressor/process wrappers alive with the cache. */
  readonly resources: readonly unknown[];
}

export interface ExactBuildMetrics {
  readonly changedCells: number;
  readonly changedNavTiles: number;
  readonly rasterizedNavTiles: number;
  readonly reusedCompressedLayers: number;
  readonly compressedLayers: number;
  readonly compressedLayerBytes: number;
  readonly geometryMs: number;
  readonly rasterizeMs: number;
  readonly navMeshBuildMs: number;
  readonly totalMs: number;
  readonly maxChunksOverlapping: number;
}

export interface ExactBuildResult {
  readonly entry: ExactTileCacheEntry;
  readonly metrics: ExactBuildMetrics;
}

function geometryFromPassability(passable: Uint8Array, width: number) {
  let passableCells = 0;
  for (const value of passable) if (value === 1) passableCells += 1;
  if (passableCells === 0) throw new Error("exact TileCache requires at least one passable cell");
  const positions = new Float32Array(passableCells * 12);
  const indices = new Int32Array(passableCells * 6);
  let vertex = 0;
  let index = 0;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (passable[y * width + x] !== 1) continue;
      positions.set([x, 0, y, x + 1, 0, y, x + 1, 0, y + 1, x, 0, y + 1], vertex * 3);
      indices.set([vertex, vertex + 2, vertex + 1, vertex, vertex + 3, vertex + 2], index);
      vertex += 4;
      index += 6;
    }
  }
  return { positions, indices };
}

function dtIlog2(value: number): number {
  let result = Number(value > 0xffff) << 4;
  let remaining = value >>> result;
  let shift = Number(remaining > 0xff) << 3;
  remaining >>>= shift;
  result |= shift;
  shift = Number(remaining > 0xf) << 2;
  remaining >>>= shift;
  result |= shift;
  shift = Number(remaining > 0x3) << 1;
  remaining >>>= shift;
  result |= shift;
  result |= remaining >> 1;
  return result;
}

function dtNextPow2(value: number): number {
  let result = value - 1;
  result |= result >> 1;
  result |= result >> 2;
  result |= result >> 4;
  result |= result >> 8;
  result |= result >> 16;
  return result + 1;
}

function layerKey(x: number, y: number, layer: number): string {
  return `${x},${y},${layer}`;
}

/**
 * Reuse unchanged compressed TileCache layers and exactly re-rasterize touched
 * tiles. A fresh NavMesh is built from the same ordered layers as full Recast.
 * No obstacle carving, A*, or approximate route repair is involved.
 */
export function buildExactTileCache(
  passable: Uint8Array,
  width: number,
  revision: number,
  previous: ExactTileCacheEntry | undefined,
  now: () => number,
): ExactBuildResult {
  const started = now();
  if (!Number.isInteger(width) || width < 1 || passable.length !== width * width) {
    throw new Error("exact TileCache snapshot must be a non-empty square grid");
  }
  if (previous && previous.passable.length !== passable.length) throw new Error("snapshot dimensions changed");
  const geometryStarted = now();
  const { positions, indices } = geometryFromPassability(passable, width);
  const geometryMs = now() - geometryStarted;
  const tileWorldWidth = RECAST_GENERATION_CONFIG.tileSize * RECAST_GENERATION_CONFIG.cs;
  const tileCount = Math.ceil(width / tileWorldWidth);
  const touched = new Set<number>();
  let changedCells = 0;
  if (!previous) {
    for (let y = 0; y < tileCount; y += 1) for (let x = 0; x < tileCount; x += 1) touched.add(y * tileCount + x);
    changedCells = passable.length;
  } else {
    for (let index = 0; index < passable.length; index += 1) {
      if (previous.passable[index] === passable[index]) continue;
      changedCells += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      touched.add(Math.floor(y / tileWorldWidth) * tileCount + Math.floor(x / tileWorldWidth));
    }
  }
  const changedNavTiles = touched.size;
  if (previous && touched.size > 0) {
    // Heightfield rasterization uses a three-cell border. A mutation at a tile
    // edge can therefore change a neighbor's compressed layer even when none
    // of that neighbor's own passability bytes changed. Rebuild the one-tile
    // halo to keep the layer stream equivalent to a corrected full rebuild.
    const directlyTouched = [...touched];
    for (const packed of directlyTouched) {
      const tileX = packed % tileCount;
      const tileY = Math.floor(packed / tileCount);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const x = tileX + offsetX;
          const y = tileY + offsetY;
          if (x >= 0 && y >= 0 && x < tileCount && y < tileCount) touched.add(y * tileCount + x);
        }
      }
    }
  }

  const buildContext = new RecastBuildContext();
  const verticesArray = new VerticesArray();
  const trianglesArray = new TrianglesArray();
  verticesArray.copy(positions);
  trianglesArray.copy(indices);
  const config = createRcConfig({ ...tileCacheGeneratorConfigDefaults, ...RECAST_GENERATION_CONFIG });
  const bbMin: [number, number, number] = [0, 0, 0];
  const bbMax: [number, number, number] = [width, 0, width];
  const gridSize = calcGridSize(bbMin, bbMax, config.cs);
  config.width = gridSize.width;
  config.height = gridSize.height;
  config.minRegionArea *= config.minRegionArea;
  config.mergeRegionArea *= config.mergeRegionArea;
  config.detailSampleDist = config.detailSampleDist < 0.9 ? 0 : config.cs * config.detailSampleDist;
  config.detailSampleMaxError = config.ch * config.detailSampleMaxError;
  const tileWidthInCells = Math.floor(config.tileSize);
  const tileWidth = Math.floor((config.width + tileWidthInCells - 1) / tileWidthInCells);
  const tileHeight = Math.floor((config.height + tileWidthInCells - 1) / tileWidthInCells);
  if (tileWidth !== tileCount || tileHeight !== tileCount) throw new Error("tile count mismatch");
  config.borderSize = config.walkableRadius + 3;
  config.width = config.tileSize + config.borderSize * 2;
  config.height = config.tileSize + config.borderSize * 2;

  const tileCache = new TileCache();
  const navMesh = new NavMesh();
  const allocator = new Raw.RecastLinearAllocator(32000);
  const compressor = new Raw.RecastFastLZCompressor();
  const meshProcess = createDefaultTileCacheMeshProcess();
  const resources = [allocator, compressor, meshProcess] as const;
  let chunkyTriMesh: InstanceType<typeof RecastChunkyTriMesh> | undefined;
  const compressedLayers = new Map(previous?.compressedLayers ?? []);
  const reusedCompressedLayers = previous
    ? [...previous.compressedLayers.keys()].filter((key) => {
      const [x, y] = key.split(",").map(Number);
      return !touched.has(y! * tileCount + x!);
    }).length
    : 0;
  let maxChunksOverlapping = 0;
  const cleanupArrays = () => {
    verticesArray.destroy();
    trianglesArray.destroy();
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };

  try {
    const tileCacheParams = DetourTileCacheParams.create({
      orig: bbMin,
      cs: config.cs,
      ch: config.ch,
      width: config.tileSize,
      height: config.tileSize,
      walkableHeight: config.walkableHeight * config.ch,
      walkableRadius: config.walkableRadius * config.cs,
      walkableClimb: config.walkableClimb * config.ch,
      maxSimplificationError: config.maxSimplificationError,
      maxTiles: tileWidth * tileHeight * RECAST_GENERATION_CONFIG.expectedLayersPerTile,
      maxObstacles: RECAST_GENERATION_CONFIG.maxObstacles,
    });
    if (!tileCache.init(tileCacheParams, allocator, compressor, meshProcess)) fail("failed to initialize TileCache");
    let tileBits = Math.min(Math.floor(dtIlog2(dtNextPow2(tileWidth * tileHeight * RECAST_GENERATION_CONFIG.expectedLayersPerTile))), 14);
    const polyBits = 22 - tileBits;
    const navMeshParams = NavMeshParams.create({
      orig: vec3.fromArray(bbMin),
      tileWidth: config.tileSize * config.cs,
      tileHeight: config.tileSize * config.cs,
      maxTiles: 1 << tileBits,
      maxPolys: 1 << polyBits,
    });
    if (!navMesh.initTiled(navMeshParams)) fail("failed to initialize NavMesh");
    chunkyTriMesh = new RecastChunkyTriMesh();
    if (!chunkyTriMesh.init(verticesArray, trianglesArray, indices.length / 3, 256)) fail("failed to build chunky triangle mesh");

    const rasterizeStarted = now();
    const orderedTouched = [...touched].sort((a, b) => (a % tileCount) - (b % tileCount) || Math.floor(a / tileCount) - Math.floor(b / tileCount));
    for (const packed of orderedTouched) {
      const tileX = packed % tileCount;
      const tileY = Math.floor(packed / tileCount);
      for (let layer = 0; layer < RECAST_GENERATION_CONFIG.expectedLayersPerTile; layer += 1) compressedLayers.delete(layerKey(tileX, tileY, layer));
      const tileConfig = cloneRcConfig(config);
      const tcs = config.tileSize * config.cs;
      const border = tileConfig.borderSize * tileConfig.cs;
      const tileBoundsMin: [number, number, number] = [tileX * tcs - border, 0, tileY * tcs - border];
      const tileBoundsMax: [number, number, number] = [(tileX + 1) * tcs + border, 0, (tileY + 1) * tcs + border];
      tileConfig.set_bmin(0, tileBoundsMin[0]);
      tileConfig.set_bmin(1, 0);
      tileConfig.set_bmin(2, tileBoundsMin[2]);
      tileConfig.set_bmax(0, tileBoundsMax[0]);
      tileConfig.set_bmax(1, 0);
      tileConfig.set_bmax(2, tileBoundsMax[2]);
      const heightfield = allocHeightfield();
      if (!createHeightfield(buildContext, heightfield, tileConfig.width, tileConfig.height, tileBoundsMin, tileBoundsMax, tileConfig.cs, tileConfig.ch)) fail(`heightfield creation failed at ${tileX},${tileY}`);
      const chunkIds = new ChunkIdsArray();
      chunkIds.resize(512);
      const chunkCount = chunkyTriMesh.getChunksOverlappingRect([tileBoundsMin[0], tileBoundsMin[2]], [tileBoundsMax[0], tileBoundsMax[2]], chunkIds, 512);
      maxChunksOverlapping = Math.max(maxChunksOverlapping, chunkCount);
      if (chunkCount >= 512) {
        chunkIds.destroy();
        freeHeightfield(heightfield);
        fail(`chunk capacity exhausted at ${tileX},${tileY}`);
      }
      if (chunkCount === 0) {
        chunkIds.destroy();
        freeHeightfield(heightfield);
        continue;
      }
      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        const nodeId = chunkIds.get(chunk);
        const node = chunkyTriMesh.nodes(nodeId);
        const triangleCount = node.n;
        const nodeTriangles = chunkyTriMesh.getNodeTris(nodeId);
        const areas = new TriangleAreasArray();
        areas.resize(triangleCount);
        markWalkableTriangles(buildContext, tileConfig.walkableSlopeAngle, verticesArray, indices.length, nodeTriangles, triangleCount, areas);
        const success = rasterizeTriangles(buildContext, verticesArray, indices.length, nodeTriangles, areas, triangleCount, heightfield, tileConfig.walkableClimb);
        areas.destroy();
        if (!success) {
          chunkIds.destroy();
          freeHeightfield(heightfield);
          fail(`triangle rasterization failed at ${tileX},${tileY}`);
        }
      }
      chunkIds.destroy();
      filterLowHangingWalkableObstacles(buildContext, config.walkableClimb, heightfield);
      filterLedgeSpans(buildContext, config.walkableHeight, config.walkableClimb, heightfield);
      filterWalkableLowHeightSpans(buildContext, config.walkableHeight, heightfield);
      const compact = allocCompactHeightfield();
      if (!buildCompactHeightfield(buildContext, config.walkableHeight, config.walkableClimb, heightfield, compact)) {
        freeHeightfield(heightfield);
        fail(`compact heightfield failed at ${tileX},${tileY}`);
      }
      freeHeightfield(heightfield);
      if (!erodeWalkableArea(buildContext, config.walkableRadius, compact)) {
        freeCompactHeightfield(compact);
        fail(`walkable erosion failed at ${tileX},${tileY}`);
      }
      const layerSet = allocHeightfieldLayerSet();
      if (!buildHeightfieldLayers(buildContext, compact, config.borderSize, config.walkableHeight, layerSet)) {
        freeCompactHeightfield(compact);
        freeHeightfieldLayerSet(layerSet);
        fail(`heightfield layers failed at ${tileX},${tileY}`);
      }
      freeCompactHeightfield(compact);
      if (layerSet.nlayers() > RECAST_GENERATION_CONFIG.expectedLayersPerTile) {
        freeHeightfieldLayerSet(layerSet);
        fail(`layer capacity exhausted at ${tileX},${tileY}`);
      }
      for (let layer = 0; layer < layerSet.nlayers(); layer += 1) {
        const heightfieldLayer = layerSet.layers(layer);
        const tile = new TileCacheData();
        const header = new Raw.dtTileCacheLayerHeader();
        header.magic = Detour.DT_TILECACHE_MAGIC;
        header.version = Detour.DT_TILECACHE_VERSION;
        header.tx = tileX;
        header.ty = tileY;
        header.tlayer = layer;
        const min = heightfieldLayer.bmin();
        const max = heightfieldLayer.bmax();
        header.set_bmin(0, min.x);
        header.set_bmin(1, min.y);
        header.set_bmin(2, min.z);
        header.set_bmax(0, max.x);
        header.set_bmax(1, max.y);
        header.set_bmax(2, max.z);
        header.width = heightfieldLayer.width();
        header.height = heightfieldLayer.height();
        header.minx = heightfieldLayer.minx();
        header.maxx = heightfieldLayer.maxx();
        header.miny = heightfieldLayer.miny();
        header.maxy = heightfieldLayer.maxy();
        header.hmin = heightfieldLayer.hmin();
        header.hmax = heightfieldLayer.hmax();
        const status = buildTileCacheLayer(compressor, header, getHeightfieldLayerHeights(heightfieldLayer), getHeightfieldLayerAreas(heightfieldLayer), getHeightfieldLayerCons(heightfieldLayer), tile);
        if (statusFailed(status)) {
          tile.destroy();
          freeHeightfieldLayerSet(layerSet);
          fail(`compressed layer build failed at ${tileX},${tileY},${layer}`);
        }
        compressedLayers.set(layerKey(tileX, tileY, layer), tile.toTypedArray().slice());
        tile.destroy();
      }
      freeHeightfieldLayerSet(layerSet);
    }
    const rasterizeMs = now() - rasterizeStarted;

    const navMeshBuildStarted = now();
    for (let y = 0; y < tileHeight; y += 1) {
      for (let x = 0; x < tileWidth; x += 1) {
        for (let layer = 0; layer < RECAST_GENERATION_CONFIG.expectedLayersPerTile; layer += 1) {
          const bytes = compressedLayers.get(layerKey(x, y, layer));
          if (!bytes) continue;
          const data = new TileCacheData();
          data.copy(new Uint8Array(bytes));
          const added = tileCache.addTile(data);
          // TileCache owns the copied allocation after addTile, matching generateTileCache.
          if (statusFailed(added.status)) fail(`tile add failed at ${x},${y},${layer}`);
        }
      }
    }
    for (let y = 0; y < tileHeight; y += 1) {
      for (let x = 0; x < tileWidth; x += 1) {
        if (statusFailed(tileCache.buildNavMeshTilesAt(x, y, navMesh))) fail(`navmesh tile build failed at ${x},${y}`);
      }
    }
    const update = tileCache.update(navMesh);
    if (!update.success || !update.upToDate) fail("initial TileCache update did not reach upToDate");
    const navMeshBuildMs = now() - navMeshBuildStarted;
    cleanupArrays();
    const compressedLayerBytes = [...compressedLayers.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    return {
      entry: { revision, passable: passable.slice(), navMesh, tileCache, compressedLayers, resources },
      metrics: {
        changedCells,
        changedNavTiles,
        rasterizedNavTiles: touched.size,
        reusedCompressedLayers,
        compressedLayers: compressedLayers.size,
        compressedLayerBytes,
        geometryMs,
        rasterizeMs,
        navMeshBuildMs,
        totalMs: now() - started,
        maxChunksOverlapping,
      },
    };
  } catch (error) {
    cleanupArrays();
    tileCache.destroy();
    navMesh.destroy();
    throw error;
  }
}

export function destroyExactTileCache(entry: ExactTileCacheEntry): void {
  entry.tileCache.destroy();
  entry.navMesh.destroy();
}

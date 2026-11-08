import {
  ChunkIdsArray,
  Detour,
  DetourTileCacheParams,
  NavMesh,
  NavMeshCreateParams,
  NavMeshParams,
  Raw,
  Recast,
  RecastBuildContext,
  RecastChunkyTriMesh,
  TileCache,
  TileCacheData,
  TileCacheMeshProcess,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocContourSet,
  allocHeightfield,
  allocHeightfieldLayerSet,
  allocPolyMesh,
  allocPolyMeshDetail,
  buildCompactHeightfield,
  buildContours,
  buildDistanceField,
  buildHeightfieldLayers,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  buildTileCacheLayer,
  calcGridSize,
  cloneRcConfig,
  createHeightfield,
  createNavMeshData,
  createRcConfig,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freeHeightfieldLayerSet,
  freePolyMesh,
  freePolyMeshDetail,
  getHeightfieldLayerAreas,
  getHeightfieldLayerCons,
  getHeightfieldLayerHeights,
  markWalkableTriangles,
  rasterizeTriangles,
  recastConfigDefaults,
  statusFailed,
  statusToReadableString,
  vec3
} from "./chunk-6TMFGFBU.js";
import "./chunk-PZ5AY32C.js";

// scratch/donor-audit/browser/voidstrike/node_modules/@recast-navigation/generators/dist/index.mjs
var getBoundingBox = (positions, indices) => {
  const bbMin = {
    x: Infinity,
    y: Infinity,
    z: Infinity
  };
  const bbMax = {
    x: -Infinity,
    y: -Infinity,
    z: -Infinity
  };
  for (let i = 0; i < indices.length; i++) {
    const ind = indices[i];
    const x = positions[ind * 3];
    const y = positions[ind * 3 + 1];
    const z = positions[ind * 3 + 2];
    bbMin.x = Math.min(bbMin.x, x);
    bbMin.y = Math.min(bbMin.y, y);
    bbMin.z = Math.min(bbMin.z, z);
    bbMax.x = Math.max(bbMax.x, x);
    bbMax.y = Math.max(bbMax.y, y);
    bbMax.z = Math.max(bbMax.z, z);
  }
  return {
    bbMin: vec3.toArray(bbMin),
    bbMax: vec3.toArray(bbMax)
  };
};
var dtIlog2 = (v) => {
  let r = 0;
  let shift = 0;
  r = Number(v > 65535) << 4;
  v >>= r;
  shift = Number(v > 255) << 3;
  v >>= shift;
  r |= shift;
  shift = Number(v > 15) << 2;
  v >>= shift;
  r |= shift;
  shift = Number(v > 3) << 1;
  v >>= shift;
  r |= shift;
  r |= v >> 1;
  return r;
};
var dtNextPow2 = (v) => {
  v--;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  v++;
  return v;
};
var soloNavMeshGeneratorConfigDefaults = {
  ...recastConfigDefaults,
  buildBvTree: true
};
var generateSoloNavMeshData = (positions, indices, navMeshGeneratorConfig = {}, keepIntermediates = false) => {
  const buildContext = new RecastBuildContext();
  const intermediates = {
    type: "solo",
    buildContext
  };
  const cleanup = () => {
    if (keepIntermediates) return;
    if (intermediates.heightfield) {
      freeHeightfield(intermediates.heightfield);
      intermediates.heightfield = void 0;
    }
    if (intermediates.compactHeightfield) {
      freeCompactHeightfield(intermediates.compactHeightfield);
      intermediates.compactHeightfield = void 0;
    }
    if (intermediates.contourSet) {
      freeContourSet(intermediates.contourSet);
      intermediates.contourSet = void 0;
    }
    if (intermediates.polyMesh) {
      freePolyMesh(intermediates.polyMesh);
      intermediates.polyMesh = void 0;
    }
    if (intermediates.polyMeshDetail) {
      freePolyMeshDetail(intermediates.polyMeshDetail);
      intermediates.polyMeshDetail = void 0;
    }
  };
  const fail = (error) => {
    cleanup();
    return {
      navMeshData: void 0,
      success: false,
      intermediates,
      error
    };
  };
  const vertices = positions;
  const numVertices = indices.length;
  const verticesArray = new VerticesArray();
  verticesArray.copy(vertices);
  const triangles = indices;
  const numTriangles = indices.length / 3;
  const trianglesArray = new TrianglesArray();
  trianglesArray.copy(triangles);
  let bbMin;
  let bbMax;
  if (navMeshGeneratorConfig.bounds) {
    bbMin = navMeshGeneratorConfig.bounds[0];
    bbMax = navMeshGeneratorConfig.bounds[1];
  } else {
    const boundingBox = getBoundingBox(positions, indices);
    bbMin = boundingBox.bbMin;
    bbMax = boundingBox.bbMax;
  }
  const config = {
    ...soloNavMeshGeneratorConfigDefaults,
    ...navMeshGeneratorConfig
  };
  const rcConfig = createRcConfig(config);
  rcConfig.minRegionArea = rcConfig.minRegionArea * rcConfig.minRegionArea;
  rcConfig.mergeRegionArea = rcConfig.mergeRegionArea * rcConfig.mergeRegionArea;
  rcConfig.detailSampleDist = rcConfig.detailSampleDist < 0.9 ? 0 : rcConfig.cs * rcConfig.detailSampleDist;
  rcConfig.detailSampleMaxError = rcConfig.ch * rcConfig.detailSampleMaxError;
  const gridSize = calcGridSize(bbMin, bbMax, rcConfig.cs);
  rcConfig.width = gridSize.width;
  rcConfig.height = gridSize.height;
  const heightfield = allocHeightfield();
  intermediates.heightfield = heightfield;
  if (!createHeightfield(buildContext, heightfield, rcConfig.width, rcConfig.height, bbMin, bbMax, rcConfig.cs, rcConfig.ch)) {
    return fail("Could not create heightfield");
  }
  const triangleAreasArray = new TriangleAreasArray();
  triangleAreasArray.resize(numTriangles);
  markWalkableTriangles(buildContext, rcConfig.walkableSlopeAngle, verticesArray, numVertices, trianglesArray, numTriangles, triangleAreasArray);
  if (!rasterizeTriangles(buildContext, verticesArray, numVertices, trianglesArray, triangleAreasArray, numTriangles, heightfield, rcConfig.walkableClimb)) {
    return fail("Could not rasterize triangles");
  }
  triangleAreasArray.destroy();
  verticesArray.destroy();
  trianglesArray.destroy();
  filterLowHangingWalkableObstacles(buildContext, rcConfig.walkableClimb, heightfield);
  filterLedgeSpans(buildContext, rcConfig.walkableHeight, rcConfig.walkableClimb, heightfield);
  filterWalkableLowHeightSpans(buildContext, rcConfig.walkableHeight, heightfield);
  const compactHeightfield = allocCompactHeightfield();
  intermediates.compactHeightfield = compactHeightfield;
  if (!buildCompactHeightfield(buildContext, rcConfig.walkableHeight, rcConfig.walkableClimb, heightfield, compactHeightfield)) {
    return fail("Failed to build compact data");
  }
  if (!keepIntermediates) {
    freeHeightfield(heightfield);
    intermediates.heightfield = void 0;
  }
  if (!erodeWalkableArea(buildContext, rcConfig.walkableRadius, compactHeightfield)) {
    return fail("Failed to erode walkable area");
  }
  if (!buildDistanceField(buildContext, compactHeightfield)) {
    return fail("Failed to build distance field");
  }
  if (!buildRegions(buildContext, compactHeightfield, rcConfig.borderSize, rcConfig.minRegionArea, rcConfig.mergeRegionArea)) {
    return fail("Failed to build regions");
  }
  const contourSet = allocContourSet();
  intermediates.contourSet = contourSet;
  if (!buildContours(buildContext, compactHeightfield, rcConfig.maxSimplificationError, rcConfig.maxEdgeLen, contourSet, Recast.RC_CONTOUR_TESS_WALL_EDGES)) {
    return fail("Failed to create contours");
  }
  const polyMesh = allocPolyMesh();
  intermediates.polyMesh = polyMesh;
  if (!buildPolyMesh(buildContext, contourSet, rcConfig.maxVertsPerPoly, polyMesh)) {
    return fail("Failed to triangulate contours");
  }
  const polyMeshDetail = allocPolyMeshDetail();
  intermediates.polyMeshDetail = polyMeshDetail;
  if (!buildPolyMeshDetail(buildContext, polyMesh, compactHeightfield, rcConfig.detailSampleDist, rcConfig.detailSampleMaxError, polyMeshDetail)) {
    return fail("Failed to build detail mesh");
  }
  if (!keepIntermediates) {
    freeCompactHeightfield(compactHeightfield);
    intermediates.compactHeightfield = void 0;
    freeContourSet(contourSet);
    intermediates.contourSet = void 0;
  }
  for (let i = 0; i < polyMesh.npolys(); i++) {
    if (polyMesh.areas(i) === Recast.RC_WALKABLE_AREA) {
      polyMesh.setAreas(i, 0);
    }
    if (polyMesh.areas(i) === 0) {
      polyMesh.setFlags(i, 1);
    }
  }
  const navMeshCreateParams = new NavMeshCreateParams();
  navMeshCreateParams.setPolyMeshCreateParams(polyMesh);
  navMeshCreateParams.setPolyMeshDetailCreateParams(polyMeshDetail);
  navMeshCreateParams.setWalkableHeight(rcConfig.walkableHeight * rcConfig.ch);
  navMeshCreateParams.setWalkableRadius(rcConfig.walkableRadius * rcConfig.cs);
  navMeshCreateParams.setWalkableClimb(rcConfig.walkableClimb * rcConfig.ch);
  navMeshCreateParams.setCellSize(rcConfig.cs);
  navMeshCreateParams.setCellHeight(rcConfig.ch);
  navMeshCreateParams.setBuildBvTree(config.buildBvTree);
  if (navMeshGeneratorConfig.offMeshConnections) {
    navMeshCreateParams.setOffMeshConnections(navMeshGeneratorConfig.offMeshConnections);
  }
  const createNavMeshDataResult = createNavMeshData(navMeshCreateParams);
  if (!createNavMeshDataResult.success) {
    return fail("Failed to create Detour navmesh data");
  }
  cleanup();
  return {
    navMeshData: createNavMeshDataResult.navMeshData,
    success: true,
    intermediates
  };
};
var generateSoloNavMesh = (positions, indices, navMeshGeneratorConfig = {}, keepIntermediates = false) => {
  if (!Raw.Module) {
    throw new Error('"init" must be called before using any recast-navigation-js APIs. See: https://github.com/isaac-mason/recast-navigation-js?tab=readme-ov-file#initialization');
  }
  const createNavMeshDataResult = generateSoloNavMeshData(positions, indices, navMeshGeneratorConfig, keepIntermediates);
  if (!createNavMeshDataResult.success) {
    return {
      navMesh: void 0,
      success: false,
      intermediates: createNavMeshDataResult.intermediates,
      error: createNavMeshDataResult.error
    };
  }
  const {
    navMeshData
  } = createNavMeshDataResult;
  const navMesh = new NavMesh();
  if (!navMesh.initSolo(navMeshData)) {
    navMeshData.destroy();
    return {
      navMesh: void 0,
      success: false,
      intermediates: createNavMeshDataResult.intermediates,
      error: "Failed to initialize solo NavMesh"
    };
  }
  return {
    success: true,
    navMesh,
    intermediates: createNavMeshDataResult.intermediates
  };
};
var tileCacheGeneratorConfigDefaults = {
  ...recastConfigDefaults,
  tileSize: 32,
  expectedLayersPerTile: 4,
  maxObstacles: 128
};
var createDefaultTileCacheMeshProcess = () => new TileCacheMeshProcess((navMeshCreateParams, polyAreas, polyFlags) => {
  for (let i = 0; i < navMeshCreateParams.polyCount(); ++i) {
    polyAreas.set(i, 0);
    polyFlags.set(i, 1);
  }
});
var generateTileCache = (positions, indices, navMeshGeneratorConfig = {}, keepIntermediates = false) => {
  if (!Raw.Module) {
    throw new Error('"init" must be called before using any recast-navigation-js APIs. See: https://github.com/isaac-mason/recast-navigation-js?tab=readme-ov-file#initialization');
  }
  const buildContext = new RecastBuildContext();
  const intermediates = {
    type: "tilecache",
    buildContext,
    chunkyTriMesh: void 0,
    tileIntermediates: []
  };
  const tileCache = new TileCache();
  const navMesh = new NavMesh();
  const vertices = positions;
  const numVertices = indices.length;
  const verticesArray = new VerticesArray();
  verticesArray.copy(vertices);
  const triangles = indices;
  const numTriangles = indices.length / 3;
  const trianglesArray = new TrianglesArray();
  trianglesArray.copy(triangles);
  let bbMin;
  let bbMax;
  if (navMeshGeneratorConfig.bounds) {
    bbMin = navMeshGeneratorConfig.bounds[0];
    bbMax = navMeshGeneratorConfig.bounds[1];
  } else {
    const boundingBox = getBoundingBox(positions, indices);
    bbMin = boundingBox.bbMin;
    bbMax = boundingBox.bbMax;
  }
  const {
    expectedLayersPerTile,
    maxObstacles,
    ...recastConfig
  } = {
    ...tileCacheGeneratorConfigDefaults,
    ...navMeshGeneratorConfig
  };
  const cleanup = () => {
    verticesArray.destroy();
    trianglesArray.destroy();
    if (!keepIntermediates) {
      for (let i = 0; i < intermediates.tileIntermediates.length; i++) {
        const tileIntermediate = intermediates.tileIntermediates[i];
        if (tileIntermediate.heightfield) {
          freeHeightfield(tileIntermediate.heightfield);
          tileIntermediate.heightfield = void 0;
        }
        if (tileIntermediate.compactHeightfield) {
          freeCompactHeightfield(tileIntermediate.compactHeightfield);
          tileIntermediate.compactHeightfield = void 0;
        }
        if (tileIntermediate.heightfieldLayerSet) {
          freeHeightfieldLayerSet(tileIntermediate.heightfieldLayerSet);
          tileIntermediate.heightfieldLayerSet = void 0;
        }
      }
    }
  };
  const fail = (error) => {
    cleanup();
    tileCache.destroy();
    navMesh.destroy();
    return {
      success: false,
      navMesh: void 0,
      tileCache: void 0,
      intermediates,
      error
    };
  };
  const config = createRcConfig(recastConfig);
  const gridSize = calcGridSize(bbMin, bbMax, config.cs);
  config.width = gridSize.width;
  config.height = gridSize.height;
  config.minRegionArea = config.minRegionArea * config.minRegionArea;
  config.mergeRegionArea = config.mergeRegionArea * config.mergeRegionArea;
  config.detailSampleDist = config.detailSampleDist < 0.9 ? 0 : config.cs * config.detailSampleDist;
  config.detailSampleMaxError = config.ch * config.detailSampleMaxError;
  const tileSize = Math.floor(config.tileSize);
  const tileWidth = Math.floor((config.width + tileSize - 1) / tileSize);
  const tileHeight = Math.floor((config.height + tileSize - 1) / tileSize);
  config.borderSize = config.walkableRadius + 3;
  config.width = config.tileSize + config.borderSize * 2;
  config.height = config.tileSize + config.borderSize * 2;
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
    maxTiles: tileWidth * tileHeight * expectedLayersPerTile,
    maxObstacles
  });
  const allocator = new Raw.RecastLinearAllocator(32e3);
  const compressor = new Raw.RecastFastLZCompressor();
  const tileCacheMeshProcess = navMeshGeneratorConfig.tileCacheMeshProcess ?? createDefaultTileCacheMeshProcess();
  if (!tileCache.init(tileCacheParams, allocator, compressor, tileCacheMeshProcess)) {
    return fail("Failed to initialize tile cache");
  }
  const orig = vec3.fromArray(bbMin);
  let tileBits = Math.min(Math.floor(dtIlog2(dtNextPow2(tileWidth * tileHeight * expectedLayersPerTile))), 14);
  if (tileBits > 14) {
    tileBits = 14;
  }
  const polyBits = 22 - tileBits;
  const maxTiles = 1 << tileBits;
  const maxPolysPerTile = 1 << polyBits;
  const navMeshParams = NavMeshParams.create({
    orig,
    tileWidth: config.tileSize * config.cs,
    tileHeight: config.tileSize * config.cs,
    maxTiles,
    maxPolys: maxPolysPerTile
  });
  if (!navMesh.initTiled(navMeshParams)) {
    return fail("Failed to initialize tiled navmesh");
  }
  const chunkyTriMesh = new RecastChunkyTriMesh();
  intermediates.chunkyTriMesh = chunkyTriMesh;
  if (!chunkyTriMesh.init(verticesArray, trianglesArray, numTriangles, 256)) {
    return fail("Failed to build chunky triangle mesh");
  }
  const rasterizeTileLayers = (tileX, tileY) => {
    const tileIntermediates = {
      tileX,
      tileY
    };
    const tcs = config.tileSize * config.cs;
    const tileConfig = cloneRcConfig(config);
    const tileBoundsMin = [bbMin[0] + tileX * tcs, bbMin[1], bbMin[2] + tileY * tcs];
    const tileBoundsMax = [bbMin[0] + (tileX + 1) * tcs, bbMax[1], bbMin[2] + (tileY + 1) * tcs];
    tileBoundsMin[0] -= tileConfig.borderSize * tileConfig.cs;
    tileBoundsMin[2] -= tileConfig.borderSize * tileConfig.cs;
    tileBoundsMax[0] += tileConfig.borderSize * tileConfig.cs;
    tileBoundsMax[2] += tileConfig.borderSize * tileConfig.cs;
    tileConfig.set_bmin(0, tileBoundsMin[0]);
    tileConfig.set_bmin(1, tileBoundsMin[1]);
    tileConfig.set_bmin(2, tileBoundsMin[2]);
    tileConfig.set_bmax(0, tileBoundsMax[0]);
    tileConfig.set_bmax(1, tileBoundsMax[1]);
    tileConfig.set_bmax(2, tileBoundsMax[2]);
    const heightfield = allocHeightfield();
    tileIntermediates.heightfield = heightfield;
    if (!createHeightfield(buildContext, heightfield, tileConfig.width, tileConfig.height, tileBoundsMin, tileBoundsMax, tileConfig.cs, tileConfig.ch)) {
      return {
        n: 0
      };
    }
    const tbmin = [tileBoundsMin[0], tileBoundsMin[2]];
    const tbmax = [tileBoundsMax[0], tileBoundsMax[2]];
    const maxChunkIds = 512;
    const chunkIdsArray = new ChunkIdsArray();
    chunkIdsArray.resize(maxChunkIds);
    const nChunksOverlapping = chunkyTriMesh.getChunksOverlappingRect(tbmin, tbmax, chunkIdsArray, maxChunkIds);
    if (nChunksOverlapping === 0) {
      return {
        n: 0
      };
    }
    for (let i = 0; i < nChunksOverlapping; ++i) {
      const nodeId = chunkIdsArray.get(i);
      const node = chunkyTriMesh.nodes(nodeId);
      const nNodeTris = node.n;
      const nodeTrianglesArray = chunkyTriMesh.getNodeTris(nodeId);
      const triangleAreasArray = new TriangleAreasArray();
      triangleAreasArray.resize(nNodeTris);
      markWalkableTriangles(buildContext, tileConfig.walkableSlopeAngle, verticesArray, numVertices, nodeTrianglesArray, nNodeTris, triangleAreasArray);
      const success = rasterizeTriangles(buildContext, verticesArray, numVertices, nodeTrianglesArray, triangleAreasArray, nNodeTris, heightfield, tileConfig.walkableClimb);
      triangleAreasArray.destroy();
      if (!success) {
        return {
          n: 0
        };
      }
    }
    filterLowHangingWalkableObstacles(buildContext, config.walkableClimb, heightfield);
    filterLedgeSpans(buildContext, config.walkableHeight, config.walkableClimb, heightfield);
    filterWalkableLowHeightSpans(buildContext, config.walkableHeight, heightfield);
    const compactHeightfield = allocCompactHeightfield();
    if (!buildCompactHeightfield(buildContext, config.walkableHeight, config.walkableClimb, heightfield, compactHeightfield)) {
      return {
        n: 0
      };
    }
    if (!keepIntermediates) {
      freeHeightfield(tileIntermediates.heightfield);
      tileIntermediates.heightfield = void 0;
    }
    if (!erodeWalkableArea(buildContext, config.walkableRadius, compactHeightfield)) {
      return {
        n: 0
      };
    }
    const heightfieldLayerSet = allocHeightfieldLayerSet();
    if (!buildHeightfieldLayers(buildContext, compactHeightfield, config.borderSize, config.walkableHeight, heightfieldLayerSet)) {
      return {
        n: 0
      };
    }
    if (!keepIntermediates) {
      freeCompactHeightfield(compactHeightfield);
      tileIntermediates.compactHeightfield = void 0;
    }
    const tiles = [];
    for (let i = 0; i < heightfieldLayerSet.nlayers(); i++) {
      const tile = new TileCacheData();
      const heightfieldLayer = heightfieldLayerSet.layers(i);
      const header = new Raw.dtTileCacheLayerHeader();
      header.magic = Detour.DT_TILECACHE_MAGIC;
      header.version = Detour.DT_TILECACHE_VERSION;
      header.tx = tileX;
      header.ty = tileY;
      header.tlayer = i;
      const heightfieldLayerBin = heightfieldLayer.bmin();
      const heightfieldLayerBmax = heightfieldLayer.bmax();
      header.set_bmin(0, heightfieldLayerBin.x);
      header.set_bmin(1, heightfieldLayerBin.y);
      header.set_bmin(2, heightfieldLayerBin.z);
      header.set_bmax(0, heightfieldLayerBmax.x);
      header.set_bmax(1, heightfieldLayerBmax.y);
      header.set_bmax(2, heightfieldLayerBmax.z);
      header.width = heightfieldLayer.width();
      header.height = heightfieldLayer.height();
      header.minx = heightfieldLayer.minx();
      header.maxx = heightfieldLayer.maxx();
      header.miny = heightfieldLayer.miny();
      header.maxy = heightfieldLayer.maxy();
      header.hmin = heightfieldLayer.hmin();
      header.hmax = heightfieldLayer.hmax();
      const heights = getHeightfieldLayerHeights(heightfieldLayer);
      const areas = getHeightfieldLayerAreas(heightfieldLayer);
      const cons = getHeightfieldLayerCons(heightfieldLayer);
      const status = buildTileCacheLayer(compressor, header, heights, areas, cons, tile);
      if (statusFailed(status)) {
        return {
          n: 0
        };
      }
      tiles.push(tile);
    }
    if (!keepIntermediates) {
      freeHeightfieldLayerSet(heightfieldLayerSet);
      tileIntermediates.heightfieldLayerSet = void 0;
    }
    intermediates.tileIntermediates.push(tileIntermediates);
    return {
      n: tiles.length,
      tiles
    };
  };
  for (let y = 0; y < tileHeight; ++y) {
    for (let x = 0; x < tileWidth; ++x) {
      const {
        n,
        tiles: newTiles
      } = rasterizeTileLayers(x, y);
      if (n > 0 && newTiles) {
        for (let i = 0; i < n; i++) {
          const tileCacheData = newTiles[i];
          const addResult = tileCache.addTile(tileCacheData);
          if (statusFailed(addResult.status)) {
            buildContext.log(Recast.RC_LOG_WARNING, `Failed to add tile to tile cache - tx: ${x}, ty: ${y}`);
          }
        }
      }
    }
  }
  for (let y = 0; y < tileHeight; y++) {
    for (let x = 0; x < tileWidth; x++) {
      const dtStatus = tileCache.buildNavMeshTilesAt(x, y, navMesh);
      if (statusFailed(dtStatus)) {
        return fail(`Failed to build nav mesh tiles at ${x}, ${y}`);
      }
    }
  }
  cleanup();
  return {
    success: true,
    tileCache,
    navMesh,
    intermediates
  };
};
var buildTiledNavMeshRcConfig = ({
  recastConfig,
  navMeshBounds: [navMeshBoundsMin, navMeshBoundsMax]
}) => {
  const config = createRcConfig(recastConfig);
  const gridSize = calcGridSize(navMeshBoundsMin, navMeshBoundsMax, config.cs);
  config.width = gridSize.width;
  config.height = gridSize.height;
  config.minRegionArea = config.minRegionArea * config.minRegionArea;
  config.mergeRegionArea = config.mergeRegionArea * config.mergeRegionArea;
  config.tileSize = Math.floor(config.tileSize);
  config.borderSize = config.walkableRadius + 3;
  config.width = config.tileSize + config.borderSize * 2;
  config.height = config.tileSize + config.borderSize * 2;
  config.detailSampleDist = config.detailSampleDist < 0.9 ? 0 : config.cs * config.detailSampleDist;
  config.detailSampleMaxError = config.ch * config.detailSampleMaxError;
  const tileSize = Math.floor(config.tileSize);
  const tileWidth = Math.floor((gridSize.width + tileSize - 1) / tileSize);
  const tileHeight = Math.floor((gridSize.height + tileSize - 1) / tileSize);
  const tcs = config.tileSize * config.cs;
  const orig = vec3.fromArray(navMeshBoundsMin);
  let tileBits = Math.min(Math.floor(dtIlog2(dtNextPow2(tileWidth * tileHeight))), 14);
  if (tileBits > 14) tileBits = 14;
  const polyBits = 22 - tileBits;
  const maxTiles = 1 << tileBits;
  const maxPolysPerTile = 1 << polyBits;
  return {
    config,
    gridSize,
    tileSize,
    tileWidth,
    tileHeight,
    tcs,
    orig,
    maxTiles,
    maxPolysPerTile
  };
};
var tiledNavMeshGeneratorConfigDefaults = {
  ...recastConfigDefaults,
  chunkyTriMeshTrisPerChunk: 256,
  buildBvTree: true
};
var generateTileNavMeshData = (positions, indices, rcConfig, chunkyTriMesh, tile, options = {}, keepIntermediates = false, buildContext = new RecastBuildContext()) => {
  const tileIntermediate = {
    x: tile.x,
    y: tile.y
  };
  const cleanup = () => {
    if (keepIntermediates) return;
    if (tileIntermediate.compactHeightfield) {
      freeCompactHeightfield(tileIntermediate.compactHeightfield);
      tileIntermediate.compactHeightfield = void 0;
    }
    if (tileIntermediate.heightfield) {
      freeHeightfield(tileIntermediate.heightfield);
      tileIntermediate.heightfield = void 0;
    }
    if (tileIntermediate.contourSet) {
      freeContourSet(tileIntermediate.contourSet);
      tileIntermediate.contourSet = void 0;
    }
    if (tileIntermediate.polyMesh) {
      freePolyMesh(tileIntermediate.polyMesh);
      tileIntermediate.polyMesh = void 0;
    }
    if (tileIntermediate.polyMeshDetail) {
      freePolyMeshDetail(tileIntermediate.polyMeshDetail);
      tileIntermediate.polyMeshDetail = void 0;
    }
  };
  const failTileMesh = (error) => {
    buildContext.log(Recast.RC_LOG_ERROR, error);
    cleanup();
    return {
      success: false,
      error,
      intermediates: tileIntermediate
    };
  };
  const tileConfig = cloneRcConfig(rcConfig);
  const expandedTileBoundsMin = [...tile.bmin];
  const expandedTileBoundsMax = [...tile.bmax];
  expandedTileBoundsMin[0] -= tileConfig.borderSize * tileConfig.cs;
  expandedTileBoundsMin[2] -= tileConfig.borderSize * tileConfig.cs;
  expandedTileBoundsMax[0] += tileConfig.borderSize * tileConfig.cs;
  expandedTileBoundsMax[2] += tileConfig.borderSize * tileConfig.cs;
  tileConfig.set_bmin(0, expandedTileBoundsMin[0]);
  tileConfig.set_bmin(1, expandedTileBoundsMin[1]);
  tileConfig.set_bmin(2, expandedTileBoundsMin[2]);
  tileConfig.set_bmax(0, expandedTileBoundsMax[0]);
  tileConfig.set_bmax(1, expandedTileBoundsMax[1]);
  tileConfig.set_bmax(2, expandedTileBoundsMax[2]);
  buildContext.resetTimers();
  buildContext.startTimer(Recast.RC_TIMER_TOTAL);
  buildContext.log(Recast.RC_LOG_PROGRESS, `Building tile at x: ${tile.x}, y: ${tile.y}`);
  buildContext.log(Recast.RC_LOG_PROGRESS, ` - ${tileConfig.width} x ${tileConfig.height} cells`);
  buildContext.log(Recast.RC_LOG_PROGRESS, ` - ${positions.size / 3 / 1e3}K verts, ${indices.size / 3 / 1e3}K tris`);
  const heightfield = allocHeightfield();
  tileIntermediate.heightfield = heightfield;
  if (!createHeightfield(buildContext, heightfield, tileConfig.width, tileConfig.height, expandedTileBoundsMin, expandedTileBoundsMax, tileConfig.cs, tileConfig.ch)) {
    return failTileMesh("Could not create heightfield");
  }
  const triAreas = new TriangleAreasArray();
  triAreas.resize(chunkyTriMesh.maxTrisPerChunk());
  const tbmin = [expandedTileBoundsMin[0], expandedTileBoundsMin[2]];
  const tbmax = [expandedTileBoundsMax[0], expandedTileBoundsMax[2]];
  const maxChunkIds = 512;
  const chunkIdsArray = new ChunkIdsArray();
  chunkIdsArray.resize(maxChunkIds);
  const nChunksOverlapping = chunkyTriMesh.getChunksOverlappingRect(tbmin, tbmax, chunkIdsArray, maxChunkIds);
  if (nChunksOverlapping === 0) {
    return {
      success: true,
      intermediates: tileIntermediate
    };
  }
  for (let i = 0; i < nChunksOverlapping; ++i) {
    const nodeId = chunkIdsArray.get(i);
    const node = chunkyTriMesh.nodes(nodeId);
    const nNodeTris = node.n;
    const nodeTrianglesArray = chunkyTriMesh.getNodeTris(nodeId);
    const triangleAreasArray = new TriangleAreasArray();
    triangleAreasArray.resize(nNodeTris);
    markWalkableTriangles(buildContext, tileConfig.walkableSlopeAngle, positions, indices.size, nodeTrianglesArray, nNodeTris, triangleAreasArray);
    const success = rasterizeTriangles(buildContext, positions, indices.size, nodeTrianglesArray, triangleAreasArray, nNodeTris, heightfield, tileConfig.walkableClimb);
    triangleAreasArray.destroy();
    if (!success) {
      return failTileMesh("Could not rasterize triangles");
    }
  }
  filterLowHangingWalkableObstacles(buildContext, tileConfig.walkableClimb, heightfield);
  filterLedgeSpans(buildContext, tileConfig.walkableHeight, tileConfig.walkableClimb, heightfield);
  filterWalkableLowHeightSpans(buildContext, tileConfig.walkableHeight, heightfield);
  const compactHeightfield = allocCompactHeightfield();
  tileIntermediate.compactHeightfield = compactHeightfield;
  if (!buildCompactHeightfield(buildContext, tileConfig.walkableHeight, tileConfig.walkableClimb, heightfield, compactHeightfield)) {
    return failTileMesh("Could not build compact heightfield");
  }
  if (!keepIntermediates) {
    freeHeightfield(tileIntermediate.heightfield);
    tileIntermediate.heightfield = void 0;
  }
  if (!erodeWalkableArea(buildContext, tileConfig.walkableRadius, compactHeightfield)) {
    return failTileMesh("Could not erode walkable area");
  }
  if (!buildDistanceField(buildContext, compactHeightfield)) {
    return failTileMesh("Failed to build distance field");
  }
  if (!buildRegions(buildContext, compactHeightfield, tileConfig.borderSize, tileConfig.minRegionArea, tileConfig.mergeRegionArea)) {
    return failTileMesh("Failed to build regions");
  }
  const contourSet = allocContourSet();
  tileIntermediate.contourSet = contourSet;
  if (!buildContours(buildContext, compactHeightfield, tileConfig.maxSimplificationError, tileConfig.maxEdgeLen, contourSet, Recast.RC_CONTOUR_TESS_WALL_EDGES)) {
    return failTileMesh("Failed to create contours");
  }
  const polyMesh = allocPolyMesh();
  tileIntermediate.polyMesh = polyMesh;
  if (!buildPolyMesh(buildContext, contourSet, tileConfig.maxVertsPerPoly, polyMesh)) {
    return failTileMesh("Failed to triangulate contours");
  }
  const polyMeshDetail = allocPolyMeshDetail();
  tileIntermediate.polyMeshDetail = polyMeshDetail;
  if (!buildPolyMeshDetail(buildContext, polyMesh, compactHeightfield, tileConfig.detailSampleDist, tileConfig.detailSampleMaxError, polyMeshDetail)) {
    return failTileMesh("Failed to build detail mesh");
  }
  if (!keepIntermediates) {
    freeCompactHeightfield(compactHeightfield);
    tileIntermediate.compactHeightfield = void 0;
    freeContourSet(contourSet);
    tileIntermediate.contourSet = void 0;
  }
  for (let i = 0; i < polyMesh.npolys(); i++) {
    if (polyMesh.areas(i) === Recast.RC_WALKABLE_AREA) {
      polyMesh.setAreas(i, 0);
    }
    if (polyMesh.areas(i) === 0) {
      polyMesh.setFlags(i, 1);
    }
  }
  const navMeshCreateParams = new NavMeshCreateParams();
  navMeshCreateParams.setPolyMeshCreateParams(polyMesh);
  navMeshCreateParams.setPolyMeshDetailCreateParams(polyMeshDetail);
  navMeshCreateParams.setWalkableHeight(tileConfig.walkableHeight * tileConfig.ch);
  navMeshCreateParams.setWalkableRadius(tileConfig.walkableRadius * tileConfig.cs);
  navMeshCreateParams.setWalkableClimb(tileConfig.walkableClimb * tileConfig.ch);
  navMeshCreateParams.setCellSize(tileConfig.cs);
  navMeshCreateParams.setCellHeight(tileConfig.ch);
  navMeshCreateParams.setBuildBvTree(options.buildBvTree ?? tiledNavMeshGeneratorConfigDefaults.buildBvTree);
  if (options.offMeshConnections) {
    navMeshCreateParams.setOffMeshConnections(options.offMeshConnections);
  }
  navMeshCreateParams.setTileX(tile.x);
  navMeshCreateParams.setTileY(tile.y);
  const createNavMeshDataResult = createNavMeshData(navMeshCreateParams);
  if (!createNavMeshDataResult.success) {
    return failTileMesh("Failed to create Detour navmesh data");
  }
  buildContext.log(Recast.RC_LOG_PROGRESS, `>> Polymesh: ${polyMesh.nverts()} vertices  ${polyMesh.npolys()} polygons`);
  return {
    success: true,
    data: createNavMeshDataResult.navMeshData,
    intermediates: tileIntermediate
  };
};
var generateTiledNavMesh = (positions, indices, navMeshGeneratorConfig = {}, keepIntermediates = false) => {
  if (!Raw.Module) {
    throw new Error('"init" must be called before using any recast-navigation-js APIs. See: https://github.com/isaac-mason/recast-navigation-js?tab=readme-ov-file#initialization');
  }
  const buildContext = new RecastBuildContext();
  const intermediates = {
    type: "tiled",
    buildContext,
    chunkyTriMesh: void 0,
    tileIntermediates: []
  };
  const navMesh = new NavMesh();
  const vertices = positions;
  const verticesArray = new VerticesArray();
  verticesArray.copy(vertices);
  const triangles = indices;
  const numTriangles = indices.length / 3;
  const trianglesArray = new TrianglesArray();
  trianglesArray.copy(triangles);
  const cleanup = () => {
    verticesArray.destroy();
    trianglesArray.destroy();
    if (keepIntermediates) return;
    if (intermediates.chunkyTriMesh) {
      intermediates.chunkyTriMesh = void 0;
    }
  };
  const fail = (error) => {
    cleanup();
    navMesh.destroy();
    return {
      success: false,
      navMesh: void 0,
      intermediates,
      error
    };
  };
  const generatorConfig = {
    ...tiledNavMeshGeneratorConfigDefaults,
    ...navMeshGeneratorConfig
  };
  let bbMin;
  let bbMax;
  if (navMeshGeneratorConfig.bounds) {
    bbMin = navMeshGeneratorConfig.bounds[0];
    bbMax = navMeshGeneratorConfig.bounds[1];
  } else {
    const boundingBox = getBoundingBox(positions, indices);
    bbMin = boundingBox.bbMin;
    bbMax = boundingBox.bbMax;
  }
  const {
    config: rcConfig,
    tileWidth,
    tileHeight,
    tcs,
    orig,
    maxTiles,
    maxPolysPerTile
  } = buildTiledNavMeshRcConfig({
    recastConfig: generatorConfig,
    navMeshBounds: [bbMin, bbMax]
  });
  const navMeshParams = NavMeshParams.create({
    orig,
    tileWidth: generatorConfig.tileSize * generatorConfig.cs,
    tileHeight: generatorConfig.tileSize * generatorConfig.cs,
    maxTiles,
    maxPolys: maxPolysPerTile
  });
  if (!navMesh.initTiled(navMeshParams)) {
    return fail("Could not init nav mesh for tiled use");
  }
  const chunkyTriMesh = new RecastChunkyTriMesh();
  intermediates.chunkyTriMesh = chunkyTriMesh;
  if (!chunkyTriMesh.init(verticesArray, trianglesArray, numTriangles, generatorConfig.chunkyTriMeshTrisPerChunk)) {
    return fail("Failed to build chunky triangle mesh");
  }
  buildContext.startTimer(Recast.RC_TIMER_TEMP);
  const lastBuiltTileBmin = [0, 0, 0];
  const lastBuiltTileBmax = [0, 0, 0];
  for (let y = 0; y < tileHeight; y++) {
    for (let x = 0; x < tileWidth; x++) {
      lastBuiltTileBmin[0] = bbMin[0] + x * tcs;
      lastBuiltTileBmin[1] = bbMin[1];
      lastBuiltTileBmin[2] = bbMin[2] + y * tcs;
      lastBuiltTileBmax[0] = bbMin[0] + (x + 1) * tcs;
      lastBuiltTileBmax[1] = bbMax[1];
      lastBuiltTileBmax[2] = bbMin[2] + (y + 1) * tcs;
      const tile = {
        x,
        y,
        bmin: lastBuiltTileBmin,
        bmax: lastBuiltTileBmax
      };
      const generatorOptions = {
        offMeshConnections: generatorConfig.offMeshConnections,
        buildBvTree: generatorConfig.buildBvTree
      };
      const result = generateTileNavMeshData(verticesArray, trianglesArray, rcConfig, chunkyTriMesh, tile, generatorOptions, keepIntermediates, buildContext);
      intermediates.tileIntermediates.push(result.intermediates);
      if (result.success && result.data) {
        navMesh.removeTile(navMesh.getTileRefAt(x, y, 0));
        const addTileResult = navMesh.addTile(result.data, Detour.DT_TILE_FREE_DATA, 0);
        if (statusFailed(addTileResult.status)) {
          buildContext.log(Recast.RC_LOG_WARNING, `Failed to add tile to nav mesh tx: ${x}, ty: ${y}, status: ${statusToReadableString(addTileResult.status)} (${addTileResult.status})`);
          result.data.destroy();
        }
      }
    }
  }
  buildContext.stopTimer(Recast.RC_TIMER_TEMP);
  if (!keepIntermediates) {
    cleanup();
  }
  return {
    success: true,
    navMesh,
    intermediates
  };
};
var mergePositionsAndIndices = (meshes) => {
  const mergedPositions = [];
  const mergedIndices = [];
  const positionToIndex = {};
  let indexCounter = 0;
  for (const {
    positions,
    indices
  } of meshes) {
    for (let i = 0; i < indices.length; i++) {
      const pt = indices[i] * 3;
      const x = positions[pt];
      const y = positions[pt + 1];
      const z = positions[pt + 2];
      const key = `${x}_${y}_${z}`;
      let idx = positionToIndex[key];
      if (!idx) {
        positionToIndex[key] = idx = indexCounter;
        mergedPositions.push(x, y, z);
        indexCounter++;
      }
      mergedIndices.push(idx);
    }
  }
  return [Float32Array.from(mergedPositions), Uint32Array.from(mergedIndices)];
};
export {
  buildTiledNavMeshRcConfig,
  createDefaultTileCacheMeshProcess,
  dtIlog2,
  dtNextPow2,
  generateSoloNavMesh,
  generateSoloNavMeshData,
  generateTileCache,
  generateTileNavMeshData,
  generateTiledNavMesh,
  getBoundingBox,
  mergePositionsAndIndices,
  soloNavMeshGeneratorConfigDefaults,
  tileCacheGeneratorConfigDefaults,
  tiledNavMeshGeneratorConfigDefaults
};
//# sourceMappingURL=@recast-navigation_generators.js.map

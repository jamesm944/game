import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getMapById } from '../browser/voidstrike/src/data/maps';
import {
  generateWalkableNavmeshGeometry,
  sampleNavMeshHeightMap,
} from '../browser/voidstrike/src/data/maps/navmesh/generateWalkableNavmeshGeometry';
import { RecastNavigation } from '../browser/voidstrike/src/engine/pathfinding/RecastNavigation';

function flatGeometry(size: number): { positions: Float32Array; indices: Uint32Array } {
  return {
    positions: new Float32Array([
      0, 0, 0,
      size, 0, 0,
      size, 0, size,
      0, 0, size,
    ]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

async function makeFlatNavigation(size: number): Promise<RecastNavigation> {
  RecastNavigation.resetInstance();
  const recast = RecastNavigation.getInstance();
  const geometry = flatGeometry(size);
  const generated = await recast.generateFromGeometry(
    geometry.positions,
    geometry.indices,
    size,
    size
  );
  if (!generated) throw new Error(`Flat ${size} navmesh generation failed`);
  return recast;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function crowdCapacity() {
  const recast = await makeFlatNavigation(32);
  const started = performance.now();
  const indices: number[] = [];
  for (let i = 1; i <= 2001; i++) {
    indices.push(recast.addAgent(i, 16, 16, 0.5, 3));
  }
  return {
    requested: 2001,
    accepted: indices.filter((index) => index >= 0).length,
    rejected: indices.filter((index) => index < 0).length,
    reportedCount: recast.getAgentCount(),
    firstRejectedRequest: indices.findIndex((index) => index < 0) + 1,
    elapsedMs: performance.now() - started,
  };
}

async function obstacleCapacity() {
  const recast = await makeFlatNavigation(64);
  const started = performance.now();
  for (let i = 1; i <= 513; i++) {
    recast.addObstacle(i, 32, 32, 0.2, 0.2);
  }
  return {
    requested: 513,
    reportedCount: recast.getObstacleCount(),
    elapsedMs: performance.now() - started,
  };
}

async function dynamicObstacleCycles() {
  RecastNavigation.resetInstance();
  const map = getMapById('crystal_caverns');
  if (!map) throw new Error('crystal_caverns not found');
  const geometry = generateWalkableNavmeshGeometry({
    terrain: map.terrain,
    width: map.width,
    height: map.height,
    ramps: map.ramps,
  });
  const recast = RecastNavigation.getInstance();
  recast.setTerrainHeightProvider((x, z) =>
    sampleNavMeshHeightMap(geometry.navMeshHeightMap, map.width, map.height, x, z)
  );
  const generated = await recast.generateFromGeometry(
    geometry.positions,
    geometry.indices,
    map.width,
    map.height
  );
  if (!generated) throw new Error('crystal_caverns navmesh generation failed');

  const direct = recast.findPath(39, 39, 59, 39);
  const addTimes: number[] = [];
  const removeTimes: number[] = [];
  let reroutes = 0;
  let restored = 0;
  let failures = 0;
  for (let cycle = 0; cycle < 25; cycle++) {
    let started = performance.now();
    recast.addObstacle(1, 43, 39, 5, 5);
    addTimes.push(performance.now() - started);
    const rerouted = recast.findPath(39, 39, 59, 39);
    if (
      rerouted.found &&
      rerouted.path.length > direct.path.length &&
      Math.max(...rerouted.path.map((point) => Math.abs(point.y - 39))) > 1
    ) {
      reroutes++;
    } else {
      failures++;
    }

    started = performance.now();
    recast.removeObstacle(1);
    removeTimes.push(performance.now() - started);
    const afterRemoval = recast.findPath(39, 39, 59, 39);
    if (digest(afterRemoval) === digest(direct)) restored++;
  }
  const queryTimes: number[] = [];
  let queriesFound = 0;
  const queryHashes = new Set<string>();
  for (let queryIndex = 0; queryIndex < 500; queryIndex++) {
    const started = performance.now();
    const result = recast.findPath(39, 39, 59, 39);
    queryTimes.push(performance.now() - started);
    if (result.found) queriesFound++;
    queryHashes.add(digest(result));
  }
  return {
    cycles: 25,
    reroutes,
    restored,
    failures,
    directPathHash: digest(direct),
    pathQueries: {
      count: queryTimes.length,
      found: queriesFound,
      uniqueResultHashes: queryHashes.size,
      meanMs: queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length,
      p95Ms: percentile(queryTimes, 0.95),
      maxMs: Math.max(...queryTimes),
    },
    addMs: {
      mean: addTimes.reduce((a, b) => a + b, 0) / addTimes.length,
      p95: percentile(addTimes, 0.95),
      max: Math.max(...addTimes),
    },
    removeMs: {
      mean: removeTimes.reduce((a, b) => a + b, 0) / removeTimes.length,
      p95: percentile(removeTimes, 0.95),
      max: Math.max(...removeTimes),
    },
  };
}

interface CrowdRunOptions {
  count: number;
  steps: number;
  dt: number;
  opposing?: boolean;
  reverseInsertion?: boolean;
}

async function crowdRun(options: CrowdRunOptions) {
  const recast = await makeFlatNavigation(96);
  const addStarted = performance.now();
  const initial = new Map<number, { x: number; y: number; tx: number; ty: number }>();
  const columns = Math.ceil(Math.sqrt(options.count));
  for (let i = 0; i < options.count; i++) {
    const entityId = i + 1;
    const col = i % columns;
    const row = Math.floor(i / columns);
    const rightGroup = options.opposing && i % 2 === 1;
    const x = rightGroup ? 70 - col * 0.65 : 8 + col * 0.65;
    const y = 8 + row * 0.65;
    initial.set(entityId, {
      x,
      y,
      tx: rightGroup ? x - 50 : x + 50,
      ty: y,
    });
  }
  const ids = [...initial.keys()];
  if (options.reverseInsertion) ids.reverse();
  let accepted = 0;
  for (const entityId of ids) {
    const p = initial.get(entityId)!;
    if (recast.addAgent(entityId, p.x, p.y, 0.5, 5) >= 0) accepted++;
  }
  const addMs = performance.now() - addStarted;
  for (const entityId of ids) {
    const p = initial.get(entityId)!;
    recast.setAgentTarget(entityId, p.tx, p.ty);
  }

  const tickTimes: number[] = [];
  const hashes: string[] = [];
  for (let tick = 0; tick < options.steps; tick++) {
    const started = performance.now();
    recast.updateCrowd(options.dt);
    tickTimes.push(performance.now() - started);
    if (tick === options.steps - 1 || options.count <= 128) {
      const state = ids
        .slice()
        .sort((a, b) => a - b)
        .map((entityId) => ({ entityId, state: recast.getAgentState(entityId) }));
      hashes.push(digest(state));
    }
  }

  let arrived = 0;
  let stuckAtEnd = 0;
  let totalDistanceRemaining = 0;
  const finalStates = ids
    .slice()
    .sort((a, b) => a - b)
    .map((entityId) => {
      const p = initial.get(entityId)!;
      const state = recast.getAgentState(entityId);
      if (!state) return { entityId, state: null };
      const remaining = Math.hypot(state.x - p.tx, state.y - p.ty);
      totalDistanceRemaining += remaining;
      if (remaining <= 1.5) arrived++;
      if (remaining > 2 && Math.hypot(state.vx, state.vy) < 0.01) stuckAtEnd++;
      return { entityId, state };
    });

  return {
    options,
    accepted,
    addMs,
    updateTotalMs: tickTimes.reduce((a, b) => a + b, 0),
    updateMeanMs: tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length,
    updateP95Ms: percentile(tickTimes, 0.95),
    updateMaxMs: Math.max(...tickTimes),
    arrived,
    arrivalThreshold: 1.5,
    stuckAtEnd,
    meanDistanceRemaining: totalDistanceRemaining / options.count,
    finalHash: digest(finalStates),
    traceHash: digest(hashes),
    finalStates,
  };
}

async function main() {
  await RecastNavigation.initWasm();
  const results: Record<string, unknown> = {};
  results.crowdCapacity = await crowdCapacity();
  results.obstacleCapacity = await obstacleCapacity();
  results.dynamicObstacleCycles = await dynamicObstacleCycles();

  const dense1000 = await crowdRun({ count: 1000, steps: 200, dt: 0.05 });
  const { finalStates: _denseStates, ...dense1000Summary } = dense1000;
  results.dense1000 = dense1000Summary;

  const opposing400 = await crowdRun({ count: 400, steps: 240, dt: 0.05, opposing: true });
  const { finalStates: _opposingStates, ...opposing400Summary } = opposing400;
  results.opposing400 = opposing400Summary;

  const traceA = await crowdRun({ count: 100, steps: 120, dt: 0.05 });
  const traceB = await crowdRun({ count: 100, steps: 120, dt: 0.05 });
  const traceReverse = await crowdRun({ count: 100, steps: 120, dt: 0.05, reverseInsertion: true });
  const traceFine = await crowdRun({ count: 100, steps: 240, dt: 0.025 });
  results.determinism = {
    sameHostSameRunExact: traceA.traceHash === traceB.traceHash,
    sameHostReverseInsertionExact: traceA.finalHash === traceReverse.finalHash,
    sameHostEquivalentSixSecondsDifferentStepExact: traceA.finalHash === traceFine.finalHash,
    hashes: {
      traceA: traceA.traceHash,
      traceB: traceB.traceHash,
      reverseFinal: traceReverse.finalHash,
      fineStepFinal: traceFine.finalHash,
      coarseFinal: traceA.finalHash,
    },
    scope: 'One Node.js process on one macOS arm64 host; not cross-browser or cross-platform evidence.',
  };

  console.log(JSON.stringify(results, null, 2));
  RecastNavigation.resetInstance();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

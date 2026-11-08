import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ProjectAStarAdapter, PathFindingJsAdapter, VoidstrikeRecastAdapter, type Adapter, type FixtureMap, type PathRequestFixture, type QueryOutput } from './adapters';

const root = resolve(import.meta.dirname, '../../..');
const benchmarkRoot = resolve(import.meta.dirname, '..');
const donorRoot = resolve(root, 'scratch/donor-audit/browser/voidstrike');
const outputPath = resolve(process.argv[2] ?? resolve(benchmarkRoot, 'results/run.json'));
const fixturePath = resolve(benchmarkRoot, 'fixtures/fixtures.json');
const fixtureSet = JSON.parse(readFileSync(fixturePath, 'utf8'));
const config = {
  pathWarmupsPerRequest: 10,
  pathIterationsPerRequest: 50,
  groupOrderCount: 32,
  groupWarmupBatches: 5,
  groupMeasuredBatches: 20,
  mutationWarmupCycles: 5,
  mutationMeasuredCycles: 20,
  recastRebuildWarmups: 1,
  recastRebuildIterations: 3,
  exactGoalToleranceWorldUnits: 0.05,
};
const exactCommand = `../../node_modules/.bin/tsx --tsconfig ../donor-audit/browser/voidstrike/tsconfig.json src/run.ts ${process.argv[2] ?? 'results/run.json'}`;

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function round(value: number) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function stats(samples: number[]) {
  const sorted = [...samples].sort((a,b) => a-b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    count: samples.length,
    minMs: round(sorted[0]),
    meanMs: round(samples.reduce((a,b) => a+b, 0) / samples.length),
    p50Ms: round(at(0.50)),
    p95Ms: round(at(0.95)),
    p99Ms: round(at(0.99)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}
function normalized(output: QueryOutput) {
  return { reportedSuccess: output.reportedSuccess, points: output.points.map(([x,y]) => [round(x), round(y)]), rawGridCost: output.rawGridCost ?? null };
}
function evaluate(output: QueryOutput, request: PathRequestFixture) {
  const goal: [number, number] = [request.goal[0] + 0.5, request.goal[1] + 0.5];
  let length = 0;
  for (let i = 1; i < output.points.length; i++) length += Math.hypot(output.points[i][0] - output.points[i-1][0], output.points[i][1] - output.points[i-1][1]);
  const last = output.points[output.points.length - 1];
  const endpointError = last ? Math.hypot(last[0] - goal[0], last[1] - goal[1]) : null;
  return {
    ...normalized(output),
    exactSuccess: output.reportedSuccess && endpointError !== null && endpointError <= config.exactGoalToleranceWorldUnits,
    expectedExactSuccess: request.expectedReachable,
    endpointErrorWorldUnits: round(endpointError ?? Number.NaN),
    pathLengthWorldUnits: round(length),
    waypointCount: output.points.length,
  };
}
function timed<T>(fn: () => T) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}
function adaptersFor(map: FixtureMap): Adapter[] {
  return [new ProjectAStarAdapter(map), new PathFindingJsAdapter(map), new VoidstrikeRecastAdapter(map)];
}

const results: any = {
  schema: 'wayfinder-navigation-results-v1',
  startedAt: new Date().toISOString(),
  exactCommand,
  cwdAtInvocation: 'scratch/navigation-benchmark',
  config,
  fixtureSha256: digest(fixtureSet),
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform} ${process.arch}`,
    osRelease: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(),
    cpu: cpus()[0]?.model,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    projectCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    donorCommit: execFileSync('git', ['-C', donorRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    pathfindingVersion: JSON.parse(readFileSync(resolve(benchmarkRoot, 'node_modules/pathfinding/package.json'), 'utf8')).version,
    recastNavigationVersion: JSON.parse(readFileSync(resolve(donorRoot, 'node_modules/recast-navigation/package.json'), 'utf8')).version,
  },
  sourceImplementations: {
    projectAStar: 'src/sim/path/astar.ts imported directly; native integer costs and string-pulling',
    projectRepeatedOrders: 'src/sim/path/engine.ts createPathEngine LRU, fresh engine per batch',
    pathfindingJs: 'AStarFinder diagonalMovement=OnlyWhenNoObstacles; grid.clone() included per query; no smoothing',
    recast: 'Voidstrike RecastNavigation.generateFromGeometry/findPath/addBoxObstacle/removeObstacle imported directly',
    flowField: { status: 'not-implemented', evidence: 'No flow-field implementation found under project src/sim/path' },
  },
  coordinateAndSuccessContract: {
    worldPoint: 'tile center (x+0.5,y+0.5), tileSize=1',
    exactSuccess: 'reportedSuccess and final waypoint within 0.05 world units of requested goal center',
    pathLength: 'two-dimensional Euclidean length of native returned polyline; elevation excluded for every engine',
    latencyScope: 'synchronous in-process query only; worker transport/scheduling/render frame time excluded',
    recastSetupScope: 'fixture geometry conversion plus Voidstrike generateFromGeometry; excluded from query samples',
  },
  maps: [],
  crowdMetrics: {
    completionTime: { status: 'unmeasured' },
    stuckCount: { status: 'unmeasured' },
    crowdDensity: { status: 'unmeasured' },
    reason: 'Only path requests were executed. No fair shared movement/collision simulation was run; path latency is not substituted for crowd performance.',
  },
};
const logicalResults: any = {};

for (const map of fixtureSet.maps as FixtureMap[]) {
  console.log(`MAP ${map.id}`);
  const mapResult: any = { id: map.id, description: map.description, algorithms: [] };
  logicalResults[map.id] = {};
  for (const adapter of adaptersFor(map)) {
    await adapter.setup();
    console.log(`  ${adapter.name} setup=${adapter.setupMs.toFixed(3)}ms`);
    const algorithm: any = { name: adapter.name, setupMs: round(adapter.setupMs), requests: [], repeatedGroup: null, mutations: [], recastTerrainRebuild: null };
    logicalResults[map.id][adapter.name] = { requests: [], repeatedGroup: null, mutations: [] };
    for (const request of map.requests) {
      for (let i = 0; i < config.pathWarmupsPerRequest; i++) adapter.query(request);
      const samples: number[] = [];
      const first = evaluate(adapter.query(request), request);
      let stable = true;
      let exactSuccesses = 0;
      for (let i = 0; i < config.pathIterationsPerRequest; i++) {
        const run = timed(() => adapter.query(request));
        const evaluated = evaluate(run.value, request);
        if (digest(evaluated) !== digest(first)) stable = false;
        if (evaluated.exactSuccess) exactSuccesses++;
        samples.push(run.ms);
      }
      const requestResult = { id: request.id, ...first, exactSuccesses, failures: config.pathIterationsPerRequest - exactSuccesses, outputStableAcrossIterations: stable, latency: stats(samples), samplesMs: samples.map(round) };
      algorithm.requests.push(requestResult);
      logicalResults[map.id][adapter.name].requests.push({ id: request.id, ...first });
    }
    const groupRequest = map.requests[0];
    for (let i = 0; i < config.groupWarmupBatches; i++) adapter.repeatedGroup(groupRequest, config.groupOrderCount);
    const groupSamples: number[] = [];
    let groupStable = true;
    let groupCacheHits: number | null = null;
    let firstGroupDigest = '';
    for (let i = 0; i < config.groupMeasuredBatches; i++) {
      const run = timed(() => adapter.repeatedGroup(groupRequest, config.groupOrderCount));
      const logical = run.value.outputs.map((o) => evaluate(o, groupRequest));
      const currentDigest = digest(logical);
      if (!firstGroupDigest) firstGroupDigest = currentDigest;
      if (currentDigest !== firstGroupDigest) groupStable = false;
      groupCacheHits = run.value.cacheHits;
      groupSamples.push(run.ms);
    }
    algorithm.repeatedGroup = {
      requestId: groupRequest.id,
      ordersPerBatch: config.groupOrderCount,
      cacheHitsPerBatch: groupCacheHits,
      outputStableAcrossBatches: groupStable,
      batchLatency: stats(groupSamples),
      perOrderMeanMs: round(groupSamples.reduce((a,b)=>a+b,0) / groupSamples.length / config.groupOrderCount),
      batchSamplesMs: groupSamples.map(round),
      outputDigest: firstGroupDigest,
    };
    logicalResults[map.id][adapter.name].repeatedGroup = firstGroupDigest;

    for (const mutation of map.mutations) {
      const baseline = evaluate(adapter.query(groupRequest), groupRequest);
      for (let i = 0; i < config.mutationWarmupCycles; i++) { adapter.addMutation(mutation); adapter.query(groupRequest); adapter.removeMutation(mutation); }
      const addSamples: number[] = [], removeSamples: number[] = [];
      let allPostAddExact = true, allRestored = true, allPostAddStable = true;
      let firstPostAdd = '';
      for (let i = 0; i < config.mutationMeasuredCycles; i++) {
        addSamples.push(timed(() => adapter.addMutation(mutation)).ms);
        const after = evaluate(adapter.query(groupRequest), groupRequest);
        const afterDigest = digest(after);
        if (!firstPostAdd) firstPostAdd = afterDigest;
        if (afterDigest !== firstPostAdd) allPostAddStable = false;
        if (after.exactSuccess !== mutation.expectedReachableAfter) allPostAddExact = false;
        removeSamples.push(timed(() => adapter.removeMutation(mutation)).ms);
        if (digest(evaluate(adapter.query(groupRequest), groupRequest)) !== digest(baseline)) allRestored = false;
      }
      const mutationResult = {
        id: mutation.id,
        rect: mutation.rect,
        addUpdateLatency: stats(addSamples),
        removeUpdateLatency: stats(removeSamples),
        addSamplesMs: addSamples.map(round),
        removeSamplesMs: removeSamples.map(round),
        allPostAddExpectedExactOutcomes: allPostAddExact,
        allPostAddOutputsStable: allPostAddStable,
        allPostRemoveOutputsMatchBaseline: allRestored,
        postAddOutputDigest: firstPostAdd,
        baselineOutputDigest: digest(baseline),
      };
      algorithm.mutations.push(mutationResult);
      logicalResults[map.id][adapter.name].mutations.push({ baseline: digest(baseline), postAdd: firstPostAdd, allPostAddExact, allRestored });
    }
    if (adapter.rebuildWithMutation && map.mutations.length) {
      const mutation = map.mutations[0];
      const samples: number[] = [];
      for (let i = 0; i < config.recastRebuildWarmups; i++) await adapter.rebuildWithMutation(mutation);
      for (let i = 0; i < config.recastRebuildIterations; i++) {
        const start = performance.now();
        await adapter.rebuildWithMutation(mutation);
        samples.push(performance.now() - start);
      }
      algorithm.recastTerrainRebuild = { scope: 'full generateFromGeometry on mutated walkable-cell mesh, including tile-cache and crowd construction', latency: stats(samples), samplesMs: samples.map(round) };
    }
    mapResult.algorithms.push(algorithm);
    adapter.dispose();
  }
  results.maps.push(mapResult);
}
results.logicalResults = logicalResults;
results.logicalDigest = digest(logicalResults);
results.finishedAt = new Date().toISOString();
writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n');
console.log(`WROTE ${outputPath}`);
console.log(`LOGICAL DIGEST ${results.logicalDigest}`);

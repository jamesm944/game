import { readFileSync, writeFileSync } from 'node:fs';

const first = JSON.parse(readFileSync(new URL('../results/run-01.json', import.meta.url), 'utf8'));
const second = JSON.parse(readFileSync(new URL('../results/run-02.json', import.meta.url), 'utf8'));
function stats(samples) {
  const sorted = [...samples].sort((a,b) => a-b);
  const at = p => sorted[Math.ceil(sorted.length * p) - 1];
  const round = n => Number(n.toFixed(6));
  return { count: samples.length, meanMs: round(samples.reduce((a,b)=>a+b,0)/samples.length), p50Ms: round(at(.5)), p95Ms: round(at(.95)), p99Ms: round(at(.99)), maxMs: round(sorted.at(-1)) };
}
const summary = {
  schema: 'wayfinder-navigation-summary-v1',
  sourceRun: 'results/run-02.json',
  comparisonRun: 'results/run-01.json',
  logicalDigestRun01: first.logicalDigest,
  logicalDigestRun02: second.logicalDigest,
  crossProcessLogicalOutputsEqual: first.logicalDigest === second.logicalDigest,
  config: second.config,
  environment: second.environment,
  maps: second.maps.map(map => ({
    id: map.id,
    algorithms: map.algorithms.map(algorithm => ({
      name: algorithm.name,
      setupMs: algorithm.setupMs,
      aggregateLatency: stats(algorithm.requests.flatMap(request => request.samplesMs)),
      exactSuccesses: algorithm.requests.reduce((n,r) => n+r.exactSuccesses,0),
      measuredRequests: algorithm.requests.reduce((n,r) => n+r.latency.count,0),
      allExactOutcomesExpected: algorithm.requests.every(r => r.exactSuccess === r.expectedExactSuccess),
      allOutputsStable: algorithm.requests.every(r => r.outputStableAcrossIterations),
      requests: algorithm.requests.map(r => ({ id:r.id, reportedSuccess:r.reportedSuccess, exactSuccess:r.exactSuccess, expectedExactSuccess:r.expectedExactSuccess, endpointErrorWorldUnits:r.endpointErrorWorldUnits, pathLengthWorldUnits:r.pathLengthWorldUnits, waypointCount:r.waypointCount, latency:{p50Ms:r.latency.p50Ms,p95Ms:r.latency.p95Ms,p99Ms:r.latency.p99Ms} })),
      repeatedGroup: algorithm.repeatedGroup,
      mutations: algorithm.mutations,
      recastTerrainRebuild: algorithm.recastTerrainRebuild,
    }))
  })),
  crowdMetrics: second.crowdMetrics,
};
if (!summary.crossProcessLogicalOutputsEqual) throw new Error('Cross-process logical outputs differ');
for (const map of summary.maps) for (const algorithm of map.algorithms) {
  if (!algorithm.allExactOutcomesExpected || !algorithm.allOutputsStable) throw new Error(`${map.id}/${algorithm.name}: correctness or stability failure`);
  for (const mutation of algorithm.mutations) {
    if (!mutation.allPostAddExpectedExactOutcomes || !mutation.allPostAddOutputsStable || !mutation.allPostRemoveOutputsMatchBaseline) throw new Error(`${map.id}/${algorithm.name}: mutation verification failure`);
  }
}
writeFileSync(new URL('../results/summary.json', import.meta.url), JSON.stringify(summary,null,2)+'\n');
console.log('Verified correctness, mutation restoration, within-run stability, and cross-process logical equality.');
console.log('Wrote results/summary.json');

#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, "results");
const read = (name) => JSON.parse(readFileSync(path.join(RESULTS, name), "utf8"));
function logical(result) {
  return {
    scenario: result.scenario.name,
    population: result.population,
    finalTick: result.finalTick,
    initialMapHash: result.initialMapHash,
    finalMapHash: result.finalMapHash,
    finalWorldDigest: result.finalWorldDigest,
    finalFullStateHash: result.finalFullStateHash,
    milestones: result.milestones,
    completions: result.completions,
    units: result.units,
    crowdStates: result.crowdStates,
    movementDiagnostics: result.movementDiagnostics,
    mutations: result.mutations,
    paths: result.pathRequests.map((request) => ({
      id: request.id,
      issueTick: request.issueTick,
      dueTick: request.dueTick,
      applyTick: request.applyTick,
      issueToApplyTicks: request.issueToApplyTicks,
      outcome: request.outcome,
      ok: request.ok,
      passableVersion: request.passableVersion,
      commandTick: request.commandTick,
    })),
  };
}
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}
function distribution(values) {
  return { n: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? Math.max(...values) : 0, meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 };
}
function numeric(sample, key) {
  const value = sample.candidateMetrics[key];
  return typeof value === "number" ? value : 0;
}
function summarize(sample) {
  const leader = sample.pathRequests.filter((request) => request.commandTick !== undefined);
  const repath = sample.pathRequests.filter((request) => request.commandTick === undefined);
  const responses = (requests) => distribution(requests.flatMap((request) => request.issueToResponseMs === undefined ? [] : [request.issueToResponseMs]));
  const worker = (requests) => distribution(requests.flatMap((request) => request.computeMs === undefined ? [] : [request.computeMs]));
  const apply = distribution(sample.pathRequests.flatMap((request) => request.applyCostMs === undefined ? [] : [request.applyCostMs]));
  const protocolViolations = sample.pathRequests.flatMap((request, index) => {
    const violations = [];
    if (request.id !== index + 1) violations.push("non-monotonic-request-id");
    if (request.dueTick !== request.issueTick + 2) violations.push("due-tick-contract");
    if (request.snapshotBytes !== 14400) violations.push("snapshot-size");
    if (request.applyTick !== undefined && request.issueToApplyTicks !== 2) violations.push("late-or-early-application");
    return violations.length ? [{ id: request.id, violations }] : [];
  });
  return {
    finalTick: sample.finalTick,
    frames: sample.frames,
    wallClockMs: sample.wallClockMs,
    requests: sample.pathRequests.length,
    protocolViolations,
    leaderRequests: leader.length,
    leaderResponse: responses(leader),
    repathResponse: responses(repath),
    leaderWorkerCompute: worker(leader),
    repathWorkerCompute: worker(repath),
    productionApply: apply,
    blockedFrames: sample.scheduler.blockedTicks,
    queue: sample.scheduler,
    snapshotBytes: sample.pathRequests.reduce((sum, request) => sum + request.snapshotBytes, 0),
    revisionBuilds: numeric(sample, "revisionBuilds"),
    totalRevisionBuildMs: numeric(sample, "totalRevisionBuildMs"),
    maxRevisionBuildMs: numeric(sample, "maxRevisionBuildMs"),
    pathQueries: numeric(sample, "pathQueries"),
    totalPathQueryMs: numeric(sample, "totalPathQueryMs"),
    maxPathQueryMs: numeric(sample, "maxPathQueryMs"),
    routeConversions: numeric(sample, "routeConversions"),
    totalRouteConversionMs: numeric(sample, "totalRouteConversionMs"),
    maxRouteConversionMs: numeric(sample, "maxRouteConversionMs"),
    responseWaypointBytes: numeric(sample, "responseWaypointBytes"),
    wasmInitializationMs: numeric(sample, "wasmInitializationMs"),
    completions: Object.fromEntries(["completed", "active-at-cutoff", "no-path", "stale-cancelled", "replaced"].map((outcome) => [outcome, sample.completions.filter((entry) => entry.outcome === outcome).length])),
    failedResponses: sample.pathRequests.filter((request) => request.ok === false).length,
    repaths: sample.movementDiagnostics.repaths,
    correctnessCounters: Object.fromEntries(["geometryRejections", "partialPathsRejected", "endpointProjectionsRejected", "nativeQueryFailures", "navmeshGenerationFailures", "pathCapacityFailures", "snapshotMismatches"].map((key) => [key, numeric(sample, key)])),
    finalFullStateHash: sample.finalFullStateHash,
  };
}
function compare(pair) {
  const browserRun = read(pair.browser);
  const node = read(pair.node);
  const preserved = pair.preserved ? JSON.parse(readFileSync(path.resolve(ROOT, pair.preserved), "utf8")) : undefined;
  if (browserRun.browser !== "chrome" || browserRun.host.architecture !== "arm64") throw new Error(`${pair.name}: evidence is not Chrome arm64`);
  if (browserRun.provenance.wasmSha256 !== node.provenance.wasmSha256) throw new Error(`${pair.name}: WASM binary differs`);
  const samples = browserRun.samples.map((sample) => {
    const routeMismatches = [];
    const count = Math.max(sample.recastRoutes.length, node.recastRoutes.length);
    for (let index = 0; index < count; index += 1) {
      if (JSON.stringify(sample.recastRoutes[index]) !== JSON.stringify(node.recastRoutes[index])) routeMismatches.push({ index, browser: sample.recastRoutes[index], node: node.recastRoutes[index] });
    }
    const routesEqual = routeMismatches.length === 0;
    const logicalEqual = JSON.stringify(logical(sample)) === JSON.stringify(logical(node));
    const fullStateEqual = sample.finalFullStateHash === node.finalFullStateHash;
    return {
      routesEqual,
      routeCountBrowser: sample.recastRoutes.length,
      routeCountNode: node.recastRoutes.length,
      routeMismatches: routeMismatches.slice(0, 20),
      logicalEqual,
      fullStateEqual,
      classification: routesEqual && logicalEqual && fullStateEqual ? "identical-route-stream-logical-and-full-state-replay" : !routesEqual ? "browser-node-wasm-route-output-difference" : "identical-routes-but-logical-or-full-state-application-difference",
      browser: summarize(sample),
      node: summarize(node),
    };
  });
  return {
    ...pair,
    browserVersion: browserRun.browserVersion,
    host: browserRun.host,
    provenance: browserRun.provenance,
    repeatLogicalResultsEqual: browserRun.repeatLogicalResultsEqual,
    repeatFullStateHashesEqual: browserRun.repeatFullStateHashesEqual,
    preservedNodeLogicalEqual: preserved ? JSON.stringify(logical(node)) === JSON.stringify(logical(preserved)) : undefined,
    samples,
  };
}
const pairs = [
  { name: "short-repeated-mutation", browser: "chrome-recast-mutation-p40-t400-replay.json", node: "node-recast-mutation-p40-t400.json" },
  { name: "dense-1000-3600", browser: "chrome-recast-dense-p1000-t3600.json", node: "node-recast-dense-p1000-t3600.json", preserved: "../../phase2-navigation/recast-corridor/results/dense-open-120-p1000-corridor.json" },
  { name: "narrow-mutation-1000-3600", browser: "chrome-recast-narrow-mutation-p1000-t3600.json", node: "node-recast-narrow-mutation-p1000-t3600.json", preserved: "../../phase2-navigation/recast-corridor/results/narrow-mutation-120-p1000-corridor.json" },
];
const comparisons = pairs.map(compare);
const document = {
  schema: "wayfinder-recast-browser-comparison-v1",
  scope: "same-candidate-Chrome-arm64-module-worker-versus-corrected-Node-Recast",
  determinismClaim: "Only pairs with identical route streams and logical/full-state equality support observed same-candidate replay on this host; no cross-browser or x64 claim.",
  comparisons,
};
const output = path.join(RESULTS, "comparison-validation.json");
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ output, comparisons: comparisons.map((entry) => ({ name: entry.name, preservedNodeLogicalEqual: entry.preservedNodeLogicalEqual, samples: entry.samples.map((sample) => ({ routesEqual: sample.routesEqual, logicalEqual: sample.logicalEqual, fullStateEqual: sample.fullStateEqual, browserWallMs: sample.browser.wallClockMs, blockedFrames: sample.browser.blockedFrames, leaderResponse: sample.browser.leaderResponse, repathResponse: sample.browser.repathResponse })) })) }, null, 2));
if (!comparisons.every((entry) => entry.preservedNodeLogicalEqual !== false && entry.samples.every((sample) => sample.routesEqual && sample.logicalEqual && sample.fullStateEqual && sample.browser.protocolViolations.length === 0 && sample.node.protocolViolations.length === 0))) process.exitCode = 1;

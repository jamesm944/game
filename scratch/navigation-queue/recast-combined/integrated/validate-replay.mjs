#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const results = path.join(root, "results");
const browser = JSON.parse(readFileSync(path.join(results, "chrome-combined-p40-t400-built.json"), "utf8"));
const node = JSON.parse(readFileSync(path.join(results, "node-combined-oracle-p40-t400.json"), "utf8"));
const sample = browser.samples[0];
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
    paths: result.pathRequests.map((request) => ({ id: request.id, issueTick: request.issueTick, dueTick: request.dueTick, applyTick: request.applyTick, issueToApplyTicks: request.issueToApplyTicks, outcome: request.outcome, ok: request.ok, passableVersion: request.passableVersion, commandTick: request.commandTick })),
  };
}
const routeMismatches = [];
const routeCount = Math.max(sample.recastRoutes.length, node.recastRoutes.length);
for (let index = 0; index < routeCount; index += 1) {
  if (JSON.stringify(sample.recastRoutes[index]) !== JSON.stringify(node.recastRoutes[index])) routeMismatches.push({ index, browser: sample.recastRoutes[index], node: node.recastRoutes[index] });
}
const protocolViolations = [];
for (const [index, request] of sample.pathRequests.entries()) {
  if (request.id !== index + 1) protocolViolations.push({ id: request.id, violation: "non-monotonic-request-id" });
  if (request.dueTick !== request.issueTick + 2) protocolViolations.push({ id: request.id, violation: "due-tick-contract" });
  if (request.applyTick !== undefined && request.issueToApplyTicks !== 2) protocolViolations.push({ id: request.id, violation: "late-or-early-application" });
}
const protocol = sample.protocol;
if (protocol.errors.length) protocolViolations.push({ violation: "worker-errors", errors: protocol.errors });
if (protocol.snapshotAcks.length !== protocol.snapshotSends.length) protocolViolations.push({ violation: "missing-snapshot-acknowledgment" });
if (protocol.snapshotSends[0]?.operation !== "register" || !protocol.snapshotSends.slice(1).every((event) => event.operation === "update")) protocolViolations.push({ violation: "full-delta-sequence" });
if (Math.max(...protocol.responses.map((entry) => entry.snapshotCount)) > 2) protocolViolations.push({ violation: "worker-snapshot-capacity" });
if (protocol.mainRetainedSnapshotCount !== 1) protocolViolations.push({ violation: "main-snapshot-retention" });
const output = {
  schema: "wayfinder-combined-recast-replay-validation-v1",
  browser: browser.browser,
  browserVersion: browser.browserVersion,
  artifactMode: browser.artifactMode,
  host: browser.host,
  wasmSha256: browser.provenance.wasmSha256,
  wasmMatchesNode: browser.provenance.wasmSha256 === node.provenance.wasmSha256,
  routeCountBrowser: sample.recastRoutes.length,
  routeCountNode: node.recastRoutes.length,
  routeMismatches,
  routesEqual: routeMismatches.length === 0,
  logicalEqual: JSON.stringify(logical(sample)) === JSON.stringify(logical(node)),
  fullStateEqual: sample.finalFullStateHash === node.finalFullStateHash,
  finalFullStateHash: sample.finalFullStateHash,
  protocolViolations,
  snapshotSends: protocol.snapshotSends.length,
  snapshotAcks: protocol.snapshotAcks.length,
  maxWorkerSnapshotCount: Math.max(...protocol.responses.map((entry) => entry.snapshotCount)),
  maxWorkerSnapshotBytes: Math.max(...protocol.responses.map((entry) => entry.snapshotBytes)),
  revisionRasterizedNavTiles: sample.candidateMetrics.rasterizedNavTiles,
  revisionReusedCompressedLayers: sample.candidateMetrics.reusedCompressedLayers,
  geometryRejections: sample.candidateMetrics.geometryRejections,
  performanceComparison: false,
};
const passed = output.wasmMatchesNode && output.routesEqual && output.logicalEqual && output.fullStateEqual && protocolViolations.length === 0;
const target = path.join(results, "replay-validation.json");
writeFileSync(target, `${JSON.stringify({ ...output, passed }, null, 2)}\n`);
console.log(JSON.stringify({ target, passed, routes: `${output.routeCountBrowser}/${output.routeCountNode}`, routeMismatches: routeMismatches.length, logicalEqual: output.logicalEqual, fullStateEqual: output.fullStateEqual, hash: output.finalFullStateHash, protocolViolations, snapshotSends: output.snapshotSends, snapshotAcks: output.snapshotAcks }, null, 2));
if (!passed) process.exitCode = 1;

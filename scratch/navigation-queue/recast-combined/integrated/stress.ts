import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import { RecastRouteEngine as FullRebuildEngine } from "../../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "../../../phase2-navigation/recast-corridor/corridor-candidate";
import { CombinedRecastEngine, initializeCombinedRecast } from "../combined-engine";

interface Snapshot { readonly passable: Uint8Array; readonly startX: number; readonly startY: number; readonly goalX: number; readonly goalY: number; }
interface CaseSpec { readonly name: string; readonly width: number; readonly snapshots: readonly Snapshot[]; }
function request(id: number, snapshot: Snapshot, version: number): PathRequest {
  return { kind: "path", id, dueTick: version + 2, startX: snapshot.startX, startY: snapshot.startY, goalX: snapshot.goalX, goalY: snapshot.goalY, passable: snapshot.passable, passableVersion: version, seed: 171 };
}
function summary(response: PathResponse) { return { id: response.id, ok: response.ok, cost: response.cost, waypoints: Array.from(response.waypoints) }; }
function equal(actual: PathResponse, expected: PathResponse): boolean { return JSON.stringify(summary(actual)) === JSON.stringify(summary(expected)); }
function open(width: number): Uint8Array { return new Uint8Array(width * width).fill(1); }
function endpoints(passable: Uint8Array, width: number): Snapshot { return { passable, startX: 0, startY: 0, goalX: width - 1, goalY: width - 1 }; }
function repeatedGates(): CaseSpec {
  const width = 12;
  const initial = open(width);
  for (let y = 0; y < width; y += 1) if (y !== 4) initial[y * width + 5] = 0;
  const closed = initial.slice(); closed[4 * width + 5] = 0;
  const snapshots: Snapshot[] = [];
  for (let cycle = 0; cycle < 10; cycle += 1) snapshots.push(endpoints(initial, width), endpoints(closed, width));
  return { name: "repeated-one-tile-gate-close-reopen", width, snapshots };
}
function buildingAddRemove(): CaseSpec {
  const width = 40; const initial = open(width); const building = initial.slice();
  for (let y = 8; y < 12; y += 1) for (let x = 8; x < 12; x += 1) building[y * width + x] = 0;
  return { name: "building-add-remove", width, snapshots: [endpoints(initial, width), endpoints(building, width), endpoints(initial, width)] };
}
function mutationBurst(): CaseSpec {
  const width = 120; const initial = open(width); const burst = initial.slice();
  for (const [ox, oy] of [[8, 8], [40, 16], [72, 40], [96, 80], [16, 96]] as const) for (let y = oy; y < oy + 4; y += 1) for (let x = ox; x < ox + 4; x += 1) burst[y * width + x] = 0;
  return { name: "five-rectangle-mutation-burst", width, snapshots: [endpoints(initial, width), endpoints(burst, width), endpoints(initial, width)] };
}
function largeObstacle(): CaseSpec {
  const width = 120; const initial = open(width); const blocked = initial.slice();
  for (let y = 8; y < 112; y += 1) for (let x = 8; x < 112; x += 1) blocked[y * width + x] = 0;
  return { name: "large-104x104-obstacle-multi-tile-halo", width, snapshots: [endpoints(initial, width), endpoints(blocked, width), endpoints(initial, width)] };
}
function isolatedCells(): CaseSpec {
  const width = 48; const passable = open(width);
  for (let y = 1; y < width; y += 2) for (let x = 1; x < width; x += 2) passable[y * width + x] = 0;
  return { name: "576-isolated-blocked-cells", width, snapshots: [{ passable, startX: 0, startY: 0, goalX: 47, goalY: 46 }] };
}
function runCase(spec: CaseSpec) {
  const combined = new CombinedRecastEngine(); const full = new FullRebuildEngine();
  const revisions = []; const mismatches = [];
  try {
    for (let version = 0; version < spec.snapshots.length; version += 1) {
      const snapshot = spec.snapshots[version]!; const input = request(version + 1, snapshot, version);
      const actual = combined.handle(input, () => 0); const expected = full.handle(input, () => 0);
      const exact = equal(actual, expected);
      if (!exact) mismatches.push({ revision: version, actual: summary(actual), expected: summary(expected) });
      revisions.push({ revision: version, snapshotHash: createHash("sha256").update(snapshot.passable).digest("hex"), exact, actual: summary(actual), expected: summary(expected) });
    }
    return { name: spec.name, width: spec.width, exact: mismatches.length === 0, revisions, mismatches, combinedMetrics: combined.candidateMetrics(), fullRebuildMetrics: full.candidateMetrics() };
  } finally { combined.dispose(); full.dispose(); }
}

await Promise.all([initializeCombinedRecast(), initializeRecast()]);
const cases = [repeatedGates(), buildingAddRemove(), mutationBurst(), largeObstacle(), isolatedCells()];
const result = {
  schema: "wayfinder-combined-recast-mutation-stress-v1",
  ticket: 171,
  recastNavigationVersion: "0.43.0",
  host: { node: process.version, arch: process.arch, platform: process.platform },
  oracle: "corrected-full-rebuild-recast-exact-id-status-cost-waypoints",
  performanceComparison: false,
  comparedResponses: cases.reduce((sum, entry) => sum + entry.snapshots.length, 0),
  cases: cases.map(runCase),
};
const passed = result.cases.every((entry) => entry.exact);
const output = new URL("./results/mutation-stress.json", import.meta.url);
writeFileSync(output, `${JSON.stringify({ ...result, passed }, null, 2)}\n`);
console.log(JSON.stringify({ output: output.pathname, passed, comparedResponses: result.comparedResponses, cases: result.cases.map((entry) => ({ name: entry.name, exact: entry.exact, revisions: entry.revisions.length, geometryRejections: entry.combinedMetrics.geometryRejections })) }, null, 2));
if (!passed) process.exitCode = 1;

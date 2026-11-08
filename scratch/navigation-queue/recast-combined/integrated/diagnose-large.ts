import { writeFileSync } from "node:fs";
import { RecastRouteEngine as FullRebuildEngine } from "../../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "../../../phase2-navigation/recast-corridor/corridor-candidate";
import { CombinedRecastEngine, initializeCombinedRecast } from "../combined-engine";

await Promise.all([initializeCombinedRecast(), initializeRecast()]);
const width = 120;
const open = new Uint8Array(width * width).fill(1);
const blocked = open.slice();
for (let y = 8; y < 112; y += 1) for (let x = 8; x < 112; x += 1) blocked[y * width + x] = 0;
const input = (id: number, passable: Uint8Array, passableVersion: number) => ({ kind: "path" as const, id, dueTick: passableVersion + 2, startX: 0, startY: 0, goalX: 119, goalY: 119, passable, passableVersion, seed: 171 });
const combined = new CombinedRecastEngine();
const full = new FullRebuildEngine();
const revisions = [];
for (const [id, passable, revision] of [[1, open, 0], [2, blocked, 1], [3, open, 2]] as const) {
  const request = input(id, passable, revision);
  const actual = combined.handle(request, () => 0);
  const expected = full.handle(request, () => 0);
  revisions.push({ revision, actual: { ok: actual.ok, cost: actual.cost, waypoints: Array.from(actual.waypoints) }, expected: { ok: expected.ok, cost: expected.cost, waypoints: Array.from(expected.waypoints) }, metrics: combined.candidateMetrics() });
}
const output = { revisions };
writeFileSync(new URL("./results/large-mutation-diagnosis.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
combined.dispose();
full.dispose();

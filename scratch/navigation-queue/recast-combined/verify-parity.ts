import { writeFileSync } from "node:fs";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import type { PathResponse } from "../../../src/sim/path/protocol";
import { RecastRouteEngine as FullEngine } from "../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "./incremental-candidate";
import { CombinedRecastEngine, initializeCombinedRecast } from "./combined-engine";

const EXPECTED_HASH = "e78b4e70c87e9470ee276c83a7aaf3c514a62c4573bc9ae7a2840afc4ef32a4f";
await Promise.all([initializeRecast(), initializeCombinedRecast()]);
const combined = new CombinedRecastEngine();
const full = new FullEngine();
const mismatches: unknown[] = [];
let compared = 0;
let thrown: unknown;
const sameRoute = (a: PathResponse, b: PathResponse): boolean =>
  a.id === b.id && a.ok === b.ok && a.cost === b.cost && a.waypoints.length === b.waypoints.length &&
  a.waypoints.every((value, index) => value === b.waypoints[index]);
const candidate: MovementCandidateAdapter = {
  id: "recast-combined-exact-parity-verification",
  createTransport(context) {
    let receive: ((response: PathResponse) => void) | undefined;
    return {
      attach(onReceive) { receive = onReceive; },
      send(request) {
        context.onRequest(request);
        const started = context.now();
        const response = combined.handle(request, context.now);
        const expected = full.handle(request, () => 0);
        compared += 1;
        if (!sameRoute(response, expected) && mismatches.length < 64) {
          mismatches.push({
            id: request.id,
            revision: request.passableVersion,
            start: [request.startX, request.startY],
            goal: [request.goalX, request.goalY],
            actual: { ok: response.ok, cost: response.cost, waypoints: Array.from(response.waypoints) },
            expected: { ok: expected.ok, cost: expected.cost, waypoints: Array.from(expected.waypoints) },
          });
        }
        context.onResponse(response, context.now() - started);
        receive?.(response);
      },
      dispose() {},
    };
  },
  candidateMetrics: () => combined.candidateMetrics(),
  dispose() { combined.dispose(); full.dispose(); },
};
let result: ReturnType<typeof runBenchmark> | undefined;
try {
  result = runBenchmark({ scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400, candidate, evidenceClass: "node-inline" });
} catch (error) {
  thrown = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
}
const output = {
  scenario: "narrow-mutation-120",
  population: 40,
  ticks: 400,
  compared,
  mismatchCount: mismatches.length,
  mismatches,
  thrown,
  expectedFinalFullStateHash: EXPECTED_HASH,
  finalFullStateHash: result?.finalFullStateHash,
  hashMatches: result?.finalFullStateHash === EXPECTED_HASH,
  combinedMetrics: combined.candidateMetrics(),
  fullMetrics: full.candidateMetrics(),
};
writeFileSync(new URL("./results/combined-parity-p40-t400.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
combined.dispose();
full.dispose();
if (thrown || mismatches.length > 0 || output.finalFullStateHash !== EXPECTED_HASH) process.exitCode = 1;

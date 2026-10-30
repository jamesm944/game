import { writeFileSync } from "node:fs";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import type { PathResponse } from "../../../src/sim/path/protocol";
import { RecastRouteEngine as FullEngine } from "../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "./incremental-candidate";
import { RecastRouteEngine } from "../../navigation-protocol/recast-incremental/incremental-engine";

await initializeRecast();
const engine = new RecastRouteEngine();
const full = new FullEngine();
const mismatches: unknown[] = [];
const geometryFallbacks: unknown[] = [];
let compared = 0;
const sameRoute = (a: PathResponse, b: PathResponse): boolean =>
  a.id === b.id && a.ok === b.ok && a.cost === b.cost && a.waypoints.length === b.waypoints.length &&
  a.waypoints.every((value, index) => value === b.waypoints[index]);
const candidate: MovementCandidateAdapter = {
  id: "original-169-geometry-diagnosis",
  createTransport(context) {
    let receive: ((response: PathResponse) => void) | undefined;
    return {
      attach(onReceive) { receive = onReceive; },
      send(request) {
        context.onRequest(request);
        const started = context.now();
        const fallbacksBefore = Number(engine.candidateMetrics().geometryFallbacks ?? 0);
        const response = engine.handle(request, context.now);
        const fallbacksAfter = Number(engine.candidateMetrics().geometryFallbacks ?? 0);
        if (fallbacksAfter > fallbacksBefore) {
          geometryFallbacks.push({
            id: request.id,
            revision: request.passableVersion,
            start: [request.startX, request.startY],
            goal: [request.goalX, request.goalY],
            fallbacksBefore,
            fallbacksAfter,
          });
        }
        const expected = full.handle(request, () => 0);
        compared += 1;
        if (!sameRoute(response, expected)) {
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
  candidateMetrics: () => engine.candidateMetrics(),
  dispose() { engine.dispose(); full.dispose(); },
};
const result = runBenchmark({
  scenario: scenarioByName("narrow-mutation-120"),
  population: 40,
  ticks: 400,
  candidate,
  evidenceClass: "node-inline",
});
const output = {
  source: "scratch/navigation-protocol/recast-incremental/incremental-engine.ts",
  population: 40,
  ticks: 400,
  compared,
  mismatchCount: mismatches.length,
  mismatches,
  geometryFallbacks,
  finalFullStateHash: result.finalFullStateHash,
  mutations: result.mutations,
  candidateMetrics: result.candidateMetrics,
};
writeFileSync(new URL("./results/original-169-geometry-diagnosis-p40-t400.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
engine.dispose();
full.dispose();

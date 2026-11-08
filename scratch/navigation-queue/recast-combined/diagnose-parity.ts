import { writeFileSync } from "node:fs";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import { RecastRouteEngine as FullEngine } from "../../phase2-navigation/recast-corridor/corridor-engine";
import { initializeRecast } from "./incremental-candidate";
import { RecastRouteEngine } from "./incremental-engine";

await initializeRecast();
const incremental = new RecastRouteEngine();
const full = new FullEngine();
const mismatches: unknown[] = [];
let compared = 0;
const candidate: MovementCandidateAdapter = {
  id: "incremental-parity-diagnosis",
  createTransport(context) {
    let receive: ((response: import("../../../src/sim/path/protocol").PathResponse) => void) | undefined;
    return {
      attach(onReceive) { receive = onReceive; },
      send(request) {
        context.onRequest(request);
        const started = context.now();
        const response = incremental.handle(request, context.now);
        const expected = full.handle(request, () => 0);
        compared += 1;
        if (mismatches.length < 32 && (response.ok !== expected.ok || response.cost !== expected.cost || response.waypoints.some((value, index) => value !== expected.waypoints[index]) || response.waypoints.length !== expected.waypoints.length)) {
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
  candidateMetrics: () => incremental.candidateMetrics(),
  dispose() { incremental.dispose(); full.dispose(); },
};
const result = runBenchmark({ scenario: scenarioByName("narrow-mutation-120"), population: 40, ticks: 400, candidate, evidenceClass: "node-inline" });
const output = { compared, mismatches, incrementalMetrics: incremental.candidateMetrics(), fullMetrics: full.candidateMetrics(), finalFullStateHash: result.finalFullStateHash };
writeFileSync(new URL("./results/parity-diagnosis.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));

import { mkdirSync, writeFileSync } from "node:fs";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import { initializeRecast } from "./incremental-candidate";
import { RecastRouteEngine } from "./incremental-engine";

await initializeRecast();
const engine = new RecastRouteEngine();
const candidate: MovementCandidateAdapter = {
  id: "incremental-geometry-diagnosis",
  createTransport(context) {
    let receive: ((response: import("../../../src/sim/path/protocol").PathResponse) => void) | undefined;
    return {
      attach(onReceive) { receive = onReceive; },
      send(request) {
        context.onRequest(request);
        const started = context.now();
        const response = engine.handle(request, context.now);
        context.onResponse(response, context.now() - started);
        receive?.(response);
      },
      dispose() {},
    };
  },
  candidateMetrics: () => engine.candidateMetrics(),
  dispose: () => engine.dispose(),
};
const population = Number(process.argv[2] ?? 40);
const ticks = Number(process.argv[3] ?? 400);
const result = runBenchmark({
  scenario: scenarioByName("narrow-mutation-120"),
  population,
  ticks,
  candidate,
  evidenceClass: "node-inline",
});
const output = {
  population,
  ticks,
  finalFullStateHash: result.finalFullStateHash,
  geometryFailureSamples: engine.geometryFailureSamples,
  requests: result.pathRequests.filter((entry) => engine.geometryFailureSamples.some((sample) => sample.id === entry.id)),
  mutations: result.mutations,
  candidateMetrics: result.candidateMetrics,
};
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const destination = new URL(`./results/geometry-diagnosis-p${population}-t${ticks}.json`, import.meta.url);
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));

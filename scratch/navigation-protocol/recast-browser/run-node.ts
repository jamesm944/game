import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "../../full-game-movement/harness/runner";
import { scenarioByName } from "../../full-game-movement/harness/scenarios";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import { createRecastCandidate } from "../../phase2-navigation/recast-corridor/corridor-candidate";
import type { RecastRouteRecord } from "./worker-adapter";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const scenarioName = argument("scenario") ?? "dense-open-120";
const population = Number(argument("population") ?? "1000");
const ticksRaw = argument("ticks");
const name = argument("name") ?? `node-recast-${scenarioName}-p${population}${ticksRaw ? `-t${ticksRaw}` : ""}`;
if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("invalid name");
const baseline = await createRecastCandidate();
const routes: RecastRouteRecord[] = [];
const candidate: MovementCandidateAdapter = {
  ...baseline,
  createTransport(context) {
    return baseline.createTransport({
      ...context,
      onResponse(response, computeMs) {
        routes.push({ id: response.id, ok: response.ok, cost: response.cost, waypoints: Array.from(response.waypoints) });
        context.onResponse(response, computeMs);
      },
    });
  },
};
const result = runBenchmark({
  scenario: scenarioByName(scenarioName),
  population,
  candidate,
  evidenceClass: "node-inline",
  ...(ticksRaw !== undefined ? { ticks: Number(ticksRaw) } : {}),
});
const root = path.dirname(fileURLToPath(import.meta.url));
const donor = path.resolve(root, "../../donor-audit/browser/voidstrike/node_modules");
const packages = Object.fromEntries(["recast-navigation", "@recast-navigation/core", "@recast-navigation/generators", "@recast-navigation/wasm"].map((entry) => {
  const json = JSON.parse(readFileSync(path.join(donor, entry, "package.json"), "utf8")) as { version: string; license: string };
  return [entry, { version: json.version, license: json.license }];
}));
const wasm = readFileSync(path.join(donor, "@recast-navigation/wasm/dist/recast-navigation.wasm.wasm"));
const output = path.join(root, "results", `${name}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  ...result,
  recastRoutes: routes,
  evidenceScope: "preserved-corrected-node-recast-engine-with-route-capture",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, release: os.release(), architecture: process.arch, cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
  provenance: { packages, wasmBytes: wasm.byteLength, wasmSha256: createHash("sha256").update(wasm).digest("hex") },
}, null, 2)}\n`);
console.log(JSON.stringify({ output, tick: result.finalTick, requests: result.pathRequests.length, hash: result.finalFullStateHash, routes: routes.length }));

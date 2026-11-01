// Wayfinder #173 verification: exact Recast routes vs corrected full-rebuild Node
// Recast oracle; A* logical/final-hash vs preserved Node A* sync references;
// protocol invariants (IDs, due ticks, two-tick application, bounded stores).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "../../..");
const scenarios = [
  ["dense-open-120", "dense"],
  ["mixed-destinations-120", "mixed"],
  ["narrow-mutation-120", "narrow"],
] as const;

async function loadJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Same logical projection as integrated/validate-replay.mjs (#171).
function logical(result: any) {
  return JSON.stringify({
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
    paths: result.pathRequests.map((request: any) => ({
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
  });
}

function protocolViolations(
  sample: BenchmarkResult & { protocol: any },
  engine: string,
): string[] {
  const violations: string[] = [];
  sample.pathRequests.forEach((request, index) => {
    if (request.id !== index + 1)
      violations.push(`non-monotonic-request-id@${index}`);
    if (request.dueTick !== request.issueTick + 2)
      violations.push(`due-tick-contract@${request.id}`);
    if (request.applyTick !== undefined && request.issueToApplyTicks !== 2)
      violations.push(`late-or-early-application@${request.id}`);
    if (request.issueToResponseMs === undefined)
      violations.push(`missing-response-timing@${request.id}`);
  });
  if (engine === "recast") {
    const protocol = sample.protocol;
    if (protocol.errors.length)
      violations.push(`worker-errors:${protocol.errors.join(";")}`);
    if (protocol.snapshotAcks.length !== protocol.snapshotSends.length)
      violations.push("missing-snapshot-acknowledgment");
    if (
      protocol.snapshotSends[0]?.operation !== "register" ||
      !protocol.snapshotSends
        .slice(1)
        .every((event: any) => event.operation === "update")
    )
      violations.push("full-delta-sequence");
    if (
      Math.max(...protocol.responses.map((entry: any) => entry.snapshotCount)) >
      2
    )
      violations.push("worker-snapshot-capacity>2");
    if (
      Math.max(...protocol.responses.map((entry: any) => entry.snapshotBytes)) >
      28_800
    )
      violations.push("worker-snapshot-bytes>28800");
    if (protocol.mainRetainedSnapshotCount !== 1)
      violations.push("main-snapshot-retention!=1");
    const cm = sample.candidateMetrics as any;
    if (cm.revisionCacheEntries > cm.revisionCacheCapacity)
      violations.push("revision-cache-over-capacity");
    if (cm.geometryRejections !== 0)
      violations.push(`geometry-rejections=${cm.geometryRejections}`);
    if (cm.nativeQueryFailures !== 0)
      violations.push(`native-query-failures=${cm.nativeQueryFailures}`);
    if (cm.navmeshGenerationFailures !== 0)
      violations.push(
        `navmesh-generation-failures=${cm.navmeshGenerationFailures}`,
      );
    if (cm.workerErrorCount !== 0)
      violations.push(`worker-error-count=${cm.workerErrorCount}`);
  } else {
    const cm = sample.candidateMetrics as any;
    if (cm.maxWorkerSnapshotCount > 2)
      violations.push("astar-worker-snapshot-count>2");
    if (cm.maxPathCacheSize > 32) violations.push("astar-path-cache>32");
    if (cm.maxBatchSize !== 1)
      violations.push(`astar-not-fifo:maxBatchSize=${cm.maxBatchSize}`);
  }
  return violations;
}

const report: any = {
  schema: "wayfinder-173-verification-v1",
  generatedAt: new Date().toISOString(),
  scenarios: {},
};
let allPassed = true;
for (const [scenario, short] of scenarios) {
  const entry: any = { astar: [], recast: [] };
  const astarReference = await loadJson(
    path.join(
      REPO,
      `scratch/full-game-movement/harness/results/${scenario}-p1000-sync.json`,
    ),
  );
  const recastOracle = await loadJson(
    path.join(ROOT, "results", `node-recast-oracle-${short}-p1000-t3600.json`),
  );
  entry.astarReference = astarReference
    ? {
        candidate: astarReference.candidate,
        finalTick: astarReference.finalTick,
        population: astarReference.population,
        requests: astarReference.pathRequests.length,
        finalFullStateHash: astarReference.finalFullStateHash,
        completed: astarReference.crowdStates.completed,
      }
    : null;
  entry.recastOracle = recastOracle
    ? {
        candidate: recastOracle.candidate,
        finalTick: recastOracle.finalTick,
        population: recastOracle.population,
        requests: recastOracle.pathRequests.length,
        routes: recastOracle.recastRoutes.length,
        finalFullStateHash: recastOracle.finalFullStateHash,
        completed: recastOracle.crowdStates.completed,
        wasmSha256: recastOracle.provenance?.wasmSha256,
      }
    : null;
  const hashes: Record<string, Set<string>> = {
    astar: new Set(),
    recast: new Set(),
  };
  for (let iteration = 1; iteration <= 4; iteration += 1) {
    for (const engine of ["astar", "recast"] as const) {
      const run = await loadJson(
        path.join(
          ROOT,
          "results",
          `chrome-${engine}-${short}-iter${iteration}.json`,
        ),
      );
      if (!run) continue;
      const sample = run.samples[0];
      hashes[engine].add(sample.finalFullStateHash);
      const row: any = {
        iteration,
        requests: sample.pathRequests.length,
        finalFullStateHash: sample.finalFullStateHash,
        completed: sample.crowdStates.completed,
        activeAtCutoff: sample.population - sample.crowdStates.completed,
        noPathResponses: sample.pathRequests.filter(
          (request: any) => request.ok === false,
        ).length,
        protocolViolations: protocolViolations(sample, engine),
      };
      if (engine === "astar") {
        row.logicalEqualToNodeReference = astarReference
          ? logicalBenchmarkString(sample) ===
            logicalBenchmarkString(astarReference)
          : null;
        row.finalHashEqualToNodeReference = astarReference
          ? sample.finalFullStateHash === astarReference.finalFullStateHash
          : null;
        row.passed =
          row.protocolViolations.length === 0 &&
          row.logicalEqualToNodeReference === true &&
          row.finalHashEqualToNodeReference === true;
      } else {
        const routes = sample.recastRoutes as any[];
        let mismatches = 0;
        let firstMismatch: any = null;
        if (recastOracle) {
          const oracleRoutes = recastOracle.recastRoutes as any[];
          const count = Math.max(routes.length, oracleRoutes.length);
          for (let index = 0; index < count; index += 1) {
            if (
              JSON.stringify(routes[index]) !==
              JSON.stringify(oracleRoutes[index])
            ) {
              mismatches += 1;
              if (!firstMismatch)
                firstMismatch = {
                  index,
                  browser: routes[index],
                  node: oracleRoutes[index],
                };
            }
          }
          // False no-path: browser says no route where the full-rebuild oracle found one (same position in stream).
          row.falseNoPath = routes.filter(
            (route, index) =>
              route && route.ok === false && oracleRoutes[index]?.ok === true,
          ).length;
        }
        row.routesBrowser = routes.length;
        row.routesNodeOracle = recastOracle
          ? recastOracle.recastRoutes.length
          : null;
        row.routeMismatches = recastOracle ? mismatches : null;
        row.firstRouteMismatch = firstMismatch;
        row.logicalEqualToNodeOracle = recastOracle
          ? logical(sample) === logical(recastOracle)
          : null;
        row.finalHashEqualToNodeOracle = recastOracle
          ? sample.finalFullStateHash === recastOracle.finalFullStateHash
          : null;
        row.wasmMatchesNode =
          recastOracle && run.provenance
            ? run.provenance.wasmSha256 === recastOracle.provenance.wasmSha256
            : null;
        row.passed =
          row.protocolViolations.length === 0 &&
          row.routeMismatches === 0 &&
          row.falseNoPath === 0 &&
          row.logicalEqualToNodeOracle === true &&
          row.finalHashEqualToNodeOracle === true &&
          row.wasmMatchesNode === true;
      }
      if (!row.passed) allPassed = false;
      entry[engine].push(row);
    }
  }
  entry.repeatHashesStable = {
    astar: hashes.astar.size <= 1,
    recast: hashes.recast.size <= 1,
  };
  if (hashes.astar.size > 1 || hashes.recast.size > 1) allPassed = false;
  report.scenarios[scenario] = entry;
}
report.allPassed = allPassed;
await writeFile(
  path.join(ROOT, "results", "verification-173.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
if (!allPassed) process.exitCode = 1;

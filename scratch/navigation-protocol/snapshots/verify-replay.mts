import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, "results");
const configurations = [
  ...[1, 2, 3].map((sample) => ({
    file: `chrome-versioned-mixed-p1000-t3600-sample-${String(sample).padStart(2, "0")}.json`,
    reference: "../../full-game-movement/harness/results/mixed-destinations-120-p1000-sync.json",
    scenario: "mixed-destinations-120",
    population: 1000,
    ticks: 3600,
  })),
  {
    file: "chrome-versioned-mutation-p100-t600-sample-01.json",
    reference: "../../full-game-movement/harness/results/narrow-mutation-120-p100-t600-sync-a.json",
    scenario: "narrow-mutation-120",
    population: 100,
    ticks: 600,
  },
];
const comparisons = [];
for (const configuration of configurations) {
  const referencePath = path.resolve(ROOT, configuration.reference);
  const reference = JSON.parse(await readFile(referencePath, "utf8")) as BenchmarkResult;
  const run = JSON.parse(await readFile(path.join(RESULTS, configuration.file), "utf8")) as {
    samples: readonly BenchmarkResult[];
  };
  if (run.samples.length !== 1 || reference.scenario.name !== configuration.scenario
    || reference.population !== configuration.population || reference.finalTick !== configuration.ticks) {
    throw new Error(`unexpected reference or sample: ${configuration.file}`);
  }
  const measured = run.samples[0]!;
  const logicalEqual = logicalBenchmarkString(measured) === logicalBenchmarkString(reference);
  const finalFullStateHashEqual = measured.finalFullStateHash === reference.finalFullStateHash;
  comparisons.push({
    file: configuration.file,
    referencePath,
    logicalEqual,
    finalFullStateHashEqual,
    browserFinalFullStateHash: measured.finalFullStateHash,
    nodeFinalFullStateHash: reference.finalFullStateHash,
    browserFrames: measured.frames,
    browserBlockedFrames: measured.scheduler.blockedTicks,
    nodeFrames: reference.frames,
    nodeBlockedTicks: reference.scheduler.blockedTicks,
  });
}
const allLogicalEqual = comparisons.every((entry) => entry.logicalEqual);
const allFinalFullStateHashesEqual = comparisons.every((entry) => entry.finalFullStateHashEqual);
const output = {
  schema: "wayfinder-169-replay-equivalence-v1",
  generatedAt: new Date().toISOString(),
  comparison: "logicalBenchmarkString plus final hash; versioned Chrome A* against preserved same-scenario Node A*",
  allLogicalEqual,
  allFinalFullStateHashesEqual,
  comparisons,
};
await writeFile(path.join(RESULTS, "replay-equivalence.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!allLogicalEqual || !allFinalFullStateHashesEqual) throw new Error("replay mismatch");

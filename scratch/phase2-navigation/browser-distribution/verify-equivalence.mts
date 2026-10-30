import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logicalBenchmarkString } from "../../full-game-movement/harness/browser/full-game/replay";
import type { BenchmarkResult } from "../../full-game-movement/harness/types";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, "results");
const referencePath = path.resolve(
  ROOT,
  "../../full-game-movement/harness/results/mixed-destinations-120-p1000-sync.json",
);
const reference = JSON.parse(await readFile(referencePath, "utf8")) as BenchmarkResult;
if (reference.candidate !== "current-integer-astar" || reference.scenario.name !== "mixed-destinations-120"
  || reference.population !== 1000 || reference.finalTick !== 3600) {
  throw new Error("unexpected preserved Node reference");
}
const referenceLogical = logicalBenchmarkString(reference);
const comparisons = [];
for (let sampleNumber = 1; sampleNumber <= 5; sampleNumber += 1) {
  const file = `chrome-mixed-p1000-t3600-sample-${String(sampleNumber).padStart(2, "0")}.json`;
  const run = JSON.parse(await readFile(path.join(RESULTS, file), "utf8")) as {
    readonly candidate: string;
    readonly samples: readonly BenchmarkResult[];
  };
  if (run.candidate !== "astar" || run.samples.length !== 1) throw new Error(`${file}: invalid sample`);
  const sample = run.samples[0]!;
  const logicalEqual = logicalBenchmarkString(sample) === referenceLogical;
  const finalFullStateHashEqual = sample.finalFullStateHash === reference.finalFullStateHash;
  comparisons.push({
    sample: sampleNumber,
    file,
    candidate: run.candidate,
    logicalEqual,
    finalFullStateHashEqual,
    browserFinalFullStateHash: sample.finalFullStateHash,
    nodeFinalFullStateHash: reference.finalFullStateHash,
    browserFrames: sample.frames,
    browserBlockedFrames: sample.scheduler.blockedTicks,
    nodeFrames: reference.frames,
    nodeBlockedTicks: reference.scheduler.blockedTicks,
  });
}
const allLogicalEqual = comparisons.every((comparison) => comparison.logicalEqual);
const allFinalFullStateHashesEqual = comparisons.every((comparison) => comparison.finalFullStateHashEqual);
const result = {
  schema: "wayfinder-168-replay-equivalence-v1",
  generatedAt: new Date().toISOString(),
  comparison: "logicalBenchmarkString plus explicit finalFullStateHash; Chrome A* versus preserved Node A* only",
  referencePath,
  referenceFinalFullStateHash: reference.finalFullStateHash,
  sampleCount: comparisons.length,
  allLogicalEqual,
  allFinalFullStateHashesEqual,
  comparisons,
};
await writeFile(path.join(RESULTS, "replay-equivalence.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!allLogicalEqual || !allFinalFullStateHashesEqual) {
  throw new Error("one or more Chrome samples differ from preserved Node A* replay");
}

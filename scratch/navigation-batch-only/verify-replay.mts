import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logicalBenchmarkString } from "../full-game-movement/harness/browser/full-game/replay";
import type { BenchmarkResult } from "../full-game-movement/harness/types";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const referencePath = path.resolve(ROOT, "../full-game-movement/harness/results/mixed-destinations-120-p1000-sync.json");
const reference = JSON.parse(await readFile(referencePath, "utf8")) as BenchmarkResult;
const policies = ["fifo", "batch-8", "batch-16", "batch-32", "batch-64"] as const;
const comparisons = [];
for (const policy of policies) {
  for (let iteration = 1; iteration <= 4; iteration += 1) {
    const file = `chrome-${policy}-mixed-iteration-${iteration}.json`;
    const run = JSON.parse(await readFile(path.join(ROOT, "results", file), "utf8")) as {
      readonly samples: readonly BenchmarkResult[];
    };
    if (run.samples.length !== 1) throw new Error(`invalid ${file}`);
    const sample = run.samples[0]!;
    const applicationTicksValid = sample.pathRequests
      .filter((request) => request.applyTick !== undefined)
      .every((request) => request.issueToApplyTicks === 2);
    comparisons.push({
      policy,
      iteration,
      file,
      logicalEqual: logicalBenchmarkString(sample) === logicalBenchmarkString(reference),
      finalFullStateHashEqual: sample.finalFullStateHash === reference.finalFullStateHash,
      applicationTicksValid,
      browserFinalFullStateHash: sample.finalFullStateHash,
      nodeFinalFullStateHash: reference.finalFullStateHash,
      frames: sample.frames,
      blockedFrames: sample.scheduler.blockedTicks,
    });
  }
}
const allLogicalEqual = comparisons.every((entry) => entry.logicalEqual);
const allFinalFullStateHashesEqual = comparisons.every((entry) => entry.finalFullStateHashEqual);
const allApplicationTicksValid = comparisons.every((entry) => entry.applicationTicksValid);
const output = {
  schema: "wayfinder-171-replay-equivalence-v1",
  generatedAt: new Date().toISOString(),
  referencePath,
  referenceFinalFullStateHash: reference.finalFullStateHash,
  allLogicalEqual,
  allFinalFullStateHashesEqual,
  allApplicationTicksValid,
  comparisons,
};
await writeFile(path.join(ROOT, "results", "replay-equivalence.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!allLogicalEqual || !allFinalFullStateHashesEqual || !allApplicationTicksValid) {
  throw new Error("queue policy replay or application-tick mismatch");
}

import { readFileSync, writeFileSync } from "node:fs";
import type { BenchmarkResult } from "../../types";
import { logicalBenchmarkString } from "./replay";

const root = new URL("./results/", import.meta.url);
const nodeRoot = new URL("../../results/", import.meta.url);
function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}
interface BrowserRun {
  readonly browser: string;
  readonly browserVersion: string;
  readonly samples: readonly BenchmarkResult[];
  readonly repeatLogicalResultsEqual: boolean;
}
const pairs = [
  { candidate: "astar", scenario: "dense-open-120-p1000", browser: "chrome-astar-dense-p1000-t3600.json", node: "dense-open-120-p1000-sync.json" },
  { candidate: "astar", scenario: "mixed-destinations-120-p1000", browser: "chrome-astar-mixed-p1000-t3600.json", node: "mixed-destinations-120-p1000-sync.json" },
  { candidate: "flow", scenario: "dense-open-120-p1000", browser: "chrome-flow-dense-p1000-t3600.json", node: "dense-open-120-p1000-flow.json" },
  { candidate: "astar", scenario: "narrow-mutation-120-p100-t600", browser: "chrome-astar-mutation-p100-t600-replay.json", node: "narrow-mutation-120-p100-t600-sync-a.json" },
  { candidate: "flow", scenario: "narrow-mutation-120-p100-t600", browser: "chrome-flow-mutation-p100-t600-replay.json", node: "narrow-mutation-120-p100-t600-flow-a.json" },
];
const comparisons = pairs.map((pair) => {
  const browser = readJson<BrowserRun>(new URL(pair.browser, root));
  const node = readJson<BenchmarkResult>(new URL(pair.node, nodeRoot));
  const nodeLogical = logicalBenchmarkString(node);
  return {
    ...pair,
    browser: browser.browser,
    browserVersion: browser.browserVersion,
    browserSamples: browser.samples.length,
    logicalEqualPerSample: browser.samples.map((sample) => logicalBenchmarkString(sample) === nodeLogical),
    finalFullStateHashEqualPerSample: browser.samples.map((sample) => sample.finalFullStateHash === node.finalFullStateHash),
    finalFullStateHash: node.finalFullStateHash,
    browserFrames: browser.samples.map((sample) => sample.frames),
    nodeFrames: node.frames,
    browserBlockedTicks: browser.samples.map((sample) => sample.scheduler.blockedTicks),
    nodeBlockedTicks: node.scheduler.blockedTicks,
  };
});
if (!comparisons.every((comparison) => comparison.logicalEqualPerSample.every(Boolean))) {
  throw new Error("browser/Node logical mismatch");
}
const document = {
  scope: "same-candidate-real-Chrome-worker-versus-preserved-Node-inline-logical-results",
  crossArchitectureHashEqualityRequired: false,
  comparisons,
};
writeFileSync(new URL("node-equivalence.json", root), `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify(document, null, 2));

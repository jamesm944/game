/**
 * Perf budget recorder — SPEC §7 / M1-T11 + M2-T11 + M3-T10.
 *
 * Runs the canonical §7 budget scenarios and prints markdown table
 * fragments for docs/m1-budget.md (economy workload),
 * docs/m2-budget.md (combat+fog workload) and docs/m3-budget.md
 * (deep-sim + schedules workload).
 * Usage: npx tsx tools/perf-record.ts [runs]
 */

import {
  runBudgetScenario,
  type BudgetRunResult,
} from "../tests/helpers/budget-scenario";
import {
  runBudgetScenarioM2,
  type BudgetM2RunResult,
} from "../tests/helpers/budget-scenario-m2";
import {
  runBudgetScenarioM3,
  type BudgetM3RunResult,
} from "../tests/helpers/budget-scenario-m3";

const runs = Math.max(1, Number.parseInt(process.argv[2] ?? "3", 10));

console.log(`Running the §7 M1 budget scenario ${String(runs)}×…`);
const results: BudgetRunResult[] = [];
for (let i = 0; i < runs; i++) {
  results.push(runBudgetScenario());
}

console.log("");
console.log(
  `Running the §7 M2 budget scenario ${String(runs)}× (combat+fog active)…`,
);
const resultsM2: BudgetM2RunResult[] = [];
for (let i = 0; i < runs; i++) {
  resultsM2.push(runBudgetScenarioM2());
}

console.log("");
console.log(
  `Running the §7 M3 budget scenario ${String(runs)}× (deep-sim+schedules active)…`,
);
const resultsM3: BudgetM3RunResult[] = [];
for (let i = 0; i < runs; i++) {
  resultsM3.push(runBudgetScenarioM3());
}

const pick = (key: keyof BudgetRunResult): number[] =>
  results.map((r) => r[key]);
const pickM2 = (key: keyof BudgetM2RunResult): number[] =>
  resultsM2.map((r) => r[key] as number);
const pickM3 = (key: keyof BudgetM3RunResult): number[] =>
  resultsM3.map((r) => r[key] as number);
const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(3)).join(" / ");
const min = (xs: number[]): number => Math.min(...xs);
const med = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

for (const r of results) {
  console.log(
    `m1: mean ${r.meanTickMs.toFixed(3)} ms · p95 ${r.p95TickMs.toFixed(3)} ms · ` +
      `max ${r.maxTickMs.toFixed(3)} ms · mirror copy ${r.mirrorCopyMs.toFixed(4)} ms`,
  );
}
for (const r of resultsM2) {
  console.log(
    `m2: mean ${r.meanTickMs.toFixed(3)} ms · p95 ${r.p95TickMs.toFixed(3)} ms · ` +
      `max ${r.maxTickMs.toFixed(3)} ms · mirror copy ${r.mirrorCopyMs.toFixed(4)} ms · ` +
      `survivors ${r.survivorsPerSide[0]}/${r.survivorsPerSide[1]}`,
  );
}
for (const r of resultsM3) {
  console.log(
    `m3: mean ${r.meanTickMs.toFixed(3)} ms · p95 ${r.p95TickMs.toFixed(3)} ms · ` +
      `max ${r.maxTickMs.toFixed(3)} ms · mirror copy ${r.mirrorCopyMs.toFixed(4)} ms · ` +
      `households ${String(r.householdsFormed)} · population ${String(r.populationEnd)}`,
  );
}
console.log("");
console.log("### M1 economy workload (300 villagers · 300 ticks)");
console.log(
  `| Metric | Runs (${String(runs)}) | Best | Median | §7 cap |
| ---------------------------------- | ----------- | ---- | ------ | ------ |
| Sim tick mean (ms) | ${fmt(pick("meanTickMs"))} | ${min(pick("meanTickMs")).toFixed(3)} | ${med(pick("meanTickMs")).toFixed(3)} | — |
| Sim tick p95 (ms) | ${fmt(pick("p95TickMs"))} | ${min(pick("p95TickMs")).toFixed(3)} | ${med(pick("p95TickMs")).toFixed(3)} | ≤ 8 hard |
| Sim tick max (ms) | ${fmt(pick("maxTickMs"))} | ${min(pick("maxTickMs")).toFixed(3)} | ${med(pick("maxTickMs")).toFixed(3)} | — |
| Mirror snapshot copy (ms) | ${pick("mirrorCopyMs")
    .map((x) => x.toFixed(4))
    .join(
      " / ",
    )} | ${min(pick("mirrorCopyMs")).toFixed(4)} | ${med(pick("mirrorCopyMs")).toFixed(4)} | ≤ 2 @500 inst |
| Draw calls (static approximation) | — | ${String(results[0]!.drawCallApprox)} | ${String(results[0]!.drawCallApprox)} | ≤ 90 typ / ≤ 150 hard |`,
);
console.log("");
console.log(
  "### M2 workload — combat+fog active (300v + 200 knights · 300 ticks)",
);
console.log(
  `| Metric | Runs (${String(runs)}) | Best | Median | §7 cap |
| ---------------------------------- | ----------- | ---- | ------ | ------ |
| Sim tick mean (ms) | ${fmt(pickM2("meanTickMs"))} | ${min(pickM2("meanTickMs")).toFixed(3)} | ${med(pickM2("meanTickMs")).toFixed(3)} | — |
| Sim tick p95 (ms) | ${fmt(pickM2("p95TickMs"))} | ${min(pickM2("p95TickMs")).toFixed(3)} | ${med(pickM2("p95TickMs")).toFixed(3)} | ≤ 8 hard |
| Sim tick max (ms) | ${fmt(pickM2("maxTickMs"))} | ${min(pickM2("maxTickMs")).toFixed(3)} | ${med(pickM2("maxTickMs")).toFixed(3)} | — |
| Mirror snapshot copy (ms) | ${pickM2("mirrorCopyMs")
    .map((x) => x.toFixed(4))
    .join(
      " / ",
    )} | ${min(pickM2("mirrorCopyMs")).toFixed(4)} | ${med(pickM2("mirrorCopyMs")).toFixed(4)} | ≤ 2 @500 inst |
| Draw calls (static approximation) | — | ${String(resultsM2[0]!.drawCallApprox)} | ${String(resultsM2[0]!.drawCallApprox)} | ≤ 90 typ / ≤ 150 hard |`,
);
console.log("");
console.log(
  "### M3 workload — deep-sim+schedules active (305 deep Pops · 600 ticks)",
);
console.log(
  `| Metric | Runs (${String(runs)}) | Best | Median | §7 cap |
| ---------------------------------- | ----------- | ---- | ------ | ------ |
| Sim tick mean (ms) | ${fmt(pickM3("meanTickMs"))} | ${min(pickM3("meanTickMs")).toFixed(3)} | ${med(pickM3("meanTickMs")).toFixed(3)} | — |
| Sim tick p95 (ms) | ${fmt(pickM3("p95TickMs"))} | ${min(pickM3("p95TickMs")).toFixed(3)} | ${med(pickM3("p95TickMs")).toFixed(3)} | ≤ 8 hard |
| Sim tick max (ms) | ${fmt(pickM3("maxTickMs"))} | ${min(pickM3("maxTickMs")).toFixed(3)} | ${med(pickM3("maxTickMs")).toFixed(3)} | — |
| Mirror snapshot copy (ms) | ${pickM3("mirrorCopyMs")
    .map((x) => x.toFixed(4))
    .join(
      " / ",
    )} | ${min(pickM3("mirrorCopyMs")).toFixed(4)} | ${med(pickM3("mirrorCopyMs")).toFixed(4)} | ≤ 2 @500 inst |
| Draw calls (static approximation) | — | ${String(resultsM3[0]!.drawCallApprox)} | ${String(resultsM3[0]!.drawCallApprox)} | ≤ 90 typ / ≤ 150 hard |`,
);

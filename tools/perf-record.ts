/**
 * Perf budget recorder — SPEC §7 / M1-T11.
 *
 * Runs the canonical §7 budget scenario (tests/helpers/budget-scenario)
 * N times and prints a markdown table fragment for docs/m1-budget.md.
 * Usage: npx tsx tools/perf-record.ts [runs]
 */

import {
  runBudgetScenario,
  type BudgetRunResult,
} from "../tests/helpers/budget-scenario";

const runs = Math.max(1, Number.parseInt(process.argv[2] ?? "3", 10));

console.log(`Running the §7 budget scenario ${String(runs)}×…`);
const results: BudgetRunResult[] = [];
for (let i = 0; i < runs; i++) {
  results.push(runBudgetScenario());
}

const pick = (key: keyof BudgetRunResult): number[] =>
  results.map((r) => r[key]);
const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(3)).join(" / ");
const min = (xs: number[]): number => Math.min(...xs);
const med = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

for (const r of results) {
  console.log(
    `run: mean ${r.meanTickMs.toFixed(3)} ms · p95 ${r.p95TickMs.toFixed(3)} ms · ` +
      `max ${r.maxTickMs.toFixed(3)} ms · mirror copy ${r.mirrorCopyMs.toFixed(4)} ms`,
  );
}
console.log("");
console.log(
  `| Metric (300 villagers · 300 ticks) | Runs (${String(runs)}) | Best | Median | §7 cap |`,
);
console.log(
  `| ---------------------------------- | ----------- | ---- | ------ | ------ |`,
);
console.log(
  `| Sim tick mean (ms) | ${fmt(pick("meanTickMs"))} | ${min(pick("meanTickMs")).toFixed(3)} | ${med(pick("meanTickMs")).toFixed(3)} | — |`,
);
console.log(
  `| Sim tick p95 (ms) | ${fmt(pick("p95TickMs"))} | ${min(pick("p95TickMs")).toFixed(3)} | ${med(pick("p95TickMs")).toFixed(3)} | ≤ 8 hard |`,
);
console.log(
  `| Sim tick max (ms) | ${fmt(pick("maxTickMs"))} | ${min(pick("maxTickMs")).toFixed(3)} | ${med(pick("maxTickMs")).toFixed(3)} | — |`,
);
console.log(
  `| Mirror snapshot copy (ms) | ${pick("mirrorCopyMs")
    .map((x) => x.toFixed(4))
    .join(
      " / ",
    )} | ${min(pick("mirrorCopyMs")).toFixed(4)} | ${med(pick("mirrorCopyMs")).toFixed(4)} | ≤ 2 @500 inst |`,
);
console.log(
  `| Draw calls (static approximation) | — | ${String(results[0]!.drawCallApprox)} | ${String(results[0]!.drawCallApprox)} | ≤ 90 typ / ≤ 150 hard |`,
);

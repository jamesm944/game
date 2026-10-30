import { writeFile } from "node:fs/promises";
import { runDenseBenchmark } from "./runner";
import type { QueuePolicy } from "./protocol";
const policy = (process.argv[process.argv.indexOf("--policy") + 1] ?? "fifo") as QueuePolicy;
const ticks = Number(process.argv[process.argv.indexOf("--ticks") + 1] ?? 3600);
const delay = Number(process.argv[process.argv.indexOf("--delay") + 1] ?? 10);
const name = process.argv[process.argv.indexOf("--name") + 1] ?? `node-${policy}-delayed`;
const result = await runDenseBenchmark({ policy, ticks, localWorkerDelayMs: delay, rendererPaced: false,
  waitFrame: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); return performance.now(); },
  onProgress: (tick, frames, pending) => { if (frames % 600 === 0) console.log({ tick, frames, pending }); } });
await writeFile(new URL(`./results/${name}.json`, import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ policy, ticks, wallClockMs: result.wallClockMs, requests: result.requests.length,
  hash: result.finalFullStateHash, outcomes: result.outcomeCounts, candidateMetrics: result.candidateMetrics }));

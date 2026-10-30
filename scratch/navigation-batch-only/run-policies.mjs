#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../..");
const RESULTS = path.join(ROOT, "results");
const PAGE_PATH = "/scratch/navigation-batch-only/index.html";
const iteration = Number(process.argv[process.argv.indexOf("--iteration") + 1]);
if (!Number.isInteger(iteration) || iteration < 1 || iteration > 4) throw new Error("use --iteration 1, 2, 3, or 4");
const policies = ["fifo", "batch-8", "batch-16", "batch-32", "batch-64"];
const orders = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
  index + 1,
  policies.map((_, policyIndex) => policies[(policyIndex + index) % policies.length]),
]));
const policyOrder = orders[iteration];
await mkdir(RESULTS, { recursive: true });
for (const policy of policyOrder) {
  const output = path.join(RESULTS, `chrome-${policy}-mixed-iteration-${iteration}.json`);
  try {
    await access(output);
    throw new Error(`refusing to overwrite ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const host = {
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  node: process.version,
};
const server = await createServer({
  root: REPO_ROOT,
  configFile: false,
  cacheDir: path.join(ROOT, ".vite"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  console.log(`Chrome ${browser.version()} iteration ${iteration}: ${policyOrder.join(" -> ")}`);
  for (const policy of policyOrder) {
    const config = {
      policy,
      scenario: "mixed-destinations-120",
      population: 1000,
      ticks: 3600,
      warmupTicks: 400,
      warmupRuns: 1,
      measuredRuns: 1,
    };
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    try {
      await page.goto(`http://127.0.0.1:${address.port}${PAGE_PATH}`, { waitUntil: "networkidle", timeout: 60_000 });
      await page.waitForFunction(() => typeof window.runQueueBrowserBenchmark === "function", null, { timeout: 30_000 });
      console.log(`start ${policy} iteration ${iteration}`);
      const result = await page.evaluate((runConfig) => window.runQueueBrowserBenchmark(runConfig), config);
      if (errors.length) throw new Error(errors.join("\n"));
      const measured = result.samples[0];
      const outputPath = path.join(RESULTS, `chrome-${policy}-mixed-iteration-${iteration}.json`);
      await writeFile(outputPath, `${JSON.stringify({
        ...result,
        browser: "chrome",
        browserVersion: browser.version(),
        capturedAt: new Date().toISOString(),
        host,
        automation: "playwright",
        headless: true,
        iteration,
        policyOrder,
        config,
      }, null, 2)}\n`);
      console.log(JSON.stringify({
        policy,
        iteration,
        wallClockMs: measured.wallClockMs,
        frames: measured.frames,
        blockedTicks: measured.scheduler.blockedTicks,
        finalFullStateHash: measured.finalFullStateHash,
        candidateMetrics: measured.candidateMetrics,
      }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

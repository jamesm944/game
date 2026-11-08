#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../../..");
const RESULTS = path.join(ROOT, "results");
const PAGE_PATH = "/scratch/navigation-protocol/snapshots/index.html";
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const scenarioName = argument("scenario", "mixed");
const sample = Number(argument("sample", "1"));
if (!["mixed", "mutation"].includes(scenarioName)) throw new Error("scenario must be mixed or mutation");
if (!Number.isInteger(sample) || sample < 1 || sample > (scenarioName === "mixed" ? 3 : 1)) {
  throw new Error("mixed sample must be 1..3; mutation sample must be 1");
}
const config = {
  scenario: scenarioName === "mixed" ? "mixed-destinations-120" : "narrow-mutation-120",
  population: scenarioName === "mixed" ? 1000 : 100,
  ticks: scenarioName === "mixed" ? 3600 : 600,
  warmupRuns: 1,
  measuredRuns: 1,
};
const name = `chrome-versioned-${scenarioName}-p${config.population}-t${config.ticks}-sample-${String(sample).padStart(2, "0")}`;
const outputPath = path.join(RESULTS, `${name}.json`);
await mkdir(RESULTS, { recursive: true });
try {
  await access(outputPath);
  throw new Error(`refusing to overwrite ${outputPath}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}${PAGE_PATH}`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => typeof window.runVersionedBrowserBenchmark === "function", null, { timeout: 30_000 });
  console.log(`Chrome ${browser.version()}: ${scenarioName} sample ${sample}`);
  const result = await page.evaluate((runConfig) => window.runVersionedBrowserBenchmark(runConfig), config);
  if (errors.length) throw new Error(errors.join("\n"));
  const measured = result.samples[0];
  await writeFile(outputPath, `${JSON.stringify({
    ...result,
    browser: "chrome",
    browserVersion: browser.version(),
    capturedAt: new Date().toISOString(),
    host,
    automation: "playwright",
    headless: true,
    distributionSample: sample,
    config,
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    finalTick: measured.finalTick,
    wallClockMs: measured.wallClockMs,
    frames: measured.frames,
    blockedTicks: measured.scheduler.blockedTicks,
    requests: measured.pathRequests.length,
    finalFullStateHash: measured.finalFullStateHash,
    candidateMetrics: measured.candidateMetrics,
  }, null, 2));
} catch (error) {
  await writeFile(path.join(RESULTS, `${name}-error.json`), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    browserVersion: browser?.version(),
    host,
    config,
    error: String(error),
    stack: error?.stack,
  }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}

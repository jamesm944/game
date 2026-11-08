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
const PAGE_PATH = "/scratch/full-game-movement/harness/browser/full-game/index.html";
const CONFIG = Object.freeze({
  candidate: "astar",
  scenario: "mixed-destinations-120",
  population: 1000,
  ticks: 3600,
  warmupRuns: 1,
  measuredRuns: 1,
});

function sampleArgument() {
  const index = process.argv.indexOf("--sample");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  const sample = Number(value);
  if (!Number.isInteger(sample) || sample < 1 || sample > 5) {
    throw new Error("usage: node run-distribution.mjs --sample <1..5>");
  }
  return sample;
}

const sampleNumber = sampleArgument();
const sampleName = `chrome-mixed-p1000-t3600-sample-${String(sampleNumber).padStart(2, "0")}`;
const outputPath = path.join(RESULTS, `${sampleName}.json`);
await mkdir(RESULTS, { recursive: true });
try {
  await access(outputPath);
  throw new Error(`refusing to overwrite existing sample: ${outputPath}`);
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
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
const url = `http://127.0.0.1:${address.port}${PAGE_PATH}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(
    () => typeof window.runFullGameBrowserBenchmark === "function",
    null,
    { timeout: 30_000 },
  );
  console.log(`Chrome ${browser.version()}: sample ${sampleNumber}, one warmup plus one measured run`);
  const result = await page.evaluate(
    (runConfig) => window.runFullGameBrowserBenchmark(runConfig),
    CONFIG,
  );
  if (errors.length) throw new Error(errors.join("\n"));
  if (result.samples.length !== 1) throw new Error("expected exactly one measured sample");
  const sample = result.samples[0];
  const initialLeaders = sample.pathRequests.filter((request) => request.commandTick === 1);
  if (initialLeaders.length !== 8) throw new Error(`expected eight initial leaders, got ${initialLeaders.length}`);
  await writeFile(outputPath, `${JSON.stringify({
    ...result,
    browser: "chrome",
    browserVersion: browser.version(),
    capturedAt: new Date().toISOString(),
    host,
    automation: "playwright",
    headless: true,
    distributionSample: sampleNumber,
    config: CONFIG,
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    finalTick: sample.finalTick,
    wallClockMs: sample.wallClockMs,
    frames: sample.frames,
    blockedTicks: sample.scheduler.blockedTicks,
    requests: sample.pathRequests.length,
    repaths: sample.movementDiagnostics.repaths,
    finalFullStateHash: sample.finalFullStateHash,
  }, null, 2));
} catch (error) {
  await writeFile(path.join(RESULTS, `${sampleName}-error.json`), `${JSON.stringify({
    browser: "chrome",
    browserVersion: browser?.version(),
    capturedAt: new Date().toISOString(),
    host,
    distributionSample: sampleNumber,
    config: CONFIG,
    error: String(error),
    stack: error?.stack,
  }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}

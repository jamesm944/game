#!/usr/bin/env node
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../../..");
const RESULTS = path.join(ROOT, "results");
const iteration = Number(process.argv[process.argv.indexOf("--iteration") + 1]);
if (!Number.isInteger(iteration) || iteration < 1 || iteration > 5) throw new Error("use --iteration 1 through 5");
const policyOrder = iteration % 2 === 1 ? ["fifo", "batch-32"] : ["batch-32", "fifo"];
const smoke = process.argv.includes("--smoke");
const prefix = smoke ? "smoke-" : "";
await mkdir(RESULTS, { recursive: true });
for (const policy of policyOrder) {
  const output = path.join(RESULTS, `${prefix}chrome-${policy}-iteration-${iteration}.json`);
  try { await access(output); throw new Error(`refusing to overwrite ${output}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}
const server = await createServer({ root: REPO_ROOT, configFile: false, assetsInclude: ["**/*.gltf", "**/*.glb"], cacheDir: path.join(ROOT, ".vite"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
let browser;
const sessionId = randomUUID();
try {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-swiftshader"] });
  console.log(`Chrome ${browser.version()} iteration ${iteration} session ${sessionId}: ${policyOrder.join(" -> ")}`);
  for (const policy of policyOrder) {
    const config = { policy, population: 1000, ticks: smoke ? 60 : 3600, warmupTicks: smoke ? 30 : 60 };
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(String(error)); console.error(error.stack ?? String(error)); });
    page.on("response", (response) => { if (response.status() >= 400) console.error(`${response.status()} ${response.url()}`); });
    page.on("console", (message) => { if (message.type() === "error") console.error(message.text(), message.location()); });
    try {
      await page.goto(`http://127.0.0.1:${address.port}/scratch/navigation-renderer-paced/narrow/index.html`, { waitUntil: "networkidle", timeout: 60_000 });
      const importError = await page.evaluate(async () => {
        try { await import("/scratch/navigation-renderer-paced/narrow/browser-main.ts"); return null; }
        catch (error) { return error instanceof Error ? error.stack : String(error); }
      });
      if (importError) throw new Error(importError);
      await page.waitForFunction(() => typeof window.runRendererBenchmark === "function", null, { timeout: 30_000 });
      console.log(`start ${policy} iteration ${iteration} at ${new Date().toISOString()}`);
      const result = await page.evaluate((runConfig) => window.runRendererBenchmark(runConfig), config);
      if (errors.length) throw new Error(errors.join("\n"));
      const sample = result.samples[0];
      if (result.samples.length !== 1 || sample.finalTick !== config.ticks || result.warmup.finalTick !== config.warmupTicks) {
        throw new Error(`${policy} iteration ${iteration}: incomplete warmup or measured run`);
      }
      const output = path.join(RESULTS, `${prefix}chrome-${policy}-iteration-${iteration}.json`);
      const temporary = `${output}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify({ ...result,
        browser: "chrome", browserVersion: browser.version(), capturedAt: new Date().toISOString(),
        host: { platform: process.platform, release: os.release(), architecture: process.arch, cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
        automation: "playwright", headless: true, iteration, policyOrder, sessionId, config,
      }, null, 2)}\n`);
      await rename(temporary, output);
      console.log(JSON.stringify({ policy, iteration, wallClockMs: sample.wallClockMs, frames: sample.frames, blockedTicks: sample.scheduler.blockedTicks, finalFullStateHash: sample.finalFullStateHash, workloadComposition: sample.workloadComposition, candidateMetrics: sample.candidateMetrics }));
    } finally { await page.close(); }
  }
} finally { await browser?.close(); await server.close(); }

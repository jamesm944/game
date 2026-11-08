#!/usr/bin/env node
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path"; import process from "node:process";
import { fileURLToPath } from "node:url"; import { chromium } from "playwright"; import { createServer } from "vite";
const ROOT = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(ROOT, "../../..");
const RESULTS = path.join(ROOT, "results"); const iteration = Number(process.argv[process.argv.indexOf("--iteration") + 1]);
if (!Number.isInteger(iteration) || iteration < 1 || iteration > 5) throw new Error("use --iteration 1 through 5");
const policyOrder = iteration % 2 === 1 ? ["fifo", "batch-32"] : ["batch-32", "fifo"];
const selectedPolicies = policyOrder;
if (selectedPolicies.length !== 2) throw new Error("compliant matrix requires both policies in one browser session");
await mkdir(RESULTS, { recursive: true });
for (const policy of selectedPolicies) { const file = path.join(RESULTS, `chrome-${policy}-iteration-${iteration}.json`);
  try { await access(file); throw new Error(`refusing to overwrite ${file}`); } catch (e) { if (e?.code !== "ENOENT") throw e; } }
const host = { platform: process.platform, release: os.release(), architecture: process.arch,
  cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version };
const server = await createServer({ root: REPO, configFile: false, cacheDir: path.join(ROOT, ".vite"),
  assetsInclude: ["**/*.gltf", "**/*.glb"], logLevel: "error", server: { host: "127.0.0.1", port: 0 } }); await server.listen();
const address = server.httpServer.address(); if (!address || typeof address === "string") throw new Error("no Vite port");
const browserSessionId = `dense-v2-iteration-${iteration}-${Date.now()}`;
const methodologyVersion = "dense-renderer-paced-v2-shared-page-assets";
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-swiftshader"] });
  console.log(`Chrome ${browser.version()} iteration ${iteration}: ${selectedPolicies.join(" -> ")}; session ${browserSessionId}`);
  for (const policy of selectedPolicies) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }); const errors = [];
    page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") console.error(m.text()); });
    try { await page.goto(`http://127.0.0.1:${address.port}/scratch/navigation-renderer-paced/dense/index.html`, { waitUntil: "networkidle", timeout: 120000 });
      await page.waitForFunction(() => typeof window.runDenseBrowserBenchmark === "function", null, { timeout: 120000 });
      console.log(`start ${policy} iteration ${iteration} at ${new Date().toISOString()}`);
      const config = { policy, ticks: 3600, warmupTicks: 120 };
      const result = await page.evaluate((c) => window.runDenseBrowserBenchmark(c), config);
      if (errors.length) throw new Error(errors.join("\n"));
      const output = path.join(RESULTS, `chrome-${policy}-iteration-${iteration}.json`);
      const partial = `${output}.partial`;
      await writeFile(partial, `${JSON.stringify({ ...result, browser: "chrome", browserVersion: browser.version(),
        capturedAt: new Date().toISOString(), host, automation: "playwright", headless: true,
        iteration, policyOrder, browserSessionId, methodologyVersion, config })}\n`);
      await rename(partial, output);
      console.log(JSON.stringify({ policy, iteration, wallClockMs: result.measured.wallClockMs,
        frames: result.measured.frameCount, blockedTicks: result.measured.scheduler.blockedTicks,
        requests: result.measured.requests.length, outcomes: result.measured.outcomeCounts,
        hash: result.measured.finalFullStateHash, candidateMetrics: result.measured.candidateMetrics }));
    } finally { await page.close(); }
  }
} finally { await browser?.close(); await server.close(); }

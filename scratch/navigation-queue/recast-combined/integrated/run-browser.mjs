#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, preview } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../../../..");
const RESULTS = path.join(ROOT, "results");
const CONFIG = path.join(ROOT, "vite.config.ts");
const PAGE_PATH = "/scratch/navigation-queue/recast-combined/integrated/index.html";
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
if (process.arch !== "arm64" || process.platform !== "darwin") throw new Error(`This evidence runner requires macOS arm64; got ${process.platform} ${process.arch}`);
const smoke = process.argv.includes("--smoke");
const built = process.argv.includes("--built");
const scenario = argument("scenario", "dense-open-120");
const population = Number(argument("population", "1000"));
const ticksRaw = argument("ticks");
const warmupRuns = Number(argument("warmups", "0"));
const measuredRuns = Number(argument("samples", "1"));
if (!Number.isInteger(population) || population < 1) throw new Error("invalid population");
const config = { scenario, population, warmupRuns, measuredRuns, ...(ticksRaw !== undefined ? { ticks: Number(ticksRaw) } : {}) };
const name = argument("name", smoke ? `smoke${built ? "-built" : ""}` : `recast-${scenario}-p${population}${ticksRaw ? `-t${ticksRaw}` : ""}${built ? "-built" : ""}`);
if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("invalid result name");
const host = { platform: process.platform, release: os.release(), architecture: process.arch, cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version };
const donor = path.join(REPO_ROOT, "scratch/donor-audit/browser/voidstrike/node_modules");
const packages = Object.fromEntries(["recast-navigation", "@recast-navigation/core", "@recast-navigation/generators", "@recast-navigation/wasm"].map((entry) => {
  const json = JSON.parse(readFileSync(path.join(donor, entry, "package.json"), "utf8"));
  return [entry, { version: json.version, license: json.license }];
}));
const wasmPath = path.join(donor, "@recast-navigation/wasm/dist/recast-navigation.wasm.wasm");
const wasmBytes = readFileSync(wasmPath);
const provenance = { packages, wasmFile: "@recast-navigation/wasm/dist/recast-navigation.wasm.wasm", wasmBytes: wasmBytes.byteLength, wasmSha256: createHash("sha256").update(wasmBytes).digest("hex"), packaging: "Vite browser bundle of @recast-navigation/wasm-compat; provenance only, no donor files modified" };
const server = built ? await preview({ configFile: CONFIG, preview: { host: "127.0.0.1", port: 0 } }) : await createServer({ configFile: CONFIG, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
if (!built) await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
const url = `http://127.0.0.1:${address.port}${PAGE_PATH}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => { errors.push(String(error)); console.error(String(error)); });
  page.on("console", (message) => { if (message.type() === "error") { consoleErrors.push(message.text()); console.error(message.text()); } });
  page.on("requestfailed", (request) => console.error(`REQUEST FAILED ${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => typeof window.smokeRecastBrowserWorker === "function" && typeof window.runRecastBrowserBenchmark === "function", null, { timeout: 30_000 });
  console.log(`chrome ${browser.version()} ${built ? "built" : "dev"}: ${name}`);
  const result = smoke ? await page.evaluate(() => window.smokeRecastBrowserWorker()) : await page.evaluate((runConfig) => window.runRecastBrowserBenchmark(runConfig), config);
  if (errors.length || consoleErrors.length) throw new Error([...errors, ...consoleErrors].join("\n"));
  await mkdir(RESULTS, { recursive: true });
  const output = path.join(RESULTS, `chrome-${name}.json`);
  await writeFile(output, `${JSON.stringify({ ...result, smoke, artifactMode: built ? "vite-production-build" : "vite-development", browser: "chrome", browserVersion: browser.version(), capturedAt: new Date().toISOString(), host, automation: "playwright", headless: true, urlPath: PAGE_PATH, config: smoke ? undefined : config, provenance }, null, 2)}\n`);
  console.log(JSON.stringify(smoke ? { output, ready: result.ready, route: result.route } : { output, tick: result.samples.at(-1).finalTick, frames: result.samples.at(-1).frames, requests: result.samples.at(-1).pathRequests.length, repeat: result.repeatLogicalResultsEqual, hash: result.samples.at(-1).finalFullStateHash }));
} catch (error) {
  await mkdir(RESULTS, { recursive: true });
  await writeFile(path.join(RESULTS, `chrome-${name}-error.json`), `${JSON.stringify({ browser: "chrome", browserVersion: browser?.version(), capturedAt: new Date().toISOString(), host, smoke, artifactMode: built ? "vite-production-build" : "vite-development", config, provenance, error: String(error), stack: error?.stack }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}

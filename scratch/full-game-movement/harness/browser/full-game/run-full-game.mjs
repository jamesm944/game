#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../../../../..");
const RESULTS = path.join(ROOT, "results");
const PAGE_PATH = "/scratch/full-game-movement/harness/browser/full-game/index.html";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const browserName = argument("browser", "chrome");
const candidate = argument("candidate", "astar");
const scenario = argument("scenario", "dense-open-120");
const population = Number(argument("population", "1000"));
const ticksRaw = argument("ticks");
const warmupRuns = Number(argument("warmups", "0"));
const measuredRuns = Number(argument("samples", "1"));
if (!["chrome", "chromium"].includes(browserName)) throw new Error("browser must be chrome or chromium");
if (!["astar", "flow"].includes(candidate)) throw new Error("candidate must be astar or flow");
if (!Number.isInteger(population) || population < 1) throw new Error("invalid population");
const config = {
  candidate,
  scenario,
  population,
  warmupRuns,
  measuredRuns,
  ...(ticksRaw !== undefined ? { ticks: Number(ticksRaw) } : {}),
};
const name = argument("name", `${candidate}-${scenario}-p${population}${ticksRaw ? `-t${ticksRaw}` : ""}`);
if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("invalid result name");
if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ browserName, name, config, page: PAGE_PATH, results: RESULTS }, null, 2));
  process.exit(0);
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
const url = `http://127.0.0.1:${address.port}${PAGE_PATH}`;
let browser;
try {
  browser = await chromium.launch({
    ...(browserName === "chrome" ? { channel: "chrome" } : {}),
    ...(browserName === "chromium" && process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => typeof window.runFullGameBrowserBenchmark === "function", null, { timeout: 30_000 });
  console.log(`${browserName} ${browser.version()}: ${name}`);
  const result = await page.evaluate((runConfig) => window.runFullGameBrowserBenchmark(runConfig), config);
  if (errors.length) throw new Error(errors.join("\n"));
  await mkdir(RESULTS, { recursive: true });
  await writeFile(path.join(RESULTS, `${browserName}-${name}.json`), `${JSON.stringify({
    ...result,
    browser: browserName,
    browserVersion: browser.version(),
    capturedAt: new Date().toISOString(),
    host,
    automation: "playwright",
    headless: true,
    config,
  }, null, 2)}\n`);
  console.log(`completed tick=${result.samples.at(-1).finalTick} frames=${result.samples.at(-1).frames} requests=${result.samples.at(-1).pathRequests.length} repeat=${result.repeatLogicalResultsEqual}`);
} catch (error) {
  await mkdir(RESULTS, { recursive: true });
  await writeFile(path.join(RESULTS, `${browserName}-${name}-error.json`), `${JSON.stringify({
    browser: browserName,
    browserVersion: browser?.version(),
    capturedAt: new Date().toISOString(),
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

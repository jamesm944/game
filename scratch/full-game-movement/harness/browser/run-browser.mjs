#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { createServer } from "vite";

const BROWSER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BROWSER_DIR, "../../../..");
const RESULTS = path.join(BROWSER_DIR, "results");
const PAGE_PATH = "/scratch/full-game-movement/harness/browser/index.html";
const BROWSERS = ["chrome", "chromium", "firefox", "webkit", "safari"];
const CANDIDATES = ["astar", "flow"];
const SCENARIOS = ["dense-open-120", "mixed-destinations-120"];
const PATTERNS = ["concurrent-burst", "staggered-groups"];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function selections(value, allowed) {
  if (value === "both" || value === "all") return allowed;
  const values = value.split(",");
  for (const item of values) if (!allowed.includes(item)) throw new Error(`unknown selection ${item}; allowed: ${allowed.join(",")}`);
  return values;
}

const options = {
  browsers: selections(argument("browser", "chrome"), BROWSERS),
  candidates: selections(argument("candidate", "both"), CANDIDATES),
  scenarios: selections(argument("scenario", "dense-open-120"), SCENARIOS),
  patterns: selections(argument("pattern", "concurrent-burst"), PATTERNS),
  population: Number(argument("population", "1000")),
  warmupRuns: Number(argument("warmups", "1")),
  measuredRuns: Number(argument("samples", "3")),
};
if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ ...options, page: PAGE_PATH, results: RESULTS }, null, 2));
  process.exit(0);
}
if (!Number.isInteger(options.population) || options.population < 1) throw new Error("invalid population");

const host = {
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  node: process.version,
};

async function startServer() {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    cacheDir: path.join(BROWSER_DIR, ".vite"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}${PAGE_PATH}` };
}

function resultName(browser, config, suffix = "") {
  return `${browser}-${config.candidate}-${config.scenario}-${config.pattern}-p${config.population}${suffix}.json`;
}

async function save(name, value) {
  await mkdir(RESULTS, { recursive: true });
  await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function launchPlaywright(name) {
  if (name === "chrome") return chromium.launch({ channel: "chrome", headless: true });
  if (name === "chromium") return chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  if (name === "firefox") return firefox.launch({ headless: true });
  if (name === "webkit") return webkit.launch({ headless: true });
  throw new Error(`not a Playwright browser: ${name}`);
}

async function runPlaywright(name, url) {
  const browser = await launchPlaywright(name);
  const version = browser.version();
  return {
    version,
    async run(config) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForFunction(() => typeof window.runBrowserBenchmark === "function", null, { timeout: 30_000 });
        const result = await page.evaluate((runConfig) => window.runBrowserBenchmark(runConfig), config);
        if (errors.length) throw new Error(errors.join("\n"));
        return result;
      } finally {
        await page.close();
      }
    },
    async close() { await browser.close(); },
  };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function webdriver(port, route, method = "GET", body, timeout = 30_000) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  if (!response.ok) throw new Error(`WebDriver ${method} ${route}: ${response.status} ${text}`);
  return value;
}

async function runSafari(url) {
  const port = await freePort();
  const output = [];
  const driver = spawn("safaridriver", ["--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  driver.stdout.on("data", (chunk) => output.push(String(chunk)));
  driver.stderr.on("data", (chunk) => output.push(String(chunk)));
  let sessionId;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (driver.exitCode !== null) throw new Error(`safaridriver exited ${driver.exitCode}: ${output.join("")}`);
      try { await webdriver(port, "/status", "GET", undefined, 1000); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (!ready) throw new Error(`safaridriver did not become ready: ${output.join("")}`);
    const session = await webdriver(port, "/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    sessionId = session.value.sessionId;
    const capabilities = session.value.capabilities;
    const route = (suffix) => `/session/${sessionId}${suffix}`;
    await webdriver(port, route("/timeouts"), "POST", { script: 300_000, pageLoad: 60_000, implicit: 0 });
    await webdriver(port, route("/url"), "POST", { url });
    let loaded = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await webdriver(port, route("/execute/sync"), "POST", {
        script: "return typeof window.runBrowserBenchmark === 'function';",
        args: [],
      });
      if (result.value === true) { loaded = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!loaded) throw new Error("Safari did not load the benchmark module");
    return {
      version: capabilities.browserVersion ?? capabilities.version ?? "unknown",
      async run(config) {
        const result = await webdriver(port, route("/execute/async"), "POST", {
          script: "const done = arguments[arguments.length - 1]; window.runBrowserBenchmark(arguments[0]).then(done, (error) => { done({runnerError: String(error), stack: error?.stack}); });",
          args: [config],
        }, 310_000);
        if (result.value?.runnerError) throw new Error(result.value.runnerError);
        return result.value;
      },
      async close() {
        if (sessionId) await webdriver(port, route(""), "DELETE").catch(() => {});
        driver.kill("SIGTERM");
      },
    };
  } catch (error) {
    if (sessionId) await webdriver(port, `/session/${sessionId}`, "DELETE").catch(() => {});
    driver.kill("SIGTERM");
    throw new Error(`${error.message}; safaridriver output: ${output.join("")}`);
  }
}

const { server, url } = await startServer();
try {
  for (const browserName of options.browsers) {
    let launcher;
    try {
      launcher = browserName === "safari" ? await runSafari(url) : await runPlaywright(browserName, url);
      await save(`${browserName}-availability.json`, {
        browser: browserName,
        available: true,
        version: launcher.version,
        capturedAt: new Date().toISOString(),
        host,
        pageUrlPath: PAGE_PATH,
        automation: browserName === "safari" ? "safaridriver-webdriver" : "playwright",
        headless: browserName !== "safari",
      });
    } catch (error) {
      await save(`${browserName}-availability.json`, {
        browser: browserName,
        available: false,
        capturedAt: new Date().toISOString(),
        host,
        automation: browserName === "safari" ? "safaridriver-webdriver" : "playwright",
        error: String(error),
        stack: error?.stack,
      });
      console.error(`${browserName}: unavailable: ${error}`);
      continue;
    }
    try {
      for (const candidate of options.candidates) {
        for (const scenario of options.scenarios) {
          for (const pattern of options.patterns) {
            const config = { candidate, scenario, pattern, population: options.population, warmupRuns: options.warmupRuns, measuredRuns: options.measuredRuns };
            console.log(`${browserName}: ${candidate} ${scenario} ${pattern} p${options.population}`);
            try {
              const result = await launcher.run(config);
              await save(resultName(browserName, config), {
                ...result,
                browser: browserName,
                browserVersion: launcher.version,
                capturedAt: new Date().toISOString(),
                host,
                automation: browserName === "safari" ? "safaridriver-webdriver" : "playwright",
                headless: browserName !== "safari",
                config,
              });
            } catch (error) {
              await save(resultName(browserName, config, "-error"), {
                browser: browserName,
                browserVersion: launcher.version,
                capturedAt: new Date().toISOString(),
                host,
                config,
                error: String(error),
                stack: error?.stack,
              });
              console.error(`${browserName}: run failed: ${error}`);
            }
          }
        }
      }
    } finally {
      await launcher.close();
    }
  }
} finally {
  await server.close();
}

#!/usr/bin/env node
// Wayfinder #173 gate driver: corrected integrated Recast vs current A* (FIFO),
// rotated/interleaved same-session real-Chrome p1000/t3600 samples.
// A* arm: scratch/navigation-batch-only harness (policy "fifo"), Vite dev server (as #171).
// Recast arm: scratch/navigation-queue/recast-combined/integrated, Vite production build preview (as #171).
// Fresh page per sample; one 400-tick warmup run (fresh worker) then one measured run (fresh worker).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, preview } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "../../..");
const RESULTS = path.join(ROOT, "results");
const INTEGRATED = path.join(
  REPO_ROOT,
  "scratch/navigation-queue/recast-combined/integrated",
);
const ASTAR_PAGE = "/scratch/navigation-batch-only/index.html";
const RECAST_PAGE =
  "/scratch/navigation-queue/recast-combined/integrated/index.html";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const scenario = argument("scenario", "narrow-mutation-120");
const iterations = Number(argument("iterations", "4"));
const population = Number(argument("population", "1000"));
const ticks = Number(argument("ticks", "3600"));
const warmupTicks = Number(argument("warmup-ticks", "400"));
if (
  !["dense-open-120", "mixed-destinations-120", "narrow-mutation-120"].includes(
    scenario,
  )
)
  throw new Error(`unsupported scenario ${scenario}`);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 4)
  throw new Error("use --iterations 1..4");
const short = {
  "dense-open-120": "dense",
  "mixed-destinations-120": "mixed",
  "narrow-mutation-120": "narrow",
}[scenario];
// Balanced rotation: odd iterations A* first, even iterations Recast first.
const orders = Object.fromEntries(
  Array.from({ length: iterations }, (_, i) => [
    i + 1,
    i % 2 === 0 ? ["astar", "recast"] : ["recast", "astar"],
  ]),
);

await mkdir(RESULTS, { recursive: true });
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  for (const engine of orders[iteration]) {
    const output = path.join(
      RESULTS,
      `chrome-${engine}-${short}-iter${iteration}.json`,
    );
    try {
      await access(output);
      throw new Error(`refusing to overwrite ${output}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
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
  loadAverageAtStart: os.loadavg(),
};
const donor = path.join(
  REPO_ROOT,
  "scratch/donor-audit/browser/voidstrike/node_modules",
);
const wasmBytes = readFileSync(
  path.join(donor, "@recast-navigation/wasm/dist/recast-navigation.wasm.wasm"),
);
const provenance = {
  packages: Object.fromEntries(
    [
      "recast-navigation",
      "@recast-navigation/core",
      "@recast-navigation/generators",
      "@recast-navigation/wasm",
    ].map((entry) => {
      const json = JSON.parse(
        readFileSync(path.join(donor, entry, "package.json"), "utf8"),
      );
      return [entry, { version: json.version, license: json.license }];
    }),
  ),
  wasmFile: "@recast-navigation/wasm/dist/recast-navigation.wasm.wasm",
  wasmBytes: wasmBytes.byteLength,
  wasmSha256: createHash("sha256").update(wasmBytes).digest("hex"),
};

const astarServer = await createServer({
  root: REPO_ROOT,
  configFile: false,
  cacheDir: path.join(ROOT, ".vite-astar"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await astarServer.listen();
const recastServer = await preview({
  configFile: path.join(INTEGRATED, "vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0 },
});
const portOf = (server) => {
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Vite did not expose a TCP port");
  return address.port;
};
const astarUrl = `http://127.0.0.1:${portOf(astarServer)}${ASTAR_PAGE}`;
const recastUrl = `http://127.0.0.1:${portOf(recastServer)}${RECAST_PAGE}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  console.log(
    `Chrome ${browser.version()} gate-173 scenario=${scenario} iterations=${iterations}`,
  );

  async function runSample(engine, iteration) {
    const page = await browser.newPage();
    const errors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    // Best-effort in-worker JS-heap polling (performance.memory) while the run is live.
    // Workers are terminated by candidate.dispose() at run end, so post-run probing is impossible.
    const memoryPoll = { phase: "warmup", polls: [], workerGlobals: [] };
    let polling = true;
    page.on("worker", (worker) => {
      (async () => {
        try {
          const globals = await worker.evaluate(() =>
            Object.getOwnPropertyNames(globalThis).filter((key) =>
              /memory|wasm|module|recast/i.test(key),
            ),
          );
          memoryPoll.workerGlobals.push({ url: worker.url(), globals });
        } catch {
          /* worker may already be gone */
        }
        while (polling) {
          try {
            const mem = await worker.evaluate(() => {
              const m = performance.memory;
              return m
                ? {
                    hasMemory: true,
                    usedJSHeapSize: m.usedJSHeapSize,
                    totalJSHeapSize: m.totalJSHeapSize,
                    jsHeapSizeLimit: m.jsHeapSizeLimit,
                  }
                : { hasMemory: false };
            });
            memoryPoll.polls.push({
              at: new Date().toISOString(),
              phase: memoryPoll.phase,
              url: worker.url(),
              ...mem,
            });
          } catch (error) {
            memoryPoll.polls.push({
              at: new Date().toISOString(),
              phase: memoryPoll.phase,
              url: worker.url(),
              error: String(error).slice(0, 200),
            });
            break;
          }
          await sleep(2000);
        }
      })();
    });
    try {
      const isAstar = engine === "astar";
      await page.goto(isAstar ? astarUrl : recastUrl, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });
      await page.waitForFunction(
        (fn) => typeof window[fn] === "function",
        isAstar ? "runQueueBrowserBenchmark" : "runRecastBrowserBenchmark",
        { timeout: 30_000 },
      );
      console.log(`start ${engine} ${scenario} iteration ${iteration}`);
      let result;
      if (isAstar) {
        const config = {
          policy: "fifo",
          scenario,
          population,
          ticks,
          warmupTicks,
          warmupRuns: 1,
          measuredRuns: 1,
        };
        memoryPoll.phase = "warmup+measured"; // A* harness runs warmup then measured inside one evaluate.
        result = await page.evaluate(
          (runConfig) => window.runQueueBrowserBenchmark(runConfig),
          config,
        );
        result = { ...result, gateConfig: config };
      } else {
        memoryPoll.phase = "warmup";
        const warmup = await page.evaluate(
          (runConfig) => window.runRecastBrowserBenchmark(runConfig),
          {
            scenario,
            population,
            ticks: warmupTicks,
            warmupRuns: 0,
            measuredRuns: 1,
          },
        );
        const warmupSample = warmup.samples[0];
        memoryPoll.phase = "measured";
        const measured = await page.evaluate(
          (runConfig) => window.runRecastBrowserBenchmark(runConfig),
          { scenario, population, ticks, warmupRuns: 0, measuredRuns: 1 },
        );
        result = {
          ...measured,
          warmupRuns: 1,
          warmupTicks,
          warmups: [
            {
              finalTick: warmupSample.finalTick,
              frames: warmupSample.frames,
              wallClockMs: warmupSample.wallClockMs,
              pathRequests: warmupSample.pathRequests.length,
              finalFullStateHash: warmupSample.finalFullStateHash,
            },
          ],
          gateConfig: {
            scenario,
            population,
            ticks,
            warmupTicks,
            warmupRuns: 1,
            measuredRuns: 1,
            queuePolicy: "fifo-single-request-messages",
          },
        };
      }
      polling = false;
      if (errors.length) throw new Error(errors.join("\n"));
      const pageMemoryAfter = await page
        .evaluate(() => {
          const m = performance.memory;
          return m
            ? {
                usedJSHeapSize: m.usedJSHeapSize,
                totalJSHeapSize: m.totalJSHeapSize,
                jsHeapSizeLimit: m.jsHeapSizeLimit,
              }
            : null;
        })
        .catch(() => null);
      const measured = result.samples[0];
      const outputPath = path.join(
        RESULTS,
        `chrome-${engine}-${short}-iter${iteration}.json`,
      );
      await writeFile(
        outputPath,
        `${JSON.stringify(
          {
            ...result,
            gate: "wayfinder-173-recast-vs-astar",
            engine,
            artifactMode: isAstar
              ? "vite-development-server"
              : "vite-production-build-preview",
            browser: "chrome",
            browserVersion: browser.version(),
            capturedAt: new Date().toISOString(),
            host,
            automation: "playwright",
            headless: true,
            iteration,
            engineOrder: orders[iteration],
            consoleErrors,
            memoryProbe: {
              method:
                "performance.memory polled in each live worker every ~2s during the run (JS heap only; WASM linear memory is not included by Chrome performance.memory); pageMemoryAfter is main-thread JS heap after the measured run",
              polls: memoryPoll.polls,
              workerGlobals: memoryPoll.workerGlobals,
              pageMemoryAfter,
            },
            ...(isAstar ? {} : { provenance }),
          },
          null,
          2,
        )}\n`,
      );
      console.log(
        JSON.stringify({
          engine,
          iteration,
          scenario,
          wallClockMs: measured.wallClockMs,
          frames: measured.frames,
          blockedTicks: measured.scheduler.blockedTicks,
          requests: measured.pathRequests.length,
          completed: measured.crowdStates.completed,
          finalFullStateHash: measured.finalFullStateHash,
        }),
      );
    } finally {
      polling = false;
      await page.close();
    }
  }

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const engine of orders[iteration]) await runSample(engine, iteration);
  }
} finally {
  await browser?.close();
  await astarServer.close();
  await recastServer.close();
}

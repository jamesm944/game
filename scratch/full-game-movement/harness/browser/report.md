# Wayfinder #167 — real browser-worker evidence

## Verdict and evidence boundary

This directory contains a runnable **real module-Worker** benchmark for current A* and the existing flow-field engine. It uses the production `PathScheduler`, actual `Worker.postMessage` structured cloning, `performance.now()` wall timing, and deterministic due-tick application. These are browser-worker results, separate from all Node/mock evidence.

Executed coverage is **headless Chrome 156.0.8078.47** and **headless Chromium / Chrome for Testing 153.0.8010.12**, on Apple M1 arm64, 16 GiB RAM, macOS Darwin 23.6.0. For each browser, both candidates ran dense and mixed 120 × 120 loads, concurrent and staggered patterns, population 1,000, one warmup plus three measured samples. Each reported configuration pools 3,000 measured requests; per-sample values remain in raw JSON.

This is **direct real-worker load evidence, not full-game browser evidence**. It does not execute `World.step`, production group formation/Activity application, steering, collision, or the full-game repath mix. The existing full-game runner is synchronous around `step(world)` (`harness/runner.ts:99-103,242-249`), so this slice uses an asynchronous direct scheduler driver instead of pretending that a busy loop can receive worker messages.

Under the direct 1,000-request loads, **15 of 16 configurations had pooled issue→response p95 above 33.3 ms**. The exception was Chromium flow/mixed/staggered at 25.5 ms. Every direct route-consumer apply p95 was below 2 ms, but that lightweight callback is not the production group/Activity callback and cannot settle the apply side of ADR-0003's phase-2 trigger.

## Implementation

- A* uses the production `createPathWorkerFactory()` and its module `new Worker(new URL("../sim/path.worker.ts", import.meta.url), {type:"module"})` (`src/game/paths.ts:10-29`; `src/sim/path.worker.ts:11-30`). No replacement A* implementation is used.
- Flow uses `browser/flow.worker.ts`, an isolated module Worker around the existing `FlowFieldRouteEngine`. It returns the same raw tile-route protocol as the completed Node flow integration. Flow is real browser-worker evidence, but its worker shell is harness-owned rather than production.
- Both workers sit below the unchanged production scheduler. The scheduler copies each passability snapshot, assigns `dueTick = issueTick + 2`, buffers out-of-order responses, applies in ascending ID order, and holds a due tick when a response is missing (`src/sim/path/protocol.ts:16-50`; `src/sim/path/scheduler.ts:155-231`).
- `browser/browser-main.ts:38-82` constructs the real-worker adapters. `browser/browser-main.ts:93-182` issues loads, pumps once per `requestAnimationFrame`, retains applied routes, records queue/frame data, terminates each worker, and hashes logical results.
- Existing scheduler decoration records issue/response wall time, apply tick/cost, snapshot bytes, and outcomes (`harness/instrumentation.ts:71-154`). The browser adapter calls the response observer from the actual worker message handler; worker-internal compute time is not estimated.
- `browser/load-model.ts` provides deterministic population allocation, exact-goal member requests, staggered issue ticks, nearest-rank statistics, and canonical logical results. `browser/run-browser.mjs` starts an ephemeral Vite server, automates installed browsers, writes metadata/raw JSON, and closes the browser and server.

### Load definitions

Every request carries a 120 × 120 `Uint8Array` snapshot. This direct stress load creates one search per generated member; it is not the production initial order's one-search-per-group-leader behavior (ADR-0003 lines 9-12).

- **Dense / burst:** 1,000 distinct starts, one shared destination, all issued at tick 1, due at tick 3.
- **Mixed / burst:** 1,000 starts allocated equally across eight groups and eight destinations, all issued at tick 1, due at tick 3.
- **Mixed / staggered:** the eight 125-member groups issue at ticks 1 through 8, with due ticks 3 through 10.
- **Dense / staggered:** dense has only one group, so this is intentionally the same issue pattern as dense/burst, not an independent staggered workload.

The direct apply callback copies and retains each applied route and records its logical application. Its measured cost includes that consumer work, not production formation-slot or ActivityQueue writes.

### Metric definitions

- **Issue→response wall ms:** from immediately before transport `postMessage` to the actual worker message callback. It includes worker queueing, structured clone/delivery, path computation, and response delivery. The scheduler's snapshot `.slice()` occurs before transport send and is not isolated in this interval.
- **Apply wall ms:** time inside the direct applied-route consumer at the scheduler callback. It excludes search and is measured separately from whole-frame/world time.
- **Issue→apply ticks:** simulated target-boundary difference, not milliseconds. Late responses hold the same target tick, so logical application remains at the due tick while frames and blocked-tick counts increase.
- **Queue:** scheduler outstanding count sampled once per frame. **Blocked ticks** are the production scheduler's count of due-but-missing pump attempts; in this driver each is also a held frame.
- **Payload:** 14,400 snapshot bytes per request, actually structured-cloned by `postMessage` without a transfer list. Response bytes are the applied `Int16Array` waypoint payload. No isolated structured-clone CPU timing is claimed.
- **Logical route hash:** SHA-256 over applied request ID, issue/due/apply ticks, `ok`, cost, and waypoints in application order. Timing, response arrival order, and frame counts are excluded. This is not a full-game world-state hash.

## Measured results

Response columns are pooled p50 / p95 / max **wall milliseconds**. Apply is pooled p95 / max **wall milliseconds**. Blocked is the range across three samples. Queue is mean across frame samples / maximum. Wall range is total direct run duration across three samples, not simulated time.

| Browser | Candidate | Load | Response p50 / p95 / max ms | Apply p95 / max ms | Blocked | Queue mean / max | Run wall ms | Evidence |
|---|---|---|---:|---:|---:|---:|---:|---|
| Chrome | A* | dense / burst | 116.9 / **197.2** / 216.4 | 0.0 / 0.2 | 10–13 | 571.6 / 1,000 | 197.4–238.5 | [raw](results/chrome-astar-dense-open-120-concurrent-burst-p1000.json) |
| Chrome | A* | dense / staggered | 106.1 / **186.6** / 202.3 | 0.0 / 0.1 | 10–11 | 536.7 / 1,000 | 197.3–214.4 | [raw](results/chrome-astar-dense-open-120-staggered-groups-p1000.json) |
| Chrome | A* | mixed / burst | 94.1 / **156.6** / 161.5 | 0.0 / 0.1 | 8–9 | 570.1 / 1,000 | 164.1–181.1 | [raw](results/chrome-astar-mixed-destinations-120-concurrent-burst-p1000.json) |
| Chrome | A* | mixed / staggered | 26.9 / **46.8** / 53.5 | 0.0 / 0.1 | 2–3 | 220.3 / 368 | 177.2–194.4 | [raw](results/chrome-astar-mixed-destinations-120-staggered-groups-p1000.json) |
| Chrome | Flow | dense / burst | 32.6 / **43.6** / 44.6 | 0.0 / 0.1 | 2 | 646.9 / 1,000 | 58.6–61.1 | [raw](results/chrome-flow-dense-open-120-concurrent-burst-p1000.json) |
| Chrome | Flow | dense / staggered | 32.4 / **37.5** / 38.9 | 0.0 / 0.2 | 0–2 | 678.0 / 1,000 | 46.9–58.4 | [raw](results/chrome-flow-dense-open-120-staggered-groups-p1000.json) |
| Chrome | Flow | mixed / burst | 57.3 / **81.1** / 85.8 | 0.0 / 0.1 | 4–5 | 650.2 / 1,000 | 93.0–108.7 | [raw](results/chrome-flow-mixed-destinations-120-concurrent-burst-p1000.json) |
| Chrome | Flow | mixed / staggered | 7.8 / **33.4** / 35.4 | 0.0 / 0.1 | 0–1 | 210.6 / 375 | 144.2–157.3 | [raw](results/chrome-flow-mixed-destinations-120-staggered-groups-p1000.json) |
| Chromium | A* | dense / burst | 133.9 / **246.7** / 259.0 | 0.0 / 0.1 | 11–15 | 564.1 / 1,000 | 215.1–281.2 | [raw](results/chromium-astar-dense-open-120-concurrent-burst-p1000.json) |
| Chromium | A* | dense / staggered | 118.4 / **198.3** / 218.1 | 0.0 / 0.1 | 11–12 | 554.7 / 1,000 | 214.5–228.2 | [raw](results/chromium-astar-dense-open-120-staggered-groups-p1000.json) |
| Chromium | A* | mixed / burst | 90.6 / **143.1** / 154.0 | 0.0 / 0.1 | 8–9 | 567.2 / 1,000 | 163.6–180.1 | [raw](results/chromium-astar-mixed-destinations-120-concurrent-burst-p1000.json) |
| Chromium | A* | mixed / staggered | 15.8 / **94.2** / 103.7 | 0.0 / 0.1 | 1–5 | 227.7 / 375 | 164.6–230.5 | [raw](results/chromium-astar-mixed-destinations-120-staggered-groups-p1000.json) |
| Chromium | Flow | dense / burst | 33.6 / **37.2** / 41.2 | 0.0 / 0.2 | 2 | 612.1 / 1,000 | 58.0–59.2 | [raw](results/chromium-flow-dense-open-120-concurrent-burst-p1000.json) |
| Chromium | Flow | dense / staggered | 34.4 / **38.3** / 41.9 | 0.0 / 0.1 | 1–2 | 692.7 / 1,000 | 45.3–60.1 | [raw](results/chromium-flow-dense-open-120-staggered-groups-p1000.json) |
| Chromium | Flow | mixed / burst | 45.0 / **65.7** / 67.8 | 0.0 / 0.1 | 3–4 | 616.9 / 1,000 | 77.9–92.9 | [raw](results/chromium-flow-mixed-destinations-120-concurrent-burst-p1000.json) |
| Chromium | Flow | mixed / staggered | 6.4 / **25.5** / 28.0 | 0.0 / 0.1 | 0–1 | 208.2 / 352 | 141.6–158.5 | [raw](results/chromium-flow-mixed-destinations-120-staggered-groups-p1000.json) |

All response values except Chromium flow/mixed/staggered exceed 33.3 ms at p95. Chrome flow/mixed/staggered is only marginally above at 33.4 ms; three samples are not enough to treat that boundary difference as stable. Browser versions were run sequentially, not interleaved, so this table does not rank browser performance.

The apply p95 displays as 0.0 ms because Chrome-family `performance.now()` was quantized to 0.1 ms and the direct consumer is very small. It does not mean literally zero work. Observed apply maxima were 0.1–0.2 ms.

### Payload and target-tick results

| Candidate / load | Snapshot bytes per request | Snapshot bytes per 1,000-request sample | Response waypoint bytes per sample |
|---|---:|---:|---:|
| A*, dense or mixed | 14,400 | 14,400,000 | 8,000 |
| Flow, dense | 14,400 | 14,400,000 | 228,900 |
| Flow, mixed | 14,400 | 14,400,000 | 263,380 |

Every applied request in every measured sample had issue→apply = **2 ticks**. Concurrent runs finished at target tick 3; mixed staggered runs finished at tick 10. Application order was exactly ascending IDs 1 through 1,000 and every final queue depth was zero. Blocked frames varied with real response timing without changing logical target ticks.

All three measured repeats in all 16 configurations had equal logical route hashes. In addition, the eight matched Chrome/Chromium configuration pairs were actually executed and had equal hashes. That is an observation for two Chromium-family browsers on this one host, not general cross-browser determinism evidence. A* and flow hashes differ where their route geometry differs; cross-architecture hash equality is neither required nor claimed.

## ADR-0003 phase-2 interpretation

ADR-0003 triggers phase 2 when **concurrent leader searches** push path-worker turnaround past one tick budget or **production path application** exceeds roughly 2 ms/tick (`docs/adr/0003-unit-movement-and-pathfinding.md:9-12,42,78`).

- **Response side:** the real-browser direct loads repeatedly breach 33.3 ms at p95, with nonzero blocked frames. This is direct evidence that real worker queueing/turnaround can exceed the budget under heavy concurrent 120 × 120 searches; Node/mock latency must not be substituted for it.
- **Apply side:** the measured direct consumer is below 2 ms at p95, but production formation/member and Activity application was not run in a browser. No production apply-side pass/fail conclusion is made.
- **Decision boundary:** these workloads issue per-member stress searches, not solely production concurrent leader searches. Therefore they do not by themselves prove that the ADR's production phase-2 trigger has fired. A full-game asynchronous browser driver must replay the actual leader/repath mix and instrument the production group callback before making that decision.
- **Candidate comparison:** dense flow benefits from a genuinely shared destination field, while current A* keys its cache by start as well as goal (`src/sim/path/engine.ts:61-107`). Mixed staggered results also show strong batching/cache effects. These direct-load measurements do not erase the completed full-game Node comparison or establish a universal flow-field winner.

## Browser coverage and exact limitations

| Target | Result |
|---|---|
| Chrome arm64 | Executed: 156.0.8078.47, Playwright, headless. |
| Chromium arm64 | Executed: cached Chrome for Testing 153.0.8010.12, Playwright, headless, explicit existing executable. |
| Firefox arm64 | Not executed: no Firefox application or Playwright Firefox binary; launch attempted and missing `firefox-1482` executable recorded. |
| Playwright WebKit arm64 | Not executed: launch attempted and missing `webkit-2158/pw_run.sh` recorded. |
| Safari arm64 | Installed, but not executed: `safaridriver` refused session creation because “Allow remote automation” is disabled in Safari Developer settings. Browser version remains unmeasured. |
| Any x64 browser | Unmeasured; no x64 host/emulation evidence was produced. |

Availability/error records: [Chrome](results/chrome-availability.json), [Chromium](results/chromium-availability.json), [Firefox](results/firefox-availability.json), [WebKit](results/webkit-availability.json), [Safari](results/safari-availability.json). No browser binaries or packages were downloaded or installed.

Additional limitations:

1. Three measured samples per configuration are enough for this initial evidence path, not stable distributions or small threshold-margin decisions. Warmups and every measured sample use a fresh worker; worker caches do not carry between samples.
2. Dense/staggered duplicates dense/burst by construction. Mixed staggered is the meaningful staggered pattern.
3. Only direct dense and mixed loads at population 1,000 were measured. Full-game completion, stalls, mutations, Activity queues, production world hashes, and 2,000-unit browser loads remain unmeasured.
4. Snapshot-copy CPU, isolated structured-clone CPU, worker-internal compute, rendering, background-tab throttling, and browser-process scheduling are not separately attributed. Issue→response is the required end-to-end wall interval.
5. Chrome and Chromium are the same engine family at different versions. Their equal logical hashes do not cover Firefox, WebKit/Safari, x64, or independent builds.

## Tests and exact commands

Local artifact validation passed: **1 test file, 7/7 tests**, plus strict TypeScript. Tests cover deterministic load generation, exact goals, staggered allocation, passability, nearest-rank statistics, wall/tick separation, thresholds, logical hashing, scheduler due-tick/ascending application, and runner artifact wiring. The local scheduler smoke is not counted as browser evidence.

Run from the repository root:

```sh
npx tsc -p scratch/full-game-movement/harness/tsconfig.json
npx vitest run scratch/full-game-movement/harness/browser/browser.test.ts

node scratch/full-game-movement/harness/browser/run-browser.mjs --browser chrome --candidate both --scenario dense-open-120,mixed-destinations-120 --pattern concurrent-burst,staggered-groups --population 1000 --warmups 1 --samples 3

CHROMIUM_EXECUTABLE_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  node scratch/full-game-movement/harness/browser/run-browser.mjs --browser chromium --candidate both --scenario dense-open-120,mixed-destinations-120 --pattern concurrent-burst,staggered-groups --population 1000 --warmups 1 --samples 3

node scratch/full-game-movement/harness/browser/run-browser.mjs --browser firefox,webkit --candidate both --scenario dense-open-120,mixed-destinations-120 --pattern concurrent-burst,staggered-groups --population 1000 --warmups 1 --samples 3

node scratch/full-game-movement/harness/browser/run-browser.mjs --browser safari --candidate both --scenario dense-open-120,mixed-destinations-120 --pattern concurrent-burst,staggered-groups --population 1000 --warmups 1 --samples 3

python scratch/full-game-movement/harness/browser/summarize.py
```

`run-browser.mjs --list` prints selections without launching. `--browser`, `--candidate`, `--scenario`, and `--pattern` accept comma-separated selections; `both`/`all` select every supported value. Results are written only under `harness/browser/results/`; existing Node raw results are never read or overwritten.

Derived index: [summary](results/summary.json). The table above links every measured raw file, including per-request timing, frame/queue samples, hashes, browser version, and host metadata.

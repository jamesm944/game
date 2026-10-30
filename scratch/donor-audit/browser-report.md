# Wayfinder ticket #161 — browser RTS donor audit

## Scope and method

This audit covers only the two requested upstream repositories. Each was cloned separately with `git clone --depth 1`, installed and tested in place, and inspected as source. No Wayfinder production file was edited, no donor module was integrated, and no retail/proprietary game assets were sought or supplied.

Local clones:

- `scratch/donor-audit/browser/voidstrike/`
- `scratch/donor-audit/browser/generals-rts-threejs-port/`

All paths below are repository-relative. “Verified” means observed in the checked-out source or in a command run during this audit. README statements are treated as claims, not proof. Licence is recorded as provenance metadata, not used as a selection filter.

## Executive result

| Repository | Exact audited HEAD | Default branch | Build / typecheck | Tests |
| --- | --- | --- | --- | --- |
| `braedonsaunders/voidstrike` | `4df0235116b78bf9232105486738e64b2e6905cb` | `main` | `npm run type-check`: **FAIL**; `npm run build`: **FAIL** after successful compilation, during TypeScript | Full `npm test`: **2 failures / 2,517 passes**; isolated retry reproduced the two 5 s timeouts; diagnostic 20 s timeout run: **4 / 4 passes** |
| `sentifold/generals-rts-threejs-port` | `816b259c962c13d7d3c6e0cb2def1c682e410bdb` | `main` | `npm run typecheck`: **PASS**; `npm run build`: **PASS** | Stock `npm test`: **1 failed test plus 1 failed suite setup / 3,559 passes / 119 skips**; with the two improperly ungated retail-only files excluded: **3,559 passes / 96 skips, no failures**; focused reusable set: **335 / 335 passes** |

Highest-value reusable material:

1. **Generals determinism and persistence tests** — `web/src/sim/replayDeterminism.test.ts`, `gate4Determinism.test.ts`, `stateHashHarness.ts`, and the 135-test `simSnapshot.test.ts`. These verify actual frame hashes, RNG checkpoints, replay round-trips, and capture/restore/recapture behavior rather than merely testing configuration.
2. **Generals sim/render bridge** — `web/src/browser/simRenderBridge.ts` plus its 19 tests. The visual-factory seam, transform conversion, lifecycle/disposal, reset/ObjectID reuse, and restored-world binding are particularly reusable design/test ideas.
3. **Voidstrike worker protocol and render adapter** — `src/engine/workers/{WorkerBridge,GameWorker,types,RenderStateAdapter}.ts`. This is a concrete authoritative-worker/message-protocol design, but its current checkout does not typecheck/build and the worker test itself is thin.
4. **Both navigation suites** — Voidstrike has real Recast WASM elevated-obstacle and multi-map connectivity tests; Generals has small, fast integer-grid pathfinding tests with explicit parity/gap documentation. Voidstrike’s ramp suite currently exceeds its default 5 s test budget.
5. **Generals command replay and snapshot modules** — useful as reference implementations and test seams, subject to their documented non-retail command ordinals and incomplete retail CRC coverage.

## 1. Provenance and toolchain

### Voidstrike

- Upstream: `https://github.com/braedonsaunders/voidstrike.git`
- Clone command: `git clone --depth 1 https://github.com/braedonsaunders/voidstrike.git voidstrike`
- HEAD: `4df0235116b78bf9232105486738e64b2e6905cb`
- `git branch --show-current`: `main`
- `git remote show origin`: `HEAD branch: main`
- Commit subject: `chore: update codeflow card [skip ci]`
- Licence metadata: `LICENSE` is MIT, copyright 2024–2025 VOIDSTRIKE Contributors.
- Package/toolchain: `package.json`, `package-lock.json`; Next.js 16.1.2, React 19.2.3, TypeScript 5.9.3 installed from the lockfile, Three.js 0.182.0, Phaser 4.0.0-rc.6, Recast Navigation 0.43.0, Vitest 4.0.18.
- Notable version skew: runtime `three` is 0.182.0 while direct `@types/three` is 0.172.0. TypeScript errors also referenced a second Three type installation under the parent Wayfinder workspace; Next warned that it inferred `/Users/jamesmoss` as workspace root because multiple lockfiles were visible. These are relevant to interpreting, not hiding, the observed failures.
- Entry points: `src/app/page.tsx` (home), `src/app/game/setup/page.tsx` (setup), `src/app/game/page.tsx` (client-only game), `src/components/game/WebGPUGameCanvas.tsx`, and `src/components/game/hooks/useWorkerBridge.ts`. Editor route: `src/app/game/setup/editor/page.tsx`.
- Test discovery: `vitest.config.ts` uses Node environment and `tests/**/*.test.ts`.

### Generals port

- Upstream: `https://github.com/sentifold/generals-rts-threejs-port.git`
- Clone command: `git clone --depth 1 https://github.com/sentifold/generals-rts-threejs-port.git generals-rts-threejs-port`
- HEAD: `816b259c962c13d7d3c6e0cb2def1c682e410bdb`
- `git branch --show-current`: `main`
- `git remote show origin`: `HEAD branch: main`
- Commit subject: `docs: trim the duplicated renderer sections (#2)`
- Licence metadata: `LICENSE.md` is GPL-3.0 with EA’s additional Section 7 terms (trademark/publicity, notice, origin, and related provisions). `README.md` explicitly says retail game content is not included or covered by the source licence. No assets were obtained.
- Application root is `web/`, not repository root.
- Package/toolchain: `web/package.json`, `web/package-lock.json`; Vite 8.1.4, TypeScript 7.0.2, Three.js 0.185.1 with matching types, Vitest 4.1.10, Playwright 1.61.1.
- Browser entry: `web/index.html` loads `/src/index.ts`; `web/src/index.ts` creates the renderer, scene, session, UI, fixed-step loop, and presentation wiring. Vite config: `web/vite.config.ts`.
- Test scripts: `npm test` is `vitest run --exclude=e2e/**`; `npm run test:retail` requires `CNC_GAME_DIR`; `npm run test:e2e` uses `web/playwright.config.ts`.

Host tool versions for both installs: Node `v24.21.0`, npm `11.12.1`.

## 2. Commands and observed verification

### Voidstrike commands

Run from `scratch/donor-audit/browser/voidstrike/` unless noted.

| Command | Result |
| --- | --- |
| `npm ci` | **PASS** — 485 packages added. npm reported 24 dependency vulnerabilities (1 low, 7 moderate, 13 high, 3 critical); no `audit fix` was run. |
| `npm run type-check` | **FAIL** — errors in `src/rendering/tsl/effects/EffectPasses.ts` (unused `@ts-expect-error`, `Camera`/`PerspectiveCamera`, missing `getTextureNode`, and cross-installation `Camera` incompatibility) and four test files’ config/API mismatches. |
| `npm run build` | **FAIL** — music manifest prebuild ran and Turbopack compiled successfully in 7.4 s, then Next’s TypeScript phase failed first on `EffectPasses.ts:51`. |
| `npm test` | **FAIL** — 85 passed files, 1 failed file (86); 2,517 passed tests, 2 failed (2,519). Both failures are 5 s timeouts in `tests/engine/pathfinding/recastRampConnectivity.test.ts`. |
| `npx vitest run tests/engine/pathfinding/recastRampConnectivity.test.ts` | **FAIL, reproduced** — same two timeouts; other two tests pass. |
| `npx vitest run tests/engine/pathfinding/recastRampConnectivity.test.ts --testTimeout=20000` | **PASS diagnostically** — all 4 tests pass in 15.96 s of test time. This shows the observed default-suite failures are timeout-budget failures, not demonstrated connectivity assertion failures; it does not make the stock suite green. |
| `npm run lint` | **PASS with warnings** — exit 0, 0 errors and 381 warnings. |

The build’s prebuild step rewrote `src/data/music-manifest.json` inside the disposable donor clone; it was restored to audited HEAD afterward. Final donor `git status --short` was clean (ignored `node_modules`/build output excepted).

### Generals commands

Run from `scratch/donor-audit/browser/generals-rts-threejs-port/web/`.

| Command | Result |
| --- | --- |
| `npm ci` | **PASS** — 62 packages added. npm reported 6 dependency vulnerabilities (3 moderate, 3 high); no `audit fix` was run. |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, no diagnostics. |
| `npm run build` | **PASS** — typecheck plus Vite production build; 259 modules transformed. Main JS was 1,438.17 kB (398.69 kB gzip) and Three WebGPU chunk 855.32 kB (234.62 kB gzip), with chunk-size warnings only. |
| `npm test` | **FAIL** — 297 passed, 2 failed, 12 skipped files (311); 3,559 passed, 1 failed, 119 skipped tests (3,679). `vite-plugins/gameAssetServer.test.ts` fails in `beforeAll`, and `test/retailAIScriptSourceMounted.test.ts` has the failed test. Both read a hard-coded Windows retail `SkirmishScripts.scb` path without using the normal retail skip gate. |
| `npx vitest run --exclude=e2e/** --exclude=vite-plugins/gameAssetServer.test.ts --exclude=test/retailAIScriptSourceMounted.test.ts` | **PASS** — 297 passed and 12 skipped files (309); 3,559 passed and 96 skipped tests (3,655), no failures. This verifies the remaining asset-free suite, not the two excluded files. |
| `npx vitest run src/sim/replayDeterminism.test.ts src/sim/gate4Determinism.test.ts src/sim/simSnapshot.test.ts src/browser/simRenderBridge.test.ts src/sim/pathfinder.test.ts src/sim/pathfindGrid.test.ts src/sim/skirmishAI.test.ts src/browser/audioDirector.test.ts` | **PASS** — 8 files, 335 / 335 tests. |

The clean-clone asset-free claim in `README.md:78,84–86` is therefore **not fully verified at this HEAD**: 3,559 tests do pass without assets, but the stock command is not clean because two retail-only files escaped the skip policy.

### Deliberate skips

- `npm run test:retail`: skipped; requires a local retail installation via `CNC_GAME_DIR`.
- `npm run test:e2e`, visual baselines, and Gate 109/110 browser evidence runs: skipped; Playwright comments describe full retail asset downloads (about 2.1 GB), and runtime requires WebGPU.
- No live browser smoke test was performed for either project. Generals’ production bundle builds, but meaningful startup needs WebGPU and game content; Voidstrike’s production build fails before a browser run.

## 3. Voidstrike source audit — commit `4df0235116b78bf9232105486738e64b2e6905cb`

### Worker runtime and fixed-step simulation — verified in source

- `src/engine/workers/WorkerBridge.ts:133–190` creates `new Worker(new URL('./GameWorker.ts', import.meta.url), { type: 'module' })`, waits for initialization, and forwards commands/control messages.
- `src/engine/workers/GameWorker.ts:112–128` explicitly hosts the authoritative game in the worker with its own interval/accumulator. `src/components/game/hooks/useWorkerBridge.ts:218–230` configures 20 TPS.
- Additional real worker entry points exist for pathfinding, vision, AI micro decisions, GLTF loading, Phaser loop timing, and countdowns: `src/workers/` plus their managers.
- `src/engine/core/GameLoop.ts` separately implements an inline Blob-worker timer and fixed-step accumulator with catch-up iteration/time budgets. Do not conflate this with `WorkerGame`’s own worker loop.
- Only two `tests/engine/workers/gameWorker.test.ts` tests exist; they cover placement-helper presence and starting resources, not end-to-end worker messaging or deterministic multi-worker execution.

### Sim/render bridge — verified in source

- `GameWorker.sendRenderState()` (`GameWorker.ts:949–999`) collects units, buildings, resources, projectiles, vision grids, resources, selection, tick/time, and interpolation, then posts a serialized snapshot.
- `WorkerBridge.ts:204–249` deserializes snapshots and updates `RenderStateWorldAdapter`; `RenderStateAdapter.ts` supplies World-like entity wrappers and reuses adapter instances. Previous/current transforms are included for presentation.
- Navmesh typed-array buffers are transferred in `WorkerBridge.setNavMesh()` / `setWaterNavMesh()` (`WorkerBridge.ts:438–450`). Ordinary render state is message-copy based; no SharedArrayBuffer render-state channel was found.

### Navigation — verified, with current test-budget issue

- `src/engine/systems/PathfindingSystem.ts:233–320` initializes Recast WASM in a dedicated worker and sends geometry/heightfield data.
- `PathfindingSystem.ts:962–1000` uses the worker only for ground paths and falls back to synchronous domain-aware main-thread queries otherwise; comments explicitly limit worker support to ground.
- `src/editor/services/EditorNavigation.ts` shares walkable-geometry generation/config and uses TileCache dynamic obstacles with solo-navmesh fallback.
- Strong tests: `tests/engine/pathfinding/recastDynamicObstacleElevation.test.ts` passes and proves rerouting around an elevated building; `recastRampConnectivity.test.ts` covers editor ramps, bundled map exits, spawn-to-spawn connectivity, and elevated local routes. Its default 5 s budget currently fails on two tests, while all assertions pass with a 20 s diagnostic budget.

### AI — verified in source and broad unit coverage

- `src/engine/ai/AIWorkerManager.ts` implements asynchronous micro-decision requests, caching, timeouts, snapshots, and a tick-derived seed (`12345 + currentTick`).
- `src/workers/ai-decisions.worker.ts`, `src/engine/systems/ai/`, `EnhancedAISystem`, `AIEconomySystem`, `AIMicroSystem`, behavior trees, influence maps, and build-order execution are real implementations.
- The full suite passed the AI behavior/economy/micro/build-order/completion tests. This verifies those tested units, not whole-game strategic quality or worker/main-thread determinism.

### Editor — verified in source

- The editor is a substantial React/Three tool under `src/editor/`, with 2D/3D canvases, terrain tools, map serialization/export, and navigation validation.
- `src/editor/utils/mapExport.ts` exports JSON/clipboard/download; `EditorNavigation.ts` provides Recast validation.
- No comparable dedicated end-to-end editor suite was identified in the configured `tests/**/*.test.ts` inventory; navigation tests exercise some editor-style behavior.

### Audio — verified in source; runtime audio not browser-verified

- `src/audio/AudioManager.ts` uses Web Audio through Three audio objects, JSON-driven sound/voice config, a 96-source positional pool, 64-sound global budget, priorities, cooldowns, clustering, and resume handling.
- `src/engine/systems/AudioSystem.ts` consumes game events on the presentation side and uses seeded voice selection. `GameWorker` excludes Audio and forwards events to the main thread.
- `tests/data/audioConfig.test.ts` passed (16 tests), but no actual browser output/device test was run.

### Save/replay — significant limitations verified

- `src/engine/systems/SaveLoadSystem.ts` is registered, but save/load returns false where `localStorage` is unavailable, including the authoritative worker context (`:92–129`).
- Serialization writes zeroed player resources/upgrades/control groups and empty fog (`:327–364`). Restoration explicitly says it is simplified and restores only Transform, Health, and Selectable, not Unit/Building/Ability state (`:367–437`).
- No general save/load test or usable replay recorder/playback implementation was found. “Replay” references in pathfinding and desync code are obstacle reapplication/debug command history, not a game replay system.
- Therefore save/replay should **not** be treated as a reusable completed subsystem at this commit.

### Determinism and networking — useful parts, not whole-game proof

- `src/utils/DeterministicMath.ts`, seeded RNG use, deterministic command ordering, lockstep queueing, `ChecksumSystem`, Merkle divergence, and desync utilities are present.
- `ChecksumSystem.ts:589–804` sorts entities by ID, quantizes relevant values, and hashes units/buildings/resources/projectiles plus tick. Merkle and lockstep tests passed.
- Valuable tests include `tests/engine/network/{lockstep,commandSync,merkleTree,desyncDetection,adaptiveDelay}.test.ts`, `tests/utils/{math,deterministicMath}.test.ts`, and `tests/engine/core/gameLoop.test.ts`.
- These do not amount to an end-to-end two-instance deterministic simulation proof. Save incompleteness and asynchronous worker boundaries need separate scrutiny before relying on the README’s broad determinism claim.

## 4. Generals source audit — commit `816b259c962c13d7d3c6e0cb2def1c682e410bdb`

### Runtime and fixed-step loop — verified main-thread, not worker-based

- No actual `new Worker`, worker `postMessage`, or worker entry point was found under `web/src`; “worker” matches are supply-unit logic.
- `web/src/index.ts:487–498` runs from `renderer.setAnimationLoop`, advances the sim accumulator, then updates presentation.
- `web/src/sim/fixedStep.ts` clamps each render delta to one step and advances at most one logic frame per render call (no catch-up burst). `web/src/sim/time.ts` fixes the step at `1 / 30` second.
- `web/src/sim/frameLoop.ts` implements deterministic update phases and registration-order scheduling, snapshot-restorable frame/wake state, and deferred reaping.
- This is a useful small fixed-step design, but it does not supply Voidstrike-style background worker isolation.

### Sim/render bridge — high-value, verified by tests

- `web/src/browser/simRenderBridge.ts` provides `VisualFactory`, `BoundVisual`, binding/reconciliation, transform synchronization, animation update, disposal, bone access, initial-map and restored-world constructors.
- Coordinate conversion is explicit: sim `(x,y,z)` becomes Three `(x,z,y)` with yaw negated (`:169–179`). Interpolation remains a documented backlog item (`:174`).
- The 19 tests verify initial/later binding, transform conversion, full-basis overrides, destruction/disposal, suppressed objects, reset/ObjectID reuse, restored worlds, real locomotor movement, damage visuals, and map-spawn parity. All passed.

### Navigation — compact and tested, with explicit gaps

- `web/src/sim/pathfindGrid.ts` builds a 10-world-unit cell grid from map heights/boundaries and marks cliffs/pinched cells. It explicitly documents deferred water classification.
- `web/src/sim/pathfinder.ts` is synchronous integer-cost A* with fixed neighbor order, turn/pinched penalties, FIFO equal-cost insertion, and first-reach-wins/no relaxation.
- Documented parity gaps include zones/hierarchical pre-search, layers, crowds/occupancy, obstacles/tunnelling, and 16-bit cost wrap. It is a reference slice, not a drop-in complete RTS navigation solution.
- `pathfinder.test.ts` (18) and `pathfindGrid.test.ts` (4) passed.

### AI — verified deterministic slices and retail-script machinery

- `web/src/sim/skirmishAI.ts` implements deterministic production, structure, attack-wave, and opt-in economy behavior with injectable RNG/dependencies. It also documents omitted MVP features.
- `web/src/sim/aiTeamScriptRuntime.ts`, `aiTeamLifecycle.ts`, `aiTeamBuildQueue.ts`, and team modules implement retail-script/team state and snapshot support.
- `skirmishAI.test.ts` passed all 40 tests, including a 9,000-frame worker supply-delivery scenario whose balance increased from 10,000 to 23,950. This is one of the most useful behavior-level tests in either donor.

### Editor — not present

- No editor implementation or editor entry point was found under `web/src`. This repository should not be counted as an editor donor.

### Audio — real Web Audio with explicit presentation simplification

- `web/src/browser/audioEngine.ts` resolves VFS samples, caches decode promises, manages handles/looping/gain/resume/disposal, and uses a separate audio RNG.
- Positional attenuation/listener updates are intentionally no-ops in the documented 2D MVP (`:187–224`).
- `audioDirector.ts`, `audioLiveSession.ts`, backend/unlock/test-backend modules and semantic evidence tests provide unusually extensive test seams. The focused 115 `audioDirector` tests and full audio-related suites passed without retail assets; no physical audio output was verified.

### Save/snapshots — strongest persistence implementation in this audit

- `web/src/sim/simSnapshot.ts` implements `CNCSAV` envelope version 1 and payload schemas v1/v2, bounded payload parsing, template/module reconstruction, RNG, object IDs, pending destroys, command queue, AI, victory, shroud, teams, WorkOrders, and update wake frames.
- `web/src/browser/saveGameFiles.ts` provides safe `.cncsav` download and lobby reconstruction; `web/src/index.ts` wires save/load into the live app.
- `simSnapshot.test.ts` has 135 passing tests, including corruption/cross-reference rejection and capture → restore → recapture byte/timing preservation. This is high-value reference material, though its schema is port-specific and large (3,808 lines).

### Replay — working port-owned subset, not retail-complete

- `web/src/sim/replayRecording.ts` records flushed commands into the replay format; `replayPlayback.ts` installs playback before object updates; `replayCommandBridge.ts` decodes and dispatches commands.
- `replayCommandBridge.ts:23–55` explicitly marks message ordinals 1001–1010 as port-owned, not retail-authoritative, and lists unsupported command/object-ID parity gaps.
- `web/src/formats/replay/` handles binary replay parsing/serialization; `web/src/browser/replayFiles.ts` resolves maps and downloads `.rep` files.
- `replayDeterminism.test.ts` is excellent: it serializes/parses a recorded run, plays it twice, and compares every frame’s extended CRC and RNG checkpoint against live. It passed.

### Determinism — strongest verified test architecture, with honest scope limits

- `web/src/sim/stateHash.ts` implements integer CRC primitives, sorted object traversal, float32 folding, RNG state, retail-light and extended hashes.
- Its contributor table explicitly marks full/partial/none coverage. Comments state the hashes prove the port against itself and are not yet retail-replay compatible; PlayerList/AI and other retail contributors remain absent.
- `stateHashHarness.ts` supplies reusable `recordRun` / `compareRuns` and first-divergent-frame reporting.
- `gate4Determinism.test.ts` verifies two clean runs, committed golden hashes, and useful simulation work. Additional aircraft, economy, containment, crate, topple, veterancy, special-power, fog, and dozer determinism tests all passed in the broad suite.
- This is the best donor for reusable determinism test patterns; the hash itself must not be misrepresented as complete retail parity.

### Formats and renderer — additional reusable value

- Asset-free tests passed for BIG, RefPack, INI, W3D chunks/mesh/hierarchy/animation, TGA, DDS, CSF, maps, replay, random, and synthetic VFS sources. These tests use synthetic fixtures and are reusable without retail content.
- `web/src/render/rendererFactory.ts` explicitly disables Three’s WebGL fallback and checks `isWebGPUBackend`; the WebGPU-only README claim is source-verified. Production bundling passed, but actual GPU rendering was not exercised.

## 5. Claims versus verified status

| Upstream claim | Audit status |
| --- | --- |
| Voidstrike “worker-first” authoritative runtime | **Source-verified** as a real worker architecture; browser execution not verified because build fails. |
| Voidstrike deterministic simulation / lockstep / desync forensics | **Subsystems and unit tests verified**; no whole-game cross-instance proof established by this audit. |
| Voidstrike integrated editor/navigation/audio | **Implementations verified**; only some areas have direct tests; save/replay is not comparably complete. |
| Generals `npm test` must pass on clean clone without assets | **Contradicted at this HEAD** by two ungated hard-coded retail-path files. Remainder passes with exactly those files excluded. |
| Generals ~3,500 asset-free tests | **Substantively supported** — 3,559 passing tests observed — but stock exit status is red due to the gating defect. |
| Generals deterministic sim, audio, AI, replay/save | **Verified in source and asset-free tests**, within the explicit MVP/parity limits above. |
| Generals WebGPU-only | **Source-verified**; build passes, live GPU behavior untested. |

## 6. Recommended reuse priority for Wayfinder

1. **Adapt test ideas first, not donor code wholesale.** Start with Generals’ `stateHashHarness.ts` pattern, per-frame replay CRC/RNG comparison, snapshot recapture checks, and bridge lifecycle/ObjectID-reuse cases.
2. **Use Voidstrike as the worker-boundary reference.** Compare its typed message protocol, render snapshots, adapter, and transferable navmesh buffers against Wayfinder’s intended native-sim/worker bridge; retain the distinction between authoritative state and presentation-only audio/render state.
3. **Combine navigation test styles.** Voidstrike contributes real Recast/WASM elevation, dynamic-obstacle, ramp, and full-map connectivity scenarios; Generals contributes fast deterministic grid-cost/order tests. Budget Recast tests explicitly instead of hiding their current 5 s failures.
4. **Treat persistence claims asymmetrically.** Generals has meaningful versioned snapshot/replay verification. Voidstrike’s current `SaveLoadSystem` is incomplete and worker-incompatible; do not reuse it as evidence of save support.
5. **Preserve documented limitations.** Generals’ pathfinding, retail CRC, replay ordinals, 2D audio, and fixed-step behavior are intentionally partial. Voidstrike’s passing unit tests do not erase its current type/build failures or save gaps.

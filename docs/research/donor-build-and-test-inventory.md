# Priority donor repositories: pinned builds and reusable test inventory

- **Issue:** [jamesm944/game#161](https://github.com/jamesm944/game/issues/161)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140)
- **Date:** 2026-10-25
- **Method:** four parallel source audits; shallow clones, exact `HEAD` pins, local build/test attempts and direct source inspection
- **Scope:** private local use. Licences are provenance, not selection filters. No donor code was integrated and no production file was changed.

## 1. Executive result

Eight priority donors are now pinned and audited. **The Generals TypeScript port is the strongest verified donor for determinism, snapshots, replay and sim/render bridge tests. Voidstrike is the strongest source donor for worker/runtime, WebGPU, editor and Recast integration, but its pinned checkout does not typecheck or build. Widelands has the strongest reusable logistics-routing tests. DFHack Orders has the most directly transferable automation fixtures. Augustus and both RimWorld mods require new adapter-level tests because upstream coverage is absent or host-bound.**

No claim below treats a README as proof. “Passed” means executed during this audit; “source-verified” means inspected but not executed.

| Donor | Branch and exact commit | Verification result | Primary reuse verdict |
|---|---|---|---|
| Voidstrike | `main` [`4df0235116b78bf9232105486738e64b2e6905cb`](https://github.com/braedonsaunders/voidstrike/commit/4df0235116b78bf9232105486738e64b2e6905cb) | Typecheck/build **failed**; 2,517 tests passed, 2 timed out; all 4 Recast ramp tests passed with a diagnostic 20 s timeout | Worker/render/navigation/editor/audio source; do not use its incomplete save system |
| Generals Three.js port | `main` [`816b259c962c13d7d3c6e0cb2def1c682e410bdb`](https://github.com/sentifold/generals-rts-threejs-port/commit/816b259c962c13d7d3c6e0cb2def1c682e410bdb) | Typecheck/build **passed**; 3,559 asset-free tests passed after excluding two improperly ungated retail-only files; focused reusable set **335/335 passed** | Best determinism/snapshot/replay/bridge test donor |
| OpenRA | `bleed` [`dbe674733305cd1ebe7bd03feed347b5c0da3c08`](https://github.com/OpenRA/OpenRA/commit/dbe674733305cd1ebe7bd03feed347b5c0da3c08) | `make tests` blocked before build: .NET 10 SDK absent | Activities/orders/shroud/replay architecture; add missing tests |
| Widelands | `master` [`bfc7713d5f5659bb6393a78205c408c081d4b027`](https://github.com/widelands/widelands/commit/bfc7713d5f5659bb6393a78205c408c081d4b027) | Test-enabled CMake configure blocked by missing SDL2_image; no tests ran | Best routing fixtures; logistics, save/replay and Lua scenario references |
| Augustus | `master` [`dae1899ef6abca7a19b73a99f65f6aa680a78173`](https://github.com/Keriew/augustus/commit/dae1899ef6abca7a19b73a99f65f6aa680a78173) | Configure blocked by missing SDL2_mixer; CTest inventory 0; no checked-in suite found | Rich city mechanics; derive golden tests before porting |
| DFHack | `develop` [`438faf3b87ff3a308c0a8501e91228a10cdaeec4`](https://github.com/DFHack/dfhack/commit/438faf3b87ff3a308c0a8501e91228a10cdaeec4) | Configure blocked: GCC 11–15 and submodules required; available Clang rejected and GCC 16 unsupported; CTest inventory 0 | Port Orders fixtures and Workflow range semantics, not the disabled whole plugin |
| RimWar | `master` [`aab38d573275f5d2a1552e70e7dd4702507a2cc2`](https://github.com/TorannD/RimWar/commit/aab38d573275f5d2a1552e70e7dd4702507a2cc2) | No tests; clean build needs proprietary/local RimWorld, Unity and Workshop assemblies | Pure policy ports behind injected RNG/clock/world adapters |
| PickUpAndHaul | `master` [`09f1fac96e70cc2a93d647615a5abd37734a3eba`](https://github.com/Mehni/PickUpAndHaul/commit/09f1fac96e70cc2a93d647615a5abd37734a3eba) | No tests; .NET toolchain absent; public reference packages make a future compile plausible but unverified | Batch planner/unload policies behind storage/inventory/reservation ports |

## 2. Verification details

### 2.1 Browser donors

Both were installed locally from lockfiles with Node `v24.21.0` / npm `11.12.1`. No retail assets, Playwright/E2E downloads or live WebGPU runs were used.

**Voidstrike commands and results**

- `npm ci`: passed.
- `npm run type-check`: failed in `src/rendering/tsl/effects/EffectPasses.ts` and test config/API mismatches. Three runtime/types skew is present (`three` 0.182.0 versus `@types/three` 0.172.0), with an additional cross-installation type conflict in this workspace.
- `npm run build`: application compilation succeeded, then Next's TypeScript phase failed.
- `npm test`: **2,517 passed / 2 failed**. Both failures were 5 s timeouts in `tests/engine/pathfinding/recastRampConnectivity.test.ts`.
- The same ramp file passed **4/4** with `--testTimeout=20000`; this diagnoses a budget problem, not a demonstrated connectivity assertion failure, and does not make the stock suite green.
- `npm run lint`: exit 0 with 381 warnings.

**Generals commands and results**

- `npm ci`, `npm run typecheck`, `npm run build`: passed.
- Stock `npm test`: **3,559 passed / 1 failed / 119 skipped**, plus a suite failing during setup. `vite-plugins/gameAssetServer.test.ts` and `test/retailAIScriptSourceMounted.test.ts` access a hard-coded Windows retail `SkirmishScripts.scb` path without the normal skip gate.
- Excluding exactly those two files: **3,559 passed / 96 skipped / 0 failed**.
- Focused replay, determinism, snapshot, bridge, navigation, AI and audio run: **335/335 passed**.
- Therefore its clean asset-free README claim is not literally true at this revision, although the substantive suite is large and useful.

### 2.2 Native and host-coupled donors

- OpenRA targets C# 13 / `net10.0`; `make tests` stopped at `dotnet: command not found`. No NUnit/YAML checks ran.
- Widelands CMake found AppleClang 16, OpenGL, PNG, ZLIB and SDL2, then stopped at missing SDL2_image. `test_economy` was not generated; Lua/regression tests require a game binary and were not run.
- Augustus CMake stopped at missing SDL2_mixer. Its CI “Build and test” step builds but no actual test suite was found. No Caesar III assets were sought.
- DFHack requires GCC 11–15 and initialized submodules. Available Apple Clang is rejected; installed GCC 16.2.0 is explicitly unsupported. Required submodules and the proprietary host were not downloaded.
- RimWar directly references proprietary game/Unity and local Workshop assemblies; its checked-in DLLs do not make a clean source build possible.
- PickUpAndHaul targets `net48` and uses public `Krafs.Rimworld.Ref` packages, but `dotnet`, `msbuild`, `xbuild`, `csc` and `mcs` were unavailable. Runtime still requires RimWorld.

These are environment/dependency results, not assertions that donor code is incorrect.

## 3. Reusable code and test shortlist

### Priority 1 — Generals determinism and persistence

Pinned root: `web/src/` at `816b259c…`.

- `sim/replayDeterminism.test.ts`: records a run, parses/plays it twice and compares every frame's extended CRC and RNG checkpoint against live execution.
- `sim/gate4Determinism.test.ts`, `sim/stateHashHarness.ts`: clean-run comparison and first-divergent-frame reporting.
- `sim/simSnapshot.ts` plus 135 passing tests: versioned envelope, bounded parsing, cross-reference rejection, RNG/object IDs/commands/AI/shroud/team state and capture → restore → recapture behavior.
- `browser/simRenderBridge.ts` plus 19 passing tests: visual binding/reconciliation, coordinates, lifecycle/disposal, reset/ObjectID reuse and restored-world binding.
- `sim/replayRecording.ts`, `replayPlayback.ts`, `replayCommandBridge.ts`, `formats/replay/`: working port-owned replay subset. Command ordinals and retail CRC coverage are explicitly incomplete; do not claim retail parity.

**Reuse action:** translate the harness patterns and fixtures before copying production implementations. Age of Wind should gain per-tick hash/RNG comparison, first-divergence diagnostics, snapshot recapture and bridge lifecycle tests regardless of the eventual engine.

### Priority 2 — Voidstrike worker/runtime and rendering

Pinned root: `src/` at `4df02351…`.

- `engine/workers/{GameWorker,WorkerBridge,types,RenderStateAdapter}.ts`: real authoritative worker, typed message protocol, serialized render snapshots, adapter reuse and interpolation inputs.
- `workers/`: pathfinding, vision, AI decisions, GLTF, overlay and countdown entry points.
- `components/game/hooks/useWorkerBridge.ts`: configures the current donor at 20 TPS; this is donor configuration, not a recommendation to change Age of Wind's 30 Hz contract.
- `engine/pathfinding/RecastNavigation.ts`, `systems/PathfindingSystem.ts`, `editor/services/EditorNavigation.ts`: Recast/WASM and dynamic-obstacle integration. Ground-worker support and main-thread fallback differ by query domain.
- `rendering/tsl`, `rendering/compute`, `rendering/water`: high-value rendering candidates for the existing visual roadmap.
- `editor/`: substantial React/Three map tooling and navigation validation.
- `audio/AudioManager.ts`, `engine/systems/AudioSystem.ts`: event-driven presentation audio with budgets, pooling and priorities.

**Important exclusions:** `SaveLoadSystem.ts` depends on unavailable `localStorage` in the worker and restores only a simplified subset; no usable general replay implementation was found. The two GameWorker tests do not prove end-to-end messaging or multi-worker determinism.

### Priority 3 — Widelands logistics and scenario persistence

Pinned root at `bfc7713d…`.

- `src/economy/{router,routeastar,routing_node,iroute,itransport_cost_calculator}.*`: estimator-injected A*, separate ware/worker costs, route reconstruction and cost cutoffs.
- `src/economy/test/test_routing.cc`: **18 source-verified cases** using lightweight fake nodes/routes/cost calculators: connectivity, shortcuts, route pieces, priced ware-versus-worker routing and cutoffs. They were not executable in this environment.
- `request.cc`, `transfer.cc`, `flag.cc`, `road.cc`, `ware_instance.cc`, `warehousesupply.h`: request/supply/transfer lifecycle and versioned persistence.
- `logic/map_objects/tribes/carrier.cc` and `worker_tasks/carrier_*`: pickup acknowledgment, full-flag exchange/wait and transport interruption behavior.
- `logic/generic_save_handler.cc`: transactional backup/restore; `logic/replay.cc`: embedded initial save + RNG + timestamped commands + sync reports.
- `test/maps/lua_persistence.wmf/scripting/test_persistence.lua`: broad save/reload assertions including coroutines/objectives.
- `data/campaigns/*/scripting/mission_thread.lua` and tutorial campaigns: concrete coroutine/objective structures.

**Adaptation caveats:** `RouteAStar` explicitly does not support concurrent instances; carrier and replay branches need new direct tests; naval transport scenarios are adjacent rather than complete road-carrier coverage.

### Priority 4 — OpenRA orders, activities and shroud

Pinned root at `dbe67473…`.

- `OpenRA.Game/Activities/Activity.cs`, `Actor.cs`, `OpenRA.Mods.Common/Activities/`: explicit queued/active/canceling/done lifecycle, parent/child/next composition, cancellation and cleanup.
- `OpenRA.Game/Network/{Order,OrderIO,OrderManager,ReplayRecorder,ReplayConnection}.cs`: bounded order serialization, frame queues, sync hashes and replay through the normal connection boundary.
- `OpenRA.Test/OpenRA.Game/OrderTest.cs`: six compact serialization round trips.
- `OpenRA.Game/Traits/Player/Shroud.cs`: keyed source counts, exploration and dirty-cell resolution separated from `ShroudRenderer.cs`.
- `OpenRA.Test/OpenRA.Game/ActorInfoTest.cs`: required/optional dependency ordering and cycle fixtures.

**Coverage gap:** no dedicated activity, replay or shroud tests were found. Create lifecycle, nested priority, cancellation, packet corruption, overlapping-source and metadata-version tests before adapting these designs.

### Priority 5 — Augustus city simulation

Pinned root at `dae1899e…`.

- `src/building/properties.c`: 20 declarative housing tiers with evolution/devolution requirements, capacities and tax multipliers.
- `src/building/house_evolution.c`, `house_service.c`, `house_population.c`: requirement evaluation, coverage decay and population/capacity behavior.
- `src/figure/service.c`: physical service coverage and risk/goods/service callbacks.
- `src/city/finance.c`, `sentiment.c`, `migration.c`: monthly tax/finance, cause-ranked sentiment and migration thresholds.
- `src/scenario/request.c`: the real request lifecycle—normal/dispatched/late/received/overdue/ignored, favour and save/load. `src/city/request.c` is primarily an adapter.
- `src/building/monument.c`: phase/resource matrices and in-flight delivery accounting.

**Required new tests:** every housing threshold/missing requirement, coverage edge/decay, integer tax ledger, sentiment/migration boundary, request transition and mid-request save, monument partial/duplicate/cancelled delivery. No upstream suite exists to rely on.

### Priority 6 — DFHack automation

Pinned root at `438faf3b…`.

- `test/plugins/orders.lua`: active runtime fixtures for malformed input, field/type validation, import/export, reaction conditions and restore behavior. Translate these into local Workplace bill schema tests.
- `plugins/orders.cpp`: JSON import/export, ID remapping, stable sorting and condition invalidation.
- `plugins/workflow.cpp`: maintain-range hysteresis (`resume <= goal-gap`, `suspend >= goal`), available/in-use stock filters and constraint conflict weights.

**Critical qualification:** Workflow's build declaration and only test are commented out at this revision. Extract its small pure rules; do not import the entire 1,836-line plugin as if it were maintained, executable infrastructure.

### Priority 7 — RimWar world policies

Pinned root: `Source/RimWar/` at `aab38d57…`.

- Real behavior is in `WorldComponent_PowerTracker.cs`, `RimWarData.cs`, `RimWarSettlementComp.cs`, `WorldUtility.cs` and `IncidentUtility.cs`; `WorldComponent_IncidentTracker.cs` is a stub.
- Portable policies: behavior-weight selection, faction/settlement power and growth, abstract combat, scheduling and demand planning.
- Host-only orchestration—world objects, map/pawn creation, dialogs, letters and combat spawning—belongs behind adapters.

**Required new tests:** deterministic weights at exact thresholds, power/heat clamps, delayed gains exactly once, combat ratio boundaries, empty factions, scheduling cadence and no-duplicate dispatch. Characterize the suspicious defender-victory comparison at `IncidentUtility.cs:116` before deciding whether to preserve or change it.

### Priority 8 — PickUpAndHaul batch logistics

Pinned root: `Source/PickUpAndHaul/` at `09f1fac9…`.

- `WorkGiver_HaulToInventory.cs`: nearest-candidate search, multi-item/multi-destination allocation, capacity and storage selection.
- `JobDriver_HaulToInventory.cs`, `JobDriver_UnloadYourHauledInventory.cs`: reservation, stack splitting, unload and failure state machines.
- `CompHauledToInventory.cs`, `PawnUnloadChecker.cs`: identity registry and unload triggers.

**Required ports/tests:** storage/inventory/reservation queries, per-plan skip state, deterministic item identities, exact-fit/overflow/no-storage cases, independent planner isolation, merged-stack identity, reservation failure and unload-loop termination.

## 4. Recommended extraction order

1. **Determinism contract first:** adapt Generals hash/divergence/replay/snapshot fixtures to the current game before any large donor port.
2. **Shared bridge contract:** compare Generals bridge lifecycle with Voidstrike worker snapshots; establish one command/snapshot/event contract through #158/#159.
3. **Navigation evidence:** feed both donors' grid/Recast scenarios into #162 rather than selecting by feature lists.
4. **Logistics vertical slice:** Widelands routing fixtures + PickUpAndHaul allocation + DFHack bill validation/hysteresis.
5. **City vertical slice:** Augustus housing/service/request/monument state machines behind new golden fixtures.
6. **World incidents:** RimWar pure policies only after RNG/clock/world command adapters exist.
7. **Presentation harvest:** Voidstrike rendering/editor/audio after the engine decision, with independent visual/performance evidence.

## 5. Constraints for every donor port

- Pin upstream commit and copied paths in a donor manifest; retain local-edit history.
- Keep donor code behind an adapter until semantic tests pass.
- Use one authoritative Activity/entity model; do not import parallel job systems.
- Inject RNG, clocks, storage, world queries and command sinks; remove global/host lookups from portable policy.
- Apply asynchronous results at deterministic tick boundaries in stable order.
- Preserve save/load in the middle of activities, requests, shipments and narrative events.
- Require same-seed/same-command equivalence, including 1/2/4/8 workers when #159's architecture is selected.
- Record characterization tests for suspected donor defects instead of silently preserving or fixing them.

## 6. Primary-source audit record

Local clones and detailed command/source notes remain under `scratch/donor-audit/`:

- `browser-report.md` — commands, failures, module/line evidence and claim-versus-verification table for Voidstrike and Generals.
- `rts-report.md` — OpenRA/Widelands build record and detailed source/test inventory.
- `city-report.md` — Augustus/DFHack licences, entry points, configure logs and derived test scenarios.
- `mods-report.md` — RimWar/PickUpAndHaul host coupling, portable policies and required adapter tests.

All eight donor worktrees were left without tracked modifications. No production integration was performed.

# Open-source donor inventory and implementation roadmap

- **Issue:** [jamesm944/game#160](https://github.com/jamesm944/game/issues/160)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140)
- **Date:** 2026-10-25
- **Mode:** research and planning only; no donor code has been integrated by this document
- **Scope ruling:** James confirmed strictly private local use. Licensing is retained as provenance metadata, not as a donor-selection filter. This plan covers source code, not proprietary game assets or decompiled proprietary code.

## 1. Executive recommendation

**Harvest substantial subsystems; do not fork one entire donor and then bolt the existing game onto it.** Age of Wind already has a deterministic TypeScript simulation, content definitions, save/replay support, RTS combat/economy and a large test suite. The highest-return strategy is to preserve those working contracts while importing donor modules behind narrow adapters.

Use five principal code wells:

1. **Voidstrike** — closest current browser-native donor: TypeScript, Three.js, WebGPU/TSL, worker runtime, Recast/WASM navigation, advanced post-processing, AI, map editor, audio and saves.
2. **Generals RTS — Three.js Port** — second TypeScript donor with an explicit `sim` / `render` / `formats` separation, deterministic tests, replay/save/audio plumbing and a large asset-free test suite.
3. **OpenRA** — mature activity/order/trait/shroud/replay architecture and data-driven RTS content patterns.
4. **Augustus + Widelands** — deep, working city simulation and physical logistics: housing, services, taxation, sentiment, imperial requests, roads, carriers, warehouses, routing and campaign scripting.
5. **DFHack + selected RimWorld mods** — work automation, batch hauling, faction incident pacing and multithreading investigations for the Pop simulation.

Use supporting libraries where they replace undifferentiated infrastructure: Recast/Detour, shipyard, Rayon, FlatBuffers, Serde, ink/inkjs, Godot Dialogue Manager and postprocessing.

**Engine and simulation-language decisions remain open.** This research does not resolve #158 or #159 and does not treat the uncommitted ADR-0008 draft as ratified. The first implementation phase therefore extracts and evaluates donor seams before binding them to a new engine.

## 2. Corrections and constraints discovered during this audit

- Augustus currently identifies as **AGPL-3.0**, not GPL-3.0 as the older city-builder note states. This does not exclude it under James's private-use ruling, but the provenance table must be accurate.
- DetourCrowd is not a magical unlimited-unit solution. Its own header documents local rather than long-range planning, ownership of agent position, and a starting envelope of roughly 20–30 managed agents for 0.5 ms per frame. Use hierarchical/shared planning and benchmark before replacing the existing group-path system.
- shipyard documents both outer parallelism (workload scheduling) and inner parallelism (`par_iter`), and explicitly warns that parallel iteration has overhead. It does not provide deterministic conflict ordering or replay determinism by itself.
- Voidstrike claims a broad, impressive feature set in its own README. Treat those as repository capabilities to inspect and benchmark, not as evidence that its modules meet Age of Wind's determinism or performance contracts.
- The Generals port describes itself as work in progress despite approximately 3,500 asset-free tests. Reuse tested infrastructure selectively; do not assume retail-game parity.
- Map #140's one-line gist for #153 says six epochs, while accepted ADR-0007 specifies **8 Master Epochs / 24 ranks**. A follow-up must reconcile the map text with the ADR; this report follows ADR-0007.

## 3. Donor matrix

Reuse levels:

- **Direct vendor:** compile the upstream library with a thin integration layer.
- **Port:** copy source into the donor tree and translate language/framework assumptions while retaining algorithms and tests.
- **Adapt:** reuse substantial control flow/data models but redesign storage and external interfaces.
- **Reference:** study implementation and independently reproduce the small relevant mechanism.

### 3.1 Browser runtime, rendering and tooling

| Donor and exact modules | Reuse | What to extract | Integration risks / proof required |
|---|---|---|---|
| [Voidstrike](https://github.com/braedonsaunders/voidstrike): `src/engine/workers`, `src/workers`, `src/components/game/hooks/useWorkerBridge.ts` | Port / adapt | Worker-first fixed-step runtime, bounded command transport, render-state adapter, path/vision/AI worker separation | Verify background-tab policy, due-tick application, backpressure and identical replay digests before adopting |
| Voidstrike: `src/rendering/tsl`, `src/rendering/compute`, `src/rendering/water` | Port / adapt | TSL terrain/water/fog, post-processing, GPU culling/vision, instanced motion vectors and temporal effects | Match the chosen Three.js version; validate visual gains and frame-time separately from simulation |
| Voidstrike: `src/editor`, `src/app/game/setup/editor` | Port / adapt | 3D map editor, terrain brushes, object placement, navigation validation, map export | Replace donor content/schema dependencies with Age of Wind map and era definitions |
| Voidstrike: `src/engine/ai`, `src/engine/systems/ai`, `src/data/ai` | Adapt | Behaviour trees, influence maps, scouting memory, retreat coordination, build orders and worker distribution | Route all observations through `KnowledgeView`; no hidden omniscience |
| Voidstrike: `src/audio`, `src/engine/systems/AudioSystem.ts` | Port / adapt | Music, buses, alerts and gameplay audio orchestration | Replace sci-fi event vocabulary and content; retain concurrency, priority and ducking machinery |
| Voidstrike: `src/engine/systems/SaveLoadSystem.ts` | Reference / adapt | Save orchestration and runtime lifecycle ideas | Existing `.ageof` schema remains canonical until the versioning ticket decides otherwise |
| [Generals Three.js port](https://github.com/sentifold/generals-rts-threejs-port): `web/src/browser/simRenderBridge.ts` | Port / adapt | Tested TypeScript sim/render boundary and visibility handling | Compare against current render mirror; retain the stronger contract rather than creating a second bridge |
| Generals port: `web/src/formats/replay`, `web/src/browser/replayFiles.ts`, `saveGameFiles.ts` | Adapt | Replay/file validation and browser persistence patterns | Translate formats; do not import Generals-specific data or retail-asset requirements |
| Generals port: `web/src/browser/audio*` and `web/src/formats/ini/audioEvents.ts` | Adapt | Audio director/backend separation, semantic audio events and tests | Replace INI/retail-specific parser dependencies with local definitions |
| Generals port: `web/src/sim` and its tests | Selective port | Activity, AI script runtime, combat/economy implementations where they outperform local equivalents | Module-by-module differential tests; no wholesale replacement of the existing sim |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | Direct vendor | Established Three.js post-processing passes and effect composition | Version-match Three.js; measure bandwidth and aliasing at all three camera modes |
| [Godot](https://github.com/godotengine/godot) | Direct engine donor if #158 selects it | MIT engine, native rendering, editor, audio and export pipeline | Does not solve deterministic simulation; native/Rust boundary remains required |

### 3.2 Deterministic simulation, movement and parallel architecture

| Donor and exact modules | Reuse | What to extract | Integration risks / proof required |
|---|---|---|---|
| [Recast Navigation](https://github.com/recastnavigation/recastnavigation): `Detour`, `DetourCrowd`, `DetourTileCache` | Direct native/WASM vendor or port | Navmesh queries, path corridors, local avoidance, dynamic tiles and existing tests | Float determinism, agent-count ceiling, terrain mutation cost; ADR-0003 currently selects grid A* → flow fields |
| [PathFinding.js](https://github.com/qiao/PathFinding.js): `src/finders`, heap/grid utilities | Port | Multiple A*, Dijkstra, bi-directional and jump-point implementations | Existing integer costs and stable tie-breaking remain mandatory; benchmark before replacement |
| Voidstrike: `src/engine/pathfinding/RecastNavigation.ts`, `src/workers/pathfinding.worker.ts` | Adapt | A working TypeScript/WASM Recast integration and worker protocol | Compare against current 120×120 integer grid and group A* before changing ADR-0003 |
| [shipyard](https://github.com/leudz/shipyard): workloads, `src/iter/parallel.rs` | Direct vendor if Rust wins #159 | ECS storage, borrow-aware workload scheduling and Rayon parallel iteration | Parallel scheduling is not deterministic event reduction; whole-game layout still must be designed |
| [Rayon](https://github.com/rayon-rs/rayon): indexed parallel iterators, `fold`, `reduce` | Direct vendor | Native worker pool and parallel kernels | Avoid order-sensitive floating reductions; collect and apply conflicts by stable keys |
| [RimThreaded](https://github.com/cseelhoff/RimThreaded): `Source/CustomTickList.cs`, `OneTickPool.cs`, patch catalogue | Reference / selective adaptation | Real-world evidence about which simulation operations are hard to parallelise safely | It patches a closed host game; do not transplant architecture blindly or treat it as determinism evidence |
| [FlatBuffers](https://github.com/google/flatbuffers) | Direct vendor if a native core wins | Versioned command/snapshot wire schema and zero-copy accessors | Schema evolution, allocation cost and buffer lifetime benchmarks; not needed inside one TypeScript process |
| [Serde](https://github.com/serde-rs/serde) | Direct vendor if Rust wins | Save-state and fixture serialisation | Canonical field ordering and explicit format versions remain project responsibilities |

**Architectural invariant for any parallel donor:** command application and cross-entity conflicts resolve at explicit barriers in stable order. Parallel workers may compute proposals; they must not perform nondeterministic shared mutation. Test identical output for 1/2/4/8 workers and across repeated runs.

### 3.3 City, economy and Pop systems

| Donor and exact modules | Reuse | What to extract | Integration risks / proof required |
|---|---|---|---|
| [Augustus](https://github.com/Keriew/augustus): `src/building/house_evolution.c`, `house_service.c`, `house_population.c` | Port / adapt | Housing requirement evaluation, service coverage, upgrade/devolution and population capacity | Convert house aggregates to Household/Pop ownership without losing existing individual lifecycle |
| Augustus: `src/building/figure.c`, `src/city/figures.c`, routed figure implementations | Adapt | Physical service-walker spawning, routing, destination selection and coverage | Replace global C state with ECS commands; preserve deterministic route tie-breaking |
| Augustus: `src/city/finance.c`, `sentiment.c`, `migration.c`, `ratings.c` | Port / adapt | Tax/finance flow, sentiment causes, migration and city ratings | Reconcile with locked job-income tax, Pop wealth, interest groups and unrest rather than duplicating morale |
| Augustus: `src/city/request.c`, `emperor.c`, `src/building/monument.c` | Port / adapt | Imperial requests, favour, deadlines and staged monuments | Feed the existing scenario event stream and locked Emperor Favor model |
| Augustus: `src/city/health.c`, `culture.c`, `entertainment.c`, `gods.c` | Adapt | Service accumulation and city-wide coverage/rating models | Avoid importing a second victory system; expose metrics to existing evaluators |
| [Widelands](https://github.com/widelands/widelands): `src/economy/routeastar.cc`, `router.cc`, `request.cc`, `transfer.cc` | Port / adapt | Commodity requests, supply matching and route costs | Preserve entity-level cargo identity and deterministic tie-breaking |
| Widelands: `flag.cc`, `road.cc`, `ware_instance.cc`, `warehousesupply.cc`, `workers_queue.cc` | Port / adapt | Physical road/flag/carrier logistics, stock and worker queues | Decide which settlements use physical road logistics versus current free-drop-off network |
| Widelands: `src/logic/map_objects/tribes/carrier.cc`, `worker_tasks/carrier_*` | Adapt | Carrier activity state machines and transport execution | Express as local Activity implementations; avoid a parallel job system |
| [DFHack](https://github.com/DFHack/dfhack): `plugins/workflow`, `plugins/orders` | Port / adapt | Standing production constraints and automation logic | Convert DF item/job APIs to Workplace bills and local commodity stock |
| [PickUpAndHaul](https://github.com/Mehni/PickUpAndHaul): `Source/PickUpAndHaul/JobDriver_HaulToInventory.cs`, `WorkGiver_HaulToInventory.cs`, unload drivers | Port / adapt | Batch hauling, inventory capacity checks and unload behaviour | Harmony/RimWorld host calls must be replaced; use existing carry/deposit activities |
| [RimWar](https://github.com/TorannD/RimWar): `Source/RimWar/Planet/WorldComponent_IncidentTracker.cs`, `WorldComponent_PowerTracker.cs`, `IncidentUtility.cs` | Port / adapt | Persistent faction power and world incident scheduling | Strip RimWorld world-object dependencies; use seeded local scenario clocks |
| RimWar: `Source/RimWar/Utility/IncidentWorker_*.cs` | Adapt | Raid, demand and meeting incident variants | Convert outcomes to local commands/events; no direct state mutation outside sim |
| Existing research: thought ledgers, wounds, rooms, weather, legends | Implement from documented mechanics | Keep the priority already resolved by #146 | No vanilla DF/RimWorld code or data extraction |

### 3.4 Orders, AI, narrative, campaigns and modding

| Donor and exact modules | Reuse | What to extract | Integration risks / proof required |
|---|---|---|---|
| [OpenRA](https://github.com/OpenRA/OpenRA): `OpenRA.Game/Activities`, `Orders`, `Network/OrderManager.cs` | Adapt | Activity cancellation/queueing and order-only simulation input | Current ActivityQueue already follows this model; import missing behaviours, not a second queue |
| OpenRA: `OpenRA.Game/Traits`, `TraitDictionary.cs`, player shroud/frozen actor implementations | Adapt | Composable capabilities, fog memory and trait-conditioned behaviour | Preserve bitecs storage and fog-honest `KnowledgeView` |
| OpenRA: replay recorder/connection, `FieldSaver.cs`, YAML traits/rules | Reference / adapt | Replay metadata, serialization conventions and data-driven content validation | Keep current portable `.ageofreplay` contract until migration decision |
| OpenRA AI and mod activities | Selective port | Specific tactics and production behaviours missing locally | C# trait runtime cannot be dropped into TypeScript/Rust unchanged |
| Widelands: `src/scripting`, `data/campaigns/*/scripting/mission_thread.lua`, tutorial campaigns | Port / adapt | Coroutine-style mission sequencing and a concrete tutorial progression model | Sandbox scripts; deterministic command bridge; no wall-clock or unsourced randomness |
| [ink](https://github.com/inkle/ink) / [inkjs](https://github.com/inkle/inkjs): compiler and `src/engine/Story.ts` | Direct vendor | Branching narrative, state, choices and save/load for dilemmas | Story state belongs in snapshots; all gameplay effects enter the sim as commands |
| [Godot Dialogue Manager](https://github.com/nathanhoad/godot_dialogue_manager): `addons/dialogue_manager/compiler`, runtime and editor | Direct vendor if Godot wins | Dialogue authoring, compilation, branching and editor UI | Choose either Ink or Dialogue Manager as canonical narrative format; avoid two runtimes |
| Existing `src/data/definitions` + JSON Schema/Zod | Extend | Data-first unit/building/recipe/tech/incident definitions | Scripting is for scenario logic, not unrestricted authoritative code at launch |

## 4. Target integration shape

```text
Content / mods / campaign
  JSON definitions + validated scenario scripts + one narrative runtime
                         |
Player / AI / script ---- command inbox ----> authoritative simulation
                                               |
                    +--------------------------+----------------------+
                    |                          |                      |
              RTS activities           Pop/city/economy         event director
              combat/movement          logistics/politics       quests/dilemmas
                    |                          |                      |
                    +----------- deterministic phase barriers ------+
                                               |
                               snapshots / events / save state
                                               |
                          renderer / HUD / audio / editor
```

Rules:

1. One authoritative entity store and one Activity implementation per runtime.
2. Donor code lives initially under `third_party/<donor>` or `src/donors/<donor>` with an adapter, never mixed anonymously into core files.
3. Every donor has a pinned upstream commit and a manifest listing copied paths, local edits and removed host dependencies.
4. Rendering, audio and UI consume events/snapshots; they never mutate authoritative state.
5. AI and narrative use the same command boundary as the player.
6. All random behaviour uses named seeded streams. Worker count and completion timing cannot change output.
7. Existing golden fixtures remain behavioural references until #159 deliberately establishes a compatibility break.

## 5. Dependency-ordered implementation plan

### Phase 0 — Donor quarantine and reproducible evaluation

**Dependencies:** none. **Can start immediately.**

- Create `third_party/manifest.json` and `docs/donors/<name>.md` for every imported candidate.
- Pin Voidstrike, Generals port, OpenRA, Augustus, Widelands, DFHack, RimWar and PickUpAndHaul commits.
- Build each candidate untouched where practical. Record toolchain, tests, runtime evidence and module sizes.
- Write adapter-level tests before modifying donor algorithms.
- Maintain a reuse ledger: untouched vendor / translated / adapted / reference-only.
- Do not copy donor assets as part of code harvesting.

**Exit gate:** every proposed donor module has a known entry point, dependencies, test route and owner adapter; no unexplained multi-repository code dump.

### Phase 1 — Close the engine and simulation architecture route

**Dependencies:** existing #147, #157, #158 and #159. **Blocks engine-specific mass porting.**

- Finish James's visual review of terrain/camera and matched engine prototypes.
- Resolve #158 with actual evidence; preserve all three camera modes.
- Resolve #159 using representative whole-game workloads, not only the limited Rust slice.
- Compare three implementation routes using the donor matrix:
  - **TypeScript/WebGPU + optional Rust core:** maximum Voidstrike/Generals reuse; native core introduces FlatBuffers/process or WASM boundary.
  - **Godot + Rust native core:** maximum native editor/rendering reuse; TypeScript donor algorithms require translation and existing renderer work is not portable wholesale.
  - **Unity + independent Rust core:** strong authoring path; least direct reuse of current TypeScript stack; avoid a second C# authoritative sim.
- Specify command IDs, tick stamping, snapshots, events, saves, replay ownership, lifecycle and recovery before production migration.
- Update ADR-0004 only as part of the resolved #159 decision.

**Exit gate:** one engine, one simulation language, one bridge contract and one deterministic worker-count test plan recorded on the map.

### Phase 2 — Establish the shared donor contracts

**Dependencies:** Phase 1 for runtime-specific adapters; schema work can proceed earlier.

- Define canonical `Command`, `Activity`, `GameEvent`, `Snapshot`, `ContentDefinition`, `SaveVersion` and `ReplayHeader` boundaries.
- Build a source-to-target translation table for bitecs/shipyard, entity IDs, coordinates, resources, time and RNG.
- Add differential harnesses that run old and new implementations against the same command stream and compare semantic traces.
- Introduce deterministic event envelopes keyed by `(tick, phase, sourceEntity, sequence, eventType)`.
- Establish snapshot versioning and fixture naming before deep-system migration.

**Exit gate:** one donor vertical slice can run behind an adapter without changing renderer or player command semantics.

### Phase 3 — Rendering and presentation harvest

**Dependencies:** engine decision; visual decisions in #147/#148/#149.

For Three.js/WebGPU:

- Extract Voidstrike TSL terrain, water, fog and post-processing into isolated example scenes.
- Compare Generals and Voidstrike sim/render bridges against the current mirror.
- Add instancing/culling/temporal features one at a time with matched screenshots and frame-time traces.
- Port the useful map-editor terrain brushes, cliff/water tools and validation.

For Godot/Unity:

- Reuse camera compositions, assets and simulation trace; reimplement shaders in the selected engine instead of translating TSL line by line.
- Harvest Godot-native editor/audio/dialogue modules if Godot wins.

Across all routes:

- Preserve tactical, settlement and coastal panorama modes.
- Complete HUD prototypes before coupling deep-sim panels to live state.
- Build the audio event taxonomy and backend before content batching.

**Exit gate:** matched views meet James's visual review; 500 visible Pops and labelled stretch scenes are profiled; no simulation digest change.

### Phase 4 — Navigation and command execution upgrade

**Dependencies:** Phase 2; ADR-0003 comparison.

- Port candidate donor tests for path corridors, dynamic obstacles, formation movement and local avoidance.
- Benchmark three candidates on identical maps/traces: current integer group A*/flow-field route, PathFinding.js variants, Recast/Detour via Voidstrike's integration.
- Retain hierarchical/shared long-distance planning even if Detour handles local steering.
- Import missing OpenRA/Generals Activity behaviours: queued attack, patrol, garrison, transport, repair, cancel/resume and failure propagation.
- Prove path results apply at deterministic due ticks and stale passability versions are rejected.
- Test blocked gates, construction invalidation, water/land transitions, dense formations and worker-count invariance.

**Exit gate:** no degradation in replay compatibility without an approved boundary; better movement measured by completion time, stuck count and path latency, not visual intuition alone.

### Phase 5 — Physical logistics and economic automation

**Dependencies:** Phase 4 movement; existing Workplace/Company models.

- Port Widelands request/supply/route concepts into a logistics adapter.
- Introduce roads, flags, carriers and warehouses as optional configured logistics layers rather than silently invalidating all current drop-offs.
- Port carrier activities and stock queues; add route-cost caching and invalidation.
- Port PickUpAndHaul batch collection/unload semantics into existing carry activities.
- Port DFHack Workflow-style standing bills: maintain range, pause/resume, input priority and stockpile filters.
- Connect Foreman/Manager/Company layers so delegated management operates on the same requests as players.
- Add trace UI for a commodity: produced → requested → reserved → carried → stored → consumed.

**Exit gate:** seeded multi-workplace scenarios complete without deadlocks or duplicated cargo; save/load resumes every reservation and shipment; throughput and idle time improve measurably.

### Phase 6 — Housing, services, taxation and city sentiment

**Dependencies:** Phase 5 goods/logistics; locked #146/#151 decisions.

- Port Augustus housing requirement tables and evolution/devolution state machines into data definitions.
- Implement service walkers through existing Activity/navigation; emit coverage events rather than directly modifying arbitrary houses.
- Connect water, food variety, goods, religion, entertainment, health, safety and desirability to Household state.
- Port finance/tax collection timing and sentiment cause tracking, but map them to personal income, wealth, class and affordability.
- Implement physical bailiffs, tax ledgers and player-facing cause explanations.
- Add migration and housing occupancy using existing Household lifecycle; avoid creating anonymous replacement population.
- Feed city ratings into existing victory metrics instead of importing Augustus victory logic.

**Exit gate:** a Household's tier, affordability, tax burden and sentiment can be explained from inspectable events; no negative resource/wealth duplication; long-run demographic soaks remain bounded.

### Phase 7 — Emotional Pop simulation and legends

**Dependencies:** Phase 6 household/economic causes.

- Implement thought/memory ledgers and mental breaks from the #142 priority list.
- Extend wounds with bleeding, incapacitation, rescue and triage.
- Add room detection, beauty/impressiveness and venue effects.
- Port relevant incident/pacing machinery from RimWar after stripping host-specific world objects.
- Add chronicles/tales from actual event logs, named masterworks and post-match histories.
- Surface causes in HUD, notifications and campaign narrative; deep state without explanation does not count as complete.

**Exit gate:** identical seeds reproduce thoughts, breaks, wounds and tales; rare-tick budgets hold; every major mood change has a readable cause chain.

### Phase 8 — Politics, imperial pressure and dynamic stories

**Dependencies:** Phases 5–7; locked #151/#154/#155 and ADR-0007.

- Adapt Augustus imperial request deadlines, tribute, favour and consequences to the locked Suzerainty model.
- Implement council delegates, faction voting and policy effects through sim commands.
- Adapt RimWar faction-power/incident scheduling for wars, demands and meetings.
- Integrate InterestGroups, InfluentialFigures and ideological movements without duplicating Thought/Morale state.
- Implement riot/revolt/civil-war escalation and negotiated peace as explicit state machines.
- Add story dilemmas with one canonical narrative runtime and deterministic external variable synchronization.

**Exit gate:** council/imperial/rebel actions cannot bypass command ordering; saves resume mid-vote, mid-request and mid-dilemma; repeated seeds produce identical outcomes.

### Phase 9 — Epoch content pipeline and technological diffusion

**Dependencies:** stable economy/combat/content schemas from Phases 5–8.

- Reconcile the map's six-epoch gist with ADR-0007's 8/24 structure.
- Generalize content definitions to era gates, era-specific units/buildings/recipes and replacement/legacy rules.
- Implement the triple era gate: research, institutional readiness and Great Wonder quota.
- Build staged/capturable wonders using donor monument patterns but local ECS state.
- Implement technology diffusion via physical trade, borders/roads and diplomatic pacts.
- Add era-cap and starting-era setup, fixture generation and content validation.
- Batch content by playable era slices; do not author all 24 ranks before the first transition passes end-to-end tests.

**Exit gate:** Ancient→Classical and Medieval→Colonial reference transitions work; full 24-rank marathon validation is automated; legacy/captured wonders and era caps behave consistently.

### Phase 10 — AI, campaign, tutorial and modding

**Dependencies:** representative systems from Phases 4–9.

- Port/adapt Voidstrike influence maps, scouting memory, retreats and build-order execution behind `KnowledgeView`.
- Mine OpenRA/Generals behaviours for production counters and tactical activities.
- Give AI difficulty strategic options rather than direct hidden-state access; disclose cheats where retained.
- Adapt Widelands mission coroutines and tutorial sequencing to the existing scenario engine.
- Integrate Ink or Godot Dialogue Manager for campaign dialogue and branching dilemmas.
- Adapt the Voidstrike editor for maps, triggers, starting conditions and validation.
- Support data mods first; add sandboxed scenario scripts second. Do not expose arbitrary native code as the initial mod API.
- Create one tutorial chain: camera/commands → economy/logistics → housing/tax → combat → politics/era advancement.

**Exit gate:** AI plays all unlocked mechanics through public commands; tutorial/campaign saves and replays resume exactly; malformed mods fail validation without corrupting a match.

### Phase 11 — Audio, optimisation, compatibility and full-roadmap acceptance

**Dependencies:** ongoing; final gate after all preceding phases.

- Port audio directors/backends first, then batch licensed/local audio content by semantic event.
- Profile full representative workloads: economy, melee/fog, deep Pop, politics and late-era content at target populations.
- Measure serial and parallel fractions, worker scaling, bridge overhead, memory and input latency.
- Run 1/2/4/8-worker digest suites, long soaks, save/load equivalence and replay round trips.
- Complete migration/version policy for saves and fixtures across every new component.
- Produce donor attribution/provenance and retained upstream test reports even though private use is the current scope.

**Exit gate:** the complete roadmap has passing determinism, performance, campaign/tutorial, visual, audio and content gates on the declared machine and engine targets.

## 6. Recommended first implementation bundles after the open decisions

These are deliberately sequenced to produce reusable capability quickly without waiting for the entire roadmap:

1. **Donor harness + Voidstrike/Generals bridge comparison.**
2. **Terrain/water/post-processing candidate extraction in the selected renderer.**
3. **Navigation bake-off using the same recorded command traces.**
4. **Widelands request/route + PickUpAndHaul batch-carry vertical slice.**
5. **Augustus house evolution + service walker + tax/sentiment vertical slice.**
6. **RimWar incident director + Pop thought/chronicle vertical slice.**

Each bundle includes source manifest, adapter, semantic tests, save/replay support, profiling and a small visible scenario. This avoids months of invisible framework work.

## 7. Research still needed before specific implementation tickets

- **Pin and test donor revisions:** repository capability claims need local builds and targeted source reading.
- **Navigation bake-off:** integer grid/flow fields versus Recast/WASM under mutation and crowd load.
- **Save/replay compatibility:** choose semantic migration versus a reviewed hard break with #159.
- **Canonical narrative runtime:** Ink versus Godot Dialogue Manager after #158.
- **Physical-logistics scope:** which resources/buildings require roads and carriers, and where direct hauling remains.
- **Content scale:** asset/content matrix for all ADR-0007 epochs, including which systems transform rather than merely reskin.
- **Performance contract:** target populations and representative whole-game workloads for #159.
- **AI knowledge and difficulty contract:** prevent imported donor AI from bypassing fog honesty.

## 8. Primary sources

Repository and source inspections performed for this report:

- [Voidstrike README and source tree](https://github.com/braedonsaunders/voidstrike) — worker, rendering, Recast, AI, editor, audio and save module layout.
- [Generals RTS Three.js port README and source tree](https://github.com/sentifold/generals-rts-threejs-port) — project scope, test policy and `sim`/`render`/`formats` boundaries.
- [OpenRA source tree](https://github.com/OpenRA/OpenRA) — Activities, Orders, Traits, shroud and replay modules.
- [Augustus source tree](https://github.com/Keriew/augustus) — building, housing, city finance/sentiment/request/emperor modules; repository licence metadata.
- [Widelands source tree](https://github.com/widelands/widelands) — economy routing, carrier, save/replay and Lua campaign modules.
- [DFHack source and licence](https://github.com/DFHack/dfhack) — workflow/orders donor and Zlib provenance.
- [RimWar source and licence](https://github.com/TorannD/RimWar) — world power/incident implementation; MIT provenance.
- [PickUpAndHaul source](https://github.com/Mehni/PickUpAndHaul) — batch haul/unload drivers and work giver.
- [RimThreaded source](https://github.com/cseelhoff/RimThreaded) — tick pools and host-specific parallelisation patches.
- [Recast Navigation source](https://github.com/recastnavigation/recastnavigation) — Detour/Crowd/TileCache modules.
- [DetourCrowd header](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Include/DetourCrowd.h) — crowd ownership, local-planning and performance caveats.
- [shipyard parallelism guide](https://github.com/leudz/shipyard/blob/master/guide/master/src/going-further/parallelism.md) — outer/inner parallelism and overhead warning.
- [Rayon source](https://github.com/rayon-rs/rayon), [FlatBuffers](https://github.com/google/flatbuffers), [Serde](https://github.com/serde-rs/serde) — supporting native-core infrastructure.
- [Ink](https://github.com/inkle/ink), [inkjs](https://github.com/inkle/inkjs), [Godot Dialogue Manager](https://github.com/nathanhoad/godot_dialogue_manager) — narrative compilers, runtimes and save-capable story state.
- [Godot](https://github.com/godotengine/godot), [Three.js](https://github.com/mrdoob/three.js), [postprocessing](https://github.com/pmndrs/postprocessing) — rendering engine/library candidates.

Existing project research used as input rather than duplicated: `df-rimworld-donor-inventory.md`, `city-builder-donors.md`, `rts-engine-patterns.md`, `asset-sourcing-aaa.md`, `perf-baseline-2026-10.md`, ADR-0001 through ADR-0004 and ADR-0007.

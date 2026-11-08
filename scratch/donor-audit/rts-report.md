# Wayfinder #161 — RTS primary-source donor audit

## Scope and provenance

Private, local-use source audit only. No production code was changed and no donor code was integrated. Licensing is recorded as provenance, not used as a filter.

Both repositories were cloned with `git clone --depth 1` into separate audit directories. Every source path below is relative to the indicated clone and is pinned to the full commit shown; line ranges refer to that checkout.

| Project | Primary repository | Clone | Default branch | Full HEAD commit | License provenance |
|---|---|---|---|---|---|
| OpenRA | `https://github.com/OpenRA/OpenRA` | `scratch/donor-audit/rts/openra/source` | `bleed` | `dbe674733305cd1ebe7bd03feed347b5c0da3c08` | GPL-3.0-or-later; see `COPYING` and source headers |
| Widelands | `https://github.com/widelands/widelands` | `scratch/donor-audit/rts/widelands/source` | `master` | `bfc7713d5f5659bb6393a78205c408c081d4b027` | GPL-2.0-or-later for code, assorted CC licenses for assets; `README.md:14-16`, `COPYING` |

The default branches and commits were read with `git branch --show-current`, `git remote show origin`, and `git rev-parse HEAD`. Final `git status --short` in both source clones was empty; build output was kept outside the Widelands source clone in `scratch/donor-audit/rts/widelands/build`.

## Executive findings

1. **Best OpenRA architectural donors:** `Activity`'s explicit queued/active/canceling/done state machine with parent/child/next composition; the order serialization and frame-lockstep boundary; and shroud's keyed, per-source reference counts with dirty-cell updates. These are cohesive design references but are coupled to OpenRA's `Actor`, `World`, map geometry, traits, and sync model.
2. **Best Widelands algorithm/test donor:** `Router` + `RouteAStar` + `RoutingNode` with `test_routing.cc`. The tests use lightweight fake nodes/routes/cost calculators and directly exercise connectivity, route reconstruction, long routes versus shortcuts, ware-versus-worker costs, and cutoff behavior.
3. **Best Widelands persistence donors:** versioned economy/request/transfer/carrier packets, backup-and-restore save handling, and replay's embedded initial save + RNG state + timestamped command/sync stream. Lua persistence has an unusually broad save/reload regression scenario.
4. **Coverage warning:** OpenRA has directly relevant order serialization and trait-ordering unit tests, but no dedicated activity, replay, or shroud tests in `OpenRA.Test`. Widelands has strong routing and scripted persistence/transport coverage, but no dedicated C++ carrier/replay tests were found; its replay-specific runtime coverage was not established by this audit.
5. **No donor test passed or failed:** neither project could generate/run its relevant test executable in this environment. All execution results below are dependency/configuration results, not judgments about donor correctness.

---

# OpenRA

Pinned source: `scratch/donor-audit/rts/openra/source` at `dbe674733305cd1ebe7bd03feed347b5c0da3c08` (`bleed`).

## Build system and toolchain

- **Build:** Make wrapper over the .NET SDK; `Makefile:42-58,81-89` selects `dotnet`, platform RIDs, Release by default, and runs `dotnet build`. `OpenRA.slnx` is the solution file at this HEAD (there is no `OpenRA.sln`).
- **Language/runtime:** C# 13 targeting `net10.0`; `Directory.Build.props:3-22`. Projects use SDK-style `.csproj` files and NuGet dependencies. `INSTALL.md:9-26,76-81` requires the .NET 10 SDK; native SDL2/FreeType/OpenAL/Lua dependencies apply to system-library builds.
- **Tests:** NUnit 4.3.2, NUnit3TestAdapter 4.6.0, Microsoft.NET.Test.Sdk 17.12.0; `OpenRA.Test/OpenRA.Test.csproj:6-15`. `make tests` builds `OpenRA.Test/OpenRA.Test.csproj` and runs `dotnet test bin/OpenRA.Test.dll --test-adapter-path:.`; `Makefile:134-137`. Separate `make test` checks official-mod YAML, and `make check` builds Debug plus trait/style checks; `Makefile:96-137`.

## Activities

### Exact modules

- `OpenRA.Game/Activities/Activity.cs:21,39-225` — core state machine. `ActivityState` is `Queued`, `Active`, `Canceling`, `Done`; `TickOuter` performs first/last-run hooks, child-priority ticking, and advancement to `NextActivity`. `Queue` appends sequential work and `QueueChild` composes nested work. `Cancel` drops the next queue by default, propagates to children, and distinguishes not-yet-started from running activities.
- `OpenRA.Game/Traits/ActivityUtils.cs` — activity runner used by actors and parent activities.
- `OpenRA.Game/Actor.cs:61-81,272-289,351-372,419-423` — actor-owned `CurrentActivity`, idle transitions, immediate-versus-queued insertion, cancellation, and disposal cleanup.
- `OpenRA.Mods.Common/Activities/` — concrete activity library, including `Attack.cs`, `CaptureActor.cs`, `DeliverUnit.cs`, `Enter.cs`, `FindAndDeliverResources.cs`, `HarvestResource.cs`, `Move/`, `Resupply.cs`, `RideTransport.cs`, `Transform.cs`, `Turn.cs`, `UnloadCargo.cs`, and `Wait.cs`; air activities are under `Activities/Air/`.
- `OpenRA.Mods.Common/Activities/Move/Move.cs:31-37,57-140,142-246,249-360` — useful complex example: fallback path searches across blocker classes, child turning/movement activities, repathing, waiting, destination completion states, and local unblocking.

### Tests and gap

- No `Activity`-specific test was found anywhere under `OpenRA.Test` (searched `Activity|Replay|Shroud|Trait|Order`). The activity lifecycle therefore needs new donor-independent tests if its design is reused: first/last hooks, nested priority, cancellation before first tick, queue preservation, and disposal.
- The closest reusable test style is the small NUnit fixture approach in `OpenRA.Test/OpenRA.Game/OrderTest.cs` and trait dependency fixtures in `ActorInfoTest.cs`.

## Orders and deterministic command processing

### Exact modules

- `OpenRA.Game/Network/Order.cs:18-50,52-278,279-495` — order field model, bounded deserialization, actor/target resolution, constructors, and flags-based serialization. Actor IDs and generations, frozen actors, terrain/cell/position targets, grouped/extra actors, queue state, target strings, extra location/data, and handshake orders are represented.
- `OpenRA.Game/Network/OrderIO.cs` — order-packet encoding/parsing used by networking and replay.
- `OpenRA.Game/Network/UnitOrders.cs` — resolves incoming orders against the world and dispatches them to actors/traits.
- `OpenRA.Game/Network/OrderManager.cs:29-73,98-169,177-285,293-332` — per-client pending frame queues, immediate orders, lockstep readiness, disconnect markers, per-frame sync hash/defeat state, desync reporting, and replay pacing.
- `OpenRA.Game/Traits/TraitsInterfaces.cs:123-152` — `IIssueOrder`, `IOrderTargeter`, `IResolveOrder`, and `IValidateOrder` contracts.
- `OpenRA.Mods.Common/Orders/UnitOrderGenerator.cs`, `UnitOrderTargeter.cs`, `OrderGenerator.cs`, `PlaceBuildingOrderGenerator.cs`, `GuardOrderGenerator.cs`, `RepairOrderGenerator.cs` — UI targeting/order-generation layer.
- `OpenRA.Mods.Common/Traits/World/ValidateOrder.cs` — common validation trait.

### Exact tests

- `OpenRA.Test/OpenRA.Game/OrderTest.cs:18-73` — six round-trip serialization cases: empty, unqueued, queued, position target, invalid target, and extra fields. This is the best small OpenRA test to mine for Wayfinder's command-codec cases. It does not exercise actor/world resolution, malformed packets, frame pacing, or sync hashes.

## Traits

### Exact modules

- `OpenRA.Game/Traits/TraitsInterfaces.cs` — lifecycle and capability contracts, including `ITick`, order interfaces, created/added/removed/disposed notifications, occupancy, visibility, and resource storage.
- `OpenRA.Game/TraitDictionary.cs:40-125,137-259` — type/interface-indexed trait registry, actor-sorted storage, single/multiple trait queries, and world-wide trait queries.
- `OpenRA.Game/ActorInfo.cs` — actor trait construction and prerequisite ordering (exercised by the tests below).
- `OpenRA.Mods.Common/Traits/Conditions/ConditionalTrait.cs` and `PausableConditionalTrait.cs` — reusable conditional/pause composition pattern.
- `OpenRA.Mods.Common/TraitsInterfaces.cs` — common-mod trait contracts.

### Exact tests

- `OpenRA.Test/OpenRA.Game/ActorInfoTest.cs:18-120` — mock traits exercise required and optional dependency ordering, missing dependencies, and cyclic required/optional dependencies. These are valuable fixtures for validating a capability/dependency graph without booting a game world.
- `make check` additionally invokes `--check-explicit-interfaces` and `--check-conditional-trait-interface-overrides`; `Makefile:96-109`. These are static/mod checks, not NUnit tests.

## Replay

### Exact modules

- `OpenRA.Game/Network/ReplayRecorder.cs:19-117` — buffers pre-start packets until `StartGame`, writes client ID + packet length + packet bytes, chooses collision-free `.orarep` filenames, and appends metadata on disposal.
- `OpenRA.Game/Network/ReplayConnection.cs:19-135` — implements the normal `IConnection` boundary over a replay. It parses packet chunks, reconstructs lobby metadata/start validity, suppresses local sends, and feeds immediate/regular orders, disconnects, and sync packets into `OrderManager` using replay order latency.
- `OpenRA.Game/FileFormats/ReplayMetadata.cs:18-107` — versioned metadata trailer with start/end markers, length-prefixed UTF-8 serialized `GameInformation`, and backward seeking from file end.
- `OpenRA.Mods.Common/Widgets/Logic/ReplayBrowserLogic.cs`, `ReplayUtils.cs`, `Ingame/ReplayControlBarLogic.cs` — browser/playback UI; `UtilityCommands/ReplayMetadataCommand.cs` — metadata utility.

### Test gap

No replay recorder/connection/metadata fixture or sample-replay round-trip test was found in `OpenRA.Test`. Reusing this design should be accompanied by packet-chunk, pre-start buffering, metadata truncation/version, unknown packet, and sync/desync tests.

## Shroud and fog

### Exact modules

- `OpenRA.Game/Traits/Player/Shroud.cs:72-243,245-394,396-514` — player shroud state. It tracks keyed visibility/passive-visibility/generated-shroud sources, per-cell source counts, exploration, dirty/touched cells, resolved hidden/fog/visible state, change notifications, and sync hash participation. `ProjectedCellsInRange` handles projected geometry/range/height limits.
- `OpenRA.Mods.Common/Traits/AffectsShroud.cs:18-173` — shared conditional trait that recomputes footprint/center/ground visibility on movement, range, and enabled-state changes and adds/removes sources for every player.
- `OpenRA.Mods.Common/Traits/RevealsShroud.cs:18-71` and `CreatesShroud.cs:18-65` — relationship-filtered reveal/generation and range modifiers.
- `OpenRA.Mods.Common/ShroudExts.cs`, `Effects/RevealShroudEffect.cs`, `Traits/Multipliers/RevealsShroudMultiplier.cs`, `CreatesShroudMultiplier.cs` — query helpers, temporary reveal effect, and modifiers.
- `OpenRA.Mods.Common/Traits/Modifiers/HiddenUnderShroud.cs:19-71` — actor visibility by relationship and footprint/center exploration.
- `OpenRA.Mods.Common/Traits/World/ShroudRenderer.cs:24-391` — rendering-only dirty-cell cache, neighbor-edge sprite selection, palettes, and render-player switching; `OpenRA.Mods.Cnc/Traits/World/ShroudPalette.cs` and `TSShroudPalette.cs` provide mod palettes.

### Test gap and reuse boundary

No shroud unit test was found in `OpenRA.Test`. The most reusable logic is the simulation-side source counting and dirty resolution in `Shroud.cs`, deliberately separate from `ShroudRenderer`. Tests should cover overlapping source add/remove, generated shroud versus passive visibility, fog on/off, exploration reset/share, out-of-bounds cells, and change events.

## OpenRA execution record

Command run from `scratch/donor-audit/rts/openra/source`:

```sh
make tests
```

Observed result (exit 2):

```text
/bin/sh: dotnet: command not found
make: dotnet: No such file or directory
make: *** [tests] Error 1
```

`dotnet --info` likewise returned `dotnet: command not found`. **Blocker:** the required .NET 10 SDK is absent. No global/local SDK bootstrap was attempted, so no NUnit tests, YAML checks, or build ran. Source and test inventory was performed instead.

---

# Widelands

Pinned source: `scratch/donor-audit/rts/widelands/source` at `bfc7713d5f5659bb6393a78205c408c081d4b027` (`master`).

## Build system and toolchain

- **Build:** CMake (`cmake_minimum_required 3.15...3.31`) with optional Make/Ninja generators and `compile.sh` convenience wrapper; `CMakeLists.txt:1-17`, `README.md:52-103`. Tests and website tools default on; this audit disabled website/codecheck only.
- **Language:** C++17 (`CMakeLists.txt:285,298,380`), with GCC >= 8 or Clang >= 7 checks (`CMakeLists.txt:75-89`; `README.md:22-25`). Python 3 is required by configure (`CMakeLists.txt:119`).
- **Required packages at configure:** OpenGL, PNG, SDL2, SDL2_image, SDL2_mixer, SDL2_ttf, ZLIB, ICU, GLEW or glbinding, and standalone Asio; `CMakeLists.txt:119-146`. `README.md:27-42` also lists gettext/iconv.
- **Relevant targets:** `src/economy/CMakeLists.txt:1-79` defines the `economy` library and adds its tests. `src/economy/test/CMakeLists.txt:1-14` defines `test_economy` from `economy_test_main.cc`, `test_road.cc`, and `test_routing.cc`.
- **Regression runner:** `regression_test.py` discovers saved-game, scenario-map, template, and editor tests (`regression_test.py:516-591`) and supports `--regexp`, `--binary`, worker count, and timeout. It requires a built `widelands` executable (`regression_test.py:494-501`).

## Economy and request/supply model

### Exact modules

- `src/economy/economy.cc` / `economy.h` — separate ware/worker economies, flags/warehouses/requests/supplies, target quantities, merge/split, request balancing, and routing facade. `check_merge` preserves the larger economy (`economy.cc:121-136`); deferred split checks use A* reachability (`142-213`); closest warehouse uses zero-heuristic A* (Dijkstra) (`235-277`).
- `src/economy/request.cc` / `request.h` — versioned request persistence, active transfers, requirements, due times, cancellation, and destination priorities. `get_priority` combines building priority, waiting/due time, and capped route cost (`request.cc:279-323`).
- `src/economy/transfer.cc` / `transfer.h` — connects a ware/worker to a request and destination; recomputes the next route step, handles economy splits, buildings and port docks, and restores destination references on load (`transfer.cc:41-99,118-230,232-328`). Routes themselves are deliberately recalculated after load (`324-328`).
- `src/economy/flag.cc`, `roadbase.cc`, `road.cc`, `route.cc`, `ware_instance.cc`, `supply_list.cc`, `idleworkersupply.cc`, `warehousesupply.h`, `ware_priority.cc` — graph nodes/edges, route storage, moved items, supply matching, and priority support.
- `src/economy/wares_queue.cc`, `workers_queue.cc`, `input_queue.cc`, `soldier_request.cc` — building input and specialized request queues.
- `src/economy/portdock.cc`, `ship_fleet.cc`, `ferry_fleet.cc`, `shipping_schedule.cc`, `shippingitem.cc`, `waterway.cc`, `expedition_bootstrap.cc` — naval/ferry extensions of the same economy model.

## Routing

### Exact modules

- `src/economy/router.h` / `router.cc:31-137` — cycle allocation/reset, single-source route search with optional cost cutoff, and multi-source nearest-route search.
- `src/economy/routeastar.h:30-197` / `routeastar.cc:29-68` — estimator-parameterized A*, separate ware/worker node state, open-queue decrease-key, backlink route reconstruction, and zero-estimator Dijkstra mode. The header explicitly warns that concurrent `RouteAStar` instances are unsupported (`routeastar.h:66-71`).
- `src/economy/routing_node.h`, `iroute.h`, `itransport_cost_calculator.h` — narrow extension seams for graph nodes, route output, and heuristic cost.
- `src/logic/cookie_priority_queue.h` — priority queue/cookie support used by node routing state.

### Exact unit tests — strongest reusable suite

`src/economy/test/test_routing.cc` contains 18 cases in the `Routing` suite:

- Fixture/helper validation: `testingnode_creation`, `testingnode_neighbour_attaching`, `testingnode_illegalneighbour_access`, `RoutingNode_InitializeMemberVariables` (`174-228`).
- Fake route behavior: empty, add node, membership, directional chains, partial/subchain behavior, initialization (`267-366`).
- Router behavior: disconnected failure, connected success, triangle construction, long route then direct shortcut, priced ware-versus-worker routing, and cost cutoff (`376-390,507-614`). `priced_routing` proves worker cost is unchanged by node wait cost while ware routing chooses the longer cheaper path (`570-604`).

`src/economy/test/test_road.cc:38-87` adds a real `EditorGameBase`/map/flag fixture with `passability` and `correct_size` cases. The custom test framework is `src/base/test.h`; test entry point is `src/economy/test/economy_test_main.cc`.

## Carriers

### Exact modules

- `src/logic/map_objects/tribes/carrier.h` / `carrier.cc` — carrier behavior and persistence. Key logic covers building delivery (`carrier.cc:41-75`), flag pickup and road payment (`83-107`), drop/swap (`115-154`), full-flag exchange/wait (`180-207`), pickup acknowledgment (`214-294`), closest-flag walking cost (`296-363`), and versioned promised-pickup save state (`373-433`).
- `src/logic/map_objects/tribes/worker_tasks/carrier_transport.cc:26-101` — transport task state machine and interruptions, direct building delivery, road deletion, full-flag swap/wait, and drop.
- `src/logic/map_objects/tribes/worker_tasks/carrier_road.cc` — road-idle task and wakeup into transport.
- `src/logic/map_objects/tribes/worker_tasks/transfer.cc` — generic worker transfer task.
- `src/economy/ware_instance.cc` and `flag.cc` — ware movement, pending queues, capacity, and pickup acknowledgment backing the carrier logic.

### Tests and gap

No carrier-specific C++ `TESTCASE` was found. The best behavior-level coverage is the scripted transport suite under `test/maps/ship_transportation.wmf/scripting/`, especially:

- `test_rip_ports_with_ware_in_transit.lua:1-57` — destroys both ports around an in-transit ware, asserts stock/economy invariants, saves via `stable_save`, recreates a port, and waits for recovery.
- `test_rip_ports_with_worker_in_transit.lua`, `test_rip_portdock_with_worker_and_ware_in_transit.lua`, `test_rip_ship_while_transporting_ware.lua`, `test_rip_ship_before_picking_up_transporting_ware.lua`, `test_create_request_while_worker_with_ware_is_in_transit.lua` — destruction/race variants.
- `test_rip_first_port_with_ware_in_portdock.lua`, `test_rip_second_port_with_worker_in_portdock.lua`, `test_many_ships.lua` — dock and multi-ship variants.

These are naval transport tests rather than direct road-carrier unit tests; they are reusable scenario patterns, not evidence that every carrier branch is covered.

## Save/load

### Exact modules

- `src/logic/generic_save_handler.cc:32-205` — backup existing saves, write through a filesystem callback, remove failed remnants, restore backups on failure, and aggregate structured errors. Object and Lua mutexes are held during save (`126-130`).
- `src/logic/save_handler.cc:37-273` — rolling autosaves, inactivity/pause rules, requested saves, file naming, ZIP/directory choice, and delegation to `GameSaver` through `GenericSaveHandler`.
- `src/game_io/game_saver.cc:38-116` and `game_loader.cc:43-197` — top-level save/load packet ordering: preload, class, player info, map/map objects, economies, trades, AI state, command queue, interactive player; loading also handles required add-ons and object/message relinking.
- `src/game_io/game_player_economies_packet.cc`, `game_cmd_queue_packet.cc`, `game_map_packet.cc`, `game_preload_packet.cc` — relevant top-level packets.
- `src/economy/economy_data_packet.cc:29-162` — packet version 5, economy serial sanity check, target quantities, last-modified times, request timer ID.
- Versioned entity state: `src/economy/request.cc:94-228` (version 6), `src/economy/transfer.cc:303-328` (version 1), and `src/logic/map_objects/tribes/carrier.cc:380-433` (version 3).
- `src/scripting/persistence.cc:151-297` — Eris-based Lua object persistence/unpersistence, map-object saver/loader registry hooks, and append-only persistent-global compatibility list.

### Exact scripted tests

- `test/maps/lua_persistence.wmf/scripting/test_persistence.lua:1-170` — save/reload assertions for primitive globals, nested tables/functions, coroutines and yields, map fields/immovables, descriptions, objectives/messages, player slots, sets, and UI state. This is the best broad persistence regression donor.
- `test/scripting/stable_save.lua:1-51` — waits for observable save completion and verifies build identity after reload; `wait_save_and_quit.lua` and `load_and_quit.lua` provide save/load runner scripts.
- `test/maps/plain.wmf/scripting/test_inputqueues.lua`, `test_warehouse_garrison.lua`, `test_notifications.lua`, `test_tribes_postloading_works.lua`; `test/maps/all_tribes.wmf/scripting/test_{barbarians,empire,atlanteans,amazons,frisians}.lua`; expedition, seafaring, trade, and ship-transport scripts listed by the `stable_save` search — domain-specific save/reload scenario coverage.
- `regression_test.py:516-534` also discovers fixtures in `test/save/` and generic `.wgf` load tests.

## Replay

### Exact modules

- `src/logic/replay.h` / `replay.cc:52-306` — replay packet version 4 and magic; reader extracts and loads an embedded initial save, restores RNG state, then deserializes timestamped player commands and MD5 sync reports. Writer creates the initial save, embeds its bytes, reloads from it, schedules sync writes, stores RNG state, streams player commands, and writes an end packet (`61-108,124-175,191-268`). `ReplayfileSavegameExtractor` exposes the embedded save (`270-305`).
- `src/logic/replay_game_controller.cc:31-108` — paced command enqueueing, replay end, speed/pause, and rejection of new player commands.
- `src/commands/cmd_replay_sync_read.cc`, `cmd_replay_sync_write.cc`, `cmd_replay_end.cc` — queue commands for sync verification and termination.
- `src/logic/save_handler.cc:122-125` — ordinary saving is disabled during replay.

### Test gap

Searches under `test/` found RNG comments related to replay but no dedicated replay round-trip fixture. No replay-specific C++ `TESTCASE` exists in the inspected `src/**/test` inventory. Treat replay record/load/sync behavior as needing new tests: corrupt magic/version/length, initial-save/RNG restoration, due-time ordering, sync mismatch, end handling, and command rejection during playback.

## Lua campaigns and scripting

### Exact runtime modules

- `src/scripting/lua_interface.cc`, `run_script.cc`, `logic.cc` — Lua state/script execution; `logic.cc:56-63,282-283` resolves `map:` scripts from the map filesystem versus global data scripts.
- `src/scripting/persistence.cc` and bundled `src/scripting/eris*` — persisted Lua state.
- `src/scripting/lua_root.cc`, `lua_game.cc`, `lua_map.cc`, `lua_bases.cc` — game/map/player bindings, scenario difficulty, objectives, and campaign completion.
- `src/scripting/lua_bases.cc:382-580` — recursive campaign-data save/read supporting strings, integers, booleans, arrays/tables, with type/nil/key validation.
- `data/scripting/coroutine.lua`, `infrastructure.lua`, `messages.lua`, `objective_utils.lua` — reusable scenario coroutine, building-check, message, and objective helpers.

### Exact campaign structure and examples

- `data/campaigns/campaigns.lua` and `tutorials.lua` — campaign/scenario declarations.
- Each scenario lives in `data/campaigns/<scenario>.wmf/scripting/`; representative modules are `init.lua`, `starting_conditions.lua`, `mission_thread.lua`, `texts.lua`, and `helper_functions.lua`.
- `data/campaigns/tutorial04_economy.wmf/scripting/init.lua:1-35` — concrete economy campaign wiring: common helper includes, players/map/UI setup, then map-local helpers/text/start/mission thread.
- `data/campaigns/tutorial04_economy.wmf/scripting/mission_thread.lua` — economy-specific objective progression.
- `data/campaigns/emp03.wmf/scripting/mission_thread.lua:1-379` — more complex concurrent objective threads using `run`, polling `sleep`, production/building/port checks, and victory sequencing.

### Exact campaign tests

- `test/maps/plain.wmf/scripting/test_campaign_data.lua:1-77` — writes and reads nested campaign data, asserting strings, positive/negative numbers, booleans, arrays, and nested tables.
- `test/maps/lua_persistence.wmf/scripting/test_persistence.lua` — scenario-state persistence, including coroutine/objective state.
- `test/maps/lua_testsuite.wmf/scripting/` — broader Lua API suite, including `road.lua`, `path.lua`, `objectives.lua`, `productionsite.lua`, `warehouse.lua`, and `run_testsuite.lua`.

No standalone Lua syntax pass was run because neither `lua` nor `luac` is installed; all campaign/regression execution requires the unavailable built game executable.

## Widelands execution record

Configure command run from `scratch/donor-audit/rts/widelands`:

```sh
cmake -S source -B build \
  -DOPTION_BUILD_TESTS=ON \
  -DOPTION_BUILD_WEBSITE_TOOLS=OFF \
  -DOPTION_BUILD_CODECHECK=OFF \
  -DCMAKE_BUILD_TYPE=Release
```

Observed toolchain and dependency results:

- CMake 4.4.3; AppleClang 16.0.0 (`arm64-apple-darwin23.6.0`); Ninja 1.13.2; Python 3.12.15.
- Configure found OpenGL, ZLIB 1.2.12, PNG 1.6.58, and SDL2 2.32.72.
- Configure exited 1 at `CMakeLists.txt:125`:

```text
Could NOT find SDL2_image (missing: SDL2_IMAGE_LIBRARIES SDL2_IMAGE_INCLUDE_DIRS)
```

**Blocker:** missing SDL2_image development library/headers is the first hard configure failure. Because generation was incomplete, `test_economy` was not generated and no build or C++ test command was meaningful. Later required packages were not proven present or absent; only the checks reached before this failure are claimed above.

The regression runner itself was inspected successfully:

```sh
python3 regression_test.py --help
```

It reported options for regexp selection, explicit binary, parallel workers, and timeout. It was not used to run tests because configure produced no game binary. No dependency installer was run and no global installation or asset download was attempted.

---

# Recommended modules/tests to mine first

| Priority | Donor paths | What to reuse as a design/test reference | Main adaptation caveat |
|---|---|---|---|
| 1 | Widelands `src/economy/{router,routeastar,routing_node,iroute,itransport_cost_calculator}.*`; `src/economy/test/test_routing.cc` | Estimator-injected A*, separate cost domains, route backlinks, fake-node fixtures, priced/cutoff tests | Per-node cycle/cookie state is non-concurrent and coupled to Widelands geometry/queue types |
| 2 | OpenRA `OpenRA.Game/Activities/Activity.cs`, `Actor.cs`; `OpenRA.Mods.Common/Activities/Move/Move.cs` | Explicit activity lifecycle, sequential/child composition, cancellation and cleanup, complex movement example | No direct unit tests; actor/world/trait coupling is substantial |
| 3 | OpenRA `OpenRA.Game/Network/{Order,OrderIO,OrderManager,ReplayRecorder,ReplayConnection}.cs`; `OpenRA.Test/OpenRA.Game/OrderTest.cs` | Command codec boundary, deterministic frame queues, sync hashes, replay as an `IConnection` | Replay/shroud/frame behavior lacks direct tests; protocol depends on OpenRA world actor IDs/targets |
| 4 | Widelands `src/logic/{generic_save_handler,save_handler,replay,replay_game_controller}.cc`; `src/game_io/`; versioned economy/request/transfer/carrier packets | Transactional backup/restore, packet versioning, embedded-save + RNG + command replay | Full game/filesystem/object-loader coupling; replay round-trip tests must be added |
| 5 | Widelands `test/maps/lua_persistence.wmf/scripting/test_persistence.lua`; `test/scripting/stable_save.lua`; `src/scripting/persistence.cc` | Comprehensive save/reload assertions and coroutine-safe save helper | Requires game runtime and Widelands Lua/Eris object model |
| 6 | OpenRA `OpenRA.Game/Traits/Player/Shroud.cs`; `OpenRA.Mods.Common/Traits/{AffectsShroud,RevealsShroud,CreatesShroud}.cs` | Source-counted overlapping visibility, exploration/fog resolution, dirty-cell notification | Geometry is projected-cell specific; add overlap/lifecycle tests before adaptation |
| 7 | Widelands `src/logic/map_objects/tribes/carrier.cc`; `worker_tasks/carrier_{road,transport}.cc`; `test/maps/ship_transportation.wmf/scripting/` | Pickup acknowledgment, full-flag swap/wait, closest-end selection, destruction/save scenarios | No direct road-carrier unit suite; naval scenarios are indirect coverage |
| 8 | OpenRA `OpenRA.Test/OpenRA.Game/ActorInfoTest.cs`; Widelands `data/campaigns/*`, `test/maps/plain.wmf/scripting/test_campaign_data.lua` | Trait dependency graph fixtures; campaign coroutine/objective structure and typed cross-scenario data | Different problems, but each offers compact reusable test patterns |

## Explicit failures/skips

- **OpenRA build/tests:** attempted `make tests`; blocked before build by missing `dotnet` (.NET 10 required).
- **Widelands configure:** attempted minimal test-enabled Release configure; blocked by missing SDL2_image development files. No target build followed because generation was incomplete.
- **Widelands C++ `test_economy`:** skipped as ungenerated, not failed.
- **Widelands Lua/scenario/save/campaign regressions:** inspected and inventoried but not run; no built `widelands` binary and no standalone Lua interpreter.
- **OpenRA activity/replay/shroud tests:** none found in `OpenRA.Test`; this is a coverage gap, not an execution failure.
- **Widelands dedicated carrier/replay tests:** none found in the C++ test inventory or scripted replay search; transport/persistence scenarios provide adjacent, not complete, coverage.
- **Production/integration:** intentionally not performed. All artifacts are confined to `scratch/donor-audit/rts/` and this report.

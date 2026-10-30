# City donor audit: Augustus and DFHack

- **Ticket:** Wayfinder / `jamesm944/game#161` (city donor subset)
- **Audit time:** 2026-10-25T17:06:02Z
- **Scope:** private local-use research only. Licences are provenance, not selection filters. No production code changed and no donor code integrated. No proprietary game assets downloaded or used.
- **Workspace:** `/Users/jamesmoss/Documents/game/scratch/donor-audit/city/`
- **Citation convention:** `A:<path>:<lines>` means a path relative to `city/augustus/` at the full Augustus commit below; `D:<path>:<lines>` is relative to `city/dfhack/` at the full DFHack commit below. Command logs are under `city/logs/`.

## 1. Pinned source manifest

| Donor | Upstream | Default branch | Full HEAD commit | Local clone | Clone provenance |
|---|---|---|---|---|---|
| Augustus | `https://github.com/Keriew/augustus.git` | `master` | `dae1899ef6abca7a19b73a99f65f6aa680a78173` | `city/augustus/` | `git clone --depth 1 --no-tags`; HEAD subject `update korean.c (#1967)`, committer time `2026-10-24T12:47:59+02:00` |
| DFHack | `https://github.com/DFHack/dfhack.git` | `develop` | `438faf3b87ff3a308c0a8501e91228a10cdaeec4` | `city/dfhack/` | `git clone --depth 1 --no-tags --no-recurse-submodules`; HEAD subject `Auto-update submodules`, committer time `2026-10-20T12:34:38+00:00` |

`git ls-remote --symref <url> HEAD` independently returned the same branch and full hash for each donor. Both donor worktrees had no tracked modifications after configuration attempts. DFHack submodules were deliberately **not initialized**: compatible GCC was already a hard blocker, so downloading the required native dependency graph would not make a build feasible. In particular, the large unrelated `plugins/stonesense` and `scripts` submodules were not fetched.

DFHack's declared dependency pins at this commit, still uninitialized, are: `depends/clsocket` `00c3267aacc9c10c5864c7fce856df0de52d72a8`, `depends/dfhooks` `5a904e30a8bace81c662b44ec7ff076b92edafd1`, `depends/googletest` `b514bdc898e2951020cbdca1304b75f5950d1f59`, `depends/jsoncpp-sub` `3a5d4ff0583ce7dd5abbf92bdf49dca2177459ef`, `depends/libexpat` `e3ea4469079702ddf352bb3333bf85130c5346c2`, `depends/libzip` `011e45e125631cff73c0d6a5d19e0232dfc4df6f`, `depends/luacov` `e09ee3fa2e3366d148f94c6a5969c9896126e83a`, `depends/xlsxio` `e3ed11f6b40bf68b48afc8fc3131ea2b4a22d5b1`, `library/xml` `d8ff8a6326db37c11dc4173fadcf30b56e51b42d`, `plugins/stonesense` `42e04ca70e2e08c1fc1cef88837a7b7a38935490`, and `scripts` `4c4f5bf510e22fb96857328638e93ded3f608d0e`. Their URLs are declared in `D:.gitmodules:1-33`; required-submodule checks are in `D:CMakeLists.txt:216-229`.

## 2. Licence provenance verified from files

- **Augustus: GNU Affero General Public License v3.** `LICENSE.txt` begins `GNU AFFERO GENERAL PUBLIC LICENSE` and `Version 3, 19 November 2007`; this is the actual complete 661-line licence file, not repository metadata. `A:LICENSE.txt:1-18`. Bundled components/assets have their own files, notably `res/assets/LICENSE` and `ext/spng/LICENSE`; this audit did not harvest assets.
- **DFHack core/plugins/scripts: Zlib unless noted otherwise; some MIT/BSD components.** `LICENSE.rst` explicitly says the core, plugins, scripts, and other DFHack code use Zlib, reproduces the Zlib terms, and lists third-party components and notices. `D:LICENSE.rst:7-42`, `D:LICENSE.rst:66-88`, `D:LICENSE.rst:90-160`. This covers the audited `plugins/workflow.cpp` and `plugins/orders.cpp` absent a contrary file-level notice. Graphic assets derived from vanilla DF are separately identified at `D:LICENSE.rst:15-16`; none were used.

## 3. Augustus source and entry-point inventory

### 3.1 Shared scheduling and state dependencies

The main simulation sequencing is explicit in `src/game/tick.c`: monthly finance and requests (`advance_month`), sentiment twice per 16-day month, and 50 tick slots for housing, service, figure, migration and monument-related systems. Key calls are finance at month change, scenario requests immediately afterward, sentiment on days 0/8, migration at tick 23, figure generation at 31, culture decay/aggregation at 35/36, house evolution at 39, and tax coverage decay at 48. `A:src/game/tick.c:70-137`, `A:src/game/tick.c:150-201`.

These modules are coupled to global `city_data`, intrusive building-type linked lists, map grids, building/figure IDs, scenario state and the game random API. Reuse should therefore be a port/adapt behind local commands and stable iteration, not direct compilation into the current ECS. The data definitions are valuable independently of those host dependencies.

### 3.2 Housing and population

| Exact modules | What is implemented | Reusable seam / caveat |
|---|---|---|
| `src/building/properties.c`, `properties.h` | Twenty `house_model_data` rows cover vacant lot/small tent through luxury palace: evolution/devolution desirability, water, religion, education, barber, bathhouse, health, food variety, four goods, prosperity, capacity and tax multiplier. `model_reset_houses` copies definitions into scenario-editable model state. `A:src/building/properties.c:138-637`, `A:src/building/properties.c:2362-2429`, `A:src/building/properties.h:70-115` | **Highest-value housing donor:** convert rows to validated local content definitions; preserve scenario override as data, not a second mutable global model. |
| `src/building/house_evolution.c` | `has_required_goods_and_services` gates water, entertainment, education, religion, health, food and goods; `check_requirements` combines desirability and Pantheon bonus; per-tier callbacks evolve/devolve/merge; devolution delay and periodic resource consumption are explicit. `A:src/building/house_evolution.c:31-217`, `A:src/building/house_evolution.c:564-607` | Port requirement evaluation and transition tables separately from building/map mutation. Add boundary tests at every requirement and desirability threshold. |
| `src/building/house_service.c` | Culture/tax coverage decay and per-house aggregation of entertainment, education, religion and health. `A:src/building/house_service.c:7-181` | Small, understandable decay/aggregation reference. Replace direct building writes with household coverage events. |
| `src/building/house_population.c` | Capacity including merged houses and monument bonus, room calculation, round-robin aggregate add/remove, immigrant/emigrant creation, labour class totals and overcrowding eviction. `A:src/building/house_population.c:13-95`, `A:src/building/house_population.c:97-248` | Useful invariants and capacity cases, but aggregate people must not replace local Household/Pop identity. |
| `src/building/house.c`, `src/city/houses.c`, `src/city/houses.h` | House merge/type helpers and shared demand explanations (`house_demands`). `A:src/building/house_evolution.c:54-206`, `A:src/city/houses.h:36-40` | Demand/cause structures are useful for player-facing explanations. |

### 3.3 Figures and physical services

| Exact modules | What is implemented | Reusable seam / caveat |
|---|---|---|
| `src/building/figure.c` | Central `building_figure_generate` scans in-use buildings and dispatches per-type spawners; service, supplier, labour, market, temple, tax and monument builders are among 2,359 lines of spawn logic. `A:src/building/figure.c:52-150`, `A:src/building/figure.c:2151-2359` | Adapt spawn preconditions/cooldowns, not the monolithic global dispatcher. |
| `src/figure/service.c` | Walkers service houses in a 2-tile radius; coverage is set to 96, tax coverage to 50; risk reset, goods transfer, sickness, religion, education, entertainment and tourism callbacks. `A:src/figure/service.c:18-193`, `A:src/figure/service.c:275-327`, `A:src/figure/service.c:329-450` | **High-value service coverage model.** Turn callbacks into deterministic coverage events; test radius edges, duplicate visits, decay and no-population houses. |
| `src/figuretype/service.c`, `src/figure/action.c`, `src/figure/movement.c`, `src/figure/route.c`, `src/map/routing.c`, `src/map/routing_path.c`, `src/map/road_access.c` | Routed figure state/action and destination/movement dependencies; these are the next layer below service callbacks. `A:CMakeLists.txt:420-461`, `A:CMakeLists.txt:500-530` | Requires route-tie determinism investigation before reuse. No existing tests validate it. |
| `src/city/figures.c` | Aggregate security/enemy/protester counters and `city_figures_total_invading_enemies`, used by migration. `A:src/city/figures.c:5-136`, `A:src/city/migration.c:37-41` | Small metrics adapter, not a service-walker implementation. |

### 3.4 Finance, tax and sentiment

- **Finance/tax:** `src/city/finance.c` estimates and collects monthly taxes by house population, tax coverage and per-tier multiplier; splits plebeian/patrician ledgers; applies tax percentage after integer division; pays wages, debt interest, salary and building/highway levies in `city_finance_handle_month_change`. Annual tribute is loss/profit and population dependent. The module also contains trade ledgers, tourism and save/load code. `A:src/city/finance.c:207-268`, `A:src/city/finance.c:270-436`, `A:src/city/finance.c:438-566`, `A:src/city/finance.c:653-1011`.
- **Sentiment:** `src/city/sentiment.c` computes tax, wage and unemployment modifiers, a population-weighted housing average, and per-house squalor/desirability/entertainment/food/games/festival contributions. Happiness changes are capped per update; population weights the city aggregate. Worst-cause selection feeds explanations and migration. `A:src/city/sentiment.c:168-265`, `A:src/city/sentiment.c:267-455`.
- **Reuse:** port cause calculations as inspectable household/personal ledgers, but do not import anonymous city morale or double-tax local Pop income. Preserve integer rounding in differential fixtures so changed rounding is deliberate.

### 3.5 Migration

`src/city/migration.c` maps sentiment bands to migration percentages (100/75/50/0/-10/-25/-50), blocks immigration at scenario caps or during substantial invasion, calculates batches of 12 with modifiers, queues sub-four-person remainders, and translates low-mood causes to no-immigration explanations. `A:src/city/migration.c:11-64`, `A:src/city/migration.c:66-186`. `src/building/house_population.c` supplies physical figure creation and capacity; `src/figuretype/migrant.c` is the routed lifecycle dependency. `A:src/building/house_population.c:97-170`. Highest-value reuse is the threshold/queue/cause model with tests for every sentiment boundary, war/cap suppression and no-room behavior.

### 3.6 Requests, emperor/favour and monuments

- **Requests:** `src/city/request.c` is only the presentation/availability adapter for troop and scenario requests. The actual lifecycle is `src/scenario/request.c`: randomized visibility/amount, normal → dispatched/dispatched-late → received, normal → overdue → ignored, reminders, full/half favour, repeating requests, resource dispatch and save/load. `A:src/city/request.c:8-61`, `A:src/scenario/request.c:26-207`, `A:src/scenario/request.c:209-400`. **This is a top reusable state machine.** Replace `random_between_from_stdlib`, message posts and direct treasury/warehouse mutation with seeded streams and local commands.
- **Emperor/favour:** `src/city/emperor.c` implements rank/salary/gifts/personal savings, escalating debt bailout/penalty states and invasion pressure; `src/city/ratings.c` owns bounded favour, missed-request penalties and explanations. `A:src/city/emperor.c:15-179`, `A:src/city/emperor.c:181-436`, `A:src/city/ratings.c:120-122`, `A:src/city/ratings.c:249-263`, `A:src/city/ratings.c:551-656`. Adapt only the desired pressure mechanics to the locked local favour/suzerainty model, not the full victory system.
- **Monuments:** `src/building/monument.c` has declarative per-type phase/resource matrices, phase transitions, resource need/progress queries, grand-temple modules, and a persistent delivery ledger keyed by monument/worker/resource/loads. `A:src/building/monument.c:20-201`, `A:src/building/monument.c:235-313`, `A:src/building/monument.c:464-630`, `A:src/building/monument.c:630-742`, `A:src/building/monument.c:864-919`. **The phase matrices plus in-flight delivery accounting are high-value wonder/logistics references.** Test duplicate delivery prevention, cancellation, partial delivery, phase completion and save/load.

## 4. Augustus test inventory

There are **no checked-in unit/integration test sources or test directory, no `enable_testing()`/`add_test()` registrations, and no dedicated test target** in this revision. The CMake source list builds one game executable. `A:CMakeLists.txt:827-854`, `A:CMakeLists.txt:900-911`. A tracked-file/name inventory and CMake/workflow search found no test suite. The CI step named `Build and test` actually runs asset packing, CMake and build scripts only. `A:.github/workflows/main.yml:127-146`.

Accordingly, there are no existing Augustus tests to reuse. The reusable-test inventory below is **derived from source behavior, not claimed as upstream coverage**:

1. Housing table validation plus every tier's exact upgrade/downgrade threshold, each missing requirement, devolution delay, merged-house capacity and periodic consumption.
2. Walker radius/coverage/decay matrices, no-population exclusion, repeated service idempotence, tax coverage expiry and service aggregation.
3. Monthly tax/finance golden ledgers: covered/uncovered, plebeian/patrician, integer rounding, zero/negative treasury, annual rollover and tribute branches.
4. Sentiment band and worst-cause fixtures; migration cap/war/no-room/remainder-queue cases and conservation of people.
5. Request transition tables including on-time/late/ignored/repeat/dispatch, favour bounds and mid-request save/load.
6. Monument phase/resource matrices, partial and duplicate deliveries, worker/building cancellation, progress and save/load.

## 5. DFHack workflow/orders source and test inventory

### 5.1 Workflow: useful reference, currently disabled

The roadmap's `plugins/workflow` is not a directory at this HEAD. The implementation is one file, **`plugins/workflow.cpp` (1,836 lines)**. Its CMake declaration is commented out: `#dfhack_plugin(workflow workflow.cpp LINK_LIBRARIES lua)`. `D:plugins/CMakeLists.txt:135-140`. Its only test file, `test/plugins/workflow.lua`, is ten lines and entirely commented out, explicitly saying `comment out until workflow has been re-added to the build`; there are **zero active Workflow tests**. `D:test/plugins/workflow.lua:1-10`.

Still-reusable mechanisms:

- `ItemConstraint::goalCount`, `goalGap`, count-vs-stack selection and `computeRequest` implement hysteresis: resume at `stock <= goal - gap`, suspend at `stock >= goal`. `D:plugins/workflow.cpp:241-307`.
- `ProtectedJob` clones/tracks jobs, handles suspend/resume delay and recovery; persistent constraints and stock history are maintained across map lifecycle. `D:plugins/workflow.cpp:110-228`, `D:plugins/workflow.cpp:309-338`, `D:plugins/workflow.cpp:432-472`.
- `map_job_items` filters dumped/forbidden/rotten/trader/construction/artifact items, applies item/material/local/quality constraints, separates available and in-use stock, and excludes owned, stockpiled, routed, job-busy and squad-equipment items. `D:plugins/workflow.cpp:1038-1171`.
- Multiple constraints resolve by maximum resume/suspend weight; announcements and low-stock detection surround state changes. `D:plugins/workflow.cpp:1179-1296`.
- `plugin_onupdate` checks lost jobs every five frames and constraints each in-game half-day. `D:plugins/workflow.cpp:587-635`.

**Adaptation priority:** port the pure range/hysteresis semantics and filter categories into Workplace bills, then create tests before any job-recovery logic. Do not treat the DF-specific `PersistentDataItem`, raw item flags, global world lists or native Job APIs as portable. The disabled build/test status substantially lowers confidence in the whole 1,836-line file.

### 5.2 Orders: active plugin with a real runtime suite

The implementation is **`plugins/orders.cpp` (1,066 lines)**, built with `jsoncpp_static` and Lua. `D:plugins/CMakeLists.txt:103-108`. It provides `list`, `export`, `import`, `clear`, `sort`, `recheck`, and `recheck this` commands, restricted to a loaded fortress except `list`. `D:plugins/orders.cpp:44-142`.

Reusable code:

- Safe filename allow-list and deterministic sorted library/config listing. `D:plugins/orders.cpp:144-214`.
- JSON manager-order export/import including ID remapping, enum/material/item definitions, frequency, workshop links and item/order conditions. `D:plugins/orders.cpp:315-525`, `D:plugins/orders.cpp:525-919`.
- Import syntax/type failures, stable sorting by workshop/frequency, and condition invalidation/recheck. `D:plugins/orders.cpp:922-1066`.
- Six data-driven order libraries: `data/orders/basic.json`, `furnace.json`, `glassstock.json`, `military.json`, `rockstock.json`, `smelting.json`.

**Existing reusable tests:** `test/plugins/orders.lua` (268 lines) runs in fortress mode and wraps every test by exporting/clearing/restoring live manager orders. It covers empty input, non-array and malformed JSON, missing fields, invalid ID types, invalid-before-valid atomicity expectations, reaction-condition round trips, unknown reaction/reagent behavior, and list output. `D:test/plugins/orders.lua:1-80`, `D:test/plugins/orders.lua:82-168`, `D:test/plugins/orders.lua:170-268`. These are the **highest-value existing donor tests** for a local order-schema/adapter suite. Replace DF command/global calls with local bill repositories while retaining fixtures and assertions. Note that one valid-then-invalid case is commented out, so full transaction rollback is not established by the active suite. `D:test/plugins/orders.lua:136-168`.

`BUILD_TESTS` only installs the Lua tests into the scripts folder; it does not make them standalone CTest tests. `D:CMakeLists.txt:569-577`. The CI test workflow downloads Dwarf Fortress, installs a built DFHack artifact and runs `python ci/run-tests.py`; therefore these orders tests require a running compatible game and were not runnable in this asset-free audit. `D:.github/workflows/test-suite.yml:39-86`. The C++ `dfhack_test` macro only creates tests on non-Apple UNIX and covers library/smooth-movement tests, not Workflow or Orders. `D:CMakeLists.txt:441-450`, `D:library/CMakeLists.txt:125`, `D:plugins/smooth-movement/CMakeLists.txt:5`.

## 6. Configure/build/test commands and exact results

### 6.1 Environment

- macOS Darwin 23.6.0 arm64; Apple Clang 16.0.0 (`arm64-apple-darwin23.6.0`).
- CMake/CTest 4.4.3, Ninja 1.13.2, GNU Make 3.81.
- Existing SDL2 2.32.72 was found under `/opt/homebrew`; `SDL2_mixer` was not found by pkg-config/CMake.
- `/usr/bin/gcc` and `/usr/bin/g++` resolve to Apple Clang. The only discovered actual GCC installation is Homebrew GCC/G++ **16.2.0**. No global installs were performed.

### 6.2 Augustus

From `city/augustus/`:

```sh
cmake -S . -B ../build/augustus -G Ninja -DCMAKE_BUILD_TYPE=Release
```

**Result: exit 1 at configure; no compilation or tests ran.** Exact terminal error:

```text
Could NOT find SDL2_mixer (missing: SDL2_MIXER_LIBRARIES)
Call Stack:
  cmake/FindSDL2_mixer.cmake:152 (FIND_PACKAGE_HANDLE_STANDARD_ARGS)
  CMakeLists.txt:902 (find_package)
```

The same configure emitted `fatal: bad revision '^tags/v4.0.0'` while deriving a development version; this is expected shallow-clone version-metadata degradation handled by `A:CMakeLists.txt:131-164`, and was not the fatal configure blocker. Full output: `city/logs/augustus-configure.log`.

```sh
ctest --test-dir ../build/augustus -N
```

**Result: exit 0, `Total Tests: 0`.** This confirms no registered tests, not a passing test run. No proprietary Caesar III assets were sought because configuration already failed and no runtime tests exist.

### 6.3 DFHack

From `city/dfhack/`:

```sh
cmake -S . -B ../build/dfhack-initial -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_DOCS=OFF \
  -DBUILD_TESTS=ON -DINSTALL_SCRIPTS=OFF
```

**Result: exit 1 at configure; no compilation or tests ran.** Exact independent blockers observed:

```text
CMake Error at CMakeLists.txt:65 (message):
  C compiler is not GCC
CMake Error at CMakeLists.txt:70 (message):
  C++ compiler is not GCC
CMake Error at CMakeLists.txt:228 (message):
  One or more required submodules could not be found! Run 'git submodule
  update --init' from the root DFHack directory.
CMake Error at CMakeLists.txt:370 (if):
  if given arguments:
    "VERSION_LESS" "4.9"
  Unknown arguments specified
```

The last error is secondary to non-GCC compiler detection leaving `GCC_VERSION_OUT` unset. More importantly, substituting the discovered GCC 16.2.0 cannot fix the build: this revision explicitly rejects GCC >=16 and requires GCC 11 or later, i.e. GCC 11–15. `D:CMakeLists.txt:47-72`. No compatible compiler is installed, and no installation was attempted. Required submodules also remained absent. Full output: `city/logs/dfhack-configure-initial.log`.

CMake did download its declared SDL header archive into ignored `depends/SDL2/` and FetchContent `fmt` 12.2.0 into the separate build tree before failing (`D:CMakeLists.txt:331-361`); these are build-probe artifacts only, not integrated code. No DFHack submodules or proprietary Dwarf Fortress assets were downloaded.

```sh
ctest --test-dir ../build/dfhack-initial -N
```

**Result: exit 0, `Total Tests: 0`.** This is an inventory result from an incomplete configured tree, not a passing test run. The fortress-mode Orders suite could not run without the proprietary host game; the Workflow suite is inactive regardless.

## 7. Highest-value reuse shortlist

| Rank | Donor path | Reuse recommendation | Existing evidence |
|---|---|---|---|
| 1 | `A:src/scenario/request.c` + `A:src/building/properties.c` house rows | Port request lifecycle and declarative housing requirements into local data/state machines. | Strong, readable source; no upstream tests. Build blocked at SDL2_mixer. |
| 2 | `D:test/plugins/orders.lua` fixtures + `D:plugins/orders.cpp` schema/ID-remap ideas | Translate test fixtures to local Workplace bill JSON/import validation and round trips. | Active upstream runtime suite, but not run here; requires DF host. |
| 3 | `D:plugins/workflow.cpp:276-307,1038-1296` | Extract only maintain-range hysteresis, available/in-use stock filtering and deterministic conflict priority; write new pure tests first. | Source reference only: plugin and test disabled at pinned HEAD. |
| 4 | `A:src/figure/service.c` + `A:src/building/house_service.c` | Adapt physical coverage events and decay/aggregation; preserve Household identity. | Clear mechanism; no tests and routing remains unvalidated. |
| 5 | `A:src/building/monument.c` | Adapt phase/resource definitions and in-flight delivery ledger for wonders. | Strong data/state reference; no tests. |
| 6 | `A:src/city/finance.c`, `sentiment.c`, `migration.c` | Port selected calculations/cause explanations behind new golden fixtures; avoid duplicate treasury/morale/Population models. | Rich mechanics, highly coupled globals, no tests. |

**Bottom line:** Augustus offers the greater volume of directly relevant city mechanics, but zero test safety net. DFHack Orders offers the only immediately transferable test fixtures; Workflow's small maintain-range rule is valuable, while its full implementation is not currently build-enabled or tested. Neither donor produced a runnable binary in the available asset-free, no-install environment, and this report does not claim otherwise.

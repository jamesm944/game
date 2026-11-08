# Wayfinder #161 donor audit: RimWar and PickUpAndHaul

## Scope and verdict

Private local research only. No production code was changed and no donor code was integrated. Both repositories were shallow-cloned into separate directories under `scratch/donor-audit/mods/`; all source citations below are pinned to the recorded `HEAD`.

**Bottom line:** the reusable value is algorithmic, not drop-in source. RimWar contains useful behavior-weight, power-growth, combat-resolution, scheduling, and demand-selection policies, but they are embedded in RimWorld world components and incident workers. PickUpAndHaul contains a useful multi-item/multi-destination batch planner and unload state machine, but storage, inventory, reservation, job, and mass operations are direct RimWorld calls. Independent reimplementation should put those policies behind small deterministic ports and leave host orchestration in adapters.

## 1. Verified repository identity and provenance

| Repository | Local clone | Default branch | Full `HEAD` | Shallow depth | Licence verified at that commit |
|---|---|---|---|---|---|
| `https://github.com/TorannD/RimWar` | `/Users/jamesmoss/Documents/game/scratch/donor-audit/mods/RimWar` | `master` (`refs/remotes/origin/HEAD -> refs/remotes/origin/master`) | `aab38d573275f5d2a1552e70e7dd4702507a2cc2` | 1 commit | `LICENSE`: MIT, copyright (c) 2019 TorannD; SHA-256 `6c878e13d4edbf880b294ef8a38922794826f5df2e65b987219cefd4c2fe3ef5`; Git blob `61a3ef7cb65cd46a4e3396514680d7fec8b4b736` |
| `https://github.com/Mehni/PickUpAndHaul` | `/Users/jamesmoss/Documents/game/scratch/donor-audit/mods/PickUpAndHaul` | `master` (`refs/remotes/origin/HEAD -> refs/remotes/origin/master`) | `09f1fac96e70cc2a93d647615a5abd37734a3eba` | 1 commit | `LICENSE`: MIT, copyright (c) 2018 Mehni; SHA-256 `6331a9f068c18038e044529dcd28f333cd1857c6f577c2c8c92a3d478fa69e9c`; Git blob `17a318320cb856660767ae8af96db9b875a3d794` |

The actual files contain the standard MIT permission, notice-retention, and no-warranty text. These are provenance facts, not selection filters. If substantial donor expression is ever copied later, retain the applicable copyright and permission notice; this audit itself does not integrate donor code. Licence source: RimWar `LICENSE#L1-L21` at `aab38d573275f5d2a1552e70e7dd4702507a2cc2`; PickUpAndHaul `LICENSE#L1-L21` at `09f1fac96e70cc2a93d647615a5abd37734a3eba`.

## 2. RimWar source map

All paths in this section are relative to `/Users/jamesmoss/Documents/game/scratch/donor-audit/mods/RimWar/` and pinned to commit `aab38d573275f5d2a1552e70e7dd4702507a2cc2`.

### 2.1 World power and scheduling

- `Source/RimWar/Planet/WorldComponent_PowerTracker.cs` is the central saved world state and scheduler. `ExposeData` persists counters, victory state, faction data, and caravan targets (`#L38-L62`). `WorldComponentTick` initializes factions, adjusts caravan targets every 60 ticks, updates factions on the configured cadence, runs global actions every 60,000 ticks, and randomly selects a faction/settlement/action for event generation (`#L175-L343`). Mission dispatch methods are in the same file: warband `#L952`, launched warband `#L1055`, scout `#L1160`, settler `#L1284`, trade `#L1354`, diplomat `#L1455`.
- Growth and delayed power return are also in `WorldComponent_PowerTracker.cs`: `IncrementSettlementGrowth` applies random/biome/tech/behavior/capital/citadel factors and player heat (`#L679-L729`); `ReconstituteSettlements` applies due `ConsolidatePoints` (`#L731-L757`). `GetHeatForAction` maps action type to signed heat and scales it by difficulty (`#L1518-L1555`).
- `Source/RimWar/RimWarData.cs` is per-faction state: behavior, cumulative action thresholds, movement/combat/growth attributes, wars/alliances, cached settlements, and power totals (`#L23-L76`, `#L305-L315`, `#L425-L542`). `GetWeightedSettlementAction` compares one random value against cumulative thresholds (`#L559-L591`); `GetEngagementRange` is a behavior-to-range table (`#L593-L623`).
- `Source/RimWar/Planet/RimWarSettlementComp.cs` stores per-settlement power, heat, event ticks, capital state, and delayed gains (`#L15-L61`). Player power is dynamically derived from storyteller threat points; NPC reads clamp power to `[100, 100000]`, and heat to `[0, 10000]` (`#L23-L33`, `#L85-L120`). Nearby settlement scans and player-requested missions are host-coupled (`#L143-L176`, `#L218-L437`).
- `Source/RimWar/Planet/WorldUtility.cs` mixes lookup/mutation with reusable calculations. Key calculation methods are `CalculateSettlementPoints` (`#L658-L690`), raid/trade/settler/diplomat/scout point formulas (`#L692-L762`), tech multiplier (`#L764-L808`), behavior weight construction (`#L820-L986`), and biome multiplier (`#L988-L1015`). World-object creation and spatial/faction queries occupy most of the rest and are host adapters, not portable policy.
- `Source/RimWar/RimWarAction.cs` and `Source/RimWar/RimWarBehavior.cs` are standalone byte enums (`RimWarAction.cs#L10-L19`; `RimWarBehavior.cs#L8-L18`). They are useful vocabulary references, but should be represented by Wayfinder-owned domain values rather than imported.
- `Source/RimWar/Planet/CaravanTargetData.cs` stores caravan/war-object target references and validates their continued world presence (`#L12-L103`). `WorldComponent_PowerTracker.cs#L345-L428` maintains this target list.
- `Source/RimWar/Planet/WarObject.cs` is the world-object host: movement/tick/scan/arrival orchestration (`#L380-L443`), nearby engagement dispatch (`#L462-L494`), target repair (`#L512-L535`), and parent reassignment/destruction (`#L643-L699`). It is not a portable algorithm module.

### 2.2 Incident tracking and workers

- `Source/RimWar/Planet/WorldComponent_IncidentTracker.cs` is effectively an empty stub: one `worldEncounters` counter, empty `ExposeData`, and constructor only (`#L14-L36`). **It is not the real incident implementation.** Do not treat its name as evidence of a reusable tracker.
- `Source/RimWar/Planet/IncidentUtility.cs` is the real dispatcher/resolver. `ResolveWorldEngagement` routes caravans, war objects, trade, and peace talks (`#L19-L58`); abstract war-object battle is `#L60-L144`; settlement battle/capture/raze/reconstitution is `#L146-L408`; trade resolution is `#L410-L514`; player raid/reinforcement/caravan/trade/peace orchestration is `#L515-L846`; raid-point adjustment and strategy selection are `#L861-L904`.
- `Source/RimWar/Utility/IncidentWorker_WarObjectRaid.cs` subclasses `IncidentWorker_Raid`; it generates/spawns threats and loot, sends letters, creates lords, and updates story statistics (`#L45-L107`). Raid strategy/faction fallback and custom letter handling are `#L109-L227`.
- `Source/RimWar/Utility/IncidentWorker_WarObjectMeeting.cs` generates a meeting caravan, builds trade/attack/move-on dialog options, and on attack generates a map, enters both caravans, and creates a lord (`#L47-L186`). This is almost entirely host orchestration.
- `Source/RimWar/Utility/IncidentWorker_WarObjectDemand.cs` contains the most portable incident-worker logic: weighted demand-category fallback (`#L122-L174`), colonist/prisoner and animal selection (`#L176-L234`), and item filtering/value-budget/weighted-stack selection (`#L236-L266`). The dialog, pawn generation, kidnapping, map creation, and combat actions around it are RimWorld-bound (`#L48-L120`, `#L268-L342`).

### 2.3 RimWar reusable policy candidates and required tests

These are **reimplementation targets**, not instructions to copy donor classes.

1. **Behavior weights and weighted action selection**
   - Source evidence: `WorldUtility.cs#L820-L986`; `RimWarData.cs#L559-L623`; enums cited above.
   - Port: a pure table builder from behavior and capabilities to normalized cumulative thresholds, plus selection from an injected `double/[0,1)` sample.
   - Tests: every behavior; diplomat enabled/disabled; settlement creation and launch capability on/off; thresholds monotonic and final threshold 1; exact boundary behavior; deterministic samples at 0, just below/above each threshold, and near 1; engagement-range table.

2. **Settlement/unit power calculations and growth**
   - Source evidence: `WorldUtility.cs#L658-L808`, `#L988-L1015`; `WorldComponent_PowerTracker.cs#L679-L757`; `RimWarSettlementComp.cs#L23-L120`; `RimWarData.cs#L305-L315`, `#L509-L542`.
   - Ports: pure biome/tech snapshots, faction/settlement DTOs, injected RNG and tick. Return growth/delayed-gain events instead of mutating RimWorld components.
   - Tests: all tech levels; city-type multipliers; movement-difficulty floor 0.1; biome edge cases; capital/citadel caps; player-versus-NPC power rules; heat clamps; deterministic random growth; delayed gains before/on/after due tick and applied exactly once; total power as settlement plus unit power with explicit cache invalidation semantics.

3. **Abstract combat resolution**
   - Source evidence: `IncidentUtility.cs#L60-L408`.
   - Port: a pure resolver taking attacker/defender power, combat multipliers, behavior/capital flags, and a random sequence. Return winner, end powers, capture/raze/reconstitute decisions, and goodwill effects as data; a host adapter applies them.
   - Tests: tie goes to defender; strict `>` thresholds (war-object 2.0/1.5 and settlement 1.75/1.35); behavior capture/raze modifiers; minimum/maximum end-power clamps; destruction at the settlement threshold; delayed return amount/tick; zero/negative input policy decided explicitly rather than inherited accidentally.
   - **Characterization watch-out:** in the defender-wins branch of `ResolveRimWarBattle`, the “solid win” condition tests `attackerResult > 1.5f * defenderResult` (`IncidentUtility.cs#L116`) even though that branch is reached when attacker did not win. A new implementation needs an explicit desired rule and regression test; do not silently enshrine or “fix” this without a product decision.

4. **Tick scheduler and action dispatch**
   - Source evidence: `WorldComponent_PowerTracker.cs#L175-L343`, `#L430-L541`.
   - Ports: injected clock/RNG, world snapshot, action sink. Keep scheduling separate from mission execution.
   - Tests: each cadence; randomized next-event interval bounds; empty faction/settlement lists; night-rest gating; war reroll policy; capital half-delay; settlement cap fallback; no duplicate dispatch for one scheduled evaluation.

5. **Caravan demand planner**
   - Source evidence: `IncidentWorker_WarObjectDemand.cs#L21-L30`, `#L122-L266`.
   - Ports: inventory snapshot (owner/prisoner/animal flags, market value, mass, stack count, apparel status), injected RNG, and a demand DTO independent of `ThingCount`/`Pawn`.
   - Tests: category probability/fallback order; fewer than two owners; animal count cap; trash and low-value apparel filters; 300/3500 budget clamps; empty/zero-value inventory; stack truncation; weighted selection with scripted RNG; no duplicate item allocation.

6. **Host-only incident execution**
   - Raid spawning/arrival/lords/letters, meeting dialogs/map generation, and peace-talk world objects must remain behind an incident adapter. Unit-test parameter construction and emitted commands with fakes; reserve real pawn/map/save-load verification for RimWorld integration tests. Source: all three worker files and `IncidentUtility.cs#L515-L846` as mapped above.

## 3. PickUpAndHaul source map

All paths in this section are relative to `/Users/jamesmoss/Documents/game/scratch/donor-audit/mods/PickUpAndHaul/` and pinned to commit `09f1fac96e70cc2a93d647615a5abd37734a3eba`.

### 3.1 Batch planning and work-giver logic

- `Source/PickUpAndHaul/WorkGiver_HaulToInventory.cs` is the principal planner.
  - Eligibility and better-storage gate: `#L11-L53`.
  - Initial destination, capacity, queue construction, nearby search radius, urgency filter, and inventory-fill loop: `#L58-L201`.
  - `StoreTarget` value identity for cell/container destinations: `#L220-L244`.
  - Closest-valid-item selection: `GetClosestAndRemove` `#L246-L280`, `FindClosestThing` `#L282-L304`.
  - Per-destination allocations: `CellAllocation` `#L306-L316`; capacity/stackability `#L318-L332`; core `AllocateThingAtCell` `#L334-L437`.
  - Destination selection and static skip sets: `#L439-L489` and cell/container scans `#L491-L600`. The static `skipCells`/`skipThings` are planner-session state and should become per-plan state in any port.
  - Encumbrance equations: `AddedEncumberance` and `CountPastCapacity` `#L526-L530`.
- `Source/PickUpAndHaul/IHoldMultipleThings_Support.cs` is a compatibility lookup for non-vanilla cell capacity/stackability (`#L7-L47`). `Source/IHoldMultipleThings/IHoldMultipleThings.cs` defines the two-method interface (`#L5-L10`), but its signature still uses RimWorld `Thing`, `IntVec3`, and `Map`.

### 3.2 Pickup, unload, tracking, and triggers

- `Source/PickUpAndHaul/JobDriver_HaulToInventory.cs` reserves queued items/destinations, loops goto/take, splits stacks, registers inventory items, schedules leftovers and more nearby work, then queues unload (`#L6-L130`). Combat Extended special handling is `#L138-L168`.
- `Source/PickUpAndHaul/JobDriver_UnloadYourHauledInventory.cs` repeatedly finds storage, reserves it, transfers inventory to carry tracker, deposits in a cell/container, releases the reservation, and repeats (`#L22-L73`). Drop/failure behavior is `#L75-L167`; deterministic-ish unload ordering and merged-stack fallback are `FirstUnloadableThing` `#L169-L195`.
- `Source/PickUpAndHaul/CompHauledToInventory.cs` is the persisted `HashSet<Thing>` tracking component; it removes nulls and registers hauled things (`#L3-L19`).
- `Source/PickUpAndHaul/PawnUnloadChecker.cs` guards faction/race/inventory state, queues forced or ordinary unload jobs, checks perishables, and handles periodic tracking desync (`#L4-L51`).
- `Source/PickUpAndHaul/HarmonyPatches.cs` supplies host triggers: deliberate haul, idle, unused-inventory, item removal, pickup-limit patches, and animal hauling (`#L5-L46`, `#L51-L140`). This is host coupling, not a portable batch algorithm.

### 3.3 PickUpAndHaul reusable policy candidates and required tests

1. **Nearest-candidate search**
   - Source evidence: `WorkGiver_HaulToInventory.cs#L139-L196`, `#L246-L304`.
   - Port: candidates expose integer position plus spawned/reachable/valid predicates; distance/reachability are injected.
   - Tests: nearest by squared horizontal distance; equal-distance tie keeps first; invalid/unspawned/unreachable removal; max-distance boundary; null/empty input; urgent-only filtering; search radius `max(12, haulDistance * 0.5)`.

2. **Multi-item, multi-destination batch allocator**
   - Source evidence: `WorkGiver_HaulToInventory.cs#L120-L200`, `#L306-L489`, `#L491-L600`.
   - Ports: `IStorageQuery` (better cells/containers, priority, acceptance, capacity), item snapshot (def identity, stack count, mass, stack compatibility), and planner output `(pickup item/count, reserved destinations)`. No static mutable skip sets.
   - Tests: exact fit; overflow across two and three cells; no remaining destination truncates count; incompatible item opens a new destination; cell and container parity; priority ordering and ties; skip-set non-reuse; zero initial capacity fallback; duplicate candidate prevention; reservations align one-to-one with planned destinations; two independent planners do not share state.

3. **Encumbrance truncation**
   - Source evidence: `WorkGiver_HaulToInventory.cs#L125-L196`, `#L526-L530`; `JobDriver_HaulToInventory.cs#L34-L75`.
   - Port: pure mass/capacity arithmetic, with Combat Extended behind a separate capacity strategy.
   - Tests: exactly full; one unit over; large final stack; zero/negative capacity and zero mass explicitly rejected or defined; planned count agrees with actual pickup; leftover stack schedules exactly once.

4. **Inventory registry and unload selection**
   - Source evidence: `CompHauledToInventory.cs#L3-L19`; `JobDriver_UnloadYourHauledInventory.cs#L114-L195`; `HarmonyPatches.cs#L51-L76`.
   - Ports: item IDs plus definition/category snapshots, an inventory query, and explicit removal events.
   - Tests: merged original ID missing but same-definition replacement found; item removed externally; null cleanup; empty registry; category then definition ordering; equal-key behavior made deterministic; no modification-during-enumeration hazards.

5. **Unload state machine and unload triggers**
   - Source evidence: `JobDriver_UnloadYourHauledInventory.cs#L22-L167`; `PawnUnloadChecker.cs#L4-L51`; `HarmonyPatches.cs#L78-L140`.
   - Ports: fake inventory/carry tracker, reservation manager, storage query, job queue, clock, and perishable snapshot.
   - Tests: cell/container branches; reservation failure drops and reports incompletable; no storage drops and succeeds; incapable manipulation or unstorable item drops; forbidden flag cleared; loop terminates; forced/idle/deliberate-haul triggers; perishable threshold `<30000`; 50-tick desync path; faction/race/empty early-outs.

## 4. Dependencies, builds, and tests

### RimWar

- `Source/RimWar/RimWar.sln` contains only the `RimWar` project (`#L6-L7`). `Source/RimWar/RimWar.csproj` is a non-SDK .NET Framework 4.7.2 library (`#L2-L14`).
- Direct references include proprietary game `Assembly-CSharp` and many Unity assemblies through machine-relative Windows `HintPath`s (`RimWar.csproj#L41-L44`, `#L63-L106`), plus Harmony 1.2.0.1/HarmonyMod, HugsLib, and RimCities from local Steam Workshop paths (`#L36-L56`). The source also directly consumes those host APIs throughout the mapped modules.
- Checked-in `Assemblies/RimWar.dll` and `Source/RimWar/obj/Debug/RimWar.dll` are outputs, not portable reference inputs. They do not make a clean source build independent of RimWorld/Unity.
- **Feasibility:** no clean build is feasible from this clone alone without proprietary/local game assemblies and other donor dependencies. A Wayfinder-owned pure policy project is feasible only after extracting/reimplementing behind the ports above. No test project or test files were found.

### PickUpAndHaul

- `Source/PickUpAndHaul.sln` contains `PickUpAndHaul` and `IHoldMultipleThings` (`#L6-L9`). Both SDK projects target `net48`, C# 10 (`Source/PickUpAndHaul/PickUpAndHaul.csproj#L2-L15`; `Source/IHoldMultipleThings/IHoldMultipleThings.csproj#L2-L15`).
- Both use `Krafs.Rimworld.Ref` 1.6.4518 reference assemblies, so the intended compile path does not use the commented proprietary game `HintPath`s. The main project additionally uses `Lib.Harmony` 2.3.6, `Krafs.Publicizer` 2.3.0, and a direct `IHoldMultipleThings` DLL reference (`PickUpAndHaul.csproj#L17-L43`). The corresponding DLL is checked in at `1.6/Assemblies/IHoldMultipleThings.dll`.
- **Feasibility:** a source compile should be possible with a .NET SDK and NuGet reference packages, without downloading proprietary RimWorld assemblies, but this was **not build-verified here**. Runtime behavior still requires RimWorld. No test project or test files were found; portable algorithm tests require the new seams above.

### Commands and observed results

Run from `/Users/jamesmoss/Documents/game` unless a subdirectory is shown:

```sh
mkdir -p scratch/donor-audit/mods
git clone --depth 1 https://github.com/TorannD/RimWar.git scratch/donor-audit/mods/RimWar
git clone --depth 1 https://github.com/Mehni/PickUpAndHaul.git scratch/donor-audit/mods/PickUpAndHaul
```

Result: both clones succeeded; no proprietary dependency download was requested or performed.

From each clone:

```sh
git rev-parse HEAD
git symbolic-ref refs/remotes/origin/HEAD
git remote show origin
git log -1 --format='%H%n%D%n%ci%n%s'
git rev-list --count HEAD
git status --short
git diff --stat
```

Results: full commits and `master` branches exactly as tabled; both are grafted depth-1 clones (`rev-list --count HEAD` = 1); RimWar log `2020-10-18 21:06:28 -0700`, `v0.9.5.0 hotfix`; PickUpAndHaul log `2025-08-28 16:38:15 +0200`, `recompiled binaries prior to release`. Final `git status --short` and `git diff --stat` produced no output in both clones. Tree file counts: RimWar 111, PickUpAndHaul 73.

```sh
shasum -a 256 LICENSE
git hash-object LICENSE
```

Results: exact licence hashes/blob IDs are in the provenance table.

```sh
for tool in dotnet msbuild xbuild csc mcs; do
  if command -v "$tool" >/dev/null 2>&1; then command -v "$tool"; else echo "$tool: not found"; fi
done
```

Observed:

```text
dotnet: not found
msbuild: not found
xbuild: not found
csc: not found
mcs: not found
```

`dotnet --version` likewise returned `/bin/bash: dotnet: command not found`. Therefore restore/build/test execution was not possible in this environment; installing a toolchain or downloading game assemblies was outside the reasonable read-only audit. Static `.sln`/`.csproj` inspection and filename/content searches found only the production projects described above and no tests.

## 5. Recommended implementation boundary

Create Wayfinder-owned, engine-neutral modules for (1) deterministic random/clock, (2) world/faction/settlement snapshots and emitted world commands, (3) storage/inventory/reservation planning, and (4) serializable plans/outcomes. Port behavior by writing tests from the cited rules first; keep RimWorld workers/job drivers/world components as optional host adapters only. This avoids proprietary compile dependencies in core tests and prevents global `Find`, `Rand`, static skip sets, and UI/job side effects from leaking into domain logic.

# Engineering Blueprint — AoE2-Better Browser RTS

**Status:** Final synthesis of wayfinder map #1 + decisions #2–#22. Every open design question is resolved here. Implementation proceeds ticket-by-ticket without further design work.
**Stack:** TypeScript + Three.js, browser, single-player, personal-use only (never distributed to real users).
**Who builds:** Agents implement everything; tickets must be agent-executable slices gated by golden fixtures.

---

## 1. Product Vision & Pillars

A browser RTS that uses Age of Empires 2 as its base model and deliberately exceeds it:

1. **AoE2-better, not clone.** Documented AoE2 numbers seed the dataset; the game adds resources, buildings, deeper systems. Rebalancing is cheap because everything is data-driven Entity definitions.
2. **DF-style Pops.** Every human on the map — workers _and_ soldiers — is individually simulated: skills (with rust), traits, injuries, needs, aging, families, schooling, schedules, social lives. Death is permanent and individual; veterans are irreplaceable.
3. **Delegated management.** The endgame of play is not clicking faster: Foremen → Managers → Companies absorb micro. Player direct orders always win.
4. **Civ-style multiple victory paths.** Conquest, Wonder, Relic, Knowledge, Culture, Economic — shared evaluation frame, symmetric for both sides.
5. **Personal-use license posture.** Copy mechanics from RimWorld/CDDA/DF freely; transcribe permissively-licensed code (MIT/Zlib); GPL code acceptable if ever needed (never distributed); CC BY-NC = mechanics-only; no-license = mechanics-only.
6. **Agent-implementable.** Deterministic headless sim + golden-fixture harness means every slice ships with machine-verifiable done-ness.

Explicitly out of scope (v1): multiplayer/netcode, campaigns/scenario editor, multiple AI civs, diplomacy, LOS raycasts through cliffs/forest.

---

## 2. Systems Spec

### 2.1 Sim Core & World

- **ECS:** bitecs v0.4 (SoA typed arrays, ~5 kB). Hand-rolled fallback component store if v0.4 API friction slows agents (ADR-0001). Entity id = bitecs eid, stable ascending assignment; all iteration ascending-eid.
- **Loop:** fixed-timestep accumulator at **30 Hz sim ticks**; 250 ms frame-time clamp + max-steps-per-frame cap (browser tab-switch/GC safety); render interpolates between last two ticks (alpha = acc/DT).
- **Determinism:** no `Math.random`, no clock reads, no transcendentals in sim (startup sin/cos LUTs where needed). Seeded PRNG pinned: **sfc32**, seeded via splitmix32 from the u32 game seed; PRNG state (4×u32) is serialized in saves. Violations are test-enforceable (throwing shims).
- **Commands:** user/AI commands enter an inbox and are consumed **only on tick boundaries** at their absolute target tick. Right-clicking a resource enqueues the whole `[Move(slot), Gather(node), Return]` Activity chain as ONE command — keeps replays trivially reproducible.
- **Activities:** OpenRA-style per-Pop activity queue (`Move`, `Gather`, `Return`, `Build`, `Attack`, …, repeat flag), advanced only inside `step()`.
- **World:** uniform 120×120 tile grid, tile = 1 world unit. Per-layer `Uint8Array`s: terrain type, elevation (integer 0–8; cliffs where adjacent levels differ), derived passability. Resource nodes are cell-occupying entities (depletion/re-seeding = ordinary entity mutation). Maps serialize as raw layer bytes (`map.bin`) hashed FNV-1a-64.
- **Seam:** `src/sim/**` is pure TS — zero DOM/three imports, commands in, state out. `render/` reads and interpolates, writes nothing back. If a test needs jsdom, the seam is broken.

### 2.2 Movement, Pathfinding & Terrain

Phased hybrid (ADR-0003):

- **Phase 1:** grid A* (8-directional octile), **one search per move-order group leader** (nearest centroid, ties by ascending eid), computed in a single FIFO **Web Worker**; string-pulled into sparse waypoints. Integer costs ×1000 (straight 1000 / diagonal 1414) — no float drift. Worst case 14,400 nodes < 1 ms.
- **Worker protocol:** requests are pure functions of contents `{kind:'path', id, dueTick=issueTick+PATH_LATENCY(2), start, goal, passable snapshot, passableVersion, seed}` → `{id, ok, waypoints:Int16Array, cost}`. Sim consumes responses at tick boundaries in ascending `id`, applying those with `dueTick ≤ currentTick`; late responses block the sim (replay-exact movement). Worker: seeded PRNG only; heap tie-break `(f, insertionCounter)`; clockwise neighbor expansion; LRU cache 32 entries keyed `(goalTile, passabilityVersion)`.
- **Formation:** concentric-ring slots around destination (256-entry sin/cos LUT), dealt to Pops sorted once by ascending eid; followers steer to `waypointᵢ + slotOffset`; blocked follower re-paths individually. Prototype-validated wedge/bearing-preserving variant may replace rings visually — steering layer unchanged.
- **Gather convergence:** resource nodes expose ≤8 adjacent-passable **work slots**, claimed `(slotIndex, entityId)`; overflow mills in an outer holding ring; Carry-capacity-full → cheapest known Drop-off point (path cost cached per building), then resume slot.
- **Steering (permanent layer):** boid separation within ~1 tile via per-tick spatial hash (2-tile cells); symmetric positional push-apart; impassable-tile clamp; FSM **Moving / Stalled (>N ticks → seeded sidestep → individual re-path) / Parked** (soft obstacle; parked status propagates backward through contact so columns behind saturated camps halt cleanly).
- **Invalidation:** passability `version` bumps on placement/depletion/re-seed; per-Pop next-waypoint raycast check each tick; stale-version responses discarded.
- **Phase 2 trigger (measured, not vibes):** worker turnaround > 1 tick budget OR main-thread path application > ~2 ms/tick ⇒ per-goal flow fields keyed `(goalTile, version)` shared by converging Pops. Portal-sector tiling deferred beyond ~256² maps.
- Pathfinding uses true passability regardless of fog (AoE2-authentic).

### 2.3 Pop Simulation (Lifecycle / Family / School)

Every human individually simulated; target envelope **300–500 Pops @30 Hz** (donor-informed: CDDA CC-BY-SA skill code, DF wiki GFDL/MIT constants, RimWorld patterns, MIT RimWorld-mod donors HAR/PickUpAndHaul/WorkTab, DFHack Zlib prior art).

**Components:** Identity (name/age/familyId) · Traits[] (commonality-weighted generation with conflict exclusion; some innate, some School-acquired) · Skills map split **knowledge vs practice** (knowledge never rusts; practice decays via rust accumulator toward knowledge floor — CDDA `SkillLevel` steal; level cost `400+100·L` XP, Legendary 18,000) · Body: 6 parts (head/torso/2×arm/2×leg) holding hediff-style stacked injuries {severity, duration} · Needs (food/rest/morale).

**Tick tiering:** movement/combat/gather every tick; needs + trait effects on staggered rare ticks (~every 250 ticks, hash-offset per entity — RimWorld tickerType pattern); job selection at 1 Hz think-interval via IAUS utility scoring with DFHack-style per-building job cooldowns (anti-thrash). Amortized scoring ≈60k mults/tick @300 Pops.

**Lifecycle:** birth → childhood (cannot work/fight) → adult at age gate (~6–8 real minutes) → elder past work age (lifespan ~40 min) → death. Generations matter within one sitting.

**Family/household:** household forms when housing + food surplus allow; births scale with housed families; family bonds feed morale; family/companion deaths apply combat morale shocks.

**School:** Children attend 9am–3pm; teacher-skill-gated lesson windows grant weighted skill/trait rolls (CSL model simplified: teacher skill gates ~subject level 7, room/material XP multipliers, scheduled windows).

**Injuries:** impairments derive as multipliers from stacked injuries (aim/speed/work penalties); heal over time, scar permanently, or kill.

**Jobs:** Pops pull from the same command interface as player orders where sensible (haul/gather/build); otherwise AI-driven via IAUS. Hauling capacity-filling follows PickUpAndHaul's driver pattern.

### 2.4 Schedules & Social Life

- **Day/night cycle enters v1:** 8-minute day = 24 h sim clock tracked as integer minutes; awake band 5am–10pm. Visual = lighting tint on render mirror only; sim stays numeric.
- **Work windows per role**; children School 9am–3pm.
- **Sleep:** every Pop sleeps at its Household home during night band; quality = housing quality × crowding; deprivation ⇒ next-day work/combat penalties and napping idle states.
- **Leisure window** (post-work evening + festival days): each Pop scores available activities through the existing 1 Hz IAUS scorer, weights from Traits — Sociable→visit friends; Family-focused→spouse/children/home; Hedonist→Tavern (gold sink, morale buff, hangover debuff if repeated) or Brothel (bigger gold sink, morale buff, partner-jealousy risk event); Pious→Shrine; Ambitious→self-improvement (School/library). Mistresses: secret meetings for married Hedonist/Charmer Pops; discovery → spouse morale shock + relationship damage. All abstracted management drama à la RimWorld — no explicit content.
- **Social bonds:** pairwise Relationship values (capped) incremented by visits/shared events; strong bonds buffer morale shocks (incl. combat griefings); rivals form on negative events.
- **Weekly cycle:** 7 named days; **Sunday rest day** closes work windows (essential roles only); if a **Church** stands, community attends Morning Mass — broad morale buff + bond reinforcement across attendees, extra weight for Pious. Without a Church, plain leisure.
- **Venues v1** (all Entity definitions): Home, Friend/Family visit (no building), Tavern, Brothel, Shrine, School-library, Church.
- **Performance:** off-work transitions staggered per-Pop ±90 s jitter (paths trickle, never stampede); leisure travel reuses standard movement.

### 2.5 Combat & Progression

- **Derived stats, never stored:** attack/defense/speed/morale-break computed on read from Traits + Skills + active injuries + equipment. No duplicate stat stores.
- **Counter mechanism:** data-driven **~8 Armor classes** (infantry, cavalry, archer, siege, building, ship, monastery, camel) with Attack-bonus multipliers — AoE2's bonus system, smaller table, full damage-table snapshot-tested.
- **RPG layer on top:** XP per hit/kill → skill-ups with diminishing gains near caps (OpenXcom pattern); practice rusts when idle (shared machinery with economy skills); veterancy shown as rank pips + portrait wear.
- **Wounds in battle:** limb impairments degrade aim (arm), speed/charge (leg), crit susceptibility (torso/head) — same impairment multipliers as work penalties; one system, two contexts.
- **Morale:** individual break points; AoE2-style routing; family/companion deaths apply shocks; nearby high-morale Pops rally routers.
- **Equipment = commodities:** Forge Weapons/Armor set base stats and Armor-class tags; equipped military beats default-fisted. RPG layer modifies numbers, never the rock-paper-scissors shape.
- **Permanence:** death final; scars persist; veterans irreplaceable — the DF-feel payoff.

### 2.6 Economy (Resources, Commodities, Recipes)

- **Gatherables (7):** Food, Wood, Gold, Stone + **Iron, Coal, Clay**.
- **Commodities (depth-1 chains only):**
  | Commodity     | Building | Recipe                                                             |
  | ------------- | -------- | ------------------------------------------------------------------ |
  | Planks        | Sawpit   | wood → planks                                                      |
  | Bricks        | Kiln     | clay+coal → bricks                                                 |
  | Tools         | Smithy   | iron+wood → tools (consumed by construction + work-speed bonuses)  |
  | Weapons/Armor | Forge    | iron+wood / iron+gold (equip military Pops, better than default)   |
  | Meals         | Kitchen  | food varieties → meals (morale/work-speed buffs feeding Pop needs) |
- **Hard rule: chain depth 1** — recipes take gatherable inputs only. Schema supports commodity-on-commodity inputs; content-blocked in v1 to avoid Anno-sprawl.
- **Core loop:** AoE2-faithful — Carry capacity, walk-to-drop-off, Farm re-seeding (wood cost), auto-repeat gather Activities. Hunt-lure micro and herdables deferred.
- **Stockpile:** commodities stockpile alongside resources; Drop-off points declare per-building acceptance filter lists.
- **Recipe shape:** `{id, buildingId, inputs:[{defId,qty}], output:{defId,qty}, ticks, techGate?}` (≡ DF raws reaction format).
- Baseline numbers = documented AoE2 values, tuned upward later; all constants live in Entity definitions.

### 2.7 Delegated Management (Foremen / Managers / Companies)

- **Foreman — per Workplace** (Lumber Camp, Mining Camp, Mill/farm cluster, Kitchen, Forge…): fills work slots from idle labor pool, rotates exhausted Pops, re-seeding/rebuild orders, keeps loop saturated. Appointed via building panel; candidates ranked by derived management rating (Organization-type traits + relevant craft skill + Management skill grown on the job).
- **Manager — per domain** (Food / Wood / Stone·Clay / Metal / Crafted goods): owns player-set strategy-weight sliders; redistributes workers across domain Workplaces; escalates shortages toward TC production queue. Speaks the **same command interface as the AI opponent** — one planning stack, two customers.
- **Override rule:** direct player orders always win; delegation fills untouched space; dismissal instant, no cooldown.
- **Cadence:** foremen think at the existing 1 Hz IAUS cadence; managers every 30 ticks. Zero new tick tiers.
- **Companies:** player-chartered organization {name, charter focus, virtual treasury ledger, owned Workplaces as Branches}. V1 player-civ only (AI reuse post-v1).
  - **Ledger:** each Branch routes a configurable share (**default 20%**) of output market value to treasury; remainder hits stockpile normally. Treasury is virtual credit spendable only by the Company.
  - **Expansion:** when treasury ≥ threshold AND all holds (unclaimed resource node in reach · labor slack ≥ N · placement valid per normal rules · no freeze flag) → proposes a new Branch, paid from treasury, sited by the same scorer the AI uses. Approval mode: always-ask / auto-approve per company. Expansion log is public history.
  - **Staffing rule:** Company staffs its Branches' Foremen + one Manager **exclusively from its own management-rated Pops**; no player appointment or veto there. Player appointment power applies only to directly-owned Workplaces. Dismissed Pops return to labor pool.
  - **Origins:** (1) **Commissioned** — player charters deliberately (name, focus, seed branches); (2) **Organic** — when a sector has ≥3 profitable directly-owned Workplaces AND a sufficiently management-rated Pop exists, that Pop founds spontaneously, absorbing them as Branches; notification with short free-dissolve grace window, else persists.
  - **Oversight panel:** branches, ledger, appointments, proposals/log; player can freeze expansion, seize a branch back, or dissolve (Pops/workplaces revert).
  - **Victory tie-in:** economic path keys off aggregate company scale (§2.11).

### 2.8 AI Opponent

Exactly one AI opponent in v1. **Three-layer planner speaking the player command interface** — the AI never mutates sim state directly:

1. **Build-order layer:** scripted gated strategies (Fast Castle → knights; scouts rush; archers push) — conditions like 'wood ≥ 175 and barracks up'.
2. **Economy manager:** keeps TC training villagers, zero idle time, reassigns gatherers per strategy weights; farm re-seeding; drop-off balance.
3. **Military manager:** utility-scored attack timing (army-size thresholds, composition counters vs scouted enemy units); auto-rally to defense when buildings take damage; raid targeting by villager density.

- Cadence: full planning pass every 30 ticks (1 s), incremental checks between; budget < 1 ms amortized.
- **Difficulty = disclosed knobs:** reaction latency + decision interval scale down for easier levels; hard adds a documented AoE2-style income multiplier cheat — deliberate, never hidden.
- **Fog honesty, structural:** AI receives a `KnowledgeView` interface (`isVisible`, `isExplored`, `knownEntities()`, `lastKnown(enemyId)`) instead of raw world state; wallhacks are impossible because no API exists to ask. Same interface backs replays/future observers.
- Victory evaluators are symmetric: Knowledge/Culture/Economic metrics compute identically for the AI so progress is visible and winnable-against; no dedicated AI strategies per path in v1.

### 2.9 Fog of War & Minimap

- **Data:** per-player `explored[]` + `visible[]` `Uint8Array(N²)` planes + `contributorCount[]` `Uint16Array(N²)`, living in a singleton sim `FogState` (world-sized, not components). Binary values; all smoothing is render-side.
- **Update cadence:** dirty-entity queue (moved/spawned/died) flushed after movement, before tick-boundary commit: un-stamp old sight circle, stamp new, via precomputed offset LUTs (radius 0–16, Euclidean ≤ r, edge-clamped, no wrap). `explored` OR-ed in during stamps, never decremented. Worst case ~160k increments/tick — well inside budget. **Full recompute only** on map gen and save/load.
- **Sight radii:** `sightRadius` in Entity definitions (villager 5, scout/cavalry 8, archer 6, infantry 5, TC 8, houses/mills 5, towers 10–12; Town Watch-style techs modify). V1 pure-radius circles — no LOS raycast.
- **Rules:** building placement requires `explored`; enemies in invisible tiles are absent from player queries; pathfinding ignores fog.
- **Memory ghosts:** enemy buildings leaving visibility recorded `{entityId → lastKnownTile, defId}`; rendered greyed/static until re-sighted or observed destroyed; knowledge entries in FogState, invisible to combat/sim, exposed via KnowledgeView.
- **Minimap:** pure projection of fog planes + entity index (never independent state), redraw ~4 Hz. Unexplored black; explored-not-visible dimmed terrain/resources; visible full-bright + live dots. Own Pops always dotted; enemy dots only on visible tiles.
- **Renderer handoff:** one `THREE.DataTexture` per human viewer — RGFormat, UnsignedByteType, 120×120, LinearFilter, ClampToEdge, no mipmaps; R=explored G=visible; `.needsUpdate` on fog-dirty ticks (≤57 KB/upload). Terrain shader: `brightness = mix(EXPLORED_DIM≈0.55, 1.0, texel.g) * step(0.5, texel.r)`. Temporal smoothing via `uFogCurr`/`uFogPrev`/`uBlend` across tick interval. Entities CPU-culled against `visible` before instancing; ghost buildings submit desaturated.

### 2.10 Day/Night Rendering & Audio

- Day/night visual = sky/light color mapped from sim clock minutes onto the render mirror; tint-only in v1.
- **Audio architecture:** single lazily-created `AudioContext` on first user gesture (+`resume()`). Mix graph: `master → {music, sfx, ui, ambient}` GainNode buses; volumes persist to bus gains; ducking supported.
- **Voice pooling:** buffers decoded once, cached by asset id; throwaway source nodes; **~24 concurrent voice cap**; over-cap priority-culled by camera distance; identical same-frame events coalesced (20 chops → ≤4 pitch-varied plays).
- **Positional:** `StereoPannerNode` only — pan from world-x relative to viewport, gain falloff scaled by zoom. No PannerNode/HRTF.
- **Scheduling from render loop, never sim ticks:** an event bus subscribes to _post-step_ command results/state transitions and enqueues audio intents; render-loop scheduler drains ~15 Hz. Audio is a pure consumer of observable sim output — cannot perturb determinism; golden tests unaffected.
- Ambient loops crossfade by biome/time-of-day (equal-power ~2 s ramps) reading the double-buffered mirror.
- **CC0-verified packs** (see §6 manifest; every file ships with a provenance line — anything not provably CC0 never enters the pipeline).

### 2.11 Victory Paths

Shared frame: every path = **generator → accumulating metric → completing act → victory timer** (win on hold; timer pauses/resumes if sustaining condition breaks mid-timer; Conquest timerless). All thresholds/rates live in Entity-definition JSON.

| Path      | Generator                                                                                                                                           | Metric                                             | Completing act                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Conquest  | —                                                                                                                                                   | enemy military production capacity destroyed       | destroy capacity (baseline)                                                               |
| Wonder    | —                                                                                                                                                   | —                                                  | complete Wonder, hold through timer                                                       |
| Relic     | —                                                                                                                                                   | —                                                  | hold all Relics through timer                                                             |
| Knowledge | School output (studying Children produce Knowledge Points, scaled by teacher/school quality) + lump award per researched Technology                 | Knowledge Points/min sustained                     | build **Grand Academy** (expensive Imperial, tech-gated), sustain ≥N KP/min for T minutes |
| Culture   | Monuments yield ongoing Prestige/min · population happiness/morale surplus adds Prestige · hosted **Festivals** convert Food/Gold into timed bursts | Prestige/min sustained                             | build **Grand Monument**, sustain ≥N/min for T minutes                                    |
| Economic  | Chartered Companies running Branches                                                                                                                | aggregate Branch output market-value/min sustained | sustain ≥N/min for T minutes while owning ≥1 Company                                      |

Diplomatic path OUT for v1 (no diplomacy system); revisit post-v1 with multi-civ. Evaluators run symmetrically for both sides.

### 2.12 Save / Load / Replay / Deployment

- **`.ageof` container:** `magic "AOF1" | u32 formatVersion | u32 seed | u32 tick | f64 playtimeSeconds | u64 FNV-1a-64(mapBytes) | u32 payloadLen | fflate-gzip(payload)`. Header uncompressed (tools inspect version/seed/map-hash without inflating).
- **Payload sections (length-prefixed):** component typed-array stores dumped raw in **fixed alphabetical registry order** (same order as the digest recipe), prefixed `u32 liveCount` + alive bitmask; map layer bytes; fog planes (explored verbatim; visible saved anyway for fast-path resume); **PRNG state (mandatory)**; pending command queue with absolute target ticks; Company/Branch/Manager state (treasuries, sliders, ratings, staffing, organic-founder cooldowns); `stateDigest` in header extension.
- **Restore does NOT replay:** reconstruct from seed → allocate arrays → copy bytes in registry order → verify by re-running the digest recipe against `stateDigest` (free corruption check; one canonical serializer serves hashing + persistence).
- **Compression:** fflate (~8 kB, no WASM, sync+async) over pako.
- **Storage:** IndexedDB (db `ageofwind`, store `saves`): rolling ×3 autosave + named manual slots `{name, savedAt, playtimeSeconds, thumbnailBlob?, saveBlob}`. localStorage ruled out (size). File export downloads `<slot>.ageof`; import validates magic → version → map-hash with loud mismatch errors. Forward-incompatible by design: version bump invalidates old saves loudly.
- **Replay = golden-fixture artifact:** `{formatVersion, seed, mapHash:"fnv1a64:…", ticks, commands:[{tick,type,payload}], milestones?}`. Header gates reject mismatch (no silent desync). Pause-menu "Export replay" → attach to issue → dropped into `tests/golden/<bug-name>/` → `npm run golden:record` → failing milestone bisects regression to its simulated second. Bugs become permanent fixtures.
- **Deployment:** Vite static bundle, no backend ever. GitHub Actions: every PR = lint → typecheck → full golden+property suite (<60 s required-green); tag push `v*` on main = same checks → `vite build` → deploy `dist/` to **GitHub Pages** (primary) + zip as release asset for manual **itch.io** upload (secondary; `butler` automation optional later). Nightly soak = separate scheduled workflow.

### 2.13 Command UX (Prototype-Validated)

The `prototype/command-control` prototype was built and user-approved ("much better"). It is the browser-feel baseline, excluded from builds but mined for behavior:

- **Selection:** box select (left-drag), single-click, shift-add/toggle, double-click select-same-type-on-screen. Selection survives context switching; groups prune dead units silently.
- **Orders (right-click contextual):** move (formation + green ring), attack raider (red crosshair, retaliation), gather tree/gold with deposit loop feeding the resource topbar; attack-move (A) with auto-acquire; stop (S), focus (F), Esc cancel. Every order logged to an on-screen Orders panel. **Order feedback must appear within the same frame as the click.**
- **Control groups:** Ctrl/⌘+1..4 store, 1..4 recall, double-tap centers camera; chips show live member counts.
- **Build menu:** grid bottom-left, grid-snapped ghost placement with green/red validity; rally points on selected building (flag + dashed line).
- **Minimap:** bottom-right, unit dots + viewport rect, click/drag-to-move camera.
- **Pop card:** selecting one Pop shows name/age/origin, trait chips, five skill bars, health bar with injury status that visibly slows movement — injury must have visible mechanical meaning, not just a red bar.
- **Locomotion feel (validated iteration):** turn-rate-limited headings (smooth arcs, never snapping), ease-in/out along polyline routes sliding around obstacles, damped crowd separation, purposeful idle strolling, group wedge slots preserving bearing, gather rhythm (walk out, rhythmic bob at node, clean return line), per-unit pace/turn personality variance.
- **UI implementation stance:** vanilla TS + DOM/CSS (framework-free), matching the prototype; picking = ray-to-ground-plane + spatial-hash query against sim coords, never mesh raycasts.

### 2.14 Threading & Acceleration (standing requirements)

- **Threading posture:** the game is multi-threaded at the architecture level; the deterministic 30 Hz sim tick stays single-threaded BY DESIGN — replay-exactness and golden fixtures depend on it, so parallelizing sim systems is forbidden without a new ADR. Off-main-thread work: pathfinding FIFO worker (§2.2), seeded mapgen (workerized if gen exceeds ~50 ms), fflate save compression in async mode, atlas bake (build-time process). Every worker obeys the path-worker contract: pure function of request contents + seed, deterministic tie-breaking. Full rationale: ADR-0004.
- **GPU acceleration guarantees:** all hot-path visual work runs on GPU — vertex-shader animation playback for instanced billboard units (zero CPU animation cost), instanced building meshes, fog DataTexture blending in terrain/unit shaders, splat-shaded terrain. CPU per-frame cost is bounded to mirror writes ≤2 ms @500 instances (§7). No CPU canvas compositing or per-unit matrix math in the frame loop.
- **Banished-style work presentation:** Pops visibly DO their jobs — activity-matched looping animations (axe swings at trees, pick strikes in mines, hammering on construction sites), tools rendered in-hand during the matching activity, and **visible carried cargo** (log bundles, ore sacks, food baskets) as attached props while returning to drop-off. Requires: `activityAnims` map + `toolProp`/`cargoProp` refs in unit Entity definitions; a cargo-prop instanced overlay draw keyed to carry state; bake pipeline emits tool/cargo/gather clips alongside locomotion.

- **Format:** JSON per entity family under `src/data/definitions/{units,buildings,techs,recipes}/*.json`; **Zod schemas** in `src/data/schema.ts` generate TS types (`z.infer`). Load discipline = Factorio three-round prototype stage: parse all → validate all → fail loudly listing every error.
- **Kind discriminator:** every definition carries `kind: 'unit' | 'building' | 'tech' | 'recipe'`.
- **Common fields:** `id` (stable slug), `name`, `costs` (resource map), `buildTime`/`trainTime`/`researchTime` (ticks), `ageGate`, `techPrereqs[]`.
- **Units:** `hp`, `speed`, `carryCapacity`, `attack`, `armorClasses[]` (tags), `attackBonuses[{armorClass, mult}]`, `sightRadius`, `lineOfSight` defaults, `equipmentSlots`, `activityAnims` (activity → clip id), `toolProp`/`cargoProp` asset refs (§2.14).
- **Buildings:** `footprint` (tiles), `hp`, `workSlots` count, `dropoffFilters[]`, `acceptsRoles[]`, `sightRadius`, `ageStages[]` (asset refs per evolution stage), venue fields where applicable.
- **Techs:** effect descriptors (stat modifiers, multiplier traits à la OpenRA condition/multiplier pattern), targets, cost, prereqs.
- **Recipes:** `{id, buildingId, inputs[], output, ticks, techGate?}`.
- **Victory constants:** generators/metrics/thresholds/timers are Entity definitions like everything else.
- **Asset reference ids:** single `src/data/assets.json` manifest; stable slugs `"<pack>/<asset>[@stage]"` (e.g. `quaternius-ufrs/barracks@stage-2`). Definitions point into the manifest by id; baked atlas pages derive ids `atlas/<unitDefId>` (2048² RGBA PNG pages). Every manifest entry carries a provenance/license line.

---

## 4. Dependency Manifest

| Package                                   | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `typescript`                              | Strict-mode language; typecheck is a CI gate                                   |
| `vite`                                    | Dev server + static bundle; native Web Worker support; no backend              |
| `three`                                   | Renderer only (instanced meshes, DataTexture fog, orthographic bake turntable) |
| `bitecs`                                  | ECS core — SoA typed arrays (fallback: hand-rolled store per ADR-0001)         |
| `zod`                                     | Entity-definition validation; generates TS types                               |
| `vitest`                                  | Node-only test runner: golden fixtures, property tests, canary                 |
| `fflate`                                  | gzip for `.ageof` payloads (~8 kB, no WASM, sync+async)                        |
| `simplex-noise`                           | Seeded map generation (fed our sfc32 stream for determinism)                   |
| `idb`                                     | Tiny IndexedDB promise wrapper for save slots                                  |
| `eslint`, `typescript-eslint`, `prettier` | Lint/format CI gate                                                            |
| `@types/three`, `@types/*`                | Types                                                                          |

Deliberately absent: React/frameworks (vanilla TS UI), pako (fflate wins), lodash (write the 40 lines), Mixamo/game-icons.net/Sonniss (license).

---

## 5. Repository Layout

```
/
├── AGENTS.md, CONTEXT.md, docs/adr/, docs/research/   # living docs; keep current every session
├── index.html                  # vite entry
├── src/
│   ├── sim/                    # PURE TS — zero DOM/three imports (CI-enforced import rule)
│   │   ├── core/               # world creation, 30 Hz accumulator, command inbox, sfc32 PRNG, component registry (alphabetical), digest serializer
│   │   ├── components/         # bitecs component definitions
│   │   ├── systems/            # movement, gathering, production, combat, pop-needs, lifecycle, schedule, management, company, victory, fog
│   │   ├── activities/         # OpenRA-style Activity queue types + stepping
│   │   ├── path/               # A* search (pure exported functions for headless tests) + worker protocol types
│   │   ├── path.worker.ts      # thin worker shell wrapping path/
│   │   ├── ai/                 # build-order / economy / military layers + KnowledgeView
│   │   └── mapgen/             # seeded simplex terrain/elevation/passability → map.bin bytes
│   ├── render/                 # three.js mirror: double-buffered SoA snapshots, instanced billboards, building InstancedMeshes, terrain splat, fog DataTexture, overlays, camera
│   ├── ui/                     # vanilla-TS DOM HUD: selection, orders panel, control groups, build menu, panels (building/company/victory), minimap canvas, Pop card
│   ├── audio/                  # AudioContext bootstrap, buses, voice pool, panner, intent queue drain
│   ├── data/
│   │   ├── definitions/        # units/ buildings/ techs/ recipes/ JSON
│   │   ├── schema.ts           # Zod schemas → TS types
│   │   └── assets.json         # CC0 asset manifest w/ provenance lines
│   └── assets/                 # baked atlases, GLTF building sources, audio, fonts
├── tools/
│   └── atlas-bake/             # headless three.js: load GLTF → play clip → orthographic turntable render → composite 2048² atlas pages (actions × 8 yaws × frames, 128px frames)
├── tests/
│   ├── golden/<slice>/case.json + map.bin
│   ├── properties/             # conservation, counter-table, pathfinding termination, determinism canary, shim ban
│   └── perf/                   # headless CPU-budget assertions (mirror writes, tick time)
├── prototype/command-control/  # throwaway, EXCLUDED from tsconfig + vite build; reference only
└── .github/workflows/          # ci.yml (PR gate), release.yml (tag→Pages+zip), soak.yml (nightly)
```

---

## 6. Asset Manifest (game concept → CC0 source)

Q = Quaternius (site-wide CC0), K = Kenney (site-wide CC0), KK = KayKit (per-pack CC0). Full survey: `docs/research/cc0-asset-survey.md`.

| Game concept                      | Source pack / file                                                                                                                  | Approach                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Villager                          | Q Universal Base Characters + Modular Outfits-Fantasy + Universal Animation Library 1&2                                             | Retarget walk/idle/farming/fishing/death |
| Militia / man-at-arms             | KK Adventurers (barbarian) or Q Ultimate Animated Character Pack                                                                    | Pre-animated + weapon accessories        |
| Archer                            | KK Adventurers (archer) or Q RPG Character Pack (ranger)                                                                            | Bow attachment included                  |
| Knight                            | KK Adventurers (knight)                                                                                                             | Pre-animated, sword+shield               |
| Mounted units                     | Q Ultimate Animated Animal Pack horse + rider kitbash                                                                               | Parent rider, hide legs                  |
| Monk                              | Q RPG Character Pack (monk)                                                                                                         | Direct                                   |
| Siege (ram/trebuchet)             | Q Medieval Weapons + Modular Medieval timbers                                                                                       | Static kitbash + code-driven motion      |
| Sheep / Deer                      | Q Farm Animal Pack / Ultimate Animated Animal Pack                                                                                  | Direct, animated                         |
| Boar                              | Q Farm Animal Pack pig                                                                                                              | Recolor + tusk kitbash                   |
| Buildings (all ages)              | Q Ultimate Fantasy RTS (128 models, evolution stages, tagged `ageofempires`) + Medieval Village + Modular Medieval + Farm Buildings | One InstancedMesh per type/stage         |
| Wonder                            | Q Modular Medieval castle modules @1.5–2× + church pieces                                                                           | Gold-trim material variant               |
| Trade cart                        | Q Fantasy Props MegaKit wagon + horse                                                                                               | Procedural wheels                        |
| Ships                             | Q Ships Pack                                                                                                                        | Direct                                   |
| Trees/bushes/rocks                | Q Ultimate/Stylized Nature packs; KK Forest Nature Pack                                                                             | 3–5 variants per biome                   |
| Farms/crops                       | Q Ultimate Crops Pack + Farm Buildings fences                                                                                       | Compose plots                            |
| Mines (iron/coal/clay/gold/stone) | Q UFRS mine/resource props                                                                                                          | Ore-tint materials                       |
| Terrain ground                    | ambientCG Ground/Rock + Poly Haven grass/furrow                                                                                     | Splat map, 512 px tiles                  |
| Water                             | Procedural flat-shaded animated plane                                                                                               | Zero assets                              |
| Military atlas texture            | KK single 1024 px gradient atlas                                                                                                    | Downsampling bake source                 |
| Fonts                             | K Kenney Fonts                                                                                                                      | 1 display + 1 body                       |
| Cursors                           | K Crosshair Pack + Input Prompts                                                                                                    | Recolor into ~6 RTS cursor states        |
| UI sounds                         | K Interface Sounds (100 files) + K UI Audio                                                                                         | Direct                                   |
| World/combat SFX                  | K Impact Sounds + RPG Audio + Digital Audio; Freesound CC0 filter                                                                   | Curate ~30 clips w/ license URLs         |
| Jingles (victory/age-up)          | K Music Jingles (85 tracks)                                                                                                         | Direct                                   |
| Music beds                        | FreePD.com (World/Epic/Scoring)                                                                                                     | Site-wide PD/CC0                         |
| Ambient loops                     | OGA "Nature sounds [CC0]" (Freso); OGA "Loopable Dungeon Ambience" (JaggedStone); Freesound CC0 soundscapes                         | Crossfaded layers                        |
| Resource/unit icons               | **Gap** — resolved: in-house flat SVG icons (strict CC0; silhouettes rendered from actual models where useful)                      | game-icons.net rejected (CC-BY)          |

Rejected/not-CC0 (do not use): Mixamo, Sonniss GDC bundles (EULA ≠ CC0), FoxSynergy/Zhelanov/incompetech (CC-BY), VEF (NC-ND), Psychology repo (unlicensed).

---

## 7. Performance Budget Contract & Testing Gates

**Contract (issue #9)** — mid-range laptop (GTX 1650 / M1 / Iris Xe), 1080p, DPR ≤ 1.5, 60 fps with 500 Pops visible:

| Metric                         | Typical               | Hard cap |
| ------------------------------ | --------------------- | -------- |
| Draw calls                     | ≤ 90                  | ≤ 150    |
| Triangles/frame                | ≤ 600 k               | ≤ 1.5 M  |
| Renderer frame time            | ≤ 6 ms                | ≤ 12 ms  |
| Sim tick (30 Hz)               | —                     | ≤ 8 ms   |
| Per-frame mirror+matrix writes | ≤ 2 ms @500 instances | —        |

Rendering strategy enforcing it: instanced billboard sprites per unit type from baked atlases (vertex-shader animation playback, zero CPU anim cost; near band 15 fps clip rate, far band >60% zoom-out throttled to 7.5 fps); true-3D InstancedMesh per building type (<150 live); NO SkinnedMesh anywhere in v1; frustum-culled instance ranges skip matrix writes; fog-of-war CPU culling; overlays (selection rings, health bars) = 2 extra draw calls total; picking via spatial hash, not mesh raycasts. Headless perf scenario asserts CPU gates in Node; GPU numbers recorded manually before sign-off.

**Testing gates (issue #11):**

- Harness: Vitest, node-only, importing `sim/` directly — jsdom needed = seam broken.
- **Digest recipe:** alphabetical component registry order × ascending eid, line format `componentName:eid:v1,v2,...`, floats hashed as exact IEEE-754 f64 bit patterns, FNV-1a-64 (`offset 0xcbf29ce484222325`, prime `0x100000001b3`), rendered `fnv1a64:<16hex>`. Milestones asserted every 30th tick + final.
- Fixtures: 32×32 maps, dozens of Pops, whole suite < 60 s. Layout `tests/golden/<slice>/{case.json,map.bin}`; commands carry absolute target ticks; recording via `npm run golden:record` only — hand-editing digests forbidden.
- Property tests: resource conservation ledger; full damage-counter table snapshot; A* termination/unreachability purity; determinism canary (every fixture runs twice, digests must match); throwing shims for `Math.random`/`Date.now` reachable from `sim/*`.
- **Per-commit required-green:** unit + all golden + canary + properties + shim test, < 60 s wall.
- **Nightly soak:** 300+ Pops, 120×120, 10k+ tick streams; digests + perf telemetry (p95 ms/tick, path-worker turnaround vs phase-2 triggers); mac+linux float-drift check; failures auto-open `nightly-soak` issues, non-blocking for PRs.
- **Agent workflow rule: a slice is not done until its golden test passes** — every sim-behavior change ships a fixture; PR body names fixtures added/changed.

---

## 8. Phased Implementation Milestones

Each milestone is independently demoable and decomposable into agent-executable tickets. Order matters; slices inside a phase parallelize cleanly once the harness exists.

### M1 — Dark-age walkable slice ✅ (shipped, sign-off ticket M1-T11)

Skeleton + harness first: vite/tsconfig/CI wiring; `sim/render` seam enforced; tile-grid world + mapgen (seeded simplex → map.bin); billboard-unit renderer + atlas-bake tool (first page); instanced building meshes + terrain splat; group-leader worker A* + formation slots + steering FSM (prototype locomotion feel ported); box-select/right-click-move/build-ghost/minimap-basic/control-groups UI; gather loop for Food/Wood/Gold/Stone with work slots, carry capacity, drop-off, auto-repeat; TC trains villagers; house/barracks placement; fog stub (all-visible provider); **golden harness + digest recipe live from the first sim slice**; perf smoke vs budget. **Demo:** drag-box villagers, send them to chop/build under a real 30 Hz loop at 60 fps.

Shipped-scope checklist (M1-T11 sign-off):

- [x] Sim core/world/layers/mapgen + digest recipe + golden harness (M1-T2/T3)
- [x] Path worker with dueTick contract + movement steering FSM (M1-T4/T5)
- [x] Render mirror, camera, terrain splat, billboards + atlas bake (M1-T6/T7)
- [x] Command UI baseline: selection, orders, groups, minimap, build ghost (M1-T8)
- [x] Gather loop: slots, carry capacity, drop-off, auto-repeat (M1-T9)
- [x] Placement, construction, TC training, pop cap (M1-T10)
- [x] Fog STUB: `VisibilityProvider` seam (`src/sim/systems/fog.ts`), all-visible implementation wired through world creation; placement explored-gate flows through the interface — real planes swap in at M2 without touching callers
- [x] Perf budget gate: 300-villager headless scenario, p95 tick < 8 ms and mirror copy < 2 ms asserted in CI (`tests/perf/budget.test.ts`); recorded run in `docs/m1-budget.md` (measured p95 ≈ 2.5–4.3 ms, mirror ≈ 0.03 ms)
- [x] Demo checklist sim-half executed end-to-end headlessly (`tests/e2e/m1-demo.test.ts`: chop → construct house+barracks → train to pop cap); browser-only visual items documented as manual checks in `docs/m1-budget.md`
- [ ] Manual browser demo pass (visual 60 fps, drag-box feel) — instructions in `docs/m1-budget.md`; not blocking M2 start

### M2 — Feudal economy + combat ✅ (shipped, sign-off ticket M2-T11)

Expanded gatherables (Iron/Coal/Clay) + Sawpit/Kiln/Smithy/Forge/Kitchen recipes (depth-1) with tools/meals effects; Age advancement II/III gating buildings/units; military units with ~8-armor-class counter table, attack-move, health bars/rings overlays; building damage/destruction + repath invalidation; full fog-of-war planes + KnowledgeView + minimap projection + memory ghosts; AI build-order + economy layers speaking the command interface; **Conquest victory**; drop-off filters, farm re-seeding. **Demo:** beat the scripted AI by conquest on a 120×120 map.

Shipped-scope checklist (M2-T11 sign-off):

- [x] Definition pipeline (Zod three-round load, stable u8 codes) + Feudal/Castle content: units, buildings, techs, recipes (M2-T1)
- [x] Expanded gatherables (Iron/Coal/Clay) + drop-off filter acceptance (M2-T2)
- [x] Depth-1 commodity production chains with tools/meals effects (M2-T3)
- [x] Age advancement ladder (Feudal/Castle) gating placement, training, research (M2-T4)
- [x] Combat core: ~8-armor-class counter table, derived stats, strikes, deaths, digest-visible event logs (M2-T5)
- [x] Military training via trainUnit, Forge equipment, attack-move, health-bar/ring overlays (M2-T6)
- [x] Building damage/destruction as attackable structures + repath-storm invalidation + rubble (M2-T7)
- [x] Real fog-of-war planes (explored/visible/contributor counts), KnowledgeView seam, minimap projection, memory ghosts (M2-T8)
- [x] AI opponent: build-order strategies + economy manager speaking the player command interface through one shared inbox, fog-honest by construction (M2-T9)
- [x] Conquest victory evaluator (symmetric, replay-safe) + skirmish game flow with restart-to-fresh-world (`src/game/session.ts`) (M2-T10)
- [x] Perf budget re-gate at M2 workload (combat+fog active, 500-unit mixed load): p95 tick < 8 ms and mirror copy < 2 ms asserted in CI (`tests/perf/budget-m2.test.ts`); recorded run in `docs/m2-budget.md` (measured p95 ≈ 6.4–6.7 ms, mirror ≈ 0.02–0.08 ms; M1 economy gate unchanged at ≈ 1.8–3.2 ms)
- [x] Demo checklist sim-half executed end-to-end headlessly vs the AI (`tests/e2e/m2-full-game.test.ts`: FC → knights → conquest push on 120×120; victory at tick 13,290 on the pinned seed); browser-only visual items documented in `docs/m2-manual.md`
- [ ] Manual browser pass (visual fps under fog+overlays, minimap readability, ghost/fog rendering) — checklist in `docs/m2-manual.md`; not blocking M3 start

### M3 — Pops deep-sim + schedules ✅ (shipped, sign-off ticket M3-T10)

Identity/traits/knowledge-vs-practice skills w/ rust; needs + staggered rare ticks + 1 Hz IAUS job selection w/ cooldowns; 6-part injuries + impairment multipliers wired into work AND combat; lifecycle (birth → child → School lesson windows → adult → elder), households + housing-driven births; day/night clock + lighting tint + sleep + deprivation; leisure venues + trait-weighted choices + social bonds + rivals; 7-day week, Sunday rest, Church Mass; morale system + Pop card UI. **Demo:** watch one village week — kids graduate, families form, tavern drama happens, nobody clicks for a minute and the town still runs.

Shipped-scope checklist (M3-T10 sign-off):

- [x] Pop identity: names/ages/origins, weighted trait generation with conflict exclusion (M3-T1)
- [x] Knowledge-vs-practice skills with rust toward the knowledge floor; work/combat XP awards (M3-T2)
- [x] Needs meters (food/rest/morale) on staggered rare ticks + 1 Hz IAUS pop job brain with per-target cooldowns (M3-T3)
- [x] 6-part injury model with stacked hediffs, impairment multipliers wired into work AND combat, heal/scar/die (M3-T4)
- [x] Lifecycle (birth → child → School lesson windows → adult → elder → natural death), households + housing-driven births, teacher-gated lessons with graduation credit (M3-T5)
- [x] Day/night clock + lighting tint on the render mirror, sleep in household beds with quality × crowding refills, deprivation penalties + naps (M3-T6)
- [x] Leisure venues (tavern/brothel/shrine/study/visits) scored by trait-weighted IAUS pulls, social bonds + rivals, jealousy drama (M3-T7)
- [x] 7-day week with Sunday rest day (essential roles only) and communal Church Morning Mass with bond reinforcement (M3-T8)
- [x] Morale system: individual break points, routing/rally, family/companion death shocks; Pop card UI (M3-T9)
- [x] Perf budget re-gate at the M3 workload (305 fully deep-simmed Pops through the daily transition zoo): p95 tick < 8 ms and mirror copy < 2 ms asserted in CI (`tests/perf/budget-m3.test.ts`); recorded run in `docs/m3-budget.md` (measured p95 ≈ 2.65–3.10 ms, mirror ≈ 0.011 ms)
- [x] Demo checklist sim-half executed end-to-end headlessly (`tests/e2e/m3-village-week.test.ts`: one fully unattended week — 5 kids graduated, 10 households formed, 5 births, 87 outings incl. 3 tavern rounds, 7 Masses, economy grew on every resource, zero player commands); browser-only visual items documented in `docs/m3-manual.md`
- [ ] Manual browser pass (Pop card visuals, lighting tint, minimap social dots, unattended-week feel) — checklist in `docs/m3-manual.md`; not blocking M4 start

### M4 — Management, companies & victory paths ✅ (shipped, sign-off ticket M4-T7)

Foremen + domain Managers with strategy sliders (override rule); Companies commissioned AND organic (treasury, branch share routing, autonomous expansion proposals, exclusive staffing, freeze/seize/dissolve, oversight panel); Knowledge/Culture/Economic generators + Grand Academy/Grand Monument/Festivals; Wonder/Relic timers; shared victory evaluator frame running symmetrically; AI military manager + disclosed difficulty knobs. **Demo:** win via each path against the AI; charter a mining company and watch it expand itself.

Shipped-scope checklist (M4-T7 sign-off):

- [x] Delegation layer: foremen + domain managers with strategy sliders, direct-order override rule at 1 Hz cadence (M4-T1)
- [x] Companies: charters, virtual treasury fed by branch output share, exclusive staffing from management-rated Pops, freeze flag (M4-T2)
- [x] Autonomous expansion (treasury-paid, AI-scorer sited, always-ask/auto-approve) AND organic foundings with grace window + severance (M4-T3)
- [x] Knowledge + Culture paths: teacher-scaled KP per lesson, research lumps, monument/happiness prestige, festivals; Grand Academy/Grand Monument sustain gates (M4-T4)
- [x] Wonder/Relic hold timers + Economic path keyed off aggregate branch market value; pause/resume hold ledger derived purely from digest rows (M4-T5)
- [x] AI military manager (rally-to-defense, density raids, counter composition) + disclosed difficulty knobs incl. hard income multiplier (M4-T6)
- [x] Perf budget re-gate at the M4 workload (305 deep Pops PLUS delegation + companies active: chartered branches tithe live deliveries, expansion thinks run, foremen seated): p95 tick < 8 ms and mirror copy < 2 ms asserted in CI (`tests/perf/budget-m4.test.ts`); recorded run in `docs/m4-budget.md` (measured p95 ≈ 2.09–2.19 ms, mirror ≈ 0.012–0.014 ms)
- [x] Demo checklist sim-half executed end-to-end headlessly vs the AI (`tests/e2e/m4-paths.test.ts`: all SIX §2.11 paths decided for the scripted player against the real fast-castle-knights AI on pinned seed 20260902 — conquest t16,800, knowledge t3,870, culture/wonder/relic t960, economic t4,380) plus BOTH company origins in one unattended run (`tests/e2e/m4-company-growth.test.ts`: commissioned self-expansion THEN an organic founding absorbing three profitable direct workplaces); browser-only visual items documented in `docs/m4-manual.md`
- [ ] Manual browser pass (oversight panel, victory HUD, difficulty badge, fps under the full stack) — checklist in `docs/m4-manual.md`; not blocking M5 start

### M5 — Polish, audio, save/replay, ship ✅ (shipped, sign-off ticket M5-T6)

Audio buses/voice pool/positional panning/jingles/ambient crossfades + curated CC0 music; save/load (IndexedDB slots + autosaves + `.ageof` export/import + digest verification); replay export/import + bug-report-to-fixture flow; LOD zoom bands + far-band throttle tuning; full perf verification vs §7 tables; balance pass on counter table + economy rates; GitHub Pages + itch.io release workflow; final UX pass from prototype checklist. **Demo:** the shipped URL with saves, replays, sound, and all victory paths.

Shipped-scope checklist (M5-T6 sign-off):

- [x] Audio architecture: gesture-gated buses (master/music/sfx/ui/ambient), voice pool with priority culling + coalescing, StereoPannerNode positional pan, jingle/ambient intents — render-loop scheduled, sim-invisible (M5-T1)
- [x] Save/load: `.ageof` container (AOF1 header, FNV map hash, fflate payload) with digest-verified restore, IndexedDB rolling autosaves + named slots, file export/import with loud validation (M5-T2)
- [x] Replays: record/export/import (`.ageofreplay`), headless re-replay through the pause menu, bug-report → golden fixture via `npm run replay:to-fixture` (M5-T3)
- [x] Render polish & UX sweep: LOD zoom bands with far-band 7.5 fps playback throttle, dev draw-call HUD, settings panel (audio buses / AI difficulty / autosave cadence), §2.13 checklist verdicts incl. minimap dot split and Pop-card impairment line (M5-T4)
- [x] Balance pass on engagement + economy ramp (`docs/balance-m5.md`), six-path e2e still decided on pinned seed 20260902 post-balance (M5-T5)
- [x] Release workflow `.github/workflows/release.yml`: tag `v*` → full gate → `vite build` with relative base → GitHub Pages deploy + dist zip release asset for manual itch.io upload (M5-T6)
- [x] Final full-suite perf verification vs §7 tables recorded in `docs/m5-budget.md` (all four workloads ×5 runs: p95 tick ≤ 7.27 ms worst workload vs 8 ms cap, mirror copy ≤ 0.08 ms vs 2 ms cap, draws 10–11 approx)
- [x] README quickstart: npm install → dev server → first villager, saves/replays/settings pointers, controls table
- [ ] Manual browser pass (GPU frame time/triangles, LOD band feel, audio mix by ear, itch.io upload) — checklist in `docs/m5-manual.md`; recorded draw-call audit already inside caps

### Wayfinder Map 2 — AoE2 look & feel (V1–V12) ✅ (shipped, sign-off issue #83)

Complete visual and content overhaul to eliminate prototype feel and achieve full AoE2 aesthetic fidelity: real 3D building models across all ages, 8-direction baked sprite atlases for full military rosters, day/night lighting with dawn boot, fortifications, market & trade, full combat feedback, audio SFX, and ambient environmental shaders.

Shipped-scope checklist (V12 / #83 sign-off):

- [x] CC0 3D asset acquisition, inventory, and licensing mapped across Quaternius & KayKit packs (V1 / #70)
- [x] 8-direction unit sprite rendering pipeline with multi-page atlas UV fix and zero invisible units (V2 / #73)
- [x] 3D instanced GLTF building models replacing all prototype boxes across 37 variants and 4 ages with timber scaffolding (V3 / #74)
- [x] Lighting overhaul: 7:00 AM dawn boot, directional sun shadows, readable midnight navy lighting (V4 / #75)
- [x] Fortifications: palisade/stone walls, directional gates, watchtowers, and Castle (V5 / #76)
- [x] Victory-act architectural landmarks: Wonder, Grand Academy, Grand Monument (V6 / #77)
- [x] Natural world enhancements: procedural tree models and dynamic water shimmer (V7 / #78)
- [x] Full military lines: Barracks (Militia→Longswordsman), Archery Range (Archer→Arbalest), Stable (Scout→Paladin) + 13 branch techs (V8 / #79)
- [x] Market economy: Market building, trade cart routing, gold payout scaling, commodity exchange (V9 / #80)
- [x] Audio SFX pack & combat hit/death feedback: hit flash, death collapse, corpse linger & fade (V10 / #81)
- [x] Polish & juice: animated selection rings, rally pennant flags, chimney smoke particles, wind tree sway, UI transitions (V11 / #82)
- [x] Canonical 5-scene screenshot suite (dawn village, field battle, night settlement, fog frontier, victory overlay) committed to `docs/screenshots/`, M1–M4 budget gates green, Wayfinder Map 2 (#69) destination reached (V12 / #83)

---

## 9. Open Risks & Mitigations

| Risk                                                              | Mitigation                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bitecs v0.4 API friction slows agents                             | Sanctioned hand-rolled fallback store (ADR-0001); registry abstraction isolates the swap                                                                           |
| Determinism leaks (platform float drift, hidden randomness)       | Integer path costs; sin/cos LUTs; f64-bit-pattern hashing; double-run canary; throwing shims; mac+linux nightly                                                    |
| 300–500 Pops @30 Hz exceeds tick budget                           | Tick tiering (rare ticks, 1 Hz think); measured triggers before optimizations; nightly soak telemetry; envelope floor drops to 300 before features cut             |
| Worker latency stalls under GC pauses                             | dueTick blocking contract (bounded like frame clamp); PATH_LATENCY=2 hides sub-frame latency                                                                       |
| Atlas bake pipeline complexity / rig mismatch                     | Headless three.js bake (no Blender dep); rigs matter only at bake time; KayKit family for military, Quaternius for villagers; PNG pages, deterministic compositing |
| Icon gap forces CC-BY compromise                                  | Resolved: in-house SVG icons, strict CC0 maintained                                                                                                                |
| Anno-sprawl from commodity chains                                 | Depth-1 hard rule; deeper chains schema-supported but content-blocked                                                                                              |
| Emergent company/social chaos (organic foundings, mistress drama) | Grace-window dissolution; freeze flags; all events abstracted management mechanics; expansion log audit trail                                                      |
| Browser autoplay policy breaks audio                              | Gesture-gated AudioContext + resume; audio strictly post-gesture                                                                                                   |
| IndexedDB eviction loses saves                                    | Rolling autosaves + prominent file export; `.ageof` self-describing                                                                                                |
| Golden fixtures churn during early flux                           | Fixtures added per-slice from M1 onward; digests regenerated only via `golden:record` and reviewed in PR                                                           |
| Scope creep beyond decisions                                      | This SPEC is the boundary; changes require a new decision ticket, not silent drift                                                                                 |
| Remote main missing docs (CONTEXT/ADRs unmerged)                  | Blueprint branch carries them; merge `main` → `origin/main` alongside this branch                                                                                  |

---

_Source decisions: issues #1–#22 on jamesm944/game; ADRs 0001–0003; `docs/research/{rts-engine-patterns, cc0-asset-survey, pop-sim-sources, rw-df-mod-donors}.md`; prototype/command-control._

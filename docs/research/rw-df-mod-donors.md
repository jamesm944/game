# Research: RimWorld Mod & Dwarf Fortress Mod/DFHack Donors

- **Issue:** [jamesm944/game#13](https://github.com/jamesm944/game/issues/13)
- **Branch:** `research/rw-df-mods`
- **Date:** 2026-08-21
- **Question:** Per the standing rule — prefer RimWorld mods AND Dwarf Fortress mods/DFHack as donors for every feature — which specific mods/repos should we mine for each subsystem, what is their license verdict, what is their internal architecture, and what transfers to bitecs SoA ECS at 30Hz?
- **Scope:** NEW coverage only — RimWorld mods (CSL, Psychology, Combat Extended, VEF, HAR, standout economy/AI/UI mods), DF raws-as-schema + DFHack internals (event streams, job manager, unit/injury structures, Lua patterns), plus non-RW/DF engines where they beat both (OpenTTD cargo chains, OpenRA orders/conditions, Factorio data lifecycle). Base-game mechanics are covered by `pop-sim-sources.md`; engine-level RTS patterns by `rts-engine-patterns.md`.
- **Method:** Primary sources only — LICENSE files fetched directly from each repo (raw.githubusercontent / GitHub contents API), DFHack's own docs site and plugin tree inspected, workshop pages read for workshop-only mods, official API doc sites (docs.dfhack.org, docs.openra.net, lua-api.factorio.com, wiki.openttd.org). Every license verdict below was read off the primary file this session unless explicitly marked otherwise.
- **License posture:** unchanged from `pop-sim-sources.md` §"License nuance": project is private/never distributed, so obligations attach on conveyance only; we still record verdicts so a future open-source decision is cheap. RimWorld EULA bars extracting vanilla assets/code — that ban extends in spirit to NoDerivatives-licensed mods.

---

## TL;DR

1. **The permissive RimWorld donors are real and better than expected**: Humanoid Alien Races (**MIT**, verified `license.md`), Pick Up And Haul (**MIT**), WorkTab (**MIT**), Taranchuk's RimWar (**MIT**) — actual transcription candidates, not just inspiration.
2. **Combat Extended is CC BY-NC-SA 4.0 and VEF is CC BY-NC-ND 4.0** (LICENSE fetched and read this session). ND means *no derivatives* — VEF code must stay an architecture reference even under our private-use posture. CE's NC-SA is usable-but-flagged. Both are still top-tier *mechanics* donors.
3. **CSL has no public code** (workshop-only, id 1541438230; also ticket correction: author is Dylan/dxdlan, *not* Lycanite) — mine its workshop description for the school model; it validates our School design almost point-for-point.
4. **Psychology's repo has no LICENSE file** — all rights reserved despite being public; read-as-reference only. Its psyche-vs-traits split and conversation-opinion model are the best available blueprint for social simulation.
5. **DFHack is Zlib** (core, plugins, scripts — LICENSE.rst read this session): its `workflow`/`orders` plugins are literal prior art for our production-chain auto-ordering, and `eventful`'s event stream maps 1:1 onto bitecs event buses. Copy freely with attribution.
6. **DF raws are a schema masterclass**: `reaction` = our Recipe definition (inputs→outputs, skill gate, required building) fifteen years before we invented it; `df.unit.xml` (194 KB of pure structure) shows how far "game logic as data" goes.
7. **Cross-engine steals**: OpenRA's condition system (`ConditionalTrait` + `GrantCondition*`) solves buff/debuff composition without inheritance hell in an ECS; OpenTTD's link graph shows how to route supply/demand through multi-step chains off-thread while staying deterministic; Factorio's three-round prototype stage is the right shape for our Entity-definition load order.

---

## Part A — RimWorld mods

### A1. Combat Extended (injury/vitals/combat layering)

- **Repo:** https://github.com/CombatExtended-Continued/CombatExtended (active; original by NoImageAvailable archived 2020)
- **Workshop mirror:** https://steamcommunity.com/sharedfiles/filedetails/?id=2890901044
- **License (verified from README/LICENSE):** **CC BY-NC-SA 4.0** — "This mod is a continuation and expansion of the original Combat Extended and is used under the Creative Commons 4.0 License." ShareAlike + NonCommercial: fine privately; never mix transcriptions into anything shippable.

#### Architecture worth mining

| System | Where | Pattern |
|---|---|---|
| Ballistic projectiles | `Source/CombatExtended/Projectiles/` | Bullets are entities with position/velocity/height flying along trajectories that intersect hitboxes — replaces vanilla's per-shot RNG roll. Damage becomes a *spatial* question. At 30Hz in bitecs: projectile component `{pos, vel, height, damageDef}` iterated in one movement system; hit detection against capsule/AABB hitshapes. |
| Armor | `ArmorUtility` classes | Penetration-deflection model: `armorPenetration` vs `armorRating` sharpness/shock/heat categories, partial penetration → blunt trauma. Replaces flat % reduction. Maps to two float comparisons in our combat system. |
| Medical/bleeding | Hediff extensions (`HediffComp_TendDuration`, stabilization comps) | Bleed rate summed per wound; **stabilize** temporarily suppresses total bleed rate, wears off over time; internal/destroyed organs bleed faster and can't be stabilized as effectively. This is a *hediff stack + aggregate query* — exactly the injury-stack shape from CONTEXT.md. |
| Ammo/loadouts | Defs/Ammo*, `Loadout` comps | Ammo is pure Def data (classes, calibers, recipes); loadouts are declarative item lists pawns keep topped-up via a hauling-like job. Lesson: consumable logistics = data + a generic "keep inventory at target" job, reusable for our arrows/rations. |
| Body-part coverage | `BodyPartDef` patches | Hit probability distributed over body-part coverage values; vital organs rebalanced (torso hits more likely lethal). Feeds straight into our injury table. |

#### Verdict
**Copy mechanics** (NC-SA blocks comfortable transcription long-term). The bleed-aggregate + stabilize-decay loop is the strongest RPG-combat injury model in any RimWorld mod and slots into a bitecs `Injury` component stack cleanly.

---

### A2. Children, School and Learning — CSL (school/family)

- **Workshop:** https://steamcommunity.com/sharedfiles/filedetails/?id=1541438230 (v1.7.8.0, maintained for RW 1.6); school-only fork "CSL – Light": https://steamcommunity.com/sharedfiles/filedetails/?id=3573095529
- **Ticket correction:** CSL is by **Dylan (dxdlan)**, not Lycanite — Lycanite's GitHub holds Minecraft-era projects only.
- **License verdict:** **workshop-no-code** — no GitHub repo exists (GitHub search returned nothing for CSL mirrors), no stated license ⇒ all rights reserved; mine the *description* only, which is unusually detailed.

#### Mechanics mined from the workshop description (primary text)

- Children born age 7 (configurable; 0 with Biotech) — pregnancy inherits parents' looks/skills (inheritance toggle), passions/traits random. Our Family component gets birth-weighted inheritance for free from this spec.
- **Teaching stations**: blackboard + school-table are buildings that host lessons; a schedule tab per station defines when schooling outranks normal work — i.e., *schooling is a scheduled job slot at a building*, not a global mode. Directly transferable: our School building advertises a `Lesson` job candidate; children take it during scheduled windows.
- **Teacher gating**: teacher needs intellectual ≥3–5 else teaches less, plus ~7 in the taught subject. Room quality and relevant materials (raw food for cooking class…) multiply XP gained; factors displayed in the schedule tab. That's a utility-scored job with skill-gated effectiveness and environmental multipliers — same shape as our IAUS considerations.
- Students learn until a configurable cap age (16). Learning consumes materials — schools have running costs, not just presence.

#### Verdict
**Copy mechanics** (nothing else available). CSL proves the exact loop CONTEXT.md specifies — child + School building + skilled teacher + materials + schedule — is implementable as data + one job system, and gives concrete tuning numbers (teacher thresholds, age caps).

---

### A3. Psychology (personality engine)

- **Repo:** https://github.com/rwpsychology/Psychology (original author FluffierThanThou)
- **License verdict:** **NO LICENSE FILE in repo** (top-level listing: About/, Assemblies/, Defs/, Patches/, Source/, Textures/ — no LICENSE). All rights reserved; **read-as-reference only**. Do not transcribe even privately without asking.

#### Architecture worth mining (from Source/ + README)

- **Psyche separate from traits**: `Psyche` object holds continuous personality dimensions (near-Big-Five: extroversion, neuroticism-style axes) independent of gameplay Traits. Two parallel layers — scalar personality drives *social* behavior; discrete traits drive *mechanical* modifiers. This is precisely the DF-facet/innate-trait split from `pop-sim-sources.md`, implemented in anger.
- **Conversations as opinion deltas**: pawns passing or working near each other fire topic-based conversations; each topic's enjoyment scales from both psyches, producing opinion changes. Implementation shape: proximity check (rare-tick) → pick topic weighted by speaker dimensions → apply `opinionDelta` to relationship map. Cheap, staggered, emergent.
- **Compatibility ratings**: pairwise derived score from psyche distance buffers friendships/rivalries — relationships get *quality*, not just sign.
- **Elections/mayor**: colony-wide events driven by personality-platform matching (candidates' platforms derive from their psyches; votes align by similarity). Blueprint if we ever want settlement leadership for victory paths.
- **Trait-conditioned mental breaks**: break type selected by personality (anxiety/depression-flavored conditions replace vanilla's generic ones).

#### Verdict
**Copy mechanics.** The psyche-dimensions layer + conversation-opinion loop is our best template for family/social drama (grudges, marriages) beyond what DF wiki constants give us.

---

### A4. Vanilla Expanded Framework (framework patterns)

- **Repo:** https://github.com/Vanilla-Expanded/VanillaExpandedFramework
- **Workshop:** https://steamcommunity.com/sharedfiles/filedetails/?id=2023507013 (1.98M subscribers — the largest framework in the ecosystem)
- **License (verified — LICENSE file fetched raw this session):** **CC BY-NC-ND 4.0** (the workshop FAQ elsewhere mislabels it SA; the file says NoDerivatives, with explicit carve-outs for streamers and dependent-mod authors). FAQ also answers "Can I take your code and put it in my mod?" with "**No.**"

#### Patterns worth mining (architecture reference only)

- **Shared-comp library instead of per-mod forks**: everything is `ThingComp` subclasses registered per-def in XML (`comps: [{compClass: VE.X}]`). One deep framework assembly serves hundreds of content mods. For us: the equivalent discipline is *one shared behavior keyed by data flag*, never copy-pasted systems per entity type — bitecs systems + a `flags`/`kind` field achieve this without OOP comps.
- **Def-modding surface**: features ship as XML-linkable classes with documented wiki pages (github.com/Vanilla-Expanded/VanillaExpandedFramework/wiki) — i.e., the framework's contract is *data-first*. Our Entity definitions should expose the same: every behavior reachable from JSON, never from code edits.
- **Effect composition**: custom gizmos/UI tabs/hediff behaviors composed additively per def — no inheritance trees over content defs. Mirrors OpenRA conditions (§C2) as the third independent confirmation of composition-over-inheritance.

#### Verdict
**Copy nothing; imitate structure.** ND license + explicit refusal makes VEF the cleanest "look, don't touch" donor. Its value is proving the data-first framework contract at massive scale.

---

### A5. Humanoid Alien Races (body architecture)

- **Repo:** https://github.com/erdelf/AlienRaces
- **Workshop:** https://steamcommunity.com/sharedfiles/filedetails/?id=839005762
- **License (verified — license.md read this session):** **MIT** ("Copyright (c) 2018 Simon Latusek"). ✅ Best-license large RimWorld codebase.

#### What transfers

- **Race/lifestage definitions are pure XML**: `ThingDef_AlienRace` with lifeStage lists changing graphics, body size, hair/skin — **aging expressed as lifestage-keyed visual/stat overrides**. Our Pop aging (child→adult→elder) wants exactly this: `LifeStageDef[] { minAge, bodyScale, allowedJobs… }` as data, one system interpolating.
- Weighted color/trait pools, forced traits per race, thought overrides, relation chances, race-restricted clothing/weapons/bills — a full worked example of "population variant = data profile", applicable if we ever add culture/faction variants of Pops.
- Body-addon drawing keyed to backstory/disease/implants — precedent for rendering injuries/equipment as layered sprite attachments rather than bespoke models.

#### Verdict
**Copy code AND structures** (MIT). Most useful concretely for the lifestage/aging data schema; port the shape to JSON Entity definitions.

---

### A6. Standout economy/AI/UI mods

| Mod | Repo / License (verified via GitHub API this session) | What to steal |
|---|---|---|
| **Pick Up And Haul** | https://github.com/Mehni/PickUpAndHaul — **MIT** (c) 2018 Mehni | Hauling job picks up *multiple compatible items up to carry capacity* then sweeps to stockpile — the AoE2 villager carry model done right. Its jobdriver (reserve goods → fill inventory → deliver) is the direct ancestor of our gatherer role loop. |
| **WorkTab** | https://github.com/fluffy-mods/WorkTab — **MIT** (LICENSE: "The following MIT license applies to the software and any documentation") | Priority matrix UI (priorities 1–4 per pawn × worktype) + hour-by-hour scheduler columns. Even if our UX is different, its data model (two-axis assignment grid, resolved to per-pawn ordered job list each rare tick) is the clean way to let players override IAUS. |
| **RimWar** | https://github.com/Taranchuk/RimWar — **MIT** | Faction-level strategic AI: world-object "armies" moving between settlements, faction power scores, expansion/war decisions decoupled from map-level sim. Closest open donor for our **AI opponent** strategic layer — simulate opponent economy/armies at low frequency, resolve contact battles in the tactical sim. |
| **Hospitality** | https://github.com/OrionFive/Hospitality — **GPL-3.0** | Visitor/guest lifecycle (wants, entertainment, recruitment) — mechanics only; useful if neutral traders/diplomats ever matter to victory paths. |
| **Common Sense** | https://github.com/catgirlfighter/RimWorld_CommonSense — **no LICENSE** (reference only) | Autonomous micro-behaviors (self-clean, extinguish nearby fire) gated by thresholds + hysteresis — the pattern for Pops interrupting haul routes for urgent needs without decision thrash. |
| **Achtung!** | Workshop-only, no public repo | Queueing/multi-order UX notes only (queue-move with modifier keys). Our command UX already leans on OpenRA activities (§C2) for this. |

---

## Part B — Dwarf Fortress side

### B1. Classic raws as schema lessons

- **Sources:** dwarffortresswiki.org [Modding](https://dwarffortresswiki.org/index.php/Modding), [Creature token](https://dwarffortresswiki.org/index.php/Creature_token), [Reaction](https://dwarffortresswiki.org/index.php/Reaction), [Entity token](https://dwarffortresswiki.org/index.php/Entity_token). Wiki licensing (GFDL & MIT dual) verified in `pop-sim-sources.md` §3 — text remains liftable with attribution.
- The raws predate every "modern" data-driven design and still hold up:

| Raw format | Schema lesson for us |
|---|---|
| `creature_*.txt` | Creature = BODY plan (part hierarchy w/ connective tokens) + tissues layered onto parts + castes (gender/variant profiles within one species) + attacks referencing body parts. Our Pop body/injury schema should be: `BodyPlan` (parts w/ parent links, HP, functions) referenced by name, tissues optional depth. Castes = free faction/culture variation. |
| `reaction_*.txt` | **`reaction` ≡ our Recipe**: `[REACTION:X]`, building token, N× input item/material tags (with category-or-specific matching), output item + quantity, skill token, optional skill XP. Fifteen years of modders extending economies on this exact shape validate CONTEXT.md's Recipe definition — including the trick of *input categories* (any-wood) vs specific mats. |
| `entity_*.txt` | Civilization profile: which creatures/jobs/reactions/weapons a civ *permits* — i.e., faction variants are allow-lists over the same global defs, not new defs. Our AI opponent's tech/economy identity can be an entity-style permit list. |

### B2. DFHack (github.com/DFHack/dfhack)

- **License (verified — LICENSE.rst fetched this session):** **Zlib** for core, plugins, and scripts ("DFHack is distributed under the Zlib license… The core, plugins, scripts, and other DFHack code all use the ZLib license unless noted otherwise"), with MIT/BSD vendored components listed in-file. ✅ Transcription-friendly with attribution.
- **Docs:** https://docs.dfhack.org (Lua API page read this session for the interfaces below).

#### Internals mapped to our needs

| DFHack piece | File(s) | Pattern for bitecs @ 30Hz |
|---|---|---|
| **Event streams** | [`plugins/eventful.cpp`](https://github.com/DFHack/dfhack/blob/develop/plugins/eventful.cpp) + EventManager | Registered listeners for `onJobInitiated(job)`, `onJobCompleted` (needs frequency 0 to distinguish cancel vs complete — note the *edge-detection caveat*), `onUnitDeath(unit_id)`, `onItemCreated`, `onSyndrome`, `onInventoryChange`, `onBuildingCreatedDestroyed`, `onInvasion`. This is exactly an event-bus fed by system hooks: our production/combat/victory systems emit typed events; achievements, morale, and history-recording subscribe. Deterministic because emission points are fixed tick boundaries. |
| **Job manager** | `library/include/modules/Job.h` + Lua `dfhack.job.*` (documented at docs.dfhack.org) | `cloneJobStruct`, `linkIntoWorld(job,new_id)` against a monotonically increasing `job_next_id`, `listNewlyCreated(first_id)` (delta-scan by ID range — cheap incremental job discovery), and **`setJobCooldown(building,worker,timeout)`** — per-building per-worker cooldown after leaving a job, preventing flicker reassignment. That cooldown is the missing piece vs naive IAUS: commitment windows per (building, pop) pair. |
| **Production-chain automation** | [`plugins/workflow.cpp`](https://github.com/DFHack/dfhack/blob/develop/plugins/workflow.cpp) (~49 KB) | Persistent *production orders*: user declares "keep ≥30 planks"; workflow watches item counts, subtracts in-flight jobs, re-queues crafting jobs when net stock < target. Literal prior art for our production chains — targets as data, a monitor system diffing stock+committed vs target each Rare tick. |
| **Order import/export** | [`plugins/orders.cpp`](https://github.com/DFHack/dfhack/blob/develop/plugins/orders.cpp) | Manager orders serialized to/from plain JSON files for sharing — proof our build-order presets (AI opening strategies!) should just be JSON order lists applied to the queue. |
| **Labor assignment** | [`plugins/autolabor/`](https://github.com/DFHack/dfhack/tree/develop/plugins/autolabor) (+ labormanager) | Scores each idle dwarf × each labor (skill, distance, priority weights) and assigns lowest-cost pairs with hysteresis to avoid flip-flopping — batch bipartite-lite assignment run at intervals. Our villager-role allocator is this with fewer labors. |
| **Unit schema** | [DFHack/df-structures](https://github.com/DFHack/df-structures) → [`df.unit.xml`](https://github.com/DFHack/df-structures/blob/master/df.unit.xml) (≈194 KB of pure structure definition, confirmed this session) | The reverse-engineered ground truth of a simulated person: personality facet vectors, `status.misc_traits`, body-component + `body_part_status` bitfields (infection/nerve/broken flags per part), counters for hunger/thirst/sleep, relationships, soul/skill arrays. Read it as a *checklist of Pop-component fields* — anything DF tracks for 40 years is probably worth a column. |
| **Lua game-logic-as-data** | `hack/lua/*`, `scripts/modtools/*` | modtools scripts turn gameplay rules (reactions, triggers, events) into declarative script tables so raws+saves stay self-contained — same goal as our "Entity definitions + shared systems" rule; validation that the boundary holds even under heavy modding. |

### B3. Other DF mod ecosystem notes

Steam-workshop DF mods (Meph/Masterwork lineage, graphics packs) are almost entirely **raw-text content packs** — no compiled logic — so they donate *balance data and content schemas*, not architecture. Nothing beats df-structures + the wiki for our purposes; skip unless we need content volume later.

---

## Part C — Beyond RimWorld/DF (flagged briefly)

### C1. OpenTTD — cargo chains & routed demand

- **Repos/docs:** https://github.com/OpenTTD/OpenTTD (GPL-2.0), [`docs/linkgraph.md`](https://github.com/OpenTTD/OpenTTD/blob/master/docs/linkgraph.md), wiki ["Passenger and cargo distribution"](https://wiki.openttd.org/en/Manual/Passenger%20and%20cargo%20distribution), source `src/linkgraph/`.
- **Link graph** = per-cargo connected component of stations/industries; edges accumulate capacity/usage stats; **multi-commodity flow (MCF)** distributes demand to destinations; stats **compress periodically** (COMPRESSION_INTERVAL 256 days) so history stays bounded.
- **Determinism trick:** graph recalculation runs as asynchronous `LinkGraphJob`s joined at predefined synchronization points — expensive flow math off the hot path without breaking save/replay determinism. For us: run production-chain flow analysis as a budgeted job spread across ticks (or a worker), joining before the tick that consumes results.
- Steal for: multi-hop commodity flows (ore→iron→tools), demand propagation upstream, and per-edge saturation overlays (their smallmap overlay = our trade-route debug view).

### C2. OpenRA — order pipeline & condition system

- **Repo:** https://github.com/OpenRA/OpenRA (GPL-3.0), auto-generated trait reference: https://docs.openra.net/en/release/traits/
- Orders are value objects (`order string + Target + queued flags`) flowing through an `OrderManager` to `IResolveOrder` traits, which enqueue **Activities** (queues, not interrupts). Replays store *orders only* and replay deterministically — the existence proof that our command layer can be a thin order log over the sim.
- **Condition system** (the big steal): `ConditionalTrait` base + dozens of `GrantConditionOn*` / `ExternalCondition` traits; boolean named conditions enable/disable behaviors. Plus multiplier traits (`FirepowerMultiplier`, `SpeedMultiplier`, `DamageMultiplier`) that stack conditionally. Translation to bitecs: injuries/traits/auras grant named condition tags; modifier systems sum multipliers over tags — **buff/debuff composition with zero inheritance**. Third independent confirmation after VEF and RimWorld moodlets.
- Their `[Desc("…")]`-generated trait docs are also the nicest doc-from-code workflow to copy for our Entity definitions.

### C3. Factorio — data lifecycle discipline

- **Docs:** https://lua-api.factorio.com/latest/auxiliary/data-lifecycle.html (primary, read this session); vanilla prototypes tracked at https://github.com/wube/factorio-data (Wube content — read-as-reference, no open license).
- Three stages with strict contracts: settings → **prototype stage** in three global rounds (`data.lua` → `data-updates.lua` → `data-final-fixes.lua`; each round completes for *all* mods before the next, so cross-def edits always find their targets; Lua state then discarded) → control stage (event handlers only, `storage` persisted, migrations for save upgrades).
- Adopt for our Entity-definition loader: round 1 define all defs → round 2 resolve cross-references/patch (techs unlocking recipes, counter bonuses) → round 3 final-fixes; then freeze. Runtime reads immutable processed defs; save migrations versioned separately. Kills an entire class of load-order bugs before they exist.

---

## Adoption table

| Our feature area | Donor(s) | Approach | Code-vs-mechanics |
|---|---|---|---|
| **Pop skills/traits/needs/aging** (base) | *(see `pop-sim-sources.md` — CDDA, DF wiki, RimWorld base)* | — | — |
| **Pop body/lifestage schema** | HAR (`erdelf/AlienRaces`, MIT) + DF `creature` body plans | LifeStageDef array (minAge, scale, gates) as JSON; BodyPlan part-graph referenced by name | **Code + structures** (MIT) |
| **School / education** | CSL workshop description (Dylan) + WorkTab scheduler | School building advertises lesson jobs; teacher skill-gated; room/material multipliers; scheduled windows override work | **Mechanics** (workshop-no-code) |
| **Family/social drama** | Psychology (no license — reference) + DF facets | Psyche dimension vector + conversation→opinion-delta loop on rare tick; compatibility scores | **Mechanics** |
| **RPG combat injuries/vitals** | Combat Extended (CC BY-NC-SA) + DFHack `df.unit.xml` bitfields | Injury hediff-stack: per-wound bleed, aggregate bleed query, stabilize-with-decay; body-part status bitfield per Pop | **Mechanics** (SA-flagged) |
| **Buff/effect composition** | OpenRA conditions (GPL-3) + VEF comps (CC BY-NC-ND, reference) | Named condition tags grant/remove; multiplier systems sum over tags; zero inheritance | **Mechanics** (both flagged) |
| **Economy / production chains** | DFHack `workflow`+`orders` (Zlib) + OpenTTD link graph (GPL-2) | Keep-target production orders monitored net-of-committed each Rare tick; per-commodity flow graph with periodic stat compression; order presets as JSON | **Code OK** (Zlib) + mechanics (GPL-2) |
| **Villager roles / hauling** | Pick Up And Haul (MIT) + DFHack autolabor (Zlib) | Capacity-filling haul jobdriver; scored labor×idle assignment with hysteresis | **Code OK** (both) |
| **Player overrides / command UX** | WorkTab (MIT) + OpenRA activities/orders (GPL-3) | Two-axis priority grid resolved over IAUS defaults; commands as queued activity order-log | **Code OK** (MIT) + mechanics |
| **Victory paths** | RimWar (MIT) + Hospitality (GPL-3, light) | Strategic-layer objectives as faction power/goal scores evaluated off-tick; diplomacy-adjacent paths borrow visitor-lifecycle loops | **Code OK** (MIT) + mechanics |
| **AI opponent** | RimWar (MIT) + DFHack orders.cpp JSON presets | Opponent economy/armies simulated as low-frequency world objects; opening strategies as JSON build-order lists | **Code OK** (MIT) |
| **Def loading discipline** | Factorio data lifecycle (docs, proprietary impl) | Three-round def resolution (define→patch→final-fix), freeze, immutable runtime defs | **Mechanics** |

## Suggested next tickets
1. Port DFHack `workflow` semantics (targets, committed-stock accounting, re-queue cadence) into a `ProductionOrder` spec citing this doc.
2. Define the Pop `BodyPlan`/lifestage JSON schema from HAR's XML shapes + `df.unit.xml` field checklist.
3. Spec the condition-tag + multiplier composition layer (OpenRA-style) before implementing traits/injuries, so both consume it.

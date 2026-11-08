# Dwarf Fortress & RimWorld — Systems Worth Porting & Ranked Donor Inventory

- **Issue:** [jamesm944/game#142](https://github.com/jamesm944/game/issues/142)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140) (Wayfinder Map 6: AAA Supremacy)
- **Date:** 2026-10-17
- **Branch:** `research/df-rw-deep-sim`
- **Extends:** [`pop-sim-sources.md`](./pop-sim-sources.md) (which vetted CDDA, OpenXcom, DF wiki, HAR, PickUpAndHaul, DFHack) and [`rw-df-mod-donors.md`](./rw-df-mod-donors.md)
- **Scope:** Survey 13 major simulation systems across Dwarf Fortress (vanilla mechanics, DFHack structures, wiki specifications) and RimWorld (vanilla behaviour, Harmony-free mod architectures, popular community mods) for inclusion in this browser-based, single-player RTS. Evaluate runtime performance in TypeScript + bitecs + Three.js at 30Hz, legal/licensing boundaries, gap analysis against the existing sim, and produce a ranked donor inventory.

---

## 1. The Licence Boundary (Read First)

| Source | What it is | Licence (verified) | What we may do |
| :--- | :--- | :--- | :--- |
| **Dwarf Fortress wiki** | Community-documented mechanics & constants | **MIT and GFDL** (see `pop-sim-sources.md` §3, from the wiki's Copyrights page) | Quote/adapt text, level tables, and formulas into specs/ADRs with attribution. |
| **Dwarf Fortress (game, raws)** | Closed source, Bay 12 Games | Proprietary | **Ideas and observable mechanics only.** Mechanics are uncopyrightable. No code/data/assets. |
| **DFHack** | Open tooling around DF | **Zlib** for core, plugins, scripts; MIT/BSD for bundled deps; JSON.lua is CC-BY-SA ([LICENSE.rst](https://raw.githubusercontent.com/DFHack/dfhack/develop/LICENSE.rst)) | Zlib code may be copied/adapted (keep notice, mark changes). Do **not** take DF-derived graphics. |
| **RimWorld (game code/art)** | Closed source, Ludeon Studios | Proprietary EULA | **Ideas only.** Decompiling for reference/modding is tolerated by Ludeon, but redistribution of code/assets or standalone extraction is prohibited. Never paste decompiled code or Defs text into this repo. |
| **RimWorld mods (Harmony-free)** | Third-party C#/XML | **Per-repo**. Vetted: HAR (MIT), PickUpAndHaul (MIT), WorkTab (MIT), RimWar (MIT). Combat Extended (CC BY-NC-SA). | Copy only from permissive repos (MIT/Zlib); mods that embed vanilla Defs inherit Ludeon's restrictions. |
| **Cataclysm: DDA, OpenXcom** | Open games | CC-BY-SA 3.0 / GPLv3 (in `pop-sim-sources.md`) | Mechanics only for GPL; CC-BY-SA needs attribution/share-alike if code is transcribed. |

**Conclusion for the brief:** "Copy code" is realistic for **DFHack (Zlib)**, **MIT-licensed RimWorld mods**, and **wiki-documented DF formulas**. Vanilla RimWorld and DF are _idea_ donors; we reimplement behaviours cleanly in bitecs. This is not a limitation in practice — the mechanics below are small, well-documented algorithms.

---

## 2. What We Already Have (Gap Analysis)

Grepped `src/sim`:
- **Components present:** `body, needs, morale, skills, relationship, household, faith, culture, lessons, jobCooldown, socialEvents`
- **Systems present:** `injuries, lifecycle, needs, morale, skills, social, schedules, school, households, companies, management, market`
- **AI present:** `popBrain` (IAUS utility scorer), `tradeManager`

→ Individual Pops with traits, skills, 6-part bodies with stacked injuries, needs (food/rest/morale), family bonds, schooling, weekly schedules, delegated management, and player companies **already exist**.

**Search hits in `src/sim` for candidate systems:**
- *Mental break, storyteller/incident director, temperature, weather, z-level, fluid/flood, room/beauty, caravan, disease/plague, legends/history:* **0 files each.**
- *Fire:* present in 19 files, but exclusively naval/fire-ship combat, not terrain fire propagation.

---

## 3. Deep-Dive System Evaluation (All 13 Systems)

---

### System 1: Thought/Mood Ledger & Mental Breaks
- **Primary References:**
  - RimWorld: `ThoughtDef`, `Thought_Memory`, `Thought_Situational`, `MentalBreakDef`
  - DF Wiki: [Personality facet], [Stress], [Tantrum]
- **What It Does:**
  Morale currently exists as a single scalar meter decaying on the Rare Tick. In RimWorld/DF, mood is the sum of an explained, stacked ledger:
  - *Situational thoughts:* Derived on read (e.g. *Starving* -15, *Slept in cold* -6, *Ate in impressive hall* +8).
  - *Memory thoughts:* Expiring entries in a small circular buffer (e.g. *Witnessed ally death* -12 for 3 days; *Tavern revelry* +5 for 1 day).
  When morale falls below thresholds (Minor: 35, Major: 20, Extreme: 8), an MTBF check triggers a **Mental Break**: dazed wandering (refusing orders for 60s), food binge, tantrum (smashing commodity stockpiles), or berserk (attacking nearest entity).
- **RTS Fit & Value:**
  **Transformative / Essential.** Makes armies and peasants emotionally legible. Forcing workers to chop timber in freezing rain under catapult fire shatters morale from within.
- **Port Cost & Architecture:**
  - *Cost:* Low (M). Evaluated on the Pop's Rare Tick (`(tick + eid) % 250`).
  - *Bitecs schema:* Fixed ring buffer of 4–6 thought memory slots per Pop (8 bytes each). Active break state stored as enum + countdown timer.
- **Licence & Verdict:** Reimplement mechanics. DF Wiki personality facets and stress formulas are MIT. **Rank 1 (Tier 1).**

---

### System 2: Combat Wounds, Bleeding & Field Triage
- **Primary References:**
  - Combat Extended (CC BY-NC-SA): Stabilize, Bleed rate, Carry to bed
  - RimWorld: `Hediff_Injury.BleedRate`, `Pawn_HealthTracker.MakeBleed`, Incapacitation
  - Cataclysm-DDA: `src/bodypart.cpp` (CC-BY-SA 3.0)
- **What It Does:**
  Builds on the existing 6-part `body.ts` and `injuries.ts`. Damage applies trauma with associated **Bleed Rates** (milli-units/tick).
  When blood volume drops below a threshold, the Pop becomes **Incapacitated** (collapses, drops weapons). They bleed out in 2–4 in-game minutes unless tended by an ally or carried to an Infirmary. Tending stops bleeding and reduces infection chance.
- **RTS Fit & Value:**
  **High Stakes & Heroism.** Replaces instant unit deletion with battlefield casualties, rescue operations, and triage decisions. Veterans accumulate battle scars.
- **Port Cost & Architecture:**
  - *Cost:* Low-Medium (M). Bleed arithmetic executes on Rare Tick for wounded Pops only.
  - *Bitecs schema:* Extend existing `injuries.ts` with `bleedRate`, `bloodVolume` (0–1000), `isIncapacitated`, and `triageTicksRemaining`.
- **Licence & Verdict:** Reimplement mechanics. Cataclysm-DDA patterns for body-part mending. **Rank 2 (Tier 1).**

---

### System 3: Storyteller / Dynamic Event Director
- **Primary References:**
  - RimWorld: `Storyteller`, `StorytellerDef` (Cassandra, Randy, Phoebe), `IncidentDef`
  - DF Wiki: [Siege], [Megabeast], Fortress Wealth triggers
- **What It Does:**
  Paces campaign and skirmish matches. Computes a dynamic *Threat Point Budget* from player **Colony Wealth** (stockpiles + buildings + equipment) and population count. Schedules incidents in an oscillating wave:
  - *Tension:* Bandits, wolf pack migration, blights, tribute demands.
  - *Climax:* Scaled siege or coordinated assault.
  - *Recovery:* Wandering refugees, merchant visits, clear weather.
- **RTS Fit & Value:**
  **Essential for Single-Player AAA Experience.** Replaces static timers with responsive, adaptive game pacing.
- **Port Cost & Architecture:**
  - *Cost:* Low (M). Evaluated once every 300–900 ticks (10–30s) as a seeded scheduler over `scenario/engine.ts`. Must use seeded PRNG streams for ADR-0001 determinism.
- **Licence & Verdict:** Reimplement mechanics. RimWar (MIT) provides open-source faction and event pacing code. **Rank 3 (Tier 1).**

---

### System 4: Workshops, Standing Bills & Priority Stockpiles
- **Primary References:**
  - DFHack: `plugins/workflow/`, `plugins/orders/` (Zlib license)
  - RimWorld: `Bill`, `BillStack`, `Zone_Stockpile`, `StorageSettings`, `PickUpAndHaul` (MIT)
- **What It Does:**
  Automates the economic backbone. Players set **Standing Bills** on Workplaces:
  - *"Maintain 50 Iron Broadswords in stockpile net of equipped items."*
  - *"Brew Ale until Stockpile has 200 units, pause until drops to 80."*
  Stockpiles carry priority ranks (1=Low to 5=Critical) and commodity filters. Haulers use batch carrying (`PickUpAndHaul`) to gather multiple scattered resources before delivering.
- **RTS Fit & Value:**
  **Flawless / Core Pillar.** Bridges AoE2 macro-economy with Dwarf Fortress automated manufacturing. Eliminates worker babysitting.
- **Port Cost & Architecture:**
  - *Cost:* Small-Medium (S–M). Bill quotas check aggregate stockpiles on Rare Tick. Labor assignment is handled by the existing IAUS job brain.
- **Licence & Verdict:** DFHack `workflow` is Zlib; `PickUpAndHaul` is MIT. **Directly transcribe algorithms.** **Rank 4 (Tier 1).**

---

### System 5: Rooms, Beauty & Impressiveness
- **Primary References:**
  - RimWorld: `Verse.Room`, `RoomStatDefOf.Impressiveness`, `RoomStatDefOf.Beauty`, `RoomStatDefOf.Space`
  - DF Wiki: [Dining room], [Bedroom value], [Architecture]
- **What It Does:**
  Detects enclosed spaces bounded by walls and doors as **Rooms**. Calculates composite stats:
  $$\text{Impressiveness} = f(\text{Space}, \text{Beauty}, \text{Wealth}, \text{Cleanliness})$$
  Detects room roles from contents (Table+Chairs = *Dining Hall*; Beds = *Barracks*/*Private Bedroom*; Anvil+Forge = *Smithy*; Altar = *Chapel*). Pops eating in an impressive dining room gain morale buffs; sleeping in cramped filth inflicts mood penalties.
- **RTS Fit & Value:**
  **City-Building Appeal.** Gives base building aesthetic purpose beyond utilitarian sprawl.
- **Port Cost & Architecture:**
  - *Cost:* Low (M). Enclosed spaces detected via lazy flood-fill on wall/door placement ($O(\text{room\_tiles}) \le 400$). Cached permanently until walls/furniture change.
- **Licence & Verdict:** Reimplement mechanics. **Rank 5 (Tier 2).**

---

### System 6: Temperature, Weather & Seasons
- **Primary References:**
  - RimWorld: `Verse.TemperatureCache`, `RoomGroup.Temperature`, `WeatherDef`
  - DF Wiki: [Temperature], [Weather]
- **What It Does:**
  Simulates seasonal temperature cycles (summer heat, winter freezes) and dynamic weather (rain, fog, blizzard). Enclosed rooms insulate based on wall materials and doors.
  - Rain extinguishes building fires and degrades ranged accuracy.
  - Fog reduces sight and projectile range.
  - Winter freezes shallow water into ice, halts farming, and inflicts hypothermia on Pops without winter clothes or heated shelter.
- **RTS Fit & Value:**
  **High Strategic Depth & Visual Hook.** Seasons force food and fuel stockpiling. Inclement weather creates tactical attack opportunities.
- **Port Cost & Architecture:**
  - *Cost:* Medium-Large (M–L). Uses RimWorld's *room-based lumped thermal model* ($O(\text{rooms})$ once per second) rather than per-tile thermodynamics. Render side reuses the Day/Night lighting pipeline.
- **Licence & Verdict:** Reimplement mechanics. **Rank 6 (Tier 2).**

---

### System 7: Animals, Livestock & War Beasts
- **Primary References:**
  - RimWorld: `PawnKindDef` (Animal), `TrainableDef` (Obedience, Release, Rescue, Haul)
  - DF Wiki: [Pasture], [War animal], [Animal trainer]
- **What It Does:**
  Domesticated and wild animals share the Pop entity architecture with simplified needs:
  - *Livestock (Sheep, Cattle, Pigs):* Graze on pastures, reproduce, yield recurring wool/milk, or meat/leather on slaughter.
  - *Draft / Pack Animals (Oxen, Horses):* Pull carts, accelerate trade routes.
  - *War Beasts (War Hounds):* Handled by soldiers, attack-move on command, pin skirmishers.
  - *Wildlife (Deer, Boars, Wolves):* Ambient hunting and predator threats.
- **RTS Fit & Value:**
  **Natural RTS Fit.** Seamlessly expands AoE2 herding/hunting into an authentic medieval animal economy. Animal 3D rigs are already vendored (`quaternius-ultimate-animated-animals`).
- **Port Cost & Architecture:**
  - *Cost:* Medium (M). Animals reuse the Pop ECS pipeline but omit human social/intellectual needs.
- **Licence & Verdict:** Reimplement mechanics. **Rank 7 (Tier 2).**

---

### System 8: Seasonal Trade Caravans & Market Depots
- **Primary References:**
  - DF Wiki: [Trade depot], [Merchant], [Liaison]
  - RimWorld: `TradeShip`, `Faction_Caravan`, `TradeDeal`
- **What It Does:**
  Foreign merchant caravans arrive from map edges on seasonal schedules with guards and pack animals. They unpack at the designated **Market Depot**, stay for several days, and barter surplus goods for scarce ores, weapons, or seeds. If attacked, faction relations plummet and provoke retaliatory raids.
- **RTS Fit & Value:**
  **Macro-Economic Depth.** Solves resource bottlenecks on resource-scarce maps and adds diplomatic escort objectives.
- **Port Cost & Architecture:**
  - *Cost:* Low-Medium (M). Builds on the existing `market.ts` and pathfinding systems.
- **Licence & Verdict:** Reimplement mechanics. **Rank 8 (Tier 2).**

---

### System 9: History, Legends & Artifact Chronicles
- **Primary References:**
  - DF Wiki: [Legends], [Artifact], [Strange mood]
  - RimWorld: `TaleDef`, `CompArt`
- **What It Does:**
  Records an append-only ledger of pivotal settlement events (*Tales*): town founding, major sieges, heroic kills, tragedy, and inspired craftsmen forging **Named Masterwork Relics**. Tales are engraved on monuments, sung in taverns, and displayed in the post-game match recap.
- **RTS Fit & Value:**
  **Signature Emotional Resonance.** Minimal CPU cost for immense player attachment.
- **Port Cost & Architecture:**
  - *Cost:* Small-Medium (S–M). Append-only in-memory log; zero runtime overhead during ticks.
- **Licence & Verdict:** Reimplement mechanics. **Rank 9 (Tier 2).**

---

### System 10: Health & Hediff Capacity Hierarchy (Disease & Hygiene)
- **Primary References:**
  - RimWorld: `HediffDef`, `HediffComp_Immunizable`, `Pawn_HealthTracker`
  - DF: `df.unit.xml` syndromes, infection flags
- **What It Does:**
  Expands physical trauma into internal medicine: diseases (plague, malaria, wound infections), immunity progression (race to 100% immunity before 100% severity), herbal treatments, and chronic ailments (asthma, bad back, cataracts in elders).
- **RTS Fit & Value:**
  **Siege & Attrition Realism.** Adds stakes to camp sanitation and winter confinement.
- **Port Cost & Architecture:**
  - *Cost:* Medium (M). Evaluated on the entity's Rare Tick.
- **Licence & Verdict:** Reimplement mechanics. **Rank 10 (Tier 3).**

---

### System 11: Fire Spread & Building Destruction States
- **Primary References:**
  - DF Wiki: [Fire]
  - RimWorld: `Fire`, `CompFlRaw`, Flammability
- **What It Does:**
  Wooden structures, crops, and dry vegetation ignite from flaming arrows, siege pitch, or thunderstorms. Fire spreads across adjacent flammable tiles with wind bias. Villagers self-dispatch to beat out flames unless ordered otherwise.
- **RTS Fit & Value:**
  **Visceral Siege Gameplay.** Makes siege engines terrifying and defensive firebreaks valuable.
- **Port Cost & Architecture:**
  - *Cost:* Medium (M). Grid-based fire ticks with wind vector. Extends existing fire-ship combat logic.
- **Licence & Verdict:** Reimplement mechanics. **Rank 11 (Tier 3).**

---

### System 12: Z-Levels, Digging & Elevation (Adapted to 2.5D)
- **Primary References:**
  - DF Wiki: [Z-level], [Mining], [Channeling]
  - AoE2 DE: Hill elevation advantage (+25% dealt, -25% taken)
- **What It Does:**
  Dwarf Fortress features full 3D voxel grids (-100 to +100 z-levels).
- **RTS Fit & Value:**
  **Full 3D Z-Levels REJECTED.** 3D z-levels destroy RTS camera ergonomics, fragment player focus across floors, and require rewriting pathfinding, rendering, and ADR-0002.
  **2.5D Stepped Elevation ADOPTED:** Stepped cliff plateaus and valleys with ramps. High ground grants combat bonuses (+25% damage, range bonus). Destructible rock cliffs and quarries provide minable stone.
- **Port Cost:** Medium (M) for 2.5D elevation; Prohibitive (XL) for true 3D voxels.
- **Licence & Verdict:** Clean-room 2.5D implementation. **Rank 12 (Tier 4 - Adapted).**

---

### System 13: Fluids & Dynamic Hydrology (Adapted to Static Hydrology)
- **Primary References:**
  - DF Wiki: [Fluid dynamics], [Water], [Pressure]
  - RimWorld: Static water tiles (`WaterShallow`, `WaterDeep`, `Mud`)
- **What It Does:**
  Dwarf Fortress models water and magma with 1–7 cellular automata depth and pressure.
- **RTS Fit & Value:**
  **Full Dynamic Cellular Fluids REJECTED.** Accidental flooding and constant pathfinding graph invalidation create unbearable RTS friction.
  **Static Hydrology & Seasonal Fords ADOPTED:** Shallow fordable water (slows movement, allows land combat) vs deep water (ships only) vs coastal mud. Seasonal water levels open/close river crossings.
- **Port Cost:** Low (L for dynamic; S for static).
- **Licence & Verdict:** Clean-room implementation. **Rank 13 (Tier 4 - Adapted).**

---

## 4. Ranked Donor Inventory

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                RANKED DONOR INVENTORY                                 │
├──────┬─────────────────────────────────────────────────┬───────────┬──────────┬───────┤
│ Rank │ System Name                                     │ RTS       │ Port     │ Tier  │
│      │                                                 │ Payoff    │ Cost     │       │
├──────┼─────────────────────────────────────────────────┼───────────┼──────────┼───────┤
│  1   │ Thought/Mood Ledger & Mental Breaks             │ Very High │ M        │ Tier 1│
│  2   │ Combat Wounds, Bleeding & Field Triage          │ Very High │ M        │ Tier 1│
│  3   │ Storyteller / Dynamic Event Director            │ Very High │ M        │ Tier 1│
│  4   │ Workshops, Standing Bills & Priority Stockpiles │ Very High │ S–M      │ Tier 1│
├──────┼─────────────────────────────────────────────────┼───────────┼──────────┼───────┤
│  5   │ Rooms, Beauty & Impressiveness                  │ High      │ M        │ Tier 2│
│  6   │ Temperature, Weather & Seasons                  │ High      │ M–L      │ Tier 2│
│  7   │ Animals, Livestock & War Beasts                 │ High      │ M        │ Tier 2│
│  8   │ Seasonal Trade Caravans & Market Depots         │ High      │ M        │ Tier 2│
│  9   │ History, Legends & Artifact Chronicles          │ High      │ S–M      │ Tier 2│
├──────┼─────────────────────────────────────────────────┼───────────┼──────────┼───────┤
│ 10   │ Health/Hediff Capacity Hierarchy & Disease      │ Medium    │ M        │ Tier 3│
│ 11   │ Fire Spread & Building Destruction States       │ Medium    │ M        │ Tier 3│
├──────┼─────────────────────────────────────────────────┼───────────┼──────────┼───────┤
│ 12   │ Stepped 2.5D Elevation & Cliff Fortifications   │ High      │ M        │ Tier 4│
│      │ *(Full 3D Z-Levels REJECTED; 2.5D Hills ADOPTED)*│           │ (XL for 3D)│(Adapt)│
│ 13   │ Static Hydrology & Seasonal Fords               │ Medium    │ S        │ Tier 4│
│      │ *(Dynamic 1-7 Cellular Fluids REJECTED)*        │           │ (L for CA) │(Adapt)│
└──────┴─────────────────────────────────────────────────┴───────────┴──────────┴───────┘
```

---

## 5. Architectural Constraints & Engine Invariants

1. **Tick Budget & Rare-Tick Amortization:**
   - On a quiet machine, M2 melee+fog p95 is ~7.3 ms of the 8.0 ms budget (`docs/research/perf-baseline-2026-10.md`).
   - Systems 1, 2, 5, 6, 7, 10 **must** execute on the staggered Rare Tick tier (`(tick + eid) % 250`) or on macro cadences (10s–30s). None can be evaluated per-tick.
2. **Determinism (ADR-0001):**
   - Weather, event director rolls, disease transmission, and mental breaks must consume seeded PRNG streams per system to preserve deterministic replays and save compatibility.
3. **Save Format & Migrations:**
   - Every new component requires serialization entries in `src/sim/save/serialize.ts` with explicit schema versioning.
4. **World Grid Invariant (ADR-0002):**
   - Retaining the 2D tile-grid world preserves pathfinding and spatial partition performance. 2.5D elevation operates as a tile attribute, not multi-deck voxels.

---

## 6. Recommendations for Downstream Tickets (Inputs to #146)

1. **Scope Ratification for Ticket #146 ("Simulation depth scope"):**
   - **Phase 1 (The Emotional Core):** Systems 1–4 (*Thoughts/Breaks*, *Wounds/Triage*, *Event Director*, *Workshops/Bills*). These establish the DF/RimWorld identity without altering the world map.
   - **Phase 2 (The Living World):** Systems 5–9 (*Rooms/Beauty*, *Seasons/Weather*, *Animals*, *Caravans*, *Legends*).
   - **Phase 3 (World Physics & Defense):** Systems 11–13 (*Fire*, *2.5D Cliffs/Elevation*, *Seasonal Fords*).
   - **Formal Rejection:** Author an ADR recording the deliberate rejection of full 3D z-levels and cellular fluids in favor of 2.5D cliff tiers and static seasonal hydrology.

# Research: Open-Source Sources to Mine for Individual Pop Simulation

- **Issue:** [jamesm944/game#13](https://github.com/jamesm944/game/issues/13)
- **Date:** 2026-08-21
- **Question:** For each Pop subsystem (skills, traits, injuries, needs, aging/family, education), what open-source or fully-documented source should we mine — and do we copy *code* or copy *mechanics*?
- **Scope:** Browser RTS, TypeScript + Three.js + bitecs @ 30Hz deterministic ticks. Every Pop simulated Dwarf-Fortress-style: skills w/ rust, traits (innate + school), body-part injuries, needs, age lifecycle, families, schools. **Personal-use only, never distributed** — so permissively-licensed code is on the table.
- **Method:** Primary sources only — LICENSE files read directly from each repo, source files fetched and inspected, wiki pages fetched from dwarffortresswiki.org / rimworldwiki.com, GitHub API license lookups for JS libraries. Every load-bearing number below was read off a primary page during this research session.

---

## TL;DR

1. **Cataclysm DDA is the single best code donor**: its whole project (C++ *and* JSON data) is CC-BY-SA 3.0, and `src/skill.h` contains an almost exactly-on-target `SkillLevel` model — including a **knowledge level that never rusts vs. a practice level that does** (`_rustAccumulator`), which maps perfectly onto our Skill definition in CONTEXT.md.
2. **The DF Wiki is dual-licensed GFDL & MIT** — not just "documented", but legally liftable under MIT with attribution. Its pages give exact numbers: XP per job, the level-cost curve (`400 + 100·level`), and the full rust counter machine (`SKILL_RATE 100:8:16:16`, rust layers capped at 6, permanent demotion).
3. **OpenXcom (GPL-3)** shows how to run promotion/rank/stat-growth off mission diaries with stats generated from ruleset min/max ranges — mine mechanics, not code.
4. **RimWorld contributes design vocabulary, not code** (closed source; EULA bars asset extraction): age-gated trait acquisition ("growth moments" at ages 7/10/13 = our Schools), commonality-weighted trait pools with conflict exclusion, passions, moodlets, and — critically for perf — the **tickerType stagger** (Normal / Rare=250 ticks / Long=2000 ticks).
5. **No mature open-source TS/JS colony sim exists to vendor.** The honest finding after searching: ant sims, a GDScript tutorial series, and small PoCs. Hand-roll the pop sim in bitecs; borrow patterns only.
6. **Utility AI at our scale is a non-problem mathematically**: IAUS-style scoring is O(actions × considerations) — 300 Pops × 20 actions × 10 considerations ≈ 60k float ops/tick, trivially amortized by staggering (only re-evaluate 1/N of Pops per tick).

---

## License nuance up front (affects every "copy code?" verdict)

This project is private and never distributed. Licenses impose obligations **on distribution/conveyance**, not on private use — so even GPL/CC-BY-SA code can be transcribed today with no legal trigger. The real risks are (a) habits, if this ever ships, and (b) RimWorld's EULA, which restricts extracting game assets/code regardless of distribution. Policy adopted below:

- Prefer permissive sources when quality ties.
- Record provenance comments for anything transcribed (source file + license), so a future open-sourcing decision is cheap.
- Never extract RimWorld assets/code; learn its *structures* from the community wiki and your own installed copy's XML.

---

## 1. Cataclysm: Dark Days Ahead (C++)

- **Repo:** https://github.com/CleverRaven/Cataclysm-DDA
- **License (verified from `LICENSE.txt`):** Creative Commons **Attribution-ShareAlike 3.0 Unported** — applied to the *entire project including C++ source* (unusual but explicit: "Cataclysm is licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported License"). Fonts and vendored libs (fmt MIT, zstd BSD, etc.) carry separate notices. CC-BY-SA requires attribution + share-alike *if conveyed*; fine for us either way, but note it's copyleft-ish — don't mix into a would-be MIT codebase later without deciding relicensing.

### What to mine

| Subsystem | Files | What's there |
|---|---|---|
| Skills | [`src/skill.h`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/src/skill.h), `src/skill.cpp`, data in [`data/json/skills.json`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/data/json/skills.json) | `SkillLevel` holds `_level`, `_exercise`, `_lastPracticed`, `_knowledgeLevel` + `_knowledgeExperience` (**theory never rusts; practice does**), `_rustAccumulator`; methods `train()`, `isRusty()`, `rust(rust_resist, rust_multiplier)`, `practice()`; hard cap `MAX_SKILL`; `exercised_level() = level²·100 + exercise`. Skills are JSON-defined via `load_skill(JsonObject)` — data-driven exactly like our Entity definitions convention. |
| Traits | [`data/json/mutations/mutations.json`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/data/json/mutations/mutations.json), `src/mutation.cpp` | ~hundreds of traits as pure JSON data with point costs, category/prerequisite/conflict chains — the best existing example of "trait as data" at DF scale. |
| Body-part injury/healing | [`src/bodypart.cpp`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/src/bodypart.cpp), [`data/json/body_parts.json`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/data/json/body_parts.json) | Per-part `hp_cur`, `heal_bonus`, `health_limit`, wound objects with `get_healing_time()`, cumulative `healed_total` tracking (bandage-accelerated healing). Part-based HP with time-based mending and permanent-impairment flags. |

### Verdict
**Copy code AND data structures** (transcribe to TS; CC-BY-SA provenance comment). The knowledge/practice split alone justifies it — it solves our "skills grow with use and rust without it" requirement more elegantly than flat decay.

---

## 2. OpenXcom (soldier stats / promotion / traits)

- **Repo:** https://github.com/OpenXcom/OpenXcom
- **License (verified):** **GPL-3.0-or-later** (`LICENSE.txt` is the full GPLv3 text; file headers say "version 3 … or any later version"). Strong copyleft → for a TS project, treat as **copy-mechanics**.

### What to mine

| Mechanic | Where | Detail (read from `src/Savegame/Soldier.cpp`) |
|---|---|---|
| Data-driven stat generation | constructor (~line 43–80) | Each stat rolled `RNG::generate(minStats.x, maxStats.x)` from `RuleSoldier::getMinStats()/getMaxStats()` — i.e., stat ranges live in the moddable YAML ruleset, not code. Bravery rounded to multiples of 10. Names drawn from `SoldierNamePool` pools selected by nationality. This is exactly our "Entity definitions + shared systems" pattern applied to people. |
| Rank/promotion | `promoteRank()` (line ~323), `_rank` serialized | Simple rank enum Rookie→…; promotion driven by mission counts, not XP curves: `addMissionCount()` (line ~391) tracks missions/kills via `SoldierDiary`. Lesson: **promote on deeds logged by a diary component**, which fits our combat-growth Pops. |
| Monthly stat improvement | lines ~498–560 | Improvement rolls scale with headroom (`RNG::generate(5,12)` while far below cap, `(1,3)` near cap) — a cheap "diminishing gains near stat ceiling" formula worth copying as-is conceptually. |
| Derived personality label | `calcStatString()` (line ~645) | `StatString::calcStatString(_currentStats, statStrings, …)` maps a stat profile onto descriptive strings — a 90s-era precursor of "traits emerge from stats"; nice for flavor titles like "Hardy Miner". |
| Recovery | `_recovery` field | Wounded soldiers are unavailable for N days post-mission — the light-weight injury model we want for non-heroic injuries. |

### Verdict
**Copy mechanics.** GPL makes direct transcription unattractive long-term, but the architecture (ruleset-driven ranges, diary-driven promotion, diminishing monthly gains) ports to bitecs components in an afternoon.

---

## 3. Dwarf Fortress (closed source — the wiki IS the spec)

- **Wiki:** https://dwarffortresswiki.org
- **License (verified from [Copyrights page](https://dwarffortresswiki.org/index.php/Dwarf_Fortress_Wiki:Copyrights)):** contributions released under **MIT *and* GFDL** dual license; footer repeats "Content is available under GFDL & MIT". So wiki text can be quoted/adapted in our docs under **MIT with attribution** — this is spec material we may literally paste into ADRs.

### Verified canonical models

**Skills & experience** ([Experience](https://dwarffortresswiki.org/index.php/Experience), [Skill](https://dwarffortresswiki.org/index.php/Skill)):
- Most jobs grant **30 XP (+30 more if a quality-rated item results)**; mining/smoothing/engraving grant 10.
- Level names 0=Dabbling … 15=Legendary(+n). Cost of reaching level L = **400 + 100·L** XP (Novice 500; Adequate→Competent 700; Legendary totals 18,000). Equivalent closed form for cumulative XP at level L: `500·L + 50·L·(L−1)`.
- Quality roll (worth stealing for crafted goods): `rand(0..10) + rand(0..⌊level·5/2⌋) + rand(0..⌊level·5/2⌋)` plus small attribute terms, multiplied by focus/current÷undistracted; thresholds map points → Well-crafted/Fine/Superior/Exceptional/Masterwork.
- Status penalties compound multiplicatively (Stunned −50%, Blind −75%…) — cheap way to make injuries/needs degrade work output.

**Skill rust** ([Skill §Skill rust](https://dwarffortresswiki.org/index.php/Skill#Skill_rust)) — the canonical model, exact counters:
- Per-skill token `SKILL_RATE 100:8:16:16` = %XP gained : unused-counter cap : rust-counter cap : demotion-counter cap.
- Daily: unused counter +1 → at cap resets and bumps rust counter → at cap resets, adds one **rust layer (max 6)** and bumps demotion counter → at cap, **permanent −1 skill level**.
- Defaults ⇒ ~4½ months before visible rust, ~6 years before level loss. Labels: Rusty at rust layers ≥50% of skill level; Very Rusty at ≥75% (and level ≥4).
- Practicing reverses it: half the newly-gained XP (⌊XP/2⌋+1) is lost, and 10% of that loss removes rust layers. Elegant: rust costs you progress but practice still pays.

**Personality traits** ([Personality facet](https://dwarffortresswiki.org/index.php/Personality_facet)): each facet is a **0–100 scalar** with seven report bands and explicit probabilities (91–100 highest: 0.4%; neutral 40–60: 78%). ~48 facets enumerated with gameplay effects: gating social-skill learning (DISCORD blocks Consoler/Pacifier), thought generation, stress/insanity routing (STRESS_VULNERABILITY 91+ ⇒ 50% catatonia). Facets distinct from values and goals; memories can shift facets over time. This banded-scalar design is directly reusable for our innate traits.

**Injury/body-part health** — pointers to mine next (pages not exhaustively fetched this session): [Healthcare](https://dwarffortresswiki.org/index.php/Healthcare), [Wound](https://dwarffortresswiki.org/index.php/Wound), [Body part](https://dwarffortresswiki.org/index.php/Body_part). Canonical elements there: layered tissue wounds, infection risk over time, nerve damage as permanence, crutches/prosthetics, and healthcare jobs (diagnosis/surgery/suturing/dressing/recovery) that themselves train skills — a loop our School/Hospital buildings could mirror.

### Verdict
**Copy mechanics — and you may copy text** (MIT leg of the dual license; keep attribution). The rust counter machine and facet bands are ready-to-implement specs with all constants given.

---

## 4. RimWorld (closed code — learnable entirely through data + community docs)

- **Status:** Source closed. Game data ships as XML Defs readable in your own install; the EULA prohibits redistributing extracted assets/code, so we take **design lessons only**. Community decompilation exists but is explicitly personal-use-only per EULA — same footing as ours reading the XML.
- **Docs:** rimworldwiki.com — [Traits](https://rimworldwiki.com/wiki/Traits), [Skills](https://rimworldwiki.com/wiki/Skills), [Needs](https://rimworldwiki.com/wiki/Needs), [Mood](https://rimworldwiki.com/wiki/Mood).

### Learnable from data/docs alone

| Design | What it teaches us |
|---|---|
| **Age-gated trait slots** ([Traits](https://rimworldwiki.com/wiki/Traits)) | Babies 0 traits; children gain traits at **growth moments on birthdays 7/10/13**; adults capped 1–3, acquired once, never removed. This is precisely a "School shapes Children" pipeline — random fill weighted by per-trait **commonality**, filtered by conflict lists, prohibitions, and break-threshold sanity caps. |
| Spectrum vs boolean traits | Traits like Nerves/Speed/Beauty/Gourmand-desire are scalar spectra with degrees; others boolean with explicit conflicting-trait exclusions (Ascetic↔Greedy↔Jealous form a conflict triangle). |
| Skills & passions ([Skills](https://rimworldwiki.com/wiki/Skills)) | Minor/major passion multiply learning speed; unused skills **decay below level 10**; Great Memory halves decay (confirmed on the Traits page: "×50% Skill loss rate"). Decay-with-floor is a friendlier variant of DF's counter machine. |
| Needs/Mood ([Needs](https://rimworldwiki.com/wiki/Needs)/[Mood](https://rimworldwiki.com/wiki/Mood)) | Needs decay toward zero continuously; mood = sum of staged moodlets (thought defs with stages); mental breaks trigger at minor/major/extreme mood thresholds. Trait effects are mostly *moodlet modifiers* — a clean implementation pattern: traits rarely touch logic, they add thoughts/stages. |
| **Perf: ticker staggering** | ThingDef `tickerType`: Normal (every tick) / **Rare (every 250 ticks — where needs updates live)** / Long (2000 ticks); per-instance work spread across ticks via `(ticksGame + id.HashOffset()) % interval == 0`; RimWorld 1.6 adds camera-distance-variable tick rates. Reference: community tick-system write-up ([Dev-Jahn/rimworld-modding-reference](https://github.com/Dev-Jahn/rimworld-modding-reference/blob/main/01-rimworld-core/tick-system.md)), [Modding Tutorials/ThingComp](https://rimworldwiki.com/wiki/Modding_Tutorials/ThingComp). At 30Hz we'd Rare-tick needs every 150–250 ticks and hash-stagger decisions. |

### Verdict
**Copy mechanics only** (EULA). The growth-moment school model, commonality+conflict trait generation, and ticker staggering are the three things to steal.

---

## 5. Genuinely open-source TS/JS agent simulations / colony sims

Searched GitHub (stars-sorted "colony sim", "utility ai" TS, "goap" JS) — **negative headline: nothing mature enough to vendor wholesale.**

| Project | Language / License | Assessment |
|---|---|---|
| [backspaces/agentscript](https://github.com/backspaces/agentscript) ★123 | JS, **GPLv3** (LICENSE verified) | Classic AgentScript ABM framework (Model/Turtle/Patch separation). Good mental model for agent-vs-model split; too generic to embed. |
| [ondras/rot.js](https://github.com/ondras/rot.js) | JS, **no SPDX detected** (custom/"Other") | Roguelike toolkit: FOV, pathfinding, RNG, schedulers. We likely already have equivalents; check license before ever vendoring. |
| [wmdmark/goap-js](https://github.com/wmdmark/goap-js) ★87 | JS, no license file found on default branch | GOAP proof-of-concept. Read-as-reference only (no license = all rights reserved). |
| [esengine/BehaviourTree-ai](https://github.com/esengine/BehaviourTree-ai) ★145 | **TypeScript**, license not auto-detected | BT + Utility AI + FSM in TS (Cocos-targeted). Possible direct dependency if license checks out; otherwise pattern donor. |
| [DreamersIncStudios/ECS-IAUS-sytstem](https://github.com/DreamersIncStudios/ECS-IAUS-sytstem) ★168 | C#/Unity DOTS | Full IAUS implementation shaped around ECS — closest architectural analog to what we'd build in bitecs; read-as-reference. |
| [davisbrandon02/colony-sim-tutorial](https://github.com/davisbrandon02/colony-sim-tutorial) ★76 | GDScript | Written+video colony-sim tutorial (job/task assignment, hauling priorities). Mechanics walkthrough, engine irrelevant. |
| Rise to Ruins | — | Often assumed open-source; **it is not** — GitHub hosts only third-party mod loaders/trainers. Excluded. |

Also surveyed and rejected as aggregate-level rather than individual-pop sims: Widelands, Unknown Horizons, Micropolis/Lincity, OpenTTD (economy/traffic models only).

### Verdict
**Hand-roll in bitecs** using patterns above; optionally adopt BehaviourTree-ai after a license review. No code donation expected from this section — which is why sections 1–4 matter more.

---

## 6. Utility-AI / needs systems cheap enough for hundreds of agents at 30Hz in JS

**The math first:** utility scoring is O(actions × considerations) per decision — 300 Pops × 20 actions × 10 considerations ≈ 60k multiply-adds. Spread over a 33ms tick budget (or amortized 1/N of Pops per tick), this is noise. Planning-based approaches (GOAP) are the ones that don't scale here; scoring does.

Primary references:

- **Dave Mark — Infinite Axis Utility System (IAUS)**. Origin talk: GDC AI Summit 2013 segment of ["Architecture Tricks: Managing Behaviors in Time, Space, and Depth"](https://gdcvault.com/play/1018040/Architecture-Tricks-Managing-Behaviors-in) (Mark's segment ~33:35). Deployed at Guild Wars 2: Heart of Thorns scale in Mark & Lewis, ["Building a Better Centaur: AI at Massive Scale"](https://gdcvault.com/play/1021848/Building-a-Better-Centaur-AI) (GDC 2015) — the existence proof for mass-scale utility AI. All **Game AI Pro chapters are free PDFs** at [gameaipro.com](http://www.gameaipro.com/) (utility-theory chapters across vols 1–3; note hosting terms forbid re-hosting).
- **The Sims lineage** — needs-as-first-class-citizen design: Sims 3 used a Boltzmann/temperature selection over need utilities so miserable Sims sometimes pick low-utility actions (summary with citations: [Utility system](https://www.owiki.org/wiki/Utility_system)); Richard Evans' GDC talks on The Sims' personalities are the primary source. Smart objects *advertising* motive deltas keeps decision cost O(needs × nearby objects) — ideal for our buildings/jobs advertising work utilities.
- **GOAP cautionary reference**: Jeff Orkin, ["Three States and a Plan: The AI of F.E.A.R."](https://www.gdcvault.com/play/356/) (GDC 2006) — great technique, wrong tool for hundreds of agents; use for boss-type entities only, if ever.
- **Cheap-needs pattern stack for us**: continuous linear/exponential decay arithmetic every tick (or batched), needs→consideration inputs via response curves (Mark's response-curve normalization), decisions staggered by `(tick + entityId) % N` (the RimWorld hash-offset trick, §4), and hysteresis/commitment windows so agents don't flicker between jobs.

---

## Adoption recommendation table

| Pop subsystem | Best source(s) | Copy code / mechanics | Concrete starting point |
|---|---|---|---|
| **Skills** (growth + rust) | DF Wiki [Skill]/[Experience] (constants + rust machine) + CDDA `skill.h` (architecture) | **Both** — DF text is MIT-licensable; CDDA is CC-BY-SA (provenance-comment any transcription) | Port CDDA's knowledge-vs-practice `SkillLevel`; drive it with DF's counters (`SKILL_RATE 100:8:16:16`) and level curve `400+100·L` |
| **Traits** (innate + school) | DF [Personality facet] (banded scalars) + RimWorld [Traits] (commonality/conflicts/growth moments) | Mechanics | Innate layer = DF 0–100 facets w/ band tables; School layer = RimWorld growth-moment picks weighted by commonality with conflict exclusion |
| **Injuries** | CDDA `bodypart.cpp` + `body_parts.json`; DF Healthcare/Wound pages for depth; OpenXcom `_recovery` for the light case | Code (CDDA) + mechanics (DF/OpenXcom) | Start OpenXcom-simple (injury → recovery days → possible permanent flag), grow into CDDA-style per-part HP/wounds/mending |
| **Needs** | RimWorld needs/moodlet architecture + IAUS response curves + Sims advertised-motive utilities | Mechanics | NeedDefs-equivalent JSON data; traits implement as moodlet modifiers; needs feed IAUS considerations; Rare-tick decay (every 150–250 ticks @30Hz) |
| **Aging / family** | No strong open code anywhere; RimWorld Biotech children/aging docs + DF relationship/facet pages | Mechanics | Own design; crib RimWorld's age-gate structure (child milestones) and DF's grudge rule (facet divergence >20 breeds grudges) for family drama |
| **Education / schools** | RimWorld growth moments + DF teaching ([Skill]: demonstrations/guildhalls train observers) | Mechanics | Child attends School building → accumulates school-points → trait pick at age gates; teachers train via demonstration, consuming their own time |
| **Decision-making** (cross-cutting) | Dave Mark IAUS (GDC/Game AI Pro) + RimWorld ticker staggering | Mechanics (implement fresh) | Utility scorer over job candidates; stagger by `(tick + popId) % N`; commitment window against thrash |

## Suggested next tickets
1. Spec Pop.Skill component (knowledge/practice/rust counters) citing this doc; port CDDA fields to bitecs schema.
2. Define trait data schema (facet scalars + commonality/conflict JSON) and seed ~30 traits.
3. Prototype needs decay + Rare-tick scheduler; measure 500-Pop tick cost in the existing bench harness.

---

## 7. Adopted skill constants (M3-T2, issue #47 — the pinned contract)

The skills implementation (src/sim/data/skills.ts, components/skills.ts,
systems/skills.ts) synthesizes §1 (CDDA architecture) and §3 (DF
constants). These are THE documented constants; tests pin them and any
change is a deliberate rebalance that must update this table, the code
constants and every pinned fixture together.

### Progression curve (DF wiki [Experience], MIT-licensable)

| Constant | Value | Meaning |
|---|---|---|
| Marginal level cost | `400 + 100·L` XP | XP to advance INTO level L (Novice = 500) |
| Cumulative threshold | `500·L + 50·L·(L−1)` XP | Total XP to reach level L (`xpToReachLevel`) |
| `MAX_SKILL_LEVEL` | 15 | DF's Legendary rank |
| `LEGENDARY_TOTAL_XP` | 18,000 XP | "Legendary totals 18,000"; total XP clamps here |

Levels are never stored: `level = levelOfTotalXp(knowledgeXp +
practiceXp)` derives on every read (SPEC §2.5 discipline).

### Pools & awards (CDDA `SkillLevel` split)

| Constant | Value | Meaning |
|---|---|---|
| knowledgeXp | per entry | Theory pool; NEVER decays; only `grantKnowledge` grows it (School lands in a later M3 ticket) |
| practiceXp | per entry | Practice pool ABOVE knowledge; grows by doing, drained by rust |
| `GATHER_XP_PER_UNIT` | 10 | gathering award per extracted resource unit |
| `CONSTRUCTION_XP_PER_TICK` | 1 | construction award per in-range contributing builder-tick |
| `COMBAT_XP_PER_HIT` | 10 | melee/ranged award per landed strike |
| `COMBAT_XP_PER_KILL` | 50 | bonus melee/ranged award on a kill |

Trait modifiers fold into the same paths: `xpGainMult`
(fast-learner ×1.25, slow-learner ×0.75, rounded to ≥1) scales awards;
`workSpeedMult` (industrious ×1.1, lazy ×0.9) multiplies work output.

### Rust accumulator (DF counter machine compressed to game scale)

Rare tick cadence follows RimWorld's tickerType Rare pattern (SPEC
§2.3): an entity processes when `(tick + eid) % RARE_TICK_INTERVAL === 0`.

| Constant | Value | DF ancestor |
|---|---|---|
| `RARE_TICK_INTERVAL` | 250 ticks (~8.3 sim-min) | Rare ticker interval |
| `RUST_GRACE_TICKS` | 14,400 ticks (one 8-min day) | daily rust cadence |
| `RUST_ACCUMULATOR_CAP` | 8 idle rare-ticks per drain | SKILL_RATE unused-cap 8 |
| `RUST_DRAIN_PRACTICE_XP` | 100 practice XP per drain | exercise loss step |

Net curve: after one full idle day the accumulator banks a drain every
8 rare ticks (2,000 ticks), so ≈7 drains ≈ **720 practice XP lost per
fully idle day**, while knowledgeXp is untouchable — practice falls
toward the knowledge floor exactly as CDDA's `_rustAccumulator` pulls
`_exercise` back to `_knowledgeLevel`. Practicing again resets the
accumulator via lastPracticeTick.

### Derived multipliers

| Constant | Value | Meaning |
|---|---|---|
| `WORK_RATE_PCT_PER_LEVEL` | +6%/level | gather rate / build speed ×(100+6L)/100 |
| `ATTACK_PCT_PER_LEVEL` | +4%/level | attack ×(100+4L)/100 for melee/ranged |

Level 0 with neutral traits is bit-identical to pre-M3-T2 behavior
(rowless entities skip every path).

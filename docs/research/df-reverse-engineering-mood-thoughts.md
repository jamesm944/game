# Dwarf Fortress reverse engineering for the Rust sim (#190)

Clean-room findings for the deep-sim port (build-sequence epics E10/E11).
Ticket: #190 (part of Map 8, #182).

## Policy — what "use as much as possible" means here

Dwarf Fortress is closed-source. Decompiled DF code, text, raws, and assets
must not enter this repository. What we *do* reuse, to the maximum extent
available:

1. **System designs** observed in the shipped binary (ideas/mechanics are
   reimplemented with our own numbers and code).
2. **Data shapes and enum vocabularies** from the open df-structures project
   (DFHack organisation), which the binary independently corroborates
   (see Lua-reflection note below).
3. **DFHack code patterns** where genuinely reusable — DFHack core, plugins,
   and scripts are Zlib-licensed (some MIT/BSD components;
   `scratch/donor-audit/city/dfhack/LICENSE.rst`, verified 2026-11-07).
   DFHack operates *on top of* DF structures; it is not DF's simulation,
   so most reuse is structural (field layouts, announcement/state enums),
   not drop-in simulation code.

Anything below marked **Observed** was read from the binary or
df-structures in this pass. **Inferred** is our reading of how pieces
combine. **Unknown** was not established; our Rust port defines its own
values there instead of guessing silently.

## Target identity (Observed)

- Binary: Dwarf Fortress Classic 53.16 Linux `dwarfort`, ELF 64-bit
  x86-64, dynamically linked, stripped.
  SHA-256 `fde60a0273deab619db1d8363ec206952dc70ffdf4d446744e2e531a4351feee`,
  BuildID `84ba59a59a6bbe4487f933a8c85360a45902749e`.
  Held only under `scratch/df-re/` — never committed.
- Analysis: Ghidra 12.1.4 headless auto-analysis (complete):
  45,642 functions, 41,600 defined strings. REA (`morluto/rea`) MCP tools
  are not registered in this session and its Ghidra provider was blocked
  earlier by a macOS SDK modulemap failure, so Ghidra was driven directly.
  Consequence: no REA Evidence IDs exist for this pass; binary addresses
  below are the evidence anchors instead. Ghidra's mac_arm_64 decompiler
  was built locally from the bundled C++ source before rerunning probes.
- Corroborating source: `df-structures` checkout in `scratch/df-re/`
  (field layouts below cite its XML files/lines).
- Probe artifacts (scratch, uncommitted): `probe.txt`/`probe2.txt`
  (string+xref inventory, decompile unavailable), `probe3.txt`
  (30 functions decompiled, 7 timeouts), `probe-migrant.txt` (broadened
  inventory), `probe-targets.txt` (4 targeted decompiles, all succeeded,
  24k-char caps). Scripts: `scratch/df-re/scripts/DfProbe{,2,3}.java`.

## What the binary itself establishes

### Token parsers confirm enum vocabularies (Observed)

The string-referencing functions for personality/mood keys are dominated
by token→enum parsers, not update math:

- `FUN_01e28f00` (probe3.txt:2625) parses personality-facet tokens by
  `memcmp` chains, returning indices in the same order as
  df-structures' `personality_facet_type` (HATE_PROPENSITY=1,
  ENVY_PROPENSITY=2, CHEER_PROPENSITY=3, DEPRESSION_PROPENSITY=4, …;
  NONE = −1 in df-structures). Unknown tokens hit the string
  "Unrecognized Personality Facet Token: " (`0x021f1da8`).
- `FUN_014e08a0` (probe3.txt:2189) is the announcement-type token parser;
  it resolves e.g. `STRANGE_MOOD`, `STRESSED_CITIZEN`,
  `CITIZEN_LOST_TO_STRESS`, `D_MIGRANT_ARRIVAL`,
  `D_MIGRANT_ARRIVAL_DISCOURAGED`, `D_NO_MIGRANT_ARRIVAL`,
  `MIGRANT_ARRIVAL_NAMED`, `FIRST_CARAVAN_ARRIVAL`.
- `FUN_01d19040` parses interaction-effect tokens `CE_FEEL_EMOTION` /
  `CE_CHANGE_PERSONALITY`, `NOTHOUGHT`, `NOEMOTION`,
  `NO_THOUGHT_CENTER_FOR_MOVEMENT`, `EXTREME_EMOTION`.

Interpretation (Inferred): personality/emotion effects are data-driven
from raws tokens; the enum orders in df-structures match the shipped
binary, so our Rust enums can safely mirror those vocabularies.

### Lua reflection corroborates field layouts (Observed)

The binary embeds Lua (`lua_createtable`, `lua_pushinteger`,
`lua_setfield` appear as resolved calls). `FUN_01e17530`
(probe-targets.txt:630) serialises a personality-like struct to Lua
tables field-by-field, referencing the field-name strings
`time_without_distress` (`0x021ee447`), `time_without_eustress`
(`0x021ee45d`), `longterm_stress` (`0x021ee4f1`); `FUN_009ab840`
(probe3.txt:230) similarly reflects `mood_spent` / `mood_succeeded`
fields. Independent of df-structures, the shipped binary carries the
same field names — the df-structures layouts are trustworthy shapes.

### Stress presentation thresholds exist as discrete bands (Observed)

UI strings define 7 stress button bands (`BUTTON_STRESS_0` …
`BUTTON_STRESS_6`, `0x020987a3`–`0x02098803`) and state labels such as
"Experiencing emotional shock", "Distressed", "Taken by mood"
(`0x020ef90d` area). Exact numeric cut-points for the bands were **not**
recovered (Unknown) — the three UI functions referencing them
(`FUN_0057f960`, `FUN_005b0b50`, `FUN_005a43f0`) failed decompile
(timeout / flow-exceeded), so our port picks its own band thresholds.

## Data model (Observed from df-structures, cross-checked above)

Per-unit `unit_soul` (`df.soul.xml:39`) embeds `unit_personality`
(`df.personality.xml:1487`). The pieces our port mirrors:

| Piece | df-structures shape | Notes from definitions |
|---|---|---|
| Facets (traits) | `personality_facet_type`, 51 entries incl. `NONE` (`df.d_basics.xml:1296`); stored as `int16` array indexed by facet (`df.personality.xml:1495`) | e.g. `STRESS_VULNERABILITY`, `ANGER_PROPENSITY`, `CHEER_PROPENSITY`, `ABSTRACT_INCLINED`, `ART_INCLINED` |
| Values / beliefs | `value_type`, 34 entries incl. `NONE` (`df.d_basics.xml:524`); per-unit vector of value records | `LAW`, `FAMILY`, `POWER`, `KNOWLEDGE`, … |
| Goals / dreams | `goal_type`, 15 entries (`df.d_basics.xml:1363`); per-unit vector with `REALIZED` flag (`df.personality.xml:1343`) | `MASTER_A_SKILL`, `CRAFT_A_MASTERWORK`, … |
| Preferences | typed records (material/food/item/colour/shape/…), 4 int params + seed (`df.personality.xml:1365`) | |
| Current emotions | vector of `personality_moodst` (`df.personality.xml:1326`): emotion type, `strength`, `relative_strength`, thought (circumstance) type, `subthought` id, `severity`, flags, `next_overcome_timer`, last-used year/tick | flags record memory provenance: short-term / long-term / core, facet/value change, `failed_to_overcome` |
| Emotions vocabulary | `emotion_type`, 170 entries (`df.d_basics.xml:685`) | far larger than our slice needs; we take a subset |
| Thoughts (circumstances) | `unit_thought_type`, 281 entries (`df.personality.xml:119`) | event kinds that produce emotions, with captions per entry |
| Needs | `need_type`, 31 entries incl. `NONE` (`df.personality.xml:1374`); per-need record: type, `deity_id` (pray only), `focus_level`, `need_level` (`df.personality.xml:1408`) | definition comments: satisfied need → `focus_level` 400; `need_level` = decay rate once focus is below 0; any focus below −999 sets `has_unmet_needs` |
| Focus / distraction | `current_focus` = weighted sum of focus levels; `undistracted_focus` ≈ 4 × need count (`df.personality.xml:1522`) | ratio drives work-quality distraction (Inferred usage) |
| Memories | handler with **8 short-term + 8 long-term slots** of `unit_emotion_memory`, plus core memories that also record an old→new facet or value shift (`df.personality.xml:1438`, `:1452`, `:1462`) | core memories are how personality *changes* over a life |
| Stress state | `stress` (int32), `longterm_stress` (int32, since v0.50.01), `time_without_distress` / `time_without_eustress` in 0…806400 — "higher values cause stress to decrease/increase quicker" (`df.personality.xml:1503`, `:1520`) | stress drifts back toward a long-term baseline; recent-history timers modulate the drift rate |
| Debug accounting | per-circumstance stress totals, eustress/distress gain/loss totals (`df.personality.xml:1472`) | confirms stress accumulates from circumstances in both directions (distress +, eustress −) |

### Update rules: established vs not

**Observed/definition-supported**

- Events create (circumstance → emotion) records with strength and
  severity; the same record shape is reused for live emotions,
  short/long memories, and core memories.
- Emotions carry an "overcome" timer (`next_overcome_timer`,
  `failed_to_overcome` flag): a unit periodically attempts to overcome a
  lingering emotional state; failure keeps it active.
- Need satisfaction resets focus to 400; unmet needs decay focus at a
  need-specific rate once below 0, and crossing −999 flags the unit as
  having unmet needs.
- Stress has two time constants: instantaneous `stress` and
  `longterm_stress`, with the 0…806400 timers modulating how fast each
  moves (definition comments above).

**Unknown (not recovered in this pass)**

- Exact formulas mapping (circumstance, severity, facets) → emotion
  strength / stress delta. The core update functions are not anchored
  to mood/skill strings; decompiled hits were parsers, announcement
  emitters, Lua reflection, and save/OS code. Finding them needs
  vtable/struct-offset tracing (e.g. following writes to the
  `unit_personality` layout), a larger separate effort.
- Exact stress-band cut-points, strange-mood probability, and migrant
  wave size formula (see below).

Our port therefore mirrors the *architecture* exactly (records, timers,
memory tiers, focus arithmetic) and defines its own deterministic integer
constants for the unknown gains — consistent with ADR-0012's integer-only,
worker-count-independent digest rules.

## Migration (broadened per James, 2026-11-07)

**Observed (binary, `probe-migrant.txt`)**

- One large function, `FUN_00f13730` (18,480 bytes), references the full
  migrant announcement string set — singular and plural variants.
  Decompile succeeded (probe-targets.txt:2, truncated at 24k chars); it
  is a broad site-update routine using the game's `mt_trandom` RNG, but
  pointer-table references hide the variant-selection branches from the
  decompiler, so branch thresholds are **Unknown**.
- The announcement variants form a complete matrix (paraphrased here;
  full strings stay in scratch): arrival vs refusal × site danger
  (safe / dangerous / terrifying) × site happiness reputation
  (content / unhappy / miserable) × one-vs-many. Refusal wording also
  distinguishes "refused" from "too nervous/wary". Migration is
  **seasonal** (every message is scoped "this season").
- Announcement types: `D_MIGRANT_ARRIVAL`, `D_MIGRANTS_ARRIVAL`,
  `D_MIGRANT_ARRIVAL_DISCOURAGED`, `D_NO_MIGRANT_ARRIVAL`,
  `MIGRANT_ARRIVAL_NAMED`; sound/announcement categories `Migrants`,
  `Migrant (one)`, `Migrants (danger)`, `No migrants`
  (`df.g_src.basics.xml` mirrors these).
- Population caps are first-class settings with binary support:
  `[POPULATION_CAP:`, `[STRICT_POPULATION_CAP:` strings, parsed by
  `FUN_01580d10` / `FUN_01b090d0`.
- Caravans share the seasonal cadence machinery: `FIRST_CARAVAN_ARRIVAL`
  announcement type, trade-depot access check (`FUN_0128ddd0`,
  "Evaluate Depot Caravan Access Overflow").

**Inferred design for our port**

- Seasonal migration tick: compute site danger score (recent deaths,
  hostiles, unburied dead) and happiness reputation (aggregate stress
  bands of residents).
- Roll against both scores: arrive (wave size scaled by wealth/exports
  and reputation, clamped by population cap), arrive-discouraged
  (small/zero wave next season), or refuse.
- Outcome is carried as a structured enum (announcement kind + counts +
  band indices); presentation text is ours. No language interpretation
  anywhere — the sim emits the enum, Unity renders it. (This also keeps
  the machine-wide no-keyword-trigger rule: migration state is judged
  from sim integers, never from text.)

## Rust port mapping (our design, Inferred from the above)

Current state: `sim/src/lib.rs` `Pop` carries only `food/rest/morale`
on a 0…10000 scale, updated every 30 ticks in `next_pop`. The port adds
modules beside it, keeping the existing snapshot/digest/save discipline
(every new field joins `digest` and `SaveFile`; `SAVE_FORMAT` bumps):

1. `personality` — facet array (subset of the 50 real facets), values,
   one goal, preferences as seeded ints. Generated deterministically
   from `Pop.id` like current spawn math.
2. `emotion` — fixed-capacity records mirroring `personality_moodst`:
   `(emotion, strength, relative_strength, circumstance, sub_id,
   severity, flags, overcome_timer, year, tick)`. Circumstance and
   emotion enums start as small subsets (witness death, good meal,
   crafted masterwork, slept poorly, rained on, …) and grow by data.
3. `memory` — 8 short-term + 8 long-term ring slots + core memories
   that shift one facet/value old→new, exactly DF's tiering.
4. `needs` — per-pop `(need_type, focus_level, need_level)` with DF's
   constants (satisfy→400, unmet below −999) rescaled only where our
   tick rate demands; `current_focus / undistracted_focus` ratio feeds
   a work-speed/quality multiplier in `next_pop`.
5. `stress` — `stress` + `longterm_stress` + the two 0…806400 timers;
   `morale` becomes a *derived* presentation value (banded 0…6 like the
   binary's UI bands) instead of a stored scalar.
6. `migration` — seasonal wave controller per the inferred design
   above; new pops spawn through the same deterministic id stream, and
   wave outcomes enter the snapshot as structured events for Unity.
7. Events, not polling: world events (delivery completed, death,
   meal eaten) append circumstance records; the 30-tick cadence in
   `next_pop` becomes the emotion/need/stress integration step.
   All integer math, entity-phase cadence `(tick + id) % N`, so the
   worker-count digest parity tests keep passing by construction.

Strange moods, relationships/grudges, conversation thoughts, and the
full 281-circumstance table are explicitly later epochs (build sequence
E10/E11), not part of this slice.

## Reuse ledger

| Source | Licence | Reused as | Not reused |
|---|---|---|---|
| `dwarfort` 53.16 binary | proprietary | observed system design; enum/field corroboration; function locations | code, text, raws, assets — nothing copied |
| df-structures (DFHack org) | Zlib (DFHack) | struct shapes, enum vocabularies, definition constants (400, −999, 8+8 slots, 806400) | generated C++ headers (not needed) |
| DFHack | Zlib (some MIT/BSD parts) | structural patterns; announcement/state enum naming | runtime hooking code (inapplicable to our sim) |
| REA (`morluto/rea`) | project licence | intended driver; provider blocked, see Target identity | — |

## Open unknowns for a future pass

1. Core circumstance→stress gain formulas (needs struct-offset tracing
   from `unit_personality` writes, or REA once its provider runs).
2. `FUN_00f13730` migrant branch thresholds and wave-size formula.
3. Stress band cut-points behind `BUTTON_STRESS_0..6`.
4. Overcome-probability rule behind `next_overcome_timer`.

Each is a "define our own number, revisit if evidence lands" item, not a
blocker for E10/E11 implementation.

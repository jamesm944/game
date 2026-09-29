# Asymmetric Civilizations Architecture

## Context

To provide deep strategic asymmetry and surpass Age of Empires 2, Wayfinder Map 3 (#84) specifies 4 core civilizations with distinctive military specialties, unique Castle units, unique technologies, and passive economic and combat bonuses. The game previously ran on symmetric civil infrastructure where every player had access to the identical tech tree and unit roster.

## Decision

1. **Data-Driven Civilization Schema**:
   - `CivilizationDefinition` in `src/data/schema.ts` loaded through the Factorio three-round loader discipline (`src/data/load.ts`) from `src/data/definitions/civs/*.json`.
   - Each civ definition specifies:
     - `id`: Unique slug (`britons`, `franks`, `goths`, `byzantines`).
     - `name`: Display name.
     - `description`: Historical summary and gameplay focus.
     - `uniqueUnitId`: Castle-trained unique unit.
     - `uniqueTechId`: Castle-age unique technology.
     - `bonuses`: Array of `TechEffect` descriptors (`target`, `stat`, `op`, `value`).

2. **Core 4-Civilization Roster**:
   - **Britons** (Archer & Food Focus):
     - Unique Unit: `longbowman` (high range foot archer).
     - Unique Tech: `yeomen` (+1 archer range, +2 tower attack).
     - Bonuses: Foot archers +1 range, food gather rate +20%, Town Center wood cost -50%.
   - **Franks** (Cavalry & Castle Focus):
     - Unique Unit: `throwing-axeman` (ranged melee infantry).
     - Unique Tech: `chivalry` (faster cavalry training).
     - Bonuses: Cavalry +20% HP, Castle stone cost -25%, forager food gather rate +15%.
   - **Goths** (Infantry Swarm Focus):
     - Unique Unit: `huskarl` (high pierce armor anti-archer infantry).
     - Unique Tech: `anarchy` (faster huskarl training).
     - Bonuses: Infantry -25% cost, population cap +10, infantry +2 attack vs buildings.
   - **Byzantines** (Defense & Counter Focus):
     - Unique Unit: `cataphract` (anti-infantry heavy cavalry).
     - Unique Tech: `greek-fire` (+1 fire ship range).
     - Bonuses: Buildings +25% HP, counter units (Skirmishers, Fire Ships) -25% cost, Imperial Age advancement -33% cost, Fire Ship reload speed +20%.

3. **Unique Unit Production**:
   - Castle trainable roster is dynamically filtered by the owning player's civilization.
   - Unique units share standard combat stats derivation and counter-triangle mechanics.
   - Visual billboarding reuses appropriately scaled and tinted base model sprite layers without requiring runtime mesh baking.

4. **Derived Bonus Application**:
   - Derived combat stats (`src/sim/combat/stats.ts`), costs (`src/sim/systems/costs.ts`), and resource gather rates (`src/sim/systems/gather.ts`) factor in the player's active civilization bonuses.
   - Unset / legacy player civs evaluate to 0 bonuses, preserving bit-identical golden test digests across pre-C1 suites.

## Consequences

- 100% deterministic simulation at 30 Hz.
- Modders and designers can add new civilizations purely via JSON definitions without modifying system logic.
- 4-player skirmish setups can assign distinct civilizations per player for diverse FFA and 2v2 tactical dynamics.

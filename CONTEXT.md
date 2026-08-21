# Age of Empires-like RTS

A browser-based, single-player real-time strategy game that uses Age of Empires 2 as its base model and deliberately exceeds it: extra resources and production chains, Dwarf-Fortress-style individually simulated Pops with generational lifecycle, RPG-flavored per-Pop combat growth, and Civilization-style multiple victory paths. Personal-use only.

## Language

### Pops

**Pop**:
An individually simulated person — the atomic unit of economy, combat, and society. Has age, family, skills, traits, health, and a job.
_Avoid_: Unit (for workers), citizen, villager-as-individual

**Villager role**:
The labor assignment a working-age Pop holds (gatherer, builder, farmer). A job, not an identity — Pops cycle through roles.
_Avoid_: Villager (when meaning the individual)

**Child**:
A young Pop; cannot work or fight, acquires traits at School, becomes an adult at the age gate.
_Avoid_: Kid

**Elder**:
A Pop past working age; light duties only, carries accumulated knowledge bonuses where modeled.

**Lifecycle**:
Birth → childhood → adulthood → elderhood → death. Aging advances in sim time; death is permanent and individual.

**Family / Household**:
The unit binding related Pops (parents, children) to a home. Drives household formation, morale, and birth rates.

**Skill**:
A trained capability of a Pop (mining, archery, melee…) that improves with use and decays without practice.
_Avoid_: Level (bare), stat

**Trait**:
A stable characteristic of a Pop — some innate/random at birth, some acquired at School — modifying work speed, combat behavior, or needs.
_Avoid_: Perk, feature

**Injury**:
Damage to a specific Pop that persists across ticks: impairs work/combat while present, heals over time or maims permanently.

**School**:
The building where Children spend childhood gaining traits and early skills before entering the workforce.

### Economy

**Resource**:
A gatherable raw material. Base four: Food, Wood, Gold, Stone — plus the expanded set decided in tickets (iron, coal, clay class).
_Avoid_: Material, currency

**Carry capacity**:
The maximum amount of one Resource a Pop holds before depositing at a Drop-off point.
_Avoid_: Load, inventory

**Drop-off point**:
A building where a Pop deposits carried Resources into the stockpile.
_Avoid_: Depot

**Commodity**:
A crafted good produced from Resources via a Recipe (planks, bricks, tools, weapons, armor, meals). Not gathered — made.
_Avoid_: Product, item

**Recipe**:
The data definition turning input Resources/Commodities into an output Commodity at a required building, gated by techs.
_Avoid_: Crafting rule

**Farm re-seeding**:
Rebuilding a depleted Farm for a wood cost so it continues producing Food indefinitely.

### Combat & progression

**Armor class**:
A tag on units/buildings (infantry, cavalry, archer, siege, building…) that Attack bonuses key off.
_Avoid_: Type, category

**Attack bonus**:
Extra damage vs a specific Armor class, defined in data. Creates the counter triangle.

**Counter triangle**:
Emergent infantry → archer → cavalry → infantry loop (plus siege → buildings).

**Age advancement**:
Moving the settlement up Dark → Feudal → Castle → Imperial by paying at an advancing building; gates units, buildings, techs.
_Avoid_: Era, level up

**Technology**:
A purchasable permanent modifier to units, buildings, or civilization. Bought via the Tech tree.

**Tech tree**:
The full graph of buildings, units, technologies and their prerequisites.

**Entity definition**:
The JSON record for one unit/building/technology/recipe: costs, stats, Armor classes, bonuses, prerequisites, asset refs. All rules are Entity definitions + shared systems.
_Avoid_: Config, blueprint

### Victory

**Victory path**:
One of several alternative win routes (Civ-style): Conquest plus knowledge/culture/economic/diplomatic-style paths as decided in design tickets.
_Avoid_: Win condition (when listing them all)

**Conquest victory**: destroy enemy military production capacity (standard).
**Wonder victory**: complete a Wonder, hold through timer.
**Relic victory**: hold all Relics through timer.

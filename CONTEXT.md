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
A gatherable raw material. The seven §2.6 gatherables live since M2-T2: Food, Wood, Gold, Stone plus Iron, Coal, Clay.
_Avoid_: Material, currency

**Carry capacity**:
The maximum amount of one Resource a Pop holds before depositing at a Drop-off point.
_Avoid_: Load, inventory

**Drop-off point**:
A building where a Pop deposits carried Resources into the stockpile. Each declares an acceptance filter list (`dropoffFilters`); carriers route to the cheapest ACCEPTING point and a rejected resource is never credited (M2-T2).
_Avoid_: Depot

**Commodity**:
A crafted good produced from Resources via a Recipe (planks, bricks, tools, weapons, armor, meals). Not gathered — made.
_Avoid_: Product, item

**Recipe**:
The data definition turning input Resources/Commodities into an output Commodity at a required building, gated by techs.
_Avoid_: Crafting rule

**Farm re-seeding**:
Rebuilding a depleted Farm for a wood cost so it continues producing Food indefinitely.

**Age**:
The per-player ladder rung — Dark, Feudal, Castle, Imperial (ranks 1–4). Every Entity definition carries an `ageGate`; content is usable only once the owner's rank reaches it. Advanced by researching age techs at the Town Center (`researchAge`); completions append digest-visible AgeAdvanced events.
_Avoid_: Era, tier

### Delegated management

**Workplace**:
A production building plus its associated work area — the unit a Foreman manages.
_Avoid_: Job site, facility

**Foreman**:
A Pop appointed to run one Workplace: fills its slots from the labor pool, rotates tired workers, handles re-seeding and rebuilds. Quality derives from the individual's traits and Management skill.
_Avoid_: Overseer, boss

**Manager**:
A Pop appointed over one resource domain (Food, Wood, Stone·Clay, Metal, Crafted) who redistributes workers across its workplaces per player-set strategy weights.
_Avoid_: Governor, administrator

**Staffing rule**:
Player appoints Foremen/Managers only on directly-owned Workplaces; a Branch is staffed exclusively by its Company — no player appointment or veto there.
_Avoid_: Veto power

**Strategy weight**:
The player-set priority slider a Manager obeys when reallocating workers within their domain.
_Avoid_: Priority flag

**Company**:
A player-chartered organization owning Workplaces as Branches, holding a treasury from a share of branch output, and proposing new branches autonomously.
_Avoid_: Corporation, business (bare)

**Branch**:
A Workplace owned by a Company rather than directly by the player.
_Avoid_: Franchise, office

**Treasury**:
A Company's virtual credit ledger, funded by its Branches' output share; spendable only on the Company's own proposals.
_Avoid_: Bank, fund

**Charter**:
A Company's founding focus and rules: name, sector, expansion approval mode.
_Avoid_: License

### Combat & progression

**Armor class**:
A tag on units/buildings (infantry, cavalry, archer, siege, building…) that Attack bonuses key off.
_Avoid_: Type, category

**Attack bonus**:
Extra damage vs a specific Armor class, defined in data. Creates the counter triangle.

**Counter triangle**:
Emergent infantry → archer → cavalry → infantry loop (plus siege → buildings).

**Derived stats**:
Combat numbers (attack, per-class armor, speed, range, reload) computed ON READ from the Entity definition plus equipped commodity counts plus researched techs — never stored in a duplicate row. Traits contribute zero until M3.
_Avoid_: Stat block, cached stats

**Equipment**:
Forge Weapons/Armor commodities consumed onto a military Pop (SPEC §2.5 "equipment = commodities"): each piece adds a flat documented attack/armor delta in the Derived-stats read. There is no separate gear inventory — the CommodityStockpile IS the armory.
_Avoid_: Item, gear slot inventory

**Engagement**:
The live attacker→target binding held in a unit's Combat row. Broken by death, disengagement validation after foreign orders, or purge when the target dies. Acquired three ways: explicit attack command, auto-retaliation when damaged in range, aggro acquisition while attack-moving.

**Attack-move**:
A march that watches for enemies inside the unit's sight radius and pauses to fight, resuming automatically once the engagement ends. Group attack-marches reuse the formation slots of plain moves (one leader path, concentric-ring deal).

**Retaliation**:
Auto-acquiring your striker as target when damaged inside aggro range; pauses (never cancels) the current job, which resumes after the fight.

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

### Schedules & social life

**Day/night cycle**:
The 24-hour sim clock driving work, sleep, and leisure windows; rendered as lighting tint only.
_Avoid_: Time of day (bare), circadian system

**Schedule**:
A Pop's recurring daily pattern of work window, sleep window at its Household home, and free leisure time.
_Avoid_: Routine, timetable

**Leisure activity**:
A personality-scored off-work choice (tavern, brothel, visiting friends/family, shrine, study) paid for in gold or time and returning morale or bond effects.
_Avoid_: Recreation, hobby

**Social bond**:
A pairwise Relationship value between two Pops, built by visits and shared events; strong bonds buffer morale shocks.
_Avoid_: Friendship level

**Venue**:
A building type hosting Leisure activities (Tavern, Brothel, Shrine, School-library).
_Avoid_: Hotspot, hangout

**Rest day**:
Sunday of the 7-day week: work windows close (essential roles only) and the community attends Mass if a Church stands.
_Avoid_: Weekend, holiday

**Mass**:
The communal Sunday morning gathering at a Church — broad morale buff and Social-bond reinforcement across attendees.
_Avoid_: Service (bare)

**Work activity**:
The visible, looping task a Pop performs at a work slot — axe swings at trees, pick strikes in mines, hammering on sites — matched to an animation clip and tool prop.
_Avoid_: Job (the assignment), chore

**Cargo prop**:
The visible bundle (logs, ore sack, food basket) rendered attached to a Pop while carrying resources back to a Drop-off point.
_Avoid_: Backpack, load mesh

### Victory

**Victory path**:
One of several alternative win routes (Civ-style): Conquest plus knowledge/culture/economic/diplomatic-style paths as decided in design tickets.
_Avoid_: Win condition (when listing them all)

**Conquest victory**: destroy enemy military production capacity (standard).
**Wonder victory**: complete a Wonder, hold through timer.
**Relic victory**: hold all Relics through timer.

### Rendering

**Render mirror**:
The double-buffered SoA snapshot of live Pop positions/headings that the renderer reads. The sim-side producer copies it after each step(); render only samples it with an interpolation alpha. Render never touches sim component rows directly.
_Avoid_: Snapshot state (bare), world copy

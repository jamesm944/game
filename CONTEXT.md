# Age of Empires-like RTS

A browser-based, single-player real-time strategy game recreating the Age of Empires 2 model: economy, base-building, age progression, and combat, rendered with Three.js.

## Language

### Economy

**Villager**:
The economic unit that gathers resources, constructs buildings, and farms. The backbone of the economy; also trains from the Town Center.
_Avoid_: Worker, peasant, citizen

**Resource**:
One of Food, Wood, Gold, Stone — the four stockpiled currencies every cost is paid in.
_Avoid_: Material, currency

**Carry capacity**:
The maximum amount of one resource a Villager holds before it must deposit at a Drop-off point.
_Avoid_: Load, inventory

**Drop-off point**:
A building where a Villager deposits carried resources into the player's stockpile (Town Center, Mill, Lumber Camp, Mining Camp, Dock).
_Avoid_: Depot, return site

**Farm re-seeding**:
Rebuilding a depleted Farm for a wood cost so it continues producing food indefinitely.

### Progression

**Age advancement**:
Moving the whole settlement up one of the four ages — Dark, Feudal, Castle, Imperial — by paying a cost at an advancing building. Gates units, buildings, and techs.
_Avoid_: Era, level up, epoch

**Tech tree**:
The full graph of buildings, units, and technologies, each gated by Age advancement and prerequisites.

**Technology**:
A purchasable, permanent modifier to a unit, building, or the whole civilization (e.g. +infantry attack).
_Avoid_: Upgrade (ambiguous), research (that's the act of buying)

### Combat

**Armor class**:
A tag on a unit or building (e.g. infantry, cavalry, archer, siege, building) that Attack bonuses key off. The mechanism behind counters.
_Avoid_: Type, category

**Attack bonus**:
Extra damage a unit deals against a specific Armor class, defined per-unit in data. Creates the counter triangle.
_Avoid_: Multiplier, strength vs

**Counter triangle**:
The emergent rock-paper-scissors between infantry → archer → cavalry → infantry (plus siege → buildings), arising from Armor classes and Attack bonuses.

### Rules data

**Entity definition**:
The JSON record specifying one unit, building, or technology: costs, stats, Armor classes, Attack bonuses, prerequisites, asset references. All game rules are Entity definitions plus shared systems.
_Avoid_: Config, blueprint (overloaded with building placement), card

### Victory

**Conquest victory**:
Winning by destroying every enemy military production building (standard AoE2 conquest).

**Wonder victory**:
Winning by completing a Wonder and holding it through its countdown timer.

**Relic victory**:
Winning by collecting all Relics and holding them through the countdown timer.

# Open Source City Builders & Economic Transport Games: Donor Analysis (map 6)

Investigation into open source city builder engines and simulation models that Age of Wind can borrow architecture, economic flow algorithms, and transport logistics from.

## 1. Prime Candidates & Source Repositories

### A. The Walker & Supply Service Model: **Julius** & **Augustus** (*Caesar III* re-implementations)
- **Repo:** `bvschaik/julius` and `Keriew/augustus` (GitHub)
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Key Mechanics to Steal:**
  1. **Walker System:** Service agents (Firefighters, Prefects/Police, Tax Collectors, Engineers, Priests) leave buildings, follow road networks, and emit service coverage over buildings they pass.
  2. **House Evolution Levels:** Houses upgrade automatically (e.g. Tent -> Hovel -> Shack -> Villa -> Manor) when supplied with prerequisite goods (Clean water, food variety, pottery, wine, temple access). Houses degrade when taxes are too high or hazards rise.
  3. **Hazards:** Fire risk and structural collapse risk accumulate on un-serviced buildings.
  4. **Tax Offices & Senate:** Tax walkers roam residential neighborhoods; uncollected taxes create budget deficits, while extortionate rates drop sentiment and trigger riots.

### B. Road, Flag & Carrier Logistics: **Widelands** (*The Settlers II* clone)
- **Repo:** `widelands/widelands` (GitHub)
- **License:** GPL-2.0-or-later (Engine) / CC-BY-SA (Assets)
- **Key Mechanics to Steal:**
  1. **Flag & Road Transport Grid:** Production buildings connect via footpaths; items move from flag to flag carried by dedicated haulers or pack animals.
  2. **Production Chains (Flour -> Bread, Iron Ore + Coal -> Weapons):** High fidelity multi-stage manufacturing.
  3. **Geologist & Mineral Prospecting:** Prospectors physically walk mountains to locate coal/gold/iron veins before mines can be placed.

### C. Island Supply Chains & Production Balance: **Unknown Horizons** (*Anno 1602/1503* clone)
- **Repo:** `unknown-horizons/unknown-horizons` (GitHub)
- **License:** GPL-2.0+ (Code) / CC-BY-SA 3.0 (Assets)
- **Key Mechanics to Steal:**
  1. **Tiered Citizen Demands:** Settlers demand Basic Food -> Salt -> Spices -> Fabric -> Alcohol -> Church service. Meeting demands unlocks higher tier production buildings and generates higher tax revenues.
  2. **Settlement Balance Sheet:** Granular display of Running Costs (Building upkeep) vs. Tax Income per social tier.

### D. Pure Modern JavaScript/TypeScript Inspiration: **Cimulity** & **IsoCity**
- **Repos:** `zeikar/cimulity` & `amilich/isometric-city` (GitHub)
- **License:** MIT
- **Key Mechanics to Steal:**
  1. Clean TypeScript road-graph pathfinding and commuter simulation.
  2. Zone-based growth mechanics in modern web stacks.

---

## 2. Synthesis: The City-Builder Hybrid Formula for Age of Wind

By combining our existing **Pop Schedule & Body ECS** (`src/sim/systems/schedules.ts`, `needs.ts`) with Caesar/Settlers city-builder mechanics:

1. **Tax Walkers / Bailiffs:** The Town Center or Manor dispatches bailiffs who physically visit households and shops to collect taxes. If tax is high and security/religion is absent, bailiffs get attacked.
2. **Housing Evolution & Desirability:** Houses improve when near water, churches, and paved roads, but degrade near noisy lumber yards, smelters, or battlefields.
3. **Fire & Structural Hazards:** Buildings suffer wear-and-tear or catch fire during heatwaves/sieges, requiring repair workers.
4. **Supply Chain Multi-tiers:** Bread requires Wheat Farm -> Windmill -> Bakery. Beer requires Wheat + Clean Water -> Brewery -> Tavern.

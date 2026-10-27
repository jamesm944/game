# 24-Rank Historical Era Content, System & Donor Integration Matrix

Wayfinder: **"Audit the content and reusable-code matrix for all 24 era ranks"** ([#163](https://github.com/jamesm944/game/issues/163))  
Date: 2026-10-27  
Status: **Resolved (Comprehensive 24-Rank Architecture & Donor Mapping)**  
References: [ADR-0007](file:///Users/jamesmoss/Documents/game/docs/adr/0007-historical-epochs-and-eras-progression.md), [#140](https://github.com/jamesm944/game/issues/140), [#153](https://github.com/jamesm944/game/issues/153), [#160](https://github.com/jamesm944/game/issues/160), [#161](https://github.com/jamesm944/game/issues/161)

---

## 1. Reconciliation: Map #140 vs ADR-0007

Earlier roadmap notes (and `docs/research/historical-eras-architecture.md`) outlined a preliminary **6-epoch model** (Classical Antiquity $\to$ Feudal Middle Ages $\to$ Colonial Age of Sail $\to$ Industrial Revolution $\to$ World Wars $\to$ Cold War/Atomic).

ADR-0007 and Issue #153 superseded this with the **8 Master Epochs × 3 Sub-Age ladder (24 discrete sequential ranks)**:
1. **Ancient / Bronze Age** was restored as Epoch 1 (Ranks 1–3) to ground the Neolithic beginnings, stone megaliths, and the transition from hunter-gatherers to bronze-age city-states (essential for Dwarf Fortress/RimWorld primitive survival loops).
2. **Information & Digital Age** was added as Epoch 8 (Ranks 22–24) to complete the timeline into the modern 21st century (microprocessors, satellite surveillance, UAV drone swarms, precision standoff munitions, and cyberwarfare).
3. Each Master Epoch contains **3 Sub-Ages** representing early emergence, mature hegemony, and revolutionary transition.

This document serves as the authoritative, reconciled content and system matrix for all 24 ranks.

---

## 2. Global Mechanics Lifecycle & Obsolescence Pipeline

As civilizations progress through the 24 ranks, primitive systems are systematically supplanted by advanced socio-economic and technological paradigms:

```
┌────────────────────────┬───────────────────────────────────────────┬──────────────────────────────────────────┐
│ Pillar                 │ Primitive / Early Era Mechanism           │ Superseded / Modern Era Mechanism        │
├────────────────────────┼───────────────────────────────────────────┼──────────────────────────────────────────┤
│ Population & Labor     │ Manual Town Center training queue         │ Organic household demographics & wages   │
│ Food & Sustenance      │ Wild forage, hand fishing, basic plots    │ Mechanized agro-combines, refrigeration  │
│ Energy & Motive Power  │ Draft oxen, manual labor, watermills      │ Steam boilers, coal, electric grid, oil  │
│ Metallurgy & Materials │ Pit furnaces (Copper/Bronze, Bloomery)    │ Bessemer steel, synthetic polymers, Al   │
│ Urban Logistics        │ Hand-carried baskets, simple wheelbarrows │ Cargo trains, trucks, automated ports    │
│ Commerce & Finance     │ Barter trade, royal bullion minting       │ Stock exchanges, fiat banking, electronic│
│ Battlefield Doctrine   │ Clustered melee shock, loose arrow volleys│ Ranged line infantry, trench, combined   │
│ Warfare Mobility       │ Foot marches, horse cavalry shock         │ Mechanized APCs, railways, supersonic jet│
│ Information & Tech     │ Oral tradition, hand-copied monastic texts│ Printing press, telegraph, fiber web, AI │
│ Governance & Faith     │ Tribal clan elders, divine god-kings      │ Feudal oaths, parliaments, mass parties  │
└────────────────────────┴───────────────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 3. Comprehensive 24-Rank Content Matrix

### Epoch 1: Ancient / Bronze Age (Ranks 1–3)

#### Rank 1: Neolithic Farming & Clan Settlements
- **Hallmark Technologies:** Primitive Agriculture, Mudbrick Kilns, Fire Hardening, Flintknapping, Basket Weaving.
- **Resources & Commodities:** Wild Wheat, Timber, Clay, Flint, Hides, Fresh Water.
- **Recipes:** Clay + Heat $\to$ Mudbrick; Flint + Timber $\to$ Primitive Tools; Wheat + Mortar $\to$ Flour.
- **Unit Roster:**
  - *Infantry:* Clubman (crude blunt shock), Flint Slinger (light skirmisher).
  - *Support/Work:* Clan Gatherer, Primitive Builder, Pack Porter.
- **Building Roster:** Thatched Hut, Communal Firepit, Clay Pit, Granary Pit, Foraging Post.
- **Combat Transformation:** Tribal skirmishing, zero armor, pure blunt/pierce damage, unorganized swarming.
- **Great Wonder:** **Stonehenge Megaliths** (+30% cultural faith generation; seasonal crop forecaster).
- **Institutions & Social Classes:** Tribal Gatherers, Clan Elders, Shamanic Animism. Barter economy, zero currency.
- **Donor Module Reference:** *Widelands* (primitive building footprints, path-based porter hauling).

#### Rank 2: Bronze Metallurgy & Pastoralism
- **Hallmark Technologies:** Copper Smelting, Tin Alloying, Potter’s Wheel, Ox Yoke, Animal Domestication.
- **Resources & Commodities:** Copper Ore, Tin Ore, Bronze Ingots, Wool, Milk, Oxen.
- **Recipes:** 3 Copper + 1 Tin $\to$ 4 Bronze; Wool $\to$ Spun Yarn; Oxen + Yoke $\to$ Heavy Draft Plow.
- **Unit Roster:**
  - *Infantry:* Bronze Spearmen (levy line), Bronze Axe Warrior (anti-shield).
  - *Ranged:* Recurve Bowmen.
  - *Mount:* Ox Cart (slow supply transport).
- **Building Roster:** Bronze Smelter, Kiln Workshop, Pastoral Corrals, Earthen Dikes.
- **Combat Transformation:** First metallic armor and edged weapons; formation line bonuses introduced.
- **Great Wonder:** **Ziggurat of Ur** (Granary spoilage eliminated; +25% regional food security).
- **Institutions & Social Classes:** Pastoral Nomads, Craft Smiths, Priesthood. Temple redistribution economy.
- **Donor Module Reference:** *Augustus* (pottery and raw material supply chain chains).

#### Rank 3: Early Empires & Cuneiform Bureaucracy
- **Hallmark Technologies:** Cuneiform Script, Wheeled Chariots, Stone Masonry, Canal Irrigation, Standing Levies.
- **Resources & Commodities:** Papyrus/Clay Tablets, Carved Stone, Cedar Timber, Gold Dust.
- **Recipes:** Clay + Reed $\to$ Cuneiform Record; Bronze + Timber $\to$ War Chariot.
- **Unit Roster:**
  - *Mounted:* Light Bronze Chariot (fast hit-and-run mobile javelin/archery).
  - *Infantry:* Shielded Spearmen, City Guard.
  - *Siege:* Primitive Battering Ram.
- **Building Roster:** Chariot Stables, Scribe Archive, Irrigation Sluice, Stone Bastion.
- **Combat Transformation:** Shock chariots dominate flat plains; defensive perimeter walls force siege engines.
- **Great Wonder:** **Great Pyramids of Giza** (-20% stone construction costs; +15% worker health).
- **Institutions & Social Classes:** Slaves, Temple Scribes, Monarchic Dynasty. Centralized grain rations.
- **Donor Module Reference:** *Augustus* (quarry logistics, canal routing and monument construction phases).

---

### Epoch 2: Classical Antiquity (Ranks 4–6)

#### Rank 4: Hellenic City-States & Agora Civic Life
- **Hallmark Technologies:** Iron Smelting, Geometry, Coinage (Drachma), Phalanx Tactics, Trireme Maritime Design.
- **Resources & Commodities:** Iron Ore, Wrought Iron, Silver, Olive Oil, Wine, Marble.
- **Recipes:** Iron Ore + Charcoal $\to$ Wrought Iron; Olives + Press $\to$ Olive Oil; Grapes $\to$ Wine; Silver $\to$ Minted Coins.
- **Unit Roster:**
  - *Infantry:* Hoplite (interlocking hoplon shield phalanx, massive frontal resistance).
  - *Ranged:* Peltast (javelin skirmisher with crescent pelta shield).
  - *Naval:* Bireme (ramming oared galley).
- **Building Roster:** Agora Market, Olive Press, Gymnasium, Stone Amphitheater, Trireme Slipway.
- **Combat Transformation:** Rigid directional shield-walls (phalanxes resist frontal melee, vulnerable to flanking).
- **Great Wonder:** **Parthenon of Athens** (+40% Philosophy KP/min; free civic discourse in urban centers).
- **Institutions & Social Classes:** Free Citizens, Metics (foreign traders), Helots/Slaves. Direct democracy / oligarchy.
- **Donor Module Reference:** *Augustus* (market agora distribution, wine/oil pleasure ratings, plebeian unrest).

#### Rank 5: Republican Phalanxes & Highway Networks
- **Hallmark Technologies:** Paved Roads, Roman Concrete (Pozzolana), Ballista Engineering, Maniple Flexibility.
- **Resources & Commodities:** Pozzolanic Ash, Cut Basalt Pavers, Iron Gladium, Siege Timber.
- **Recipes:** Ash + Lime + Aggregate $\to$ Roman Concrete; Iron + Wood $\to$ Ballista Bolt.
- **Unit Roster:**
  - *Infantry:* Hastati/Principes (pilum throwing shock infantry), Triarii (veteran spear anchors).
  - *Cavalry:* Equites (light scout and counter-skirmish cavalry).
  - *Siege:* Torsion Ballista (precision anti-personnel/structure artillery).
- **Building Roster:** Paved Highway, Aqueduct Channel, Legionary Castra, Public Bathhouse.
- **Combat Transformation:** Pre-charge ranged pilum volleys disrupt enemy charges before sword clash.
- **Great Wonder:** **Colosseum of Rome** (+15% military morale; gladiator games suppress city unrest by 30%).
- **Institutions & Social Classes:** Patricians, Plebeians, Auxiliary Levies, Senate. Curia assemblies, taxation censuses.
- **Donor Module Reference:** *Widelands* / *Augustus* (paved road speed multipliers, water pressure in aqueducts).

#### Rank 6: Imperial Pax, Academies & Siege Engineering
- **Hallmark Technologies:** Catapult & Onager Artillery, Imperial Jurisprudence, Codex Books, Large Grain Fleets.
- **Resources & Commodities:** Parchment, Glassware, Purple Dye, Imported Grain, Lead Pipes.
- **Recipes:** Sand + Soda Ash $\to$ Glassware; Iron + Leather $\to$ Lorica Segmentata.
- **Unit Roster:**
  - *Infantry:* Imperial Legionary (heavy plate-and-shield discipline), Praetorian Guard (elite bodyguard).
  - *Siege:* Heavy Onager (area stone bombardment), Siege Tower.
  - *Naval:* Quinquereme (catapult-mounted naval flagship).
- **Building Roster:** Basilica of Law, Imperial Academy, Harbor Mole, Triumphal Arch.
- **Combat Transformation:** Heavy armor shrugs off light archery; standardized professional military formations.
- **Great Wonder:** **Library of Alexandria** (Classical research project costs -20%; +25% diffusion rate).
- **Institutions & Social Classes:** Imperial Bureaucracy, Equites Merchants, Provincial Subjects. Imperial grain dole.
- **Donor Module Reference:** *OpenRA* (formation movement queues, target prioritization and stance controls).

---

### Epoch 3: Medieval Era (Ranks 7–9)

#### Rank 7: Migration Dark Age & Motte-and-Bailey Forts
- **Hallmark Technologies:** Stirrup, Scramasax Ironwork, Motte-and-Bailey Timber Keeps, Heavy Horse Harness.
- **Resources & Commodities:** Bog Iron, Hardwood Timber, Salted Meat, Wool Felt.
- **Recipes:** Timber + Earthwork $\to$ Motte Keep; Raw Iron + Coal $\to$ Riveted Chainmail.
- **Unit Roster:**
  - *Infantry:* Saxon Fird/Levy (axe/spear shield wall), Huskarl (two-handed broadaxe shock).
  - *Cavalry:* Mounted Raider (fast raiding horseman).
  - *Naval:* Longship (shallow water river navigation, coastal disembark).
- **Building Roster:** Motte & Bailey Keep, Mead Hall, Salt Smokehouse, Palisade Wall.
- **Combat Transformation:** River-borne shock landings; two-handed axes cleave heavy wooden shields.
- **Great Wonder:** **Hagia Sophia** (Immunity to religious schism; +30% regional diplomatic leverage).
- **Institutions & Social Classes:** Chieftains, Tribal Warriors, Bondsmen. Raiding tribute economy.
- **Donor Module Reference:** *Voidstrike* / *OpenRA* (amphibious landing crafts, directional disembarkation).

#### Rank 8: High Feudal Manorialism & Stonework Castles
- **Hallmark Technologies:** Heavy Mouldboard Plow, Three-Field Crop Rotation, Watermills, Stained Glass, Stone Castles.
- **Resources & Commodities:** Quarried Limestone, Heavy Iron Plowshares, Flour, Leather Armor, Horses.
- **Recipes:** Grain + Watermill $\to$ Fine Flour; Iron Ore + Flux $\to$ Hardened Steel; Leather $\to$ Saddlery.
- **Unit Roster:**
  - *Infantry:* Man-at-Arms (armored halberdier/poleaxe), Crossbowman (armor-piercing bolt).
  - *Cavalry:* Feudal Knight (armored lance charge, devastating initial impact).
  - *Naval:* Cog (high-freeboard trading and troop transport).
- **Building Roster:** Concentric Stone Castle, Watermill, Windmill, Monastery Scriptorium, Tithe Barn.
- **Combat Transformation:** Heavy lance cavalry shock obliterates disorganized infantry; crossbow counters armor.
- **Great Wonder:** **Krak des Chevaliers** (Castle HP +50%; garrison archers gain armor-piercing ballista bolts).
- **Institutions & Social Classes:** Feudal Serfs, Monastic Clergy, Manorial Knights, Barons. Tithe and Corvée labor.
- **Donor Module Reference:** *Widelands* (three-field rotation, mill supply loops, deep grain-to-bread economy).

#### Rank 9: Late Medieval Chivalry, Guilds & Siege Trebuchets
- **Hallmark Technologies:** Full Plate Harness, Counterweight Trebuchet, Guild Charters, Double-Entry Bookkeeping.
- **Resources & Commodities:** Crucible Steel, Dyed Woollens, Spices, Heraldic Parchment.
- **Recipes:** Refined Steel + Artisan Forge $\to$ Full Plate Armor; Heavy Timber + Counterweight $\to$ War Trebuchet.
- **Unit Roster:**
  - *Infantry:* Swiss Pikeman (anti-cavalry hedge), Longbowman (heavy bodkin volley), Dismounted Knight.
  - *Cavalry:* Gendarme / Full Plate Knight (heavy barded warhorse).
  - *Siege:* Counterweight Trebuchet (massive range fortification breaker).
- **Building Roster:** Guildhall, Siege Workshop, Cathedral, Tournament Grounds, University.
- **Combat Transformation:** Pike squares repel cavalry; longbow bodkins and trebuchets dictate engagement range.
- **Great Wonder:** **Notre-Dame Cathedral** (Sunday Mass grants +25% civilization-wide morale boost).
- **Institutions & Social Classes:** Guild Masters, Journeymen, Urban Burghers, Royal Court. Autonomous city charters.
- **Donor Module Reference:** *DFHack* (artisan quality tiers, apprentice-to-master craft skill progressions).

---

### Epoch 4: Age of Discovery & Colonialism (Ranks 10–12)

#### Rank 10: Age of Sail & Oceanic Navigation
- **Hallmark Technologies:** Magnetic Compass, Astrolabe, Caravel Sternpost Rudder, Early Arquebus Gunpowder.
- **Resources & Commodities:** Saltpeter, Sulfur, Gunpowder, Naval Timber, Pitch & Tar.
- **Recipes:** Saltpeter + Charcoal + Sulfur $\to$ Black Powder; Timber + Pitch $\to$ Ocean-going Caravel.
- **Unit Roster:**
  - *Infantry:* Arquebusier (early matchlock firearm), Halberd Guard.
  - *Naval:* Caravel (fast ocean exploration), Armed Carrack (broadside cannons).
- **Building Roster:** Drydock, Gunpowder Mill, Cartographer’s Guild, Customhouse.
- **Combat Transformation:** Gunpowder weapons pierce all medieval plate; deep ocean exploration unlocked.
- **Great Wonder:** **Royal Observatory Greenwich** (Complete ocean shroud removal; naval sailing +25% speed).
- **Institutions & Social Classes:** Navigators, Marine Merchants, Chartered Explorers. Maritime trade monopolies.
- **Donor Module Reference:** *Generals Three.js Port* (projectile physics, ballistic arc trajectories, smoke emitters).

#### Rank 11: Mercantilism, Joint-Stock Charters & Bastion Forts
- **Hallmark Technologies:** Blast Furnaces, Flintlock Muskets, Chartered Joint-Stock Companies, Trace Italienne (Star Forts).
- **Resources & Commodities:** Pig Iron, Cast Iron Cannons, Tobacco, Cane Sugar, Silver Bullion.
- **Recipes:** Cast Iron + Gunpowder $\to$ 12-Pounder Cannon; Sugar Cane + Mill $\to$ Refined Sugar & Rum.
- **Unit Roster:**
  - *Infantry:* Tercios / Pike-and-Shot (interlocked musket and long pike blocks).
  - *Artillery:* Culverin (field artillery), Heavy Siege Mortar.
  - *Naval:* Galleon (heavy cargo and heavy broadside warship).
- **Building Roster:** Star Bastion Fortress, Foundry, Colonial Trading Post, Stock Exchange.
- **Combat Transformation:** Geometric star forts resist artillery; pike-and-shot balances shock and missile firepower.
- **Great Wonder:** **VOC Amsterdam Admiralty** (Merchant trading ships gain +40% speed and naval escort guns).
- **Institutions & Social Classes:** Merchant Capitalists, Stockholders, Plantation Laborers. Mercantilist bullionism.
- **Donor Module Reference:** *Generals Three.js Port* (explosive impact decals, building destruction physics).

#### Rank 12: The Enlightenment & Line Infantry Tactics
- **Hallmark Technologies:** Bayonet Socket, Flintlock Standard, Seed Drill, Social Contract Philosophy, Newspapers.
- **Resources & Commodities:** Cotton, Calico Textiles, Paper Stock, Fine Optics, Tea/Coffee.
- **Recipes:** Raw Cotton + Spinning Jenny $\to$ Bulk Textiles; Pulp + Press $\to$ Newspapers & Gazettes.
- **Unit Roster:**
  - *Infantry:* Line Infantry (socket bayonet, rolling volley fire), Light Grenadier, Highland Skirmisher.
  - *Cavalry:* Hussars (fast scouting and routing cavalry), Cuirassiers (armored pistol/saber cavalry).
  - *Artillery:* 6-Pounder Horse Artillery (mobile field battery).
  - *Naval:* Ship of the Line (three-deck 100-gun naval dreadnought of sail).
- **Building Roster:** Printing House, Coffeehouse, Royal Armory, Grand Opera House.
- **Combat Transformation:** Socket bayonets eliminate pikes completely; linear volley tactics maximize firepower density.
- **Great Wonder:** **Palace of Versailles** (Diplomatic treaty acceptance +50%; nobility unrest clamped to zero).
- **Institutions & Social Classes:** Philosophers, Intellectual Bourgeoisie, Factory Proto-Laborers. Constitutional limits.
- **Donor Module Reference:** *OpenRA* (line-formation holding, synchronized volley attack sequences).

---

### Epoch 5: Industrial Revolution (Ranks 13–15)

#### Rank 13: Steam Power & Coal Mining
- **Hallmark Technologies:** Newcomen/Watt Steam Engine, Coal Deep-Mining, Puddling Process, Macadam Roads.
- **Resources & Commodities:** Bituminous Coal, Coke, Wrought Iron Plates, Machine Parts.
- **Recipes:** Coal $\to$ Coke; Pig Iron + Coke $\to$ Puddled Iron; Steam Engine + Iron $\to$ Mechanical Pump.
- **Unit Roster:**
  - *Infantry:* Rifled Musketmen (Minié ball, precision range).
  - *Artillery:* Rifled Siege Cannon, Coehorn Trench Mortar.
  - *Naval:* Steam Paddle Sloop, Armored Floating Battery.
- **Building Roster:** Deep Coal Shaft, Puddling Furnace, Steam Engine House, Iron Foundry.
- **Combat Transformation:** Rifled barrels double effective infantry engagement range, slaughtering open cavalry charges.
- **Great Wonder:** **Crystal Palace** (World industrial exposition increases foreign immigration +30% for 10 min).
- **Institutions & Social Classes:** Factory Proletariat, Coal Miners, Mill Owners. Wage labor replaces agrarian ties.
- **Donor Module Reference:** *Widelands* (fuel consumption loops in smelters, road haulage network saturation).

#### Rank 14: Steel, Railways & Mass Factories
- **Hallmark Technologies:** Bessemer Steel Converter, Steam Locomotive & Rail, Telegraph, Mechanized Reapers.
- **Resources & Commodities:** Bessemer Steel, Rail Tracks, Machine Tools, Canned Rations.
- **Recipes:** Molten Iron + Air Blast $\to$ Structural Steel; Steel + Machinery $\to$ Steam Locomotive.
- **Unit Roster:**
  - *Infantry:* Repeating Rifle Infantry (lever-action/bolt fire).
  - *Artillery:* Armstrong Gun, Early Gatling Gun (rapid-fire crank weapon).
  - *Naval:* Steam Ironclad (armored turret warship, e.g. Monitor/Merrimack).
  - *Logistics:* Armored Supply Train (high-volume rail corridor supply).
- **Building Roster:** Bessemer Steel Mill, Railway Station, Locomotive Depot, Telegraph Office, Meatpacking Plant.
- **Combat Transformation:** Ironclads render wooden sailing navies instantly obsolete; railways mobilize armies in hours.
- **Great Wonder:** **Krupp Industrial Complex** (Factory steel consumption -25%; heavy artillery trained 50% faster).
- **Institutions & Social Classes:** Railway Barons, Trade Union Organizers, Industrial Workers. Strike actions emerge.
- **Donor Module Reference:** *Augustus* / *OpenRA* (train waypoint pathing, track reservation signals, depot logic).

#### Rank 15: Electrical Grid, Petroleum & Assembly Lines
- **Hallmark Technologies:** Hydroelectric/Coal Power Grid, Petroleum Distillation, Internal Combustion, Chemical Synthetics.
- **Resources & Commodities:** Crude Oil, Refined Kerosene, Gasoline, Copper Wiring, Rubber.
- **Recipes:** Crude Oil $\to$ Gasoline + Lubricants; Copper + Rubber $\to$ Insulated Electrical Cable.
- **Unit Roster:**
  - *Infantry:* Bolt-Action Regulars, Maxim Heavy Machine Gun Team.
  - *Artillery:* Quick-Firing Field Gun (hydraulic recoil, e.g. French 75).
  - *Naval:* Pre-Dreadnought Battleship, Torpedo Boat.
- **Building Roster:** Oil Derrick, Thermal Power Plant, Substation Grid, Chemical Works, Assembly Plant.
- **Combat Transformation:** Hydraulic recoil field guns and machine guns make infantry charges across open terrain suicidal.
- **Great Wonder:** **Edison Menlo Park Lab** (Electrical patent royalties grant +200 gold/min; tech research +25%).
- **Institutions & Social Classes:** Electrical Engineers, Petrochemical Workers, Monopolists. Mass electrification.
- **Donor Module Reference:** *Generals Three.js Port* (power-grid mechanics, building brownouts, electric conduits).

---

### Epoch 6: World Wars Era (Ranks 16–18)

#### Rank 16: Trench Warfare & The Great War
- **Hallmark Technologies:** Barbed Wire, Haber-Bosch Nitrogen Fixation, Poison Gas Synthesis, Aerial Reconnaissance.
- **Resources & Commodities:** High Explosives (TNT), Barbed Wire, Chlorine/Mustard Gas, Artillery Shells.
- **Recipes:** Ammonia + Nitric Acid $\to$ TNT Shells; Steel + Zinc $\to$ Barbed Wire Coils.
- **Unit Roster:**
  - *Infantry:* Trench Raider (grenades, trench club, gas mask), Heavy Machine Gun Nest.
  - *Artillery:* Heavy Howitzer (indirect off-screen grid bombardment).
  - *Armor:* Early Landship Tank (creeping trench-crossing armor).
  - *Air:* Biplane Scout / Fighter (reconnaissance and fabric-wing dogfights).
  - *Naval:* Dreadnought (all-big-gun battleship), U-Boat Submarine.
- **Building Roster:** Fortified Trench Network, Concrete Pillbox, Chemical Munitions Plant, Aerodrome Runway.
- **Combat Transformation:** Stalemate trench warfare; creeping artillery barrages; mustard gas area denial.
- **Great Wonder:** **Panama Canal** (Inter-oceanic naval transit distance reduced 80%; naval repair speed doubled).
- **Institutions & Social Classes:** Mass Conscripts, War Production Board Planners, Suffragettes. Total war mobilization.
- **Donor Module Reference:** *OpenRA* (fog of war shroud clearing, artillery shell scattering, smoke and toxic cloud fields).

#### Rank 17: Interwar Mobilization & Industrial Aeronautics
- **Hallmark Technologies:** All-Metal Monoplanes, Radio Transceivers, Diesel Engines, Synthetic Polymers, Mechanization.
- **Resources & Commodities:** Bauxite / Aluminum Ingots, Aviation Fuel, Diesel, Radio Tubes.
- **Recipes:** Bauxite + Electricity $\to$ Duralumin Alloy; Crude Oil $\to$ High-Octane AvGas.
- **Unit Roster:**
  - *Infantry:* Motorized Infantry (truck transport), Combat Engineer.
  - *Armor:* Cruiser Tank, Light Tankette.
  - *Air:* Monoplane Fighter, Twin-Engine Medium Bomber.
  - *Naval:* Heavy Fleet Cruiser, Aircraft Carrier Prototype.
- **Building Roster:** Aircraft Assembly Works, Aluminum Smelter, Radio Broadcast Tower, Naval Dockyard.
- **Combat Transformation:** Motorized logistics restore battlefield mobility; radio coordinates combined-arms units.
- **Great Wonder:** **Empire State Building** (Radio broadcast transmitter grants +20% civic cohesion and propaganda defense).
- **Institutions & Social Classes:** Industrial Technocrats, Mass Assembly Workers, Air Cadets. National planning councils.
- **Donor Module Reference:** *Generals Three.js Port* (vehicle physics, turret turning limits, radio broadcast ranges).

#### Rank 18: Mechanized Total War & Blitzkrieg
- **Hallmark Technologies:** Radar Early Warning, Cavity Magnetron, Ballistic Rockets (V2), Combined Arms Blitzkrieg.
- **Resources & Commodities:** High-Octane Synthetic Fuel, Heavy Armor Steel, Radar Cavity Components.
- **Recipes:** High Grade Steel + 88mm Gun $\to$ Heavy Main Battle Tank; Radar Unit + AA Battery $\to$ Guided Flak.
- **Unit Roster:**
  - *Armor:* Medium Tank (T-34 / Sherman), Heavy Breakthrough Tank (Tiger / IS-2), Tank Destroyer.
  - *Infantry:* Mechanized Panzergrenadier (halftrack transport, submachine guns, panzerfaust).
  - *Air:* Heavy Strategic Bomber (B-17), Piston Interceptor (Spitfire/Mustang), Dive Bomber (Stuka).
  - *Naval:* Fleet Aircraft Carrier, Escort Destroyer, Fleet Submarine.
- **Building Roster:** Underground Munitions Bunker, Radar Station, Ballistic Rocket Pad, Tank Factory.
- **Combat Transformation:** Combined-arms blitzkrieg (tanks + mechanized infantry + close air support); radar vectors fighters.
- **Great Wonder:** **Hoover Dam** (Supplies +500 MW zero-fuel power; eliminates blackout risks for heavy industry).
- **Institutions & Social Classes:** Military Staff Command, Wartime Rations Directorate, Resistance Partisans.
- **Donor Module Reference:** *OpenRA* (airbase refueling runways, anti-air tracking, submarine submergence/stealth).

---

### Epoch 7: Cold War & Atomic Era (Ranks 19–21)

#### Rank 19: Nuclear Deterrence & Jet Aviation
- **Hallmark Technologies:** Nuclear Fission, Centrifuge Enrichment, Turbojet Engines, Early Mainframe Computers.
- **Resources & Commodities:** Uranium Ore, Enriched U-235, Titanium, Magnetic Storage Tape.
- **Recipes:** Uranium Ore + Centrifuges $\to$ Enriched Uranium; Titanium + Jet Turbine $\to$ Supersonic Jet.
- **Unit Roster:**
  - *Armor:* First-Gen Main Battle Tank (Centurion, T-54).
  - *Infantry:* Cold War Rifle Platoon (Assault Rifles, RPG launchers).
  - *Air:* Swept-Wing Jet Fighter (MiG-15, F-86 Sabre), Jet Strategic Bomber (B-52).
  - *Strategic:* Nuclear Free-Fall Gravity Bomb.
  - *Naval:* Nuclear-Powered Aircraft Carrier (Supercarrier).
- **Building Roster:** Uranium Enrichment Plant, Nuclear Fission Reactor, Mainframe Center, Jet Runway.
- **Combat Transformation:** Nuclear deterrence (MAD); jet aviation compresses tactical air reaction windows to seconds.
- **Great Wonder:** **CERN Particle Accelerator** (High-energy physics unlocks research projects 30% faster).
- **Institutions & Social Classes:** Atomic Scientists, Cold War Bureaucrats, Military Industrialists. Fallout civil defense.
- **Donor Module Reference:** *Generals Three.js Port* (nuclear mushroom cloud volumetric particles, radiation damage areas).

#### Rank 20: Space Race & Telecommunications
- **Hallmark Technologies:** Multi-Stage Rocketry, Orbital Satellites, Solid-State Transistors, Global Radar Networks.
- **Resources & Commodities:** Rocket Propellant, Semiconductor Silicon, Composite Ceramics.
- **Recipes:** Silicon Ingot $\to$ Transistor Chips; Liquid Oxygen + Kerosene $\to$ Rocket Stage.
- **Unit Roster:**
  - *Air:* Supersonic Interceptor (Mach 2+), Tactical Strike Fighter.
  - *Armor:* Second-Gen MBT with composite armor and smoothbore cannons (T-72, M60A3).
  - *Naval:* Guided Missile Destroyer, Nuclear Attack Submarine (SSN).
  - *Strategic:* Orbital Spy Satellite (reveals target terrain through shroud continuously).
- **Building Roster:** Orbital Spaceport Launchpad, Satellite Uplink Dome, Semiconductor Fabrication Plant.
- **Combat Transformation:** Wire-guided anti-tank missiles (ATGMs) challenge tank supremacy; orbital reconnaissance.
- **Great Wonder:** **Kennedy Space Center** (Unlocks orbital surveillance array; space victory milestone).
- **Institutions & Social Classes:** Aerospace Engineers, Telecomm Technicians, Defense Contractors.
- **Donor Module Reference:** *Voidstrike* / *Generals* (orbital satellite entity, missile interceptor targeting).

#### Rank 21: Proxy Conflicts & Early Microcomputing
- **Hallmark Technologies:** Microprocessors, Guided Surface-to-Air Missiles (SAMs), Attack Helicopters, Night Vision.
- **Resources & Commodities:** Microprocessors, Rare Earth Minerals, Kevlar, Chobham Armor.
- **Recipes:** Silicon Wafer + Photolithography $\to$ Microprocessor; Kevlar + Ceramic $\to$ Body Armor.
- **Unit Roster:**
  - *Helicopters:* Attack Helicopter (AH-64 Apache, Mi-24 Hind - anti-tank missile gunships).
  - *Infantry:* Special Forces Operators (night vision, suppressed weapons, laser target designators).
  - *Armor:* Third-Gen Main Battle Tank (M1 Abrams, Leopard 2).
  - *Air:* Stealth Attack Aircraft (F-117), Anti-Radar SEAD Aircraft.
- **Building Roster:** High-Tech Park, Electronics Assembly, Helicopter Helipad, SAM Missile Battery.
- **Combat Transformation:** Attack helicopters provide vertical flanking; laser designators guide surgical air strikes.
- **Great Wonder:** **Three Gorges Dam** (Massive regional industrial power; flood barrier water control).
- **Institutions & Social Classes:** Defense Analysts, Tech Programmers, White-Collar Corporate Managers.
- **Donor Module Reference:** *Generals Three.js Port* (helicopter flight physics, strafing runs, SAM missile tracking).

---

### Epoch 8: Information & Digital Age (Ranks 22–24)

#### Rank 22: Digital Networks & GPS Precision Strike
- **Hallmark Technologies:** World Wide Web, GPS Satellite Constellation, Carbon-Fiber Composites, Fiber Optics.
- **Resources & Commodities:** High-Bandwidth Fiber, Lithium Batteries, Carbon Fiber, Precision Guidance Kits.
- **Recipes:** Lithium + Rare Earths $\to$ High-Density Battery; Munition + GPS Guidance $\to$ JDAM Precision Bomb.
- **Unit Roster:**
  - *Air:* Multi-Role 4.5 Gen Fighter, Unmanned Aerial Recon Drone (Predator).
  - *Infantry:* Modern Digital Infantry (integrated HUD battlefield networking, personal ceramic plates).
  - *Artillery:* GPS-Guided Rocket Artillery (HIMARS / MLRS).
  - *Naval:* Aegis Guided Missile Cruiser, Stealth Littoral Combat Ship.
- **Building Roster:** Internet Exchange Point, Lithium Battery Plant, Drone Ground Control Station.
- **Combat Transformation:** Standoff precision strikes; beyond-visual-range (BVR) missile engagements.
- **Great Wonder:** **Svalbard Global Seed Vault** (Complete immunity to global agricultural collapses/famines).
- **Institutions & Social Classes:** Internet Entrepreneurs, Globalization Financiers, Contract Gig Workers.
- **Donor Module Reference:** *Generals Three.js Port* (drone tethering, laser-guided projectile physics).

#### Rank 23: Global Automation & Renewable Grid
- **Hallmark Technologies:** Photovoltaic Solar Arrays, Industrial Robotics, Automated Container Ports, Advanced AI Models.
- **Resources & Commodities:** High-Purity Polysilicon, Neodymium Magnets, Graphene, AI Compute Clusters.
- **Recipes:** Silicon + Solar Cell Assembly $\to$ Solar Farm Array; Graphene + Composites $\to$ Light Armor.
- **Unit Roster:**
  - *Robotics:* Autonomous Robotic Sentry (ground unmanned combat vehicle), Automated Cargo Hauler.
  - *Air:* 5th-Gen Stealth Air Superiority Fighter (F-22, Su-57), Loitering Kamikaze Munitions.
  - *Naval:* Autonomous Drone Submarine (UUV), Drone Carrier Vessel.
- **Building Roster:** Gigafactory, Automated Container Terminal, Hyperscale Data Center, Solar Farm.
- **Combat Transformation:** Unmanned ground and air platforms absorb initial attrition; extreme stealth mechanics.
- **Great Wonder:** **ITER Fusion Experimental Reactor** (Clean unlimited civil power; energy maintenance costs drop 75%).
- **Institutions & Social Classes:** Automated System Architects, Data Analysts, Displaced Laborers. Universal basic dividend.
- **Donor Module Reference:** *Voidstrike* / *DFHack* (fully automated work orders and supply replenishment triggers).

#### Rank 24: Cyber Warfare & Precision Drone Swarms
- **Hallmark Technologies:** Quantum Encryption, Swarm Intelligence Mesh, Directed Energy Weapons, Cyber Infiltration.
- **Resources & Commodities:** Quantum Processors, Superconducting Alloys, Directed Energy Capacitors.
- **Recipes:** Quantum Chip + Fiber Network $\to$ Cyber Offensive Array; Micro-Capacitors $\to$ Laser Air Defense.
- **Unit Roster:**
  - *Air:* Autonomous Drone Swarms (hundreds of networked coordinated micro-drones overwhelming point defense).
  - *Energy Weapons:* Solid-State High-Energy Laser Vehicle (shoots down incoming artillery/missiles instantaneously).
  - *Cyber:* Electronic Warfare & Cyber Operative Unit (hacks enemy radar, disables grid substations remotely).
  - *Strategic:* Hypersonic Glide Vehicle (circumvents all standard anti-ballistic missile umbrellas).
- **Building Roster:** Quantum Cyber Command, Laser Defense Emplacement, Hypersonic Launch Silo.
- **Combat Transformation:** Cyber attacks shut down enemy production without firing a shot; drone swarms defeat single-target defenses.
- **Great Wonder:** **Global Quantum Orbital Mesh** (Disables enemy radar and satellite guidance map-wide; ultimate Information victory).
- **Institutions & Social Classes:** Cyber Defense Operatives, Transhumanist Specialists, Digital Citizens.
- **Donor Module Reference:** *Generals Three.js Port* / *OpenRA* (EMP / electronic disable effects, swarm steering behaviors).

---

## 4. Reusable Donor Code Mapping Matrix

```
┌──────────────────────────────┬───────────────────────────────┬────────────────────────────────────────────────────────┐
│ Target Era & Domain          │ Audited Donor Module          │ Verified Reusable Source Components                    │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Epoch 1 & 2 (Ancient/Class.) │ Augustus (Caesar III)         │ • Urban Agora market goods distribution                │
│                              │                               │ • Aqueduct water-pressure & fountain coverage          │
│                              │                               │ • Multi-stage monument construction phases             │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Epoch 1 to 4 (Logistics)     │ Widelands                     │ • Flag and road carrier transport network              │
│                              │                               │ • Three-field crop rotation & mill supply chains       │
│                              │                               │ • Warehouse stock quotas and regional distribution     │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Epoch 2 to 5 (Formations)    │ OpenRA                        │ • Directional shield wall / phalanx mechanics          │
│                              │                               │ • Shroud and fog-of-war reveal contracts               │
│                              │                               │ • Activity-based unit queues & naval pathing           │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Epoch 4 to 8 (Modern Combat) │ Generals Three.js Port        │ • Ballistic artillery arcs, projectile physics         │
│                              │                               │ • Smoke, fire, and explosion particle emitters         │
│                              │                               │ • Power-grid network & brownout logic                  │
│                              │                               │ • Helicopter flight physics & SAM missile tracking     │
│                              │                               │ • Laser / EMP electronic disable effects               │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Epoch 5 to 8 (Automation)    │ DFHack (Orders & Workflow)    │ • Automated production order thresholds                │
│                              │                               │ • Resource stock management policies                   │
│                              │                               │ • Artisan item quality tiers & crafting progression    │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Social Class & Unrest        │ RimWorld (RimWar / Needs)     │ • Faction settlement diplomacy & war prep              │
│                              │                               │ • Mood-ledger rollups, mental breaks, strikes          │
├──────────────────────────────┼───────────────────────────────┼────────────────────────────────────────────────────────┤
│ Rendering & Shaders (All)    │ Voidstrike (WebGPU/Three.js)  │ • TSL shader pipeline and instanced render passes      │
│                              │                               │ • Terrain brush, heightmap elevation generation        │
│                              │                               │ • Spatial audio buses & environmental sound emitters   │
└──────────────────────────────┴───────────────────────────────┴────────────────────────────────────────────────────────┘
```

---

## 5. Asset Gap Analysis & Production Checklist

1. **Visual Model Packs:**
   - *Ancient to Medieval (Ranks 1–9):* Currently supported by existing prototype glTF asset sets (peasant, militia, knight, two-handed swordsman, wood/stone buildings). Need Classical Greco-Roman kit (marble columns, hoplites, triremes).
   - *Colonial to Industrial (Ranks 10–15):* Missing musket infantry, line infantry, steam train, factory chimneys, ironclad hulls. (Can source from open-source historical kits or generate via asset pipeline).
   - *World Wars to Digital (Ranks 16–24):* Modern military assets (tanks, jet aircraft, missile launchers, modern skyscrapers). Generals TS port supplies several low-poly modern military models.
2. **Audio Foley & Voice Barks:**
   - 24-era progression requires tiered voice barks (from archaic grunts/shouts $\to$ medieval chivalric orders $\to$ radio military chatter $\to$ digital confirmation tones).
3. **Data Schema Migration:**
   - `src/data/schema.ts` currently defines `ageGate: 1..4`. This must be updated to `eraGate: 1..24` without breaking existing definitions.
   - All building, unit, and tech JSONs in `src/data/definitions/` map cleanly onto this 24-rank integer ladder.

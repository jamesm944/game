# Historical Epochs & Eras Progression Specification (24-Tier System)

- **Issue:** [jamesm944/game#153](https://github.com/jamesm944/game/issues/153)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140) (Wayfinder Map 6: AAA Supremacy)
- **Date:** 2026-10-17
- **Branch:** `research/df-rw-deep-sim`
- **ADR Reference:** [`docs/adr/0007-historical-epochs-and-eras-progression.md`](file:///Users/jamesmoss/Documents/game/docs/adr/0007-historical-epochs-and-eras-progression.md)
- **Glossary:** [`CONTEXT.md`](file:///Users/jamesmoss/Documents/game/CONTEXT.md)

---

## 1. Executive Summary

This specification defines the migration of the simulation from a 4-tier Middle Ages ladder (`dark`, `feudal`, `castle`, `imperial`) into an expansive **8 Master Epoch × 3 Sub-Age ladder (24 discrete ranks)** spanning human civilization from Neolithic farming through the Information and Digital Age.

Advancement between Epochs is governed by the **Triple Gate**:
1. Complete all prerequisite technological research for the active era.
2. Meet institutional socio-economic class readiness (social classes, literacy, infrastructure).
3. Complete or capture the **Era Wonder Quota** (4 Great Wonders in standard matches, up to 8 in marathon matches).

Pioneering civilizations that break into a new Epoch trigger **Technological Diffusion ("Tech Spread / Era Contagion")**, transmitting knowledge across merchant trade routes, maritime shipping lanes, and physical borders to accelerate lagging civilizations.

---

## 2. The 8 Master Epochs & 24 Sub-Age Ladder (`ERA_RANK: 1..24`)

| Epoch ID & Name | Sub-Age Rank & Sub-Age Name | Hallmarks & Key Technologies | Military Roster & Warfare Style | Social Classes & Economy |
| :--- | :--- | :--- | :--- | :--- |
| **1. Ancient / Bronze Age** | **Rank 1**: Neolithic Farming<br>**Rank 2**: Bronze Metallurgy<br>**Rank 3**: Early Empires | Agriculture, mudbrick kilns, copper/bronze smelting, pottery, wheel transport, stone megaliths. | Clubmen, slingers, copper spear levies, bronze chariots, composite bowmen. | Slaves, Clan Elders, Tribal Gatherers. Barter trade, communal granaries. |
| **2. Classical Antiquity** | **Rank 4**: Hellenic City-States<br>**Rank 5**: Republican Phalanxes<br>**Rank 6**: Imperial Pax & Academies | Philosophy academies, aqueducts, amphitheaters, paved highways, concrete masonry, naval triremes. | Hoplite phalanxes, legionaries, auxiliary cavalry, ballistas, catapults, Roman galleys. | Free Citizens, Patricians, Plebeians, Slaves. Silver drachma currency, Agora markets. |
| **3. Medieval Era** | **Rank 7**: Migration Dark Age<br>**Rank 8**: High Feudal Manorialism<br>**Rank 9**: Late Medieval Chivalry & Guilds | Thatch to stone castles, heavy mouldboard plow, windmills, watermills, stained glass, heraldry, guild charters. | Men-at-arms, longbowmen, crossbowmen, heavy armored knights, trebuchets, cogs, fire ships. | Serfs/Peasants, Guild Artisans, Clergy, Feudal Nobility. Manorial tithes, grain mills. |
| **4. Age of Discovery & Colonialism** | **Rank 10**: Age of Sail<br>**Rank 11**: Mercantilism & Gunpowder<br>**Rank 12**: The Enlightenment | Caravels, galleons, astrolabes, printing press, flintlock muskets, blast furnaces, chartered joint-stock companies. | Arquebusiers, musketeers, pikemen, field culverin cannon, line infantry, galleons, privateers. | Burghers, Merchant Capitalists, Indentured Servants, Plantation Labor. Overseas colonial trade. |
| **5. Industrial Revolution** | **Rank 13**: Steam & Coal<br>**Rank 14**: Steel, Railways & Factories<br>**Rank 15**: Electrical Grid & Petroleum | Steam engines, coal gasification, Bessemer steel converter, steam locomotives, telegraph, oil pumpjacks, assembly lines. | Rifled infantry, Gatling guns, steam ironclads, rifled siege howitzers, dreadnoughts. | Industrial Proletariat, Trade Unionists, Petite Bourgeoisie, Monopolist Capitalists. Cash wages, stock exchanges. |
| **6. World Wars Era** | **Rank 16**: Trench & Great War<br>**Rank 17**: Interwar Mobilization<br>**Rank 18**: Mechanized Total War | Internal combustion, synthetic rubber, Haber-Bosch nitrates, radio broadcast, radar, mass assembly, aerodynamics. | Bolt-action infantry, machine gun nests, armored tanks, fighter biplanes, heavy bombers, submarines, aircraft carriers. | Mass Conscripts, Factory Workers, State Planners, Party Cadres. Rationing, war bonds, total war economy. |
| **7. Cold War & Atomic Era** | **Rank 19**: Nuclear Deterrence & Jets<br>**Rank 20**: Space Race<br>**Rank 21**: Proxy Conflicts & Early Computing | Fission reactors, ballistic missiles, mainframe computing, jet aviation, transistor radios, satellite communications, television. | Mechanized infantry fighting vehicles, main battle tanks, supersonic jet fighters, guided missile cruisers, nuclear deterrence. | Salaried White-Collar Workers, Bureaucrats, Technical Specialists, Suburban Consumers. Welfare state, fiat currency. |
| **8. Information & Digital Age** | **Rank 22**: Digital & Internet<br>**Rank 23**: Global Automation<br>**Rank 24**: Cyber & Precision Drones | Microprocessors, fiber-optic web, GPS navigation, lithium energy, automated robotics, commercial aerospace, AI networks. | Precision guided munitions, stealth aircraft, unmanned drone swarms, cyber warfare operatives, electronic warfare suites. | Gig Workers, Tech Entrepreneurs, Globalized Labor, Digital Elite. Global financial markets, decentralized credit. |

---

## 3. The Great Wonders System

### 3.1 Rules & Mechanics
1. **Contested Global Uniqueness**: Each Great Wonder can only be constructed by **one civilization** across the entire match. If an opponent finishes a Wonder first, all competing construction sites on that wonder collapse into rubble and return 50% salvageable materials.
2. **Quota to Advance**: Advancing from Epoch $N$ to $N+1$ requires completing or controlling a quota of completed Wonders of Epoch $N$ (Default: **4 Wonders** in standard skirmish; up to **8** in epic/marathon games).
3. **Legacy Wonders Are Permanent & Powerful**: Wonders from previous eras (e.g. *The Great Pyramids* or *Colosseum*) remain buildable in later eras. They provide massive, permanent civilizational buffs (cultural prestige, knowledge generation, economic multipliers) and never lose value.
4. **Wonder Capture in Warfare**: When an army storms an enemy settlement holding a completed Wonder, occupying the site with an active garrison transfers that Wonder to the conqueror's quota as long as the garrison holds it.

### 3.2 Catalogue of Great Wonders by Epoch

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SAMPLE GREAT WONDERS CATALOGUE                                  │
├────────────────────┬─────────────────────────────┬───────────┬──────────────────────────────────┤
│ Epoch              │ Wonder Name                 │ Category  │ Civilizational Passive Bonus     │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 1. Ancient         │ Stonehenge Megaliths        │ Culture   │ +30% Faith gain, seasonal fore-  │
│                    │                             │           │ cast visibility on minimap.      │
│                    │ Great Pyramids of Giza      │ Monument  │ -20% building construction stone │
│                    │                             │           │ cost; +15% worker health.        │
│                    │ Ziggurat of Ur              │ Economic  │ Granary spoilage eliminated;     │
│                    │                             │           │ +25% food storage capacity.      │
│                    │ Oracle of Delphi            │ Knowledge │ Forewarns incoming raids 60s in  │
│                    │                             │           │ advance; +10% tech speed.        │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 2. Classical       │ Parthenon of Athens         │ Culture   │ +40% Philosophy KP/min; free     │
│                    │                             │           │ civic debate in Academies.       │
│                    │ Colosseum of Rome           │ Military  │ +15% soldier morale; gladiator   │
│                    │                             │           │ games reduce city unrest by 30%. │
│                    │ Great Lighthouse of Alex.   │ Economic  │ Naval sight range +4 tiles;      │
│                    │                             │           │ foreign trade cargo value +25%.  │
│                    │ Library of Alexandria       │ Knowledge │ Technology research cost -20%    │
│                    │                             │           │ across all classical branches.   │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 3. Medieval        │ Notre-Dame Cathedral        │ Faith     │ Sunday Mass gives +25% morale;   │
│                    │                             │           │ immunity to religious heresy.    │
│                    │ Krak des Chevaliers         │ Military  │ Castle HP +50%; garrison arrows  │
│                    │                             │           │ pierce through siege armor.      │
│                    │ Grand Bazaar of Istanbul    │ Economic  │ Market trade fee 0%; generates   │
│                    │                             │           │ passive gold per foreign caravan.│
│                    │ Oxford University           │ Knowledge │ Monks and scholars generate +2 KP│
│                    │                             │           │ per lesson tick; unlocks patent. │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 4. Discovery       │ Palace of Versailles        │ Culture   │ Diplomatic pact acceptance +50%; │
│                    │                             │           │ Nobility unrest clamped to 0.    │
│                    │ VOC Amsterdam Admiralty     │ Economic  │ Maritime trading freighters gain │
│                    │                             │           │ +40% speed and naval escort guns.│
│                    │ Tower of London Armory      │ Military  │ Gunpowder weapons -25% iron cost;│
│                    │                             │           │ +20% artillery reload speed.     │
│                    │ Royal Observatory Greenwich │ Knowledge │ Complete map ocean vision;       │
│                    │                             │           │ navigational sailing +25% speed. │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 5. Industrial      │ Crystal Palace              │ Culture   │ World exposition boosts foreign  │
│                    │                             │           │ immigration +30% for 10 minutes. │
│                    │ Brooklyn Bridge             │ Economic  │ Urban transit speed +35%; factory│
│                    │                             │           │ labor catchment radius doubled.  │
│                    │ Krupp Industrial Complex    │ Military  │ Factory steel consumption -25%;  │
│                    │                             │           │ heavy artillery trained +50% fast│
│                    │ Edison Menlo Park Lab       │ Knowledge │ Electrical patent royalties pay  │
│                    │                             │           │ +200 gold/min; tech research +25%│
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 6. World Wars      │ Hoover Dam                  │ Economic  │ Generates 5,000 KW electricity;  │
│                    │                             │           │ eliminates regional flood risks. │
│                    │ Maginot Fortress Citadel    │ Military  │ Concrete bastions immune to      │
│                    │                             │           │ artillery; heavy AT guns +30% dmg│
│                    │ Bletchley Park Station X    │ Knowledge │ Decrypts enemy orders 15 seconds │
│                    │                             │           │ before execution; detects spies. │
│                    │ Pentagon War Department     │ Military  │ Total war conscription speed 2x; │
│                    │                             │           │ military command radius global.  │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 7. Cold War        │ Baikonur Cosmodrome         │ Knowledge │ Launches orbital reconnaissance; │
│                    │                             │           │ unmasks fog of war permanently.  │
│                    │ NORAD Cheyenne Mountain     │ Military  │ Early warning for nuclear/aerial │
│                    │                             │           │ strikes; air defenses +40% range.│
│                    │ Bretton Woods Monetary Ctr  │ Economic  │ Global trade settlement currency;│
│                    │                             │           │ domestic inflation capped at 2%. │
│                    │ CERN Particle Accelerator   │ Science   │ Scientific breakthrough leaps;   │
│                    │                             │           │ unlocks advanced nuclear power.  │
├────────────────────┼─────────────────────────────┼───────────┼──────────────────────────────────┤
│ 8. Information     │ Silicon Valley Tech Campus  │ Knowledge │ Software automation boosts all   │
│                    │                             │           │ workplace outputs by +25%.       │
│                    │ Global Seed Vault (Svalbard)│ Survival  │ Agricultural immunity to blights;│
│                    │                             │           │ famine food reserve guaranteed.  │
│                    │ Three Gorges Megadam        │ Industry  │ Massive industrial power output; │
│                    │                             │           │ boosts heavy manufacturing +40%. │
│                    │ International Space Station │ Prestige  │ Unified scientific victory gate; │
│                    │                             │           │ diplomatic peace enforcement.    │
└────────────────────┴─────────────────────────────┴───────────┴──────────────────────────────────┘
```

---

## 4. Technological Diffusion ("Tech Spread / Era Contagion")

When Player A breaks through to Era $N+1$ before Player B, knowledge leaks across borders:

$$\Delta\text{DiffusionKP}_{\text{Player B}} = \sum_{\text{vectors}} \left( \text{TradeVolume} \times K_{\text{trade}} + \frac{K_{\text{proximity}}}{\text{BorderDistance}} + K_{\text{treaty}} \right)$$

1. **Trade Vectors**: Every trade caravan or cargo freighter completing a delivery between Player A and Player B deposits knowledge points proportional to cargo value.
2. **Border Proximity**: Border towns contiguous to an advanced player's territory passively absorb tech points per minute.
3. **Diplomatic Treaties**: Research agreements, open-border commercial treaties, and embassies double diffusion speed.
4. **Counter-Measures (Tariffs & Embargoes)**: A player can enact isolationist trade barriers to halt foreign ideological or cultural penetration, but doing so forfeits the technological catch-up bonus.

---

## 5. Organic Demographics & Macroeconomic Inflation

### 5.1 Household Formation & Fertility
- Pops do not spawn from button clicks at the Town Center.
- Single adult Pops seek romantic partners based on compatibility, social class, and geographic proximity.
- Upon marriage, they claim an available home or tenement apartment.
- **Fertility & Childbirth Probability**:
  $$P(\text{conception}) = \text{BaseFertility} \times \frac{\text{Household Savings} \times \text{Calorie Surplus}}{\text{Cost of Living} \times \text{Inflation Index}} \times (1 - \text{InfantMortality})$$
  - In prosperous peacetime with cheap bread and low taxes, families produce 3–5 children.
  - During severe inflation, famine, or wartime devastation, birth rates plummet toward zero.

### 5.2 Dynamic Inflation & Pricing Engine
$$\text{Local Price}_{\text{Commodity}} = \text{BaseCost} \times \left( \frac{\text{Local Demand}}{\text{Available Stockpile Supply}} \right) \times \left( 1 + \frac{\text{Treasury Minted Gold}}{\text{Gross Settlement Production}} \right)$$
- If the ruler prints fiat currency or dumps raw mined gold into the market without corresponding commodity growth, market inflation accelerates, eroding real wages and sparking cost-of-living protests.

---

## 6. Emergent Figures, Cults, Rebellion & Peace Treaties

### 6.1 Emergent Influential Figures
- Pops with rare traits (*Visionary*, *Charismatic*, *Zealot*, *Demagogue*) or Pops surviving catastrophic events transform into **Influential Figures**.
- They found dynamic **Ideological Cults or Religious Schisms**:
  - Preach in Taverns, Town Squares, Print Pamphlets, and Radio broadcasts.
  - Convert surrounding Pops, forming organized political factions with distinct policy demands.

### 6.2 The Escalation Spectrum & Rebel Negotiations
1. **Dissent (10–25% Pop converted)**: Street preaching, underground pamphlets, passive tax avoidance.
2. **Civil Disobedience (25–50% Pop converted)**: Workplace strikes, refusal to pay income tax, street demonstrations.
   - *Player Lever (Negotiation)*: The ruler can open **Rebel Negotiations** and concede to specific demands (e.g. lowering taxes, granting religious toleration, abolishing slavery, capping work hours) in exchange for restoring peace and maintaining the status quo.
3. **Armed Insurrection (50–70% Pop converted)**: Assassination of royal bailiffs, warehouse arson, formation of clandestine militias.
4. **Civil War & Secession (>70% Pop converted in a district)**:
   - Armed rebels seize local town halls and branch workplaces, raising their own faction flag.
   - The conflict escalates into an active military **Civil War**.
   - *Formal Peace Treaty System*: If the war grinds into a stalemate or the government cannot crush the rebellion, the ruler can sign a binding **Peace Treaty** that formally recognizes the breakaway faction as a **Sovereign Independent Nation** with legal borders, or institutes radical constitutional reform.

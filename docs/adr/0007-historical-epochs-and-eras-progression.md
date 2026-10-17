# Historical Epochs, Great Wonders & Ideological Transformation Architecture

- **ADR:** 0007
- **Date:** 2026-10-17
- **Status:** Accepted
- **Context Issue:** [jamesm944/game#153](https://github.com/jamesm944/game/issues/153) (Wayfinder Map 6: AAA Supremacy)

## Context

The simulation previously operated on a 4-tier Middle Ages progression model inherited directly from Age of Empires 2 (`dark`, `feudal`, `castle`, `imperial`, ranks 1 to 4). To support an expansive single-player grand strategy RTS spanning human technological, socio-economic, and political history—while integrating with the Victoria-style 10-tier social class and taxation model (issue #151)—the project requires an extensible, multi-era progression architecture.

## Decision

1. **8 Master Epochs & 24 Sub-Age Ladder**:
   - The 4-tier AoE2 age ladder is superseded by an **8 Master Epoch** progression model, with each Epoch comprising **3 Sub-Ages** (24 discrete sequential ranks in `ERA_RANK: 1..24`):
     1. **Ancient / Bronze Age** (Ranks 1–3: Neolithic Farming $\to$ Bronze Metallurgy $\to$ Early Empires)
     2. **Classical Antiquity** (Ranks 4–6: Hellenic City-States $\to$ Republican Phalanxes $\to$ Imperial Pax)
     3. **Medieval Era** (Ranks 7–9: Migration Dark Age $\to$ High Feudalism $\to$ Late Medieval Guilds & Chivalry)
     4. **Age of Discovery & Colonialism** (Ranks 10–12: Age of Sail $\to$ Mercantilism & Gunpowder $\to$ The Enlightenment)
     5. **Industrial Revolution** (Ranks 13–15: Steam & Coal $\to$ Steel, Railways & Factories $\to$ Electrical Grid & Petroleum)
     6. **World Wars Era** (Ranks 16–18: Trench Warfare $\to$ Interwar Mobilization $\to$ Mechanized Total War)
     7. **Cold War & Atomic Era** (Ranks 19–21: Nuclear Deterrence & Jets $\to$ Space Race $\to$ Proxy Warfare & Early Computing)
     8. **Information & Digital Age** (Ranks 22–24: Microchips & Internet $\to$ Global Automation $\to$ Precision Drones & Cyberwarfare)
   - Match setup allows selecting a **Starting Era** and an **Era Cap** (e.g., *Medieval Only*, *Colonial to Industrial*, or *Full Epoch Marathon*).

2. **The Triple Era Gate (Tech + Social Class + Great Wonders)**:
   - Advancing between major Epochs requires satisfying three conditions simultaneously:
     a. **Technological Mastery**: All prerequisite research projects of the current era completed.
     b. **Socio-Economic Institutional Readiness**: Required social class structures and industrial infrastructure active (e.g. established merchant companies for Colonialism; literate urban proletariat and coal logistics for Industrialization).
     c. **Great Wonder Quota**: Constructing or controlling a threshold of completed Great Wonders of that era (4 Wonders in standard matches, up to 8 in marathon games).
   - **Legacy Wonders**: Wonders from previous eras remain buildable in later eras as high-value, permanent cultural/economic landmarks.
   - **Wonder Capture**: Invading armies can storm and occupy enemy Great Wonders; as long as an active military garrison holds the site, the captured wonder counts toward the occupier's era advancement quota.

3. **Technological Diffusion ("Tech Spread / Era Contagion")**:
   - When a pioneering civilization breaks into the next historical epoch, its technological breakthroughs leak organically across the map.
   - Diffusion vectors:
     - Merchant trade caravans and cargo freighters generate Knowledge Diffusion Transfers ($\Delta\text{KP}$) upon completing foreign market trades.
     - Physical border proximity and shared road networks passively transfer tech progress to adjacent border settlements.
     - Formal diplomatic research pacts and embassies accelerate diffusion, while isolationist tariffs slow it down.

4. **Organic Household Demographics & Macroeconomic Inflation**:
   - Pop reproduction is removed from Town Center buttons and simulated organically at the Household level.
   - Adult couples form Households based on social class and housing availability. Fertility and childbirth scale with real purchasing power:
     $$\text{Fertility Chance} \propto \frac{\text{Household Savings} \times \text{Surplus Calorie Security}}{\text{Cost of Living} \times \text{Inflation Index}}$$
   - Market prices float dynamically based on local supply/demand and currency dilution from excessive royal gold minting.

5. **Influential Figures, Ideologies & Diplomatic Peace Deals**:
   - Exceptional Pops with visionary or charismatic traits dynamically emerge as **Influential Figures** (Philosophers, Prophets, Union Organizers, Cult Leaders).
   - Figures preach in Taverns, Town Squares, and through Print/Radio, establishing dynamic Ideologies and Faiths that convert Pops.
   - Rulers can adopt, tolerate, or persecute emergent movements.
   - Radicalized movements can escalate through strikes and sabotage to open **Civil War**. Rulers can negotiate with insurgents before open war by conceding to specific policy demands (tax relief, abolition, wage floors), or sign binding post-war **Peace Treaties** that recognize breakaway rebel provinces as sovereign independent nations.

## Consequences

- The `ageGate` property in `src/data/schema.ts` cleanly generalizes to an integer `eraGate: 1..24`, preserving bitECS fast array operations and 100% deterministic replay testing.
- Grand strategy campaigns and skirmishes gain unmatched multi-millennia scope without sacrificing the micro-intimacy of individual Pop lives.
- Golden fixture tests and replay hashes will be updated deliberately to reflect the extended era state ladder.

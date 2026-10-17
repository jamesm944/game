# Imperial Quests, Emperor Favor & Suzerainty Rewards

Design specification inspired by the classic **Caesar III / Augustus** Emperor Favor system, combined with **Anno** and **Crusader Kings III** suzerainty mechanics.

## 1. Core Mechanics

### A. The Emperor & The Imperial Court
- The player rules as a Governor, Vassal Lord, or Colonial Administrator answerable to a distant Emperor (or Imperial Court / Suzerain Hegemon).
- **Imperial Favor Meter (0 - 100):**
  - Starts at 50 (Neutral).
  - Slowly drifts down if ignored over time ("out of sight, out of mind").
  - Falls sharply if debts accumulate, requests are failed, or rebellious laws are passed.
  - If Favor drops below 10, the Emperor declares you a traitor and dispatches an Imperial Punitive Legion / Armada to depose you.

### B. Imperial Quests & Demands
1. **Resource Tribute Demands:** Emergency shipments of food, weapons, gold, or exotic luxury goods with strict deadlines.
2. **Military Conscription Orders:** Sending cohorts of veteran troops off-map to fight in the Emperor’s border wars.
3. **Legislative Decrees (Council Interaction):**
   - The Emperor commands you to pass specific laws (e.g. Imperial Tithes, Ban on Heretical Cults, Trade Monopolies).
   - This creates deep friction with your Town Council (#154), who may fiercely resist the Emperor's decrees.

### C. Spending Imperial Favor (Emperor's Boons)
Rather than just a survival check, high Favor becomes a powerful strategic currency:
- **Imperial Legion Reinforcements:** Call in elite Praetorian/Imperial Guard legions during siege crises.
- **Imperial Treasury Grants:** Emergency low-interest cash infusions or debt forgiveness.
- **Trade Charters:** Unlock high-value Imperial merchant routes that buy your goods at 2x market rates.
- **Royal Decrees:** Overrule a blocked Town Council vote by invoking Royal Imperial Prerogative.

## 2. Demographic Boons & Historical Epoch Transformation

### A. Demographics as Imperial Currency
In addition to treasury grants and military cohorts, Imperial Favor can be spent directly to acquire labor and population infusions:
- **Antiquity & Feudal Ages (Slaves & Serfs):**
  - Purchase enslaved captives or bonded serfs transported via Imperial galley or caravan.
  - Cost: Low Favor cost, but immediately generates abolitionist/ethical unrest among religious clergy and lower-class free citizens.
- **Colonial & Early Industrial Ages (Indentured Servants & Colonial Immigrants):**
  - Subsidize immigrant ships from the homeland metropolis to solve labor shortages in factories and mines.
- **Modern & Cold War Eras (Guest Workers, Refugees & Specialists):**
  - Request scientific defectors, engineers, and visa quotas from the President or General Secretary.

### B. Evolution of the Suzerain Across Eras
The identity and legislative power of the central ruler transforms dynamically as the world advances through epochs (#153):

| Historical Epoch | Suzerain Title | Demands & Favors Available | Legal Restraints |
| --- | --- | --- | --- |
| **1. Classical Antiquity** | **The Emperor / Tyrant** | Slaves, Praetorian Cohorts, Grain Ships | Absolute autocracy. Zero human rights checks. |
| **2. Feudal Middle Ages** | **The High King** | Feudal Levies, Royal Monopolies, Indulgences | Checked by Papacy/Church tithes and feudal oaths. |
| **3. Colonial Age of Sail** | **The Crown / Royal Charter** | Chartered Ships, Mercenaries, Convict Labor | Colonists demand home representation; mercantilist trade quotas. |
| **4. Industrial Revolution** | **Parliament / Prime Minister** | Immigrant Quotas, Capital Subsidies | Slavery outlawed. Child labor restricted. Unions strike. |
| **5. World Wars Era** | **The President / Dictator** | Conscription Quotas, Lend-Lease, War Bonds | Emergency Powers acts. Civil liberties suspended in war. |
| **6. Cold War & Atomic** | **Superpower Hegemon** | Marshall Plan Aid, Nuclear Umbrella, Defectors | International treaties, human rights conventions, proxy oversight. |

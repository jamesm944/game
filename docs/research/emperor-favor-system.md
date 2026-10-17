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

# Town Council, Legislative Mechanics & Narrative Event Engines

Research and architectural specification based on **Urban Empire**, **Frostpunk 2**, **The Guild 2/3**, and **Crusader Kings III**.

## 1. Prime Game Mechanics Analyzed

### A. Urban Empire & Frostpunk 2 (Parliamentary Legislation Grid)
- **Delegates & Quorum:** A 100-delegate council divided among interest groups (Nobility, Guild Merchants, Laborers, Clergy, Intelligentsia).
- **Vote Levers:**
  - **For / Against / Hesitant:** Hesitant seats can be lobbied via political capital, promises to build specific infrastructure, or granting agendas.
  - **Power Checks:** Executive decrees (tax hikes, emergency levies, conscription) can be vetoed by a hostile council.
  - **Supermajorities:** Radical changes (e.g., transition from Feudal Monarchy to Republic or Martial Dictatorship) demand 67%+ approval.

### B. The Guild 2/3 (Local Municipal Hierarchy & Corruption)
- Specific town offices (Mayor, Town Clerk, Magistrate, Guild Master).
- Bribery, blackmail, and political alliances to sway votes before key city council sessions.

### C. Narrative Storyline Chains (Crusader Kings & Frostpunk Dilemmas)
- Multi-stage event popups with stateful consequence flags:
  - Event triggers based on class unrest, low stockpiles, or war exhaustion.
  - Decisions grant temporary buffs/debuffs (e.g. +10% Tax Yield, -20 Morale to Poor Pops for 300 ticks) and seed follow-up dilemma events 2-5 minutes later.

---

## 2. Integration into Age of Wind Simulation

1. **ECS Representation:**
   - Council Component storing active `councillorIds`, `partyFactionCodes`, `approvalRating`, and `activeDebateBill`.
   - Pop Voting: On election ticks, Pops cast weighted votes based on their Class and ideological satisfaction.
2. **UI Surfaces:**
   - Town Hall Council Chamber view with delegate seat layout, party composition charts, and vote preview gauges.
   - Narrative dilemma dialogs with choices and calculated probability/consequence tooltips.

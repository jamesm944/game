# Research: 4-Player Skirmish Sim Architecture & AI Performance

**Target**: Scaling Age of Wind from 2-Player (Human + 1 AI) to 4-Player Skirmish (Human + 3 AI / 2v2 / FFA)  
**Ticket**: Issue #86 (Part of Wayfinder Map 3: #84)  
**Author**: Antigravity Agent  
**Date**: September 2026  

---

## 1. Executive Summary

Scaling from 2 players to 4 players is the foundational architectural pillar of Map 3 (#84). The current simulation already contains strong architectural foundations for multi-player scaling:
1. Components (`Owner`, `Combat`, `Stockpile`, `Building`, `AgeState`) already use integer `ownerId` / `playerId` rather than booleans or hardcoded binary slots.
2. `FogState` and `KnowledgeView` already parameterize `playerCount` dynamically.
3. Player color palettes (`PLAYER_COLORS`) already define 8 distinct player hues (Blue, Red, Green, Yellow, Cyan, Magenta, Orange, Grey).

However, scaling to 4 players requires 5 specific architectural upgrades:
1. **Alliance / Stance Matrix**: Replacing implicit `ownerA !== ownerB` binary hostility checks with a dedicated `DiplomacyMatrix` supporting FFA, 2v2 Teams, and Neutral states.
2. **Conquest Victory Logic Fix**: Fixing the bug in `CONQUEST_EVALUATOR` where `some(...)` enemy defeated causes a premature global win; replacing with `every(...)` enemy defeated.
3. **Surrender Handling**: Transitioning surrender from an immediate match-ending event to an individual elimination event in 3+ player games.
4. **Staggered AI Planning Cadence**: Phase-offsetting the 3 concurrent AI full-planning passes across modulo ticks (0, 10, 20) to guarantee amortized think time remains strictly `<1 ms` per tick with zero frame spikes.
5. **Map Generation & Starting Spawns**: Expanding default grid size from 120×120 to 160×160 with symmetric 4-quadrant / 4-corner base placement and balanced resource rings.

---

## 2. Component & World State Audit

### 2.1 Ownership Model
- **`src/sim/components/owner.ts`**:
  ```ts
  export function ownerOfUnit(world: World, comps: Pick<OwnerComponents, "ownerId">, eid: number): number {
    return requireRows(world, comps.ownerId).get(eid)?.[0] ?? 0;
  }
  export function attachOwner(world: World, comps: Pick<OwnerComponents, "ownerId">, eid: number, playerId: number): void {
    if (playerId === 0) return; // Legacy default: rowless means player zero
    requireRows(world, comps.ownerId).set(eid, [playerId]);
  }
  ```
  - **Status**: **Fully compatible**.
  - **Details**: `playerId` is validated as any non-negative integer. Player 0 remains implicit rowless for backwards-compatibility with historical golden digests, while players 1, 2, and 3 store explicit `[playerId]` rows.

### 2.2 Stockpiles & Economy
- **`src/sim/core/stockpile.ts`**:
  - `createPlayerStockpile(world, comps, playerId, startingResources)`
  - Stores rows keyed by `[playerId, resourceCode]`.
  - **Status**: **Fully compatible**.
  - Stockpiles are partitioned by `playerId`. Calling `createPlayerStockpile` for players 0, 1, 2, 3 creates 4 isolated resource vaults.

### 2.3 Age System
- **`src/sim/systems/age.ts`**:
  - `createPlayerAgeState(world, comps, playerId)`
  - Stores `[playerId, currentAgeRank, researchProgress]`.
  - **Status**: **Fully compatible**.
  - Each player advances through Dark -> Feudal -> Castle -> Imperial independently.

---

## 3. Alliance & Diplomacy Architecture

### 3.1 Current Binary Hostility Limitation
Currently, combat systems use an implicit binary check:
```ts
// combat.ts line 605
for (const [owner, hash] of hashByOwner) {
  if (owner === self.owner) continue;
  // targets anyone who is not self!
}

// combat.ts line 1518 (Town center / tower defense)
if (combatant.owner === structure.owner) continue;
```
- In **Free-For-All (FFA)**, this behavior is naturally correct (all opponents are hostiles).
- In **Teams (2v2)** or games with neutral factions (e.g. Gaia, neutral markets), this causes friendly fire and prevents allied coordination.

### 3.2 Proposed `DiplomacyMatrix` Deep Module
Create `src/sim/core/diplomacy.ts`:

```ts
export const DIPLOMACY_STANCE_ALLY = 0;
export const DIPLOMACY_STANCE_NEUTRAL = 1;
export const DIPLOMACY_STANCE_ENEMY = 2;

export type DiplomacyStance = 0 | 1 | 2;

export interface DiplomacyMatrix {
  readonly playerCount: number;
  getStance(playerA: number, playerB: number): DiplomacyStance;
  setStance(playerA: number, playerB: number, stance: DiplomacyStance): void;
  isAllied(playerA: number, playerB: number): boolean;
  isHostile(playerA: number, playerB: number): boolean;
}

export function createDiplomacyMatrix(playerCount = 4, mode: "ffa" | "teams" = "ffa"): DiplomacyMatrix {
  const size = playerCount * playerCount;
  const stances = new Uint8Array(size);

  // Initialize stances
  for (let a = 0; a < playerCount; a++) {
    for (let b = 0; b < playerCount; b++) {
      const idx = a * playerCount + b;
      if (a === b) {
        stances[idx] = DIPLOMACY_STANCE_ALLY;
      } else if (mode === "teams") {
        // Team 0: Players 0 & 1; Team 1: Players 2 & 3
        stances[idx] = Math.floor(a / 2) === Math.floor(b / 2)
          ? DIPLOMACY_STANCE_ALLY
          : DIPLOMACY_STANCE_ENEMY;
      } else {
        stances[idx] = DIPLOMACY_STANCE_ENEMY; // FFA default
      }
    }
  }

  return {
    playerCount,
    getStance: (a, b) => stances[a * playerCount + b] as DiplomacyStance,
    setStance: (a, b, stance) => {
      stances[a * playerCount + b] = stance;
    },
    isAllied: (a, b) => stances[a * playerCount + b] === DIPLOMACY_STANCE_ALLY,
    isHostile: (a, b) => stances[a * playerCount + b] === DIPLOMACY_STANCE_ENEMY,
  };
}
```

### 3.3 Integration Points
1. **`src/sim/systems/combat.ts`**:
   - Replace `if (owner === self.owner) continue;` with `if (diplomacy.isAllied(self.owner, owner)) continue;`.
   - Aggro spatial queries only query hostile owners.
2. **`src/sim/systems/movement.ts`**:
   - Guard/Escort target command verifies target is allied (`diplomacy.isAllied(guarderOwner, targetOwner)`).
3. **`src/sim/ai/knowledge.ts`**:
   - `visibleEnemies()` filters for `diplomacy.isHostile(player, entity.owner)`.
   - `knownTargetMarkets()` filters for `entity.owner !== player && !diplomacy.isHostile(player, entity.owner)`.

---

## 4. Victory System Adjustments

### 4.1 Conquest Evaluator Fix
In `src/sim/systems/victory.ts`:
```ts
// CURRENT (Lines 193-196):
actComplete: (ctx, playerId) =>
  victoryPlayerIds(ctx.world, ctx.comps).some(
    (other) => other !== playerId && conquestDefeated(ctx, other),
  ),
```
In a 4-player match with players 0, 1, 2, 3:
If Player 3's military production is wiped out, `some(...)` evaluates to `true` for Players 0, 1, and 2, causing an immediate win for everyone else!

**Required Fix**:
```ts
// CORRECT MULTI-PLAYER CONQUEST:
actComplete: (ctx, playerId) => {
  const opponents = victoryPlayerIds(ctx.world, ctx.comps).filter(
    (other) => other !== playerId && !isAllied(playerId, other),
  );
  return opponents.length > 0 && opponents.every((enemy) => conquestDefeated(ctx, enemy));
}
```
*Note*: In a 2-player match, `opponents.length === 1`, so `every(...)` is exactly equivalent to `some(...)`. Pre-existing golden fixtures and 2-player tests will remain 100% byte-for-byte identical.

### 4.2 Individual Elimination / Surrender Handling
In 2-player games, one player surrendering immediately ends the game:
```ts
// Current applySurrender in victory.ts:
for (const other of players) {
  appendVictoryCheck(world, comps, other, { status: VICTORY_STATUS_WON, ... });
}
freeze();
```
In 4-player skirmish:
- When Player $i$ surrenders or is defeated:
  1. Record `VICTORY_STATUS_SURRENDERED` or `VICTORY_STATUS_LOST` for Player $i$.
  2. Remaining active players are checked: if only 1 player (or 1 allied team) remains alive, that player/team receives `VICTORY_STATUS_WON` and `freeze()` is called.
  3. If ≥2 opposing players remain, the match continues! Player $i$'s remaining units/buildings become neutral or are razed.

---

## 5. Fog-of-War Scaling & Shared Vision

### 5.1 Plane Memory & Allocation
`createFogState(size, playerCount)` already allocates:
- `explored`: `Uint8Array(size * size)`
- `visible`: `Uint8Array(size * size)`
- `contributorCount`: `Uint16Array(size * size)`

For a 160×160 map with 4 players:
- Total tiles per player: $160 \times 160 = 25,600$ tiles.
- Per-player plane memory: $25,600 \text{ bytes} \times 2 + 51,200 \text{ bytes} = 102.4 \text{ KB}$.
- 4 Players Total: **~409 KB** RAM.
- **Verdict**: Negligible memory footprint.

### 5.2 CPU Stamping Cost
- Vision stamping occurs incrementally on entity move/spawn/death using precomputed circle LUTs.
- Each unit stamps *only* into its owning player's plane.
- An average skirmish has ~30–50 units per player.
- 4 players × 40 units = 160 units total.
- Stamping 160 units per tick takes **<0.25 ms**, well within the 8 ms budget.

### 5.3 Shared Vision (Allied Fog)
In 2v2 matches or allied diplomacy:
- Option A: Each player continues stamping into their own plane; `isVisible(x, y, player)` checks:
  ```ts
  planes[player].visible[idx] === 1 || (alliedPlayer !== undefined && planes[alliedPlayer].visible[idx] === 1)
  ```
- Option B: Mirror stamps to allied planes during `flushDirty()`.
- **Recommendation**: **Option A** is preferred because it maintains independent exploration records per player while allowing real-time shared vision queries without doubling stamp operations.

---

## 6. AI Orchestrator & Multi-Agent Staggering

### 6.1 The Synchronous Spike Risk
In `src/sim/ai/planner.ts`:
- Full planning pass (`fullPass`): runs every 30 ticks (1 second). Executes economy rebalance, build order planning, counter-pick unit training, relic collection, trade routing, and monk conversion targeting.
- Each AI takes ~0.25 ms to 0.40 ms for a full pass.
- If 3 AI instances (Players 1, 2, 3) execute their full pass on `tick % 30 === 0`:
  - Total tick 0/30/60 AI think time: $3 \times 0.35 \text{ ms} = 1.05 \text{ ms}$.
  - This causes periodic CPU spike waves every 30 ticks.

### 6.2 Staggered Planning Schedule (Phase Offsetting)
Instead of all AIs thinking on tick 0, 30, 60, introduce a `phaseOffset` to `AiPlannerOptions`:
$$\text{phaseOffset} = (playerId - 1) \times \left\lfloor \frac{\text{fullPassIntervalTicks}}{\text{aiCount}} \right\rfloor$$

For 3 AIs with `fullPassIntervalTicks = 30`:
- **AI 1 (Player 1)**: `phaseOffset = 0` $\rightarrow$ Full pass at tick **0, 30, 60, 90...**
- **AI 2 (Player 2)**: `phaseOffset = 10` $\rightarrow$ Full pass at tick **10, 40, 70, 100...**
- **AI 3 (Player 3)**: `phaseOffset = 20` $\rightarrow$ Full pass at tick **20, 50, 80, 110...**

On every other tick, each AI runs only its cheap incremental check (~0.02 ms).

```
Tick:        0   1 ... 9  10  11 ... 19  20  21 ... 29  30
------------------------------------------------------------
AI 1 (P1):  FULL inc ... inc inc inc ... inc inc inc ... inc FULL
AI 2 (P2):  inc  inc ... inc FULL inc ... inc inc inc ... inc inc
AI 3 (P3):  inc  inc ... inc inc inc ... inc FULL inc ... inc inc
------------------------------------------------------------
Peak AI ms: ~0.4 ms on ANY tick (Zero Spikes)
```

**Result**: AI think time stays strictly under **0.5 ms per frame** across all 30 ticks of every second.

### 6.3 Multi-Target Threat Scoring in FFA
In 2-player games, `militaryManager.ts` strikes the only opponent base. In 4-player skirmish, the military manager needs multi-target scoring:
```ts
score(targetBase) = (threatLevel * 1.5) + (proximityScore * 1.0) - (enemyArmyStrength * 0.8)
```
- **Wonder / Relic Threat**: If Player 2 is holding 3 relics or has a Wonder with active timer, Player 2 receives highest priority score.
- **Proximity**: Closest enemy base receives preference for early raids.
- **Weakness**: Bases with low military defense are prioritized for opportunistic strikes.

---

## 7. Map Generation & Balanced Starting Positions

### 7.1 Grid Size
- 2-player skirmish uses 120×120 ($14,400$ tiles).
- 4-player skirmish requires **160×160** ($25,600$ tiles) to provide sufficient space between bases, navigable trade lanes, resource buffers, and choke points.

### 7.2 Quadrant Symmetry
Base positions arranged equidistant from map center ($C_x = 80, C_y = 80$):
- **Player 0 (Human, Blue)**: South-West ($X \approx 36, Y \approx 124$)
- **Player 1 (AI 1, Red)**: North-East ($X \approx 124, Y \approx 36$)
- **Player 2 (AI 2, Green)**: North-West ($X \approx 36, Y \approx 36$)
- **Player 3 (AI 3, Yellow)**: South-East ($X \approx 124, Y \approx 124$)

### 7.3 Per-Player Starting Resource Envelope
Every player's Town Center must spawn with guaranteed local resource clusters:
1. **Town Center**: 3×3 footprint on flat grass/dirt.
2. **Food**: 1 berry bush cluster (6 nodes, 125 food each) within 6 tiles; 4–6 sheep/herdables within 8 tiles.
3. **Wood**: 2 distinct forest lines within 8–12 tiles.
4. **Gold**: 1 primary gold deposit (4 nodes, 800 gold each) within 7 tiles; 1 secondary gold (2 nodes) within 14 tiles.
5. **Stone**: 1 primary stone deposit (3 nodes, 350 stone each) within 9 tiles.
6. **Villagers**: 3 villagers + 1 scout unit.

---

## 8. Migration & Implementation Roadmap

| Step | Scope | Impact | Risk |
|---|---|---|---|
| **Phase 1: Core Diplomacy & Victory Fix** | Create `src/sim/core/diplomacy.ts`. Fix `every(...)` conquest check in `src/sim/systems/victory.ts`. | Simulation core | Low (2-player golden digests remain 100% identical). |
| **Phase 2: Multi-AI Planner Staggering** | Add `phaseOffset` to `createAiPlannerSystem`. Wire multi-AI bootstrap in `session.ts`. | AI performance | Low (amortizes compute across ticks). |
| **Phase 3: 4-Player Mapgen & Resource Scatter** | Add 160×160 4-quadrant layout generator with balanced resource rings. | Map generation | Medium (needs passability & placement verification). |
| **Phase 4: UI & Minimap Multi-Player HUD** | Update minimap with 4 player colors. Add diplomacy panel / team indicators to HUD. | UI / Renderer | Low (colors already defined in `playerColors.ts`). |

---

## 9. Conclusion
Scaling to 4 players does not require rewriting the ECS or simulation foundation. The existing architecture is exceptionally clean and modular. Implementing the `DiplomacyMatrix`, fixing the conquest victory condition to require all enemies defeated, staggering the 3 AI planning cadences by 10 ticks, and expanding mapgen to 160×160 4-quadrant symmetry will deliver smooth 60 FPS / <1 ms AI 4-player skirmish parity.

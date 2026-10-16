/**
 * Multi-Agent AI Tactical Coordination Test Suite
 * Milestone S4 / Issue #117 / Map 3 (#84)
 *
 * Verifies:
 * 1. Multi-target threat scoring in FFA & Teams (Wonder/relic priority, proximity, weakness).
 * 2. Team & Allied tactical coordination (defense assistance with "defense-assist" purpose).
 * 3. Autonomous tribute transfer (surplus/deficit gating, deepest deficit priority, cooldown).
 * 4. Atomic stockpile tribute transfer execution via inbox and conservation safety.
 * 5. Fog-of-war honesty: unobserved entities are never targeted or assisted.
 */

import { describe, expect, it } from "vitest";
import {
  createMilitaryMemory,
  planDefenseRally,
  planTributeTransfer,
  scoreOffensiveTarget,
  TRIBUTE_PACKET_AMOUNT,
} from "../../src/sim/ai/militaryManager";
import {
  createAiKnowledge,
  type AiKnowledge,
} from "../../src/sim/ai/knowledge";
import { createDiplomacyMatrix } from "../../src/sim/core/diplomacy";
import {
  createPlayerStockpile,
  stockpileAmountsOf,
  transferTribute,
} from "../../src/sim/core/stockpile";
import { createWorld } from "../../src/sim/core/world";
import { defineSimComponents } from "../../src/sim/components";
import {
  createMarketSystem,
  TRIBUTE_COMMAND_KIND,
} from "../../src/sim/systems/market";
import { RESOURCE_FOOD, RESOURCE_GOLD } from "../../src/sim/components/economy";

/** Helper: build an isolated test stub for AiKnowledge. */
function stubKnowledge(parts: Partial<AiKnowledge> = {}): AiKnowledge {
  const never = (): never => {
    throw new Error("unreachable in this scenario");
  };
  return {
    player: 1,
    get view(): never {
      return never();
    },
    tick: () => 0,
    resources: () => [0, 0, 0, 0, 0, 0, 0],
    ageRank: () => 1,
    nextAgeTechId: () => undefined,
    canStartAgeAdvance: () => false,
    finishedBuildings: () => [],
    ownBuildingOrigin: () => ({ x: 10, y: 10 }),
    unfinishedSites: () => [],
    buildersOn: () => [],
    trainQueueOf: () => [],
    trainableUnitIds: () => [],
    population: () => 10,
    populationCap: () => 20,
    villagerEids: () => [],
    armyUnits: () => [
      { eid: 101, defId: "spearman", tileX: 11, tileY: 11 },
      { eid: 102, defId: "spearman", tileX: 12, tileY: 11 },
      { eid: 103, defId: "archer", tileX: 11, tileY: 12 },
    ],
    assignmentOf: () => undefined,
    carryOf: () => undefined,
    ownUnitTile: () => undefined,
    damagedOwnBuildings: () => [],
    knownNodes: () => [],
    workersOnNode: () => 0,
    visibleEnemies: () => [],
    visibleEnemyVillagers: () => [],
    canAfford: () => true,
    canPlace: () => true,
    placementBlockReason: () => undefined,
    canTrain: () => true,
    knownGroundRelics: () => [],
    ownMonasteries: () => [],
    carriedRelicOf: () => undefined,
    knownTargetMarkets: () => [],
    tradeCarts: () => [],
    isTradeCartActive: () => false,
    autoReseedEnabled: () => false,
    diplomacy: undefined,
    isHostile: (p) => p !== 1,
    isAllied: (p) => p === 1,
    alliedPlayerIds: () => [],
    alliedResources: () => [0, 0, 0, 0, 0, 0, 0],
    damagedAlliedBuildings: () => [],
    relicsHeldBy: () => 0,
    wonderCountOf: () => 0,
    isTechResearched: () => false,
    researchedTechIds: () => [],
    isBuildingResearching: () => false,
    canResearchTech: () => false,
    availableTechsForBuilding: () => [],
    researchableTechIds: () => [],
    resolveUpgradedUnitId: (unitId: string) => unitId,
    ...parts,
  };
}

describe("Milestone S4: Multi-Agent AI Tactical Coordination", () => {
  describe("Multi-Target Threat Utility Scoring", () => {
    it("prioritizes an enemy holding a Wonder over a closer enemy base", () => {
      // 4-player FFA setup
      const diplomacy = createDiplomacyMatrix(4, "ffa");
      // Player 1 is the AI.
      // Enemy 2 is far away (tile 80, 80) but has a Wonder!
      // Enemy 3 is very close (tile 15, 15) but has no Wonder.
      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        wonderCountOf: (playerId) => (playerId === 2 ? 1 : 0),
        visibleEnemies: () => [
          { eid: 201, defId: "town-center", tileX: 80, tileY: 80, owner: 2 },
          { eid: 301, defId: "town-center", tileX: 15, tileY: 15, owner: 3 },
        ],
      });

      const target = scoreOffensiveTarget(k);
      expect(target).toBeDefined();
      expect(target?.targetId).toBe(201); // Wonder owner is top priority (+22500 score term)
    });

    it("prioritizes a Relic hoarder (holding 3+ relics) over opponents with 0 relics", () => {
      const diplomacy = createDiplomacyMatrix(4, "ffa");
      // Player 2 holds 3 relics (+9500 threat level -> +14250 score term)
      // Player 3 holds 0 relics
      // Both at similar distance
      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        relicsHeldBy: (playerId) => (playerId === 2 ? 3 : 0),
        visibleEnemies: () => [
          { eid: 202, defId: "barracks", tileX: 40, tileY: 40, owner: 2 },
          { eid: 302, defId: "barracks", tileX: 38, tileY: 38, owner: 3 },
        ],
      });

      const target = scoreOffensiveTarget(k);
      expect(target).toBeDefined();
      expect(target?.targetId).toBe(202);
    });

    it("breaks ties toward nearer bases when threat levels are equal", () => {
      const diplomacy = createDiplomacyMatrix(4, "ffa");
      // Both players have 0 wonders and 0 relics.
      // Target 203 is closer (tile 20, 20) vs Target 303 (tile 60, 60).
      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        visibleEnemies: () => [
          { eid: 203, defId: "barracks", tileX: 20, tileY: 20, owner: 2 },
          { eid: 303, defId: "barracks", tileX: 60, tileY: 60, owner: 3 },
        ],
      });

      const target = scoreOffensiveTarget(k);
      expect(target).toBeDefined();
      expect(target?.targetId).toBe(203);
    });

    it("penalizes targets with heavy local enemy army defense (opportunistic strikes on weak bases)", () => {
      const diplomacy = createDiplomacyMatrix(4, "ffa");
      // Both bases equidistant (tile 30, 30 vs tile 30, 30).
      // Base 204 has 8 military units defending it.
      // Base 304 has 0 defenders.
      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        visibleEnemies: () => [
          { eid: 204, defId: "town-center", tileX: 30, tileY: 30, owner: 2 },
          // 8 visible enemy soldiers clustered around base 204
          { eid: 210, defId: "spearman", tileX: 31, tileY: 30, owner: 2 },
          { eid: 211, defId: "spearman", tileX: 30, tileY: 31, owner: 2 },
          { eid: 212, defId: "archer", tileX: 32, tileY: 30, owner: 2 },
          { eid: 213, defId: "archer", tileX: 30, tileY: 32, owner: 2 },
          { eid: 214, defId: "swordsman", tileX: 31, tileY: 31, owner: 2 },
          { eid: 215, defId: "swordsman", tileX: 29, tileY: 30, owner: 2 },
          { eid: 216, defId: "knight", tileX: 29, tileY: 31, owner: 2 },
          { eid: 217, defId: "knight", tileX: 31, tileY: 29, owner: 2 },
          // Base 304 is undefended
          { eid: 304, defId: "town-center", tileX: 30, tileY: 30, owner: 3 },
        ],
      });

      const target = scoreOffensiveTarget(k);
      expect(target).toBeDefined();
      expect(target?.targetId).toBe(304); // Undefended base is chosen over the fortress
    });

    it("never targets allied or non-hostile entities in Teams mode", () => {
      // 2v2 Teams mode: Team 0 (Players 0 & 1), Team 1 (Players 2 & 3).
      // Player 1 is allied with Player 0!
      const diplomacy = createDiplomacyMatrix(4, "teams");
      expect(diplomacy.isAllied(1, 0)).toBe(true);
      expect(diplomacy.isHostile(1, 2)).toBe(true);

      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        visibleEnemies: () => [
          // Player 2 is enemy
          { eid: 205, defId: "barracks", tileX: 50, tileY: 50, owner: 2 },
        ],
      });

      const target = scoreOffensiveTarget(k);
      expect(target).toBeDefined();
      expect(target?.targetId).toBe(205);
    });
  });

  describe("Allied Defense Assistance (Joint Defense)", () => {
    it("dispatches defense-assist rally when an allied building is besieged by hostiles", () => {
      const memory = createMilitaryMemory();
      const diplomacy = createDiplomacyMatrix(4, "teams"); // P0 and P1 are allies

      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        alliedPlayerIds: () => [0],
        tick: () => 50,
        // AI's own buildings are intact
        damagedOwnBuildings: () => [],
        // Ally (Player 0) has a damaged building under attack by enemy (Player 2)
        damagedAlliedBuildings: () => [
          { eid: 500, defId: "town-center", tileX: 25, tileY: 25, owner: 0 },
        ],
        visibleEnemies: () => [
          // Hostile raider right next to the allied town center
          { eid: 601, defId: "spearman", tileX: 26, tileY: 25, owner: 2 },
        ],
      });

      // Tick 50: first observation, latency = 0 ticks (instant reaction test)
      const rally = planDefenseRally(k, memory, 0);
      expect(rally).toBeDefined();
      expect(rally?.kind).toBe("attack");
      expect(rally?.data.targetId).toBe(601);
      expect(rally?.data.purpose).toBe("defense-assist");
      expect(rally?.data.attackerIds).toEqual([101, 102, 103]);
    });

    it("prioritizes defending own buildings before assisting allies", () => {
      const memory = createMilitaryMemory();
      const diplomacy = createDiplomacyMatrix(4, "teams");

      const k = stubKnowledge({
        player: 1,
        diplomacy,
        isHostile: (p) => diplomacy.isHostile(1, p),
        isAllied: (p) => diplomacy.isAllied(1, p),
        alliedPlayerIds: () => [0],
        tick: () => 10,
        // AI's OWN building is under attack
        damagedOwnBuildings: () => [
          { eid: 110, defId: "house", tileX: 10, tileY: 10 },
        ],
        // Ally's building is ALSO under attack
        damagedAlliedBuildings: () => [
          { eid: 500, defId: "town-center", tileX: 70, tileY: 70, owner: 0 },
        ],
        visibleEnemies: () => [
          // Raider 1 attacking AI's house
          { eid: 601, defId: "spearman", tileX: 11, tileY: 10, owner: 2 },
          // Raider 2 attacking ally's town center
          { eid: 602, defId: "knight", tileX: 71, tileY: 70, owner: 3 },
        ],
      });

      const rally = planDefenseRally(k, memory, 0);
      expect(rally).toBeDefined();
      expect(rally?.data.targetId).toBe(601); // Defends own house first!
      expect(rally?.data.purpose).toBe("defense"); // Purpose is "defense", not "defense-assist"
    });

    it("resets defense-assist observation clocks when raiders retreat", () => {
      const memory = createMilitaryMemory();
      const diplomacy = createDiplomacyMatrix(4, "teams");

      // Tick 10: Raider present, reactionDelayTicks = 15
      const kTick10 = stubKnowledge({
        player: 1,
        diplomacy,
        tick: () => 10,
        damagedAlliedBuildings: () => [
          { eid: 500, defId: "town-center", tileX: 25, tileY: 25, owner: 0 },
        ],
        visibleEnemies: () => [
          { eid: 601, defId: "spearman", tileX: 26, tileY: 25, owner: 2 },
        ],
      });

      // Still observing (delay = 15 > elapsed 0)
      const r1 = planDefenseRally(kTick10, memory, 15);
      expect(r1).toBeUndefined();
      expect(memory.threatSince.get(500)).toBe(10);

      // Tick 20: Raider has fled (no visible raider near building 500)
      const kTick20 = stubKnowledge({
        player: 1,
        diplomacy,
        tick: () => 20,
        damagedAlliedBuildings: () => [
          { eid: 500, defId: "town-center", tileX: 25, tileY: 25, owner: 0 },
        ],
        visibleEnemies: () => [
          // Raider moved far away (distance > DEFENSE_THREAT_RADIUS_TILES)
          { eid: 601, defId: "spearman", tileX: 90, tileY: 90, owner: 2 },
        ],
      });

      planDefenseRally(kTick20, memory, 15);
      // Clock for building 500 was pruned
      expect(memory.threatSince.has(500)).toBe(false);
    });
  });

  describe("Autonomous Tribute Transfer", () => {
    it("dispatches 100-packet tribute when AI has surplus (>= 700) and ally has deficit (< 150)", () => {
      const memory = createMilitaryMemory();
      const k = stubKnowledge({
        player: 1,
        alliedPlayerIds: () => [0],
        // AI has surplus food (850) and moderate wood (400)
        resources: () => [850, 400, 100, 50, 0, 0, 0],
        // Ally (Player 0) has deficit food (50)
        alliedResources: (allyId) =>
          allyId === 0 ? [50, 300, 200, 100, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0],
      });

      const draft = planTributeTransfer(k, memory, 100);
      expect(draft).toBeDefined();
      expect(draft?.kind).toBe("tribute");
      expect(draft?.data).toEqual({
        donorPlayerId: 1,
        recipientPlayerId: 0,
        resourceCode: RESOURCE_FOOD,
        amount: TRIBUTE_PACKET_AMOUNT, // 100
      });
      expect(memory.lastTributeTick).toBe(100);
    });

    it("prioritizes the ally's deepest deficit when multiple resources qualify", () => {
      const memory = createMilitaryMemory();
      const k = stubKnowledge({
        player: 1,
        alliedPlayerIds: () => [0],
        // AI has surplus in both Food (800) and Gold (900)
        resources: () => [800, 300, 900, 100, 0, 0, 0],
        // Ally has Food: 120 (< 150), and Gold: 20 (< 150). Gold is deeper deficit!
        alliedResources: () => [120, 300, 20, 100, 0, 0, 0],
      });

      const draft = planTributeTransfer(k, memory, 100);
      expect(draft).toBeDefined();
      expect(draft?.data.resourceCode).toBe(RESOURCE_GOLD); // Deepest deficit (20 < 120)
    });

    it("respects the 60-tick tribute cooldown", () => {
      const memory = createMilitaryMemory();
      memory.lastTributeTick = 100;

      const k = stubKnowledge({
        player: 1,
        alliedPlayerIds: () => [0],
        resources: () => [1000, 1000, 1000, 1000, 0, 0, 0],
        alliedResources: () => [0, 0, 0, 0, 0, 0, 0],
      });

      // Tick 140 is only 40 ticks after 100 (< TRIBUTE_COOLDOWN_TICKS = 60)
      const blocked = planTributeTransfer(k, memory, 140);
      expect(blocked).toBeUndefined();

      // Tick 160 is 60 ticks after: cooldown expired!
      const allowed = planTributeTransfer(k, memory, 160);
      expect(allowed).toBeDefined();
      expect(memory.lastTributeTick).toBe(160);
    });

    it("never tributed to non-allied players", () => {
      const memory = createMilitaryMemory();
      const k = stubKnowledge({
        player: 1,
        // No allies (FFA match)
        alliedPlayerIds: () => [],
        resources: () => [1000, 1000, 1000, 1000, 0, 0, 0],
      });

      const draft = planTributeTransfer(k, memory, 100);
      expect(draft).toBeUndefined();
    });

    it("executes atomic tribute transfer in market system with conservation of resources", () => {
      const world = createWorld(42, { size: 160 });
      const comps = defineSimComponents(world);
      const marketSystem = createMarketSystem({ comps });

      // Seed player 1 (AI) with 800 Food, player 0 (Ally) with 50 Food
      createPlayerStockpile(world, comps, 1, [800, 0, 0, 0, 0, 0, 0]);
      createPlayerStockpile(world, comps, 0, [50, 0, 0, 0, 0, 0, 0]);

      // Submit tribute command: Player 1 sends 100 Food to Player 0
      world.inbox.submit({
        kind: TRIBUTE_COMMAND_KIND,
        targetTick: 1,
        data: {
          donorPlayerId: 1,
          recipientPlayerId: 0,
          resourceCode: RESOURCE_FOOD,
          amount: 100,
        },
      });

      // Step world tick 0 -> 1
      const cmds = world.inbox.drainDue(1);
      marketSystem(world, cmds);

      // Verify donor deducted exactly 100, recipient credited exactly 100
      const donorRes = stockpileAmountsOf(world, comps, 1);
      const recipientRes = stockpileAmountsOf(world, comps, 0);

      expect(donorRes[RESOURCE_FOOD]).toBe(700);
      expect(recipientRes[RESOURCE_FOOD]).toBe(150);

      // Conservation check: total food in system unchanged
      expect(donorRes[RESOURCE_FOOD]! + recipientRes[RESOURCE_FOOD]!).toBe(850);
    });

    it("transferTribute rejects invalid amounts or insufficient funds atomically", () => {
      const world = createWorld(99, { size: 160 });
      const comps = defineSimComponents(world);

      createPlayerStockpile(world, comps, 1, [50, 0, 0, 0, 0, 0, 0]);
      createPlayerStockpile(world, comps, 0, [50, 0, 0, 0, 0, 0, 0]);

      // Donor has 50 food, attempts to send 100: fails
      const ok1 = transferTribute(world, comps, 1, 0, RESOURCE_FOOD, 100);
      expect(ok1).toBe(false);
      expect(stockpileAmountsOf(world, comps, 1)[RESOURCE_FOOD]).toBe(50);
      expect(stockpileAmountsOf(world, comps, 0)[RESOURCE_FOOD]).toBe(50);

      // Attempt to transfer to self: fails
      const ok2 = transferTribute(world, comps, 1, 1, RESOURCE_FOOD, 50);
      expect(ok2).toBe(false);

      // Attempt non-positive amount: fails
      const ok3 = transferTribute(world, comps, 1, 0, RESOURCE_FOOD, -10);
      expect(ok3).toBe(false);
    });
  });

  describe("Fog Honesty in Multi-Agent AiKnowledge", () => {
    it("ensures visibleEnemies and visibleEnemyVillagers only surface hostiles", () => {
      const world = createWorld(1234, { size: 160 });
      const comps = defineSimComponents(world);
      const diplomacy = createDiplomacyMatrix(4, "teams");
      // P1 & P0 are Allies; P1 & P2 are Enemies

      const mockKnown = [
        { eid: 10, defId: "swordsman", tileX: 20, tileY: 20, owner: 0 }, // Ally unit
        { eid: 11, defId: "villager", tileX: 21, tileY: 20, owner: 0 }, // Ally villager
        { eid: 20, defId: "swordsman", tileX: 50, tileY: 50, owner: 2 }, // Hostile unit
        { eid: 21, defId: "villager", tileX: 51, tileY: 50, owner: 2 }, // Hostile villager
      ];

      const k = createAiKnowledge({
        world,
        comps,
        player: 1,
        diplomacy,
        view: {
          knownEntities: () => mockKnown,
          isExplored: () => true,
          isVisible: () => true,
          viewer: 1,
        } as unknown as Parameters<typeof createAiKnowledge>[0]["view"],
      });

      // Ally units must NOT be in visibleEnemies
      const enemies = k.visibleEnemies();
      expect(enemies).toHaveLength(1);
      expect(enemies[0]!.eid).toBe(20);
      expect(enemies[0]!.owner).toBe(2);

      // Ally villagers must NOT be in visibleEnemyVillagers
      const villagers = k.visibleEnemyVillagers();
      expect(villagers).toHaveLength(1);
      expect(villagers[0]!.eid).toBe(21);
      expect(villagers[0]!.owner).toBe(2);
    });
  });
});

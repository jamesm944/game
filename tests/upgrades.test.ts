/**
 * Unit line upgrades & Blacksmith research tree tests — Issue #135 / U1.
 *
 * Verifies:
 * 1. Blacksmith tech tree registration and stat derivations (infantry, archer, cavalry).
 * 2. Unit line progression chains (militia, archer, scout, knight lines).
 * 3. Active trainable roster filtering (hiding unresearched tiers, replacing base with active).
 * 4. Automatic field unit transformation (HP bonus, speed update, combat code).
 * 5. In-flight training queue and garrison transformation.
 * 6. End-to-end sim researchTech execution and state consistency.
 */

import { describe, expect, it } from "vitest";
import {
  buildingDefOf,
  techCodeOf,
  techDefOf,
  techsForBuilding,
  unitCodeOf,
  unitDefOf,
} from "../src/data/definitions";
import {
  defineSimComponents,
  readTrainQueue,
  spawnCombatUnit,
  writeTrainQueue,
  type SimComponents,
} from "../src/sim/components";
import {
  createPlayerAgeState,
  getAgeResearchRow,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import {
  researchedTechCodesOf,
  markTechResearched,
} from "../src/sim/components/combat";
import { readGarrison, writeGarrison } from "../src/sim/components/garrison";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { createAgeSystem, RESEARCH_TECH_KIND } from "../src/sim/systems/age";
import { createTrainingSystem } from "../src/sim/systems/training";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  activeTrainableUnitsFor,
  applyUnitUpgrade,
  buildingActiveResearch,
  buildingTechOptions,
  isUnitTierUnlocked,
  resolveUpgradedUnitId,
} from "../src/sim/systems/upgrades";
import { deriveUnitStats } from "../src/sim/combat/stats";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
}

function harness(ageRank = 2): Harness {
  const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
  const world = createWorld(20260824, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
  });
  const comps = defineSimComponents(world);

  // Economy & age setup (food, wood, gold, stone...)
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [5000, 5000, 5000, 5000, 0, 0, 0],
  );
  createPlayerAgeState(world, comps, PLAYER_ONE);
  setPlayerAgeRank(world, comps, PLAYER_ONE, ageRank);

  registerSystem(world, createAgeSystem(comps));
  registerSystem(world, createTrainingSystem(comps));

  return { world, comps };
}

describe("U1: Blacksmith Research Tree & Unit Line Upgrades (Issue #135)", () => {
  describe("1. Blacksmith Tech Tree & Stat Bonuses", () => {
    it("Blacksmith has all 15 techs registered including archer armors", () => {
      const bsTechs = techsForBuilding("blacksmith");
      expect(bsTechs.length).toBe(15);
      const ids = bsTechs.map((t) => t.id);

      // Melee attack
      expect(ids).toContain("forging");
      expect(ids).toContain("iron-casting");
      expect(ids).toContain("blast-furnace");

      // Infantry armor
      expect(ids).toContain("scale-mail");
      expect(ids).toContain("chain-mail");
      expect(ids).toContain("plate-mail");

      // Cavalry armor
      expect(ids).toContain("scale-barding");
      expect(ids).toContain("chain-barding");
      expect(ids).toContain("plate-barding");

      // Archer attack & range
      expect(ids).toContain("fletching");
      expect(ids).toContain("bodkin-arrow");
      expect(ids).toContain("bracer");

      // Archer armor
      expect(ids).toContain("padded-archer-armor");
      expect(ids).toContain("leather-archer-armor");
      expect(ids).toContain("ring-archer-armor");
    });

    it("Blacksmith techs apply stat bonuses through deriveUnitStats", () => {
      const archerDef = unitDefOf("archer");
      const baseStats = deriveUnitStats(archerDef);
      expect(baseStats.attack).toBe(4);
      expect(baseStats.range).toBe(4);
      expect(baseStats.armorByClass.archer).toBe(0);

      // Apply fletching (+1 attack, +1 range) and padded archer armor (+1/+1 armor)
      const fletchingCode = techCodeOf("fletching");
      const paddedCode = techCodeOf("padded-archer-armor");
      const upgradedStats = deriveUnitStats(archerDef, {
        researchedTechCodes: new Set([fletchingCode, paddedCode]),
      });

      expect(upgradedStats.attack).toBe(5);
      expect(upgradedStats.range).toBe(5);
      expect(upgradedStats.armorByClass.archer).toBe(2);

      // Cavalry with scale barding (+1/+1 armor)
      const knightDef = unitDefOf("knight");
      const baseKnight = deriveUnitStats(knightDef);
      const bardingCode = techCodeOf("scale-barding");
      const knightStats = deriveUnitStats(knightDef, {
        researchedTechCodes: new Set([bardingCode]),
      });
      expect(knightStats.armorByClass.cavalry).toBe(
        baseKnight.armorByClass.cavalry + 2,
      );
    });
  });

  describe("2. Unit Line Upgrades & Progression Chains", () => {
    it("chains resolve correctly across tiers", () => {
      const { world, comps } = harness();

      // Initially base units resolve to themselves
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "militia")).toBe(
        "militia",
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "archer")).toBe(
        "archer",
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "knight")).toBe(
        "knight",
      );
      expect(
        resolveUpgradedUnitId(world, comps, PLAYER_ONE, "scout-cavalry"),
      ).toBe("scout-cavalry");

      // Research Man-at-Arms
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("man-at-arms-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "militia")).toBe(
        "man-at-arms",
      );

      // Research Long Swordsman
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("longswordsman-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "militia")).toBe(
        "longswordsman",
      );

      // Research Two-Handed Swordsman
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("two-handed-swordsman-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "militia")).toBe(
        "two-handed-swordsman",
      );

      // Archer -> Crossbowman -> Arbalest
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("crossbowman-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "archer")).toBe(
        "crossbowman",
      );
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("arbalest-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "archer")).toBe(
        "arbalest",
      );

      // Knight -> Cavalier -> Paladin
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("cavalier-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "knight")).toBe(
        "cavalier",
      );
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("paladin-upgrade"),
      );
      expect(resolveUpgradedUnitId(world, comps, PLAYER_ONE, "knight")).toBe(
        "paladin",
      );
    });

    it("isUnitTierUnlocked respects upgrade research status", () => {
      const { world, comps } = harness();

      // Base units always unlocked
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "militia")).toBe(
        true,
      );
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "archer")).toBe(true);

      // Advanced tiers locked until researched
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "man-at-arms")).toBe(
        false,
      );
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "crossbowman")).toBe(
        false,
      );
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "paladin")).toBe(
        false,
      );

      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("man-at-arms-upgrade"),
      );
      expect(isUnitTierUnlocked(world, comps, PLAYER_ONE, "man-at-arms")).toBe(
        true,
      );
    });

    it("activeTrainableUnitsFor filters and resolves active tier", () => {
      const { world, comps } = harness();
      const barracksDef = buildingDefOf("barracks");

      // Initial roster should only show militia (not unresearched man-at-arms, longswordsman, etc.)
      const initialRoster = activeTrainableUnitsFor(
        world,
        comps,
        PLAYER_ONE,
        barracksDef,
      );
      expect(initialRoster).toEqual(["militia"]);

      // After researching man-at-arms-upgrade, roster shows man-at-arms
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("man-at-arms-upgrade"),
      );
      const upgradedRoster = activeTrainableUnitsFor(
        world,
        comps,
        PLAYER_ONE,
        barracksDef,
      );
      expect(upgradedRoster).toEqual(["man-at-arms"]);
    });
  });

  describe("3. Field Unit, Queue & Garrison Auto-Upgrade", () => {
    it("applyUnitUpgrade transforms field units, updating defCode, HP, and speed", () => {
      const { world, comps } = harness();

      // Spawn 2 militia units
      const m1 = spawnCombatUnit(world, comps, "militia", 5, 5, PLAYER_ONE);
      const m2 = spawnCombatUnit(world, comps, "militia", 6, 6, PLAYER_ONE);

      const militiaDef = unitDefOf("militia");
      const manAtArmsDef = unitDefOf("man-at-arms");
      expect(manAtArmsDef.hp - militiaDef.hp).toBe(5);

      const m1Combat = world.rowsByComponentId.get(comps.combatId)!.get(m1)!;
      expect(m1Combat[0]).toBe(unitCodeOf("militia"));
      expect(m1Combat[2]).toBe(militiaDef.hp);

      // Execute upgrade
      const result = applyUnitUpgrade(
        world,
        comps,
        PLAYER_ONE,
        "militia",
        "man-at-arms",
      );
      expect(result.unitsTransformed).toBe(2);

      // Check transformed stats
      expect(m1Combat[0]).toBe(unitCodeOf("man-at-arms"));
      expect(m1Combat[2]).toBe(manAtArmsDef.hp); // +5 HP bonus

      const m2Combat = world.rowsByComponentId.get(comps.combatId)!.get(m2)!;
      expect(m2Combat[0]).toBe(unitCodeOf("man-at-arms"));
      expect(m2Combat[2]).toBe(manAtArmsDef.hp);

      const tag1 = world.rowsByComponentId.get(comps.unitTagId)!.get(m1)!;
      expect(tag1[0]).toBe(manAtArmsDef.speed);
    });

    it("applyUnitUpgrade transforms in-flight training queues", () => {
      const { world, comps } = harness();
      const barracksEid = stampFinishedBuilding(
        world,
        comps,
        "barracks",
        10,
        10,
        { playerId: PLAYER_ONE },
      );

      // Enqueue 2 militia
      writeTrainQueue(world, comps, barracksEid, [
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 600 },
      ]);

      const result = applyUnitUpgrade(
        world,
        comps,
        PLAYER_ONE,
        "militia",
        "man-at-arms",
      );
      expect(result.queuesUpdated).toBe(2);

      const updatedQueue = readTrainQueue(world, comps, barracksEid);
      expect(updatedQueue[0]!.unitCode).toBe(unitCodeOf("man-at-arms"));
      expect(updatedQueue[1]!.unitCode).toBe(unitCodeOf("man-at-arms"));
    });

    it("applyUnitUpgrade transforms garrisoned units", () => {
      const { world, comps } = harness();
      const tcEid = stampFinishedBuilding(world, comps, "town-center", 10, 10, {
        playerId: PLAYER_ONE,
      });

      writeGarrison(world, comps, tcEid, [
        {
          unitCode: unitCodeOf("militia"),
          owner: PLAYER_ONE,
          hp: 40,
          maxHp: 40,
          stanceCode: 0,
        },
      ]);

      const result = applyUnitUpgrade(
        world,
        comps,
        PLAYER_ONE,
        "militia",
        "man-at-arms",
      );
      expect(result.garrisonsUpdated).toBe(1);

      const garrison = readGarrison(world, comps, tcEid);
      expect(garrison[0]!.unitCode).toBe(unitCodeOf("man-at-arms"));
      expect(garrison[0]!.hp).toBe(45);
      expect(garrison[0]!.maxHp).toBe(45);
    });
  });

  describe("4. End-to-End Simulation Tech Research", () => {
    it("completing researchTech transforms units and adds tech to ResearchedTechs", () => {
      const { world, comps } = harness(2); // Feudal Age
      const barracksEid = stampFinishedBuilding(
        world,
        comps,
        "barracks",
        5,
        5,
        { playerId: PLAYER_ONE },
      );

      // Spawn a field militia
      const militiaEid = spawnCombatUnit(
        world,
        comps,
        "militia",
        7,
        7,
        PLAYER_ONE,
      );

      // Submit researchTech command
      const targetTick = world.tick + 1;
      world.inbox.submit({
        kind: RESEARCH_TECH_KIND,
        targetTick,
        data: {
          siteEid: barracksEid,
          playerId: PLAYER_ONE,
          techId: "man-at-arms-upgrade",
        },
      });

      // Step to targetTick — research begins
      step(world);
      expect(getAgeResearchRow(world, comps, barracksEid)).toBeDefined();

      const researchRow = getAgeResearchRow(world, comps, barracksEid)!;
      expect(researchRow[1]).toBe(techCodeOf("man-at-arms-upgrade"));

      // Fast forward remaining ticks
      const remaining = researchRow[2]!;
      for (let i = 0; i < remaining; i++) {
        step(world);
      }

      // Research row cleared
      expect(getAgeResearchRow(world, comps, barracksEid)).toBeUndefined();

      // Tech recorded in ResearchedTechs
      const researched = researchedTechCodesOf(world, comps, PLAYER_ONE);
      expect(researched).toContain(techCodeOf("man-at-arms-upgrade"));

      // Field unit automatically transformed
      const combat = world.rowsByComponentId
        .get(comps.combatId)!
        .get(militiaEid)!;
      expect(combat[0]).toBe(unitCodeOf("man-at-arms"));
      expect(combat[2]).toBe(unitDefOf("man-at-arms").hp);
    });
  });

  describe("5. Building HUD Tech Options & Active Research", () => {
    it("buildingTechOptions returns accurate states for Blacksmith", () => {
      const { world, comps } = harness(2); // Feudal Age
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 5, 5, {
        playerId: PLAYER_ONE,
      });
      const bsDef = buildingDefOf("blacksmith");

      const options = buildingTechOptions(
        world,
        comps,
        PLAYER_ONE,
        bsEid,
        bsDef,
      );
      expect(options.length).toBe(15);

      const forging = options.find((o) => o.techId === "forging")!;
      expect(forging.canResearch).toBe(true);
      expect(forging.isResearched).toBe(false);

      // Iron casting requires Castle age and Forging prereq -> disabled
      const ironCasting = options.find((o) => o.techId === "iron-casting")!;
      expect(ironCasting.canResearch).toBe(false);
      expect(ironCasting.reasonDisabled).toContain("Requires Castle");
    });

    it("buildingActiveResearch tracks progress percentage and time", () => {
      const { world, comps } = harness(2);
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 5, 5, {
        playerId: PLAYER_ONE,
      });

      world.inbox.submit({
        kind: RESEARCH_TECH_KIND,
        targetTick: world.tick + 1,
        data: {
          siteEid: bsEid,
          playerId: PLAYER_ONE,
          techId: "forging",
        },
      });

      step(world);

      const status = buildingActiveResearch(world, comps, bsEid);
      expect(status).toBeDefined();
      expect(status!.techId).toBe("forging");
      expect(status!.techName).toBe("Forging");
      expect(status!.totalTicks).toBe(techDefOf("forging").researchTime);
      expect(status!.progress01).toBeCloseTo(0, 1);
    });
  });
});

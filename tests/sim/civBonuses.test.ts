import { describe, expect, it } from "vitest";
import {
  unitDefOf,
  buildingDefOf,
  techDefOf,
  techCodeOf,
} from "../../src/data/definitions";
import { createWorld } from "../../src/sim/core/world";
import { defineSimComponents, spawnCombatUnit } from "../../src/sim/components";
import {
  setPlayerCivilization,
  getPlayerCivilization,
  getPlayerCivilizationId,
  getCivBonuses,
  canPlayerTrainUnit,
  civOfUniqueUnit,
  isUniqueUnit,
} from "../../src/sim/core/civilization";
import { deriveUnitStats } from "../../src/sim/combat/stats";
import { effectiveCosts } from "../../src/sim/systems/costs";
import {
  buildingMaxHp,
  completeBuilding,
  populationCapOf,
  spawnBuildingSite,
} from "../../src/sim/components/buildings";
import { resolveGatherInterval } from "../../src/sim/systems/skills";
import { createPlayerStockpile } from "../../src/sim/core/stockpile";
import { createPlayerAgeState, setPlayerAgeRank } from "../../src/sim/components/age";
import { canEnqueueTraining } from "../../src/sim/systems/training";
import { canAfford } from "../../src/sim/systems/placement";
import { RESOURCE_FOOD, RESOURCE_WOOD } from "../../src/sim/components/economy";
import {
  DEFAULT_FOUR_PLAYER_CIVS,
  FOUR_PLAYER_MAP_SIZE,
  generateFourPlayerLayers,
  setupFourPlayerSkirmish,
} from "../../src/sim/mapgen/fourPlayer";

describe("Civilization Bonuses & Asymmetry (Milestone C1 / Issue #118)", () => {
  it("assigns and queries player civilizations", () => {
    const world = createWorld(42);
    expect(getPlayerCivilizationId(world, 0)).toBeUndefined();
    expect(getPlayerCivilization(world, 0)).toBeUndefined();
    expect(getCivBonuses(world, 0)).toEqual([]);

    setPlayerCivilization(world, 0, "britons");
    setPlayerCivilization(world, 1, "franks");
    setPlayerCivilization(world, 2, "goths");
    setPlayerCivilization(world, 3, "byzantines");

    expect(getPlayerCivilizationId(world, 0)).toBe("britons");
    expect(getPlayerCivilization(world, 0)?.name).toBe("Britons");
    expect(getPlayerCivilizationId(world, 1)).toBe("franks");
    expect(getPlayerCivilization(world, 1)?.name).toBe("Franks");
    expect(getPlayerCivilizationId(world, 2)).toBe("goths");
    expect(getPlayerCivilization(world, 2)?.name).toBe("Goths");
    expect(getPlayerCivilizationId(world, 3)).toBe("byzantines");
    expect(getPlayerCivilization(world, 3)?.name).toBe("Byzantines");
  });

  describe("Britons Civilization", () => {
    it("applies +1 range to archers and arbalests", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "britons");
      const bonuses = getCivBonuses(world, 0);

      const archerDef = unitDefOf("archer");
      const baseArcherStats = deriveUnitStats(archerDef, {});
      const britonArcherStats = deriveUnitStats(archerDef, { civBonuses: bonuses });
      expect(britonArcherStats.range).toBe(baseArcherStats.range + 1);

      const arbalestDef = unitDefOf("arbalest");
      const baseArbalestStats = deriveUnitStats(arbalestDef, {});
      const britonArbalestStats = deriveUnitStats(arbalestDef, { civBonuses: bonuses });
      expect(britonArbalestStats.range).toBe(baseArbalestStats.range + 1);

      // Other units (e.g. skirmisher, knight) do not receive the range bonus
      const skirmisherDef = unitDefOf("skirmisher");
      const britonSkirmStats = deriveUnitStats(skirmisherDef, { civBonuses: bonuses });
      expect(britonSkirmStats.range).toBe(deriveUnitStats(skirmisherDef, {}).range);
    });

    it("applies 1.2x food gather work rate bonus", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      setPlayerCivilization(world, 0, "britons");

      const villagerEid = spawnCombatUnit(world, comps, "villager", 10, 10, 0);

      // Base gather interval is 20 ticks. With 1.2x work rate: 20 / 1.2 = 16.67 -> 17 ticks
      const foodInterval = resolveGatherInterval(
        world,
        comps,
        villagerEid,
        20,
        RESOURCE_FOOD,
      );
      expect(foodInterval).toBe(17);

      // Wood gathering is not bonused by Britons: 20 ticks
      const woodInterval = resolveGatherInterval(
        world,
        comps,
        villagerEid,
        20,
        RESOURCE_WOOD,
      );
      expect(woodInterval).toBe(20);
    });

    it("discounts Town Center wood cost by 50%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "britons");

      const tcDef = buildingDefOf("town-center");
      const effective = effectiveCosts(world, 0, tcDef);

      // Base TC: { wood: 300 }
      expect(tcDef.costs.wood).toBe(300);
      expect(effective.wood).toBe(150); // Math.round(300 * 0.5) = 150

      // Another player without Britons pays full 300
      expect(effectiveCosts(world, 1, tcDef).wood).toBe(300);
    });

    it("authorizes Longbowman training only for Britons", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "britons");
      setPlayerCivilization(world, 1, "franks");

      expect(civOfUniqueUnit("longbowman")).toBe("britons");
      expect(isUniqueUnit("longbowman")).toBe(true);

      expect(canPlayerTrainUnit(world, 0, "longbowman")).toBe(true);
      expect(canPlayerTrainUnit(world, 1, "longbowman")).toBe(false);

      // Standard units are allowed for all players
      expect(canPlayerTrainUnit(world, 0, "archer")).toBe(true);
      expect(canPlayerTrainUnit(world, 1, "archer")).toBe(true);
    });

    it("applies Yeomen unique tech effect (+1 range to foot archers, +2 attack to watch towers)", () => {
      const yeomenDef = techDefOf("yeomen");
      expect(yeomenDef.ageGate).toBe("castle");
      expect(yeomenDef.costs).toEqual({ wood: 750, gold: 450 });

      const longbowDef = unitDefOf("longbowman");
      const baseStats = deriveUnitStats(longbowDef, {});
      const techCode = techCodeOf("yeomen");

      const researchedStats = deriveUnitStats(longbowDef, {
        researchedTechCodes: new Set([techCode]),
      });
      expect(researchedStats.range).toBe(baseStats.range + 1);
    });
  });

  describe("Franks Civilization", () => {
    it("applies +20% HP to cavalry units", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "franks");
      const bonuses = getCivBonuses(world, 0);

      const knightDef = unitDefOf("knight");
      const baseKnightStats = deriveUnitStats(knightDef, {});
      expect(baseKnightStats.hp).toBe(70);
      const frankKnightStats = deriveUnitStats(knightDef, { civBonuses: bonuses });
      // Base knight HP = 70, +20% = 84 HP
      expect(frankKnightStats.hp).toBe(84);

      const scoutDef = unitDefOf("scout-cavalry");
      const baseScoutStats = deriveUnitStats(scoutDef, {});
      expect(baseScoutStats.hp).toBe(45);
      const frankScoutStats = deriveUnitStats(scoutDef, { civBonuses: bonuses });
      // Base scout HP = 45, +20% = 54 HP
      expect(frankScoutStats.hp).toBe(54);

      // Spawning unit directly gets the bonus HP
      const comps = defineSimComponents(world);
      const knightEid = spawnCombatUnit(world, comps, "knight", 10, 10, 0);
      const combatRow = world.rowsByComponentId.get(comps.combatId)!.get(knightEid)!;
      expect(combatRow[2]).toBe(84); // hp
    });

    it("discounts Castle stone cost by 25%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "franks");

      const castleDef = buildingDefOf("castle");
      const effective = effectiveCosts(world, 0, castleDef);

      // Base Castle: { stone: 650 }
      expect(castleDef.costs.stone).toBe(650);
      expect(effective.stone).toBe(488); // Math.round(650 * 0.75) = 488
    });

    it("authorizes Throwing Axeman training only for Franks", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "franks");
      setPlayerCivilization(world, 1, "goths");

      expect(civOfUniqueUnit("throwing-axeman")).toBe("franks");
      expect(canPlayerTrainUnit(world, 0, "throwing-axeman")).toBe(true);
      expect(canPlayerTrainUnit(world, 1, "throwing-axeman")).toBe(false);
    });

    it("applies Chivalry unique tech effect (+10% speed to cavalry)", () => {
      const chivalryDef = techDefOf("chivalry");
      expect(chivalryDef.ageGate).toBe("castle");
      expect(chivalryDef.costs).toEqual({ wood: 400, gold: 400 });

      const knightDef = unitDefOf("knight");
      const baseStats = deriveUnitStats(knightDef, {});
      const techCode = techCodeOf("chivalry");

      const researchedStats = deriveUnitStats(knightDef, {
        researchedTechCodes: new Set([techCode]),
      });
      expect(researchedStats.speed).toBeCloseTo(baseStats.speed * 1.1, 4);
    });
  });

  describe("Goths Civilization", () => {
    it("applies +2 attack to all infantry units", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "goths");
      const bonuses = getCivBonuses(world, 0);

      const militiaDef = unitDefOf("militia");
      const baseMilitia = deriveUnitStats(militiaDef, {});
      const gothMilitia = deriveUnitStats(militiaDef, { civBonuses: bonuses });
      expect(gothMilitia.attack).toBe(baseMilitia.attack + 2);

      const huskarlDef = unitDefOf("huskarl");
      const baseHuskarl = deriveUnitStats(huskarlDef, {});
      const gothHuskarl = deriveUnitStats(huskarlDef, { civBonuses: bonuses });
      expect(gothHuskarl.attack).toBe(baseHuskarl.attack + 2);
    });

    it("discounts all infantry unit costs by 25%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "goths");

      const militiaDef = unitDefOf("militia");
      // Base Militia: { food: 60, gold: 20 }
      const effectiveMilitia = effectiveCosts(world, 0, militiaDef);
      expect(effectiveMilitia.food).toBe(45); // 60 * 0.75 = 45
      expect(effectiveMilitia.gold).toBe(15); // 20 * 0.75 = 15

      const huskarlDef = unitDefOf("huskarl");
      // Base Huskarl: { food: 52, gold: 26 }
      const effectiveHuskarl = effectiveCosts(world, 0, huskarlDef);
      expect(effectiveHuskarl.food).toBe(39); // 52 * 0.75 = 39
      expect(effectiveHuskarl.gold).toBe(20); // Math.round(26 * 0.75) = 20
    });

    it("grants +10 population capacity bonus", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      setPlayerCivilization(world, 0, "goths");
      setPlayerCivilization(world, 1, "britons");

      // Spawn completed Town Center for Goths (player 0)
      const siteEid0 = spawnBuildingSite(world, comps, "town-center", 10, 10, { playerId: 0 });
      completeBuilding(world, comps, siteEid0);

      // Spawn completed Town Center for Britons (player 1)
      const siteEid1 = spawnBuildingSite(world, comps, "town-center", 30, 30, { playerId: 1 });
      completeBuilding(world, comps, siteEid1);

      // Base TC popCap = 5. Goths get +10 = 15
      expect(populationCapOf(world, comps, 0)).toBe(15);
      // Britons TC gets standard 5
      expect(populationCapOf(world, comps, 1)).toBe(5);
    });

    it("authorizes Huskarl training only for Goths", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "goths");
      setPlayerCivilization(world, 1, "byzantines");

      expect(civOfUniqueUnit("huskarl")).toBe("goths");
      expect(canPlayerTrainUnit(world, 0, "huskarl")).toBe(true);
      expect(canPlayerTrainUnit(world, 1, "huskarl")).toBe(false);
    });

    it("applies Anarchy unique tech effect (+10% speed to huskarls)", () => {
      const anarchyDef = techDefOf("anarchy");
      expect(anarchyDef.ageGate).toBe("castle");
      expect(anarchyDef.costs).toEqual({ food: 450, gold: 250 });

      const huskarlDef = unitDefOf("huskarl");
      const baseStats = deriveUnitStats(huskarlDef, {});
      const techCode = techCodeOf("anarchy");

      const researchedStats = deriveUnitStats(huskarlDef, {
        researchedTechCodes: new Set([techCode]),
      });
      expect(researchedStats.speed).toBeCloseTo(baseStats.speed * 1.1, 4);
    });
  });

  describe("Byzantines Civilization", () => {
    it("increases building HP by 25%", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      setPlayerCivilization(world, 0, "byzantines");
      setPlayerCivilization(world, 1, "britons");

      const tcDef = buildingDefOf("town-center");
      expect(tcDef.hp).toBe(2400);
      // Base TC HP = 2400. Byzantines: 2400 * 1.25 = 3000
      expect(buildingMaxHp(world, 0, "town-center")).toBe(3000);
      expect(buildingMaxHp(world, 1, "town-center")).toBe(2400);

      const siteEid = spawnBuildingSite(world, comps, "town-center", 10, 10, { playerId: 0 });
      const completed = completeBuilding(world, comps, siteEid);
      const bRow = world.rowsByComponentId.get(comps.buildingId)!.get(completed.eid)!;
      expect(bRow[4]).toBe(3000); // completed building HP
    });

    it("discounts skirmisher and fire ship costs by 25%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "byzantines");

      const skirmDef = unitDefOf("skirmisher");
      // Base Skirmisher: { food: 25, wood: 35 }
      const effectiveSkirm = effectiveCosts(world, 0, skirmDef);
      expect(effectiveSkirm.food).toBe(19); // 25 * 0.75 = 18.75 -> 19
      expect(effectiveSkirm.wood).toBe(26); // 35 * 0.75 = 26.25 -> 26

      const fireShipDef = unitDefOf("fire-ship");
      // Base Fire Ship: { wood: 125, gold: 45 }
      const effectiveFireShip = effectiveCosts(world, 0, fireShipDef);
      expect(effectiveFireShip.wood).toBe(94); // 125 * 0.75 = 93.75 -> 94
      expect(effectiveFireShip.gold).toBe(34); // 45 * 0.75 = 33.75 -> 34
    });

    it("discounts Imperial Age advance cost by 33%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "byzantines");

      const impAgeDef = techDefOf("imperial-age");
      // Base Imperial Age: { food: 1000, gold: 800 }
      const effectiveImp = effectiveCosts(world, 0, impAgeDef);
      expect(effectiveImp.food).toBe(670); // 1000 * 0.67 = 670
      expect(effectiveImp.gold).toBe(536); // 800 * 0.67 = 536
    });

    it("reduces fire ship reload time by 20%", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "byzantines");
      const bonuses = getCivBonuses(world, 0);

      const fireShipDef = unitDefOf("fire-ship");
      const baseStats = deriveUnitStats(fireShipDef, {});
      const byzStats = deriveUnitStats(fireShipDef, { civBonuses: bonuses });
      // Base reloadTicks = 90, 90 * 0.8 = 72
      expect(byzStats.reloadTicks).toBe(72);
      expect(baseStats.reloadTicks).toBe(90);
    });

    it("authorizes Cataphract training only for Byzantines", () => {
      const world = createWorld(42);
      setPlayerCivilization(world, 0, "byzantines");
      setPlayerCivilization(world, 1, "britons");

      expect(civOfUniqueUnit("cataphract")).toBe("byzantines");
      expect(canPlayerTrainUnit(world, 0, "cataphract")).toBe(true);
      expect(canPlayerTrainUnit(world, 1, "cataphract")).toBe(false);
    });

    it("applies Greek Fire unique tech effect (+1 range to fire ships)", () => {
      const greekFireDef = techDefOf("greek-fire");
      expect(greekFireDef.ageGate).toBe("castle");
      expect(greekFireDef.costs).toEqual({ food: 250, gold: 300 });

      const fireShipDef = unitDefOf("fire-ship");
      const baseStats = deriveUnitStats(fireShipDef, {});
      const techCode = techCodeOf("greek-fire");

      const researchedStats = deriveUnitStats(fireShipDef, {
        researchedTechCodes: new Set([techCode]),
      });
      expect(researchedStats.range).toBe(baseStats.range + 1);
    });
  });

  describe("Training & Placement Simulation Integration", () => {
    it("canEnqueueTraining enforces civilization unique unit authorization", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      setPlayerCivilization(world, 0, "britons");
      setPlayerCivilization(world, 1, "franks");
      createPlayerStockpile(world, comps, 0, [500, 500, 500, 500, 0, 0, 0]);
      createPlayerStockpile(world, comps, 1, [500, 500, 500, 500, 0, 0, 0]);
      createPlayerAgeState(world, comps, 0);
      createPlayerAgeState(world, comps, 1);
      setPlayerAgeRank(world, comps, 0, 3); // Castle Age
      setPlayerAgeRank(world, comps, 1, 3); // Castle Age

      // Spawn Castle for Britons (Player 0)
      const bCastleSite = spawnBuildingSite(world, comps, "castle", 10, 10, { playerId: 0 });
      completeBuilding(world, comps, bCastleSite);

      // Spawn Castle for Franks (Player 1)
      const fCastleSite = spawnBuildingSite(world, comps, "castle", 30, 30, { playerId: 1 });
      completeBuilding(world, comps, fCastleSite);

      // Britons castle can enqueue Longbowman, cannot enqueue Throwing Axeman
      expect(canEnqueueTraining(world, comps, bCastleSite, 0, "longbowman")).toBe(true);
      expect(canEnqueueTraining(world, comps, bCastleSite, 0, "throwing-axeman")).toBe(false);

      // Franks castle can enqueue Throwing Axeman, cannot enqueue Longbowman
      expect(canEnqueueTraining(world, comps, fCastleSite, 1, "throwing-axeman")).toBe(true);
      expect(canEnqueueTraining(world, comps, fCastleSite, 1, "longbowman")).toBe(false);
    });

    it("canAfford considers civilization discounts", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      setPlayerCivilization(world, 0, "britons"); // TC wood -50% (150 wood)
      setPlayerCivilization(world, 1, "franks");  // TC full cost (300 wood)

      // Give player 0 exactly 200 wood (more than 150, less than 300)
      createPlayerStockpile(world, comps, 0, [0, 200, 0, 0, 0, 0, 0]);
      // Give player 1 exactly 200 wood
      createPlayerStockpile(world, comps, 1, [0, 200, 0, 0, 0, 0, 0]);

      expect(canAfford(world, comps, 0, "town-center")).toBe(true);
      expect(canAfford(world, comps, 1, "town-center")).toBe(false);
    });
  });

  describe("4-Player Skirmish Default Civilization Assignment", () => {
    it("assigns Britons, Franks, Goths, Byzantines to players 0..3 in 4-player skirmish", () => {
      const seed = 12345;
      const layers = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);
      const world = createWorld(seed, {
        size: FOUR_PLAYER_MAP_SIZE,
        layers,
      });
      const comps = defineSimComponents(world);

      const result = setupFourPlayerSkirmish(world, comps, { seed });

      expect(DEFAULT_FOUR_PLAYER_CIVS).toEqual([
        "britons",
        "franks",
        "goths",
        "byzantines",
      ]);

      expect(getPlayerCivilizationId(world, 0)).toBe("britons");
      expect(getPlayerCivilizationId(world, 1)).toBe("franks");
      expect(getPlayerCivilizationId(world, 2)).toBe("goths");
      expect(getPlayerCivilizationId(world, 3)).toBe("byzantines");

      expect(result.players[0]!.civId).toBe("britons");
      expect(result.players[1]!.civId).toBe("franks");
      expect(result.players[2]!.civId).toBe("goths");
      expect(result.players[3]!.civId).toBe("byzantines");
    });
  });

  describe("Backward Compatibility (Civs Omitted / Empty)", () => {
    it("returns base costs, stats, HP, and pop caps when civilizations are unset", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);

      expect(world.civilizations).toBeUndefined();

      const tcDef = buildingDefOf("town-center");
      expect(effectiveCosts(world, 0, tcDef)).toBe(tcDef.costs);
      expect(buildingMaxHp(world, 0, "town-center")).toBe(tcDef.hp);

      const siteEid = spawnBuildingSite(world, comps, "town-center", 10, 10, { playerId: 0 });
      const completed = completeBuilding(world, comps, siteEid);
      const bRow = world.rowsByComponentId.get(comps.buildingId)!.get(completed.eid)!;
      expect(bRow[4]).toBe(tcDef.hp);

      expect(populationCapOf(world, comps, 0)).toBe(5);

      // In sandbox/unconfigured worlds, all units can be trained
      expect(canPlayerTrainUnit(world, 0, "longbowman")).toBe(true);
      expect(canPlayerTrainUnit(world, 0, "cataphract")).toBe(true);
    });
  });
});

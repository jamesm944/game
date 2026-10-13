import { describe, expect, it } from "vitest";
import {
  buildingDefOf,
  techCodeOf,
  unitCodeOf,
  unitDefOf,
  UNIT_DEFINITIONS,
} from "../src/data/definitions";
import { deriveUnitStats, strikeDamage } from "../src/sim/combat/stats";

describe("V8: Military Lines & Branch Techs (Issue #79)", () => {
  it("all 15 unit definitions are registered with valid def codes", () => {
    const expectedUnits = [
      "villager",
      "militia",
      "man-at-arms",
      "longswordsman",
      "two-handed-swordsman",
      "archer",
      "skirmisher",
      "arbalest",
      "scout-cavalry",
      "light-cavalry",
      "knight",
      "cavalier",
      "paladin",
      "monk",
      "trade-cart",
    ];

    for (const id of expectedUnits) {
      expect(
        UNIT_DEFINITIONS.has(id),
        `unit ${id} must exist in definitions`,
      ).toBe(true);
      const code = unitCodeOf(id);
      expect(code, `unit ${id} must have positive def code`).toBeGreaterThan(0);
    }
  });

  it("production buildings contain the full military training lines", () => {
    const barracks = buildingDefOf("barracks");
    const barracksUnits =
      barracks.trainQueue?.trainable.map((t) => t.unitId) ?? [];
    expect(barracksUnits).toEqual([
      "militia",
      "man-at-arms",
      "longswordsman",
      "two-handed-swordsman",
    ]);

    const range = buildingDefOf("archery-range");
    const rangeUnits = range.trainQueue?.trainable.map((t) => t.unitId) ?? [];
    expect(rangeUnits).toEqual([
      "archer",
      "crossbowman",
      "skirmisher",
      "arbalest",
    ]);

    const stable = buildingDefOf("stable");
    const stableUnits = stable.trainQueue?.trainable.map((t) => t.unitId) ?? [];
    expect(stableUnits).toEqual([
      "scout-cavalry",
      "light-cavalry",
      "knight",
      "cavalier",
      "paladin",
    ]);
  });

  it("infantry line advances monotonically in HP and attack across ages", () => {
    const militia = unitDefOf("militia");
    const manAtArms = unitDefOf("man-at-arms");
    const longsword = unitDefOf("longswordsman");
    const twoHander = unitDefOf("two-handed-swordsman");

    expect(militia.ageGate).toBe("dark");
    expect(manAtArms.ageGate).toBe("feudal");
    expect(longsword.ageGate).toBe("castle");
    expect(twoHander.ageGate).toBe("imperial");

    expect(militia.hp).toBeLessThan(manAtArms.hp);
    expect(manAtArms.hp).toBeLessThan(longsword.hp);
    expect(longsword.hp).toBeLessThan(twoHander.hp);

    expect(militia.attack).toBeLessThan(manAtArms.attack);
    expect(manAtArms.attack).toBeLessThan(longsword.attack);
    expect(longsword.attack).toBeLessThan(twoHander.attack);
  });

  it("cavalry lines advance monotonically across tiers", () => {
    const scout = unitDefOf("scout-cavalry");
    const lightCav = unitDefOf("light-cavalry");
    expect(scout.hp).toBeLessThan(lightCav.hp);
    expect(scout.attack).toBeLessThan(lightCav.attack);
    expect(lightCav.ageGate).toBe("castle");

    const knight = unitDefOf("knight");
    const cavalier = unitDefOf("cavalier");
    const paladin = unitDefOf("paladin");
    expect(knight.hp).toBeLessThan(cavalier.hp);
    expect(cavalier.hp).toBeLessThan(paladin.hp);
    expect(knight.attack).toBeLessThan(cavalier.attack);
    expect(cavalier.attack).toBeLessThan(paladin.attack);
    expect(paladin.ageGate).toBe("imperial");
  });

  it("blacksmith melee attack line (forging -> iron-casting -> blast-furnace) stacks attack", () => {
    const militia = unitDefOf("militia");
    const baseStats = deriveUnitStats(militia);
    expect(baseStats.attack).toBe(4);

    const forgingCode = techCodeOf("forging");
    const statsForging = deriveUnitStats(militia, {
      researchedTechCodes: new Set([forgingCode]),
    });
    expect(statsForging.attack).toBe(5);

    const ironCastingCode = techCodeOf("iron-casting");
    const statsIron = deriveUnitStats(militia, {
      researchedTechCodes: new Set([forgingCode, ironCastingCode]),
    });
    expect(statsIron.attack).toBe(6);

    const blastFurnaceCode = techCodeOf("blast-furnace");
    const statsBlast = deriveUnitStats(militia, {
      researchedTechCodes: new Set([
        forgingCode,
        ironCastingCode,
        blastFurnaceCode,
      ]),
    });
    expect(statsBlast.attack).toBe(8); // 4 + 1 + 1 + 2 = 8
  });

  it("blacksmith archer line (fletching -> bodkin -> bracer) stacks attack and range", () => {
    const archer = unitDefOf("archer");
    const baseStats = deriveUnitStats(archer);
    expect(baseStats.attack).toBe(4);
    expect(baseStats.range).toBe(4);

    const fletching = techCodeOf("fletching");
    const bodkin = techCodeOf("bodkin-arrow");
    const bracer = techCodeOf("bracer");

    const stats1 = deriveUnitStats(archer, {
      researchedTechCodes: new Set([fletching]),
    });
    expect(stats1.attack).toBe(5);
    expect(stats1.range).toBe(5);

    const stats2 = deriveUnitStats(archer, {
      researchedTechCodes: new Set([fletching, bodkin]),
    });
    expect(stats2.attack).toBe(6);
    expect(stats2.range).toBe(6);

    const stats3 = deriveUnitStats(archer, {
      researchedTechCodes: new Set([fletching, bodkin, bracer]),
    });
    expect(stats3.attack).toBe(7);
    expect(stats3.range).toBe(7);
  });

  it("blacksmith armor lines increase defensive class armor", () => {
    const militia = unitDefOf("militia");
    const scaleMail = techCodeOf("scale-mail");
    const chainMail = techCodeOf("chain-mail");
    const plateMail = techCodeOf("plate-mail");

    const baseStats = deriveUnitStats(militia);
    expect(baseStats.armorByClass.infantry).toBe(0);

    const statsArmor = deriveUnitStats(militia, {
      researchedTechCodes: new Set([scaleMail, chainMail, plateMail]),
    });
    // scale-mail (+1 melee, +1 pierce), chain-mail (+1, +1), plate-mail (+1, +2) = 7
    expect(statsArmor.armorByClass.infantry).toBe(7);

    const knight = unitDefOf("knight");
    const scaleBarding = techCodeOf("scale-barding");
    const chainBarding = techCodeOf("chain-barding");
    const plateBarding = techCodeOf("plate-barding");

    const statsBarding = deriveUnitStats(knight, {
      researchedTechCodes: new Set([scaleBarding, chainBarding, plateBarding]),
    });
    expect(statsBarding.armorByClass.cavalry).toBe(7);
  });

  it("stable upgrades (husbandry, bloodlines) boost speed and attack", () => {
    const knight = unitDefOf("knight");
    const baseStats = deriveUnitStats(knight);
    expect(baseStats.speed).toBeCloseTo(1.35);

    const husbandry = techCodeOf("husbandry");
    const statsHusbandry = deriveUnitStats(knight, {
      researchedTechCodes: new Set([husbandry]),
    });
    expect(statsHusbandry.speed).toBeCloseTo(1.35 * 1.1);

    const bloodlines = techCodeOf("bloodlines");
    const statsBlood = deriveUnitStats(knight, {
      researchedTechCodes: new Set([bloodlines]),
    });
    expect(statsBlood.attack).toBe(baseStats.attack + 1);
  });

  it("counter dynamics function properly across extended military lines", () => {
    const skirmisher = unitDefOf("skirmisher");
    const archer = unitDefOf("archer");
    const militia = unitDefOf("militia");
    const paladin = unitDefOf("paladin");

    // Skirmisher deals bonus against Archer (mult 3.0 on base 2 = 6 damage)
    const dmgSkirmOnArcher = strikeDamage(
      skirmisher,
      deriveUnitStats(skirmisher),
      archer,
      deriveUnitStats(archer),
    );
    expect(dmgSkirmOnArcher).toBe(6);

    // Paladin deals massive damage against unarmored infantry
    const dmgPaladinOnMilitia = strikeDamage(
      paladin,
      deriveUnitStats(paladin),
      militia,
      deriveUnitStats(militia),
    );
    expect(dmgPaladinOnMilitia).toBe(14);
  });
});

import { describe, expect, it } from "vitest";
import {
  CIV_DEFINITIONS,
  CIV_DEF_CODES,
  civDefOf,
  civCodeOf,
  civIdOfCode,
  unitDefOf,
  techDefOf,
  buildingDefOf,
} from "../../src/data/definitions";
import { loadDefinitions, type DefinitionSource } from "../../src/data/load";

describe("Civilization Definitions & Registry", () => {
  it("loads the 4 core asymmetric civilizations", () => {
    expect(CIV_DEFINITIONS.size).toBe(4);
    expect(CIV_DEFINITIONS.has("britons")).toBe(true);
    expect(CIV_DEFINITIONS.has("franks")).toBe(true);
    expect(CIV_DEFINITIONS.has("goths")).toBe(true);
    expect(CIV_DEFINITIONS.has("byzantines")).toBe(true);
  });

  it("assigns stable numeric def codes to civilizations", () => {
    expect(CIV_DEF_CODES.size).toBe(4);
    const codes = [...CIV_DEF_CODES.entries()].sort((a, b) => a[1] - b[1]);
    expect(codes[0]).toEqual(["britons", 1]);
    expect(codes[1]).toEqual(["byzantines", 2]);
    expect(codes[2]).toEqual(["franks", 3]);
    expect(codes[3]).toEqual(["goths", 4]);

    expect(civCodeOf("britons")).toBe(1);
    expect(civIdOfCode(1)).toBe("britons");
    expect(civCodeOf("goths")).toBe(4);
    expect(civIdOfCode(4)).toBe("goths");
  });

  it("defines Britons with Longbowman, Yeomen, and signature bonuses", () => {
    const britons = civDefOf("britons");
    expect(britons.id).toBe("britons");
    expect(britons.name).toBe("Britons");
    expect(britons.kind).toBe("civ");
    expect(britons.uniqueUnitId).toBe("longbowman");
    expect(britons.uniqueTechId).toBe("yeomen");

    // Check unique unit exists and is Castle-gated
    const uu = unitDefOf(britons.uniqueUnitId);
    expect(uu.id).toBe("longbowman");
    expect(uu.ageGate).toBe("castle");
    expect(uu.range).toBeGreaterThanOrEqual(6);
    expect(uu.armorClasses).toContain("archer");

    // Check unique tech exists
    const ut = techDefOf(britons.uniqueTechId);
    expect(ut.id).toBe("yeomen");
    expect(ut.ageGate).toBe("castle");

    // Verify civ bonuses
    const hasArcherRange = britons.bonuses.some(
      (b) => b.target === "unit:archer" && b.stat === "range" && b.value === 1,
    );
    expect(hasArcherRange).toBe(true);
  });

  it("defines Franks with Throwing Axeman, Chivalry, and cavalry bonuses", () => {
    const franks = civDefOf("franks");
    expect(franks.id).toBe("franks");
    expect(franks.name).toBe("Franks");
    expect(franks.uniqueUnitId).toBe("throwing-axeman");
    expect(franks.uniqueTechId).toBe("chivalry");

    const uu = unitDefOf(franks.uniqueUnitId);
    expect(uu.id).toBe("throwing-axeman");
    expect(uu.ageGate).toBe("castle");
    expect(uu.armorClasses).toContain("infantry");

    const ut = techDefOf(franks.uniqueTechId);
    expect(ut.id).toBe("chivalry");

    const hasCavalryHp = franks.bonuses.some(
      (b) => b.target === "class:cavalry" && b.stat === "hp" && b.value === 1.2,
    );
    expect(hasCavalryHp).toBe(true);
  });

  it("defines Goths with Huskarl, Anarchy, and cheap infantry bonuses", () => {
    const goths = civDefOf("goths");
    expect(goths.id).toBe("goths");
    expect(goths.name).toBe("Goths");
    expect(goths.uniqueUnitId).toBe("huskarl");
    expect(goths.uniqueTechId).toBe("anarchy");

    const uu = unitDefOf(goths.uniqueUnitId);
    expect(uu.id).toBe("huskarl");
    expect(uu.ageGate).toBe("castle");
    expect(uu.armorClasses).toContain("infantry");

    const ut = techDefOf(goths.uniqueTechId);
    expect(ut.id).toBe("anarchy");

    const hasInfantryCost = goths.bonuses.some(
      (b) => b.target === "class:infantry" && b.stat === "cost:all",
    );
    expect(hasInfantryCost).toBe(true);
  });

  it("defines Byzantines with Cataphract, Greek Fire, and defensive bonuses", () => {
    const byz = civDefOf("byzantines");
    expect(byz.id).toBe("byzantines");
    expect(byz.name).toBe("Byzantines");
    expect(byz.uniqueUnitId).toBe("cataphract");
    expect(byz.uniqueTechId).toBe("greek-fire");

    const uu = unitDefOf(byz.uniqueUnitId);
    expect(uu.id).toBe("cataphract");
    expect(uu.ageGate).toBe("castle");
    expect(uu.armorClasses).toContain("cavalry");

    const ut = techDefOf(byz.uniqueTechId);
    expect(ut.id).toBe("greek-fire");

    const hasBuildingHp = byz.bonuses.some(
      (b) => b.target === "class:building" && b.stat === "hp",
    );
    expect(hasBuildingHp).toBe(true);
  });

  it("Castle trains all 4 unique units", () => {
    const castle = buildingDefOf("castle");
    expect(castle.trainQueue).toBeDefined();
    const trainableIds = castle.trainQueue!.trainable.map((t) => t.unitId);
    expect(trainableIds).toContain("longbowman");
    expect(trainableIds).toContain("throwing-axeman");
    expect(trainableIds).toContain("huskarl");
    expect(trainableIds).toContain("cataphract");
  });

  it("cross-validation fails if uniqueUnitId or uniqueTechId references unknown entity", () => {
    const invalidCiv: DefinitionSource = {
      label: "./definitions/civs/atlantis.json",
      json: JSON.stringify({
        id: "atlantis",
        name: "Atlantis",
        description: "Sunken civilization",
        kind: "civ",
        uniqueUnitId: "non-existent-unit",
        uniqueTechId: "yeomen",
        bonuses: [],
      }),
    };

    expect(() => loadDefinitions([invalidCiv])).toThrow(
      /uniqueUnitId references unknown unit/i,
    );
  });
});

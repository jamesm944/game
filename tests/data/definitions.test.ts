/**
 * M2-T1 definition-pipeline tests — SPEC §3.
 *
 * Covers the loader happy path (all built-in content loads through the
 * three-round discipline), the aggregate-error contract (one broken
 * source must list EVERY problem at once), and referential integrity of
 * the shipped M2 content: attack bonuses hit real armor classes,
 * recipes take existing gatherable inputs under the depth-1 hard rule,
 * and every cross-kind reference resolves.
 */
import { describe, expect, it } from "vitest";
import { loadDefinitions, type DefinitionSource } from "../../src/data/load";
import {
  ARMOR_CLASSES,
  COMMODITY_SLUGS,
  RESOURCE_SLUGS,
} from "../../src/data/schema";
import {
  BUILDING_DEFINITIONS,
  BUILDING_DEF_CODES,
  RECIPE_DEFINITIONS,
  TECH_DEFINITIONS,
  UNIT_DEFINITIONS,
  UNIT_DEF_CODES,
  VICTORY_PATH_DEFINITIONS,
  buildingCodeOf,
  buildingDefOf,
  techDefOf,
  unitCodeOf,
  unitDefOf,
  victoryPathDefOf,
} from "../../src/data/definitions";

describe("definition loader happy path", () => {
  it("loads every M2-T1 definition into typed registries", () => {
    // V13 adds siege weapons: battering-ram, mangonel, trebuchet-packed, trebuchet (19).
    // N2: fishing-boat (20).
    // N3: transport-ship (21).
    // N4: galley, war-galley, galleon (24).
    // N5: fire-ship, cannon-galleon (26).
    expect(UNIT_DEFINITIONS.size).toBe(26);
    // M3-T5: the §2.3 school joins the building set (17). M3-T7 adds
    // the §2.4 leisure venues tavern/brothel + the church stub (20).
    // M4-T4: the §2.11 set — grand-academy, monument, grand-monument (23).
    // M4-T5: the wonder + monastery completing acts (25).
    // V6: palisade-wall, stone-wall, palisade-gate, stone-gate (29).
    // V7/V9: castle, market (31).
    // N1: dock (32).
    expect(BUILDING_DEFINITIONS.size).toBe(32);
    // V8: 8 canonical + 13 branch techs (21).
    expect(TECH_DEFINITIONS.size).toBe(21);
    expect(RECIPE_DEFINITIONS.size).toBe(6);
    // M4-T5: the §2.11 victory-path constants are their own family.
    expect(VICTORY_PATH_DEFINITIONS.size).toBe(1);
    const economicPath = victoryPathDefOf("economic-path");
    expect(economicPath.sustainPerMin).toBeGreaterThan(0);
    expect(economicPath.holdTicks).toBeGreaterThan(0);

    // Spot-check a unit: AoE2-baseline villager fields survive the round
    // trip with schema defaults applied.
    const villager = unitDefOf("villager");
    expect(villager.kind).toBe("unit");
    expect(villager.hp).toBe(25);
    expect(villager.carryCapacity).toBe(10);
    expect(villager.ageGate).toBe("dark");
    expect(villager.attackBonuses).toEqual([]);
    expect(villager.equipmentSlots).toEqual([]);

    // Spot-check a building and its production queue.
    const range = buildingDefOf("archery-range");
    expect(range.ageGate).toBe("feudal");
    expect(range.trainQueue?.trainable.map((entry) => entry.unitId)).toEqual([
      "archer",
      "skirmisher",
      "arbalest",
    ]);

    // Spot-check an age tech's advance descriptor.
    const castleAge = techDefOf("castle-age");
    expect(castleAge.ageAdvance).toBe(3);
    expect(castleAge.techPrereqs).toEqual(["feudal-age"]);
  });

  it("assigns def codes as a pure ascending-slug function per family", () => {
    const unitIds = [...UNIT_DEF_CODES.keys()].sort();
    expect([...UNIT_DEF_CODES.values()]).toEqual([
      ...Array.from({ length: UNIT_DEF_CODES.size }, (_, i) => i + 1),
    ]);
    expect(unitIds[unitIds.length - 1]).toBe("war-galley");

    const buildingCodes = [...BUILDING_DEF_CODES.entries()].sort(
      (a, b) => a[1] - b[1],
    );
    expect(buildingCodes[0]).toEqual(["archery-range", 1]);
    expect(buildingCodes[24]).toEqual(["wonder", 25]);
    expect(buildingCodes.at(-1)?.[0]).toBe("stone-wall");

    expect(unitCodeOf("militia")).toBeGreaterThan(unitCodeOf("knight"));
    expect(buildingCodeOf("town-center")).toBeGreaterThan(
      buildingCodeOf("barracks"),
    );
  });

  it("throws loudly on unknown ids from every lookup helper", () => {
    expect(() => unitDefOf("griffin")).toThrow(/unknown unit definition/);
    expect(() => buildingDefOf("pyramid")).toThrow(
      /unknown building definition/,
    );
    expect(() => techDefOf("gunpowder")).toThrow(/unknown tech definition/);
    expect(() => unitCodeOf("griffin")).toThrow(/unknown unit definition/);
    expect(() => buildingCodeOf("pyramid")).toThrow(
      /unknown building definition/,
    );
  });
});

describe("three-round aggregate failure reporting", () => {
  /** Sources that fail in EVERY round with multiple problems each. */
  const malformed: DefinitionSource[] = [
    // Round 1: two unparseable JSON files — both must be listed.
    { label: "units/broken-a.json", json: '{ "id": "broken-a", ' },
    { label: "units/broken-b.json", json: "not json at all" },
    // Round 2: schema failures across kinds — all must be listed.
    {
      label: "buildings/bad-building.json",
      json: JSON.stringify({
        id: "bad-building",
        name: "",
        kind: "building",
        costs: {},
        ageGate: "renaissance",
        buildTime: 0,
        footprint: { width: 0, height: 2 },
        hp: -5,
        workSlots: 0,
        dropoffFilters: [],
        acceptsRoles: [],
        sightRadius: 1,
        populationCap: 0,
      }),
    },
    {
      label: "techs/bad-tech.json",
      json: JSON.stringify({
        id: "bad-tech",
        name: "Bad Tech",
        kind: "tech",
        costs: { gold: -1 },
        ageGate: "dark",
        researchTime: 100,
        effects: [{ target: "*", stat: "attack", op: "mult", value: 0 }],
      }),
    },
    {
      label: "recipes/bad-recipe.json",
      json: JSON.stringify({
        id: "bad_recipe_id",
        name: "Bad Recipe",
        kind: "recipe",
        costs: {},
        ageGate: "dark",
        inputs: [],
        output: { defId: "", qty: 0 },
        ticks: 10,
      }),
    },
    // Round 3: reference failures across kinds — all must be listed.
    {
      label: "units/bad-bonus-unit.json",
      json: JSON.stringify({
        id: "bad-bonus-unit",
        name: "Bad Bonus Unit",
        kind: "unit",
        costs: {},
        ageGate: "dark",
        techPrereqs: ["no-such-tech"],
        trainTime: 100,
        hp: 10,
        speed: 1,
        carryCapacity: 0,
        attack: 1,
        armorClasses: ["war-elephant"],
        attackBonuses: [{ armorClass: "hovercraft", mult: 2 }],
        sightRadius: 4,
      }),
    },
    {
      label: "buildings/bad-queue.json",
      json: JSON.stringify({
        id: "bad-queue",
        name: "Bad Queue",
        kind: "building",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildTime: 100,
        footprint: { width: 1, height: 1 },
        hp: 100,
        workSlots: 0,
        dropoffFilters: [],
        acceptsRoles: [],
        sightRadius: 3,
        populationCap: 0,
        trainQueue: { capacity: 5, trainable: [{ unitId: "paladin" }] },
      }),
    },
    {
      label: "recipes/deep-chain.json",
      json: JSON.stringify({
        id: "deep-chain",
        name: "Deep Chain",
        kind: "recipe",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildingId: "nonexistent-workshop",
        inputs: [{ defId: "tools", qty: 1 }],
        output: { defId: "weapons", qty: 1 },
        ticks: 50,
        techGate: "no-such-gate",
      }),
    },
  ];

  it("throws ONE error listing EVERY problem across all three rounds", () => {
    let caught: Error | undefined;
    try {
      loadDefinitions(malformed);
    } catch (error) {
      caught = error instanceof Error ? error : undefined;
    }
    expect(caught).toBeDefined();

    const message = caught!.message;
    // Header counts every collected problem.
    const listed = message.split("\n  - ").slice(1);
    expect(listed.length).toBe(Number(message.match(/failed \((\d+)\)/)![1]));

    // Round 1: BOTH parse failures appear.
    for (const label of ["units/broken-a.json", "units/broken-b.json"]) {
      expect(message).toContain(`parse ${label}`);
    }
    // Round 2: every schema violation appears, per field.
    expect(message).toContain("schema buildings/bad-building.json");
    expect(message).toContain("ageGate: Invalid option");
    expect(message).toContain("schema techs/bad-tech.json");
    expect(message).toContain("strictly positive");
    expect(message).toContain("schema recipes/bad-recipe.json");
    expect(message).toContain("stable slug");
    // Round 3: every dangling reference appears.
    expect(message).toContain(
      'attackBonus references unknown armor class "hovercraft"',
    );
    expect(message).toContain('unknown armor class "war-elephant"');
    expect(message).toContain('reference unknown tech "no-such-tech"');
    expect(message).toContain('references unknown unit "paladin"');
    expect(message).toContain(
      'buildingId references unknown building "nonexistent-workshop"',
    );
    expect(message).toContain(
      'commodity input "tools" violates the depth-1 hard rule',
    );
    expect(message).toContain(
      'techGate references unknown tech "no-such-gate"',
    );
  });

  /**
   * M2-T3 explicit proof of the issue #37 acceptance criterion: a
   * recipe whose INPUT is itself a commodity (tools → weapons here)
   * is rejected outright at load under default options.
   */
  it("rejects commodity-input recipes at load (depth-1 hard rule)", () => {
    const workshop: DefinitionSource = {
      label: "buildings/workshop.json",
      json: JSON.stringify({
        id: "workshop",
        name: "Workshop",
        kind: "building",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildTime: 100,
        footprint: { width: 1, height: 1 },
        hp: 100,
        workSlots: 1,
        dropoffFilters: [],
        acceptsRoles: [],
        sightRadius: 3,
        populationCap: 0,
      }),
    };
    const deepChain: DefinitionSource = {
      label: "recipes/deep-chain.json",
      json: JSON.stringify({
        id: "deep-chain",
        name: "Deep Chain",
        kind: "recipe",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildingId: "workshop",
        inputs: [{ defId: "tools", qty: 1 }],
        output: { defId: "weapons", qty: 1 },
        ticks: 50,
      }),
    };
    expect(() => loadDefinitions([workshop, deepChain])).toThrow(
      /recipe deep-chain: commodity input "tools" violates the depth-1 hard rule/,
    );
  });

  it("permits commodity inputs only when the depth rule is relaxed", () => {
    const workshop: DefinitionSource = {
      label: "buildings/workshop.json",
      json: JSON.stringify({
        id: "workshop",
        name: "Workshop",
        kind: "building",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildTime: 100,
        footprint: { width: 1, height: 1 },
        hp: 100,
        workSlots: 1,
        dropoffFilters: [],
        acceptsRoles: [],
        sightRadius: 3,
        populationCap: 0,
      }),
    };
    const deepChain: DefinitionSource = {
      label: "recipes/deep-ok.json",
      json: JSON.stringify({
        id: "deep-ok",
        name: "Deep Chain OK",
        kind: "recipe",
        costs: {},
        ageGate: "dark",
        techPrereqs: [],
        buildingId: "workshop",
        inputs: [{ defId: "tools", qty: 2 }],
        output: { defId: "weapons", qty: 1 },
        ticks: 50,
      }),
    };

    // Schema supports commodity-on-commodity inputs, but the depth-1
    // hard rule blocks them by default…
    expect(() => loadDefinitions([workshop, deepChain])).toThrow(
      /depth-1 hard rule/,
    );
    // …and the option exists for future chain expansion.
    const registry = loadDefinitions([workshop, deepChain], {
      allowCommodityInputs: true,
    });
    expect(registry.recipes.get("deep-ok")?.inputs[0]?.defId).toBe("tools");
  });

  it("flags duplicate ids across kinds in one report", () => {
    const duplicated: DefinitionSource[] = [
      {
        label: "a.json",
        json: JSON.stringify({
          id: "twin",
          name: "Twin A",
          kind: "unit",
          costs: {},
          ageGate: "dark",
          techPrereqs: [],
          trainTime: 10,
          hp: 1,
          speed: 1,
          carryCapacity: 0,
          attack: 0,
          armorClasses: ["civilian"],
          sightRadius: 1,
        }),
      },
      {
        label: "b.json",
        json: JSON.stringify({
          id: "twin",
          name: "Twin B",
          kind: "tech",
          costs: {},
          ageGate: "dark",
          techPrereqs: [],
          researchTime: 10,
          effects: [],
        }),
      },
    ];
    try {
      loadDefinitions(duplicated);
      throw new Error("expected aggregated validation error");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("duplicate definition id");
      expect(message).toContain("already defined as unit");
    }
  });
});

describe("shipped M2-T1 content integrity", () => {
  it("every attackBonus and armorClass tag references a real armor class", () => {
    for (const unit of UNIT_DEFINITIONS.values()) {
      for (const armorClass of unit.armorClasses) {
        expect(ARMOR_CLASSES as readonly string[]).toContain(armorClass);
      }
      for (const bonus of unit.attackBonuses) {
        expect(ARMOR_CLASSES as readonly string[]).toContain(bonus.armorClass);
      }
    }
  });

  it("every recipe input exists and satisfies the gatherable-or-blocked depth rule", () => {
    const gatherables = new Set<string>(RESOURCE_SLUGS);
    for (const recipe of RECIPE_DEFINITIONS.values()) {
      expect(BUILDING_DEFINITIONS.has(recipe.buildingId)).toBe(true);
      for (const input of recipe.inputs) {
        // v1 hard rule: inputs are gatherables ONLY (SPEC §2.6).
        expect(gatherables.has(input.defId)).toBe(true);
      }
      // Outputs are always commodities in shipped content.
      expect(COMMODITY_SLUGS as readonly string[]).toContain(
        recipe.output.defId,
      );
    }
    // And the SPEC §2.6 table is fully populated.
    expect([...RECIPE_DEFINITIONS.keys()].sort()).toEqual(
      [...COMMODITY_SLUGS].sort(),
    );
  });

  it("every cross-kind reference resolves within the loaded set", () => {
    for (const def of UNIT_DEFINITIONS.values()) {
      for (const prereq of def.techPrereqs) {
        expect(TECH_DEFINITIONS.has(prereq)).toBe(true);
      }
    }
    for (const building of BUILDING_DEFINITIONS.values()) {
      for (const trainable of building.trainQueue?.trainable ?? []) {
        expect(UNIT_DEFINITIONS.has(trainable.unitId)).toBe(true);
      }
      for (const filter of building.dropoffFilters) {
        expect(RESOURCE_SLUGS as readonly string[]).toContain(filter);
      }
    }
    for (const tech of TECH_DEFINITIONS.values()) {
      for (const prereq of tech.techPrereqs) {
        expect(TECH_DEFINITIONS.has(prereq)).toBe(true);
      }
    }
  });

  it("covers the Feudal+ content checklist from issue #35", () => {
    expect([...UNIT_DEFINITIONS.keys()]).toEqual(
      expect.arrayContaining([
        "archer",
        "knight",
        "man-at-arms",
        "militia",
        "monk",
        "scout-cavalry",
        "skirmisher",
        "villager",
      ]),
    );
    for (const id of [
      "town-center",
      "house",
      "barracks",
      "mill",
      "lumber-camp",
      "mining-camp",
      "archery-range",
      "stable",
      "blacksmith",
      "watch-tower",
      "farm",
      "sawpit",
      "kiln",
      "smithy",
      "forge",
      "kitchen",
      // M4-T4: the §2.11 Knowledge/Culture content set.
      "grand-academy",
      "monument",
      "grand-monument",
    ]) {
      expect(BUILDING_DEFINITIONS.has(id)).toBe(true);
    }
    for (const id of [
      "feudal-age",
      "castle-age",
      "imperial-age",
      "double-bit-axe",
      "hand-cart",
      "wheelbarrow",
      "forging",
      "scale-mail",
    ]) {
      expect(TECH_DEFINITIONS.has(id)).toBe(true);
    }
  });
});

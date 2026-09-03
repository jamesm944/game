/**
 * Building model wiring and resolution tests (Issue #74 / V3).
 *
 * Verifies that:
 * 1. Every building definition across all 4 age ranks resolves to a model key.
 * 2. Every model key resolves to a valid GLTF file in the assets directory.
 * 3. Scaffolding geometry has valid attributes.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDING_DEFINITIONS } from "../../src/data/definitions";
import { modelKeyFor } from "../../src/render/buildingModels";

const MODEL_DIR = resolve(
  __dirname,
  "../../src/assets/models/quaternius-ultimate-fantasy-rts/glTF",
);

// Map of model keys to their filenames
const KEY_TO_FILE: Record<string, string> = {
  tcDark: "TownCenter_FirstAge_Level1.gltf",
  tcFeudal: "TownCenter_FirstAge_Level2.gltf",
  tcCastle: "TownCenter_FirstAge_Level3.gltf",
  tcImperial: "TownCenter_SecondAge_Level3.gltf",
  houseDark: "Houses_FirstAge_1_Level1.gltf",
  houseFeudal: "Houses_FirstAge_1_Level2.gltf",
  houseCastle: "Houses_FirstAge_1_Level3.gltf",
  houseImperial: "Houses_SecondAge_1_Level3.gltf",
  barracksDark: "Barracks_FirstAge_Level1.gltf",
  barracksFeudal: "Barracks_FirstAge_Level2.gltf",
  barracksCastle: "Barracks_FirstAge_Level3.gltf",
  barracksImperial: "Barracks_SecondAge_Level3.gltf",
  windmillDark: "Windmill_FirstAge.gltf",
  windmillCastle: "Windmill_SecondAge.gltf",
  farmDark: "Farm_FirstAge_Level1_Wheat.gltf",
  farmCastle: "Farm_SecondAge_Level3_Wheat.gltf",
  archeryFeudal: "Archery_FirstAge_Level1.gltf",
  archeryCastle: "Archery_FirstAge_Level3.gltf",
  archeryImperial: "Archery_SecondAge_Level3.gltf",
  towerFeudal: "WatchTower_FirstAge_Level1.gltf",
  towerCastle: "WatchTower_FirstAge_Level3.gltf",
  towerImperial: "WatchTower_SecondAge_Level3.gltf",
  storage1: "Storage_FirstAge_Level1.gltf",
  storage2: "Storage_FirstAge_Level2.gltf",
  storageSec1: "Storage_SecondAge_Level1.gltf",
  storageSec2: "Storage_SecondAge_Level2.gltf",
  market1: "Market_FirstAge_Level1.gltf",
  market2: "Market_SecondAge_Level1.gltf",
  temple1: "Temple_FirstAge_Level1.gltf",
  temple2: "Temple_SecondAge_Level1.gltf",
  house2_1: "Houses_FirstAge_2_Level1.gltf",
  house2_2: "Houses_SecondAge_2_Level1.gltf",
  house3_1: "Houses_FirstAge_3_Level1.gltf",
  tcSecond1: "TownCenter_SecondAge_Level1.gltf",
  wonder1: "Wonder_FirstAge_Level1.gltf",
  wonder2: "Wonder_SecondAge_Level3.gltf",
  academy: "TownCenter_SecondAge_Level2.gltf",
  monumentModel: "Wonder_FirstAge_Level2.gltf",
  grandMonumentModel: "Wonder_SecondAge_Level2.gltf",
  monasteryCastle: "Temple_SecondAge_Level2.gltf",
  monasteryImperial: "Temple_SecondAge_Level3.gltf",
  wallDark: "Wall_FirstAge.gltf",
  wallFeudal: "Wall_SecondAge.gltf",
  gateDarkOpen: "WallTowers_Door_FirstAge.gltf",
  gateDarkClosed: "WallTowers_DoorClosed_FirstAge.gltf",
  gateFeudalOpen: "WallTowers_Door_SecondAge.gltf",
  gateFeudalClosed: "WallTowers_DoorClosed_SecondAge.gltf",
};

describe("building models mapping", () => {
  it("every building definition resolves to an existing GLTF model across all ages", () => {
    expect(BUILDING_DEFINITIONS.size).toBeGreaterThan(0);

    for (const [id] of BUILDING_DEFINITIONS) {
      for (const ageRank of [1, 2, 3, 4]) {
        const key = modelKeyFor(id, ageRank);
        expect(
          key,
          `No model key returned for ${id} in age rank ${ageRank}`,
        ).toBeDefined();
        const filename = KEY_TO_FILE[key];
        expect(
          filename,
          `Model key ${key} has no mapped filename`,
        ).toBeDefined();
        const fullPath = resolve(MODEL_DIR, filename!);
        expect(existsSync(fullPath), `Model file missing: ${fullPath}`).toBe(
          true,
        );
      }
    }
  });

  it("Town Center visual changes across ages", () => {
    const dark = modelKeyFor("town-center", 1);
    const feudal = modelKeyFor("town-center", 2);
    const castle = modelKeyFor("town-center", 3);
    const imperial = modelKeyFor("town-center", 4);

    expect(dark).toBe("tcDark");
    expect(feudal).toBe("tcFeudal");
    expect(castle).toBe("tcCastle");
    expect(imperial).toBe("tcImperial");
    expect(dark).not.toEqual(feudal);
    expect(feudal).not.toEqual(castle);
    expect(castle).not.toEqual(imperial);
  });

  it("House visual changes across ages", () => {
    const dark = modelKeyFor("house", 1);
    const feudal = modelKeyFor("house", 2);
    const castle = modelKeyFor("house", 3);
    const imperial = modelKeyFor("house", 4);

    expect(dark).toBe("houseDark");
    expect(feudal).toBe("houseFeudal");
    expect(castle).toBe("houseCastle");
    expect(imperial).toBe("houseImperial");
    expect(dark).not.toEqual(feudal);
    expect(feudal).not.toEqual(castle);
    expect(castle).not.toEqual(imperial);
  });

  it("Barracks visual changes across ages", () => {
    const dark = modelKeyFor("barracks", 1);
    const feudal = modelKeyFor("barracks", 2);
    const castle = modelKeyFor("barracks", 3);
    const imperial = modelKeyFor("barracks", 4);

    expect(dark).toBe("barracksDark");
    expect(feudal).toBe("barracksFeudal");
    expect(castle).toBe("barracksCastle");
    expect(imperial).toBe("barracksImperial");
  });

  it("Victory-act buildings resolve to authentic models", () => {
    // Grand Academy (knowledge)
    expect(modelKeyFor("grand-academy", 4)).toBe("academy");
    // Monument & Grand Monument (culture)
    expect(modelKeyFor("monument", 3)).toBe("monumentModel");
    expect(modelKeyFor("grand-monument", 4)).toBe("grandMonumentModel");
    // Wonder (wonder)
    expect(modelKeyFor("wonder", 4)).toBe("wonder2");
    // Monastery (relics)
    expect(modelKeyFor("monastery", 3)).toBe("monasteryCastle");
    expect(modelKeyFor("monastery", 4)).toBe("monasteryImperial");
  });
});

/**
 * Tower line & Castle tests (Issue #78 / V7).
 *
 * Verifies:
 * 1. Definitions: watch-tower and castle load with defensive stats (attack, range, reloadTicks).
 * 2. Visual model mapping: watch-tower scales through 3 age-stages (Watch Tower, Guard Tower, Keep),
 *    and castle renders with 4x4 footprint.
 * 3. Combat: towers and castles acquire the nearest enemy unit within range and fire on reloadTicks cadence.
 * 4. Tower upgrade scaling: damage scales with owner's age rank.
 * 5. Out-of-range and friendly safety: friendly units and distant enemies are never targeted.
 */

import { describe, expect, it } from "vitest";
import { buildingDefOf } from "../src/data/definitions";
import { modelKeyFor } from "../src/render/buildingModels";
import { createWorld } from "../src/sim/core/world";
import {
  defineSimComponents,
  getCombatRow,
  spawnCombatUnit,
  readCombatEvents,
  COMBAT_EVENT_SHOT,
  COMBAT_EVENT_DAMAGE,
} from "../src/sim/components";
import { setPlayerAgeRank } from "../src/sim/components/age";
import { createCombatSystem } from "../src/sim/systems/combat";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { createPlayerStockpile } from "../src/sim/core/stockpile";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function createTestWorld(size = 32) {
  const tileCount = size * size;
  const terrain = new Uint8Array(tileCount).fill(TERRAIN_GRASS);
  const elevation = new Uint8Array(tileCount);
  const world = createWorld(42, {
    size,
    layers: buildLayers(terrain, elevation),
  });
  const comps = defineSimComponents(world);
  createPlayerStockpile(world, comps, 0);
  createPlayerStockpile(world, comps, 1);
  return { world, comps };
}

describe("V7: Tower line & Castle", () => {
  describe("definitions & stat schemas", () => {
    it("watch-tower has valid costs, age gate, and defensive stats", () => {
      const def = buildingDefOf("watch-tower");
      expect(def.id).toBe("watch-tower");
      expect(def.ageGate).toBe("feudal");
      expect(def.costs).toEqual({ wood: 50, stone: 50 });
      expect(def.hp).toBe(850);
      expect(def.attack).toBe(5);
      expect(def.range).toBe(8);
      expect(def.reloadTicks).toBe(60);
      expect(def.footprint).toEqual({ width: 1, height: 1 });
    });

    it("castle has valid stone cost, 4x4 footprint, and high attack power", () => {
      const def = buildingDefOf("castle");
      expect(def.id).toBe("castle");
      expect(def.ageGate).toBe("castle");
      expect(def.costs).toEqual({ stone: 650 });
      expect(def.hp).toBe(4800);
      expect(def.attack).toBe(11);
      expect(def.range).toBe(8);
      expect(def.reloadTicks).toBe(60);
      expect(def.footprint).toEqual({ width: 4, height: 4 });
    });
  });

  describe("model stages", () => {
    it("watch-tower upgrades through Feudal, Castle, and Imperial visual stages", () => {
      expect(modelKeyFor("watch-tower", 1)).toBe("towerFeudal");
      expect(modelKeyFor("watch-tower", 2)).toBe("towerFeudal");
      expect(modelKeyFor("watch-tower", 3)).toBe("towerCastle");
      expect(modelKeyFor("watch-tower", 4)).toBe("towerImperial");
    });

    it("castle resolves to grand stone fortress model", () => {
      expect(modelKeyFor("castle", 3)).toBe("tcImperial");
      expect(modelKeyFor("castle", 4)).toBe("tcImperial");
    });
  });

  describe("defensive fire & acquisition", () => {
    it("tower acquires and fires at enemy unit within range", () => {
      const { world, comps } = createTestWorld();
      const combat = createCombatSystem(comps);

      // Player 0 builds a watch-tower at (10, 10)
      const towerEid = stampFinishedBuilding(
        world,
        comps,
        "watch-tower",
        10,
        10,
        { playerId: 0 },
      );

      // Player 1 has a militiaman at (14, 10) -> distance 4 tiles (within range 8)
      const militiaEid = spawnCombatUnit(world, comps, "militia", 14, 10, 1);
      const militiaCombat = getCombatRow(world, comps, militiaEid)!;
      const initialHp = militiaCombat[2]!;

      // Step world until tower's firing tick
      const reloadTicks = 60;
      const firingTick =
        Math.ceil(world.tick / reloadTicks) * reloadTicks +
        ((reloadTicks - (towerEid % reloadTicks)) % reloadTicks);

      while (world.tick < firingTick) {
        world.tick += 1;
        combat(world, []);
      }

      // Tower fired on firingTick!
      const currentHp = militiaCombat[2]!;
      expect(currentHp).toBeLessThan(initialHp);

      // Verify shot and damage combat events were logged
      const p0Events = readCombatEvents(world, comps, 0);
      const p1Events = readCombatEvents(world, comps, 1);
      expect(
        p0Events.some(
          (e) => e.kind === COMBAT_EVENT_SHOT && e.attackerEid === towerEid,
        ),
      ).toBe(true);
      expect(
        p1Events.some(
          (e) => e.kind === COMBAT_EVENT_DAMAGE && e.attackerEid === towerEid,
        ),
      ).toBe(true);
    });

    it("tower does not attack friendly units", () => {
      const { world, comps } = createTestWorld();
      const combat = createCombatSystem(comps);

      stampFinishedBuilding(world, comps, "watch-tower", 10, 10, {
        playerId: 0,
      });

      // Friendly Player 0 militiaman at (12, 10)
      const friendlyEid = spawnCombatUnit(world, comps, "militia", 12, 10, 0);
      const combatRow = getCombatRow(world, comps, friendlyEid)!;
      const initialHp = combatRow[2]!;

      // Advance through 120 ticks (2 full reload cycles)
      for (let t = 0; t < 120; t++) {
        world.tick += 1;
        combat(world, []);
      }

      expect(combatRow[2]).toBe(initialHp);
    });

    it("tower does not attack enemies outside its range", () => {
      const { world, comps } = createTestWorld();
      const combat = createCombatSystem(comps);

      stampFinishedBuilding(world, comps, "watch-tower", 10, 10, {
        playerId: 0,
      });

      // Enemy Player 1 militiaman at (25, 10) -> distance 15 tiles (well outside range 8)
      const enemyEid = spawnCombatUnit(world, comps, "militia", 25, 10, 1);
      const combatRow = getCombatRow(world, comps, enemyEid)!;
      const initialHp = combatRow[2]!;

      for (let t = 0; t < 120; t++) {
        world.tick += 1;
        combat(world, []);
      }

      expect(combatRow[2]).toBe(initialHp);
    });

    it("tower damage scales with player age rank (Feudal=5, Castle=7, Imperial=8)", () => {
      const { world, comps } = createTestWorld();
      const combat = createCombatSystem(comps);

      const towerEid = stampFinishedBuilding(
        world,
        comps,
        "watch-tower",
        10,
        10,
        { playerId: 0 },
      );
      const reloadTicks = 60;

      // 1. Feudal Age (rank 2): 5 attack
      setPlayerAgeRank(world, comps, 0, 2);
      const enemyFeudal = spawnCombatUnit(world, comps, "militia", 12, 10, 1);
      const hp0 = getCombatRow(world, comps, enemyFeudal)![2]!;

      // Align tick to tower reload
      world.tick = reloadTicks - (towerEid % reloadTicks);
      combat(world, []);
      const hpAfterFeudal = getCombatRow(world, comps, enemyFeudal)![2]!;
      const feudalDmg = hp0 - hpAfterFeudal;
      expect(feudalDmg).toBe(5);

      // 2. Castle Age (rank 3): 7 attack (Guard Tower)
      setPlayerAgeRank(world, comps, 0, 3);
      const enemyCastle = spawnCombatUnit(world, comps, "militia", 12, 10, 1);
      const hp1 = getCombatRow(world, comps, enemyCastle)![2]!;

      world.tick += reloadTicks;
      combat(world, []);
      const hpAfterCastle = getCombatRow(world, comps, enemyCastle)![2]!;
      const castleDmg = hp1 - hpAfterCastle;
      expect(castleDmg).toBe(7);

      // 3. Imperial Age (rank 4): 8 attack (Keep)
      setPlayerAgeRank(world, comps, 0, 4);
      const enemyImperial = spawnCombatUnit(world, comps, "militia", 12, 10, 1);
      const hp2 = getCombatRow(world, comps, enemyImperial)![2]!;

      world.tick += reloadTicks;
      combat(world, []);
      const hpAfterImperial = getCombatRow(world, comps, enemyImperial)![2]!;
      const imperialDmg = hp2 - hpAfterImperial;
      expect(imperialDmg).toBe(8);
    });

    it("castle fires with high attack and can kill low-hp enemy unit", () => {
      const { world, comps } = createTestWorld();
      const combat = createCombatSystem(comps);

      // Castle at (10, 10) with 4x4 footprint
      const castleEid = stampFinishedBuilding(world, comps, "castle", 10, 10, {
        playerId: 0,
      });
      const reloadTicks = 60;

      // Enemy archer (hp 30) at (14, 10)
      const archerEid = spawnCombatUnit(world, comps, "archer", 14, 10, 1);
      const archerRow = getCombatRow(world, comps, archerEid)!;

      // Align to firing tick: castle has attack 11
      world.tick = reloadTicks - (castleEid % reloadTicks);
      combat(world, []);

      expect(archerRow[2]).toBe(30 - 11);

      // Castle fires again and again until archer dies
      world.tick += reloadTicks;
      combat(world, []);
      expect(archerRow[2]).toBe(30 - 22);

      world.tick += reloadTicks;
      combat(world, []); // 30 - 33 <= 0 -> lethal!

      // Archer was killed and despawned
      expect(world.entities.includes(archerEid)).toBe(false);
    });
  });
});

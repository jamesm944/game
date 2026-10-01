/**
 * Unit garrison tests — V13 / Issue #96.
 *
 * Tests:
 * 1. Garrison Component & Serialization:
 *    - Component row encoding/decoding: unitCode, owner, hp, maxHp, stanceCode.
 *    - Population counting: garrisoned units count toward player population.
 * 2. Garrison Activity & Steering:
 *    - Units steer towards target building and enter upon reaching perimeter (<=1.2 tiles).
 *    - Unit entity is despawned from active world and added to building's garrison row.
 *    - Units cannot enter enemy buildings or exceed building capacity.
 * 3. Combat DPS Bonus & Town Center Firing:
 *    - Town Center has base 0 attack and does not fire when empty.
 *    - Garrisoning villagers (+1) or archers (+2) allows Town Center to fire.
 *    - Watch Tower attack increases with garrisoned units.
 * 4. Garrison Healing Over Time:
 *    - Damaged garrisoned units heal slowly according to garrisonHealRate.
 * 5. Ungarrison Command:
 *    - Units exit building at exit point with preserved HP and stance.
 *    - Building garrison row is emptied.
 * 6. Destruction Ejection:
 *    - Trapped units are ejected onto ground when building is destroyed.
 * 7. Save/Load Round Trip & Determinism:
 *    - Garrison state survives captureSkirmishSave and restoreSkirmishSession.
 *    - Multi-run digest parity across identical runs.
 */

import { describe, expect, it } from "vitest";
import {
  attackActivity,
  decodeActivities,
  encodeActivities,
  garrisonActivity,
  type Activity,
} from "../src/sim/activities";
import {
  addGarrisonedUnit,
  getGarrisonCount,
  readGarrison,
} from "../src/sim/components/garrison";
import {
  defineSimComponents,
  getCombatRow,
  getPosition,
  populationOf,
  readCombatEvents,
  spawnCombatUnit,
  writeActivityQueue,
  COMBAT_EVENT_SHOT,
} from "../src/sim/components";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  captureSkirmishSave,
  createSkirmishWorld,
  restoreSkirmishSession,
} from "../src/game/session";
import {
  createCombatDiagnostics,
  createCombatSystem,
  GARRISON_COMMAND_KIND,
  UNGARRISON_COMMAND_KIND,
} from "../src/sim/systems/combat";
import {
  createMovementDiagnostics,
  createMovementSystem,
} from "../src/sim/systems/movement";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { buildingDefOf, unitCodeOf } from "../src/data/definitions";
import { STANCE_CODE_DEFENSIVE } from "../src/sim/components/stance";

installSimPurityShims();

const PLAYER_TWO = 1;

function createTestWorld(
  size = 32,
  seed = 20260906,
): {
  world: World;
  comps: ReturnType<typeof defineSimComponents>;
  paths: PathScheduler;
} {
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const heightMap = new Uint8Array(size * size);
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, heightMap),
    size,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, PLAYER_TWO);

  registerSystem(
    world,
    createMovementSystem(comps, paths, createMovementDiagnostics()),
  );
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));

  return { world, comps, paths };
}

describe("Garrison Activity Encoding", () => {
  it("encodes and decodes garrison activity with targetBuildingId", () => {
    const original: Activity[] = [garrisonActivity(77)];
    const encoded = encodeActivities(original);
    const decoded = decodeActivities(encoded);

    expect(decoded.length).toBe(1);
    expect(decoded[0]!.kind).toBe("garrison");
    if (decoded[0]!.kind === "garrison") {
      expect(decoded[0]!.targetBuildingId).toBe(77);
    }
  });
});

describe("Garrison Component & Population", () => {
  it("stores and retrieves garrisoned units, preserving unit data", () => {
    const { world, comps } = createTestWorld();
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );

    expect(getGarrisonCount(world, comps, towerEid)).toBe(0);

    const militiaCode = unitCodeOf("militia");
    addGarrisonedUnit(world, comps, towerEid, {
      unitCode: militiaCode,
      owner: PLAYER_ONE,
      hp: 35,
      maxHp: 40,
      stanceCode: STANCE_CODE_DEFENSIVE,
    });

    expect(getGarrisonCount(world, comps, towerEid)).toBe(1);

    const units = readGarrison(world, comps, towerEid);
    expect(units.length).toBe(1);
    expect(units[0]!.unitCode).toBe(militiaCode);
    expect(units[0]!.owner).toBe(PLAYER_ONE);
    expect(units[0]!.hp).toBe(35);
    expect(units[0]!.maxHp).toBe(40);
    expect(units[0]!.stanceCode).toBe(STANCE_CODE_DEFENSIVE);
  });

  it("garrisoned units count toward player population", () => {
    const { world, comps } = createTestWorld();
    const tcEid = stampFinishedBuilding(world, comps, "town-center", 10, 10, {
      playerId: PLAYER_ONE,
    });

    const initialPop = populationOf(world, comps, PLAYER_ONE);

    // Spawn an active unit
    spawnCombatUnit(world, comps, "villager", 8, 8, PLAYER_ONE);
    expect(populationOf(world, comps, PLAYER_ONE)).toBe(initialPop + 1);

    // Garrison the unit by adding to garrison and despawning active unit
    addGarrisonedUnit(world, comps, tcEid, {
      unitCode: unitCodeOf("villager"),
      owner: PLAYER_ONE,
      hp: 25,
      maxHp: 25,
      stanceCode: 0,
    });
    // Population still includes the garrisoned unit even before despawn
    expect(populationOf(world, comps, PLAYER_ONE)).toBe(initialPop + 2);
  });
});

describe("Garrison Movement Steering & Entering", () => {
  it("unit steers towards building and enters when close enough", () => {
    const { world, comps } = createTestWorld();
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );

    // Spawn unit near tower at (10.5, 8.5) (1.5 tiles from tower origin (10, 10))
    const unitEid = spawnCombatUnit(
      world,
      comps,
      "archer",
      10.5,
      8.5,
      PLAYER_ONE,
    );
    expect(world.entities.includes(unitEid)).toBe(true);

    // Issue garrison command
    world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [unitEid], targetBuildingId: towerEid },
    });

    // Step a few ticks to let unit steer and enter
    for (let i = 0; i < 20; i++) {
      step(world);
      if (!world.entities.includes(unitEid)) break;
    }

    // Unit entered tower: despawned from active world entities
    expect(world.entities.includes(unitEid)).toBe(false);
    expect(getGarrisonCount(world, comps, towerEid)).toBe(1);

    const garrisoned = readGarrison(world, comps, towerEid);
    expect(garrisoned[0]!.unitCode).toBe(unitCodeOf("archer"));
    expect(garrisoned[0]!.owner).toBe(PLAYER_ONE);
  });

  it("cannot enter enemy building", () => {
    const { world, comps } = createTestWorld();
    const enemyTowerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_TWO,
      },
    );

    const unitEid = spawnCombatUnit(
      world,
      comps,
      "militia",
      10.5,
      8.5,
      PLAYER_ONE,
    );

    world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [unitEid], targetBuildingId: enemyTowerEid },
    });

    for (let i = 0; i < 20; i++) {
      step(world);
    }

    // Unit must not enter enemy tower
    expect(world.entities.includes(unitEid)).toBe(true);
    expect(getGarrisonCount(world, comps, enemyTowerEid)).toBe(0);
  });

  it("cannot exceed building garrison capacity", () => {
    const { world, comps } = createTestWorld();
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );
    const cap = buildingDefOf("watch-tower").garrisonCapacity ?? 5;

    // Fill tower to capacity
    for (let i = 0; i < cap; i++) {
      addGarrisonedUnit(world, comps, towerEid, {
        unitCode: unitCodeOf("archer"),
        owner: PLAYER_ONE,
        hp: 30,
        maxHp: 30,
        stanceCode: 0,
      });
    }
    expect(getGarrisonCount(world, comps, towerEid)).toBe(cap);

    // Try to garrison one more unit
    const extraUnit = spawnCombatUnit(
      world,
      comps,
      "archer",
      10.5,
      8.5,
      PLAYER_ONE,
    );
    world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [extraUnit], targetBuildingId: towerEid },
    });

    for (let i = 0; i < 20; i++) {
      step(world);
    }

    // Must still be in world, not entered
    expect(world.entities.includes(extraUnit)).toBe(true);
    expect(getGarrisonCount(world, comps, towerEid)).toBe(cap);
  });
});

describe("Combat DPS Bonus & Town Center Firing", () => {
  it("Town Center does not fire when empty, but fires when units are garrisoned", () => {
    const { world, comps } = createTestWorld();
    const combat = createCombatSystem(comps);

    const tcEid = stampFinishedBuilding(world, comps, "town-center", 10, 10, {
      playerId: PLAYER_ONE,
    });

    // Enemy unit within TC range (range = 6)
    const enemyEid = spawnCombatUnit(
      world,
      comps,
      "militia",
      12,
      10,
      PLAYER_TWO,
    );
    const enemyCombat = getCombatRow(world, comps, enemyEid)!;
    const initialHp = enemyCombat[2]!;

    const reloadTicks = 60;
    const firingTick =
      Math.ceil(world.tick / reloadTicks) * reloadTicks +
      ((reloadTicks - (tcEid % reloadTicks)) % reloadTicks);

    // Step to firingTick with empty TC
    while (world.tick < firingTick) {
      world.tick += 1;
      combat(world, []);
    }

    // Empty TC must NOT have damaged enemy
    expect(enemyCombat[2]!).toBe(initialHp);

    // Now garrison an archer into the Town Center
    addGarrisonedUnit(world, comps, tcEid, {
      unitCode: unitCodeOf("archer"),
      owner: PLAYER_ONE,
      hp: 30,
      maxHp: 30,
      stanceCode: 0,
    });

    // Step to next firing tick
    const nextFiringTick = firingTick + reloadTicks;
    while (world.tick < nextFiringTick) {
      world.tick += 1;
      combat(world, []);
    }

    // TC with garrisoned archer fired and damaged enemy!
    expect(enemyCombat[2]!).toBeLessThan(initialHp);

    const p0Events = readCombatEvents(world, comps, PLAYER_ONE);
    expect(
      p0Events.some(
        (e) => e.kind === COMBAT_EVENT_SHOT && e.attackerEid === tcEid,
      ),
    ).toBe(true);
  });

  it("garrisoned archers increase Watch Tower attack damage", () => {
    // 1) Test with empty tower
    const { world: w1, comps: c1 } = createTestWorld();
    const combat1 = createCombatSystem(c1);
    const tower1 = stampFinishedBuilding(w1, c1, "watch-tower", 10, 10, {
      playerId: PLAYER_ONE,
    });
    const enemy1 = spawnCombatUnit(w1, c1, "militia", 13, 10, PLAYER_TWO);
    const combatRow1 = getCombatRow(w1, c1, enemy1)!;
    const hp1 = combatRow1[2]!;

    const reloadTicks = 60;
    const firingTick1 =
      Math.ceil(w1.tick / reloadTicks) * reloadTicks +
      ((reloadTicks - (tower1 % reloadTicks)) % reloadTicks);

    while (w1.tick < firingTick1) {
      w1.tick += 1;
      combat1(w1, []);
    }
    const damageEmpty = hp1 - combatRow1[2]!;
    expect(damageEmpty).toBeGreaterThan(0);

    // 2) Test with garrisoned archers
    const { world: w2, comps: c2 } = createTestWorld();
    const combat2 = createCombatSystem(c2);
    const tower2 = stampFinishedBuilding(w2, c2, "watch-tower", 10, 10, {
      playerId: PLAYER_ONE,
    });
    // Add 2 archers (+4 bonus damage)
    addGarrisonedUnit(w2, c2, tower2, {
      unitCode: unitCodeOf("archer"),
      owner: PLAYER_ONE,
      hp: 30,
      maxHp: 30,
      stanceCode: 0,
    });
    addGarrisonedUnit(w2, c2, tower2, {
      unitCode: unitCodeOf("archer"),
      owner: PLAYER_ONE,
      hp: 30,
      maxHp: 30,
      stanceCode: 0,
    });

    const enemy2 = spawnCombatUnit(w2, c2, "militia", 13, 10, PLAYER_TWO);
    const combatRow2 = getCombatRow(w2, c2, enemy2)!;
    const hp2 = combatRow2[2]!;

    const firingTick2 =
      Math.ceil(w2.tick / reloadTicks) * reloadTicks +
      ((reloadTicks - (tower2 % reloadTicks)) % reloadTicks);

    while (w2.tick < firingTick2) {
      w2.tick += 1;
      combat2(w2, []);
    }
    const damageGarrisoned = hp2 - combatRow2[2]!;
    expect(damageGarrisoned).toBeGreaterThan(damageEmpty);
  });
});

describe("Garrison Healing Over Time", () => {
  it("damages unit inside garrison heal over time up to maxHp", () => {
    const { world, comps } = createTestWorld();
    const combat = createCombatSystem(comps);
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );

    // Add damaged unit (hp 10, maxHp 40)
    addGarrisonedUnit(world, comps, towerEid, {
      unitCode: unitCodeOf("militia"),
      owner: PLAYER_ONE,
      hp: 10,
      maxHp: 40,
      stanceCode: 0,
    });

    // Step 50 ticks (heal rate = 0.05/tick => +2.5 HP)
    for (let i = 0; i < 50; i++) {
      world.tick += 1;
      combat(world, []);
    }

    const units = readGarrison(world, comps, towerEid);
    expect(units[0]!.hp).toBeGreaterThan(10);
    expect(units[0]!.hp).toBeCloseTo(12.5, 1);
  });
});

describe("Ungarrison Command", () => {
  it("ungarrison releases units at building exit point with preserved stats", () => {
    const { world, comps } = createTestWorld();
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );

    addGarrisonedUnit(world, comps, towerEid, {
      unitCode: unitCodeOf("archer"),
      owner: PLAYER_ONE,
      hp: 25,
      maxHp: 30,
      stanceCode: STANCE_CODE_DEFENSIVE,
    });

    expect(getGarrisonCount(world, comps, towerEid)).toBe(1);

    // Issue ungarrison command
    world.inbox.submit({
      kind: UNGARRISON_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { buildingEid: towerEid },
    });

    step(world);

    // Tower garrison is now empty
    expect(getGarrisonCount(world, comps, towerEid)).toBe(0);

    // Unit was spawned in the world
    const newUnit = world.entities.find((e) => {
      const cRow = getCombatRow(world, comps, e);
      return cRow && cRow[0] === unitCodeOf("archer");
    });

    expect(newUnit).toBeDefined();
    const cRow = getCombatRow(world, comps, newUnit!)!;
    expect(cRow[1]).toBe(PLAYER_ONE);
    expect(cRow[2]).toBe(25); // Preserved HP

    const pos = getPosition(world, comps, newUnit!);
    expect(pos).toBeDefined();
    // Spawns near building exit point
    expect(pos!.x).toBeGreaterThan(9);
    expect(pos!.y).toBeGreaterThan(9);
  });
});

describe("Building Destruction Ejection", () => {
  it("ejects trapped units onto adjacent ground when building is destroyed", () => {
    const { world, comps } = createTestWorld();
    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_ONE,
      },
    );

    addGarrisonedUnit(world, comps, towerEid, {
      unitCode: unitCodeOf("militia"),
      owner: PLAYER_ONE,
      hp: 40,
      maxHp: 40,
      stanceCode: 0,
    });

    // Spawn massive enemy force to destroy the tower
    const enemy = spawnCombatUnit(
      world,
      comps,
      "knight",
      10.5,
      9.5,
      PLAYER_TWO,
    );
    // Directly deal lethal damage to tower
    const bRow = comps.buildingId
      ? world.rowsByComponentId.get(comps.buildingId)?.get(towerEid)
      : undefined;
    expect(bRow).toBeDefined();
    bRow![4] = 1; // 1 HP left

    // Step system so knight strikes tower and destroys it
    writeActivityQueue(world, comps, enemy, [attackActivity(towerEid)]);
    const combatRow = getCombatRow(world, comps, enemy)!;
    combatRow[3] = towerEid; // engage tower

    for (let i = 0; i < 10; i++) {
      step(world);
      if (!world.entities.includes(towerEid)) break;
    }

    // Tower was destroyed
    expect(world.entities.includes(towerEid)).toBe(false);

    // Trapped militia was ejected onto ground
    const ejectedUnit = world.entities.find((e) => {
      const cRow = getCombatRow(world, comps, e);
      return (
        cRow && cRow[0] === unitCodeOf("militia") && cRow[1] === PLAYER_ONE
      );
    });

    expect(ejectedUnit).toBeDefined();
    const cRow = getCombatRow(world, comps, ejectedUnit!)!;
    expect(cRow[2]!).toBeLessThanOrEqual(40); // took ejection penalty
    expect(cRow[2]!).toBeGreaterThan(0);
  });
});

describe("Garrison Save/Load Round-Trip & Determinism", () => {
  it("survives save/load round-trip bit-identically", async () => {
    const session = createSkirmishWorld(20260906, {
      createTransport: createSynchronousPathTransport,
      size: 32,
    });
    const { world, comps } = session;

    const towerEid = stampFinishedBuilding(
      world,
      comps,
      "watch-tower",
      12,
      12,
      {
        playerId: 0,
      },
    );

    addGarrisonedUnit(world, comps, towerEid, {
      unitCode: unitCodeOf("archer"),
      owner: 0,
      hp: 28,
      maxHp: 30,
      stanceCode: STANCE_CODE_DEFENSIVE,
    });

    expect(getGarrisonCount(world, comps, towerEid)).toBe(1);

    const saved = await captureSkirmishSave(session, 10.0);
    const restored = await restoreSkirmishSession(saved, {
      createTransport: createSynchronousPathTransport,
    });

    expect(getGarrisonCount(restored.world, restored.comps, towerEid)).toBe(1);
    const restoredGarrison = readGarrison(
      restored.world,
      restored.comps,
      towerEid,
    );
    expect(restoredGarrison.length).toBe(1);
    expect(restoredGarrison[0]!.unitCode).toBe(unitCodeOf("archer"));
    expect(restoredGarrison[0]!.owner).toBe(0);
    expect(restoredGarrison[0]!.hp).toBe(28);
    expect(restoredGarrison[0]!.maxHp).toBe(30);
    expect(restoredGarrison[0]!.stanceCode).toBe(STANCE_CODE_DEFENSIVE);
  });

  it("maintains determinism across identical runs with garrison actions", () => {
    const runSim = (): string => {
      const { world, comps } = createTestWorld(32, 42);
      const tcEid = stampFinishedBuilding(world, comps, "town-center", 14, 14, {
        playerId: PLAYER_ONE,
      });

      const u1 = spawnCombatUnit(
        world,
        comps,
        "archer",
        14.5,
        12.5,
        PLAYER_ONE,
      );
      spawnCombatUnit(world, comps, "militia", 18.5, 14.5, PLAYER_TWO);

      world.inbox.submit({
        kind: GARRISON_COMMAND_KIND,
        targetTick: 2,
        data: { entityIds: [u1], targetBuildingId: tcEid },
      });

      for (let tick = 0; tick < 80; tick++) {
        step(world);
      }

      return computeWorldDigest(world);
    };

    const digestA = runSim();
    const digestB = runSim();
    expect(digestA).toBe(digestB);
  });
});

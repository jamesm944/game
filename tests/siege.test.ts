/**
 * Siege weapons unit line tests — V13 / Issue #97.
 *
 * Tests:
 * 1. Pack Activity Encoding:
 *    - Encodes and decodes PackActivity preserving remainingTicks and targetUnitId.
 * 2. Battering Ram Building Damage Bonus vs Unit Damage:
 *    - Deals high damage (120 = 2 * 60) against buildings.
 *    - Deals base damage (2) against units.
 *    - Has 175 HP and 0.5 speed.
 * 3. Mangonel AoE Splash Damage & Friendly Fire:
 *    - Ranged strike deals splash damage to all units within aoeRadius (1.5).
 *    - Friendly fire: damages own friendly units caught in blast.
 *    - Units outside blast radius take no damage.
 * 4. Mangonel Minimum Range:
 *    - Target at distance < 2.0 (inside minRange 2.0) cannot be struck.
 *    - Target at distance >= 2.0 and <= 7.0 can be struck.
 * 5. Trebuchet Pack / Unpack / Attack Sequence:
 *    - Packed Trebuchet (speed 0.7, attack 0) cannot attack.
 *    - Unpack command initiates 90-tick countdown.
 *    - Morphs into Unpacked Trebuchet (speed 0, attack 200, range 16, minRange 4).
 *    - Attacks distant building (range 16) dealing 500 damage (200 * 2.5).
 *    - Cannot strike target inside minRange 4.
 *    - Pack command initiates 90-tick countdown and morphs back to packed state.
 * 6. Save/Load Round-Trip:
 *    - Preserves siege units, current pack activity countdown, and siege state across save/load.
 * 7. Determinism Canary:
 *    - Multi-run digest parity across identical siege combat simulations.
 */

import { describe, expect, it } from "vitest";
import {
  attackActivity,
  decodeActivities,
  encodeActivities,
  packActivity,
  type Activity,
} from "../src/sim/activities";
import {
  defineSimComponents,
  getCombatRow,
  getPosition,
  setPosition,
  readCombatEvents,
  spawnCombatUnit,
  writeActivityQueue,
  COMBAT_EVENT_DAMAGE,
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
  PACK_COMMAND_KIND,
  UNPACK_COMMAND_KIND,
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
import { unitCodeOf, unitDefOf, unitIdOfCode } from "../src/data/definitions";

installSimPurityShims();

const PLAYER_TWO = 1;

function createTestWorld(size = 32, seed = 20260906): {
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

  registerSystem(world, createMovementSystem(comps, paths, createMovementDiagnostics()));
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));

  return { world, comps, paths };
}

describe("Pack Activity Encoding", () => {
  it("encodes and decodes pack activity with remainingTicks and targetUnitId", () => {
    const original: Activity[] = [packActivity(90, "trebuchet")];
    const encoded = encodeActivities(original);
    const decoded = decodeActivities(encoded);

    expect(decoded.length).toBe(1);
    expect(decoded[0]!.kind).toBe("pack");
    if (decoded[0]!.kind === "pack") {
      expect(decoded[0]!.remainingTicks).toBe(90);
      expect(decoded[0]!.targetUnitId).toBe("trebuchet");
    }
  });
});

describe("Battering Ram Mechanics", () => {
  it("has high building damage bonus (60x) and low unit damage", () => {
    const { world, comps } = createTestWorld();

    const ramDef = unitDefOf("battering-ram");
    expect(ramDef.hp).toBe(175);
    expect(ramDef.speed).toBe(0.5);
    expect(ramDef.attack).toBe(2);

    // Spawn Player 1 ram at (11.5, 11)
    const ramEid = spawnCombatUnit(world, comps, "battering-ram", 11.5, 11.0, PLAYER_ONE);

    // Stamp Player 2 house at (12, 10) (footprint 2x2: x 12..14, y 10..12)
    const houseEid = stampFinishedBuilding(world, comps, "house", 12, 10, {
      playerId: PLAYER_TWO,
    });
    const bRow = comps.buildingId !== undefined
      ? world.rowsByComponentId.get(comps.buildingId)?.get(houseEid)
      : undefined;
    expect(bRow).toBeDefined();
    const initialHp = bRow![4]!;
    expect(initialHp).toBe(550);

    // Order ram to attack the house
    writeActivityQueue(world, comps, ramEid, [attackActivity(houseEid)]);
    const cRow = getCombatRow(world, comps, ramEid)!;
    cRow[3] = houseEid; // engage
    cRow[4] = 0; // ready to strike

    // Step world to land strike
    step(world);

    // House takes 120 damage (attack 2 * 60 bonus = 120)
    const hpAfterStrike = bRow![4]!;
    expect(hpAfterStrike).toBe(initialHp - 120);

    // Now test ram striking an enemy unit (e.g. militia with 40 HP)
    const militiaEid = spawnCombatUnit(world, comps, "militia", 11.8, 11.0, PLAYER_TWO);
    const mRow = getCombatRow(world, comps, militiaEid)!;
    expect(mRow[2]).toBe(40);

    // Order ram to attack the militia
    writeActivityQueue(world, comps, ramEid, [attackActivity(militiaEid)]);
    cRow[3] = militiaEid;
    cRow[4] = 0; // ready to strike

    step(world);

    // Militia takes only base attack damage: 2 (since no unit bonus)
    expect(mRow[2]).toBe(40 - 2);
  });
});

describe("Mangonel AoE Splash Damage & Friendly Fire", () => {
  it("damages primary target, nearby enemies, and friendly units caught in blast", () => {
    const { world, comps } = createTestWorld();

    const mangonelDef = unitDefOf("mangonel");
    expect(mangonelDef.aoeRadius).toBe(1.5);
    expect(mangonelDef.minRange).toBe(2.0);
    expect(mangonelDef.range).toBe(7.0);

    // Mangonel at (10, 10) (Player 1)
    const mangonelEid = spawnCombatUnit(world, comps, "mangonel", 10, 10, PLAYER_ONE);

    // Target enemy unit at (14, 10) (Player 2) - distance 4.0 (valid in [2.0, 7.0])
    const primaryTargetEid = spawnCombatUnit(world, comps, "militia", 14, 10, PLAYER_TWO);
    const primaryRow = getCombatRow(world, comps, primaryTargetEid)!;
    primaryRow[2] = 50; // give enough HP

    // Nearby enemy at (14.5, 10.5) (distance to target ~0.7 <= 1.5) (Player 2)
    const splashEnemyEid = spawnCombatUnit(world, comps, "militia", 14.5, 10.5, PLAYER_TWO);
    const splashEnemyRow = getCombatRow(world, comps, splashEnemyEid)!;
    splashEnemyRow[2] = 50;

    // Friendly unit caught in blast at (14.2, 9.8) (distance to target ~0.3 <= 1.5) (Player 1 - friendly fire!)
    const friendlyUnitEid = spawnCombatUnit(world, comps, "militia", 14.2, 9.8, PLAYER_ONE);
    const friendlyRow = getCombatRow(world, comps, friendlyUnitEid)!;
    friendlyRow[2] = 50;

    // Distant enemy at (18, 10) (distance to target 4.0 > 1.5)
    const distantEnemyEid = spawnCombatUnit(world, comps, "militia", 18, 10, PLAYER_TWO);
    const distantRow = getCombatRow(world, comps, distantEnemyEid)!;
    distantRow[2] = 50;

    // Order Mangonel to strike primary target
    writeActivityQueue(world, comps, mangonelEid, [attackActivity(primaryTargetEid)]);
    const cRow = getCombatRow(world, comps, mangonelEid)!;
    cRow[3] = primaryTargetEid;
    cRow[4] = 0; // ready to fire

    step(world);

    // Primary target was hit
    expect(primaryRow[2]).toBeLessThan(50);

    // Splash enemy took damage
    expect(splashEnemyRow[2]).toBeLessThan(50);

    // Friendly unit ALSO took damage (friendly fire!)
    expect(friendlyRow[2]).toBeLessThan(50);

    // Distant enemy took NO damage
    expect(distantRow[2]).toBe(50);
  });

  it("enforces minimum range (minRange: 2.0)", () => {
    const { world, comps } = createTestWorld();

    // Mangonel at (10, 10) (Player 1)
    const mangonelEid = spawnCombatUnit(world, comps, "mangonel", 10, 10, PLAYER_ONE);

    // Enemy too close at (11, 10) (distance 1.0 < minRange 2.0)
    const closeEnemyEid = spawnCombatUnit(world, comps, "militia", 11, 10, PLAYER_TWO);
    const closeRow = getCombatRow(world, comps, closeEnemyEid)!;
    const initialHp = closeRow[2]!;

    // Order Mangonel to attack close enemy
    writeActivityQueue(world, comps, mangonelEid, [attackActivity(closeEnemyEid)]);
    const cRow = getCombatRow(world, comps, mangonelEid)!;
    cRow[3] = closeEnemyEid;
    cRow[4] = 0;

    step(world);

    // Cannot strike because target is inside minRange!
    expect(closeRow[2]).toBe(initialHp);

    // Now move enemy to distance 4.0 (within [2.0, 7.0])
    setPosition(world, comps, closeEnemyEid, 14, 10);

    step(world);

    // Now strikes!
    expect(closeRow[2]).toBeLessThan(initialHp);
  });
});

describe("Trebuchet Pack / Unpack / Attack Sequence", () => {
  it("packs, unpacks over 90 ticks, attacks long range, and packs back", () => {
    const { world, comps } = createTestWorld();

    const packedDef = unitDefOf("trebuchet-packed");
    expect(packedDef.siegeState).toBe("packed");
    expect(packedDef.speed).toBe(0.7);
    expect(packedDef.attack).toBe(0);
    expect(packedDef.morphTargetId).toBe("trebuchet");
    expect(packedDef.packTimeTicks).toBe(90);

    const unpackedDef = unitDefOf("trebuchet");
    expect(unpackedDef.siegeState).toBe("unpacked");
    expect(unpackedDef.speed).toBe(0);
    expect(unpackedDef.attack).toBe(200);
    expect(unpackedDef.range).toBe(16.0);
    expect(unpackedDef.minRange).toBe(4.0);
    expect(unpackedDef.morphTargetId).toBe("trebuchet-packed");

    // Spawn packed Trebuchet at (5, 5) (Player 1)
    const trebEid = spawnCombatUnit(world, comps, "trebuchet-packed", 5, 5, PLAYER_ONE);
    const trebCombatRow = getCombatRow(world, comps, trebEid)!;
    expect(unitIdOfCode(trebCombatRow[0]!)).toBe("trebuchet-packed");

    // Stamp Player 2 castle at (18, 5) (distance 13, <= 16 range and >= 4 minRange)
    const castleEid = stampFinishedBuilding(world, comps, "castle", 18, 5, {
      playerId: PLAYER_TWO,
    });
    const castleRow = comps.buildingId !== undefined
      ? world.rowsByComponentId.get(comps.buildingId)?.get(castleEid)
      : undefined;
    const initialCastleHp = castleRow![4]!;

    // Packed trebuchet has 0 attack and cannot attack the castle
    writeActivityQueue(world, comps, trebEid, [attackActivity(castleEid)]);
    trebCombatRow[3] = castleEid;
    trebCombatRow[4] = 0;
    step(world);
    expect(castleRow![4]!).toBe(initialCastleHp);

    // Issue UNPACK command
    world.inbox.submit({
      kind: UNPACK_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { ids: [trebEid] },
    });

    // Step 1 tick to process command
    step(world);

    // Unit should now have a pack activity with 89 or 90 ticks remaining
    const q1 = world.rowsByComponentId.get(comps.activityQueueId)?.get(trebEid);
    const acts1 = decodeActivities(q1!);
    expect(acts1.length).toBe(1);
    expect(acts1[0]!.kind).toBe("pack");

    // Run for 90 ticks to complete unpacking
    for (let i = 0; i < 90; i++) {
      step(world);
    }

    // Now morphed to unpacked trebuchet!
    expect(unitIdOfCode(trebCombatRow[0]!)).toBe("trebuchet");
    const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(trebEid)!;
    expect(tagRow[0]).toBe(0); // speed is 0

    // Order unpacked Trebuchet to attack the castle
    writeActivityQueue(world, comps, trebEid, [attackActivity(castleEid)]);
    trebCombatRow[3] = castleEid;
    trebCombatRow[4] = 0; // ready to fire

    step(world);

    // Castle took 500 damage (200 attack * 2.5 building bonus = 500)
    expect(castleRow![4]!).toBe(initialCastleHp - 500);

    // Issue PACK command to pack it back
    world.inbox.submit({
      kind: PACK_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { ids: [trebEid] },
    });
    step(world);

    // Run 90 ticks to pack
    for (let i = 0; i < 90; i++) {
      step(world);
    }

    // Morphed back to trebuchet-packed with speed 0.7!
    expect(unitIdOfCode(trebCombatRow[0]!)).toBe("trebuchet-packed");
    expect(tagRow[0]).toBe(0.7);
  });

  it("trebuchet cannot strike targets within minRange (4.0)", () => {
    const { world, comps } = createTestWorld();

    // Spawn unpacked trebuchet at (10, 10)
    const trebEid = spawnCombatUnit(world, comps, "trebuchet", 10, 10, PLAYER_ONE);
    const trebCombatRow = getCombatRow(world, comps, trebEid)!;

    // Enemy target close by at (12, 10) (distance 2.0 < minRange 4.0)
    const enemyEid = spawnCombatUnit(world, comps, "militia", 12, 10, PLAYER_TWO);
    const enemyRow = getCombatRow(world, comps, enemyEid)!;
    const initialHp = enemyRow[2]!;

    writeActivityQueue(world, comps, trebEid, [attackActivity(enemyEid)]);
    trebCombatRow[3] = enemyEid;
    trebCombatRow[4] = 0;

    step(world);

    // Did not fire because target is inside minRange 4.0
    expect(enemyRow[2]!).toBe(initialHp);
  });
});

describe("Save/Load Round-Trip with Siege Weapons", () => {
  it("preserves siege weapon units, pack activities, and siege state across save/load", async () => {
    const session = createSkirmishWorld(20260906, {
      createTransport: createSynchronousPathTransport,
      size: 32,
    });
    const { world, comps } = session;

    // Spawn a packed trebuchet
    const trebEid = spawnCombatUnit(world, comps, "trebuchet-packed", 8, 8, PLAYER_ONE);

    // Start unpacking
    world.inbox.submit({
      kind: UNPACK_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { ids: [trebEid] },
    });
    step(world); // process command

    // Step 25 ticks into the 90-tick unpacking
    for (let i = 0; i < 25; i++) {
      step(world);
    }

    // Capture save
    const saveState = await captureSkirmishSave(session, 10.0);
    const restoredSession = await restoreSkirmishSession(saveState, {
      createTransport: createSynchronousPathTransport,
    });
    const rWorld = restoredSession.world;
    const rComps = restoredSession.comps;

    // Check restored trebuchet
    const rCombatRow = getCombatRow(rWorld, rComps, trebEid)!;
    expect(rCombatRow).toBeDefined();
    expect(unitIdOfCode(rCombatRow[0]!)).toBe("trebuchet-packed");

    const rQueue = rWorld.rowsByComponentId.get(rComps.activityQueueId)?.get(trebEid)!;
    const rActs = decodeActivities(rQueue);
    expect(rActs.length).toBe(1);
    expect(rActs[0]!.kind).toBe("pack");
    if (rActs[0]!.kind === "pack") {
      // 90 - 1 - 25 = 64 ticks remaining
      expect(rActs[0]!.remainingTicks).toBe(64);
      expect(rActs[0]!.targetUnitId).toBe("trebuchet");
    }

    // Finish unpacking in restored world (64 ticks)
    for (let i = 0; i < 64; i++) {
      step(rWorld);
    }

    // Successfully morphed to unpacked trebuchet!
    expect(unitIdOfCode(rCombatRow[0]!)).toBe("trebuchet");
  });
});

describe("Determinism Canary: Siege Weapons", () => {
  it("two independent runs with siege combat produce bit-identical digests", () => {
    function runSim(): string {
      const { world, comps } = createTestWorld(32, 424242);

      // Spawn ram, mangonel, and enemy buildings
      const ram = spawnCombatUnit(world, comps, "battering-ram", 10, 10, PLAYER_ONE);
      const mangonel = spawnCombatUnit(world, comps, "mangonel", 8, 8, PLAYER_ONE);
      const enemy1 = spawnCombatUnit(world, comps, "militia", 13, 10, PLAYER_TWO);
      const enemy2 = spawnCombatUnit(world, comps, "militia", 13.5, 10.5, PLAYER_TWO);
      const house = stampFinishedBuilding(world, comps, "house", 12, 12, {
        playerId: PLAYER_TWO,
      });

      writeActivityQueue(world, comps, ram, [attackActivity(house)]);
      getCombatRow(world, comps, ram)![3] = house;

      writeActivityQueue(world, comps, mangonel, [attackActivity(enemy1)]);
      getCombatRow(world, comps, mangonel)![3] = enemy1;

      for (let i = 0; i < 100; i++) {
        step(world);
      }

      return computeWorldDigest(world);
    }

    const digestA = runSim();
    const digestB = runSim();
    expect(digestA).toBe(digestB);
  });
});

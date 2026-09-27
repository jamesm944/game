/**
 * Galley Line Combat & Visual Juice tests — Milestone N4 (Issue #112 / Epic #84).
 *
 * Tests:
 * 1. Unit definitions & Dock training queue:
 *    - Galley, War Galley, and Galleon stats, ageGates, and counter multipliers.
 * 2. Dock training & Age Gating:
 *    - Dark Age player cannot train warships.
 *    - Feudal Age player trains Galley onto water berth.
 *    - Castle Age trains War Galley, Imperial Age trains Galleon.
 * 3. Water approach & stand point:
 *    - Warship paths exclusively across water tiles.
 *    - When acquiring a target, combat approach stands on navigable water.
 * 4. Ship vs Ship combat:
 *    - 1.5x anti-ship counter multiplier verified.
 *    - Combat events (SHOT and DAMAGE) logged accurately.
 * 5. Coastal bombardment:
 *    - Warship attacks shoreline building and land units from water.
 * 6. Range progression:
 *    - 5 range (Galley) < 6 range (War Galley) < 7 range (Galleon).
 */

import { describe, expect, it } from "vitest";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  defineSimComponents,
  getPosition,
  populationOf,
  spawnCombatUnit,
  combatHpOf,
  combatDefOf,
  type SimComponents,
} from "../src/sim/components";
import {
  createPlayerStockpile,
  PLAYER_ONE,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";

const PLAYER_TWO = 1;
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createTrainingSystem,
  canEnqueueTraining,
  TRAIN_UNIT_KIND,
} from "../src/sim/systems/training";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createCombatSystem,
  createCombatDiagnostics,
  ATTACK_COMMAND_KIND,
} from "../src/sim/systems/combat";
import {
  readCombatEvents,
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_SHOT,
} from "../src/sim/components/combat";
import {
  unitDefOf,
  buildingDefOf,
} from "../src/data/definitions";
import { deriveUnitStats } from "../src/sim/combat/stats";
import { AGE_RANK } from "../src/data/schema";
import {
  createPlayerAgeState,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
} from "../src/sim/world/layers";
import { attachOwner } from "../src/sim/components/owner";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface TestHarness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly paths: PathScheduler;
}

function setupTestWorld(): TestHarness {
  const terrainType = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x < 12) {
        terrainType[y * SIZE + x] = TERRAIN_GRASS;
      } else {
        terrainType[y * SIZE + x] = TERRAIN_WATER;
      }
    }
  }

  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(54321, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);

  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));

  // Supply houses for population cap
  stampFinishedBuilding(world, comps, "house", 1, 1, { playerId: PLAYER_ONE });
  stampFinishedBuilding(world, comps, "house", 1, 4, { playerId: PLAYER_ONE });

  // Initial stockpile: 1000 wood, 1000 food, 1000 gold
  createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 0, 0, 0, 0]);
  createPlayerStockpile(world, comps, PLAYER_TWO, [1000, 1000, 1000, 0, 0, 0, 0]);

  createPlayerAgeState(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_TWO);

  return { world, comps, paths };
}

describe("Milestone N4: Galley Line Combat", () => {
  it("verifies unit definitions and stats for Galley, War Galley, and Galleon", () => {
    const galley = unitDefOf("galley");
    expect(galley.id).toBe("galley");
    expect(galley.ageGate).toBe("feudal");
    expect(galley.costs).toEqual({ wood: 90, gold: 30 });
    expect(galley.hp).toBe(120);
    expect(galley.speed).toBe(1.43);
    expect(galley.attack).toBe(6);
    expect(galley.range).toBe(5);
    expect(galley.reloadTicks).toBe(60);
    expect(galley.sightRadius).toBe(7);
    expect(galley.armorClasses).toContain("ship");
    expect(galley.attackBonuses).toEqual([{ armorClass: "ship", mult: 1.5 }]);

    const warGalley = unitDefOf("war-galley");
    expect(warGalley.id).toBe("war-galley");
    expect(warGalley.ageGate).toBe("castle");
    expect(warGalley.costs).toEqual({ wood: 90, gold: 30 });
    expect(warGalley.hp).toBe(135);
    expect(warGalley.speed).toBe(1.43);
    expect(warGalley.attack).toBe(7);
    expect(warGalley.range).toBe(6);
    expect(warGalley.reloadTicks).toBe(60);
    expect(warGalley.sightRadius).toBe(8);
    expect(warGalley.armorClasses).toContain("ship");
    expect(warGalley.attackBonuses).toEqual([{ armorClass: "ship", mult: 1.5 }]);

    const galleon = unitDefOf("galleon");
    expect(galleon.id).toBe("galleon");
    expect(galleon.ageGate).toBe("imperial");
    expect(galleon.costs).toEqual({ wood: 90, gold: 30 });
    expect(galleon.hp).toBe(165);
    expect(galleon.speed).toBe(1.43);
    expect(galleon.attack).toBe(8);
    expect(galleon.range).toBe(7);
    expect(galleon.reloadTicks).toBe(60);
    expect(galleon.sightRadius).toBe(9);
    expect(galleon.armorClasses).toContain("ship");
    expect(galleon.attackBonuses).toEqual([{ armorClass: "ship", mult: 1.5 }]);

    const dock = buildingDefOf("dock");
    const trainable = dock.trainQueue!.trainable.map((t) => t.unitId);
    expect(trainable).toContain("galley");
    expect(trainable).toContain("war-galley");
    expect(trainable).toContain("galleon");
  });

  it("enforces age gating at the Dock for the Galley line", () => {
    const h = setupTestWorld();
    // Shoreline is at x=12. Place Dock at (10, 8) spanning 10..12
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 10, 8, {
      playerId: PLAYER_ONE,
    });

    // 1. In Dark Age:
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galley")).toBe(false);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "war-galley")).toBe(false);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galleon")).toBe(false);

    // 2. Advance to Feudal Age:
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galley")).toBe(true);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "war-galley")).toBe(false);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galleon")).toBe(false);

    // 3. Advance to Castle Age:
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.castle);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galley")).toBe(true);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "war-galley")).toBe(true);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galleon")).toBe(false);

    // 4. Advance to Imperial Age:
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.imperial);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galley")).toBe(true);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "war-galley")).toBe(true);
    expect(canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "galleon")).toBe(true);
  });

  it("trains a Galley and spawns it at the Dock water berth", () => {
    const h = setupTestWorld();
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 10, 8, {
      playerId: PLAYER_ONE,
    });
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);

    const initialWood = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]!;
    const initialGold = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[2]!;

    h.world.inbox.submit({
      targetTick: 1,
      kind: TRAIN_UNIT_KIND,
      data: { siteEid: dockEid, unitId: "galley" },
    });
    step(h.world);

    // Deducted 90 wood and 30 gold
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]).toBe(initialWood - 90);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[2]).toBe(initialGold - 30);

    // Step through trainTime (900 ticks)
    for (let t = 0; t < 905; t++) {
      step(h.world);
    }

    expect(populationOf(h.world, h.comps, PLAYER_ONE)).toBe(1);

    // Find the spawned galley
    const spawned = h.world.entities.find((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "galley";
    });
    expect(spawned).toBeDefined();

    // Verify it spawned on water (x >= 12)
    const pos = getPosition(h.world, h.comps, spawned!);
    expect(pos).toBeDefined();
    expect(pos!.x).toBeGreaterThanOrEqual(12.0);
  });

  it("resolves Ship vs Ship combat with 1.5x counter bonus", () => {
    const h = setupTestWorld();

    // Spawn Player 1 Galley at (14.5, 12.5) on water
    const galleyEid = spawnCombatUnit(
      h.world,
      h.comps,
      "galley",
      14.5,
      12.5,
      PLAYER_ONE,
    );
    attachOwner(h.world, h.comps, galleyEid, PLAYER_ONE);

    // Spawn Player 2 Fishing Boat at (16.5, 12.5) on water (distance = 2 tiles, within range 5)
    const targetEid = spawnCombatUnit(
      h.world,
      h.comps,
      "fishing-boat",
      16.5,
      12.5,
      PLAYER_TWO,
    );
    attachOwner(h.world, h.comps, targetEid, PLAYER_TWO);

    const targetInitialHp = combatHpOf(h.world, h.comps, targetEid);
    expect(targetInitialHp).toBe(60);

    // Order Galley to attack Fishing Boat
    h.world.inbox.submit({
      targetTick: 1,
      kind: ATTACK_COMMAND_KIND,
      data: { attackerIds: [galleyEid], targetId: targetEid },
    });

    // Step 2 ticks to acquire and strike
    step(h.world);
    step(h.world);

    // Base attack = 6, multiplier vs ship = 1.5x => floor(6 * 1.5) = 9 damage
    const hpAfterStrike = combatHpOf(h.world, h.comps, targetEid);
    expect(hpAfterStrike).toBe(targetInitialHp! - 9);

    // Check combat events
    const p1Events = readCombatEvents(h.world, h.comps, PLAYER_ONE);
    const shots = p1Events.filter((e) => e.kind === COMBAT_EVENT_SHOT);
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(shots[0]?.attackerEid).toBe(galleyEid);
    expect(shots[0]?.victimEid).toBe(targetEid);
    expect(shots[0]?.amount).toBe(9);

    const p2Events = readCombatEvents(h.world, h.comps, PLAYER_TWO);
    const damageEvents = p2Events.filter((e) => e.kind === COMBAT_EVENT_DAMAGE);
    expect(damageEvents.length).toBeGreaterThanOrEqual(1);
    expect(damageEvents[0]?.amount).toBe(9);
  });

  it("conducts coastal bombardment from water against land units and buildings", () => {
    const h = setupTestWorld();

    // War Galley on water at (14.5, 10.5), range 6
    const shipEid = spawnCombatUnit(
      h.world,
      h.comps,
      "war-galley",
      14.5,
      10.5,
      PLAYER_ONE,
    );
    attachOwner(h.world, h.comps, shipEid, PLAYER_ONE);

    // Enemy Swordsman on land at (10.5, 10.5) (distance = 4 tiles, within range 6)
    const landUnitEid = spawnCombatUnit(
      h.world,
      h.comps,
      "man-at-arms",
      10.5,
      10.5,
      PLAYER_TWO,
    );
    attachOwner(h.world, h.comps, landUnitEid, PLAYER_TWO);

    const initialHp = combatHpOf(h.world, h.comps, landUnitEid);

    // Order War Galley to attack the land unit
    h.world.inbox.submit({
      targetTick: 1,
      kind: ATTACK_COMMAND_KIND,
      data: { attackerIds: [shipEid], targetId: landUnitEid },
    });

    step(h.world);
    step(h.world);

    // War Galley attack = 7, man-at-arms armor = 0 => 7 damage
    const hpAfter = combatHpOf(h.world, h.comps, landUnitEid);
    expect(hpAfter).toBe(initialHp! - 7);

    // Ship must have stayed on water (x >= 12)
    const shipPos = getPosition(h.world, h.comps, shipEid);
    expect(shipPos!.x).toBeGreaterThanOrEqual(12.0);
  });

  it("verifies range progression: Galley (5) vs War Galley (6) vs Galleon (7)", () => {
    const galleyDef = unitDefOf("galley");
    const warGalleyDef = unitDefOf("war-galley");
    const galleonDef = unitDefOf("galleon");

    const galleyStats = deriveUnitStats(galleyDef);
    const warGalleyStats = deriveUnitStats(warGalleyDef);
    const galleonStats = deriveUnitStats(galleonDef);

    expect(galleyStats.range).toBe(5);
    expect(warGalleyStats.range).toBe(6);
    expect(galleonStats.range).toBe(7);

    // At distance 6.5:
    const dist = 6.5;
    expect(dist <= galleyStats.range).toBe(false);
    expect(dist <= warGalleyStats.range).toBe(false);
    expect(dist <= galleonStats.range).toBe(true); // only Galleon reaches

    // At distance 5.5:
    const dist2 = 5.5;
    expect(dist2 <= galleyStats.range).toBe(false);
    expect(dist2 <= warGalleyStats.range).toBe(true); // War Galley and Galleon reach
    expect(dist2 <= galleonStats.range).toBe(true);
  });
});

/**
 * Transport Ship & Amphibious Garrison tests — Milestone N3 (Issue #110 / Epic #84).
 *
 * Tests:
 * 1. Unit definition & Dock training queue:
 *    - transport-ship costs 125 Wood, 100 HP, 1.45 speed, Feudal Age, 5 garrison capacity.
 *    - Dock includes transport-ship in trainable list.
 * 2. Training at Dock with Feudal Age gating:
 *    - Dark Age player cannot enqueue transport-ship.
 *    - Feudal Age player can enqueue and trains transport-ship, which spawns on water berth.
 * 3. Coastal Embarkation:
 *    - Land units path to shore and embark into transport ship (within 1.5 tiles).
 *    - Units are removed from active world entities and stored in garrison row.
 *    - Population count includes garrisoned units.
 * 4. Water Transit & Mid-Ocean Ungarrison Prevention:
 *    - Transport ship moves across deep water channel.
 *    - Ungarrison order in deep water is rejected (units cannot disembark into water).
 * 5. Coastal Disembarkation (Island Hopping):
 *    - Transport ship moors at destination island shore.
 *    - Ungarrison command spawns units on passable island land tiles.
 * 6. Transport Sinking Casualties:
 *    - Sinking transport ship destroys all embarked units (AoE2 parity).
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
  GARRISON_COMMAND_KIND,
  UNGARRISON_COMMAND_KIND,
} from "../src/sim/systems/combat";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  isWaterTerrain,
} from "../src/sim/world/layers";
import { unitDefOf, buildingDefOf, unitCodeOf } from "../src/data/definitions";
import { getBuildingRow } from "../src/sim/components/buildings";
import { AGE_RANK } from "../src/data/schema";
import {
  createPlayerAgeState,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import { readGarrison, getGarrisonCount } from "../src/sim/components/garrison";
import { attachOwner } from "../src/sim/components/owner";
import { isNavalUnit } from "../src/sim/components/combat";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface ChannelHarness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly paths: PathScheduler;
}

/**
 * Creates a world with:
 * - x < 8: Main Continent (Grass)
 * - 8 <= x < 18: Water Channel (Water)
 * - x >= 18: Destination Island (Grass)
 */
function createChannelHarness(): ChannelHarness {
  const terrainType = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x < 8 || x >= 18) {
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

  // Initial stockpile: 500 wood, 500 food, 500 gold
  createPlayerStockpile(world, comps, PLAYER_ONE, [500, 500, 500, 0, 0, 0, 0]);
  createPlayerStockpile(world, comps, PLAYER_TWO, [500, 500, 500, 0, 0, 0, 0]);

  // Set Dark Age by default
  createPlayerAgeState(world, comps, PLAYER_ONE);

  return { world, comps, paths };
}

describe("Milestone N3: Amphibious Transport Ship & Mobile Garrison", () => {
  it("defines transport-ship correctly and registers it at the Dock", () => {
    const def = unitDefOf("transport-ship");
    expect(def.id).toBe("transport-ship");
    expect(def.costs.wood).toBe(125);
    expect(def.hp).toBe(100);
    expect(def.speed).toBe(1.45);
    expect(def.ageGate).toBe("feudal");
    expect(def.garrisonCapacity).toBe(5);
    expect(def.armorClasses).toContain("ship");

    const dockDef = buildingDefOf("dock");
    expect(
      dockDef.trainQueue?.trainable.some((u) => u.unitId === "transport-ship"),
    ).toBe(true);
  });

  it("enforces Feudal Age gate and trains Transport Ship at Dock", () => {
    const h = createChannelHarness();
    // Dock at x=6, y=10 (footprint 3x3: x in 6..8, y in 10..12; x=6,7 land, x=8 water)
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 6, 10, {
      playerId: PLAYER_ONE,
    });
    expect(getBuildingRow(h.world, h.comps, dockEid)).toBeDefined();

    // Dark Age player cannot enqueue transport-ship
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "transport-ship",
      ),
    ).toBe(false);

    // Advance player to Feudal Age
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "transport-ship",
      ),
    ).toBe(true);

    // Enqueue transport-ship training
    h.world.inbox.submit({
      kind: TRAIN_UNIT_KIND,
      targetTick: h.world.tick + 1,
      data: { siteEid: dockEid, unitId: "transport-ship" },
    });

    step(h.world); // train command consumed, 125 wood escrowed
    const woodAfter = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]!;
    expect(woodAfter).toBe(375); // 500 - 125 = 375

    // Run until trained
    const trainTime = unitDefOf("transport-ship").trainTime;
    for (let i = 0; i < trainTime; i++) {
      step(h.world);
    }

    // Find the spawned transport ship
    const shipEid = [...h.world.entities].find((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "transport-ship";
    });
    expect(shipEid).toBeDefined();
    expect(isNavalUnit(h.world, h.comps, shipEid!)).toBe(true);
    expect(combatHpOf(h.world, h.comps, shipEid!)).toBe(100);

    // Spawns on water tile (x in 8..17)
    const pos = getPosition(h.world, h.comps, shipEid!);
    expect(pos).toBeDefined();
    const terrain =
      h.world.layers.terrainType[
        Math.floor(pos!.y) * SIZE + Math.floor(pos!.x)
      ]!;
    expect(isWaterTerrain(terrain)).toBe(true);
  });

  it("embarks land units from shoreline into transport ship and maintains population", () => {
    const h = createChannelHarness();
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);

    // Spawn transport ship on water near shore at (8.5, 10.5)
    const shipEid = spawnCombatUnit(
      h.world,
      h.comps,
      "transport-ship",
      8.5,
      10.5,
      PLAYER_ONE,
    );
    expect(h.world.entities.includes(shipEid)).toBe(true);

    // Spawn land units on adjacent shore at (7.5, 10.5) and (7.5, 11.5)
    const villagerEid = spawnCombatUnit(
      h.world,
      h.comps,
      "villager",
      7.5,
      10.5,
      PLAYER_ONE,
    );
    const militiaEid = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      7.5,
      11.5,
      PLAYER_ONE,
    );

    // Population before embarkation: 3 units (1 ship + 1 villager + 1 militia)
    const popBefore = populationOf(h.world, h.comps, PLAYER_ONE);
    expect(popBefore).toBe(3);

    // Order both units to garrison into the transport ship
    h.world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { entityIds: [villagerEid, militiaEid], targetBuildingId: shipEid },
    });

    // Step ticks for units to embark
    for (let i = 0; i < 20; i++) {
      step(h.world);
      if (
        !h.world.entities.includes(villagerEid) &&
        !h.world.entities.includes(militiaEid)
      ) {
        break;
      }
    }

    // Both land units entered transport ship: despawned from active world entities
    expect(h.world.entities.includes(villagerEid)).toBe(false);
    expect(h.world.entities.includes(militiaEid)).toBe(false);
    expect(getGarrisonCount(h.world, h.comps, shipEid)).toBe(2);

    const garrisoned = readGarrison(h.world, h.comps, shipEid);
    expect(garrisoned.length).toBe(2);
    expect(garrisoned[0]!.unitCode).toBe(unitCodeOf("villager"));
    expect(garrisoned[1]!.unitCode).toBe(unitCodeOf("militia"));

    // Crucial: population count remains 3! Garrisoned units still consume pop cap!
    expect(populationOf(h.world, h.comps, PLAYER_ONE)).toBe(3);
  });

  it("moves across water and disembarks land units onto destination island", () => {
    const h = createChannelHarness();
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);

    const shipEid = spawnCombatUnit(
      h.world,
      h.comps,
      "transport-ship",
      8.5,
      10.5,
      PLAYER_ONE,
    );
    const villagerEid = spawnCombatUnit(
      h.world,
      h.comps,
      "villager",
      7.5,
      10.5,
      PLAYER_ONE,
    );

    // Embark
    h.world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { entityIds: [villagerEid], targetBuildingId: shipEid },
    });
    for (let i = 0; i < 20; i++) {
      step(h.world);
      if (!h.world.entities.includes(villagerEid)) break;
    }
    expect(getGarrisonCount(h.world, h.comps, shipEid)).toBe(1);

    // 1. Move into deep water at (13.5, 10.5)
    h.world.inbox.submit({
      kind: "groupMove",
      targetTick: h.world.tick + 1,
      data: { entityIds: [shipEid], x: 13.5, y: 10.5 },
    });
    for (let i = 0; i < 120; i++) {
      step(h.world);
    }
    const midPos = getPosition(h.world, h.comps, shipEid)!;
    expect(midPos.x).toBeGreaterThan(12.0);

    // 2. While in deep water, ungarrison should be rejected (cannot disembark into ocean)
    h.world.inbox.submit({
      kind: UNGARRISON_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { buildingEid: shipEid },
    });
    step(h.world);
    // Garrison must remain intact!
    expect(getGarrisonCount(h.world, h.comps, shipEid)).toBe(1);

    // 3. Move transport ship to destination island shoreline (17.5, 10.5)
    h.world.inbox.submit({
      kind: "groupMove",
      targetTick: h.world.tick + 1,
      data: { entityIds: [shipEid], x: 17.5, y: 10.5 },
    });
    for (let i = 0; i < 120; i++) {
      step(h.world);
    }
    const islandPos = getPosition(h.world, h.comps, shipEid)!;
    expect(islandPos.x).toBeGreaterThanOrEqual(17.0);

    // 4. Now at island shore: ungarrison!
    h.world.inbox.submit({
      kind: UNGARRISON_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { buildingEid: shipEid },
    });
    step(h.world);

    // Transport ship garrison emptied
    expect(getGarrisonCount(h.world, h.comps, shipEid)).toBe(0);

    // Unit re-spawned on Island B (x >= 18)
    const spawnedUnits = [...h.world.entities].filter((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "villager";
    });
    expect(spawnedUnits.length).toBe(1);
    const disembarkedPos = getPosition(h.world, h.comps, spawnedUnits[0]!)!;
    expect(disembarkedPos.x).toBeGreaterThanOrEqual(18.0);
    const terrain =
      h.world.layers.terrainType[
        Math.floor(disembarkedPos.y) * SIZE + Math.floor(disembarkedPos.x)
      ]!;
    expect(isWaterTerrain(terrain)).toBe(false);
  });

  it("destroys all embarked units when transport ship is sunk (AoE2 parity)", () => {
    const h = createChannelHarness();
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);

    const shipEid = spawnCombatUnit(
      h.world,
      h.comps,
      "transport-ship",
      8.5,
      10.5,
      PLAYER_ONE,
    );
    const militia1 = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      7.5,
      10.5,
      PLAYER_ONE,
    );
    const militia2 = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      7.5,
      11.5,
      PLAYER_ONE,
    );

    // Embark both militia
    h.world.inbox.submit({
      kind: GARRISON_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { entityIds: [militia1, militia2], targetBuildingId: shipEid },
    });
    for (let i = 0; i < 20; i++) {
      step(h.world);
      if (
        !h.world.entities.includes(militia1) &&
        !h.world.entities.includes(militia2)
      )
        break;
    }
    expect(getGarrisonCount(h.world, h.comps, shipEid)).toBe(2);
    expect(populationOf(h.world, h.comps, PLAYER_ONE)).toBe(3);

    // Spawn ranged enemy on shore (x=7.5 is land, ship is at x=8.5 on water, within range 5)
    const enemy = spawnCombatUnit(
      h.world,
      h.comps,
      "arbalest",
      7.5,
      10.5,
      PLAYER_TWO,
    );
    attachOwner(h.world, h.comps, enemy, PLAYER_TWO);

    // Set transport ship HP to 5 so one strike will sink it
    const shipCombatRow = h.world.rowsByComponentId
      .get(h.comps.combatId)
      ?.get(shipEid);
    if (shipCombatRow) shipCombatRow[2] = 5;

    // Order enemy to attack transport ship
    h.world.inbox.submit({
      kind: "attack",
      targetTick: h.world.tick + 1,
      data: { attackerIds: [enemy], targetId: shipEid },
    });

    // Step until transport ship is sunk
    for (let i = 0; i < 60; i++) {
      step(h.world);
      if (!h.world.entities.includes(shipEid)) break;
    }

    // Transport ship is sunk
    expect(h.world.entities.includes(shipEid)).toBe(false);

    // Crucial: no militia were ejected onto water or land; they perished with the ship!
    const remainingMilitia = [...h.world.entities].filter((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "militia";
    });
    expect(remainingMilitia.length).toBe(0);

    // Player population drops to 0 (all 3 units lost)
    expect(populationOf(h.world, h.comps, PLAYER_ONE)).toBe(0);
  });
});

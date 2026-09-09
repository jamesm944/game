/**
 * Fishing Boat and Coastal Dock Economy unit tests — Milestone N2 (#109).
 */

import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getBuildingRow,
  getPosition,
  getInventory,
  getCarryCapacity,
  spawnResourceNode,
  type SimComponents,
} from "../src/sim/components";
import {
  isNavalUnit,
  combatHpOf,
  combatDefOf,
} from "../src/sim/components/combat";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  TRAIN_UNIT_KIND,
  canEnqueueTraining,
  createTrainingSystem,
} from "../src/sim/systems/training";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../src/sim/systems/gather";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  isWaterTerrain,
} from "../src/sim/world/layers";
import { unitDefOf, buildingDefOf } from "../src/data/definitions";
import { RESOURCE_FOOD } from "../src/sim/components/economy";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly paths: PathScheduler;
  readonly gatherDiag: GatherDiagnostics;
}

/**
 * Creates a world where x < 10 is grass (land) and x >= 10 is water.
 */
function createShorelineHarness(initialWood = 500, initialFood = 0): Harness {
  const terrainType = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      terrainType[y * SIZE + x] = x < 10 ? TERRAIN_GRASS : TERRAIN_WATER;
    }
  }

  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(12345, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  const gatherDiag = createGatherDiagnostics();

  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createGatherSystem(comps, paths, gatherDiag));

  stampFinishedBuilding(world, comps, "house", 1, 1, { playerId: PLAYER_ONE });

  createPlayerStockpile(world, comps, PLAYER_ONE, [
    initialFood,
    initialWood,
    100,
    0,
    0,
    0,
    0,
  ]);

  return { world, comps, paths, gatherDiag };
}

describe("Milestone N2: Coastal Dock & Fishing Economy", () => {
  it("defines fishing-boat unit and dock training queue correctly", () => {
    const boatDef = unitDefOf("fishing-boat");
    expect(boatDef.id).toBe("fishing-boat");
    expect(boatDef.costs.wood).toBe(75);
    expect(boatDef.hp).toBe(60);
    expect(boatDef.speed).toBe(1.26);
    expect(boatDef.carryCapacity).toBe(15);
    expect(boatDef.armorClasses).toContain("ship");
    expect(boatDef.armorClasses).toContain("civilian");
    expect(boatDef.ageGate).toBe("dark");

    const dockDef = buildingDefOf("dock");
    expect(dockDef.trainQueue).toBeDefined();
    expect(dockDef.trainQueue?.capacity).toBe(15);
    expect(
      dockDef.trainQueue?.trainable.some((u) => u.unitId === "fishing-boat"),
    ).toBe(true);
    expect(dockDef.dropoffFilters).toContain("food");
  });

  it("trains a Fishing Boat at a Dock and spawns it on an adjacent water tile", () => {
    const h = createShorelineHarness(200, 0);
    // Stamp a Dock at x=9, y=10 (footprint 3x3: x in [9, 11], y in [10, 12])
    // x=9 is land (grass), x=10..11 is water. Shoreline hybrid placement!
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 9, 10, {
      playerId: PLAYER_ONE,
    });
    expect(getBuildingRow(h.world, h.comps, dockEid)).toBeDefined();
    expect(
      canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "fishing-boat"),
    ).toBe(true);

    // Enqueue training
    h.world.inbox.submit({
      kind: TRAIN_UNIT_KIND,
      targetTick: h.world.tick + 1,
      data: { siteEid: dockEid, unitId: "fishing-boat" },
    });

    step(h.world); // train command consumed and escrow paid
    const stockpileAfter = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
    expect(stockpileAfter[1]).toBe(125); // 200 - 75 = 125 wood

    const trainTime = unitDefOf("fishing-boat").trainTime;
    for (let i = 0; i < trainTime; i++) {
      step(h.world);
    }

    // Find the spawned unit
    const boatEid = [...h.world.entities].find((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "fishing-boat";
    });
    expect(boatEid).toBeDefined();
    expect(isNavalUnit(h.world, h.comps, boatEid!)).toBe(true);
    expect(combatHpOf(h.world, h.comps, boatEid!)).toBe(60);
    expect(getCarryCapacity(h.world, h.comps, boatEid!)).toBe(15);

    // Verify spawn position: must be on a water tile (x >= 10) and not inside dock footprint (x in 9..11, y in 10..12)
    const pos = getPosition(h.world, h.comps, boatEid!);
    expect(pos).toBeDefined();
    const tileX = Math.floor(pos!.x);
    const tileY = Math.floor(pos!.y);
    const terrain = h.world.layers.terrainType[tileY * SIZE + tileX]!;
    expect(isWaterTerrain(terrain)).toBe(true);
    // Not inside footprint
    const insideFootprint =
      tileX >= 9 && tileX <= 11 && tileY >= 10 && tileY <= 12;
    expect(insideFootprint).toBe(false);
  });

  it("enforces naval passability: Fishing Boat moves on water and cannot enter land", () => {
    const h = createShorelineHarness(200, 0);
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 9, 10, {
      playerId: PLAYER_ONE,
    });

    // Train and spawn the boat
    h.world.inbox.submit({
      kind: TRAIN_UNIT_KIND,
      targetTick: h.world.tick + 1,
      data: { siteEid: dockEid, unitId: "fishing-boat" },
    });
    for (let i = 0; i <= unitDefOf("fishing-boat").trainTime; i++) {
      step(h.world);
    }

    const boatEid = [...h.world.entities].find((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "fishing-boat";
    })!;

    const initialPos = getPosition(h.world, h.comps, boatEid)!;
    expect(initialPos).toBeDefined();

    // 1. Move deeper into water (x=16, y=10)
    h.world.inbox.submit({
      kind: "groupMove",
      targetTick: h.world.tick + 1,
      data: { entityIds: [boatEid], x: 16.5, y: 10.5 },
    });

    for (let i = 0; i < 150; i++) {
      step(h.world);
    }

    const waterPos = getPosition(h.world, h.comps, boatEid)!;
    expect(waterPos.x).toBeGreaterThan(15.0);
    expect(
      isWaterTerrain(
        h.world.layers.terrainType[
          Math.floor(waterPos.y) * SIZE + Math.floor(waterPos.x)
        ]!,
      ),
    ).toBe(true);

    // 2. Try to move deep onto land (x=2.5, y=10.5)
    h.world.inbox.submit({
      kind: "groupMove",
      targetTick: h.world.tick + 1,
      data: { entityIds: [boatEid], x: 2.5, y: 10.5 },
    });

    for (let i = 0; i < 150; i++) {
      step(h.world);
    }

    const landAttemptPos = getPosition(h.world, h.comps, boatEid)!;
    // The boat must remain on water!
    expect(landAttemptPos.x).toBeGreaterThanOrEqual(10.0);
    expect(
      isWaterTerrain(
        h.world.layers.terrainType[
          Math.floor(landAttemptPos.y) * SIZE + Math.floor(landAttemptPos.x)
        ]!,
      ),
    ).toBe(true);
  });

  it("executes the full fishing economy loop: harvest fish node, deliver to Dock, resume", () => {
    const h = createShorelineHarness(200, 0);
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 9, 10, {
      playerId: PLAYER_ONE,
    });

    // Train and spawn the boat
    h.world.inbox.submit({
      kind: TRAIN_UNIT_KIND,
      targetTick: h.world.tick + 1,
      data: { siteEid: dockEid, unitId: "fishing-boat" },
    });
    for (let i = 0; i <= unitDefOf("fishing-boat").trainTime; i++) {
      step(h.world);
    }

    const boatEid = [...h.world.entities].find((eid) => {
      const def = combatDefOf(h.world, h.comps, eid);
      return def?.id === "fishing-boat";
    })!;

    // Spawn a fish resource node at water tile (14, 11) with 100 food
    const fishNodeEid = spawnResourceNode(
      h.world,
      h.comps,
      14,
      11,
      RESOURCE_FOOD,
      100,
    );

    // Issue gather order to the fishing boat
    h.world.inbox.submit({
      kind: "gather",
      targetTick: h.world.tick + 1,
      data: { entityIds: [boatEid], nodeId: fishNodeEid },
    });

    step(h.world); // gather order processed, boat assigned to node

    // Step until the boat fills its cargo (15 food)
    let filled = false;
    for (let tick = 0; tick < 700; tick++) {
      step(h.world);
      const inv = getInventory(h.world, h.comps, boatEid);
      if (inv && inv.amount >= 15) {
        filled = true;
        break;
      }
    }
    expect(filled).toBe(true);
    expect(getInventory(h.world, h.comps, boatEid)?.amount).toBe(15);

    // Step until the boat returns to the Dock and delivers its cargo
    let delivered = false;
    for (let tick = 0; tick < 500; tick++) {
      step(h.world);
      const stockpile = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
      if (stockpile[0]! >= 15) {
        delivered = true;
        break;
      }
    }
    expect(delivered).toBe(true);
    expect(
      stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]!,
    ).toBeGreaterThanOrEqual(15);

    // After delivery, boat inventory should be empty and it should head back to harvest
    const invAfter = getInventory(h.world, h.comps, boatEid);
    expect(invAfter?.amount).toBe(0);

    // Step further to confirm it starts harvesting again
    let gatheredAgain = false;
    for (let tick = 0; tick < 400; tick++) {
      step(h.world);
      const inv = getInventory(h.world, h.comps, boatEid);
      if (inv && inv.amount > 0) {
        gatheredAgain = true;
        break;
      }
    }
    expect(gatheredAgain).toBe(true);
  });
});

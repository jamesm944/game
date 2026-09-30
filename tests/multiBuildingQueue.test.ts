import { describe, expect, it } from "vitest";
import { createWorld, registerSystem } from "../src/sim/core/world";
import { defineSimComponents } from "../src/sim/components";
import { completeBuilding, spawnBuildingSite, writeTrainQueue } from "../src/sim/components/buildings";
import { unitCodeOf } from "../src/data/definitions";
import { createPlayerStockpile, PLAYER_ONE } from "../src/sim/core/stockpile";
import { createAgeSystem } from "../src/sim/systems/age";
import { createTrainingSystem } from "../src/sim/systems/training";
import {
  aggregateBuildingSelection,
  dispatchBalancedTraining,
  getBuildingQueueStatus,
  pickBuildingForTraining,
  pluralizeBuildingName,
} from "../src/sim/economy/multiQueue";

describe("Multi-Building Queue Aggregation & Balanced Production (Q1 / #119)", () => {
  describe("pluralizeBuildingName", () => {
    it("preserves singular for count 1", () => {
      expect(pluralizeBuildingName("Barracks", 1)).toBe("Barracks");
      expect(pluralizeBuildingName("Archery Range", 1)).toBe("Archery Range");
      expect(pluralizeBuildingName("Monastery", 1)).toBe("Monastery");
    });

    it("pluralizes correctly for count > 1", () => {
      expect(pluralizeBuildingName("Barracks", 2)).toBe("Barracks"); // already ending in s
      expect(pluralizeBuildingName("Archery Range", 2)).toBe("Archery Ranges");
      expect(pluralizeBuildingName("Dock", 3)).toBe("Docks");
      expect(pluralizeBuildingName("Town Center", 4)).toBe("Town Centers");
      expect(pluralizeBuildingName("Monastery", 2)).toBe("Monasteries");
    });
  });

  describe("getBuildingQueueStatus", () => {
    it("returns undefined for non-production buildings", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      const siteEid = spawnBuildingSite(world, comps, "house", 10, 10, { playerId: PLAYER_ONE });
      const completed = completeBuilding(world, comps, siteEid);

      const status = getBuildingQueueStatus(world, comps, completed.eid);
      expect(status).toBeUndefined();
    });

    it("reads empty queue status correctly", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      const siteEid = spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE });
      const completed = completeBuilding(world, comps, siteEid);

      const status = getBuildingQueueStatus(world, comps, completed.eid);
      expect(status).toBeDefined();
      expect(status?.defId).toBe("barracks");
      expect(status?.queueLength).toBe(0);
      expect(status?.capacity).toBe(15);
      expect(status?.headUnitId).toBeUndefined();
    });

    it("reads active queue with head unit and countdown", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      const siteEid = spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE });
      const completed = completeBuilding(world, comps, siteEid);

      writeTrainQueue(world, comps, completed.eid, [
        { unitCode: unitCodeOf("militia"), remainingTicks: 150 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
      ]);

      const status = getBuildingQueueStatus(world, comps, completed.eid);
      expect(status).toBeDefined();
      expect(status?.queueLength).toBe(2);
      expect(status?.headUnitId).toBe("militia");
      expect(status?.headUnitName).toBe("Militia");
      expect(status?.headRemainingTicks).toBe(150);
    });
  });

  describe("aggregateBuildingSelection", () => {
    it("returns homogeneous title and trainable units for multiple barracks", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      // Spawn 3 barracks
      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;
      const b3 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 20, 10, { playerId: PLAYER_ONE })).eid;

      // Add a house so population cap > 0
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "house", 5, 5, { playerId: PLAYER_ONE }));

      const summary = aggregateBuildingSelection(world, comps, [b1, b2, b3], PLAYER_ONE);
      expect(summary).toBeDefined();
      expect(summary?.isHomogeneous).toBe(true);
      expect(summary?.title).toBe("3 Barracks");
      expect(summary?.buildingEids).toEqual([b1, b2, b3]);
      expect(summary?.buildingQueues.length).toBe(3);
      expect(summary?.totalQueuedCount).toBe(0);

      // Check trainable units (Militia, Man-at-Arms, Spearman)
      const militia = summary?.trainableUnits.find((u) => u.unitId === "militia");
      expect(militia).toBeDefined();
      expect(militia?.capableBuildingCount).toBe(3);
      expect(militia?.capableBuildingEids).toEqual([b1, b2, b3]);
    });

    it("returns heterogeneous title for mixed production buildings", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const a1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "archery-range", 15, 10, { playerId: PLAYER_ONE })).eid;

      const summary = aggregateBuildingSelection(world, comps, [b1, a1], PLAYER_ONE);
      expect(summary).toBeDefined();
      expect(summary?.isHomogeneous).toBe(false);
      expect(summary?.title).toBe("2 Production Buildings");

      // Militia only in Barracks (count 1)
      const militia = summary?.trainableUnits.find((u) => u.unitId === "militia");
      expect(militia?.capableBuildingCount).toBe(1);
      expect(militia?.capableBuildingEids).toEqual([b1]);

      // Archer only in Archery Range (count 1)
      const archer = summary?.trainableUnits.find((u) => u.unitId === "archer");
      expect(archer?.capableBuildingCount).toBe(1);
      expect(archer?.capableBuildingEids).toEqual([a1]);
    });

    it("filters out opponent buildings", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);

      const myB = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const enemyB = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 20, 20, { playerId: 1 })).eid;

      const summary = aggregateBuildingSelection(world, comps, [myB, enemyB], PLAYER_ONE);
      expect(summary).toBeDefined();
      expect(summary?.buildingEids).toEqual([myB]);
      expect(summary?.title).toBe("1 Barracks");
    });
  });

  describe("pickBuildingForTraining (Shortest-Queue Balancing)", () => {
    it("chooses the empty building over one with units queued", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 1000, 0, 0, 0]);
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "house", 5, 5, { playerId: PLAYER_ONE }));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;

      // b1 has 1 militia queued
      writeTrainQueue(world, comps, b1, [{ unitCode: unitCodeOf("militia"), remainingTicks: 200 }]);
      // b2 is empty
      writeTrainQueue(world, comps, b2, []);

      const picked = pickBuildingForTraining(world, comps, [b1, b2], PLAYER_ONE, "militia");
      expect(picked).toBe(b2);
    });

    it("tie-breaks by remaining ticks when queue lengths match", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 1000, 0, 0, 0]);
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "house", 5, 5, { playerId: PLAYER_ONE }));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;

      // Both have 1 unit, but b2 has only 30 ticks remaining (almost done) vs b1's 250 ticks
      writeTrainQueue(world, comps, b1, [{ unitCode: unitCodeOf("militia"), remainingTicks: 250 }]);
      writeTrainQueue(world, comps, b2, [{ unitCode: unitCodeOf("militia"), remainingTicks: 30 }]);

      const picked = pickBuildingForTraining(world, comps, [b1, b2], PLAYER_ONE, "militia");
      expect(picked).toBe(b2);
    });

    it("respects queue capacity (5 max)", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 1000, 0, 0, 0]);
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "town-center", 5, 5, { playerId: PLAYER_ONE }));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;

      // b1 is completely full (5 units)
      writeTrainQueue(world, comps, b1, [
        { unitCode: unitCodeOf("militia"), remainingTicks: 100 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
      ]);
      // b2 has 3 units
      writeTrainQueue(world, comps, b2, [
        { unitCode: unitCodeOf("militia"), remainingTicks: 100 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
        { unitCode: unitCodeOf("militia"), remainingTicks: 300 },
      ]);

      const picked = pickBuildingForTraining(world, comps, [b1, b2], PLAYER_ONE, "militia");
      expect(picked).toBe(b2);
    });
  });

  describe("dispatchBalancedTraining", () => {
    it("evenly balances a batch of 5 units across 2 empty barracks", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 1000, 0, 0, 0]);
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "town-center", 5, 5, { playerId: PLAYER_ONE }));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;

      const enqueued = dispatchBalancedTraining(
        world,
        comps,
        world.inbox,
        world.tick,
        [b1, b2],
        PLAYER_ONE,
        "militia",
        5,
      );

      expect(enqueued).toBe(5);

      // Verify commands submitted to inbox
      const commands = [...world.inbox.drainDue(world.tick + 1)];
      expect(commands.length).toBe(5);

      // Counts per building in the submitted commands:
      const b1Count = commands.filter((c) => (c.data as { siteEid?: number }).siteEid === b1).length;
      const b2Count = commands.filter((c) => (c.data as { siteEid?: number }).siteEid === b2).length;

      // 5 units across 2 barracks -> 3 and 2
      expect(Math.max(b1Count, b2Count)).toBe(3);
      expect(Math.min(b1Count, b2Count)).toBe(2);
    });

    it("distributes 1 unit to each of 3 barracks when ordering 3 units", () => {
      const world = createWorld(42);
      const comps = defineSimComponents(world);
      registerSystem(world, createAgeSystem(comps));
      registerSystem(world, createTrainingSystem(comps));

      createPlayerStockpile(world, comps, PLAYER_ONE, [1000, 1000, 1000, 1000, 0, 0, 0]);
      completeBuilding(world, comps, spawnBuildingSite(world, comps, "town-center", 5, 5, { playerId: PLAYER_ONE }));

      const b1 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 10, 10, { playerId: PLAYER_ONE })).eid;
      const b2 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 15, 10, { playerId: PLAYER_ONE })).eid;
      const b3 = completeBuilding(world, comps, spawnBuildingSite(world, comps, "barracks", 20, 10, { playerId: PLAYER_ONE })).eid;

      const enqueued = dispatchBalancedTraining(
        world,
        comps,
        world.inbox,
        world.tick,
        [b1, b2, b3],
        PLAYER_ONE,
        "militia",
        3,
      );

      expect(enqueued).toBe(3);

      const commands = [...world.inbox.drainDue(world.tick + 1)];
      const targetEids = commands.map((c) => (c.data as { siteEid?: number }).siteEid);
      expect(targetEids).toContain(b1);
      expect(targetEids).toContain(b2);
      expect(targetEids).toContain(b3);
    });
  });
});

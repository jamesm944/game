/**
 * Simulation-side deterministic rally point tests — Q1 (Issue #120).
 */

import { describe, expect, it } from "vitest";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../src/sim/core/world";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnUnit,
  type SimComponents,
} from "../../src/sim/components";
import {
  createTrainingSystem,
  SET_RALLY_POINT_KIND,
  SET_MULTI_RALLY_POINT_KIND,
  CLEAR_RALLY_POINT_KIND,
} from "../../src/sim/systems/training";
import {
  completeBuilding,
  spawnBuildingSite,
  writeTrainQueue,
} from "../../src/sim/components/buildings";
import {
  spawnResourceNode,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
} from "../../src/sim/components/economy";
import {
  getRallyPoint,
  setRallyPoint,
  clearRallyPoint,
  hasRallyPoint,
  dispatchSpawnedUnitToRally,
} from "../../src/sim/core/rally";
import { unitCodeOf } from "../../src/data/definitions";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { createMovementSystem } from "../../src/sim/systems/movement";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

function setupTestWorld(): { world: World; comps: SimComponents } {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(42, { size: 60, pathScheduler: paths });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createTrainingSystem(comps));
  return { world, comps };
}

function spawnTestBarracks(
  world: World,
  comps: SimComponents,
  x: number = 10,
  y: number = 10,
  playerId: number = PLAYER_ONE,
): number {
  const siteEid = spawnBuildingSite(world, comps, "barracks", x, y, {
    playerId,
  });
  completeBuilding(world, comps, siteEid);
  return siteEid;
}

function spawnTestTownCenter(
  world: World,
  comps: SimComponents,
  x: number = 20,
  y: number = 20,
  playerId: number = PLAYER_ONE,
): number {
  const siteEid = spawnBuildingSite(world, comps, "town-center", x, y, {
    playerId,
  });
  completeBuilding(world, comps, siteEid);
  return siteEid;
}

describe("Rally Point Core Queries & Helpers", () => {
  it("sets, queries, and clears rally points on world", () => {
    const { world } = setupTestWorld();
    const bEid = 42;

    expect(hasRallyPoint(world, bEid)).toBe(false);
    expect(getRallyPoint(world, bEid)).toBeUndefined();

    setRallyPoint(world, bEid, { x: 15.5, y: 25.5, targetEntityId: 99 });
    expect(hasRallyPoint(world, bEid)).toBe(true);
    expect(getRallyPoint(world, bEid)).toEqual({
      x: 15.5,
      y: 25.5,
      targetEntityId: 99,
    });

    const removed = clearRallyPoint(world, bEid);
    expect(removed).toBe(true);
    expect(hasRallyPoint(world, bEid)).toBe(false);
    expect(getRallyPoint(world, bEid)).toBeUndefined();

    // Clearing non-existent returns false
    expect(clearRallyPoint(world, bEid)).toBe(false);
  });
});

describe("dispatchSpawnedUnitToRally", () => {
  it("dispatches spawned military unit to ground rally coords via groupMove", () => {
    const { world, comps } = setupTestWorld();
    const barracksEid = spawnTestBarracks(world, comps, 10, 10);
    setRallyPoint(world, barracksEid, { x: 30, y: 40 });

    const soldierEid = spawnCombatUnit(
      world,
      comps,
      "militia",
      12.5,
      12.5,
      PLAYER_ONE,
    );

    dispatchSpawnedUnitToRally(
      world,
      comps,
      soldierEid,
      barracksEid,
      "militia",
    );

    // Check inbox for scheduled groupMove order
    const due = world.inbox.drainDue(world.tick + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("groupMove");
    expect(due[0]!.data).toEqual({
      entityIds: [soldierEid],
      x: 30,
      y: 40,
    });
  });

  it("dispatches spawned villager to resource node rally via gather", () => {
    const { world, comps } = setupTestWorld();
    const tcEid = spawnTestTownCenter(world, comps, 20, 20);
    const goldNodeEid = spawnResourceNode(
      world,
      comps,
      25,
      25,
      RESOURCE_GOLD,
      800,
    );

    setRallyPoint(world, tcEid, { x: 25, y: 25, targetEntityId: goldNodeEid });

    const villagerEid = spawnUnit(world, comps, 22.5, 22.5, {
      ownerId: PLAYER_ONE,
    });

    dispatchSpawnedUnitToRally(world, comps, villagerEid, tcEid, "villager");

    const due = world.inbox.drainDue(world.tick + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("gather");
    expect(due[0]!.data).toEqual({
      entityIds: [villagerEid],
      nodeId: goldNodeEid,
    });
  });

  it("falls back to ground move when rallied resource node is depleted", () => {
    const { world, comps } = setupTestWorld();
    const tcEid = spawnTestTownCenter(world, comps, 20, 20);
    // Node with 0 remaining
    const depletedNodeEid = spawnResourceNode(
      world,
      comps,
      28,
      28,
      RESOURCE_FOOD,
      100,
    );
    // Mark depleted
    world.rowsByComponentId
      .get(comps.resourceNodeId)!
      .get(depletedNodeEid)![1] = 0;

    setRallyPoint(world, tcEid, {
      x: 28,
      y: 28,
      targetEntityId: depletedNodeEid,
    });

    const villagerEid = spawnUnit(world, comps, 22.5, 22.5, {
      ownerId: PLAYER_ONE,
    });

    dispatchSpawnedUnitToRally(world, comps, villagerEid, tcEid, "villager");

    const due = world.inbox.drainDue(world.tick + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("groupMove");
    expect(due[0]!.data).toEqual({
      entityIds: [villagerEid],
      x: 28,
      y: 28,
    });
  });

  it("dispatches spawned villager to construction site rally via build", () => {
    const { world, comps } = setupTestWorld();
    const tcEid = spawnTestTownCenter(world, comps, 20, 20);
    const siteEid = spawnBuildingSite(world, comps, "house", 15, 15, {
      playerId: PLAYER_ONE,
    });

    setRallyPoint(world, tcEid, { x: 15, y: 15, targetEntityId: siteEid });

    const villagerEid = spawnUnit(world, comps, 22.5, 22.5, {
      ownerId: PLAYER_ONE,
    });

    dispatchSpawnedUnitToRally(world, comps, villagerEid, tcEid, "villager");

    const due = world.inbox.drainDue(world.tick + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("build");
    expect(due[0]!.data).toEqual({
      entityIds: [villagerEid],
      siteEid,
    });
  });

  it("dispatches non-worker to ground move even if rallied to a resource node", () => {
    const { world, comps } = setupTestWorld();
    const barracksEid = spawnTestBarracks(world, comps, 10, 10);
    const nodeEid = spawnResourceNode(world, comps, 25, 25, RESOURCE_GOLD, 800);

    setRallyPoint(world, barracksEid, {
      x: 25,
      y: 25,
      targetEntityId: nodeEid,
    });

    const soldierEid = spawnCombatUnit(
      world,
      comps,
      "militia",
      12.5,
      12.5,
      PLAYER_ONE,
    );

    // Militia cannot gather, so it should fall back to ground move
    dispatchSpawnedUnitToRally(
      world,
      comps,
      soldierEid,
      barracksEid,
      "militia",
    );

    const due = world.inbox.drainDue(world.tick + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("groupMove");
    expect(due[0]!.data).toEqual({
      entityIds: [soldierEid],
      x: 25,
      y: 25,
    });
  });
});

describe("Training System Rally Command Handling & Spawn Loop", () => {
  it("consumes setRallyPoint command and updates building rally target", () => {
    const { world, comps } = setupTestWorld();
    const bEid = spawnTestBarracks(world, comps, 10, 10);

    world.inbox.submit({
      kind: SET_RALLY_POINT_KIND,
      targetTick: 1,
      data: {
        buildingEid: bEid,
        x: 35.5,
        y: 42.5,
      },
    });

    step(world); // tick 1

    expect(getRallyPoint(world, bEid)).toEqual({
      x: 35.5,
      y: 42.5,
      targetEntityId: undefined,
    });
  });

  it("consumes setMultiRallyPoint command and updates all targeted buildings", () => {
    const { world, comps } = setupTestWorld();
    const b1 = spawnTestBarracks(world, comps, 10, 10);
    const b2 = spawnTestBarracks(world, comps, 15, 10);
    const tc = spawnTestTownCenter(world, comps, 25, 25);

    world.inbox.submit({
      kind: SET_MULTI_RALLY_POINT_KIND,
      targetTick: 1,
      data: {
        buildingEids: [b1, b2, tc],
        x: 50,
        y: 50,
      },
    });

    step(world);

    expect(getRallyPoint(world, b1)).toEqual({
      x: 50,
      y: 50,
      targetEntityId: undefined,
    });
    expect(getRallyPoint(world, b2)).toEqual({
      x: 50,
      y: 50,
      targetEntityId: undefined,
    });
    expect(getRallyPoint(world, tc)).toEqual({
      x: 50,
      y: 50,
      targetEntityId: undefined,
    });
  });

  it("consumes clearRallyPoint command", () => {
    const { world, comps } = setupTestWorld();
    const bEid = spawnTestBarracks(world, comps, 10, 10);
    setRallyPoint(world, bEid, { x: 30, y: 30 });

    world.inbox.submit({
      kind: CLEAR_RALLY_POINT_KIND,
      targetTick: 1,
      data: { buildingEid: bEid },
    });

    step(world);
    expect(hasRallyPoint(world, bEid)).toBe(false);
  });

  it("automatically marches trained unit to rally point upon queue completion", () => {
    const { world, comps } = setupTestWorld();
    // House provides pop capacity so production is not blocked
    const houseEid = spawnBuildingSite(world, comps, "house", 5, 5, {
      playerId: PLAYER_ONE,
    });
    completeBuilding(world, comps, houseEid);

    const bEid = spawnTestBarracks(world, comps, 10, 10);
    setRallyPoint(world, bEid, { x: 35, y: 35 });

    // Set train queue with 1 remaining tick for instant completion
    writeTrainQueue(world, comps, bEid, [
      { unitCode: unitCodeOf("militia"), remainingTicks: 1 },
    ]);

    step(world); // tick 1: queue finishes, unit spawns, rally order dispatched
    step(world); // tick 2: movement system picks up groupMove and requests path
    step(world); // tick 3: path in flight
    step(world); // tick 4: path response pumped, moveTarget set, unit begins marching
    step(world); // tick 5: unit continues moving

    // Find the spawned unit entity
    const posRows = world.rowsByComponentId.get(comps.positionId);
    expect(posRows).toBeDefined();

    // Verify move target was set
    const moveRows = world.rowsByComponentId.get(comps.moveTargetId);
    expect(moveRows).toBeDefined();

    // The newly spawned unit should have move target (35, 35)
    let foundMovingUnit = false;
    for (const [eid, target] of moveRows!) {
      if (
        eid !== bEid &&
        Math.abs(target[0]! - 35) < 0.1 &&
        Math.abs(target[1]! - 35) < 0.1
      ) {
        foundMovingUnit = true;
        break;
      }
    }
    expect(foundMovingUnit).toBe(true);
  });
});

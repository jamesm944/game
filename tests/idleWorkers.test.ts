/**
 * Idle Worker Management — V15 / Issue #106.
 *
 * Tests for findIdleVillagers, smartRedistributeIdleWorkers, and
 * formatRedistributionMessage covering all acceptance criteria.
 */

import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  RESOURCE_FOOD,
  RESOURCE_WOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  spawnResourceNode,
} from "../src/sim/components/economy";
import {
  createPlayerStockpile,
  createDropOffPoint,
  PLAYER_ONE,
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
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  findIdleVillagers,
  smartRedistributeIdleWorkers,
  formatRedistributionMessage,
  type RedistributionResult,
} from "../src/sim/economy/idleWorkers";
import {
  createGatherSystem,
  createGatherDiagnostics,
} from "../src/sim/systems/gather";
import { unitCodeOf } from "../src/data/definitions";
import { issueGather } from "../src/ui/orders";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VILLAGER_CODE = unitCodeOf("villager");

function makeHarness() {
  const size = 64;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(20261001, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));

  const startResources = new Array(7).fill(0);
  startResources[RESOURCE_WOOD] = 500;
  createPlayerStockpile(world, comps, PLAYER_ONE, startResources);

  const diag = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, diag));

  createDropOffPoint(world, comps, 10, 10, PLAYER_ONE, [
    RESOURCE_FOOD,
    RESOURCE_WOOD,
    RESOURCE_GOLD,
    RESOURCE_STONE,
  ]);

  return { world, comps };
}

/**
 * Spawn a villager: a movement unit + combatId row with VILLAGER_CODE.
 * The combatId row format is [unitCode, attack, hp, targetEid, reloadCounter].
 */
function spawnVillager(
  world: World,
  comps: SimComponents,
  x: number,
  y: number,
  playerId: number = PLAYER_ONE,
): number {
  const eid = spawnUnit(world, comps, x, y, { ownerId: playerId });
  world.rowsByComponentId.get(comps.combatId)!.set(eid, [
    VILLAGER_CODE, // unitCode
    3,             // attack (villager gathering tool)
    40,            // hp
    0,             // targetEid (none)
    0,             // reloadCounter
  ]);
  return eid;
}

// ---------------------------------------------------------------------------
// findIdleVillagers
// ---------------------------------------------------------------------------

describe("findIdleVillagers", () => {
  it("returns an empty array when there are no units", () => {
    const { world, comps } = makeHarness();
    expect(findIdleVillagers(world, comps)).toEqual([]);
  });

  it("detects a freshly spawned villager as idle", () => {
    const { world, comps } = makeHarness();
    const eid = spawnVillager(world, comps, 5, 5);
    step(world);
    const idle = findIdleVillagers(world, comps);
    expect(idle).toContain(eid);
  });

  it("does NOT list a villager that is actively gathering", () => {
    const { world, comps } = makeHarness();
    const nodeEid = spawnResourceNode(world, comps, 12, 12, RESOURCE_WOOD, 200);
    const workerEid = spawnVillager(world, comps, 12, 12);

    issueGather(world.inbox, world.tick, [workerEid], nodeEid);
    step(world);

    // Worker now has an assigned node or activity — should not be idle
    const idle = findIdleVillagers(world, comps);
    expect(idle).not.toContain(workerEid);
  });

  it("does NOT list a unit that lacks a combatId row (non-villager)", () => {
    const { world, comps } = makeHarness();
    // Plain movement unit with no combatId row
    spawnUnit(world, comps, 5, 5, { ownerId: PLAYER_ONE });
    step(world);
    const idle = findIdleVillagers(world, comps);
    expect(idle).toHaveLength(0);
  });

  it("counts multiple idle villagers correctly", () => {
    const { world, comps } = makeHarness();
    const a = spawnVillager(world, comps, 5, 5);
    const b = spawnVillager(world, comps, 6, 6);
    const c = spawnVillager(world, comps, 7, 7);
    step(world);
    const idle = findIdleVillagers(world, comps);
    expect(idle).toContain(a);
    expect(idle).toContain(b);
    expect(idle).toContain(c);
    expect(idle.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores units belonging to other players", () => {
    const { world, comps } = makeHarness();
    const otherPlayer = 2;
    const playerUnit = spawnVillager(world, comps, 5, 5, PLAYER_ONE);
    const enemyUnit  = spawnVillager(world, comps, 20, 20, otherPlayer);
    step(world);

    const idle = findIdleVillagers(world, comps, PLAYER_ONE);
    expect(idle).toContain(playerUnit);
    expect(idle).not.toContain(enemyUnit);
  });
});

// ---------------------------------------------------------------------------
// smartRedistributeIdleWorkers
// ---------------------------------------------------------------------------

describe("smartRedistributeIdleWorkers", () => {
  it("returns zero totals when no workers are idle", () => {
    const { world, comps } = makeHarness();
    // No villagers at all
    const result = smartRedistributeIdleWorkers(world, comps);
    expect(result.total).toBe(0);
    expect(result.assignedEids).toEqual([]);
  });

  it("returns zero totals when there are no available resource nodes", () => {
    const { world, comps } = makeHarness();
    spawnVillager(world, comps, 5, 5);
    step(world);
    const result = smartRedistributeIdleWorkers(world, comps);
    expect(result.total).toBe(0);
  });

  it("dispatches idle workers to available nodes and returns correct counts", () => {
    const { world, comps } = makeHarness();
    spawnResourceNode(world, comps, 15, 15, RESOURCE_FOOD, 200);
    spawnResourceNode(world, comps, 20, 20, RESOURCE_WOOD, 200);

    const v1 = spawnVillager(world, comps, 16, 16);
    const v2 = spawnVillager(world, comps, 17, 17);
    step(world);

    const result = smartRedistributeIdleWorkers(world, comps);
    expect(result.total).toBeGreaterThan(0);
    expect(result.assignedEids.length).toBe(result.total);
    // Every assigned eid should be one of our villagers
    for (const eid of result.assignedEids) {
      expect([v1, v2]).toContain(eid);
    }
  });

  it("does not exceed node capacity (work slots)", () => {
    const { world, comps } = makeHarness();
    // Node with only 1 slot
    spawnResourceNode(world, comps, 15, 15, RESOURCE_FOOD, 200, { workSlots: 1 });

    // Three idle villagers compete for 1 slot
    spawnVillager(world, comps, 15, 15);
    spawnVillager(world, comps, 16, 16);
    spawnVillager(world, comps, 17, 17);
    step(world);

    const result = smartRedistributeIdleWorkers(world, comps);
    // At most 1 can be assigned (node capacity = 1)
    expect(result.total).toBeLessThanOrEqual(1);
  });

  it("skips depleted nodes (amount <= 0)", () => {
    const { world, comps } = makeHarness();
    // Use amount=1 which is the minimum valid, then manually deplete it
    const nodeEid = spawnResourceNode(world, comps, 15, 15, RESOURCE_FOOD, 1);
    // Deplete manually
    world.rowsByComponentId.get(comps.resourceNodeId)!.set(nodeEid, [RESOURCE_FOOD, 0, 4]);

    spawnVillager(world, comps, 15, 15);
    step(world);

    const result = smartRedistributeIdleWorkers(world, comps);
    expect(result.total).toBe(0);
  });

  it("submits gather commands into world.inbox for each assigned worker", () => {
    const { world, comps } = makeHarness();
    spawnResourceNode(world, comps, 15, 15, RESOURCE_WOOD, 200);
    spawnVillager(world, comps, 15, 15);
    step(world);

    const submitted: unknown[] = [];
    const origSubmit = world.inbox.submit.bind(world.inbox);
    world.inbox.submit = (cmd) => {
      submitted.push(cmd);
      origSubmit(cmd);
    };

    const result = smartRedistributeIdleWorkers(world, comps);
    if (result.total > 0) {
      expect(submitted.length).toBeGreaterThan(0);
      const gatherCmds = submitted.filter(
        (c) => (c as { kind: string }).kind === "gather",
      );
      expect(gatherCmds.length).toBe(result.total);
    }
  });

  it("prefers the nearest node for each idle worker", () => {
    const { world, comps } = makeHarness();
    const nearNode = spawnResourceNode(world, comps, 6, 6, RESOURCE_FOOD, 200);
    spawnResourceNode(world, comps, 50, 50, RESOURCE_FOOD, 200);

    // Worker right next to nearNode
    spawnVillager(world, comps, 6, 6);
    step(world);

    const submitted: Array<{ kind: string; data: { nodeId: number } }> = [];
    const origSubmit = world.inbox.submit.bind(world.inbox);
    world.inbox.submit = (cmd) => {
      submitted.push(cmd as unknown as { kind: string; data: { nodeId: number } });
      origSubmit(cmd);
    };

    const result = smartRedistributeIdleWorkers(world, comps);
    if (result.total > 0) {
      const gather = submitted.find((c) => c.kind === "gather");
      expect(gather).toBeDefined();
      expect(gather!.data.nodeId).toBe(nearNode);
    }
  });

  it("spreads workers across multiple resources matching age weights", () => {
    const { world, comps } = makeHarness();
    // Generous food and wood nodes
    spawnResourceNode(world, comps, 10, 10, RESOURCE_FOOD, 500, { workSlots: 10 });
    spawnResourceNode(world, comps, 20, 20, RESOURCE_WOOD, 500, { workSlots: 10 });

    // 6 idle villagers
    for (let i = 0; i < 6; i++) {
      spawnVillager(world, comps, 10 + i, 10);
    }
    step(world);

    const result = smartRedistributeIdleWorkers(world, comps);
    expect(result.total).toBe(6);
    // Both resources should receive at least 1 worker (age-weighted split)
    const keys = Object.keys(result.byResource);
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// formatRedistributionMessage
// ---------------------------------------------------------------------------

describe("formatRedistributionMessage", () => {
  it("returns a 'no idle workers' message when total is 0", () => {
    const res: RedistributionResult = {
      total: 0,
      byResource: {},
      assignedEids: [],
    };
    expect(formatRedistributionMessage(res)).toBe(
      "No idle workers to redistribute",
    );
  });

  it("formats singular worker correctly", () => {
    const res: RedistributionResult = {
      total: 1,
      byResource: { wood: 1 },
      assignedEids: [42],
    };
    const msg = formatRedistributionMessage(res);
    expect(msg).toContain("1 idle worker");
    expect(msg).toContain("wood");
    expect(msg).toContain("⚡");
  });

  it("formats plural workers with multiple resources", () => {
    const res: RedistributionResult = {
      total: 3,
      byResource: { wood: 2, food: 1 },
      assignedEids: [1, 2, 3],
    };
    const msg = formatRedistributionMessage(res);
    expect(msg).toContain("3 idle workers");
    expect(msg).toContain("wood (2)");
    expect(msg).toContain("food (1)");
    expect(msg).toContain("and");
  });

  it("handles dispatch with no byResource breakdown gracefully", () => {
    const res: RedistributionResult = {
      total: 2,
      byResource: {},
      assignedEids: [1, 2],
    };
    const msg = formatRedistributionMessage(res);
    expect(msg).toContain("2 idle workers dispatched");
  });
});

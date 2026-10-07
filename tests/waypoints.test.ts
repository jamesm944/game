/**
 * Waypoint Queuing & Command Chaining tests — W1 (Issue #132 / Epic #131).
 *
 * Tests:
 * 1. Sequential Move Queuing:
 *    - Shift-move appends multiple MoveActivities in FIFO order.
 *    - Unit executes the first leg to completion, then seamlessly cascades into the next leg.
 * 2. Three-Leg Chained Route:
 *    - (4.5, 4.5) -> (8.5, 4.5) -> (8.5, 8.5) -> (4.5, 8.5).
 *    - All legs executed in sequence; unit settles at final waypoint.
 * 3. Queue Flushing on Non-Shift Order:
 *    - An in-flight chained route is immediately flushed when a non-shift move is issued.
 * 4. Move -> Gather Chaining:
 *    - Villager shift-moves to waypoint, then shift-gathers from a resource node.
 * 5. Move -> Build Chaining:
 *    - Villager shift-moves to waypoint, then shift-builds at a construction site.
 * 6. Move -> Patrol Chaining:
 *    - Combat unit shift-moves to waypoint, then shift-patrols between two points.
 * 7. Waypoint Chain Extraction:
 *    - extractWaypointChain extracts world coordinates and updates as unit advances.
 * 8. Deterministic Simulation:
 *    - Multiple runs with identical seeds produce byte-identical positions.
 *
 * PATH_LATENCY = 2: a groupMove command targets T+1; the path request is
 * issued during tick T+1 processing and applies at T+1+2 = T+3. Therefore
 * 3 step() calls are needed before the MoveActivity appears in the queue.
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
  spawnUnit,
  spawnBuildingSite,
  getPosition,
  readActivityQueue,
  spawnResourceNode,
  type SimComponents,
} from "../src/sim/components";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import { createGatherSystem } from "../src/sim/systems/gather";
import { createConstructionSystem } from "../src/sim/systems/construction";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import {
  issueGroupMove,
  issueGather,
  issueBuild,
  issuePatrol,
} from "../src/ui/orders";
import { createCombatSystem } from "../src/sim/systems/combat";
import {
  extractWaypointChain,
  getLastQueuedDestination,
} from "../src/sim/activities";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  createDropOffPoint,
} from "../src/sim/core/stockpile";
import { RESOURCE_WOOD } from "../src/sim/components/economy";

installSimPurityShims();

// PATH_LATENCY = 2: command targets T+1, path applies at T+3.
const STEPS_TO_APPLY_PATH = 3;

function createTestWorld(
  size = 32,
  seed = 20261001,
): {
  world: World;
  comps: SimComponents;
  paths: PathScheduler;
} {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const layers = buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
  const world = createWorld(seed, { layers, size, pathScheduler: paths });
  const comps = defineSimComponents(world);
  return { world, comps, paths };
}

function runTicks(world: World, count: number): void {
  for (let i = 0; i < count; i++) {
    step(world);
  }
}

describe("W1: Waypoint Queuing & Command Chaining", () => {
  it("appends shift-move commands sequentially and cascades through legs", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    const unitEid = spawnUnit(world, comps, 4.5, 4.5);

    // Initial move: (8.5, 4.5). Command targets tick 1; path applies at tick 3.
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 4.5);
    runTicks(world, STEPS_TO_APPLY_PATH);

    let queue = readActivityQueue(world, comps, unitEid);
    expect(queue.length).toBe(1);
    expect(queue[0]!.kind).toBe("move");

    // Shift-move: (8.5, 8.5) while first leg is executing.
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 8.5, true);
    runTicks(world, STEPS_TO_APPLY_PATH);

    queue = readActivityQueue(world, comps, unitEid);
    expect(queue.length).toBe(2);
    expect(queue[0]!.kind).toBe("move");
    expect(queue[1]!.kind).toBe("move");

    // Run until unit reaches near first waypoint (4 tiles at ~1 tile/s ~= 120 ticks)
    runTicks(world, 130);

    const midPos = getPosition(world, comps, unitEid)!;
    expect(midPos.x).toBeGreaterThan(7.5);

    // Run until unit completes second leg
    runTicks(world, 150);

    const finalPos = getPosition(world, comps, unitEid)!;
    expect(Math.abs(finalPos.x - 8.5)).toBeLessThan(0.5);
    expect(Math.abs(finalPos.y - 8.5)).toBeLessThan(0.5);

    // Queue should now be empty
    queue = readActivityQueue(world, comps, unitEid);
    expect(queue.length).toBe(0);
  });

  it("executes a 3-leg chained route in sequence and comes to a full stop", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    const unitEid = spawnUnit(world, comps, 4.5, 4.5);

    // Issue legs one per tick so each queued path resolves in order.
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 4.5);
    step(world); // tick 1: leg-1 command drained, path requested
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 8.5, true);
    step(world); // tick 2: leg-2 command drained
    issueGroupMove(world.inbox, world.tick, [unitEid], 4.5, 8.5, true);
    step(world); // tick 3: leg-3 command drained; leg-1 path applies NOW
    step(world); // tick 4: leg-2 path applies
    step(world); // tick 5: leg-3 path applies

    const queue = readActivityQueue(world, comps, unitEid);
    expect(queue.length).toBe(3);

    // ~12 tiles total; add generous margin for path planning
    runTicks(world, 550);

    const pos = getPosition(world, comps, unitEid)!;
    expect(Math.abs(pos.x - 4.5)).toBeLessThan(0.5);
    expect(Math.abs(pos.y - 8.5)).toBeLessThan(0.5);

    const finalQueue = readActivityQueue(world, comps, unitEid);
    expect(finalQueue.length).toBe(0);
  });

  it("flushes queued waypoints immediately on a non-shift move order", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    const unitEid = spawnUnit(world, comps, 4.5, 4.5);

    issueGroupMove(world.inbox, world.tick, [unitEid], 12.5, 4.5);
    issueGroupMove(world.inbox, world.tick, [unitEid], 12.5, 12.5, true);
    issueGroupMove(world.inbox, world.tick, [unitEid], 4.5, 12.5, true);

    // Let all 3 path requests settle (issued on 3 consecutive ticks, all done by tick 7)
    runTicks(world, 7);

    expect(readActivityQueue(world, comps, unitEid).length).toBe(3);

    // Unit starts walking
    runTicks(world, 30);

    // Non-shift order override: redirect to (2.5, 2.5) — flushes prior queue
    issueGroupMove(world.inbox, world.tick, [unitEid], 2.5, 2.5, false);
    runTicks(world, STEPS_TO_APPLY_PATH);

    const flushedQueue = readActivityQueue(world, comps, unitEid);
    expect(flushedQueue.length).toBe(1);

    runTicks(world, 200);

    const pos = getPosition(world, comps, unitEid)!;
    expect(Math.abs(pos.x - 2.5)).toBeLessThan(0.5);
    expect(Math.abs(pos.y - 2.5)).toBeLessThan(0.5);
  });

  it("chains move waypoint then resource gathering", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));
    registerSystem(world, createGatherSystem(comps, paths));

    createPlayerStockpile(world, comps, PLAYER_ONE);
    createDropOffPoint(world, comps, 4.5, 4.5, PLAYER_ONE);

    const workerEid = spawnUnit(world, comps, 4.5, 4.5, {
      ownerId: PLAYER_ONE,
    });

    // Tree node at tile (12, 4) -> world centre (12.5, 4.5)
    const treeEid = spawnResourceNode(world, comps, 12, 4, RESOURCE_WOOD, 500);

    // Move to intermediate waypoint first, then queue gather
    issueGroupMove(world.inbox, world.tick, [workerEid], 8.5, 4.5);
    issueGather(world.inbox, world.tick, [workerEid], treeEid, true);

    runTicks(world, 6);

    // Unit is en route to (8.5, 4.5)
    runTicks(world, 60);
    const midPos = getPosition(world, comps, workerEid)!;
    expect(midPos.x).toBeGreaterThan(5.5);
    expect(midPos.x).toBeLessThan(8.8);

    // Continue: worker reaches waypoint then proceeds to tree slot
    runTicks(world, 250);

    const finalPos = getPosition(world, comps, workerEid)!;
    const distToTree = Math.hypot(finalPos.x - 12.5, finalPos.y - 4.5);
    expect(distToTree).toBeLessThan(2.5);
  });

  it("chains move waypoint then construction", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));
    registerSystem(world, createConstructionSystem(comps));

    createPlayerStockpile(world, comps, PLAYER_ONE);

    const builderEid = spawnUnit(world, comps, 4.5, 4.5, {
      ownerId: PLAYER_ONE,
    });
    const siteEid = spawnBuildingSite(world, comps, "house", 14, 4, {
      playerId: PLAYER_ONE,
    });

    issueGroupMove(world.inbox, world.tick, [builderEid], 8.5, 4.5);
    issueBuild(world.inbox, world.tick, [builderEid], siteEid, true);

    runTicks(world, 6);
    runTicks(world, 450);

    const pos = getPosition(world, comps, builderEid)!;
    const distToSite = Math.hypot(pos.x - 14.5, pos.y - 4.5);
    expect(distToSite).toBeLessThan(3.0);
  });

  it("chains move waypoint then patrol", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));
    // createCombatSystem handles the "patrol" command kind
    registerSystem(world, createCombatSystem(comps, undefined, paths));

    const unitEid = spawnUnit(world, comps, 4.5, 4.5);

    // Move to (8.5, 4.5), wait for path to apply
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 4.5);
    runTicks(world, STEPS_TO_APPLY_PATH);

    // Queue patrol between (8.5, 4.5) and (12.5, 4.5)
    issuePatrol(
      world.inbox,
      world.tick,
      [unitEid],
      [
        { x: 8.5, y: 4.5 },
        { x: 12.5, y: 4.5 },
      ],
      true,
    );
    step(world); // consume patrol command

    const q = readActivityQueue(world, comps, unitEid);
    expect(q.length).toBe(2);
    expect(q[0]!.kind).toBe("move");
    expect(q[1]!.kind).toBe("patrol");

    // Run until move completes (~130 ticks) and patrol begins
    runTicks(world, 200);

    const currentQ = readActivityQueue(world, comps, unitEid);
    expect(currentQ[0]!.kind).toBe("patrol");
  });

  it("extracts sequenced waypoint chain and updates dynamically", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    const unitEid = spawnUnit(world, comps, 4.5, 4.5);

    // When idle, extractWaypointChain returns empty array
    let chain = extractWaypointChain(
      4.5,
      4.5,
      readActivityQueue(world, comps, unitEid),
    );
    expect(chain).toEqual([]);

    // Queue 2 legs, one per tick so paths apply in order
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 4.5);
    step(world); // tick 1
    issueGroupMove(world.inbox, world.tick, [unitEid], 8.5, 8.5, true);
    step(world); // tick 2
    step(world); // tick 3: leg-1 path applies
    step(world); // tick 4: leg-2 path applies

    chain = extractWaypointChain(
      4.5,
      4.5,
      readActivityQueue(world, comps, unitEid),
    );
    expect(chain.length).toBeGreaterThanOrEqual(3);
    expect(chain[0]).toEqual({ x: 4.5, y: 4.5 });
    // Final destination should match last queued waypoint (8.5, 8.5)
    const last = chain[chain.length - 1]!;
    expect(Math.abs(last.x - 8.5)).toBeLessThan(0.1);
    expect(Math.abs(last.y - 8.5)).toBeLessThan(0.1);

    // getLastQueuedDestination correctly retrieves the destination
    const lastDest = getLastQueuedDestination(
      readActivityQueue(world, comps, unitEid),
      4.5,
      4.5,
    );
    expect(lastDest.x).toBe(8.5);
    expect(lastDest.y).toBe(8.5);
  });

  it("is 100% deterministic across multiple runs", () => {
    function runSimulation(): { x: number; y: number } {
      const { world, comps, paths } = createTestWorld(32, 12345);
      registerSystem(world, createMovementSystem(comps, paths));

      const u1 = spawnUnit(world, comps, 4.5, 4.5);
      const u2 = spawnUnit(world, comps, 5.5, 4.5);

      issueGroupMove(world.inbox, world.tick, [u1, u2], 10.5, 4.5);
      issueGroupMove(world.inbox, world.tick, [u1, u2], 10.5, 10.5, true);

      runTicks(world, 300);

      const p1 = getPosition(world, comps, u1)!;
      return { x: p1.x, y: p1.y };
    }

    const run1 = runSimulation();
    const run2 = runSimulation();
    expect(run1.x).toBe(run2.x);
    expect(run1.y).toBe(run2.y);
  });
});

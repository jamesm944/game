/**
 * Pop needs system — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Pins the meter machine end to end:
 *   - rare staggered decay, hash-offset per entity (two Pops drain on
 *     different ticks; nothing decays between rare ticks);
 *   - starvation is observable in digests: an unfed village's food and
 *     morale meters land exactly on zero and the world digest moves
 *     with them (the Needs rows ARE the observable state);
 *   - eating debits the depot owner's ledger by exactly EAT_FOOD_COST
 *     and restores the meters;
 *   - emergency hunger interrupts a live work chain mid-flight;
 *   - exhaustion slows work measurably (tired novice outgathered by a
 *     rested twin), while rowless legacy Pops multiply by exactly 1.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readNeeds,
  setNeedLevels,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { RESOURCE_WOOD } from "../src/sim/components/economy";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../src/sim/systems/gather";
import {
  EAT_FOOD_COST,
  EMERGENCY_FOOD_LEVEL,
  createNeedsSystem,
  restWorkMultiplierOf,
} from "../src/sim/systems/needs";
import { NEEDS_TICK_INTERVAL } from "../src/sim/components/needs";
import { resolveGatherInterval } from "../src/sim/systems/skills";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 24;

interface Scenario {
  readonly world: ReturnType<typeof createWorld>;
  readonly comps: SimComponents;
  readonly gather?: ReturnType<typeof createGatherDiagnostics>;
}

function openWorld(
  seed: number,
  opts: {
    readonly withGather?: boolean | undefined;
    readonly startingFood?: number | undefined;
  } = {},
): Scenario {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  if (opts.withGather === true) {
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(
      world,
      createGatherSystem(comps, scheduler, createGatherDiagnostics()),
    );
  }
  registerSystem(world, createNeedsSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE, [
    opts.startingFood ?? 0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return { world, comps };
}

function spawnNamedPop(scenario: Scenario, x: number, y: number): number {
  return spawnUnit(scenario.world, scenario.comps, x, y, { identity: true });
}

installSimPurityShims();

describe("needs decay", () => {
  it("decays only on each entity's hash-offset rare tick", () => {
    const { world, comps } = openWorld(20260824);
    const first = spawnNamedPop({ world, comps }, 8.5, 8.5);
    const second = spawnNamedPop({ world, comps }, 10.5, 8.5);

    // Step until one meter has moved: the FIRST rare tick due among
    // the two eids lands somewhere inside one full interval.
    let movedTick = -1;
    while (world.tick < NEEDS_TICK_INTERVAL * 2) {
      step(world);
      const a = readNeeds(world, comps, first)!;
      const b = readNeeds(world, comps, second)!;
      if (a.food < 100 || b.food < 100) {
        movedTick = world.tick;
        break;
      }
    }
    expect(movedTick).toBeGreaterThan(0);
    // Exactly the hash-offset boundary: (tick + eid) % interval === 0.
    const mover = readNeeds(world, comps, first)!.food < 100 ? first : second;
    const frozen = mover === first ? second : first;
    expect((movedTick + mover) % NEEDS_TICK_INTERVAL).toBe(0);
    // The neighbor's offset differs, so it has not decayed yet.
    expect((movedTick + frozen) % NEEDS_TICK_INTERVAL).not.toBe(0);
    expect(readNeeds(world, comps, frozen)!.food).toBe(100);
  });

  it("starvation and morale-zero are observable in the digest", () => {
    const { world, comps } = openWorld(20260824);
    createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
    const eid = spawnNamedPop({ world, comps }, 12.5, 12.5);

    // The meters are hashed state: the pre-starvation digest can never
    // come back once food and morale have bottomed out.
    const healthyDigest = computeWorldDigest(world);
    let sawStarving = false;
    let sawMoraleZero = false;
    while (world.tick < 34_000) {
      step(world);
      const needs = readNeeds(world, comps, eid)!;
      if (needs.food === 0) sawStarving = true;
      if (needs.morale === 0) {
        sawMoraleZero = true;
        break;
      }
    }
    expect(sawStarving).toBe(true);
    expect(sawMoraleZero).toBe(true);
    expect(readNeeds(world, comps, eid)!.food).toBe(0);
    expect(computeWorldDigest(world)).not.toBe(healthyDigest);
  });
});

describe("eating from the stockpile", () => {
  it("walks to the nearest payable depot, debits a meal, restores meters", () => {
    const { world, comps } = openWorld(20260825, {
      withGather: true,
      startingFood: 50,
    });
    createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
    const eid = spawnNamedPop({ world, comps }, 10.5, 6.5);
    setNeedLevels(world, comps, eid, { food: 40, rest: 80, morale: 60 });

    let eaten = false;
    while (world.tick < 1200) {
      step(world);
      const needs = readNeeds(world, comps, eid)!;
      if (needs.food > 40) {
        eaten = true;
        break;
      }
    }
    expect(eaten).toBe(true);
    // Exactly one meal's worth left the owner's ledger.
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[0]).toBe(
      50 - EAT_FOOD_COST,
    );
    // Meters restored (clamped at the ceiling for food).
    const needs = readNeeds(world, comps, eid)!;
    expect(needs.food).toBe(100);
    expect(needs.rest).toBe(100);
    expect(needs.morale).toBeGreaterThanOrEqual(60);
    // The eat head itself is consumed once the meal lands.
    const queueRow = world.rowsByComponentId
      .get(comps.activityQueueId)!
      .get(eid)!;
    expect(queueRow[0]).toBe(0);
  });

  it("interrupts work mid-chain once food hits the emergency level", () => {
    const { world, comps, gather } = openWorld(20260826, {
      withGather: true,
      startingFood: 50,
    });
    createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
    const nodeId = spawnResourceNode(world, comps, 16, 16, RESOURCE_WOOD, 500);
    const eid = spawnNamedPop({ world, comps }, 15.5, 15.5);
    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [eid], nodeId },
    });

    // Employed first…
    step(world);
    step(world);
    expect(world.rowsByComponentId.get(comps.assignedNodeId)?.has(eid)).toBe(
      true,
    );

    // …then hunger strikes at the emergency level: the very next tick
    // drops every job row and queues the eat chain instead.
    setNeedLevels(world, comps, eid, {
      food: EMERGENCY_FOOD_LEVEL,
      rest: 90,
      morale: 90,
    });
    step(world);
    expect(
      world.rowsByComponentId.get(comps.assignedNodeId)?.has(eid) ?? false,
    ).toBe(false);
    const queueRow = world.rowsByComponentId
      .get(comps.activityQueueId)!
      .get(eid)!;
    expect(queueRow[0]).toBeGreaterThan(0); // [Move, Eat] planned
    void gather;
  });
});

describe("rest penalty on work", () => {
  it("stretches the resolved work interval exactly as documented", () => {
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const world = createWorld(20260829, {
      size: SIZE,
      layers: buildLayers(
        new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
        new Uint8Array(SIZE * SIZE),
      ),
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE);
    const rested = spawnUnit(world, comps, 5.5, 5.5, { identity: true });
    const exhausted = spawnUnit(world, comps, 6.5, 5.5, { identity: true });
    setNeedLevels(world, comps, exhausted, {
      food: 100,
      rest: 0,
      morale: 100,
    });

    // Novice twins, only the rest meter differs: 30 ticks per unit
    // rested versus the M3-T6-deprived floor exhausted — rest 0 sits
    // below DEPRIVED_REST_LEVEL, so the 0.75× M3-T3 rest slope stacks
    // with the 0.75× deprivation multiplier (30 / 0.5625 ≈ 53).
    expect(resolveGatherInterval(world, comps, rested, 30)).toBe(30);
    expect(resolveGatherInterval(world, comps, exhausted, 30)).toBe(53);
  });

  it("an exhausted gatherer measurably underperforms a rested twin", () => {
    const runGather = (restLevel: number): number => {
      const scheduler = new PathScheduler(createSynchronousPathTransport());
      const world = createWorld(20260827, {
        size: SIZE,
        layers: buildLayers(
          new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
          new Uint8Array(SIZE * SIZE),
        ),
        pathScheduler: scheduler,
      });
      const comps = defineSimComponents(world);
      const diagnostics = createGatherDiagnostics();
      registerSystem(world, createMovementSystem(comps, scheduler));
      registerSystem(world, createGatherSystem(comps, scheduler, diagnostics));
      registerSystem(world, createNeedsSystem(comps));
      createPlayerStockpile(world, comps, PLAYER_ONE);
      createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
      const nodeId = spawnResourceNode(world, comps, 9, 9, RESOURCE_WOOD, 400);
      const eid = spawnUnit(world, comps, 8.5, 7.5, { identity: true });
      if (restLevel < 100) {
        setNeedLevels(world, comps, eid, {
          food: 100,
          rest: restLevel,
          morale: 100,
        });
      }
      world.inbox.submit({
        kind: "gather",
        targetTick: 1,
        data: { entityIds: [eid], nodeId },
      });
      while (world.tick < 1500) step(world);
      return diagnostics.extractedByResource[RESOURCE_WOOD]!;
    };

    const rested = runGather(100);
    const exhausted = runGather(0);
    // Same seed, same node, same novice sheet — only the rest meter
    // differs, and the rested twin brings home strictly more.
    expect(rested).toBeGreaterThan(exhausted);
  });

  it("rowless legacy Pops multiply by exactly 1 everywhere", () => {
    const { world, comps } = openWorld(20260828);
    const legacy = spawnUnit(world, comps, 5.5, 5.5); // no identity branch
    expect(restWorkMultiplierOf(world, comps, legacy)).toBe(1);
    expect(resolveGatherInterval(world, comps, legacy, 30)).toBe(30);
  });
});

/**
 * Delegated management — SPEC §2.7 / M4-T1 (issue #56).
 *
 * Pins the §2.7 acceptance criteria end to end:
 *   - SATURATION: a foreman keeps its workplace's slots filled from
 *     the idle pool without any player input, refills after a vacancy,
 *     and the same workplace decays to zero crafters without one;
 *   - EXHAUSTION ROTATION: a drained worker swaps off the line only
 *     once a rested replacement is secured;
 *   - SLIDERS: a strategy-weight shift measurably reallocates workers
 *     across a domain's workplaces well inside one canonical day
 *     (over-weighted workplaces may hold an overflow bench — the
 *     production system's slot −1);
 *   - OVERRIDE: direct orders win instantly, carry an OrderLock that
 *     outlives delegation pressure, and release the moment the ordered
 *     activity completes;
 *   - RATING & XP: candidates rank by Organization traits + craft +
 *     Management skill, and service grows that skill on the job.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  setNeedLevels,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  clearProductionJob,
  getProductionJob,
} from "../src/sim/components/production";
import {
  MANAGEMENT_SKILL_ARITY,
  foremanRowOf,
  managementXpOf,
  managerRowOf,
  orderLockOf,
} from "../src/sim/components/management";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
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
  createProductionDiagnostics,
  createProductionSystem,
} from "../src/sim/systems/production";
import { createNeedsSystem } from "../src/sim/systems/needs";
import {
  createManagementDiagnostics,
  createManagementSystem,
  managementCandidatesOf,
  managementRatingOf,
  type ManagementDiagnostics,
} from "../src/sim/systems/management";
import { awardPractice } from "../src/sim/systems/skills";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 32;
/** One canonical §2.4 day — the reallocation deadline. */
const DAY_TICKS = 14_400;

interface Scenario {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diag: ManagementDiagnostics;
}

function openManagementWorld(seed: number): Scenario {
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
  const diag = createManagementDiagnostics();
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, createGatherDiagnostics()),
  );
  registerSystem(
    world,
    createProductionSystem(
      comps,
      createProductionDiagnostics(),
      // Golden-free fixture: unlock every recipe line regardless of age.
      { isRecipeUnlocked: () => true },
    ),
  );
  registerSystem(world, createNeedsSystem(comps));
  // Registered last: after every labor system, per its contract.
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE], diagnostics: diag }),
  );
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [400, 400, 100, 0, 50, 50, 0],
  );
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(world, comps, 8.5, 8.5, PLAYER_ONE);
  return { world, comps, diag };
}

const villager = (scene: Scenario, x: number, y: number): number =>
  spawnUnit(scene.world, scene.comps, x, y, { identity: true });

function kitchen(scene: Scenario, tileX: number, tileY: number): number {
  return stampFinishedBuilding(
    scene.world,
    scene.comps,
    "kitchen",
    tileX,
    tileY,
    { playerId: PLAYER_ONE },
  );
}

function submit(
  scene: Scenario,
  kind: string,
  data: Record<string, unknown>,
): void {
  scene.world.inbox.submit({
    kind,
    targetTick: scene.world.tick + 1,
    data,
  });
}

/** Crafter eids (ascending) currently holding a job at `buildingEid`. */
function craftersAt(scene: Scenario, buildingEid: number): number[] {
  const rows = scene.world.rowsByComponentId.get(scene.comps.productionJobId)!;
  return [...rows.entries()]
    .filter(([, row]) => row[0] === buildingEid)
    .map(([eid]) => eid)
    .sort((a, b) => a - b);
}

function runFor(scene: Scenario, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(scene.world);
}

installSimPurityShims();

describe("foreman saturation", () => {
  it("keeps the workplace full without any player input", () => {
    const scene = openManagementWorld(20260901);
    const work = kitchen(scene, 14, 6);
    const boss = villager(scene, 13.5, 8.5);
    villager(scene, 14.5, 8.5);
    villager(scene, 15.5, 9.5);

    submit(scene, "appointForeman", { buildingEid: work, popId: boss });
    runFor(scene, 120);

    // Exactly ONE seat (kitchen workSlots = 1) and someone sits in it.
    expect(craftersAt(scene, work).length).toBe(1);
    expect(scene.diag.fills).toBeGreaterThanOrEqual(1);
    expect(managerRowOf(scene.world, scene.comps, boss)).toBeUndefined();

    // Vacancy → refill: fire the crafter outright, the foreman re-hires.
    const fired = craftersAt(scene, work)[0]!;
    clearProductionJob(scene.world, scene.comps, fired);
    runFor(scene, 120);
    expect(craftersAt(scene, work).length).toBe(1);
    expect(scene.diag.fills).toBeGreaterThanOrEqual(2);
  });

  it("lets an unmanaged workplace decay to zero crafters", () => {
    const scene = openManagementWorld(20260902);
    const work = kitchen(scene, 14, 6);
    villager(scene, 13.5, 8.5);
    villager(scene, 14.5, 8.5);

    runFor(scene, 240);

    // No foreman and no brain in this fixture: nothing ever staffs it.
    expect(craftersAt(scene, work)).toEqual([]);
    expect(foremanRowOf(scene.world, scene.comps, work)).toBeUndefined();
  });

  it("rotates an exhausted worker once a rested replacement exists", () => {
    const scene = openManagementWorld(20260903);
    const work = kitchen(scene, 14, 6);
    const boss = villager(scene, 13.5, 8.5);
    const tired = villager(scene, 14.5, 8.5);
    const rested = villager(scene, 15.5, 9.5);

    // Stage the tired worker straight onto the line (delegated shape:
    // no direct-order lock), drain their rest meter, hand over the office.
    submit(scene, "produce", {
      entityIds: [tired],
      buildingEid: work,
      delegated: true,
    });
    runFor(scene, 2);
    setNeedLevels(scene.world, scene.comps, tired, {
      food: 100,
      rest: 5,
      morale: 100,
    });
    submit(scene, "appointForeman", { buildingEid: work, popId: boss });
    runFor(scene, 120);

    expect(scene.diag.rotations).toBeGreaterThanOrEqual(1);
    expect(craftersAt(scene, work)).toEqual([rested]);
    expect(getProductionJob(scene.world, scene.comps, tired)).toBeUndefined();
  });
});

describe("strategy sliders", () => {
  it("reallocates workers across the domain within a day", () => {
    const scene = openManagementWorld(20260904);
    const kitchenA = kitchen(scene, 11, 6);
    const kitchenB = kitchen(scene, 17, 6);
    const manager = villager(scene, 14.5, 4.5);
    villager(scene, 12.5, 8.5);
    villager(scene, 16.5, 8.5);

    submit(scene, "appointManager", { popId: manager, domain: 0 /* food */ });
    runFor(scene, 120);
    // Equal defaults: one crafter per kitchen.
    expect(craftersAt(scene, kitchenA).length).toBe(1);
    expect(craftersAt(scene, kitchenB).length).toBe(1);

    // Shift the brief 3:1 toward kitchen A: both workers consolidate
    // onto A (the second holds the production system's overflow slot).
    submit(scene, "setStrategy", { domain: 0, weights: [3, 1] });
    runFor(scene, 240);

    expect(craftersAt(scene, kitchenA).length).toBe(2);
    expect(craftersAt(scene, kitchenB).length).toBe(0);
    expect(scene.diag.redistributions).toBeGreaterThanOrEqual(1);

    // And the whole dance finished far inside one canonical day.
    expect(scene.world.tick).toBeLessThan(DAY_TICKS);
  });

  it("never redistributes a directly-ordered worker", () => {
    const scene = openManagementWorld(20260905);
    const kitchenA = kitchen(scene, 11, 6);
    const kitchenB = kitchen(scene, 17, 6);
    const manager = villager(scene, 14.5, 4.5);
    const w1 = villager(scene, 12.5, 8.5);
    const w2 = villager(scene, 16.5, 8.5);

    submit(scene, "appointManager", { popId: manager, domain: 0 });
    runFor(scene, 120);
    expect(craftersAt(scene, kitchenA)).toEqual([w1]);
    expect(craftersAt(scene, kitchenB)).toEqual([w2]);

    // DIRECT order: the player pulls w1 to kitchen B themselves. It
    // lands the very next boundary and stamps an OrderLock.
    submit(scene, "produce", { entityIds: [w1], buildingEid: kitchenB });
    runFor(scene, 2);
    expect(getProductionJob(scene.world, scene.comps, w1)?.buildingEid).toBe(
      kitchenB,
    );
    expect(orderLockOf(scene.world, scene.comps, w1)).toBeDefined();

    // Now beg the manager to stack food onto A: the unlocked w2 moves,
    // the locked w1 NEVER does — delegation cannot touch direct orders.
    submit(scene, "setStrategy", { domain: 0, weights: [3, 1] });
    runFor(scene, 240);
    expect(craftersAt(scene, kitchenA)).toEqual([w2]);
    expect(getProductionJob(scene.world, scene.comps, w1)?.buildingEid).toBe(
      kitchenB,
    );
    expect(orderLockOf(scene.world, scene.comps, w1)).toBeDefined();
  });
});

describe("override rule", () => {
  it("wins instantly against a saturated foreman and holds", () => {
    const scene = openManagementWorld(20260906);
    const kitchenA = kitchen(scene, 11, 6);
    const kitchenB = kitchen(scene, 17, 6);
    const boss = villager(scene, 10.5, 8.5);
    const w1 = villager(scene, 12.5, 8.5);
    const spare = villager(scene, 13.5, 9.5);

    submit(scene, "appointForeman", { buildingEid: kitchenA, popId: boss });
    runFor(scene, 120);
    expect(craftersAt(scene, kitchenA)).toEqual([w1]);

    // DIRECT order mid-production: w1 walks off to kitchen B this tick.
    submit(scene, "produce", { entityIds: [w1], buildingEid: kitchenB });
    runFor(scene, 2);
    expect(getProductionJob(scene.world, scene.comps, w1)?.buildingEid).toBe(
      kitchenB,
    );

    // The foreman backfills A with the spare — but w1 stays put for
    // hundreds of ticks of continued delegation pressure.
    runFor(scene, 300);
    expect(getProductionJob(scene.world, scene.comps, w1)?.buildingEid).toBe(
      kitchenB,
    );
    expect(orderLockOf(scene.world, scene.comps, w1)).toBeDefined();
    expect(craftersAt(scene, kitchenA)).toEqual([spare]);
  });

  it("releases the lock the moment the ordered activity ends", () => {
    const scene = openManagementWorld(20260907);
    const work = kitchen(scene, 14, 6);
    const boss = villager(scene, 13.5, 8.5);
    const helper = villager(scene, 14.5, 8.5);
    const wanderer = villager(scene, 24.5, 24.5);

    submit(scene, "appointForeman", { buildingEid: work, popId: boss });
    runFor(scene, 120);
    expect(craftersAt(scene, work)).toEqual([helper]);

    // Transit order: march away. While moving, the Pop is locked out
    // of every delegation decision.
    submit(scene, "groupMove", { entityIds: [wanderer], x: 26.5, y: 26.5 });
    runFor(scene, 2);
    expect(orderLockOf(scene.world, scene.comps, wanderer)).toBeDefined();

    runFor(scene, 240);
    // Arrival emptied the queue → lock released…
    expect(orderLockOf(scene.world, scene.comps, wanderer)).toBeUndefined();
    expect(scene.diag.locksReleased).toBeGreaterThanOrEqual(1);

    // …and the released Pop is back in the delegable pool: fire the
    // line worker and the foreman re-staffs from the pool.
    clearProductionJob(scene.world, scene.comps, helper);
    runFor(scene, 120);
    expect(craftersAt(scene, work).length).toBe(1);
    expect(scene.diag.fills).toBeGreaterThanOrEqual(2);
  });
});

describe("appointments", () => {
  it("validates eligibility loudly", () => {
    const scene = openManagementWorld(20260908);
    const work = kitchen(scene, 14, 6);
    const outsider = spawnUnit(scene.world, scene.comps, 20.5, 20.5, {
      identity: true,
      ownerId: 1,
    });
    const local = villager(scene, 14.5, 8.5);

    // Commands validate when the system consumes them on the boundary.
    submit(scene, "appointForeman", { buildingEid: work, popId: outsider });
    expect(() => step(scene.world)).toThrow(/not served/);

    submit(scene, "appointForeman", { buildingEid: 999999, popId: local });
    expect(() => step(scene.world)).toThrow(/no finished Building row/);

    // …and non-workplaces refuse the office outright.
    const house = stampFinishedBuilding(
      scene.world,
      scene.comps,
      "house",
      22,
      10,
      { playerId: PLAYER_ONE },
    );
    submit(scene, "appointForeman", { buildingEid: house, popId: local });
    expect(() => step(scene.world)).toThrow(/not a workplace/);
    void local;
  });

  it("ranks candidates by craft skill with traits held equal", () => {
    const scene = openManagementWorld(20260909);
    kitchen(scene, 14, 6);
    const novice = villager(scene, 13.5, 8.5);
    const journeyman = villager(scene, 14.5, 8.5);
    // Hold the Organization-trait term at zero for both (empty trait
    // rows, the same digest-visible state traitless fixtures use) so
    // the ranking isolates the craft-skill term.
    scene.world.rowsByComponentId.get(scene.comps.traitsId)!.set(novice, []);
    scene.world.rowsByComponentId
      .get(scene.comps.traitsId)!
      .set(journeyman, []);
    awardPractice(scene.world, scene.comps, journeyman, "gathering", 1500);

    const ranked = managementCandidatesOf(
      scene.world,
      scene.comps,
      PLAYER_ONE,
      0,
    ).map((candidate) => candidate.popEid);
    expect(ranked.indexOf(journeyman)).toBeLessThan(ranked.indexOf(novice));
    expect(
      managementRatingOf(scene.world, scene.comps, journeyman, 0),
    ).toBeCloseTo(
      managementRatingOf(scene.world, scene.comps, novice, 0) + 0.8,
      5,
    );
  });

  it("grows management skill XP while serving, and only while serving", () => {
    const scene = openManagementWorld(20260910);
    const work = kitchen(scene, 14, 6);
    const boss = villager(scene, 13.5, 8.5);
    villager(scene, 14.5, 8.5);

    expect(managementXpOf(scene.world, scene.comps, boss)).toBeUndefined();
    submit(scene, "appointForeman", { buildingEid: work, popId: boss });
    runFor(scene, 90); // ≥ 2 staggered thinks

    // Two serving passes at ≥2 XP each.
    const xp = managementXpOf(scene.world, scene.comps, boss);
    expect(xp).toBeGreaterThanOrEqual(4);
    expect(
      scene.world.rowsByComponentId
        .get(scene.comps.managementSkillId)
        ?.get(boss)?.length,
    ).toBe(MANAGEMENT_SKILL_ARITY);

    // Dismissal is instant; XP freezes the moment service ends.
    submit(scene, "dismissForeman", { buildingEid: work });
    runFor(scene, 2);
    expect(foremanRowOf(scene.world, scene.comps, work)).toBeUndefined();
    const frozen = managementXpOf(scene.world, scene.comps, boss);
    runFor(scene, 90);
    expect(managementXpOf(scene.world, scene.comps, boss)).toBe(frozen);
  });

  it("enforces one manager per domain by dismissing the incumbent", () => {
    const scene = openManagementWorld(20260912);
    const first = villager(scene, 12.5, 4.5);
    const second = villager(scene, 16.5, 4.5);

    submit(scene, "appointManager", { popId: first, domain: 0 });
    runFor(scene, 2);
    expect(managerRowOf(scene.world, scene.comps, first)?.domain).toBe(0);

    submit(scene, "appointManager", { popId: second, domain: 0 });
    runFor(scene, 2);
    expect(managerRowOf(scene.world, scene.comps, first)).toBeUndefined();
    expect(managerRowOf(scene.world, scene.comps, second)?.domain).toBe(0);
    expect(scene.diag.dismissals).toBeGreaterThanOrEqual(1);
  });
});

describe("digest seam", () => {
  it("never attaches management rows implicitly", () => {
    const scene = openManagementWorld(20260913);
    const nodeId = spawnResourceNode(scene.world, scene.comps, 20, 20, 0, 500);
    const worker = villager(scene, 19.5, 19.5);
    submit(scene, "gather", { entityIds: [worker], nodeId });
    runFor(scene, 120);

    // Even a busy direct-order world carries no rows unless the §2.7
    // layer is actually used — legacy digests stay byte-identical.
    expect(
      scene.world.rowsByComponentId.get(scene.comps.foremanId)?.size ?? 0,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.managerId)?.size ?? 0,
    ).toBe(0);

    // …except OrderLock, which stamps exactly what direct orders touched.
    expect(
      scene.world.rowsByComponentId.get(scene.comps.orderLockId)?.size ?? 0,
    ).toBe(1);
  });
});

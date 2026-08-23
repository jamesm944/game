/**
 * Building damage & destruction unit fixtures — SPEC §2.5/§2.11 / M2-T7.
 *
 * Covers the pieces the golden raid exercises at tighter granularity:
 *
 *   1. the full destruction pipeline (DEATH event, rubble-state entity,
 *      tile freeing + passabilityVersion bump, attacker disengage);
 *   2. the destroy-under-friends repath storm: a mid-march corridor
 *      placement invalidates routes (bounded individual re-paths), a
 *      raid frees the tiles again, everyone lands on their slots and a
 *      double-run digest canary pins determinism across the storm;
 *   3. destroyed-camp rerouting: carriers targeting a drop-off that died
 *      mid-flight reroute to the next cheapest accepting point (or idle
 *      holding cargo — the diagnostic case);
 *   4. construction-site destruction releases builders to idle;
 *   5. the §2.11 conquest counter over live military production
 *      buildings;
 *   6. TrainQueue purge on production-building destruction.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getInventory,
  getPosition,
  getResourceNodeRow,
  readActivityQueue,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  getRubbleRow,
  readTrainQueue,
} from "../src/sim/components/buildings";
import {
  COMBAT_EVENT_DEATH,
  readCombatEvents,
} from "../src/sim/components/combat";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  despawnEntity,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createMovementDiagnostics,
  createMovementSystem,
  formationSlotOffset,
  type MovementDiagnostics,
} from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../src/sim/systems/gather";
import {
  createPlacementDiagnostics,
  createPlacementSystem,
  PLACE_BUILDING_KIND,
} from "../src/sim/systems/placement";
import { createConstructionSystem } from "../src/sim/systems/construction";
import {
  TRAIN_UNIT_KIND,
  createTrainingSystem,
} from "../src/sim/systems/training";
import {
  ATTACK_COMMAND_KIND,
  createCombatDiagnostics,
  createCombatSystem,
  type CombatDiagnostics,
} from "../src/sim/systems/combat";
import {
  militaryProductionBuildingsOf,
  militaryProductionBuildingCount,
} from "../src/sim/systems/conquest";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";

const RESOURCE_WOOD = 1;
const SIZE = 32;

interface Harness {
  world: World;
  comps: SimComponents;
  paths: PathScheduler;
  movement: MovementDiagnostics;
  gather: GatherDiagnostics;
  combat: CombatDiagnostics;
}

function harness(seed = 21): Harness {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  const movement = createMovementDiagnostics();
  registerSystem(world, createMovementSystem(comps, paths, movement));
  const gather = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, paths, gather));
  registerSystem(
    world,
    createPlacementSystem(comps, createPlacementDiagnostics()),
  );
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));
  const combat = createCombatDiagnostics();
  registerSystem(world, createCombatSystem(comps, combat, paths));
  // Player one opens with capital so gameplay placement/training
  // commands pass their escrow checks inside these fixtures.
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [2000, 2000, 2000, 2000, 0, 0, 0],
  );
  createPlayerStockpile(world, comps, 1);
  return { world, comps, paths, movement, gather, combat };
}

function steps(world: World, count: number): void {
  for (let i = 0; i < count; i++) step(world);
}

function submit(
  world: World,
  kind: string,
  targetTick: number,
  data: Readonly<Record<string, unknown>>,
): void {
  world.inbox.submit({ kind, targetTick, data });
}

/** Set a finished building's hp so the next strike destroys it. */
function primeBuildingHp(h: Harness, eid: number, hp: number): void {
  const row = getBuildingRow(h.world, h.comps, eid) as number[];
  if (!row) throw new Error(`entity ${String(eid)} is not a finished building`);
  row[4] = hp;
}

function tilePassable(h: Harness, x: number, y: number): boolean {
  return h.world.layers.derivedPassability[y * SIZE + x] === 1;
}

function everyUnitOnPassableTiles(h: Harness): boolean {
  const posRows = h.world.rowsByComponentId.get(h.comps.positionId);
  if (!posRows) return true;
  for (const eid of h.world.entities) {
    // Rubble markers have positions too but are not walkers.
    if (getRubbleRow(h.world, h.comps, eid) !== undefined) continue;
    const pos = posRows.get(eid);
    if (!pos) continue;
    if (!h.world.rowsByComponentId.get(h.comps.unitTagId)?.has(eid)) continue;
    if (!tilePassable(h, Math.floor(pos[0]!), Math.floor(pos[1]!))) {
      return false;
    }
  }
  return true;
}

installSimPurityShims();

describe("destruction pipeline (finished building)", () => {
  it("tears a killed building down through every side-effect", () => {
    const h = harness(7);
    const militia = spawnCombatUnit(h.world, h.comps, "militia", 13.8, 11.5, 1);
    const barracks = stampFinishedBuilding(
      h.world,
      h.comps,
      "barracks",
      10,
      10,
    );
    primeBuildingHp(h, barracks, 4);
    const versionBefore = h.paths.passabilityVersion;

    submit(h.world, ATTACK_COMMAND_KIND, 1, {
      attackerIds: [militia],
      targetId: barracks,
    });
    step(h.world);

    expect(h.combat.buildingsDestroyed).toBe(1);
    // DEATH event landed on the victim owner's log…
    const deaths = readCombatEvents(h.world, h.comps, PLAYER_ONE).filter(
      (event) => event.kind === COMBAT_EVENT_DEATH,
    );
    expect(deaths.map((event) => event.victimEid)).toEqual([barracks]);
    // …the Building row is gone and a rubble-state entity spawned over
    // the exact footprint on a FRESH entity id.
    expect(getBuildingRow(h.world, h.comps, barracks)).toBeUndefined();
    const rubbleEid = h.world.lastAllocatedEid;
    expect(getRubbleRow(h.world, h.comps, rubbleEid)).toEqual([10, 10, 3, 3]);
    expect(rubbleEid).toBeGreaterThan(barracks);
    // Footprint tiles are PASSABLE again and the version bumped once.
    for (let y = 10; y <= 12; y++) {
      for (let x = 10; x <= 12; x++) {
        expect(tilePassable(h, x, y)).toBe(true);
      }
    }
    expect(h.paths.passabilityVersion).toBe(versionBefore + 1);
    // The attacker dropped its engagement cleanly.
    expect(readActivityQueue(h.world, h.comps, militia)).toEqual([]);
    expect(getCombatTarget(h, militia)).toBe(0);
  });

  function getCombatTarget(h: Harness, eid: number): number {
    const row = h.world.rowsByComponentId.get(h.comps.combatId)?.get(eid);
    return row ? row[3]! : 0;
  }
});

describe("destroy-under-units repath storm (acceptance fixture)", () => {
  // Harness eids: player ledgers take 1–2; villagers march as 3–6 and
  // the raider idles as 7.
  const VILLAGERS = [3, 4, 5, 6];

  function stormSetup(): { h: Harness; house: number; militia: number } {
    const h = harness(11);
    // Four villagers march east through the soon-contested corridor…
    const starts = [14.5, 15.5, 16.5, 17.5];
    for (const y of starts) spawnUnit(h.world, h.comps, 5.5, y);
    // …a raider idles beside the future house site.
    const militia = spawnCombatUnit(h.world, h.comps, "militia", 12.8, 15, 1);

    submit(h.world, "groupMove", 1, {
      entityIds: VILLAGERS,
      x: 20.5,
      y: 15.5,
    });
    steps(h.world, 40);

    // Mid-flight corridor placement: blocks tiles UNDER live routes.
    // Gameplay placement creates a construction SITE (attackable from
    // day one, M2-T7) — the raid will tear the foundation down.
    submit(h.world, PLACE_BUILDING_KIND, 41, {
      defId: "house",
      tileX: 10,
      tileY: 14,
    });
    step(h.world);
    const house = h.world.lastAllocatedEid;
    const houseSiteRow = getBuildingSiteRow(
      h.world,
      h.comps,
      house,
    ) as number[];
    expect(houseSiteRow).toBeDefined();

    steps(h.world, 119); // villagers hit the wall and individually repath
    expect(h.movement.repaths).toBeGreaterThanOrEqual(1);
    expect(h.movement.repaths).toBeLessThanOrEqual(40);

    // The raid frees the corridor again while the detours are live.
    houseSiteRow![3] = 4; // foundation one strike from collapse
    submit(h.world, ATTACK_COMMAND_KIND, 161, {
      attackerIds: [militia],
      targetId: house,
    });
    step(h.world);
    expect(h.combat.buildingsDestroyed).toBe(1);
    return { h, house, militia };
  }

  it("frees the tiles, repaths neighbors cleanly and lands every slot", () => {
    const { h } = stormSetup();
    steps(h.world, 360);

    // Freed footprint stays passable; nobody stands on stone.
    for (let y = 14; y <= 15; y++) {
      for (let x = 10; x <= 11; x++) {
        expect(tilePassable(h, x, y)).toBe(true);
      }
    }
    expect(everyUnitOnPassableTiles(h)).toBe(true);
    // Exactly two invalidation bumps: placement blocked the corridor,
    // destruction freed it.
    expect(h.paths.passabilityVersion).toBe(2);

    // Every marcher reached its formation slot around the destination.
    // Leader = nearest the centroid (ascending-eid tie) → villager 4;
    // slots then deal in ascending-eid order behind it.
    const slotOwnerByEid = [4, 3, 5, 6];
    for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
      const eid = slotOwnerByEid[slotIndex]!;
      const offset = formationSlotOffset(slotIndex);
      const pos = getPosition(h.world, h.comps, eid);
      expect(Math.abs(pos.x - (20.5 + offset.dx))).toBeLessThan(1.0);
      expect(Math.abs(pos.y - (15.5 + offset.dy))).toBeLessThan(1.0);
    }
  });

  it("is digest-stable across the storm (double-run canary)", () => {
    const runA = stormSetup();
    steps(runA.h.world, 360);
    const digestA = computeWorldDigest(runA.h.world);

    const runB = stormSetup();
    steps(runB.h.world, 360);
    const digestB = computeWorldDigest(runB.h.world);

    expect(digestB).toBe(digestA);
  });
});

describe("destroyed camp reroutes gatherers", () => {
  function campScenario(): {
    h: Harness;
    nodeId: number;
    lumberNear: number;
    lumberFar: number;
    militia: number;
    villagers: number[];
  } {
    const h = harness(23);
    const villagers = [
      spawnUnit(h.world, h.comps, 20.5, 19.5),
      spawnUnit(h.world, h.comps, 21.5, 19.5),
    ];
    const nodeId = spawnResourceNode(
      h.world,
      h.comps,
      20,
      20,
      RESOURCE_WOOD,
      10000,
    );
    // Near camp (cheapest deposit) + far camp (the reroute target).
    const lumberNear = stampFinishedBuilding(
      h.world,
      h.comps,
      "lumber-camp",
      25,
      24,
    );
    const lumberFar = stampFinishedBuilding(
      h.world,
      h.comps,
      "lumber-camp",
      29,
      28,
    );
    const militia = spawnCombatUnit(h.world, h.comps, "militia", 27.4, 25, 1);

    submit(h.world, "gather", 1, {
      entityIds: villagers,
      nodeId,
    });
    return { h, nodeId, lumberNear, lumberFar, militia, villagers };
  }

  /**
   * Step until every villager walks a delivery chain WITH cargo toward
   * the near camp — the mid-flight window the raid must interrupt.
   * Deterministic scan (no fixed-tick guesswork); throws if the window
   * never opens.
   */
  function waitUntilCarrying(h: Harness, villagers: number[]): void {
    const carrying = (eid: number): boolean => {
      const inv = getInventory(h.world, h.comps, eid);
      const queue = readActivityQueue(h.world, h.comps, eid);
      return (
        (inv?.amount ?? 0) > 0 &&
        queue.some((activity) => activity.kind === "deliver")
      );
    };
    for (let guard = 0; guard < 2000; guard++) {
      if (villagers.every(carrying)) return;
      step(h.world);
    }
    throw new Error("fixture deadlock: carriers never took cargo");
  }

  it("carriers mid-flight reroute to the surviving accepting camp", () => {
    const { h, nodeId, lumberNear, militia, villagers } = campScenario();
    waitUntilCarrying(h, villagers);
    primeBuildingHp(h, lumberNear, 4);
    submit(h.world, ATTACK_COMMAND_KIND, h.world.tick + 1, {
      attackerIds: [militia],
      targetId: lumberNear,
    });
    step(h.world);
    expect(getBuildingRow(h.world, h.comps, lumberNear)).toBeUndefined();
    expect(
      h.world.rowsByComponentId.get(h.comps.dropoffId)?.has(lumberNear),
    ).toBe(false);

    steps(h.world, 720);
    expect(h.gather.destroyedDropoffReroutes).toBeGreaterThanOrEqual(1);
    expect(h.gather.destroyedDropoffReroutes).toBeLessThanOrEqual(4);
    // Nobody stalled holding cargo: the far camp accepts wood.
    expect(h.gather.blockedCarryTicks).toBe(0);
    // Deposits kept landing after the destruction (rerouted carriers),
    // all through the surviving drop-off rank.
    const wood = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[
      RESOURCE_WOOD
    ]!;
    expect(wood).toBeGreaterThanOrEqual(20);
    expect(h.gather.deliveriesByDropOff[0]!).toBeGreaterThan(0);
    // Conservation closes per resource: extracted == deposited + carried.
    let carried = 0;
    for (const eid of villagers) {
      carried += getInventory(h.world, h.comps, eid)?.amount ?? 0;
    }
    expect(h.gather.extractedByResource[RESOURCE_WOOD]).toBe(
      h.gather.depositedByResource[RESOURCE_WOOD]! + carried,
    );
    // Node bookkeeping mirrors extraction.
    const remaining = getResourceNodeRow(h.world, h.comps, nodeId)![1]!;
    expect(10000 - remaining).toBe(h.gather.extractedByResource[RESOURCE_WOOD]);
  });

  it("leaves carriers idle holding cargo when NO accepting camp remains", () => {
    const scenario = campScenario();
    const { h, lumberNear, lumberFar, militia } = scenario;
    waitUntilCarrying(h, scenario.villagers);
    primeBuildingHp(h, lumberNear, 4);
    submit(h.world, ATTACK_COMMAND_KIND, h.world.tick + 1, {
      attackerIds: [militia],
      targetId: lumberNear,
    });
    step(h.world);
    // Destroy the fallback too (a tick later — one order per raider
    // per tick boundary), so nothing accepts wood any more.
    primeBuildingHp(h, lumberFar, 4);
    submit(h.world, ATTACK_COMMAND_KIND, h.world.tick + 1, {
      attackerIds: [militia],
      targetId: lumberFar,
    });
    step(h.world);

    steps(h.world, 600);
    expect(h.gather.blockedCarryTicks).toBeGreaterThan(0);
    const carried = scenario.villagers.reduce((sum, eid) => {
      return sum + (getInventory(h.world, h.comps, eid)?.amount ?? 0);
    }, 0);
    expect(carried).toBeGreaterThan(0);
  });
});

describe("construction-site destruction", () => {
  it("cancels builders, spawns rubble and restores the tiles", () => {
    const h = harness(31);
    const builders = [
      spawnUnit(h.world, h.comps, 7.5, 7.5),
      spawnUnit(h.world, h.comps, 10.5, 7.5),
    ];
    const militia = spawnCombatUnit(h.world, h.comps, "militia", 10.6, 9, 1);

    submit(h.world, PLACE_BUILDING_KIND, 1, {
      defId: "house",
      tileX: 8,
      tileY: 8,
    });
    step(h.world);
    const site = h.world.lastAllocatedEid;
    expect(getBuildingSiteRow(h.world, h.comps, site)).toEqual([
      PLAYER_ONE,
      expect.any(Number),
      0,
      550,
    ]);
    submit(h.world, "build", 2, { entityIds: builders, siteEid: site });
    step(h.world);
    expect(getAssignedSite(h.world, h.comps, builders[0]!)).toBe(site);

    const versionBefore = h.paths.passabilityVersion;
    const siteRow = getBuildingSiteRow(h.world, h.comps, site) as number[];
    siteRow[3] = 4; // foundation one strike from collapse
    submit(h.world, ATTACK_COMMAND_KIND, h.world.tick + 1, {
      attackerIds: [militia],
      targetId: site,
    });
    step(h.world);

    expect(h.combat.buildingsDestroyed).toBe(1);
    expect(h.combat.workersRetasked).toBe(2);
    for (const eid of builders) {
      expect(getAssignedSite(h.world, h.comps, eid)).toBeUndefined();
      expect(readActivityQueue(h.world, h.comps, eid)).toEqual([]);
    }
    expect(getBuildingSiteRow(h.world, h.comps, site)).toBeUndefined();
    expect(getBuildingRow(h.world, h.comps, site)).toBeUndefined(); // progress lost
    const rubbleEid = h.world.lastAllocatedEid;
    expect(getRubbleRow(h.world, h.comps, rubbleEid)).toEqual([8, 8, 2, 2]);
    for (let y = 8; y <= 9; y++) {
      for (let x = 8; x <= 9; x++) {
        expect(tilePassable(h, x, y)).toBe(true);
      }
    }
    expect(h.paths.passabilityVersion).toBe(versionBefore + 1);
  });
});

describe("conquest counter (SPEC §2.11)", () => {
  it("counts only live barracks/archery-range/stable per player", () => {
    const h = harness(41);
    // P0: one military producer among economic noise + an excluded SITE.
    const p0Barracks = stampFinishedBuilding(
      h.world,
      h.comps,
      "barracks",
      2,
      2,
    );
    stampFinishedBuilding(h.world, h.comps, "house", 6, 2);
    stampFinishedBuilding(h.world, h.comps, "mill", 9, 2);
    // P1: two military producers among noise.
    const p1Range = stampFinishedBuilding(
      h.world,
      h.comps,
      "archery-range",
      14,
      2,
      { playerId: 1 },
    );
    const p1Stable = stampFinishedBuilding(h.world, h.comps, "stable", 18, 2, {
      playerId: 1,
    });
    stampFinishedBuilding(h.world, h.comps, "town-center", 22, 2, {
      playerId: 1,
    });

    expect(militaryProductionBuildingCount(h.world, h.comps, PLAYER_ONE)).toBe(
      1,
    );
    expect(militaryProductionBuildingCount(h.world, h.comps, 1)).toBe(2);
    expect(militaryProductionBuildingsOf(h.world, h.comps, 1)).toEqual([
      p1Range,
      p1Stable,
    ]);

    // Destruction drops the count; economic buildings never counted.
    expect(despawnEntity(h.world, p1Stable)).toBe(true);
    expect(militaryProductionBuildingCount(h.world, h.comps, 1)).toBe(1);
    expect(militaryProductionBuildingsOf(h.world, h.comps, PLAYER_ONE)).toEqual(
      [p0Barracks],
    );
  });
});

describe("production-building destruction purges the training queue", () => {
  it("drops escrowed entries with the building (refund deferred)", () => {
    const h = harness(51);
    // Harness capital covers two militia enqueues (food 60 + gold 20 each).
    stampFinishedBuilding(h.world, h.comps, "town-center", 2, 2); // pop cap
    const barracks = stampFinishedBuilding(h.world, h.comps, "barracks", 6, 2);

    submit(h.world, TRAIN_UNIT_KIND, 1, {
      siteEid: barracks,
      unitId: "militia",
    });
    submit(h.world, TRAIN_UNIT_KIND, 1, {
      siteEid: barracks,
      unitId: "militia",
    });
    step(h.world);
    expect(readTrainQueue(h.world, h.comps, barracks)).toHaveLength(2);

    const militia = spawnCombatUnit(h.world, h.comps, "militia", 9.3, 3.5, 1);
    primeBuildingHp(h, barracks, 4);
    submit(h.world, ATTACK_COMMAND_KIND, h.world.tick + 1, {
      attackerIds: [militia],
      targetId: barracks,
    });
    step(h.world);

    expect(getBuildingRow(h.world, h.comps, barracks)).toBeUndefined();
    // Queue purge falls out of despawn: no row, no future spawn.
    expect(
      h.world.rowsByComponentId.get(h.comps.trainQueueId)?.has(barracks),
    ).toBe(false);
    expect(readTrainQueue(h.world, h.comps, barracks)).toEqual([]);
    expect(militaryProductionBuildingCount(h.world, h.comps, PLAYER_ONE)).toBe(
      0,
    );
  });
});

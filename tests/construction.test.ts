/**
 * Construction system tests — SPEC §2.3 / M1-T10.
 *
 * Hand-authored 16×16 grids with builders pre-positioned inside a
 * site's work band prove: the fixed-point diminishing-returns ladder is
 * exact (1 builder = 1000 milli-ticks/tick, 2nd adds 700, 3rd 490),
 * completion swaps the BuildingSite row into its finished Building row
 * on the SAME entity id while activating drop-off filters and releasing
 * every builder, and — the economy payoff — gatherers carrying from a
 * node reroute to the newly completed camp because the gather system
 * enumerates DropOff rows live.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
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
  createMovementDiagnostics,
  createMovementSystem,
} from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../src/sim/systems/gather";
import {
  BUILD_KIND,
  builderWorkMilliPerTick,
  createConstructionSystem,
} from "../src/sim/systems/construction";
import { createPlacementSystem } from "../src/sim/systems/placement";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly movement: ReturnType<typeof createMovementDiagnostics>;
  readonly gather: ReturnType<typeof createGatherDiagnostics>;
}

function harness(seed = 424242): Harness {
  const size = 16;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  const movement = createMovementDiagnostics();
  const gather = createGatherDiagnostics();
  registerSystem(world, createMovementSystem(comps, paths, movement));
  registerSystem(world, createGatherSystem(comps, paths, gather));
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE, [500, 2000, 200, 200]);
  return { world, comps, movement, gather };
}

/** Submit a placeBuilding command for the very next tick. */
function place(
  world: World,
  defId: string,
  tileX: number,
  tileY: number,
): void {
  world.inbox.submit({
    kind: "placeBuilding",
    targetTick: world.tick + 1,
    data: { defId, tileX, tileY },
  });
}

/**
 * Place AND advance one tick, returning the freshly spawned site's
 * entity id — discovered from the new-entity set, never assumed.
 */
function placeSite(
  world: World,
  comps: SimComponents,
  defId: string,
  tileX: number,
  tileY: number,
): number {
  const known = new Set(world.entities);
  place(world, defId, tileX, tileY);
  step(world);
  for (let i = world.entities.length - 1; i >= 0; i--) {
    const eid = world.entities[i]!;
    if (!known.has(eid) && getBuildingSiteRow(world, comps, eid)) return eid;
  }
  throw new Error(`placing ${defId} spawned no BuildingSite entity`);
}

/** Submit a build (assign villagers) command for the very next tick. */
function assignBuilders(
  world: World,
  entityIds: readonly number[],
  siteEid: number,
): void {
  world.inbox.submit({
    kind: BUILD_KIND,
    targetTick: world.tick + 1,
    data: { entityIds: [...entityIds], siteEid },
  });
}

describe("construction system", () => {
  it("weights builder contributions with strictly diminishing returns", () => {
    expect([
      builderWorkMilliPerTick(0),
      builderWorkMilliPerTick(1),
      builderWorkMilliPerTick(2),
    ]).toEqual([1000, 700, 490]);
    const three = [0, 1, 2].reduce(
      (sum, rank) => sum + builderWorkMilliPerTick(rank),
      0,
    );
    expect(three).toBe(2190); // < 3000: helpers help, but never linearly
  });

  it("accumulates EXACT fixed-point progress per in-range builder count", () => {
    const single = harness();
    const solo = spawnUnit(single.world, single.comps, 6.5, 5.5);
    const soloSite = placeSite(single.world, single.comps, "house", 4, 4);
    assignBuilders(single.world, [solo], soloSite);
    step(single.world); // assignment lands; contributions start this tick
    for (let i = 0; i < 50; i++) step(single.world);
    // The builder stands in range from the assignment tick onward: 51
    // ticks of exactly one base-weight contribution each.
    expect(getBuildingSiteRow(single.world, single.comps, soloSite)?.[2]).toBe(
      51 * 1000,
    );

    const trio = harness();
    const b1 = spawnUnit(trio.world, trio.comps, 6.5, 5.5);
    const b2 = spawnUnit(trio.world, trio.comps, 6.5, 6.0);
    const b3 = spawnUnit(trio.world, trio.comps, 7.0, 5.5);
    const trioSite = placeSite(trio.world, trio.comps, "house", 4, 4);
    assignBuilders(trio.world, [b1, b2, b3], trioSite);
    step(trio.world);
    for (let i = 0; i < 50; i++) step(trio.world);
    expect(getBuildingSiteRow(trio.world, trio.comps, trioSite)?.[2]).toBe(
      51 * 2190,
    );
  });

  it("completes a house: swaps site→building on the same eid and releases builders", () => {
    const h = harness();
    const b1 = spawnUnit(h.world, h.comps, 6.5, 5.5);
    const b2 = spawnUnit(h.world, h.comps, 6.5, 6.0);
    const b3 = spawnUnit(h.world, h.comps, 7.0, 5.5);
    const siteEid = placeSite(h.world, h.comps, "house", 4, 4);
    assignBuilders(h.world, [b1, b2, b3], siteEid);
    step(h.world);

    // 750k milli needed at 2190/tick → ceil(750000/2190) = 343 work
    // ticks after the assignment tick lands; run a generous window.
    for (let i = 0; i < 500; i++) step(h.world);

    expect(getBuildingSiteRow(h.world, h.comps, siteEid)).toBeUndefined();
    const built = getBuildingRow(h.world, h.comps, siteEid)!;
    expect(built[0]).toBe(PLAYER_ONE);
    expect(built[2]).toBe(4); // origin tiles recovered from the center
    expect(built[3]).toBe(4);
    expect(built[4]).toBe(550); // definition hp stamped on completion
    for (const eid of [b1, b2, b3]) {
      expect(getAssignedSite(h.world, h.comps, eid)).toBeUndefined();
    }
  });

  it("activates drop-off filters on completion so gatherers reroute to the new camp", () => {
    const h = harness();
    // Old depot far west, wood node far east — the future TC sits much
    // closer to the node than the old camp.
    createDropOffPoint(h.world, h.comps, 1.5, 1.5, PLAYER_ONE);
    const node = spawnResourceNode(h.world, h.comps, 13, 8, 1 /* wood */, 800);
    const g1 = spawnUnit(h.world, h.comps, 12.5, 9.5);
    const g2 = spawnUnit(h.world, h.comps, 13.5, 9.5);
    const builder = spawnUnit(h.world, h.comps, 10.5, 10.5);
    h.world.inbox.submit({
      kind: "gather",
      targetTick: 2,
      data: { entityIds: [g1, g2], nodeId: node },
    });
    const tcSiteEid = placeSite(h.world, h.comps, "town-center", 11, 11);
    assignBuilders(h.world, [builder], tcSiteEid);
    step(h.world);

    // TC needs 3_000_000 milli; one in-range builder contributes 1000/tick.
    let completed = false;
    for (let i = 0; i < 3400 && !completed; i++) {
      step(h.world);
      completed =
        getBuildingRow(h.world, h.comps, tcSiteEid) !== undefined &&
        getBuildingSiteRow(h.world, h.comps, tcSiteEid) === undefined;
    }
    expect(completed).toBe(true);
    expect(getBuildingRow(h.world, h.comps, tcSiteEid)![4]).toBe(2400);

    // From here on, carries must land at the NEW camp (lower-eid old
    // depot keeps rank 0; the TC takes the next delivery rank).
    const deliveriesToNewCampBefore = h.gather.deliveriesByDropOff[1] ?? 0;
    for (let i = 0; i < 2600; i++) step(h.world);
    expect(h.gather.deliveriesByDropOff.length).toBeGreaterThanOrEqual(2);
    expect(h.gather.deliveriesByDropOff[1]!).toBeGreaterThan(
      deliveriesToNewCampBefore,
    );
    // And the ledger still closes through either camp.
    expect(h.gather.depositedByResource[1]).toBeGreaterThan(0);
  });
});

/**
 * Production-chain unit coverage — SPEC §2.6 depth-1 / M2-T3.
 *
 * Hand-stamped workshops with crafters pre-positioned inside the
 * approach band pin the exact IO contract of every §2.6 recipe: inputs
 * debit at cycle START (full list or nothing), outputs credit on the
 * pinned completion tick (commandTargetTick + recipe.ticks), stalls are
 * polite (diagnostics, never throws) and resume the instant the missing
 * piece arrives. Also covers the ≤workSlots claim cap, the techGate
 * unlock seam, loud validation errors and the MealConsumed morale stub.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  clearProductionJob,
  getProductionCycleRow,
  getProductionJob,
  readMealConsumedEvents,
} from "../src/sim/components/production";
import { RESOURCE_WOOD } from "../src/sim/components/economy";
import { recipeCodeOf } from "../src/data/definitions";
import {
  COMMODITY_MEALS,
  COMMODITY_PLANKS,
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
  commodityAmountOf,
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
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  PRODUCE_KIND,
  createProductionDiagnostics,
  createProductionSystem,
  type ProductionDiagnostics,
} from "../src/sim/systems/production";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

/** Ample seed amounts — every recipe input covered many times over. */
const SEED_RESOURCES = [200, 200, 200, 0, 200, 200, 200];

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly production: ProductionDiagnostics;
}

function harness(seed = 20260823): Harness {
  const size = 16;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, paths));
  const production = createProductionDiagnostics();
  registerSystem(world, createProductionSystem(comps, production));
  createPlayerStockpile(world, comps, PLAYER_ONE, SEED_RESOURCES);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  return { world, comps, production };
}

/**
 * Stamp one workshop at (6,6) — a 2×2 footprint covering tiles 6–7 —
 * and park a crafter just off its east edge, inside the work band on
 * spawn so staffing needs no walk.
 */
function staffedWorkshop(
  h: Harness,
  defId: string,
): { buildingEid: number; crafter: number } {
  const buildingEid = stampFinishedBuilding(h.world, h.comps, defId, 6, 6);
  const crafter = spawnUnit(h.world, h.comps, 8.5, 6.5);
  return { buildingEid, crafter };
}

function produce(
  h: Harness,
  entityIds: readonly number[],
  buildingEid: number,
  recipeId?: string,
): void {
  h.world.inbox.submit({
    kind: PRODUCE_KIND,
    targetTick: h.world.tick + 1,
    data:
      recipeId === undefined
        ? { entityIds: [...entityIds], buildingEid }
        : { entityIds: [...entityIds], buildingEid, recipeId },
  });
}

/** The six §2.6 recipes: building, optional selection, IO, duration. */
const RECIPE_TABLE: readonly {
  readonly defId: string;
  readonly recipeId?: string;
  readonly inputs: Record<string, number>;
  readonly output: string;
  readonly ticks: number;
}[] = [
  { defId: "sawpit", inputs: { wood: 2 }, output: "planks", ticks: 300 },
  {
    defId: "kiln",
    inputs: { clay: 2, coal: 1 },
    output: "bricks",
    ticks: 450,
  },
  {
    defId: "smithy",
    inputs: { iron: 1, wood: 1 },
    output: "tools",
    ticks: 450,
  },
  {
    defId: "forge",
    recipeId: "weapons",
    inputs: { iron: 2, wood: 1 },
    output: "weapons",
    ticks: 600,
  },
  // No explicit selection: forge's ascending-id default IS armor.
  { defId: "forge", inputs: { iron: 2, gold: 1 }, output: "armor", ticks: 600 },
  { defId: "kitchen", inputs: { food: 3 }, output: "meals", ticks: 300 },
];

const SLUG_CODE: Record<string, number> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
  iron: 4,
  coal: 5,
  clay: 6,
};

const COMMODITY_CODE: Record<string, number> = {
  planks: 0,
  bricks: 1,
  tools: 2,
  weapons: 3,
  armor: 4,
  meals: 5,
};

describe("production chains (M2-T3)", () => {
  for (const entry of RECIPE_TABLE) {
    const label = entry.recipeId ?? entry.output;
    it(`${label}: exact IO on the pinned completion tick`, () => {
      const h = harness();
      const { buildingEid, crafter } = staffedWorkshop(h, entry.defId);
      produce(h, [crafter], buildingEid, entry.recipeId);

      const startTick = h.world.tick + 1;
      step(h.world); // command applies + staffed start consumes inputs

      // Inputs debited AT START, exactly and atomically.
      const amounts = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
      for (const [slug, qty] of Object.entries(entry.inputs)) {
        expect(amounts[SLUG_CODE[slug]!]).toBe(
          SEED_RESOURCES[SLUG_CODE[slug]!]! - qty,
        );
      }
      // Cycle opened with the full duration; nothing produced yet.
      expect(getProductionCycleRow(h.world, h.comps, buildingEid)?.[2]).toBe(
        entry.ticks,
      );
      expect(
        commodityAmountOf(
          h.world,
          h.comps,
          PLAYER_ONE,
          COMMODITY_CODE[entry.output]!,
        ),
      ).toBe(0);

      // Advance to one tick before completion: still nothing.
      while (h.world.tick < startTick + entry.ticks - 1) step(h.world);
      expect(
        commodityAmountOf(
          h.world,
          h.comps,
          PLAYER_ONE,
          COMMODITY_CODE[entry.output]!,
        ),
      ).toBe(0);

      // The completion tick credits exactly one output unit…
      step(h.world);
      expect(h.world.tick).toBe(startTick + entry.ticks);
      expect(
        commodityAmountOf(
          h.world,
          h.comps,
          PLAYER_ONE,
          COMMODITY_CODE[entry.output]!,
        ),
      ).toBe(1);
      expect(h.production.cyclesCompleted).toBe(1);
      // …and the same-tick restart attempt immediately opens cycle #2
      // (inputs are ample) — the exact `recipe.ticks` cadence guarantee.
      expect(h.production.cyclesStarted).toBe(2);
      expect(getProductionCycleRow(h.world, h.comps, buildingEid)?.[2]).toBe(
        entry.ticks,
      );
    });
  }

  it("insufficient inputs stall politely and resume when available", () => {
    const h = harness();
    // Cripple the wood pile below the planks recipe's 2-wood input.
    const rows = h.world.rowsByComponentId.get(h.comps.stockpileId)!;
    for (const row of rows.values()) {
      if (row[0] === PLAYER_ONE) row[RESOURCE_WOOD + 1] = 1;
    }
    const { buildingEid, crafter } = staffedWorkshop(h, "sawpit");
    produce(h, [crafter], buildingEid);
    step(h.world);

    // Staffed but starving: no debit, no cycle, polite diagnostic.
    expect(
      stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[RESOURCE_WOOD],
    ).toBe(1);
    expect(getProductionCycleRow(h.world, h.comps, buildingEid)?.[2]).toBe(0);
    expect(h.production.stalledMissingInputTicks).toBeGreaterThan(0);
    expect(h.production.cyclesStarted).toBe(0);

    // Scenario-editor-style injection between ticks: top the pile up.
    const row = [...rows.values()].find((r) => r[0] === PLAYER_ONE)!;
    row[RESOURCE_WOOD + 1] = 10;

    step(h.world); // resumes the very next tick
    expect(h.production.cyclesStarted).toBe(1);
    expect(
      stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[RESOURCE_WOOD],
    ).toBe(8);
    // Completion pins exactly recipe.ticks after the resuming tick.
    const remaining = getProductionCycleRow(h.world, h.comps, buildingEid)![2]!;
    const resumedAt = h.world.tick;
    while (
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_PLANKS) === 0 &&
      h.world.tick < resumedAt + remaining + 10
    ) {
      step(h.world);
    }
    expect(h.world.tick).toBe(resumedAt + remaining);
    expect(h.production.cyclesCompleted).toBe(1);
  });

  it("a cycle in flight freezes without staff and resumes on reassignment", () => {
    const h = harness();
    const { buildingEid, crafter } = staffedWorkshop(h, "sawpit");
    produce(h, [crafter], buildingEid);
    step(h.world);
    const remainingAtFreeze = 296;
    while (h.world.tick < 5) step(h.world);
    expect(h.world.tick).toBe(5);
    expect(getProductionCycleRow(h.world, h.comps, buildingEid)?.[2]).toBe(
      remainingAtFreeze,
    );

    // Pull the crafter off mid-flight (re-task injection): the frozen
    // countdown is digest-visible stall evidence, never silent loss.
    clearProductionJob(h.world, h.comps, crafter);
    const freezeStart = h.world.tick;
    for (let i = 0; i < 25; i++) step(h.world);
    expect(h.world.tick).toBe(freezeStart + 25);
    expect(getProductionCycleRow(h.world, h.comps, buildingEid)?.[2]).toBe(
      remainingAtFreeze,
    );
    expect(h.production.stalledMissingWorkerTicks).toBeGreaterThanOrEqual(25);

    // Reassign: work resumes (same tick as the command lands) and the
    // remaining countdown finishes exactly on its pinned tick.
    produce(h, [crafter], buildingEid);
    step(h.world);
    const resumedAt = h.world.tick;
    const remainingOnResume = getProductionCycleRow(
      h.world,
      h.comps,
      buildingEid,
    )![2]!;
    while (
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_PLANKS) === 0 &&
      h.world.tick < resumedAt + remainingOnResume + 10
    ) {
      step(h.world);
    }
    expect(h.world.tick).toBe(resumedAt + remainingOnResume);
    expect(h.production.cyclesCompleted).toBe(1);
  });

  it("claims at most workSlots crafters; overflow waits at slot −1", () => {
    const h = harness();
    const buildingEid = stampFinishedBuilding(h.world, h.comps, "sawpit", 6, 6);
    const first = spawnUnit(h.world, h.comps, 8.5, 6.5);
    const second = spawnUnit(h.world, h.comps, 8.5, 7.5);
    produce(h, [second, first], buildingEid); // ascending eid re-sorted
    step(h.world);

    expect(getProductionJob(h.world, h.comps, first)).toEqual({
      buildingEid,
      slotIndex: 0,
    });
    expect(getProductionJob(h.world, h.comps, second)).toEqual({
      buildingEid,
      slotIndex: -1,
    });
    // The slotted crafter keeps the line running regardless.
    while (h.world.tick < 310) step(h.world);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_PLANKS),
    ).toBe(1);
  });

  it("honors the techGate unlock seam", () => {
    const size = 16;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const paths = new PathScheduler(createSynchronousPathTransport());
    const world = createWorld(99, {
      layers: buildLayers(terrainType, new Uint8Array(size * size)),
      size,
      pathScheduler: paths,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createMovementSystem(comps, paths));
    const production = createProductionDiagnostics();
    registerSystem(
      world,
      createProductionSystem(comps, production, {
        isRecipeUnlocked: (recipe) => recipe.id !== "meals",
      }),
    );
    createPlayerStockpile(world, comps, PLAYER_ONE, SEED_RESOURCES);
    createCommodityStockpile(world, comps, PLAYER_ONE);
    const h: Harness = { world, comps, production };

    const buildingEid = stampFinishedBuilding(
      h.world,
      h.comps,
      "kitchen",
      6,
      6,
    );
    const crafter = spawnUnit(h.world, h.comps, 8.5, 6.5);
    produce(h, [crafter], buildingEid);
    for (let i = 0; i < 40; i++) step(h.world);

    expect(production.gateBlockedTicks).toBeGreaterThan(0);
    expect(production.cyclesStarted).toBe(0);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]).toBe(
      SEED_RESOURCES[0],
    );
  });

  it("validates produce orders loudly", () => {
    const h = harness();
    const tc = stampFinishedBuilding(h.world, h.comps, "town-center", 2, 2);
    const crafter = spawnUnit(h.world, h.comps, 8.5, 6.5);
    expect(() => {
      produce(h, [crafter], tc); // no recipes at a town-center
      step(h.world);
    }).toThrow(/no recipes/);
    expect(() => {
      produce(h, [crafter], 9999);
      step(h.world);
    }).toThrow(/no finished Building/);

    const sawpit = stampFinishedBuilding(h.world, h.comps, "sawpit", 6, 6);
    expect(() => {
      produce(h, [crafter], sawpit, "bricks"); // another building's recipe
      step(h.world);
    }).toThrow(/has no recipe "bricks"/);

    const forge = stampFinishedBuilding(h.world, h.comps, "forge", 12, 6);
    const smith = spawnUnit(h.world, h.comps, 14.5, 6.5);
    produce(h, [smith], forge, "weapons"); // default would be armor…
    step(h.world);
    expect(getProductionCycleRow(h.world, h.comps, forge)?.[1]).toBe(
      recipeCodeOf("weapons"),
    );
    // …and switching recipes mid-cycle is rejected outright.
    expect(() => {
      produce(h, [smith], forge, "armor");
      step(h.world);
    }).toThrow(/mid-cycle/);
  });

  it("completed meal batches append digest-visible mealConsumed events", () => {
    const h = harness();
    const { buildingEid, crafter } = staffedWorkshop(h, "kitchen");
    produce(h, [crafter], buildingEid);
    step(h.world);
    const firstCompletion = h.world.tick + 300;
    while (h.world.tick < firstCompletion) step(h.world);

    expect(readMealConsumedEvents(h.world, h.comps, buildingEid)).toEqual([
      { tick: firstCompletion, qty: 1 },
    ]);

    // Second batch lands exactly one cadence later with its own event.
    while (h.world.tick < firstCompletion + 300) step(h.world);
    expect(readMealConsumedEvents(h.world, h.comps, buildingEid)).toEqual([
      { tick: firstCompletion, qty: 1 },
      { tick: firstCompletion + 300, qty: 1 },
    ]);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_MEALS),
    ).toBe(2);
  });
});

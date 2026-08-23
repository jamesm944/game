/**
 * M2-T3 golden harness — SPEC §2.6 depth-1 chains / issue #37.
 *
 * Five §2.6 workshops (sawpit, kiln, smithy, forge, kitchen) run
 * produce commands from six crafters — one each plus a sixth villager
 * overflowing the sawpit's single work slot. Inputs debit the resource
 * ledger at cycle START, outputs credit the commodity ledger on the
 * pinned completion tick (commandTargetTick + recipe.ticks), and meals
 * append digest-visible MealConsumed events. With ample inputs and
 * in-range staff nothing ever stalls, so the exact cycle counts close
 * both ledgers against hand-computed constants. Milestone digests land
 * every 30th tick plus final; the run executes twice as the
 * determinism canary. Milestones regenerate only through
 * `npm run golden:record`.
 *
 * Eid layout is part of the fixture contract: crafters take 1–6, the
 * stockpile 7 and the workshops 8–12 in listed order; commands reference
 * those ids.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimCommand } from "../../../src/sim/core/inbox";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  defineSimComponents,
  getPosition,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { getProductionJob } from "../../../src/sim/components/production";
import {
  PLAYER_ONE,
  commodityAmountsOf,
  createCommodityStockpile,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createProductionDiagnostics,
  createProductionSystem,
  type ProductionDiagnostics,
} from "../../../src/sim/systems/production";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";

const RESOURCE_SLUGS = [
  "food",
  "wood",
  "gold",
  "stone",
  "iron",
  "coal",
  "clay",
] as const;

interface GoldenSpawn {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenBuilding {
  readonly eid: number;
  readonly defId: string;
  readonly tileX: number;
  readonly tileY: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly stockpile: readonly number[];
  readonly spawns: readonly GoldenSpawn[];
  readonly buildings: readonly GoldenBuilding[];
  readonly commands: readonly SimCommand[];
}

function requiredNumber(value: unknown, where: string): number {
  if (typeof value !== "number") {
    throw new Error(`fixture ${where} must be a number`);
  }
  return value;
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;

  if (!Array.isArray(box.spawns) || box.spawns.length === 0) {
    throw new Error("fixture case.json: spawns must be a non-empty array");
  }
  const spawns = box.spawns.map((entry): GoldenSpawn => {
    const spawn = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(spawn.eid, "spawn.eid"),
      x: requiredNumber(spawn.x, "spawn.x"),
      y: requiredNumber(spawn.y, "spawn.y"),
    };
  });

  const stockpileBox = box.stockpile as Record<string, unknown>;
  const stockpile = RESOURCE_SLUGS.map((slug) =>
    requiredNumber(stockpileBox[slug], `stockpile.${slug}`),
  );

  if (!Array.isArray(box.buildings) || box.buildings.length === 0) {
    throw new Error("fixture case.json: buildings must be non-empty");
  }
  const buildings = box.buildings.map((entry): GoldenBuilding => {
    const building = entry as Record<string, unknown>;
    if (typeof building.defId !== "string") {
      throw new Error("fixture case.json: building.defId must be a string");
    }
    return {
      eid: requiredNumber(building.eid, "building.eid"),
      defId: building.defId,
      tileX: requiredNumber(building.tileX, "building.tileX"),
      tileY: requiredNumber(building.tileY, "building.tileY"),
    };
  });

  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: produce commands require data");
    }
    return {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    };
  });

  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    size: requiredNumber(box.size, "size"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    stockpile,
    spawns,
    buildings,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

/** Plain-comparable final state so canaries deep-equal trivially. */
interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  readonly allOnPassableTiles: boolean;
  /** [eid, x, y] ascending eid over all crafters. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly resourceLedger: readonly number[];
  readonly commodityLedger: readonly number[];
  readonly producedByCommodity: readonly number[];
  readonly consumedByResource: readonly number[];
  readonly cyclesStarted: number;
  readonly cyclesCompleted: number;
  readonly stalledMissingInputTicks: number;
  readonly stalledMissingWorkerTicks: number;
  readonly gateBlockedTicks: number;
  /** Claimed slot per crafter eid, ascending. */
  readonly slotsByCrafter: readonly (readonly [number, number])[];
}

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const production: ProductionDiagnostics = createProductionDiagnostics();
  registerSystem(world, createProductionSystem(comps, production));

  // Eid contract: crafters first, then the player's two ledgers on ONE
  // stockpile entity (commodities stockpile alongside resources).
  for (const spawn of fixture.spawns) {
    const eid = spawnUnit(world, comps, spawn.x, spawn.y);
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
  }
  createPlayerStockpile(world, comps, PLAYER_ONE, fixture.stockpile);
  createCommodityStockpile(world, comps, PLAYER_ONE);

  for (const building of fixture.buildings) {
    const eid = stampFinishedBuilding(
      world,
      comps,
      building.defId,
      building.tileX,
      building.tileY,
    );
    if (eid !== building.eid) {
      throw new Error(
        `fixture building order mismatch: expected eid ${String(building.eid)}, allocated ${String(eid)}`,
      );
    }
  }

  for (const command of fixture.commands) world.inbox.submit(command);

  const digests: MilestoneDigest[] = [];
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue; // held boundary: no double record
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const passability = world.layers.derivedPassability;
  const size = world.layers.size;
  let allOnPassableTiles = true;
  const positions: [number, number, number][] = [];
  for (const spawn of fixture.spawns) {
    const pos = getPosition(world, comps, spawn.eid);
    positions.push([spawn.eid, pos.x, pos.y]);
    const tx = Math.floor(pos.x);
    const ty = Math.floor(pos.y);
    if (
      tx < 0 ||
      ty < 0 ||
      tx >= size ||
      ty >= size ||
      passability[ty * size + tx] !== 1
    ) {
      allOnPassableTiles = false;
    }
  }

  return {
    digests,
    finalTick: world.tick,
    allOnPassableTiles,
    positions,
    resourceLedger: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    commodityLedger: [...commodityAmountsOf(world, comps, PLAYER_ONE)],
    producedByCommodity: [...production.producedByCommodity],
    consumedByResource: [...production.consumedByResource],
    cyclesStarted: production.cyclesStarted,
    cyclesCompleted: production.cyclesCompleted,
    stalledMissingInputTicks: production.stalledMissingInputTicks,
    stalledMissingWorkerTicks: production.stalledMissingWorkerTicks,
    gateBlockedTicks: production.gateBlockedTicks,
    slotsByCrafter: fixture.spawns.map(
      (spawn) =>
        [
          spawn.eid,
          getProductionJob(world, comps, spawn.eid)?.slotIndex ?? -999,
        ] as [number, number],
    ),
  };
}

installSimPurityShims();

describe("golden harness m2t3", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("closes both ledgers against exact cycle counts with zero stalls", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);

    // Ample inputs + in-range staff: the polite stall paths never fire.
    expect(run.stalledMissingInputTicks).toBe(0);
    expect(run.stalledMissingWorkerTicks).toBe(0);
    expect(run.gateBlockedTicks).toBe(0);

    // Slot cap: five crafters hold slot 0 of their workshops; the sixth
    // villager overflows the sawpit's single slot (−1).
    expect(run.slotsByCrafter).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, -1],
    ]);

    // Pinned completion ticks → exact per-commodity output counts:
    // planks ⌊(1800−302)/300⌋+1 = 5, bricks 3 (453·k ≤ 1353), tools 3,
    // weapons 2 (605/1205), armor 0 (unselected), meals 5.
    expect(run.producedByCommodity).toEqual([5, 3, 3, 2, 0, 5]);

    // Starts = completions + one in-flight cycle per running line
    // except armor (never selected): 6+4+4+3+0+6 = 23 started, 18 done.
    expect(run.cyclesStarted).toBe(23);
    expect(run.cyclesCompleted).toBe(18);

    // Resource ledger closes: seed − consumedByResource, with wood
    // eaten by planks+tools+weapons, clay/coal by bricks, iron by
    // tools+weapons, food by meals, gold untouched.
    const consumed: Record<string, number> = {
      food: 6 * 3,
      wood: 6 * 2 + 4 * 1 + 3 * 1,
      gold: 0,
      stone: 0,
      iron: 4 * 1 + 3 * 2,
      coal: 4 * 1,
      clay: 4 * 2,
    };
    expect(run.consumedByResource).toEqual([
      consumed.food,
      consumed.wood,
      consumed.gold,
      consumed.stone,
      consumed.iron,
      consumed.coal,
      consumed.clay,
    ]);
    expect(run.resourceLedger).toEqual(
      fixture.stockpile.map(
        (seed, code) => seed - (run.consumedByResource[code] ?? 0),
      ),
    );

    // Commodity ledger closes: opened zeroed, grew by outputs alone.
    expect(run.commodityLedger).toEqual(run.producedByCommodity);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(50);
  });
});

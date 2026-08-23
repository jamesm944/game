/**
 * M1-T10 golden harness — SPEC §2.6/§2.13/§7.
 *
 * Runs the full place→build→train slice headlessly on the pinned 32×32
 * map (m1t3 seed bytes): eight villagers construct a Town Center, two
 * houses and a Barracks from escrowed wood; the barracks placement
 * lands mid-corridor while TC builders are still walking, forcing
 * ADR-0003 individual re-paths; once the TC completes it trains four
 * villagers — three spawn inside the window (each on a free passable
 * perimeter tile), the fourth stays queued with its remaining ticks
 * frozen into the final digest. Milestone digests land every 30th tick
 * plus final; the run executes twice as the determinism canary.
 * Milestones regenerate only through `npm run golden:record`.
 *
 * Eid layout is part of the fixture contract: villagers take 1–8, the
 * stockpile 9, the pre-existing drop-off camp 10, nodes 11–13, and the
 * sites 14 (TC) / 15 (house) / 16 (barracks) / 17 (house) in command
 * order; trained villagers continue after 17.
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
  getBuildingRow,
  getBuildingSiteRow,
  populationCapOf,
  populationOf,
  readTrainQueue,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  createDropOffPoint,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { createGatherSystem } from "../../../src/sim/systems/gather";
import { createPlacementSystem } from "../../../src/sim/systems/placement";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createTrainingSystem } from "../../../src/sim/systems/training";

const RESOURCE_SLUG_TO_CODE: Record<string, number> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
};

interface GoldenSpawn {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenNode {
  readonly tileX: number;
  readonly tileY: number;
  readonly resourceCode: number;
  readonly amount: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly stockpile: readonly number[];
  readonly spawns: readonly GoldenSpawn[];
  readonly nodes: readonly GoldenNode[];
  readonly dropOffs: readonly { x: number; y: number }[];
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

  if (!Array.isArray(box.nodes)) {
    throw new Error("fixture case.json: nodes must be an array");
  }
  const nodes = box.nodes.map((entry): GoldenNode => {
    const node = entry as Record<string, unknown>;
    const resourceCode = RESOURCE_SLUG_TO_CODE[String(node.resource)];
    if (resourceCode === undefined) {
      throw new Error(
        `fixture case.json: unknown resource slug ${String(node.resource)}`,
      );
    }
    return {
      tileX: requiredNumber(node.tileX, "node.tileX"),
      tileY: requiredNumber(node.tileY, "node.tileY"),
      resourceCode,
      amount: requiredNumber(node.amount, "node.amount"),
    };
  });

  if (!Array.isArray(box.dropOffs)) {
    throw new Error("fixture case.json: dropOffs must be an array");
  }
  const dropOffs = box.dropOffs.map((entry) => {
    const point = entry as Record<string, unknown>;
    return {
      x: requiredNumber(point.x, "dropOff.x"),
      y: requiredNumber(point.y, "dropOff.y"),
    };
  });

  const stockpileBox = box.stockpile as Record<string, unknown> | undefined;
  if (!stockpileBox) {
    throw new Error("fixture case.json: stockpile grants are required");
  }
  // Base four from the fixture plus the M2 Iron/Coal/Clay codes (4–6),
  // which this dark-age scenario never touches and grants as zero.
  const stockpile = [
    requiredNumber(stockpileBox.food, "stockpile.food"),
    requiredNumber(stockpileBox.wood, "stockpile.wood"),
    requiredNumber(stockpileBox.gold, "stockpile.gold"),
    requiredNumber(stockpileBox.stone, "stockpile.stone"),
    0,
    0,
    0,
  ];

  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all M1-T10 commands require data");
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
    nodes,
    dropOffs,
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
  /** [eid, x, y] ascending eid over ALL live villagers. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly allOnPassableTiles: boolean;
  readonly finishedBuildings: number;
  readonly pendingSites: number;
  readonly population: number;
  readonly popCap: number;
  readonly stockpiles: readonly number[];
  /** TC queue: [unitCode, remainingTicks] per entry, head first. */
  readonly tcQueue: readonly (readonly [number, number])[];
}

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createGatherSystem(comps, scheduler));
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));

  // Eid contract: villagers first, then stockpile + drop-off + nodes.
  for (const spawn of fixture.spawns) {
    const eid = spawnUnit(world, comps, spawn.x, spawn.y);
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
  }
  createPlayerStockpile(world, comps, PLAYER_ONE, fixture.stockpile);
  for (const point of fixture.dropOffs) {
    createDropOffPoint(world, comps, point.x, point.y, PLAYER_ONE);
  }
  for (const node of fixture.nodes) {
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      node.resourceCode,
      node.amount,
    );
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
  for (const eid of world.entities) {
    const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(eid);
    if (!posRow || !tagRow) continue; // buildings lack Velocity rows
    positions.push([eid, posRow[0]!, posRow[1]!]);
    const tx = Math.floor(posRow[0]!);
    const ty = Math.floor(posRow[1]!);
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

  let finishedBuildings = 0;
  let pendingSites = 0;
  for (const eid of world.entities) {
    if (getBuildingRow(world, comps, eid) !== undefined) finishedBuildings += 1;
    if (getBuildingSiteRow(world, comps, eid) !== undefined) pendingSites += 1;
  }

  // The TC (lowest-eid production building) queue state at the end.
  let tcQueue: [number, number][] = [];
  for (const eid of world.entities) {
    const built = getBuildingRow(world, comps, eid);
    if (!built) continue;
    tcQueue = readTrainQueue(world, comps, eid).map((entry) => [
      entry.unitCode,
      entry.remainingTicks,
    ]);
    break;
  }

  return {
    digests,
    finalTick: world.tick,
    positions,
    allOnPassableTiles,
    finishedBuildings,
    pendingSites,
    population: populationOf(world, comps),
    popCap: populationCapOf(world, comps),
    stockpiles: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    tcQueue,
  };
}

installSimPurityShims();

describe("golden harness m1t10", () => {
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

  it("completes every site, trains to the window and closes the ledger", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);

    // All four placements constructed to completion; nothing pending.
    expect(run.finishedBuildings).toBe(4);
    expect(run.pendingSites).toBe(0);

    // Population: 8 starting villagers + 3 trained inside the window.
    // Cap: TC(5) + two houses(5+5) = 15 — training stayed under it.
    expect(run.population).toBe(11);
    expect(run.popCap).toBe(15);

    // Escrow accounting with zero gather income in this fixture:
    // wood spent 300+30+175+30 = 535; food spent 4×50 = 200 (escrowed
    // at enqueue, refunds are not part of M1). Codes 4–6 (iron/coal/
    // clay) stay untouched zeroes.
    expect(run.stockpiles).toEqual([400, 165, 100, 0, 0, 0, 0]);

    // Exactly the fourth queued villager remains in the TC queue: it
    // became head when the third spawned and counted down through the
    // end of the window (deterministic to the tick). Villager's def
    // code is 8 under the full M2 unit set (ascending-slug assignment).
    expect(run.tcQueue).toEqual([[8, 79]]);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(20);
  });
});

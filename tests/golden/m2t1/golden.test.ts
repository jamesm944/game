/**
 * M2-T1 golden harness — SPEC §3 / issue #35.
 *
 * Boots a world against the FULL definition set (units, buildings,
 * techs and recipes all loaded through the three-round pipeline) and
 * proves the definitions drive real sim behavior: two houses, an
 * Archery Range and a Stable are placed, paid from the seven-slug
 * resource ledger, constructed by villagers, and then train an archer
 * (range queue head) plus a scout cavalry (stable queue head) through
 * the shared production path. Milestone digests land every 30th tick
 * plus final; the run executes twice as the determinism canary.
 * Milestones regenerate only through `npm run golden:record`.
 *
 * Eid layout is part of the fixture contract: villagers take 1–6, the
 * stockpile 7, and the sites 8 (house) / 9 (range) / 10 (stable) /
 * 11 (house) in placement command order; trained units continue after
 * 11 in spawn order (archer, then scout).
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
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
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
  iron: 4,
  coal: 5,
  clay: 6,
};
/** Full §2.6 gatherable set — every stockpile row carries all seven. */
const RESOURCE_COUNT = 7;

interface GoldenSpawn {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly stockpile: readonly number[];
  readonly spawns: readonly GoldenSpawn[];
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

  const spawns = (box.spawns as Record<string, unknown>[]).map(
    (spawn): GoldenSpawn => ({
      eid: requiredNumber(spawn.eid, "spawn.eid"),
      x: requiredNumber(spawn.x, "spawn.x"),
      y: requiredNumber(spawn.y, "spawn.y"),
    }),
  );

  const stockpileBox = box.stockpile as Record<string, unknown>;
  const stockpile = Object.entries(RESOURCE_SLUG_TO_CODE).map(([slug]) =>
    requiredNumber(stockpileBox[slug], `stockpile.${slug}`),
  );
  if (stockpile.length !== RESOURCE_COUNT) {
    throw new Error("fixture case.json: stockpile must cover seven slugs");
  }

  const commands = (box.commands as Record<string, unknown>[]).map(
    (command): SimCommand => ({
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    }),
  );

  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    size: requiredNumber(box.size, "size"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    stockpile,
    spawns,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  /** [eid, x, y] ascending eid over ALL live units. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly allOnPassableTiles: boolean;
  readonly finishedBuildings: number;
  readonly pendingSites: number;
  readonly population: number;
  readonly popCap: number;
  readonly stockpiles: readonly number[];
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

  // Eid contract: villagers first, then the player stockpile.
  for (const spawn of fixture.spawns) {
    const eid = spawnUnit(world, comps, spawn.x, spawn.y);
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
  }
  createPlayerStockpile(world, comps, PLAYER_ONE, fixture.stockpile);

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
  };
}

installSimPurityShims();

describe("golden harness m2t1", () => {
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

  it("boots the full definition set into a living feudal town", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);

    // All four placements constructed to completion; nothing pending.
    expect(run.finishedBuildings).toBe(4);
    expect(run.pendingSites).toBe(0);

    // Population: 6 starting villagers + archer + scout cavalry.
    // Cap: two houses × 5 = 10 — training stayed under it.
    expect(run.population).toBe(8);
    expect(run.popCap).toBe(10);

    // Seven-slug ledger: placements debited 30+30+175+175 wood, the
    // archer a further 25 wood + 45 gold, the scout 80 food; iron/
    // coal/clay sit untouched — proving the extended codes flow
    // end-to-end.
    expect(run.stockpiles).toEqual([1120, 965, 355, 200, 100, 50, 25]);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(90);
  });
});

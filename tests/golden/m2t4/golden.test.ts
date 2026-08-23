/**
 * M2-T4 golden harness — SPEC §2.11 age advancement / issue #38.
 *
 * The full Dark→Feudal→Castle→Imperial ladder runs against the pinned
 * seed-20260823 map through researchAge commands at the town center:
 * every advance escrows its tech cost at enqueue, counts its command
 * tick as the first research tick, promotes the player's AgeState rank
 * on completion (enqueue + researchTime − 1 exactly) and appends a
 * digest-visible AgeAdvanced event — the audio bus's age-up jingle
 * hook. The run opens with both polite gate refusals (a blacksmith
 * placement and a scout-cavalry order while still Dark Age) recorded
 * as GateRejected rows; feudal then unlocks the blacksmith pair that
 * satisfies castle/imperial prerequisite building sets, plus a stable-
 * trained scout-cavalry. Milestone digests land every 30th tick plus
 * final; the run executes twice as the extended determinism canary.
 * Milestones regenerate only through `npm run golden:record`.
 *
 * Eid layout is part of the fixture contract: villagers 1–6, ledger
 * entity 7 (Stockpile + CommodityStockpile + AgeState + GateRejected
 * rows), pre-stamped TC/stable/house 8–10, command-spawned sites
 * 11–12 in placement order, the trained scout after 12.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildingCodeOf, unitCodeOf } from "../../../src/data/definitions";
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
  populationOf,
  populationCapOf,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  currentAgeRankOf,
  createAgeDiagnostics,
  createAgeSystem,
} from "../../../src/sim/systems/age";
import {
  GATE_HANDLER_PLACE,
  GATE_HANDLER_TRAIN,
  createPlayerAgeState,
  readAgeAdvancedEvents,
  readGateRejections,
} from "../../../src/sim/components/age";
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
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createTrainingSystem } from "../../../src/sim/systems/training";
import { createPlacementSystem } from "../../../src/sim/systems/placement";
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
  readonly ageState: boolean;
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
      throw new Error("fixture case.json: all M2-T4 commands require data");
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
    ageState: box.ageState === true,
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
  /** [eid, x, y] ascending eid over the six starting villagers. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly resourceLedger: readonly number[];
  readonly commodityLedger: readonly number[];
  readonly population: number;
  readonly popCap: number;
  readonly finishedBuildings: number;
  readonly pendingSites: number;
  /** Current ladder rank + its full completion history. */
  readonly finalRank: number;
  readonly ageEvents: readonly (readonly [number, number])[];
  readonly gateRejections: readonly (readonly [number, number, number])[];
}

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createAgeSystem(comps, createAgeDiagnostics()));

  // Eid contract: villagers first, then the player's single ledger
  // entity carrying every per-player row set.
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
  if (fixture.ageState) createPlayerAgeState(world, comps, PLAYER_ONE);

  for (const building of fixture.buildings) {
    const eid = stampFinishedBuilding(
      world,
      comps,
      building.defId,
      building.tileX,
      building.tileY,
      { playerId: PLAYER_ONE },
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

  let finishedBuildings = 0;
  let pendingSites = 0;
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (row) finishedBuildings += 1;
    if (world.rowsByComponentId.get(comps.buildingSiteId)?.get(eid)) {
      pendingSites += 1;
    }
  }

  return {
    digests,
    finalTick: world.tick,
    allOnPassableTiles,
    positions,
    resourceLedger: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    commodityLedger: [...commodityAmountsOf(world, comps, PLAYER_ONE)],
    population: populationOf(world, comps),
    popCap: populationCapOf(world, comps),
    finishedBuildings,
    pendingSites,
    finalRank: currentAgeRankOf(world, comps, PLAYER_ONE),
    ageEvents: readAgeAdvancedEvents(world, comps, PLAYER_ONE).map(
      (event) => [event.tick, event.ageRank] as [number, number],
    ),
    gateRejections: readGateRejections(world, comps, PLAYER_ONE).map(
      (entry) =>
        [entry.tick, entry.handler, entry.defCode] as [number, number, number],
    ),
  };
}

installSimPurityShims();

describe("golden harness m2t4", () => {
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

  it("pins the exact Dark→Imperial ladder with closed ledgers", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);

    // Both polite gate refusals landed digest-visibly BEFORE any age
    // progress: a feudal blacksmith placement (handler place) and a
    // scout-cavalry order (handler train), neither paying nor spawning.
    expect(run.gateRejections).toEqual([
      [1, GATE_HANDLER_PLACE, buildingCodeOf("blacksmith")],
      [2, GATE_HANDLER_TRAIN, unitCodeOf("scout-cavalry")],
    ]);

    // The ladder completes on exact ticks — each advance enqueues at T,
    // escrows immediately and completes at T + researchTime − 1:
    //   feudal   @3    (+1800 − 1 → 1802)
    //   castle   @3000 (+2700 − 1 → 5699)
    //   imperial @5750 (+3600 − 1 → 9349)
    expect(run.ageEvents).toEqual([
      [1802, 2],
      [5699, 3],
      [9349, 4],
    ]);
    expect(run.finalRank).toBe(4);

    // Ledger closes to the seed minus exact spends:
    //   food  −500 feudal −80 scout −800 castle −1000 imperial
    //   wood  −150 −150 blacksmith placements (escrowed up front)
    //   gold  −200 castle −800 imperial · stone untouched
    expect(run.resourceLedger).toEqual([1620, 1700, 500, 200, 0, 0, 0]);
    // No recipes ran in this fixture: the commodity ledger stays zeroed.
    expect(run.commodityLedger).toEqual([0, 0, 0, 0, 0, 0]);

    // Six starting villagers plus the feudal scout-cavalry (trained out
    // of the stable once its gate opened); cap TC(5)+house(5)=10.
    expect(run.population).toBe(7);
    expect(run.popCap).toBe(10);

    // Every site constructed: TC + stable + house + two blacksmiths.
    expect(run.finishedBuildings).toBe(5);
    expect(run.pendingSites).toBe(0);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(250);
  });
});

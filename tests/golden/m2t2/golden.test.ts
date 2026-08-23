/**
 * M2-T2 golden harness — SPEC §2.6 / issue #36.
 *
 * Mixed-economy run against the filter-enforcing drop-off pipeline: a
 * lumber camp (wood only), a mining camp (gold/stone/iron/coal/clay)
 * and a mill (food only) are stamped from their definition
 * `dropoffFilters` (bootstrap helper, sanctioned for fixtures), then
 * six villagers sustain gather loops across wood/food/gold/iron/clay.
 * Because a deposit into a rejecting camp is structurally impossible —
 * choice-time filtering routes carriers to the cheapest ACCEPTING camp
 * and the deposit-time guard refuses anything that slips through — the
 * seven-slug ledger closing while ALL THREE camps receive deliveries
 * proves per-def routing end-to-end. Milestone digests land every 30th
 * tick plus final; the run executes twice as the determinism canary.
 * Milestones regenerate only through `npm run golden:record`.
 *
 * Eid layout is part of the fixture contract: villagers take 1–6, the
 * stockpile 7, the stamped camps 8–10 in listed order and the nodes
 * 11–15; the commands reference those ids. Drop-off delivery ranks
 * follow ascending eid: lumber camp rank 0, mining camp rank 1, mill
 * rank 2.
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
  getResourceNodeRow,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { getInventory } from "../../../src/sim/components/economy";
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
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../../../src/sim/systems/gather";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";

const RESOURCE_SLUG_TO_CODE: Record<string, number> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
  iron: 4,
  coal: 5,
  clay: 6,
};
/** Full §2.6 gatherable set — every ledger row carries all seven. */
const RESOURCE_COUNT = 7;

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

interface GoldenNode {
  readonly eid: number;
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
  readonly buildings: readonly GoldenBuilding[];
  readonly nodes: readonly GoldenNode[];
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
  const stockpile = Object.keys(RESOURCE_SLUG_TO_CODE).map((slug) =>
    requiredNumber(stockpileBox[slug], `stockpile.${slug}`),
  );
  if (stockpile.length !== RESOURCE_COUNT) {
    throw new Error("fixture case.json: stockpile must cover seven slugs");
  }

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

  if (!Array.isArray(box.nodes) || box.nodes.length === 0) {
    throw new Error("fixture case.json: nodes must be a non-empty array");
  }
  const nodes = box.nodes.map((entry): GoldenNode => {
    const node = entry as Record<string, unknown>;
    const slug = String(node.resource);
    const resourceCode = RESOURCE_SLUG_TO_CODE[slug];
    if (resourceCode === undefined) {
      throw new Error(`fixture case.json: unknown resource slug ${slug}`);
    }
    return {
      eid: requiredNumber(node.eid, "node.eid"),
      tileX: requiredNumber(node.tileX, "node.tileX"),
      tileY: requiredNumber(node.tileY, "node.tileY"),
      resourceCode,
      amount: requiredNumber(node.amount, "node.amount"),
    };
  });

  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: gather commands require data");
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
    nodes,
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
  /** [eid, x, y] ascending eid over all villagers. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly extracted: readonly number[];
  readonly deposited: readonly number[];
  /** Deliveries per stamped camp, indexed by ascending-eid rank. */
  readonly deliveriesByCamp: readonly number[];
  readonly stockpiles: readonly number[];
  readonly carried: readonly number[];
  /** Node remaining aligned to fixture.nodes order. */
  readonly remainingByNodeIndex: readonly number[];
  readonly rejectedByFilter: number;
}

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const diagnostics: GatherDiagnostics = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, diagnostics));

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

  // Stamped camps complete instantly with their definition filters —
  // the bootstrap helper sanctioned for scenario/test fixtures; their
  // eids must line up with the fixture contract.
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

  const nodeIds = fixture.nodes.map((node) => {
    const eid = spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      node.resourceCode,
      node.amount,
    );
    if (eid !== node.eid) {
      throw new Error(
        `fixture node order mismatch: expected eid ${String(node.eid)}, allocated ${String(eid)}`,
      );
    }
    return eid;
  });

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

  const carried = new Array<number>(RESOURCE_COUNT).fill(0);
  for (const spawn of fixture.spawns) {
    const inv = getInventory(world, comps, spawn.eid);
    if (inv && inv.amount > 0) carried[inv.resourceCode]! += inv.amount;
  }

  const remainingByNodeIndex = nodeIds.map(
    (eid) => getResourceNodeRow(world, comps, eid)![1]!,
  );

  return {
    digests,
    finalTick: world.tick,
    allOnPassableTiles,
    positions,
    extracted: [...diagnostics.extractedByResource],
    deposited: [...diagnostics.depositedByResource],
    deliveriesByCamp: [...diagnostics.deliveriesByDropOff],
    stockpiles: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    carried,
    remainingByNodeIndex,
    rejectedByFilter: diagnostics.rejectedByFilter,
  };
}

installSimPurityShims();

describe("golden harness m2t2", () => {
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

  it("sustains the mixed economy with every delivery landing at an accepting camp", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);
    // Filter enforcement never had to refuse anything mid-flight: the
    // choice-time routing already avoided every rejecting camp.
    expect(run.rejectedByFilter).toBe(0);

    // All three camps actively received deliveries (ranks by ascending
    // eid: lumber-camp 8 → 0, mining-camp 9 → 1, mill 10 → 2).
    expect(run.deliveriesByCamp[0]!).toBeGreaterThan(0); // wood → lumber
    expect(run.deliveriesByCamp[1]!).toBeGreaterThan(0); // gold/iron/clay → mining
    expect(run.deliveriesByCamp[2]!).toBeGreaterThan(0); // food → mill

    // Ledger closure PER RESOURCE across all seven §2.6 gatherables:
    // extracted == deposited + still-carried. Stone/coal have no nodes
    // and stay zero end-to-end.
    for (let code = 0; code < RESOURCE_COUNT; code++) {
      expect(run.extracted[code] ?? 0, `resource ${String(code)} ledger`).toBe(
        (run.deposited[code] ?? 0) + (run.carried[code] ?? 0),
      );
    }

    // Node deltas mirror extraction exactly, per resource.
    const nodeCodes = new Set(fixture.nodes.map((node) => node.resourceCode));
    for (const code of nodeCodes) {
      let delta = 0;
      fixture.nodes.forEach((node, index) => {
        if (node.resourceCode !== code) return;
        delta += node.amount - run.remainingByNodeIndex[index]!;
      });
      expect(delta).toBe(run.extracted[code]);
      // Every gathered loop sustained unattended deposit cycles.
      expect(
        run.deposited[code]!,
        `resource ${String(code)} produced no deposits`,
      ).toBeGreaterThan(0);
    }

    // Stockpiles opened at the fixture seed amounts and grew by the
    // deposits alone (stamped camps cost nothing — bootstrap helper).
    const initial = [...fixture.stockpile];
    expect(run.stockpiles).toEqual(
      run.deposited.map((amount, code) => initial[code]! + amount),
    );
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(50);
  });
});

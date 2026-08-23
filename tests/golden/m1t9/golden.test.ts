/**
 * M1-T9 golden harness — SPEC §2.6/§7.
 *
 * Runs the full economy core loop headlessly on the pinned 32×32 map
 * (m1t3 seed bytes): one player stockpile, two drop-off points and five
 * hand-placed resource nodes; twenty villagers receive four gather
 * orders across ticks 10–40 covering food/wood/gold/stone. The main
 * wood node depletes late-run, exercising overflow promotion and
 * partial-load delivery. Milestone digests land every 30th tick plus
 * final into a vitest snapshot; the ledger must close exactly
 * (extracted == deposited + still-carried); slot claims stay exclusive;
 * the whole scenario executes twice AND across both path transports as
 * the extended determinism canary. Milestones regenerate only through
 * `npm run golden:record`; hand-edited digests fail every normal run.
 *
 * Eid layout is part of the fixture contract: villagers take 1–20
 * (matching case.json spawns), the stockpile takes 21, drop-offs 22–23,
 * nodes 24+ in listed order — the commands reference those ids.
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
import {
  getAssignedNode,
  getInventory,
} from "../../../src/sim/components/economy";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  createDropOffPoint,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import { MockPathWorker } from "../../helpers/mock-path-worker";
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

const RESOURCE_SLUG_TO_CODE: Record<string, number> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
};
/** M2 gatherable set: Iron/Coal/Clay join as codes 4–6 (SPEC §2.6). */
const RESOURCE_COUNT = 7;

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
      tileX: requiredNumber(node.tileX, "node.tileX"),
      tileY: requiredNumber(node.tileY, "node.tileY"),
      resourceCode,
      amount: requiredNumber(node.amount, "node.amount"),
    };
  });

  if (!Array.isArray(box.dropOffs) || box.dropOffs.length === 0) {
    throw new Error("fixture case.json: dropOffs must be a non-empty array");
  }
  const dropOffs = box.dropOffs.map((entry) => {
    const point = entry as Record<string, unknown>;
    return {
      x: requiredNumber(point.x, "dropOff.x"),
      y: requiredNumber(point.y, "dropOff.y"),
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
  readonly blockedTicks: number;
  readonly allOnPassableTiles: boolean;
  /** [eid, x, y] ascending eid. */
  readonly positions: readonly (readonly [number, number, number])[];
  readonly extracted: readonly number[];
  readonly deposited: readonly number[];
  readonly deliveries: readonly number[];
  readonly stockpiles: readonly number[];
  readonly carried: readonly number[];
  /** Node remaining aligned to fixture.nodes order. */
  readonly remainingByNodeIndex: readonly number[];
  readonly commandsApplied: number;
}

/** Which transport feeds the scheduler for a scenario run. */
export type RunMode = "sync-fallback" | "worker-mock";

/**
 * Worker-mock delivery script: delay `d` per request id (cycling
 * 0,1,2,0,…). Delay 2 lands LATE and makes step() hold ticks —
 * replay-exactness must survive both regimes.
 */
const MOCK_DELAY_SCRIPT = (requestId: number): number => (requestId - 1) % 3;

function buildScheduler(mode: RunMode): {
  scheduler: PathScheduler;
  advanceMock?: () => void;
} {
  if (mode === "sync-fallback") {
    return { scheduler: new PathScheduler(createSynchronousPathTransport()) };
  }
  const worker = new MockPathWorker(MOCK_DELAY_SCRIPT);
  return {
    scheduler: new PathScheduler(worker.transport),
    advanceMock: () => worker.advanceFrame(),
  };
}

function runScenario(fixture: GoldenCase, mode: RunMode): RunState {
  const { scheduler, advanceMock } = buildScheduler(mode);
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gatherDiagnostics: GatherDiagnostics = createGatherDiagnostics();
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, gatherDiagnostics),
  );

  // Villagers first: eids must line up with the fixture contract.
  for (const spawn of fixture.spawns) {
    const eid = spawnUnit(world, comps, spawn.x, spawn.y);
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
  }
  createPlayerStockpile(world, comps, PLAYER_ONE);
  for (const point of fixture.dropOffs) {
    createDropOffPoint(world, comps, point.x, point.y, PLAYER_ONE);
  }
  const nodeIds = fixture.nodes.map((node) =>
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      node.resourceCode,
      node.amount,
    ),
  );

  for (const command of fixture.commands) world.inbox.submit(command);

  // Held ticks retry the same boundary next frame; cap guards against a
  // transport that never answers.
  const digests: MilestoneDigest[] = [];
  let iterations = 0;
  const iterationCap = fixture.ticks * 20;
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    advanceMock?.();
    step(world);
    iterations += 1;
    if (iterations > iterationCap) {
      throw new Error(
        `scenario failed to reach tick ${String(fixture.ticks)} within ${String(iterationCap)} frames`,
      );
    }
    if (world.tick === before) continue; // held tick: no double record
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
    blockedTicks: scheduler.blockedTicks,
    allOnPassableTiles,
    positions,
    extracted: [...gatherDiagnostics.extractedByResource],
    deposited: [...gatherDiagnostics.depositedByResource],
    deliveries: [...gatherDiagnostics.deliveriesByDropOff],
    stockpiles: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    carried,
    remainingByNodeIndex,
    commandsApplied: gatherDiagnostics.commandsApplied,
  };
}

installSimPurityShims();

describe("golden harness m1t9", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture, "sync-fallback");

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

  it("closes the resource ledger and sustains all four gather loops", () => {
    const run = runScenario(fixture, "sync-fallback");

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);
    expect(run.commandsApplied).toBe(fixture.commands.length);

    // Ledger closure per resource: extracted == deposited + still-carried.
    // Codes 4–6 (iron/coal/clay) have no nodes in this M1 fixture and
    // stay zero across extracted/deposited/carried alike.
    for (let code = 0; code < RESOURCE_COUNT; code++) {
      expect(run.extracted[code] ?? 0).toBe(
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
    }

    // All four gathered resources sustain unattended deposit cycles
    // (SPEC §2.6); this fixture places no iron/coal/clay nodes yet.
    for (const code of nodeCodes) {
      expect(
        run.deposited[code]!,
        `resource ${code} produced no deposits`,
      ).toBeGreaterThan(0);
    }

    // Topbar counts read these exact rows: chrome == sim == digest input.
    expect(run.stockpiles).toEqual(run.deposited);

    // The small main wood node fully depletes late-run.
    expect(run.remainingByNodeIndex[0]).toBe(0);
  });

  it("claims work slots exclusively and releases depleted-node workers", () => {
    const { scheduler } = buildScheduler("sync-fallback");
    const world = createWorld(fixture.seed, {
      size: fixture.size,
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(world, createGatherSystem(comps, scheduler));

    for (const spawn of fixture.spawns) {
      spawnUnit(world, comps, spawn.x, spawn.y);
    }
    createPlayerStockpile(world, comps, PLAYER_ONE);
    for (const point of fixture.dropOffs) {
      createDropOffPoint(world, comps, point.x, point.y, PLAYER_ONE);
    }
    const nodeIds = fixture.nodes.map((node) =>
      spawnResourceNode(
        world,
        comps,
        node.tileX,
        node.tileY,
        node.resourceCode,
        node.amount,
      ),
    );
    for (const command of fixture.commands) world.inbox.submit(command);
    while (world.tick < fixture.ticks) step(world);

    const claimsByNode = new Map<number, [number, number][]>();
    for (const eid of world.entities) {
      const assigned = getAssignedNode(world, comps, eid);
      if (!assigned) continue;
      let list = claimsByNode.get(assigned.nodeEid);
      if (!list) {
        list = [];
        claimsByNode.set(assigned.nodeEid, list);
      }
      list.push([eid, assigned.slotIndex]);
    }

    nodeIds.forEach((nodeEid, index) => {
      const claims = claimsByNode.get(nodeEid) ?? [];
      const slotted = claims.filter(([, slot]) => slot >= 0);
      const overflow = claims.filter(([, slot]) => slot < 0);
      // Slots are exclusive: distinct indexes, bounded by the slot count.
      expect(new Set(slotted.map(([, slot]) => slot)).size).toBe(
        slotted.length,
      );
      for (const [, slot] of slotted) {
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(8);
      }
      expect(slotted.length).toBeLessThanOrEqual(8);
      // Overflow exists only while unclaimed capacity remains elsewhere.
      if (overflow.length > 0) expect(slotted.length).toBe(8);

      const remaining = getResourceNodeRow(world, comps, nodeEid)![1]!;
      if (remaining === 0) {
        // A dry node holds no workers at all.
        expect(claims.length).toBe(0);
      }
      void index;
    });
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture, "sync-fallback");
    const second = runScenario(fixture, "sync-fallback");
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(20);
  });

  it("extended canary across transports: worker-mock replays identically", () => {
    // The scripted mock interleaves out-of-order deliveries and lands
    // some responses LATE (delay 2 > PATH_LATENCY−1), so the sim must
    // hold ticks; digests/state still match the synchronous fallback
    // byte-for-byte even while dozens of gatherers repath (ADR-0003).
    const sync = runScenario(fixture, "sync-fallback");
    const mocked = runScenario(fixture, "worker-mock");

    expect(mocked.finalTick).toBe(sync.finalTick);
    expect(mocked.digests).toEqual(sync.digests);
    expect(mocked.positions).toEqual(sync.positions);
    expect(mocked.extracted).toEqual(sync.extracted);
    expect(mocked.deposited).toEqual(sync.deposited);
    expect(mocked.deliveries).toEqual(sync.deliveries);
    expect(mocked.stockpiles).toEqual(sync.stockpiles);
    expect(mocked.carried).toEqual(sync.carried);
    expect(mocked.remainingByNodeIndex).toEqual(sync.remainingByNodeIndex);
    expect(mocked.allOnPassableTiles).toBe(true);

    // The run genuinely exercised both async regimes.
    expect(sync.blockedTicks).toBe(0);
    expect(mocked.blockedTicks).toBeGreaterThan(0);
  });
});

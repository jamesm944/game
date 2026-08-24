/**
 * M3-T3 golden harness — SPEC §2.3 needs + IAUS pop brain / issue #48.
 *
 * The zero-idle village: six named Pops (Identity/Traits/Skills/Needs
 * rows via the spawnUnit identity branch), nine mixed resource nodes,
 * one drop-off depot, one house foundation — and NOT ONE submitted
 * command. The IAUS brain self-assigns every idle Pop at its staggered
 * 1 Hz think through the shared command interface (gather/build), the
 * gather loop runs unattended, and the stockpile grows on its own.
 *
 * Pinned here:
 * - milestone digests every 30th tick plus final (Needs and
 *   JobCooldown rows ride the digest like any other state);
 * - zero idle Pops at the horizon: every villager ends the window
 *   employed or actively walking a planned chain;
 * - unattended stockpile growth across food+wood+gold+stone;
 * - the extended determinism canary (two identical runs agree
 *   byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getAssignedNode,
  spawnBuildingSite,
  spawnResourceNode,
  spawnUnit,
} from "../../../src/sim/components";
import {
  RESOURCE_CLAY,
  RESOURCE_COAL,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_IRON,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../../../src/sim/components/economy";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createSkillsSystem } from "../../../src/sim/systems/skills";
import { createNeedsSystem } from "../../../src/sim/systems/needs";
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../../../src/sim/ai/popBrain";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

interface GoldenNode {
  readonly tile: readonly [number, number];
  readonly resource: string;
  readonly amount: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly startingResources: readonly number[];
  readonly dropOff: readonly [number, number];
  readonly nodes: readonly GoldenNode[];
  readonly houseSiteTile: readonly [number, number];
  readonly popSpawns: readonly (readonly [number, number])[];
}

const RESOURCE_CODE_OF_SLUG: Readonly<Record<string, number>> = {
  food: RESOURCE_FOOD,
  wood: RESOURCE_WOOD,
  gold: RESOURCE_GOLD,
  stone: RESOURCE_STONE,
  iron: RESOURCE_IRON,
  coal: RESOURCE_COAL,
  clay: RESOURCE_CLAY,
};

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  const box = raw as Record<string, unknown>;
  const pair = (value: unknown): [number, number] => {
    const list = value as unknown[];
    return [Number(list[0]), Number(list[1])];
  };
  return {
    name: String(box.name),
    seed: Number(box.seed),
    size: Number(box.size),
    ticks: Number(box.ticks),
    milestoneEvery: Number(box.milestoneEvery),
    startingResources: (box.startingResources as number[]).map(Number),
    dropOff: pair(box.dropOff),
    nodes: (box.nodes as Record<string, unknown>[]).map((node) => ({
      tile: pair(node.tile),
      resource: String(node.resource),
      amount: Number(node.amount),
    })),
    houseSiteTile: pair(box.houseSiteTile),
    popSpawns: (box.popSpawns as unknown[]).map((spawn) => pair(spawn)),
  };
}

export interface VillageRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly depositedTotal: number;
  readonly extractedTotal: number;
  /** Villager eids with no assignment AND an empty queue at the end. */
  readonly idleEids: number[];
  readonly brainAssignments: number;
  readonly cooldownRowsAtEnd: number;
}

function runScenario(fixture: GoldenCase): VillageRunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gather = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, gather));
  registerSystem(world, createConstructionSystem(comps));
  // Practice awards feed the scorer's skill terms; rust pass included
  // for roster realism even though nothing idles long enough to rust.
  registerSystem(world, createSkillsSystem(comps));
  registerSystem(world, createNeedsSystem(comps));
  const brain = createPopBrainDiagnostics();
  registerSystem(
    world,
    createPopBrainSystem({ comps, players: [PLAYER_ONE], diagnostics: brain }),
  );

  createPlayerStockpile(world, comps, PLAYER_ONE, [
    ...fixture.startingResources,
  ]);
  createDropOffPoint(
    world,
    comps,
    fixture.dropOff[0],
    fixture.dropOff[1],
    PLAYER_ONE,
  );
  for (const node of fixture.nodes) {
    spawnResourceNode(
      world,
      comps,
      node.tile[0],
      node.tile[1],
      RESOURCE_CODE_OF_SLUG[node.resource]!,
      node.amount,
    );
  }
  spawnBuildingSite(
    world,
    comps,
    "house",
    fixture.houseSiteTile[0],
    fixture.houseSiteTile[1],
    {
      playerId: PLAYER_ONE,
    },
  );

  const villagerEids: number[] = [];
  for (const spawn of fixture.popSpawns) {
    villagerEids.push(
      spawnUnit(world, comps, spawn[0], spawn[1], { identity: true }),
    );
  }

  // NO commands — the whole point of the fixture.
  const digests: { tick: number; digest: string }[] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    if (
      world.tick % fixture.milestoneEvery === 0 ||
      world.tick === fixture.ticks
    ) {
      digests.push({ tick: world.tick, digest: computeWorldDigest(world) });
    }
  }

  const idleEids = villagerEids.filter((eid) => {
    const queueLength =
      world.rowsByComponentId.get(comps.activityQueueId)?.get(eid)?.[0] ?? 0;
    return (
      getAssignedNode(world, comps, eid) === undefined &&
      world.rowsByComponentId.get(comps.assignedSiteId)?.has(eid) !== true &&
      world.rowsByComponentId.get(comps.productionJobId)?.has(eid) !== true &&
      queueLength === 0
    );
  });
  const depositedTotal = gather.depositedByResource.reduce((a, b) => a + b, 0);
  const extractedTotal = gather.extractedByResource.reduce((a, b) => a + b, 0);
  return {
    digests,
    depositedTotal,
    extractedTotal,
    idleEids,
    brainAssignments: brain.gathers + brain.builds + brain.produces,
    cooldownRowsAtEnd: world.rowsByComponentId.get(comps.jobCooldownId)!.size,
  };
}

installSimPurityShims();

describe("golden harness m3t3", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks: number[] = [];
    for (
      let tick = fixture.milestoneEvery;
      tick <= fixture.ticks;
      tick += fixture.milestoneEvery
    ) {
      expectedTicks.push(tick);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("runs itself unattended: stockpile grows and nobody idles", () => {
    const run = runScenario(fixture);

    // The brain spoke for the village…
    expect(run.brainAssignments).toBeGreaterThanOrEqual(
      fixture.popSpawns.length,
    );
    // …labor flowed without a single player command (some cargo is
    // legitimately still in transit at the horizon)…
    expect(run.extractedTotal).toBeGreaterThan(40);
    expect(run.depositedTotal).toBeGreaterThan(25);
    expect(run.depositedTotal).toBeLessThanOrEqual(run.extractedTotal);
    // …and the horizon finds every Pop employed or mid-chain.
    expect(run.idleEids).toEqual([]);
    // Anti-thrash cooldowns were stamped as digest-visible state.
    expect(run.cooldownRowsAtEnd).toBeGreaterThan(0);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

/**
 * M3-T7 golden harness — SPEC §2.4 leisure, social bonds & rivals /
 * issue #52.
 *
 * A housed village under the FULL production-style roster — movement,
 * gather, construction, skills, needs, lifecycle, households, SOCIAL,
 * schedules, IAUS brain with the leisure window — on a compressed clock
 * (2400-tick days), and not one command is ever submitted. Traits are
 * staged so the evenings tell a story: a Hedonist/Pious western couple
 * (tavern gold-sink, shrine visits) and a Sociable eastern couple
 * (friend visits that accumulate pairwise Relationship rows). Pinned
 * here:
 *
 * - milestone digests every 600th tick plus final (Relationship pair
 *   rows and SocialEvents logs ride the digest like any other state);
 * - semantic acceptance gates: outings complete every evening (gold
 *   sinks at the tavern, bonds grow between the sociable couple, no
 *   jealousy without a brothel, no rivals without bloodshed), releases
 *   and beddings accumulate daily, nobody naps;
 * - the sampled daily arc across all three days: mornings/noons AWAKE
 *   and working, deep-night ASLEEP at home;
 * - the extended determinism canary (two identical runs agree
 *   byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readActivityQueue,
  spawnResourceNode,
  spawnUnit,
  readNeeds,
  type SimComponents,
} from "../../../src/sim/components";
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
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createSkillsSystem } from "../../../src/sim/systems/skills";
import { createNeedsSystem } from "../../../src/sim/systems/needs";
import {
  createLifecycleDiagnostics,
  createLifecycleSystem,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../../../src/sim/systems/lifecycle";
import {
  createHouseholdDiagnostics,
  createHouseholdsSystem,
} from "../../../src/sim/systems/households";
import { spawnHousehold } from "../../../src/sim/components/household";
import {
  createSchedulesDiagnostics,
  createSchedulesSystem,
} from "../../../src/sim/systems/schedules";
import {
  createSocialDiagnostics,
  createSocialSystem,
  isLeisureTime,
} from "../../../src/sim/systems/social";
import { strongestBondOf } from "../../../src/sim/components/relationship";
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../../../src/sim/ai/popBrain";
import { traitCodeOf } from "../../../src/sim/data/traits";
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
  readonly dayTicks: number;
  readonly adultAgeDays: number;
  readonly elderAgeDays: number;
  readonly lifespanDays: number;
  readonly nextBirthRollTick: number;
  readonly startingResources: readonly number[];
  readonly dropOff: readonly [number, number];
  readonly nodes: readonly GoldenNode[];
  readonly houseTiles: readonly (readonly [number, number])[];
  readonly venueTiles: Readonly<Record<string, readonly [number, number]>>;
  readonly popSpawns: readonly (readonly [number, number])[];
  /** Day-relative sample ticks: [morning, noon, deep night]. */
  readonly sampleMinuteOffsets: readonly [number, number, number];
}

const RESOURCE_CODE_OF_SLUG: Readonly<Record<string, number>> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
  iron: 4,
  coal: 5,
  clay: 6,
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
    dayTicks: Number(box.dayTicks),
    adultAgeDays: Number(box.adultAgeDays),
    elderAgeDays: Number(box.elderAgeDays),
    lifespanDays: Number(box.lifespanDays),
    nextBirthRollTick: Number(box.nextBirthRollTick),
    startingResources: (box.startingResources as number[]).map(Number),
    dropOff: pair(box.dropOff),
    nodes: (box.nodes as Record<string, unknown>[]).map((node) => ({
      tile: pair(node.tile),
      resource: String(node.resource),
      amount: Number(node.amount),
    })),
    houseTiles: (box.houseTiles as unknown[]).map((tile) => pair(tile)),
    venueTiles: Object.fromEntries(
      Object.entries(box.venueTiles as Record<string, unknown>).map(
        ([key, value]) => [key, pair(value)],
      ),
    ) as GoldenCase["venueTiles"],
    popSpawns: (box.popSpawns as unknown[]).map((spawn) => pair(spawn)),
    sampleMinuteOffsets: (box.sampleMinuteOffsets as number[]).map(Number) as [
      number,
      number,
      number,
    ],
  };
}

export interface ArcSample {
  readonly tick: number;
  /** Queue-head kind per scheduled Pop, ascending eid ("none" = idle). */
  readonly headKinds: string[];
  /** Rest meter per scheduled Pop, ascending eid. */
  readonly restLevels: number[];
  /** Distance from each Pop to its own home center (tiles). */
  readonly homeDistances: number[];
  readonly population: number;
  readonly depositedTotal: number;
}

export interface VillageRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly arc: ArcSample[];
  readonly diagnostics: {
    releasedToHome: number;
    beddedNights: number;
    wakesCompleted: number;
    napsTaken: number;
    brainLeisures: number;
    leisuresCompleted: number;
    goldSpent: number;
    visitsCompleted: number;
    jealousyEvents: number;
    rivalriesFormed: number;
    sociableBond: number;
    depositedTotal: number;
  };
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
  const cfg: LifecycleConfig = normalizeLifecycleConfig({
    dayTicks: fixture.dayTicks,
    adultAgeDays: fixture.adultAgeDays,
    elderAgeDays: fixture.elderAgeDays,
    lifespanDays: fixture.lifespanDays,
  });

  // Full production-style roster; social runs after households and
  // before schedules exactly like session.ts wires it.
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gather = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, gather));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createSkillsSystem(comps));
  registerSystem(world, createNeedsSystem(comps));
  const lifeDiagnostics = createLifecycleDiagnostics();
  registerSystem(world, createLifecycleSystem(comps, cfg, lifeDiagnostics));
  const householdDiagnostics = createHouseholdDiagnostics();
  registerSystem(
    world,
    createHouseholdsSystem(comps, cfg, householdDiagnostics),
  );
  const socialDiagnostics = createSocialDiagnostics();
  registerSystem(
    world,
    createSocialSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      diagnostics: socialDiagnostics,
    }),
  );
  const schedulesDiagnostics = createSchedulesDiagnostics();
  registerSystem(
    world,
    createSchedulesSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      diagnostics: schedulesDiagnostics,
    }),
  );
  const brainDiagnostics = createPopBrainDiagnostics();
  registerSystem(
    world,
    createPopBrainSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      diagnostics: brainDiagnostics,
      leisureWindow: (tick) => isLeisureTime(tick, cfg),
    }),
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
  const houseEids: number[] = [];
  for (const tile of fixture.houseTiles) {
    houseEids.push(
      stampFinishedBuilding(world, comps, "house", tile[0], tile[1], {
        playerId: PLAYER_ONE,
      }),
    );
  }
  for (const [defId, tile] of Object.entries(fixture.venueTiles)) {
    stampFinishedBuilding(world, comps, defId, tile[0], tile[1], {
      playerId: PLAYER_ONE,
    });
  }

  const founderEids: number[] = [];
  for (const spawn of fixture.popSpawns) {
    founderEids.push(
      spawnUnit(world, comps, spawn[0], spawn[1], {
        identity: true,
        body: true,
        ownerId: PLAYER_ONE,
      }),
    );
  }
  // Staged cast: the western couple is Hedonist + Pious; the eastern
  // couple is Sociable + Sociable. Two pre-formed households keep every
  // Pop home'd from tick 0; birth rolls pushed beyond the horizon.
  const staged = ["hedonist", "pious", "sociable", "sociable"];
  founderEids.forEach((eid, index) => {
    world.rowsByComponentId
      .get(comps.traitsId)!
      .set(eid, [traitCodeOf(staged[index]!)]);
  });
  spawnHousehold(world, comps, {
    playerId: PLAYER_ONE,
    homeEid: houseEids[0]!,
    headEid: founderEids[0]!,
    partnerEid: founderEids[1]!,
    nextBirthRollTick: fixture.nextBirthRollTick,
  });
  spawnHousehold(world, comps, {
    playerId: PLAYER_ONE,
    homeEid: houseEids[1]!,
    headEid: founderEids[2]!,
    partnerEid: founderEids[3]!,
    nextBirthRollTick: fixture.nextBirthRollTick,
  });

  const homeCenters = fixture.houseTiles.map((tile) => ({
    x: tile[0] + 1,
    y: tile[1] + 1,
  }));
  const morningOffset = fixture.sampleMinuteOffsets[0];
  const noonOffset = fixture.sampleMinuteOffsets[1];
  const nightOffset = fixture.sampleMinuteOffsets[2];

  const digests: { tick: number; digest: string }[] = [];
  const arc: ArcSample[] = [];

  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    const minuteOfDayTick =
      ((tick % fixture.dayTicks) * 1440) / fixture.dayTicks;

    if (
      minuteOfDayTick === morningOffset ||
      minuteOfDayTick === noonOffset ||
      minuteOfDayTick === nightOffset
    ) {
      const headKinds: string[] = [];
      const restLevels: number[] = [];
      const homeDistances: number[] = [];
      for (let i = 0; i < founderEids.length; i++) {
        const eid = founderEids[i]!;
        const head = readActivityQueue(world, comps, eid)[0];
        headKinds.push(head?.kind ?? "none");
        restLevels.push(readNeeds(world, comps, eid)?.rest ?? -1);
        const center = homeCenters[Math.floor(i / 2)]!;
        const pos = world.rowsByComponentId.get(comps.positionId)!.get(eid)!;
        homeDistances.push(Math.hypot(pos[0]! - center.x, pos[1]! - center.y));
      }
      arc.push({
        tick,
        headKinds,
        restLevels,
        homeDistances,
        population: countPops(world, comps),
        depositedTotal: gather.depositedByResource.reduce((a, b) => a + b, 0),
      });
    }
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  return {
    digests,
    arc,
    diagnostics: {
      releasedToHome: schedulesDiagnostics.releasedToHome,
      beddedNights: schedulesDiagnostics.beddedNights,
      wakesCompleted: schedulesDiagnostics.wakesCompleted,
      napsTaken: schedulesDiagnostics.napsTaken,
      brainLeisures: brainDiagnostics.leisures,
      leisuresCompleted: socialDiagnostics.leisuresCompleted,
      goldSpent: socialDiagnostics.goldSpent,
      visitsCompleted: socialDiagnostics.visitsCompleted,
      jealousyEvents: socialDiagnostics.jealousyEvents,
      rivalriesFormed: socialDiagnostics.rivalriesFormed,
      sociableBond: strongestBondOf(world, comps, founderEids[2]!) || 0,
      depositedTotal: gather.depositedByResource.reduce((a, b) => a + b, 0),
    },
  };
}

function countPops(
  world: ReturnType<typeof createWorld>,
  comps: SimComponents,
): number {
  return world.rowsByComponentId.get(comps.unitTagId)?.size ?? 0;
}

installSimPurityShims();

describe("golden harness m3t7", () => {
  const fixture = loadGoldenCase();
  const days = fixture.ticks / fixture.dayTicks;

  it("records milestone digests at every 600th tick plus final", () => {
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

  it("an evening of village social life, every evening", () => {
    const run = runScenario(fixture);

    // The village kept its schedule across the golden days…
    expect(run.diagnostics.releasedToHome).toBeGreaterThanOrEqual(
      4 * (days - 1),
    );
    expect(run.diagnostics.beddedNights).toBeGreaterThanOrEqual(4 * (days - 1));
    expect(run.diagnostics.wakesCompleted).toBe(4 * (days - 1));
    expect(run.diagnostics.napsTaken).toBe(0);

    // …and its evenings were SOCIAL: the brain booked outings, some
    // completed with gold sunk at the tavern, the sociable couple's
    // bond accumulated, and no drama fired without a brothel or blood.
    expect(run.diagnostics.brainLeisures).toBeGreaterThan(0);
    expect(run.diagnostics.leisuresCompleted).toBeGreaterThanOrEqual(days);
    expect(run.diagnostics.goldSpent).toBeGreaterThanOrEqual(2);
    expect(run.diagnostics.visitsCompleted).toBeGreaterThan(0);
    expect(run.diagnostics.sociableBond).toBeGreaterThanOrEqual(10);
    expect(run.diagnostics.jealousyEvents).toBe(0);
    expect(run.diagnostics.rivalriesFormed).toBe(0);

    // The sampled arc pins the daily rhythm.
    expect(run.arc).toMatchSnapshot();
    const samplesPerDay = 3;
    expect(run.arc.length).toBe(days * samplesPerDay);
    for (let d = 0; d < days; d++) {
      const night = run.arc[d * samplesPerDay]!;
      const morning = run.arc[d * samplesPerDay + 1]!;
      for (let p = 0; p < 4; p++) {
        if (d === 0) continue; // pre-dawn sample predates first evening
        expect(
          night.headKinds[p],
          `day ${String(d)} pop ${String(p)} asleep`,
        ).toBe("sleep");
        expect(
          morning.headKinds[p],
          `day ${String(d)} pop ${String(p)} awake`,
        ).not.toBe("sleep");
        expect(morning.restLevels[p]!).toBeGreaterThanOrEqual(90);
      }
    }
    expect(run.diagnostics.beddedNights).toBeGreaterThanOrEqual(
      run.diagnostics.wakesCompleted,
    );
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

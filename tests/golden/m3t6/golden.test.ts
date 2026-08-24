/**
 * M3-T6 golden harness — SPEC §2.4 day/night, schedules & sleep /
 * issue #51.
 *
 * A housed village week on a COMPRESSED clock (600-tick days) with the
 * full production-style roster — movement, gather, construction,
 * skills, needs, lifecycle, households, school, schedules, IAUS brain —
 * and not one command is ever submitted. Since M3-T8 the seventh day of
 * that week IS a §2.4 Sunday: the brain wires the same rest-day
 * predicates as session.ts, so day 6 closes work windows and the
 * village keeps it. Pinned here:
 *
 * - milestone digests every 300th tick plus final (Sleep activities and
 *   hold Waits ride the digest inside ActivityQueue rows like any other
 *   state — no new components were registered for T6);
 * - the sampled daily arc across all seven days: mornings/noons AWAKE
 *   (no Sleep head, meters draining from the wake refill, gather work
 *   flowing), nights ASLEEP (every scheduled Pop's queue head is a
 *   Sleep activity parked at its household's bed slot);
 * - semantic acceptance gates: end-of-work releases and night beddings
 *   accumulate every WORKING day (the village sleeps/wakes ON SCHEDULE
 *   across the golden week; Sunday contributes bedding but no evening
 *   release wave — its windows never opened), wakes refill Rest to the
 *   housing-quality × crowding ceiling so well-housed Pops never fall
 *   into deprivation, deposits grow week over week, and no naps fire
 *   without deprivation;
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
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../../../src/sim/ai/popBrain";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { isRestDay } from "../../../src/sim/systems/schedules";
import { MASS_CLOSE_MINUTE } from "../../../src/sim/systems/mass";
import { minuteOfDay } from "../../../src/sim/systems/lifecycle";

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
  readonly popSpawns: readonly (readonly [number, number])[];
  /** Day-relative sample minutes: [morning, noon, night]. */
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
    brainAssignments: number;
    familiesFormed: number;
    birthsRolled: number;
    naturalDeaths: number;
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

  // Full production-style roster; schedules runs after school (whose
  // slot it mirrors in session.ts) and before the brain.
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
  // M3-T7: social runs between school and schedules in production; the
  // harness mirrors session.ts so evenings score venues (visits here —
  // the fixture builds no tavern/church).
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
      // M3-T8 parity with session.ts: day 6 of the golden week is a
      // §2.4 Sunday — the brain refuses work candidates and keeps
      // private leisure to the post-Mass afternoon onward.
      restDay: (tick) => isRestDay(tick, cfg),
      restDayLeisureWindow: (tick) =>
        minuteOfDay(tick, cfg) >= MASS_CLOSE_MINUTE,
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
  // Two pre-formed households so every Pop has a home from tick 0; birth
  // rolls are pushed far beyond the run to keep the cast fixed.
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
    const minuteOfDayTick = tick % fixture.dayTicks;

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
      brainAssignments:
        brainDiagnostics.gathers +
        brainDiagnostics.builds +
        brainDiagnostics.produces,
      familiesFormed: householdDiagnostics.familiesFormed,
      birthsRolled: householdDiagnostics.birthsRolled,
      naturalDeaths: lifeDiagnostics.naturalDeaths,
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

describe("golden harness m3t6", () => {
  const fixture = loadGoldenCase();
  const days = fixture.ticks / fixture.dayTicks;

  it("records milestone digests at every 300th tick plus final", () => {
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

  it("sleeps and wakes on schedule across the golden week", () => {
    const run = runScenario(fixture);

    // Every WORKING day produced its evening release wave and its night
    // bedding; each night but the horizon's last gets its morning wake
    // refills inside the run (the village sleeps/wakes ON SCHEDULE
    // across the golden week). M3-T8: day 6 is a §2.4 Sunday — work
    // windows never opened, so it contributes no evening releases.
    expect(run.diagnostics.releasedToHome).toBeGreaterThanOrEqual(
      4 * (days - 1),
    );
    expect(run.diagnostics.beddedNights).toBeGreaterThanOrEqual(4 * days);
    expect(run.diagnostics.wakesCompleted).toBe(4 * (days - 1));
    // A healthy housed village never gets tired enough to nap.
    expect(run.diagnostics.napsTaken).toBe(0);
    // The village worked for its living all week; nothing died, nobody
    // new moved in (birth rolls pinned beyond the horizon).
    expect(run.diagnostics.brainAssignments).toBeGreaterThan(0);
    expect(run.diagnostics.familiesFormed).toBe(0);
    expect(run.diagnostics.birthsRolled).toBe(0);
    expect(run.diagnostics.naturalDeaths).toBe(0);
    expect(run.diagnostics.beddedNights).toBeGreaterThanOrEqual(
      run.diagnostics.wakesCompleted,
    );

    // The sampled arc pins the exact daily rhythm: deep night (01:40 —
    // after every evening walker has reached its bed), then morning
    // (06:40, post-wake refill) and noon (12:30).
    expect(run.arc).toMatchSnapshot();

    const samplesPerDay = 3;
    expect(run.arc.length).toBe(days * samplesPerDay);
    for (let d = 0; d < days; d++) {
      const night = run.arc[d * samplesPerDay]!;
      const morning = run.arc[d * samplesPerDay + 1]!;
      const noon = run.arc[d * samplesPerDay + 2]!;
      const label = `day ${String(d)}`;

      // Deep night: EVERY scheduled Pop is asleep at its own home (the
      // previous evening's bedding). Day 0's sample predates the first
      // evening, so the village is simply awake there.
      for (let p = 0; p < 4; p++) {
        if (d === 0) {
          expect(
            night.headKinds[p],
            `${label} pre-dawn pop ${String(p)}`,
          ).not.toBe("sleep");
          continue;
        }
        expect(
          night.headKinds[p],
          `${label} night pop ${String(p)} asleep`,
        ).toBe("sleep");
        expect(
          night.homeDistances[p]!,
          `${label} night pop ${String(p)} at home`,
        ).toBeLessThan(3.5);
      }

      // Morning: everyone woke (Sleep heads popped by the schedule
      // system) and their rest was refilled toward full — a perfect
      // House night (quality 1 × crowding 2/5 → factor 1) pays the
      // whole meter back, so nobody starts the day deprived.
      for (let p = 0; p < 4; p++) {
        expect(
          morning.headKinds[p],
          `${label} pop ${String(p)} awake`,
        ).not.toBe("sleep");
        expect(
          morning.restLevels[p]!,
          `${label} pop ${String(p)} rested`,
        ).toBeGreaterThanOrEqual(90);
      }
      // Noon: broad daylight, still nobody asleep.
      for (let p = 0; p < 4; p++) {
        expect(noon.headKinds[p], `${label} noon pop ${String(p)}`).not.toBe(
          "sleep",
        );
      }
    }
    // The village earned its keep across the week: nightly releases
    // discard partial gathers (schedule outranks chain progress), so
    // deliveries land on multi-day cadences — pin week-scale growth,
    // not per-day monotony.
    const firstNoon = run.arc[2]!.depositedTotal;
    const lastArc = run.arc[run.arc.length - 1]!;
    expect(lastArc.depositedTotal).toBeGreaterThan(firstNoon);
    expect(run.diagnostics.brainAssignments).toBeGreaterThan(days); // re-staffed after every wake
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

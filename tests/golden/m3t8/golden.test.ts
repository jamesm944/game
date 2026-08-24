/**
 * M3-T8 golden harness — SPEC §2.4 weekly cycle, Sunday & Mass /
 * issue #53.
 *
 * A housed village FORTNIGHT on a compressed clock (2400-tick days,
 * Monday-first week) under the full production-style roster — movement,
 * gather, construction, skills, needs, lifecycle, households, MASS,
 * social, schedules, IAUS brain with the leisure + rest-day windows —
 * and not one command is ever submitted. Days 6 and 13 are §2.4
 * Sundays; every other day is an ordinary workday. The harness runs the
 * fixture TWICE, differing in exactly one stamp: variant A builds the
 * Church, variant B does not (the control). Pinned here:
 *
 * - milestone digests every 600th tick plus final for BOTH variants
 *   (Relationship pair rows and SocialEvents logs ride the digest like
 *   any other state);
 * - Mass fires ONLY with the Church: A books and completes congregational
 *   outings on both Sundays (broad morale buff, Pious extra weight,
 *   pairwise bond increments across co-attendees, digest-visible MASS
 *   events), B books nothing and never logs one;
 * - essential roles still staff Sundays: no gather/build assignment is
 *   ever seen on a sampled Sunday minute, while the kitchen keeps its
 *   rest-day-capped crew (1 slot of 1) running;
 * - the week calendar advances deterministically across all fourteen
 *   days (Monday-first naming, rest days exactly at 6 and 13);
 * - the sampled daily arc pins the daily rhythm: deep night asleep at
 *   home, mornings awake and rested, weekdays working;
 * - the extended determinism canary: two identical runs of EACH variant
 *   agree byte-for-byte.
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
  createCommodityStockpile,
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
import { getAssignedNode } from "../../../src/sim/components/economy";
import { getProductionJob } from "../../../src/sim/components/production";
import { strongestBondOf } from "../../../src/sim/components/relationship";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createProductionSystem } from "../../../src/sim/systems/production";
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
  DAYS_PER_WEEK,
  SUNDAY_DAY_INDEX,
  createSchedulesDiagnostics,
  createSchedulesSystem,
  isRestDay,
  weekdayNameOf,
} from "../../../src/sim/systems/schedules";
import {
  MASS_CLOSE_MINUTE,
  createMassDiagnostics,
  createMassSystem,
} from "../../../src/sim/systems/mass";
import {
  createSocialDiagnostics,
  createSocialSystem,
  isLeisureTime,
} from "../../../src/sim/systems/social";
import { minuteOfDay } from "../../../src/sim/systems/lifecycle";
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
  /** Day-relative sample ticks: [night, morning, noon]. */
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
  /** Live gather assignments at the sample minute. */
  readonly gatherAssigned: number;
  /** Live production assignments at the sample minute. */
  readonly produceAssigned: number;
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
    brainProduces: number;
    leisuresCompleted: number;
    goldSpent: number;
    visitsCompleted: number;
    jealousyEvents: number;
    rivalriesFormed: number;
    massesPlanned: number;
    massesCompleted: number;
    expiredMasses: number;
    massBondIncrements: number;
    massMoraleGranted: number;
    sociableBond: number;
    depositedTotal: number;
    population: number;
  };
}

/**
 * Run the fortnight. `withChurch` stamps the venueTiles church entry
 * (variant A); without it the identical village keeps a plain-leisure
 * §2.4 Sunday (variant B).
 */
function runScenario(
  fixture: GoldenCase,
  withChurch: boolean,
): VillageRunState {
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

  // Full production-style roster; school → mass → social → schedules →
  // brain mirrors session.ts ordering exactly.
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gather = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, gather));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createProductionSystem(comps));
  registerSystem(world, createSkillsSystem(comps));
  registerSystem(world, createNeedsSystem(comps));
  const lifeDiagnostics = createLifecycleDiagnostics();
  registerSystem(world, createLifecycleSystem(comps, cfg, lifeDiagnostics));
  const householdDiagnostics = createHouseholdDiagnostics();
  registerSystem(
    world,
    createHouseholdsSystem(comps, cfg, householdDiagnostics),
  );
  const massDiagnostics = createMassDiagnostics();
  registerSystem(
    world,
    createMassSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      diagnostics: massDiagnostics,
    }),
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
      // M3-T8: Sundays close non-essential work and weight leisure/home
      // above marginal labor once Morning Mass is over.
      restDay: (tick) => isRestDay(tick, cfg),
      restDayLeisureWindow: (tick) =>
        minuteOfDay(tick, cfg) >= MASS_CLOSE_MINUTE,
    }),
  );

  createPlayerStockpile(world, comps, PLAYER_ONE, [
    ...fixture.startingResources,
  ]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
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
    if (defId === "church" && !withChurch) continue; // the control variant
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
  // couple Industrious + Sociable. Two pre-formed households keep every
  // Pop home'd from tick 0; birth rolls pushed beyond the horizon.
  const staged = ["hedonist", "pious", "industrious", "sociable"];
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
  const nightOffset = fixture.sampleMinuteOffsets[0];
  const morningOffset = fixture.sampleMinuteOffsets[1];
  const noonOffset = fixture.sampleMinuteOffsets[2];

  const digests: { tick: number; digest: string }[] = [];
  const arc: ArcSample[] = [];

  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    const minuteOfDayTick =
      ((tick % fixture.dayTicks) * 1440) / fixture.dayTicks;

    if (
      minuteOfDayTick === nightOffset ||
      minuteOfDayTick === morningOffset ||
      minuteOfDayTick === noonOffset
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
      let gatherAssigned = 0;
      for (const eid of founderEids) {
        if (getAssignedNode(world, comps, eid) !== undefined) gatherAssigned++;
      }
      let produceAssigned = 0;
      for (const eid of founderEids) {
        if (getProductionJob(world, comps, eid) !== undefined) {
          produceAssigned++;
        }
      }
      arc.push({
        tick,
        headKinds,
        restLevels,
        homeDistances,
        gatherAssigned,
        produceAssigned,
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
      brainProduces: brainDiagnostics.produces,
      leisuresCompleted: socialDiagnostics.leisuresCompleted,
      goldSpent: socialDiagnostics.goldSpent,
      visitsCompleted: socialDiagnostics.visitsCompleted,
      jealousyEvents: socialDiagnostics.jealousyEvents,
      rivalriesFormed: socialDiagnostics.rivalriesFormed,
      massesPlanned: massDiagnostics.massesPlanned,
      massesCompleted: socialDiagnostics.massesCompleted,
      expiredMasses: massDiagnostics.expiredMasses,
      massBondIncrements: socialDiagnostics.massBondIncrements,
      massMoraleGranted: socialDiagnostics.massMoraleGranted,
      sociableBond: strongestBondOf(world, comps, founderEids[3]!) || 0,
      depositedTotal: gather.depositedByResource.reduce((a, b) => a + b, 0),
      population: countPops(world, comps),
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

describe("golden harness m3t8", () => {
  const fixture = loadGoldenCase();
  const days = fixture.ticks / fixture.dayTicks;

  it("records milestone digests at every 600th tick plus final (with Church)", () => {
    const run = runScenario(fixture, true);

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

  it("records milestone digests at every 600th tick plus final (no Church)", () => {
    const run = runScenario(fixture, false);

    expect(run.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("the week calendar advances deterministically across the fortnight", () => {
    // Pure calendar math first: fourteen Mondays-first names, rest days
    // exactly at 6 and 13 under the fixture's compressed clock.
    const cfg = compressedOf(fixture);
    const names: string[] = [];
    for (let d = 0; d < days; d++) {
      names.push(weekdayNameOf(d));
      const probe = d * fixture.dayTicks + Math.floor(fixture.dayTicks / 2);
      expect(isRestDay(probe, cfg)).toBe(
        d % DAYS_PER_WEEK === SUNDAY_DAY_INDEX,
      );
    }
    expect(names[0]).toBe("monday");
    expect(names[6]).toBe("sunday");
    expect(names[7]).toBe("monday");
    expect(names[13]).toBe("sunday");

    const run = runScenario(fixture, true);
    // The sampled arc covers all fourteen days, three samples each, and
    // every sample's day index agrees with its weekday slot.
    expect(run.arc.length).toBe(days * 3);
    for (const sample of run.arc) {
      const dayIndex = Math.floor(sample.tick / fixture.dayTicks);
      expect(isRestDay(sample.tick, cfg)).toBe(
        dayIndex % DAYS_PER_WEEK === SUNDAY_DAY_INDEX,
      );
    }
    expect(run.diagnostics.population).toBe(4); // nobody born, nobody lost
  });

  it("Morning Mass fires only with the Church, boosting morale and bonds", () => {
    const withChurch = runScenario(fixture, true);
    const withoutChurch = runScenario(fixture, false);

    // Variant A: both Sundays saw the whole congregation book, most
    // arrive in time for the blessing, and the bonds/morale follow.
    expect(withChurch.diagnostics.massesPlanned).toBeGreaterThanOrEqual(8);
    expect(withChurch.diagnostics.massesCompleted).toBeGreaterThanOrEqual(4);
    expect(withChurch.diagnostics.expiredMasses).toBeLessThan(4);
    expect(withChurch.diagnostics.massBondIncrements).toBeGreaterThan(0);
    expect(withChurch.diagnostics.massMoraleGranted).toBeGreaterThan(0);
    expect(withChurch.diagnostics.sociableBond).toBeGreaterThanOrEqual(10);

    // Variant B: identical village minus one stamp — zero Mass surface.
    expect(withoutChurch.diagnostics.massesPlanned).toBe(0);
    expect(withoutChurch.diagnostics.massesCompleted).toBe(0);
    expect(withoutChurch.diagnostics.expiredMasses).toBe(0);
    expect(withoutChurch.diagnostics.massBondIncrements).toBe(0);
    expect(withoutChurch.diagnostics.massMoraleGranted).toBe(0);

    // Both variants kept their evenings otherwise social and drama-free:
    // gold sinks at the tavern, visits between friends, no jealousy
    // without a brothel and no rivals without bloodshed.
    for (const run of [withChurch, withoutChurch]) {
      expect(run.diagnostics.brainLeisures).toBeGreaterThan(0);
      expect(run.diagnostics.leisuresCompleted).toBeGreaterThan(0);
      expect(run.diagnostics.goldSpent).toBeGreaterThanOrEqual(2);
      expect(run.diagnostics.visitsCompleted).toBeGreaterThan(0);
      expect(run.diagnostics.jealousyEvents).toBe(0);
      expect(run.diagnostics.rivalriesFormed).toBe(0);
      expect(run.diagnostics.napsTaken).toBe(0);
    }
  });

  it("essential roles stay staffed on Sundays while work windows close", () => {
    const run = runScenario(fixture, true);
    const cfg = compressedOf(fixture);

    let sundaySamples = 0;
    let weekdayWorkingNoons = 0;
    let sundayStaffedSamples = 0;
    for (const sample of run.arc) {
      const dayIndex = Math.floor(sample.tick / fixture.dayTicks);
      const minute =
        ((sample.tick % fixture.dayTicks) * 1440) / fixture.dayTicks;
      if (isRestDay(sample.tick, cfg)) {
        sundaySamples++;
        // No gather/build assignment survives a sampled Sunday minute…
        expect(sample.gatherAssigned).toBe(0);
        // …and essential production never exceeds its half-staff cap.
        expect(sample.produceAssigned).toBeLessThanOrEqual(1);
        if (sample.produceAssigned > 0 && minute > 5 * 60) {
          sundayStaffedSamples++;
        }
      } else if (minute === 720 && dayIndex > 0) {
        if (sample.gatherAssigned > 0 || sample.produceAssigned > 0) {
          weekdayWorkingNoons++;
        }
      }
    }
    expect(sundaySamples).toBe(6); // three samples × two Sundays
    expect(sundayStaffedSamples).toBeGreaterThanOrEqual(1); // essentials ran
    expect(weekdayWorkingNoons).toBeGreaterThan(0); // contrast: weeks work

    // The schedule machinery kept its rhythm across the whole fortnight:
    // twelve evening release waves plus two Sunday dawn releases at the
    // minimum, bedding every night, a wake every morning but the last.
    expect(run.diagnostics.releasedToHome).toBeGreaterThanOrEqual(
      4 * (days - 2),
    );
    expect(run.diagnostics.beddedNights).toBeGreaterThanOrEqual(4 * days);
    expect(run.diagnostics.wakesCompleted).toBe(4 * (days - 1));
  });

  it("pins the sampled daily arc of both variants", () => {
    const withChurch = runScenario(fixture, true);
    const withoutChurch = runScenario(fixture, false);

    expect(withChurch.arc).toMatchSnapshot();
    expect(withoutChurch.arc).toMatchSnapshot();

    // Deep-night samples find everyone home asleep on both variants;
    // mornings find them awake and rested again. A rare late bed-walk
    // (a household mate parked on the shared door ring can stall the
    // final approach) still counts as "home" — the head must be a Move
    // within a bed's throw of the house, never work or an outing.
    const samplesPerDay = 3;
    for (const run of [withChurch, withoutChurch]) {
      for (let d = 1; d < days; d++) {
        const night = run.arc[d * samplesPerDay]!;
        const morning = run.arc[d * samplesPerDay + 1]!;
        for (let p = 0; p < 4; p++) {
          const nightHead = night.headKinds[p]!;
          expect(
            nightHead === "sleep" ||
              (nightHead === "move" && night.homeDistances[p]! < 3.5),
            `day ${String(d)} pop ${String(p)} home in bed`,
          ).toBe(true);
          expect(
            morning.headKinds[p],
            `day ${String(d)} pop ${String(p)} awake`,
          ).not.toBe("sleep");
          expect(morning.restLevels[p]!).toBeGreaterThanOrEqual(90);
        }
      }
    }
    expect(withChurch.diagnostics.beddedNights).toBeGreaterThanOrEqual(
      withChurch.diagnostics.wakesCompleted,
    );
  });

  it("extended canary: two identical runs of each variant agree byte-for-byte", () => {
    const firstA = runScenario(fixture, true);
    const secondA = runScenario(fixture, true);
    expect(secondA).toEqual(firstA);

    const firstB = runScenario(fixture, false);
    const secondB = runScenario(fixture, false);
    expect(secondB).toEqual(firstB);

    // And the two variants genuinely differ — the Church leaves a mark.
    expect(firstB).not.toEqual(firstA);
    expect(firstA.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

function compressedOf(fixture: GoldenCase): LifecycleConfig {
  return normalizeLifecycleConfig({
    dayTicks: fixture.dayTicks,
    adultAgeDays: fixture.adultAgeDays,
    elderAgeDays: fixture.elderAgeDays,
    lifespanDays: fixture.lifespanDays,
  });
}

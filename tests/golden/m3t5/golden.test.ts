/**
 * M3-T5 golden harness — SPEC §2.3 lifecycle, households & school /
 * issue #50.
 *
 * The self-running generational village: four founding adults arrive
 * beside two houses and a finished School on a COMPRESSED clock
 * (600-tick days; adult 3d, elder 8d, lifespan 10d) and not one
 * command is ever submitted. Pinned here:
 *
 * - milestone digests every 300th tick plus final — Household,
 *   Lessons, Identity (origin column), Skills, Traits rows all ride
 *   the digest like any other state;
 * - the sampled lifecycle arc at day boundaries: founders adult →
 *   elder light duty (day 5) → natural death (day 7); firstborn child
 *   → schooled graduate at the exact adult boundary (day 5) → working
 *   adult → elder; population troughs and recovers across generations;
 * - semantic acceptance gates: households form on housing+food
 *   surplus, births scale with housed families (seeded daily rolls),
 *   school graduates are measurably better (attendance credit pays a
 *   guaranteed bonus trait + knowledge XP under a teacher-gated
 *   ceiling), adult gates hold (the brain records child skips while
 *   adults do the village's work);
 * - the extended determinism canary (two identical runs agree
 *   byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readIdentity,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../../../src/sim/components/pop";
import { readLessons } from "../../../src/sim/components/lessons";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
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
import {
  awardPractice,
  createSkillsSystem,
  totalXpOf,
} from "../../../src/sim/systems/skills";
import {
  createLifecycleDiagnostics,
  createLifecycleSystem,
  lifeStageOf,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../../../src/sim/systems/lifecycle";
import {
  createHouseholdDiagnostics,
  createHouseholdsSystem,
} from "../../../src/sim/systems/households";
import {
  createSchoolDiagnostics,
  createSchoolSystem,
} from "../../../src/sim/systems/school";
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../../../src/sim/ai/popBrain";
import { SKILL_SLUGS } from "../../../src/sim/data/skills";
import { createNeedsSystem } from "../../../src/sim/systems/needs";
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
  readonly startingResources: readonly number[];
  readonly dropOff: readonly [number, number];
  readonly nodes: readonly GoldenNode[];
  readonly houseTiles: readonly (readonly [number, number])[];
  readonly schoolTile: readonly [number, number];
  readonly popSpawns: readonly (readonly [number, number])[];
  readonly teacherIndex: number;
  readonly teacherGatheringXp: number;
  readonly arcSampleTicks: readonly number[];
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
    startingResources: (box.startingResources as number[]).map(Number),
    dropOff: pair(box.dropOff),
    nodes: (box.nodes as Record<string, unknown>[]).map((node) => ({
      tile: pair(node.tile),
      resource: String(node.resource),
      amount: Number(node.amount),
    })),
    houseTiles: (box.houseTiles as unknown[]).map((tile) => pair(tile)),
    schoolTile: pair(box.schoolTile),
    popSpawns: (box.popSpawns as unknown[]).map((spawn) => pair(spawn)),
    teacherIndex: Number(box.teacherIndex),
    teacherGatheringXp: Number(box.teacherGatheringXp),
    arcSampleTicks: (box.arcSampleTicks as number[]).map(Number),
  };
}

export interface ArcSample {
  readonly tick: number;
  readonly founderStage: string;
  readonly firstbornStage: string | undefined;
  readonly firstbornLessons: number;
  readonly firstbornGraduated: boolean;
  readonly population: number;
  readonly familiesFormed: number;
  readonly births: number;
  readonly deaths: number;
  readonly graduates: number;
  readonly food: number;
}

export interface VillageRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly arc: ArcSample[];
  /** First BIRTH-origin pop (lowest eid) — the pinned firstborn. */
  readonly firstbornEid: number | undefined;
  /** Total knowledge XP of the first graduated pop, all subjects. */
  readonly graduateKnowledge: number | undefined;
  readonly diagnostics: {
    familiesFormed: number;
    birthsRolled: number;
    birthsBlocked: number;
    naturalDeaths: number;
    lessonsTaught: number;
    knowledgeGranted: number;
    traitsPlanted: number;
    graduatesCredited: number;
    brainChildSkips: number;
    brainAssignments: number;
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

  registerSystem(world, createMovementSystem(comps, scheduler));
  const gather = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, gather));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createSkillsSystem(comps));
  registerSystem(world, createNeedsSystem(comps));
  // M3-T5 roster: lifecycle deaths, household formation/births, then
  // school — the brain last so its child/elder gates see fresh state.
  const lifeDiagnostics = createLifecycleDiagnostics();
  registerSystem(world, createLifecycleSystem(comps, cfg, lifeDiagnostics));
  const householdDiagnostics = createHouseholdDiagnostics();
  registerSystem(
    world,
    createHouseholdsSystem(comps, cfg, householdDiagnostics),
  );
  const schoolDiagnostics = createSchoolDiagnostics();
  registerSystem(world, createSchoolSystem(comps, cfg, schoolDiagnostics));
  const brainDiagnostics = createPopBrainDiagnostics();
  registerSystem(
    world,
    createPopBrainSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      diagnostics: brainDiagnostics,
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
  for (const tile of fixture.houseTiles) {
    stampFinishedBuilding(world, comps, "house", tile[0], tile[1], {
      playerId: PLAYER_ONE,
    });
  }
  stampFinishedBuilding(
    world,
    comps,
    "school",
    fixture.schoolTile[0],
    fixture.schoolTile[1],
    {
      playerId: PLAYER_ONE,
    },
  );

  const founderEids: number[] = [];
  for (const spawn of fixture.popSpawns) {
    founderEids.push(
      spawnUnit(world, comps, spawn[0], spawn[1], {
        identity: true,
        body: true,
      }),
    );
  }
  awardPractice(
    world,
    comps,
    founderEids[fixture.teacherIndex]!,
    "gathering",
    fixture.teacherGatheringXp,
  );

  const sampleTicks = new Set(fixture.arcSampleTicks);
  const digests: { tick: number; digest: string }[] = [];
  const arc: ArcSample[] = [];

  let firstbornEid: number | undefined;

  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;

    if (
      firstbornEid === undefined &&
      world.tick >= 1 &&
      world.rowsByComponentId.get(comps.identityId) !== undefined
    ) {
      for (const eid of world.entities) {
        const identity = readIdentity(world, comps, eid);
        if (identity?.origin === POP_ORIGIN_BIRTH) {
          firstbornEid = eid;
          break;
        }
      }
    }

    const stageOf = (eid: number): string | undefined =>
      lifeStageOf(world, comps, eid, cfg);

    if (sampleTicks.has(tick)) {
      const firstbornStage =
        firstbornEid !== undefined && world.entities.includes(firstbornEid)
          ? (stageOf(firstbornEid) ?? "dead")
          : undefined;
      const lessons =
        firstbornEid !== undefined
          ? (readLessons(world, comps, firstbornEid)?.attendedCount ?? 0)
          : 0;
      const graduated =
        firstbornEid !== undefined
          ? (readLessons(world, comps, firstbornEid)?.graduated ?? 0) === 1
          : false;
      arc.push({
        tick,
        founderStage: world.entities.includes(founderEids[0]!)
          ? (stageOf(founderEids[0]!) ?? "dead")
          : "dead",
        firstbornStage,
        firstbornLessons: lessons,
        firstbornGraduated: graduated,
        population: countPops(world, comps),
        familiesFormed: householdDiagnostics.familiesFormed,
        births: householdDiagnostics.birthsRolled,
        deaths: lifeDiagnostics.naturalDeaths,
        graduates: schoolDiagnostics.graduatesCredited,
        food: stockpileAmountsOf(world, comps, PLAYER_ONE)[0]!,
      });
    }
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  // Graduate knowledge: first pop whose Lessons row says graduated.
  let graduateKnowledge: number | undefined;
  for (const eid of world.entities) {
    const lessons = readLessons(world, comps, eid);
    if (lessons?.graduated === 1) {
      let total = 0;
      for (const slug of SKILL_SLUGS) {
        total += totalXpOf(world, comps, eid, slug) ?? 0;
      }
      graduateKnowledge = total;
      break;
    }
  }

  return {
    digests,
    arc,
    firstbornEid,
    graduateKnowledge,
    diagnostics: {
      familiesFormed: householdDiagnostics.familiesFormed,
      birthsRolled: householdDiagnostics.birthsRolled,
      birthsBlocked: householdDiagnostics.birthsBlocked,
      naturalDeaths: lifeDiagnostics.naturalDeaths,
      lessonsTaught: schoolDiagnostics.lessonsTaught,
      knowledgeGranted: schoolDiagnostics.knowledgeGranted,
      traitsPlanted: schoolDiagnostics.traitsPlanted,
      graduatesCredited: schoolDiagnostics.graduatesCredited,
      brainChildSkips: brainDiagnostics.childSkips,
      brainAssignments:
        brainDiagnostics.gathers +
        brainDiagnostics.builds +
        brainDiagnostics.produces,
      depositedTotal: gather.depositedByResource.reduce((a, b) => a + b, 0),
    },
  };
}

function countPops(world: World, comps: SimComponents): number {
  return world.rowsByComponentId.get(comps.unitTagId)?.size ?? 0;
}

installSimPurityShims();

describe("golden harness m3t5", () => {
  const fixture = loadGoldenCase();

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

  it("runs three generations: births occur, graduates gain, elders die", () => {
    const run = runScenario(fixture);

    // Households formed on surplus (2 founding couples + the bereft
    // second generation's new union), births scaled with them.
    expect(run.diagnostics.familiesFormed).toBeGreaterThanOrEqual(3);
    expect(run.diagnostics.birthsRolled).toBeGreaterThanOrEqual(3);
    expect(run.diagnostics.birthsBlocked).toBeLessThan(
      run.diagnostics.birthsRolled,
    );

    // School: real attendance, real knowledge, measurable graduation
    // gains (guaranteed bonus trait credit paid to schooled pupils).
    expect(run.diagnostics.lessonsTaught).toBeGreaterThanOrEqual(4);
    expect(run.diagnostics.knowledgeGranted).toBe(
      run.diagnostics.lessonsTaught * 30,
    );
    expect(run.diagnostics.graduatesCredited).toBeGreaterThanOrEqual(1);
    expect(run.graduateKnowledge).toBeGreaterThanOrEqual(60);

    // Death of the founding cohort — permanent, mid-run.
    expect(run.diagnostics.naturalDeaths).toBeGreaterThanOrEqual(4);

    // Adult gates: the village worked, children never did.
    expect(run.diagnostics.brainAssignments).toBeGreaterThan(0);
    expect(run.diagnostics.brainChildSkips).toBeGreaterThan(0);
    expect(run.diagnostics.depositedTotal).toBeGreaterThan(0);

    // The sampled arc pins the exact stage boundaries.
    expect(run.arc).toMatchSnapshot();

    const atTick = (tick: number): ArcSample =>
      run.arc.find((sample) => sample.tick === tick)!;
    // Day 1: founding couples housed; founders working adults.
    expect(atTick(600).familiesFormed).toBe(2);
    expect(atTick(600).founderStage).toBe("adult");
    // Day 2: the first generation's children have arrived.
    expect(atTick(1200).births).toBeGreaterThanOrEqual(1);
    expect(atTick(1200).firstbornStage).toBe("child");
    // Day 5: founders hit elder light duty; firstborn graduates.
    expect(atTick(3000).founderStage).toBe("elder");
    expect(atTick(3000).firstbornStage).toBe("adult");
    expect(atTick(3000).firstbornGraduated).toBe(true);
    expect(atTick(3000).firstbornLessons).toBeGreaterThanOrEqual(3);
    // Day 7: the founding cohort is gone; population recovers after.
    expect(atTick(4200).deaths).toBeGreaterThanOrEqual(4);
    expect(atTick(4200).founderStage).toBe("dead");
    expect(atTick(6600).population).toBeGreaterThan(atTick(4200).population);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

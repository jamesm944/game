/**
 * M4-T4a golden harness — SPEC §2.11 Knowledge victory / issue #59.
 *
 * A FULL two-player game ends in a KNOWLEDGE win through every real
 * pipeline: sixteen studying children stream daily lessons under a
 * level-5 teacher (School JSON's knowledgePerLesson × teacher level,
 * credited through the school pass's §2.11 hook), the Grand Academy —
 * the path's expensive Imperial completing act — is stamped mid-run,
 * and the sustained KP/min rate holds above the def's gate long enough
 * to exhaust its hold timer. The evaluator decides on the first
 * cadence tick whose closed-interval SUSTAINING sum crosses timerTicks.
 *
 * Pinned here:
 * - milestone digests every 250th tick plus the freeze tail;
 * - a legible sustain trace: per-cadence readouts (act state, trailing
 *   rate, accumulated hold) proving NO interval counts while the act
 *   is missing and the hold climbs monotonically once it stands;
 * - semantic gates: decision lands on the cadence, winners [player]
 *   with losers [{AI, knowledge}], the AI's generator stayed silent,
 *   and the decisive tick is the FIRST crossing of the hold timer;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../../../src/sim/components/pop";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { awardPractice } from "../../../src/sim/systems/skills";
import { xpToReachLevel } from "../../../src/sim/data/skills";
import { knowledgePointsOf } from "../../../src/sim/components/knowledge";
import { createKnowledgeSystem } from "../../../src/sim/systems/knowledge";
import { createCultureSystem } from "../../../src/sim/systems/culture";
import { createSchoolSystem } from "../../../src/sim/systems/school";
import { normalizeLifecycleConfig } from "../../../src/sim/systems/lifecycle";
import {
  KNOWLEDGE_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  victoryPathReadout,
} from "../../../src/sim/systems/victory";
import {
  VICTORY_PATH_KNOWLEDGE,
  VICTORY_STATUS_SUSTAINING,
  readVictoryChecks,
} from "../../../src/sim/components/victory";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const SIZE = 32;
const SEED = 20260929;
const LIMIT_TICKS = 8000;
const MILESTONE_EVERY = 250;
/** Compressed clock with a childhood far longer than the run. */
const GOLDEN_LIFE = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 40,
  elderAgeDays: 80,
  lifespanDays: 200,
});
const CHILDREN = 16;
const TEACHER_LEVEL = 5;
const ACADEMY_TICK = 450;

interface TracePoint {
  readonly tick: number;
  readonly actComplete: boolean;
  readonly ratePerMinMilli: number;
  readonly holdTicks: number;
}

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly academyTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly kpMilli: number;
  readonly aiKpMilli: number;
  readonly aiChecks: readonly number[];
  readonly trace: readonly TracePoint[];
  readonly sustainingBeforeAct: number;
  readonly actComplete: readonly boolean[];
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runScenario(): RunState {
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
  });
  const comps: SimComponents = defineSimComponents(world);

  // Generator roster first, victory LAST (its contract: fully settled
  // state at every check).
  const knowledge = createKnowledgeSystem({ comps });
  registerSystem(world, knowledge.system);
  registerSystem(world, createCultureSystem(comps));
  registerSystem(
    world,
    createSchoolSystem(comps, GOLDEN_LIFE, undefined, {
      onLesson: knowledge.onLesson,
    }),
  );
  registerSystem(world, createVictorySystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);

  // Player zero's campus: a School, a skilled teacher and a cohort of
  // studying children (birth-origin Pops stay children all run long).
  stampFinishedBuilding(world, comps, "school", 6, 6, {
    playerId: PLAYER_ONE,
  });
  const teacher = spawnUnit(world, comps, 9.5, 9.5, {
    identity: true,
    ownerId: PLAYER_ONE,
  });
  awardPractice(
    world,
    comps,
    teacher,
    "gathering",
    xpToReachLevel(TEACHER_LEVEL) * 3,
  );
  for (let i = 0; i < CHILDREN; i++) {
    spawnUnit(
      world,
      comps,
      7.2 + (i % 8) * 0.55,
      11.5 + Math.floor(i / 8) * 0.7,
      {
        identity: true,
        origin: POP_ORIGIN_BIRTH,
        ownerId: PLAYER_ONE,
      },
    );
  }

  let decidedTick = -1;
  let academyTick = -1;
  const digests: { tick: number; digest: string }[] = [];
  const trace: TracePoint[] = [];
  const ctx = () => ({ world, comps });

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;

    // Mid-run completing act: the Grand Academy stands from here on.
    if (tick === ACADEMY_TICK) {
      stampFinishedBuilding(world, comps, "grand-academy", 14, 14, {
        playerId: PLAYER_ONE,
      });
      academyTick = tick;
    }

    if (tick % VICTORY_CHECK_CADENCE_TICKS === 0) {
      const readout = victoryPathReadout(
        ctx(),
        KNOWLEDGE_EVALUATOR,
        PLAYER_ONE,
      );
      trace.push({
        tick,
        actComplete: readout.actComplete,
        ratePerMinMilli: readout.ratePerMinMilli ?? 0,
        holdTicks: readout.holdTicks,
      });
    }
    if (tick % MILESTONE_EVERY === 0 || tick === LIMIT_TICKS) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
    if (decidedTick < 0 && evaluateOutcome(world, comps).decided) {
      decidedTick = tick;
    }
    if (decidedTick >= 0 && tick >= decidedTick + 90) break; // freeze proof
  }

  const aiEntries = readVictoryChecks(world, comps, 1);
  return {
    digests,
    finalTick: world.tick,
    decidedTick,
    academyTick,
    outcome: evaluateOutcome(world, comps),
    kpMilli: knowledgePointsOf(world, comps, PLAYER_ONE),
    aiKpMilli: knowledgePointsOf(world, comps, 1),
    aiChecks: aiEntries.map((entry) => entry.metric),
    trace,
    sustainingBeforeAct: readVictoryChecks(world, comps, PLAYER_ONE).filter(
      (entry) =>
        entry.status === VICTORY_STATUS_SUSTAINING &&
        entry.pathCode === VICTORY_PATH_KNOWLEDGE &&
        entry.tick < ACADEMY_TICK,
    ).length,
    actComplete: [
      KNOWLEDGE_EVALUATOR.actComplete(ctx(), PLAYER_ONE),
      KNOWLEDGE_EVALUATOR.actComplete(ctx(), 1),
    ],
  };
}

/** The map layers come from buildLayers directly; nothing to recompute. */
let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t4a — player knowledge victory", () => {
  it("ends the full game in a sustained knowledge win", () => {
    const run = mainRun();

    expect(run.academyTick).toBe(ACADEMY_TICK);
    expect(run.decidedTick).toBeGreaterThan(run.academyTick);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([{ playerId: 1, reason: "knowledge" }]);
    // One evaluator object, opposite verdicts on the final state.
    expect(run.actComplete).toEqual([true, false]);
  });

  it("counts no hold interval before the Grand Academy stands", () => {
    const run = mainRun();

    expect(run.sustainingBeforeAct).toBe(0);
    let lastHold = 0;
    for (const point of run.trace) {
      if (!point.actComplete) {
        expect(point.holdTicks).toBe(0);
      } else {
        // Hold progress is monotone — paused intervals add nothing,
        // resumed ones never lose banked time.
        expect(point.holdTicks).toBeGreaterThanOrEqual(lastHold);
        lastHold = point.holdTicks;
      }
    }
    // Lessons flowed well before the act: output ≠ gating.
    const preActOutput = run.trace.some(
      (point) => !point.actComplete && point.ratePerMinMilli > 0,
    );
    expect(preActOutput).toBe(true);
  });

  it("crosses the hold timer exactly once, at the decision", () => {
    const run = mainRun();
    const timer = KNOWLEDGE_EVALUATOR.timerTicks!;

    // The trace keeps polling through the freeze tail; up to the
    // decision the hold sits strictly below the timer until ONE
    // crossing heartbeat, and the decision lands on the very next
    // cadence check (the frame decides from closed intervals).
    const preDecision = run.trace.filter(
      (point) => point.tick <= run.decidedTick,
    );
    const firstCrossing = preDecision.findIndex(
      (point) => point.holdTicks >= timer,
    );
    expect(firstCrossing).toBeGreaterThan(0);
    for (let i = 0; i < firstCrossing; i++) {
      expect(preDecision[i]!.holdTicks).toBeLessThan(timer);
    }
    expect(run.decidedTick).toBe(
      preDecision[firstCrossing]!.tick + VICTORY_CHECK_CADENCE_TICKS,
    );
  });

  it("kept the AI silent — its generator earned nothing", () => {
    const run = mainRun();

    expect(run.aiKpMilli).toBe(0);
    expect(Math.max(...run.aiChecks)).toBe(0);
    // Sixteen children × one lesson each per compressed day, scaled by
    // the level-5 teacher: a large, strictly positive lifetime total.
    expect(run.kpMilli).toBeGreaterThan(100_000);
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = mainRun();

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests.length).toBeGreaterThan(10);
    expect(run.digests).toMatchSnapshot();

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.trace).toEqual(run.trace);
  });
});

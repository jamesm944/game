/**
 * Knowledge & Culture victory paths — SPEC §2.11 / M4-T4 (issue #59).
 *
 * Unit-grade coverage behind the two m4t4 goldens:
 *
 *   - KNOWLEDGE GENERATOR: teacher-scaled KP per attended lesson
 *     (School JSON's knowledgePerLesson × 1000 × teacher level) and the
 *     lump award per completed research (AgeAdvanced log consumption);
 *   - CULTURE GENERATOR: monument prestige/min + population happiness/
 *     morale surplus accrued on the exact per-minute boundary, and the
 *     hostFestival command converting Food+Gold into a timed burst;
 *   - TIMED FRAME: the sustain timer PAUSES when the condition breaks
 *     mid-hold and RESUMES where it left off — derived purely from the
 *     digest-visible SUSTAINING statuses in the VictoryCheck log;
 *   - SYMMETRY: the SAME evaluators crown the AI side through the same
 *     code path when IT completes the Knowledge act;
 *   - HUD line formatting for every panel state.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../src/sim/components/pop";
import { appendAgeAdvancedEvent } from "../src/sim/components/age";
import { RESOURCE_FOOD, RESOURCE_GOLD } from "../src/sim/components/economy";
import { setNeedLevels } from "../src/sim/components/needs";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { awardPractice } from "../src/sim/systems/skills";
import { xpToReachLevel } from "../src/sim/data/skills";
import { createKnowledgeSystem } from "../src/sim/systems/knowledge";
import {
  creditKnowledgePoints,
  knowledgePointsOf,
} from "../src/sim/components/knowledge";
import { prestigeOf } from "../src/sim/components/culture";
import {
  HOST_FESTIVAL_KIND,
  PRESTIGE_ACCRUAL_TICKS,
  PRESTIGE_MORALE_BASELINE,
  createCultureSystem,
  happinessSurplusMilliOf,
  monumentIncomeMilliOf,
} from "../src/sim/systems/culture";
import {
  KNOWLEDGE_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  sustainedHoldTicksOf,
} from "../src/sim/systems/victory";
import {
  VICTORY_STATUS_SUSTAINING,
  readVictoryChecks,
  type VictoryCheckEntry,
} from "../src/sim/components/victory";
import { createSchoolSystem } from "../src/sim/systems/school";
import { normalizeLifecycleConfig } from "../src/sim/systems/lifecycle";
import { formatVictoryPathLine } from "../src/ui/victoryPaths";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 28;

/** Compressed clock: a 600-tick day keeps lessons flowing quickly. */
const GOLDEN_LIFE = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 40,
  elderAgeDays: 80,
  lifespanDays: 200,
});

interface Harness {
  world: World;
  comps: SimComponents;
}

function harness(seed = 59): Harness {
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createVictorySystem(comps));
  return { world, comps };
}

function steps(world: World, count: number): void {
  for (let i = 0; i < count; i++) step(world);
}

function addLedgers(h: Harness): void {
  createPlayerStockpile(h.world, h.comps, PLAYER_ONE);
  createPlayerStockpile(h.world, h.comps, 1);
}

function checksOf(h: Harness, playerId: number): VictoryCheckEntry[] {
  return readVictoryChecks(h.world, h.comps, playerId);
}

installSimPurityShims();

describe("knowledge generator (§2.11)", () => {
  it("credits teacher-scaled KP for attended lessons", () => {
    const h = harness(61);
    addLedgers(h);
    const knowledge = createKnowledgeSystem({ comps: h.comps });
    // Level-3 teacher ⇒ 2 KP × 1000 × 3 = 6000 milli per lesson.
    knowledge.onLesson(h.world, PLAYER_ONE, 3);
    expect(knowledgePointsOf(h.world, h.comps, PLAYER_ONE)).toBe(6000);
    // Scaling is linear in the teacher level, integer-exact in milli.
    knowledge.onLesson(h.world, PLAYER_ONE, 5);
    expect(knowledgePointsOf(h.world, h.comps, PLAYER_ONE)).toBe(16000);
  });

  it("awards the lump per completed researched technology", () => {
    const h = harness(62);
    addLedgers(h);
    registerSystem(h.world, createKnowledgeSystem({ comps: h.comps }).system);
    appendAgeAdvancedEvent(h.world, h.comps, PLAYER_ONE, {
      tick: 1,
      ageRank: 2,
    });
    appendAgeAdvancedEvent(h.world, h.comps, PLAYER_ONE, {
      tick: 2,
      ageRank: 3,
    });
    steps(h.world, 2);
    // Two completed techs ⇒ two lumps, consumed exactly once.
    expect(knowledgePointsOf(h.world, h.comps, PLAYER_ONE)).toBe(50000);
    steps(h.world, VICTORY_CHECK_CADENCE_TICKS);
    expect(knowledgePointsOf(h.world, h.comps, PLAYER_ONE)).toBe(50000);
  });
});

describe("culture generator (§2.11)", () => {
  it("accrues monument income plus happiness surplus on the minute mark", () => {
    const h = harness(63);
    addLedgers(h);
    registerSystem(h.world, createCultureSystem(h.comps));
    stampFinishedBuilding(h.world, h.comps, "monument", 6, 6, {
      playerId: PLAYER_ONE,
    });
    const happy = spawnUnit(h.world, h.comps, 10.5, 10.5, { identity: true });
    setNeedLevels(h.world, h.comps, happy, {
      food: 100,
      rest: 100,
      morale: 80,
    });
    expect(monumentIncomeMilliOf(h.world, h.comps, PLAYER_ONE)).toBe(15000);
    expect(happinessSurplusMilliOf(h.world, h.comps, PLAYER_ONE)).toBe(
      (80 - PRESTIGE_MORALE_BASELINE) * 20,
    );
    steps(h.world, PRESTIGE_ACCRUAL_TICKS - 1);
    expect(prestigeOf(h.world, h.comps, PLAYER_ONE)).toBe(0);
    step(h.world); // the exact 1800th tick
    expect(prestigeOf(h.world, h.comps, PLAYER_ONE)).toBe(
      15000 + (80 - PRESTIGE_MORALE_BASELINE) * 20,
    );
  });

  it("hosts festivals — Food+Gold become a timed prestige burst", () => {
    const h = harness(64);
    createPlayerStockpile(
      h.world,
      h.comps,
      PLAYER_ONE,
      [200, 0, 200, 0, 0, 0, 0],
    );
    createPlayerStockpile(h.world, h.comps, 1);
    registerSystem(h.world, createCultureSystem(h.comps));
    const before = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
    h.world.inbox.submit({
      kind: HOST_FESTIVAL_KIND,
      targetTick: h.world.tick + 1,
      data: { playerId: PLAYER_ONE },
    });
    step(h.world);
    const after = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
    expect(after[RESOURCE_FOOD]! - before[RESOURCE_FOOD]!).toBe(-120);
    expect(after[RESOURCE_GOLD]! - before[RESOURCE_GOLD]!).toBe(-80);
    expect(prestigeOf(h.world, h.comps, PLAYER_ONE)).toBe(20000);
  });

  it("refuses a festival the ledger cannot cover", () => {
    const h = harness(65);
    createPlayerStockpile(
      h.world,
      h.comps,
      PLAYER_ONE,
      [100, 0, 0, 0, 0, 0, 0],
    );
    registerSystem(h.world, createCultureSystem(h.comps));
    h.world.inbox.submit({
      kind: HOST_FESTIVAL_KIND,
      targetTick: h.world.tick + 1,
      data: { playerId: PLAYER_ONE },
    });
    expect(() => step(h.world)).toThrow(/hosting a festival/);
    // Atomic: the shortfall left both ledgers untouched.
    expect(
      stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[RESOURCE_FOOD],
    ).toBe(100);
    expect(prestigeOf(h.world, h.comps, PLAYER_ONE)).toBe(0);
  });
});

describe("sustain timer (§2.11 frame)", () => {
  it("pauses when the condition breaks and resumes where it left off", () => {
    const h = harness(66);
    addLedgers(h);
    // The completing act stands from tick 0 (scenario-editor stamp);
    // the generator is scripted by priming the ledger each cadence.
    stampFinishedBuilding(h.world, h.comps, "grand-academy", 8, 8, {
      playerId: PLAYER_ONE,
    });

    /** Milli credited on each sustained cadence (⇒ 60k/min ≥ 40k). */
    const FLOOR_DELTA = 1000;
    let decidedTick = -1;
    for (let guard = 0; guard < 2400 && decidedTick < 0; guard++) {
      const next = h.world.tick + 1;
      if (next % VICTORY_CHECK_CADENCE_TICKS === 0) {
        // Phase A (checks ≤300): sustained output — nine SUSTAINING
        // intervals bank (the first check has no predecessor).
        // Phase B (301–600): output stops — the timer sits frozen.
        // Phase C (601+): output resumes at the same steady rate.
        if (next <= 300 || next > 600) {
          creditKnowledgePoints(h.world, h.comps, PLAYER_ONE, FLOOR_DELTA);
        }
        if (next === 601 - 1) {
          // Frozen hold at the pause's end, read before resuming.
          expect(
            sustainedHoldTicksOf(
              { world: h.world, comps: h.comps },
              KNOWLEDGE_EVALUATOR,
              PLAYER_ONE,
            ),
          ).toBe(270);
        }
      }
      step(h.world);
      if (evaluateOutcome(h.world, h.comps).decided) {
        decidedTick = h.world.tick;
      }
    }

    // Resuming needed 900 − 270 = 630 more qualifying ticks from the
    // first post-pause check (630): SUSTAINING checks 630..1230 close
    // the gap exactly there — never earlier, proving the 300 paused
    // ticks counted nothing.
    expect(decidedTick).toBe(1260);
    expect(evaluateOutcome(h.world, h.comps)).toEqual({
      decided: true,
      winners: [PLAYER_ONE],
      losers: [{ playerId: 1, reason: "knowledge" }],
    });
  });

  it("stamps SUSTAINING heartbeats only while the act stands", () => {
    const h = harness(67);
    addLedgers(h);
    for (let i = 0; i < VICTORY_CHECK_CADENCE_TICKS * 3; i++) {
      const next = h.world.tick + 1;
      if (next % VICTORY_CHECK_CADENCE_TICKS === 0) {
        creditKnowledgePoints(h.world, h.comps, PLAYER_ONE, 1000);
        if (next === VICTORY_CHECK_CADENCE_TICKS * 2) {
          stampFinishedBuilding(h.world, h.comps, "grand-academy", 8, 8, {
            playerId: PLAYER_ONE,
          });
        }
      }
      step(h.world);
    }
    const sustaining = checksOf(h, PLAYER_ONE).filter(
      (entry) => entry.status === VICTORY_STATUS_SUSTAINING,
    );
    // Output flowed from the very first interval, but the act only
    // stood from the second cadence — everything before is plain
    // ONGOING, everything after (with output) is SUSTAINING.
    expect(sustaining.length).toBeGreaterThan(0);
    expect(sustaining.every((entry) => entry.tick >= 60)).toBe(true);
  });
});

describe("symmetric evaluation (§2.11)", () => {
  it("crowns the AI side through the same knowledge path", () => {
    const h = harness(68);
    addLedgers(h);
    const knowledge = createKnowledgeSystem({ comps: h.comps });
    stampFinishedBuilding(h.world, h.comps, "school", 6, 14, { playerId: 1 });
    stampFinishedBuilding(h.world, h.comps, "grand-academy", 10, 14, {
      playerId: 1,
    });
    // A skilled adult teacher plus studying children, all owned by the AI.
    const teacher = spawnUnit(h.world, h.comps, 9.5, 17.5, {
      identity: true,
      ownerId: 1,
    });
    awardPractice(
      h.world,
      h.comps,
      teacher,
      "gathering",
      xpToReachLevel(5) * 3,
    );
    for (let i = 0; i < 8; i++) {
      spawnUnit(h.world, h.comps, 7.5 + i * 0.2, 16.5, {
        identity: true,
        origin: POP_ORIGIN_BIRTH,
        ownerId: 1,
      });
    }
    registerSystem(h.world, knowledge.system);
    registerSystem(
      h.world,
      createSchoolSystem(h.comps, GOLDEN_LIFE, undefined, {
        onLesson: knowledge.onLesson,
      }),
    );

    for (let guard = 0; guard < 4000; guard++) {
      step(h.world);
      if (evaluateOutcome(h.world, h.comps).decided) break;
    }

    expect(evaluateOutcome(h.world, h.comps)).toEqual({
      decided: true,
      winners: [1],
      losers: [{ playerId: PLAYER_ONE, reason: "knowledge" }],
    });
    // One evaluator object, opposite verdicts on the final state.
    const ctx = { world: h.world, comps: h.comps };
    expect(KNOWLEDGE_EVALUATOR.actComplete(ctx, 1)).toBe(true);
    expect(KNOWLEDGE_EVALUATOR.actComplete(ctx, PLAYER_ONE)).toBe(false);
    // The loser's own generator stayed silent — no cross-credit.
    expect(knowledgePointsOf(h.world, h.comps, PLAYER_ONE)).toBe(0);
    expect(knowledgePointsOf(h.world, h.comps, 1)).toBeGreaterThan(0);
  });
});

describe("HUD progress lines (§2.13 chrome)", () => {
  it("renders every panel state from a readout", () => {
    const base = {
      id: "knowledge",
      pathCode: 1,
      metric: 0,
      ratePerMinMilli: 0 as number | undefined,
      thresholdPerMin: 40 as number | undefined,
      actComplete: false,
      holdTicks: 0,
      timerTicks: 900 as number | undefined,
    };
    expect(formatVictoryPathLine(base)).toBe(
      "Knowledge · 0.0/min sustained · act missing",
    );
    expect(
      formatVictoryPathLine({
        ...base,
        actComplete: true,
        ratePerMinMilli: 240_000,
        holdTicks: 450,
      }),
    ).toBe("Knowledge · 240.0/min sustained · need 40/min · holding 450/900t");
    expect(
      formatVictoryPathLine({
        ...base,
        actComplete: true,
        ratePerMinMilli: 12_000,
        holdTicks: 120,
      }),
    ).toBe("Knowledge · 12.0/min sustained · need 40/min · paused 120/900t");
    expect(
      formatVictoryPathLine({
        id: "conquest",
        pathCode: 0,
        metric: 2,
        ratePerMinMilli: undefined,
        thresholdPerMin: undefined,
        actComplete: true,
        holdTicks: 0,
        timerTicks: undefined,
      }),
    ).toBe("Conquest · capacity 2 · act ready");
  });
});

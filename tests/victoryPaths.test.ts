/**
 * Knowledge, Culture, Wonder, Relic & Economic victory paths — SPEC
 * §2.11 / M4-T4 (issue #59) + M4-T5 (issue #60).
 *
 * Unit-grade coverage behind the m4t4/m4t5 goldens:
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
 *   - HOLD-ONLY FRAME (M4-T5): the Wonder timer runs while it stands,
 *     its destruction cancels (freezes) the hold, and rebuilding
 *     resumes where it left off; the Relic act demands ALL relics in
 *     own monasteries — a partial hold never arms the timer;
 *   - RELIC LIFECYCLE: collectRelic/depositRelic command semantics and
 *     their validation walls, plus capture-on-destruction grounding;
 *   - ECONOMIC GENERATOR: branch output market value accrues to the
 *     owner's ledger at branch credit events only (never direct
 *     workplaces), full value not just the treasury share;
 *   - SYMMETRY: the SAME evaluators crown the AI side through the same
 *     code path when IT completes an act (knowledge here; wonder,
 *     relic and economic below);
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
  despawnEntity,
  registerSystem,
  spawnEntity,
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
  RELIC_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  WONDER_EVALUATOR,
  ECONOMIC_EVALUATOR,
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
import {
  dropStoredRelicsOf,
  relicRowOf,
  spawnRelic,
} from "../src/sim/components/relic";
import {
  COLLECT_RELIC_COMMAND_KIND,
  DEPOSIT_RELIC_COMMAND_KIND,
  createRelicSystem,
} from "../src/sim/systems/relics";
import { setCompanyRow } from "../src/sim/components/company";
import {
  creditBranchOutput,
  branchOutputOf,
} from "../src/sim/components/branchOutput";

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
      metricNoun: "capacity",
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
        metricNoun: "capacity",
      }),
    ).toBe("Conquest · capacity 2 · act ready");
    // M4-T5 hold-only paths: the act standing IS the qualifying
    // condition, so progress reads as a bare hold race.
    expect(
      formatVictoryPathLine({
        ...base,
        id: "wonder",
        pathCode: 3,
        metric: 1,
        ratePerMinMilli: undefined,
        thresholdPerMin: undefined,
        actComplete: true,
        metricNoun: "wonders",
      }),
    ).toBe("Wonder · wonders 1 · holding 0/900t");
    expect(
      formatVictoryPathLine({
        ...base,
        id: "relic",
        pathCode: 4,
        metric: 1,
        ratePerMinMilli: undefined,
        thresholdPerMin: undefined,
        metricNoun: "relics",
      }),
    ).toBe("Relic · relics 1 · act missing");
    expect(
      formatVictoryPathLine({
        id: "economic",
        pathCode: 5,
        metric: 90_000,
        ratePerMinMilli: 60_000,
        thresholdPerMin: 40,
        actComplete: true,
        holdTicks: 300,
        timerTicks: 900,
        metricNoun: "capacity",
      }),
    ).toBe("Economic · 60.0/min sustained · need 40/min · holding 300/900t");
  });
});

// ---- M4-T5: Wonder / Relic / Economic -------------------------------------------

/** Harness with the relic system registered BEFORE the victory frame. */
function harness5(seed = 60): Harness {
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createRelicSystem({ comps }));
  registerSystem(world, createVictorySystem(comps));
  return { world, comps };
}

function submit(h: Harness, kind: string, data: Record<string, unknown>): void {
  h.world.inbox.submit({ kind, targetTick: h.world.tick + 1, data });
}

function runUntilDecided(h: Harness, guardTicks = 6000): number {
  let guard = 0;
  while (!evaluateOutcome(h.world, h.comps).decided && guard++ < guardTicks) {
    step(h.world);
  }
  if (!evaluateOutcome(h.world, h.comps).decided) {
    throw new Error("match never decided within the guard window");
  }
  return h.world.tick;
}

describe("wonder path (§2.11 M4-T5)", () => {
  it("wins when the Wonder stands through its hold timer", () => {
    const h = harness5(71);
    addLedgers(h);
    stampFinishedBuilding(h.world, h.comps, "wonder", 8, 8, {
      playerId: PLAYER_ONE,
    });
    const decidedTick = runUntilDecided(h);
    // The act stands from tick 0: SUSTAINING heartbeats from the first
    // cadence cover the timer one interval later.
    expect(decidedTick).toBeGreaterThan(WONDER_EVALUATOR.timerTicks!);
    expect(evaluateOutcome(h.world, h.comps)).toEqual({
      decided: true,
      winners: [PLAYER_ONE],
      losers: [{ playerId: 1, reason: "wonder" }],
    });
  });

  it("cancels on destruction — and resumes where it left off on rebuild", () => {
    const h = harness5(72);
    addLedgers(h);
    stampFinishedBuilding(h.world, h.comps, "wonder", 8, 8, {
      playerId: PLAYER_ONE,
    });
    let wonderEid = 0;
    for (const eid of h.world.entities) {
      if (
        h.world.rowsByComponentId.get(h.comps.buildingId)?.has(eid) === true
      ) {
        wonderEid = eid;
      }
    }
    expect(wonderEid).toBeGreaterThan(0);

    // Bank ~half the hold, then raze the Wonder mid-timer.
    while (h.world.tick < VICTORY_CHECK_CADENCE_TICKS * 15) step(h.world);
    const bankedAtRaze = sustainedHoldTicksOf(
      { world: h.world, comps: h.comps },
      WONDER_EVALUATOR,
      PLAYER_ONE,
    );
    expect(bankedAtRaze).toBeGreaterThan(0);
    despawnEntity(h.world, wonderEid);

    // The hold freezes while no Wonder stands — even with many ticks.
    const frozenFrom = h.world.tick;
    while (h.world.tick < frozenFrom + VICTORY_CHECK_CADENCE_TICKS * 10) {
      step(h.world);
    }
    expect(
      sustainedHoldTicksOf(
        { world: h.world, comps: h.comps },
        WONDER_EVALUATOR,
        PLAYER_ONE,
      ),
    ).toBe(bankedAtRaze);
    expect(evaluateOutcome(h.world, h.comps).decided).toBe(false);

    // Rebuilding resumes exactly where the destruction left it.
    stampFinishedBuilding(h.world, h.comps, "wonder", 20, 8, {
      playerId: PLAYER_ONE,
    });
    const decidedTick = runUntilDecided(h);
    expect(decidedTick).toBeGreaterThanOrEqual(frozenFrom);
    expect(WONDER_EVALUATOR.timerTicks! - bankedAtRaze).toBeLessThan(
      h.world.tick - frozenFrom,
    );
    expect(evaluateOutcome(h.world, h.comps).winners).toEqual([PLAYER_ONE]);
    expect(evaluateOutcome(h.world, h.comps).losers[0]?.reason).toBe("wonder");
  });
});

describe("relic path (§2.11 M4-T5)", () => {
  interface RelicStage {
    readonly monastery: number;
    readonly monk: number;
    readonly relics: [number, number];
  }

  /** One monastery + monk for each side and two neutral relics. */
  function stageRelics(seed: number): RelicStage & Harness {
    const h = harness5(seed);
    addLedgers(h);
    const mine = stampFinishedBuilding(h.world, h.comps, "monastery", 6, 6, {
      playerId: PLAYER_ONE,
    });
    const monk = spawnUnit(h.world, h.comps, 9.5, 9.5, { ownerId: PLAYER_ONE });
    const relics: [number, number] = [
      spawnRelic(h.world, h.comps, 12.5, 6.5),
      spawnRelic(h.world, h.comps, 12.5, 9.5),
    ];
    return { monastery: mine, monk, relics, ...h };
  }

  it("moves relics ground → monk → monastery through real commands", () => {
    const stage = stageRelics(73);
    submit(stage, COLLECT_RELIC_COMMAND_KIND, {
      unitEid: stage.monk,
      relicEid: stage.relics[0],
    });
    step(stage.world);
    expect(relicRowOf(stage.world, stage.comps, stage.relics[0])).toEqual({
      state: 1,
      holderEid: stage.monk,
    });
    submit(stage, DEPOSIT_RELIC_COMMAND_KIND, {
      unitEid: stage.monk,
      monasteryEid: stage.monastery,
    });
    step(stage.world);
    expect(relicRowOf(stage.world, stage.comps, stage.relics[0])).toEqual({
      state: 2,
      holderEid: stage.monastery,
    });
    expect(
      RELIC_EVALUATOR.metric(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(1);
    // A partial hold is NOT the completing act.
    expect(
      RELIC_EVALUATOR.actComplete(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(false);
  });

  it("wins only when ALL relics rest in own monasteries", () => {
    const stage = stageRelics(74);
    for (const relic of stage.relics) {
      submit(stage, COLLECT_RELIC_COMMAND_KIND, {
        unitEid: stage.monk,
        relicEid: relic,
      });
      step(stage.world);
      submit(stage, DEPOSIT_RELIC_COMMAND_KIND, {
        unitEid: stage.monk,
        monasteryEid: stage.monastery,
      });
      step(stage.world);
    }
    expect(
      RELIC_EVALUATOR.actComplete(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(true);
    const decidedTick = runUntilDecided(stage);
    expect(evaluateOutcome(stage.world, stage.comps)).toEqual({
      decided: true,
      winners: [PLAYER_ONE],
      losers: [{ playerId: 1, reason: "relic" }],
    });
    void decidedTick;
  });

  it("grounds stored relics when their monastery dies (capture-on-destruction)", () => {
    const stage = stageRelics(75);
    for (const relic of stage.relics) {
      submit(stage, COLLECT_RELIC_COMMAND_KIND, {
        unitEid: stage.monk,
        relicEid: relic,
      });
      step(stage.world);
      submit(stage, DEPOSIT_RELIC_COMMAND_KIND, {
        unitEid: stage.monk,
        monasteryEid: stage.monastery,
      });
      step(stage.world);
    }
    expect(
      RELIC_EVALUATOR.actComplete(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(true);
    // The exact hook combat's destroyStructure runs before the despawn.
    expect(dropStoredRelicsOf(stage.world, stage.comps, stage.monastery)).toBe(
      2,
    );
    despawnEntity(stage.world, stage.monastery);
    for (const relic of stage.relics) {
      expect(relicRowOf(stage.world, stage.comps, relic)).toEqual({
        state: 0,
        holderEid: 0,
      });
    }
    expect(
      RELIC_EVALUATOR.actComplete(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(false);
    // Zero stored anywhere: nobody holds anything again.
    expect(
      RELIC_EVALUATOR.metric(
        { world: stage.world, comps: stage.comps },
        PLAYER_ONE,
      ),
    ).toBe(0);
  });

  it("rejects collect/deposit misuse loudly", () => {
    const stage = stageRelics(76);
    // Collecting a relic that is not on the ground throws…
    submit(stage, COLLECT_RELIC_COMMAND_KIND, {
      unitEid: stage.monk,
      relicEid: 999999,
    });
    expect(() => step(stage.world)).toThrow(/no Relic row/);
    // …and so does depositing without carrying anything.
    submit(stage, DEPOSIT_RELIC_COMMAND_KIND, {
      unitEid: stage.monk,
      monasteryEid: stage.monastery,
    });
    expect(() => step(stage.world)).toThrow(/carries no relic/);
  });
});

describe("economic path (§2.11 M4-T5)", () => {
  function stageCompany(h: Harness, ownerId: number): number {
    const co = spawnEntity(h.world);
    setCompanyRow(h.world, h.comps, co, {
      ownerPlayerId: ownerId,
      focusDomain: 3,
      name: "Deepvein Combine",
    });
    return co;
  }

  it("wins once branch output sustains ≥N/min while owning ≥1 company", () => {
    const h = harness5(77);
    addLedgers(h);
    createPlayerStockpile(h.world, h.comps, 1);
    stageCompany(h, PLAYER_ONE);

    let decidedTick = -1;
    for (let guard = 0; guard < 4000 && decidedTick < 0; guard++) {
      const next = h.world.tick + 1;
      if (next % VICTORY_CHECK_CADENCE_TICKS === 0) {
        // Steady branch output: 1000 milli per cadence ⇒ 60k/min,
        // comfortably above the def's 40/min sustain gate.
        creditBranchOutput(h.world, h.comps, PLAYER_ONE, 1000);
      }
      step(h.world);
      if (evaluateOutcome(h.world, h.comps).decided) decidedTick = h.world.tick;
    }
    expect(decidedTick).toBeGreaterThan(ECONOMIC_EVALUATOR.timerTicks!);
    expect(evaluateOutcome(h.world, h.comps)).toEqual({
      decided: true,
      winners: [PLAYER_ONE],
      losers: [{ playerId: 1, reason: "economic" }],
    });
    // The metric IS the digest-visible cumulative ledger.
    expect(
      ECONOMIC_EVALUATOR.metric({ world: h.world, comps: h.comps }, PLAYER_ONE),
    ).toBe(branchOutputOf(h.world, h.comps, PLAYER_ONE));
  });

  it("never counts output without an owning company (act missing)", () => {
    const h = harness5(78);
    addLedgers(h);
    createPlayerStockpile(h.world, h.comps, 1);
    creditBranchOutput(h.world, h.comps, PLAYER_ONE, 5000);
    expect(
      ECONOMIC_EVALUATOR.actComplete(
        { world: h.world, comps: h.comps },
        PLAYER_ONE,
      ),
    ).toBe(false);
    for (let i = 0; i < VICTORY_CHECK_CADENCE_TICKS * 4; i++) step(h.world);
    expect(evaluateOutcome(h.world, h.comps).decided).toBe(false);
  });
});

describe("symmetric evaluation of the M4-T5 paths (§2.11)", () => {
  it("crowns the AI side through wonder, relic and economic alike", () => {
    // Wonder: the AI's Wonder holds its full timer.
    const w = harness5(79);
    addLedgers(w);
    stampFinishedBuilding(w.world, w.comps, "wonder", 8, 8, { playerId: 1 });
    runUntilDecided(w);
    expect(evaluateOutcome(w.world, w.comps).winners).toEqual([1]);
    expect(evaluateOutcome(w.world, w.comps).losers[0]?.reason).toBe("wonder");

    // Relic: the AI monastery banks both relics first.
    const r = harness5(80);
    addLedgers(r);
    const aiMonastery = stampFinishedBuilding(
      r.world,
      r.comps,
      "monastery",
      8,
      8,
      { playerId: 1 },
    );
    const aiMonk = spawnUnit(r.world, r.comps, 11.5, 11.5, { ownerId: 1 });
    for (const tile of [
      [14.5, 8.5],
      [14.5, 11.5],
    ] as const) {
      const relic = spawnRelic(r.world, r.comps, tile[0], tile[1]);
      submit(r, COLLECT_RELIC_COMMAND_KIND, {
        unitEid: aiMonk,
        relicEid: relic,
      });
      step(r.world);
      submit(r, DEPOSIT_RELIC_COMMAND_KIND, {
        unitEid: aiMonk,
        monasteryEid: aiMonastery,
      });
      step(r.world);
    }
    runUntilDecided(r);
    expect(evaluateOutcome(r.world, r.comps).winners).toEqual([1]);
    expect(evaluateOutcome(r.world, r.comps).losers[0]?.reason).toBe("relic");

    // Economic: an AI-owned company with steady branch output.
    const e = harness5(81);
    addLedgers(e);
    createPlayerStockpile(e.world, e.comps, 1);
    const aiCo = spawnEntity(e.world);
    setCompanyRow(e.world, e.comps, aiCo, {
      ownerPlayerId: 1,
      focusDomain: 3,
      name: "Rival Ventures",
    });
    let aiDecidedTick = -1;
    for (let guard = 0; guard < 4000 && aiDecidedTick < 0; guard++) {
      if ((e.world.tick + 1) % VICTORY_CHECK_CADENCE_TICKS === 0) {
        creditBranchOutput(e.world, e.comps, 1, 2000);
      }
      step(e.world);
      if (evaluateOutcome(e.world, e.comps).decided) {
        aiDecidedTick = e.world.tick;
      }
    }
    expect(aiDecidedTick).toBeGreaterThan(0);
    expect(evaluateOutcome(e.world, e.comps).winners).toEqual([1]);
    expect(evaluateOutcome(e.world, e.comps).losers[0]?.reason).toBe(
      "economic",
    );
    // One evaluator object, opposite verdicts on the final states.
    const ctxE = { world: e.world, comps: e.comps };
    expect(ECONOMIC_EVALUATOR.actComplete(ctxE, 1)).toBe(true);
    expect(ECONOMIC_EVALUATOR.actComplete(ctxE, PLAYER_ONE)).toBe(false);
  });
});

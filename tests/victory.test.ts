/**
 * Victory evaluators & game flow — SPEC §2.11/§2.13 / M2-T10 (issue #44).
 *
 * Unit-grade coverage behind the two conquest goldens:
 *
 *   - the §2.11 frame rejects hold-timer paths until their generators
 *     ship (M3+), so a timer can never silently fake-decide;
 *   - CONQUEST defeats a player who HAD military production capacity and
 *     lost all of it — through the SAME evaluator code path with the
 *     players swapped (the issue's symmetry requirement);
 *   - a player who never established capacity is unconquerable;
 *   - VictoryCheck rows land on the §2.11 cadence (every 30th tick),
 *     carry the live metric, ride the digest, and FREEZE at the decision;
 *   - surrender concedes through the shared inbox and wins for the
 *     survivor — also frozen;
 *   - the stats recap reads fallen UNITS (not razed structures) off the
 *     death ledger's dedicated UNIT_DEATH kind.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import { getBuildingRow } from "../src/sim/components/buildings";
import {
  COMBAT_EVENT_DEATH,
  readCombatEvents,
} from "../src/sim/components/combat";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  ATTACK_COMMAND_KIND,
  createCombatSystem,
} from "../src/sim/systems/combat";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  CONQUEST_EVALUATOR,
  SURRENDER_COMMAND_KIND,
  VICTORY_CHECK_CADENCE_TICKS,
  conquestCapacityOf,
  createVictorySystem,
  evaluateOutcome,
  unitsLostOf,
  victoryPlayerIds,
} from "../src/sim/systems/victory";
import {
  VICTORY_PATH_CONQUEST,
  VICTORY_STATUS_ONGOING,
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_SURRENDERED,
  VICTORY_STATUS_WON,
  latestVictoryCheck,
  readVictoryChecks,
  type VictoryCheckEntry,
} from "../src/sim/components/victory";
import {
  AI_DIFFICULTY_LATENCY,
  PLANNER_CADENCE_TICKS,
  createAiPlannerSystem,
  createPlannerTelemetry,
} from "../src/sim/ai/planner";
import { createAiKnowledge } from "../src/sim/ai/knowledge";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";

const SIZE = 32;

interface Harness {
  world: World;
  comps: SimComponents;
}

function harness(seed = 21): Harness {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createCombatSystem(comps, undefined, paths));
  registerSystem(world, createVictorySystem(comps));
  return { world, comps };
}

function steps(world: World, count: number): void {
  for (let i = 0; i < count; i++) step(world);
}

/** Latest CONQUEST entry for one player (the log now carries 3 paths). */
function latestConquestCheck(
  world: World,
  comps: SimComponents,
  playerId: number,
): VictoryCheckEntry | undefined {
  return readVictoryChecks(world, comps, playerId)
    .filter((entry) => entry.pathCode === VICTORY_PATH_CONQUEST)
    .at(-1);
}

/** Ledger pair so both sides are "in the match" (ascending owners). */
function addLedgers(h: Harness): void {
  createPlayerStockpile(h.world, h.comps, PLAYER_ONE);
  createPlayerStockpile(h.world, h.comps, 1);
}

/**
 * One raider razes one primed enemy barracks, marching through the real
 * combat pipeline. Parameterized BY ROLE: the exact same code path runs
 * for (player zero raids AI) and (AI raids player zero).
 */
function raidConquest(seed: number, raider: number, defender: number) {
  const h = harness(seed);
  addLedgers(h);
  const militia = spawnCombatUnit(
    h.world,
    h.comps,
    "militia",
    13.8,
    11.5,
    raider,
  );
  const barracks = stampFinishedBuilding(h.world, h.comps, "barracks", 10, 10, {
    playerId: defender,
  });
  // Prime to a one-strike kill, but let the FIRST §2.11 heartbeat see
  // the capacity standing (production play always spans many checks).
  (getBuildingRow(h.world, h.comps, barracks) as number[])[4] = 4;
  steps(h.world, VICTORY_CHECK_CADENCE_TICKS);

  expect(evaluateOutcome(h.world, h.comps).decided).toBe(false);
  expect(latestConquestCheck(h.world, h.comps, defender)?.metric).toBe(1);

  h.world.inbox.submit({
    kind: ATTACK_COMMAND_KIND,
    targetTick: h.world.tick + 1,
    data: { attackerIds: [militia], targetId: barracks },
  });

  let destroyTick = -1;
  for (let guard = 0; guard < 900; guard++) {
    step(h.world);
    if (
      destroyTick < 0 &&
      getBuildingRow(h.world, h.comps, barracks) === undefined
    ) {
      destroyTick = h.world.tick;
    }
    if (evaluateOutcome(h.world, h.comps).decided) break;
  }

  return { h, militia, barracks, destroyTick };
}

installSimPurityShims();

describe("§2.11 frame", () => {
  it("accepts well-formed timed paths now that generators ship", () => {
    const { world, comps } = harness();
    expect(() =>
      createVictorySystem(comps, {
        paths: [
          {
            id: "wonder",
            pathCode: 7,
            timerTicks: 3000,
            thresholdPerMin: 10,
            metric: () => 0,
            actComplete: () => true,
          },
        ],
      }),
    ).not.toThrow();
    void world;
  });

  it("still rejects half-specified timed paths loudly", () => {
    const { world, comps } = harness();
    const timerNoThreshold = () =>
      createVictorySystem(comps, {
        paths: [
          {
            id: "wonder",
            pathCode: 7,
            timerTicks: 3000,
            metric: () => 0,
            actComplete: () => true,
          },
        ],
      });
    expect(timerNoThreshold).toThrow(/sustain threshold/);
    void world;
    const thresholdNoTimer = () =>
      createVictorySystem(comps, {
        paths: [
          {
            id: "wonder",
            pathCode: 7,
            timerTicks: undefined,
            thresholdPerMin: 10,
            metric: () => 0,
            actComplete: () => true,
          },
        ],
      });
    expect(thresholdNoTimer).toThrow(/no hold timer/);
  });

  it("registers VictoryCheck alphabetically last and rides the digest", () => {
    const h = harness();
    addLedgers(h);
    expect(h.world.registry.namesInOrder().at(-1)).toBe("VictoryCheck");
    const before = computeWorldDigest(h.world);
    steps(h.world, VICTORY_CHECK_CADENCE_TICKS);
    // Heartbeat rows are digest-visible state.
    expect(computeWorldDigest(h.world)).not.toBe(before);
  });
});

describe("conquest (SPEC §2.11)", () => {
  it("defeats the side whose military production was razed — player raids AI", () => {
    const { h, destroyTick } = raidConquest(11, PLAYER_ONE, 1);
    const outcome = evaluateOutcome(h.world, h.comps);

    expect(outcome.decided).toBe(true);
    expect(outcome.winners).toEqual([PLAYER_ONE]);
    expect(outcome.losers).toEqual([{ playerId: 1, reason: "conquest" }]);
    // Timerless: the decision is the FIRST cadence tick that sees the
    // defeat, strictly after the destruction.
    const decisionTick = latestVictoryCheck(h.world, h.comps, 1)?.tick ?? -1;
    expect(decisionTick).toBeGreaterThan(destroyTick);
    expect(decisionTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(latestVictoryCheck(h.world, h.comps, 1)?.status).toBe(
      VICTORY_STATUS_LOST,
    );
    expect(latestVictoryCheck(h.world, h.comps, PLAYER_ONE)?.status).toBe(
      VICTORY_STATUS_WON,
    );
  });

  it("runs the SAME path with sides reversed — AI raids player", () => {
    const { h } = raidConquest(11, 1, PLAYER_ONE);
    const outcome = evaluateOutcome(h.world, h.comps);

    // Mirror image of the previous assertion, byte-for-byte roles swapped.
    expect(outcome.decided).toBe(true);
    expect(outcome.winners).toEqual([1]);
    expect(outcome.losers).toEqual([
      { playerId: PLAYER_ONE, reason: "conquest" },
    ]);
    expect(latestVictoryCheck(h.world, h.comps, PLAYER_ONE)?.status).toBe(
      VICTORY_STATUS_LOST,
    );
    expect(latestVictoryCheck(h.world, h.comps, 1)?.status).toBe(
      VICTORY_STATUS_WON,
    );
  });

  it("never conquers a player who never established capacity", () => {
    const h = harness(5);
    addLedgers(h);
    steps(h.world, VICTORY_CHECK_CADENCE_TICKS * 4);
    const outcome = evaluateOutcome(h.world, h.comps);
    expect(outcome.decided).toBe(false);
    for (const playerId of victoryPlayerIds(h.world, h.comps)) {
      expect(
        conquestCapacityOf({ world: h.world, comps: h.comps }, playerId),
      ).toBe(0);
      const conquestChecks = readVictoryChecks(
        h.world,
        h.comps,
        playerId,
      ).filter((entry) => entry.pathCode === VICTORY_PATH_CONQUEST);
      // M4-T4: the log carries one entry per path per check (conquest +
      // knowledge + culture); the conquest slice is four heartbeats.
      expect(readVictoryChecks(h.world, h.comps, playerId).length).toBe(12);
      for (const entry of conquestChecks) {
        expect(entry.status).toBe(VICTORY_STATUS_ONGOING);
        expect(entry.metric).toBe(0);
      }
    }
  });

  it("freezes the log after the decision — no post-game rows", () => {
    const { h } = raidConquest(11, PLAYER_ONE, 1);
    const p0Entries = readVictoryChecks(h.world, h.comps, PLAYER_ONE).length;
    const p1Entries = readVictoryChecks(h.world, h.comps, 1).length;
    steps(h.world, VICTORY_CHECK_CADENCE_TICKS * 3);
    expect(readVictoryChecks(h.world, h.comps, PLAYER_ONE).length).toBe(
      p0Entries,
    );
    expect(readVictoryChecks(h.world, h.comps, 1).length).toBe(p1Entries);
  });
});

describe("surrender (§2.13 game flow)", () => {
  it("concedes through the shared inbox and freezes the match", () => {
    const h = harness(9);
    addLedgers(h);
    steps(h.world, 10);
    h.world.inbox.submit({
      kind: SURRENDER_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { playerId: PLAYER_ONE },
    });
    const surrenderTick = h.world.tick + 1;
    step(h.world);

    expect(h.world.tick).toBe(surrenderTick);
    const outcome = evaluateOutcome(h.world, h.comps);
    expect(outcome.decided).toBe(true);
    expect(outcome.winners).toEqual([1]);
    expect(outcome.losers).toEqual([
      { playerId: PLAYER_ONE, reason: "surrender" },
    ]);
    expect(latestVictoryCheck(h.world, h.comps, PLAYER_ONE)?.status).toBe(
      VICTORY_STATUS_SURRENDERED,
    );

    const p0Entries = readVictoryChecks(h.world, h.comps, PLAYER_ONE).length;
    steps(h.world, VICTORY_CHECK_CADENCE_TICKS * 2);
    expect(readVictoryChecks(h.world, h.comps, PLAYER_ONE).length).toBe(
      p0Entries,
    );
  });

  it("ignores a late surrender after the match is already decided", () => {
    const { h } = raidConquest(11, PLAYER_ONE, 1);
    h.world.inbox.submit({
      kind: SURRENDER_COMMAND_KIND,
      targetTick: h.world.tick + 1,
      data: { playerId: PLAYER_ONE },
    });
    const winnerEntries = readVictoryChecks(h.world, h.comps, PLAYER_ONE);
    step(h.world);
    // Post-game no-op: the frozen winner's log did not grow a SURRENDERED
    // tail, and the outcome still reads conquest.
    expect(readVictoryChecks(h.world, h.comps, PLAYER_ONE)).toEqual(
      winnerEntries,
    );
    expect(evaluateOutcome(h.world, h.comps).losers[0]?.reason).toBe(
      "conquest",
    );
  });
});

describe("death-ledger stats recap", () => {
  it("counts fallen units — and never razed structures", () => {
    // Structure raze: the DEATH event lands but unitsLostOf stays 0.
    const { h } = raidConquest(11, PLAYER_ONE, 1);
    expect(
      readCombatEvents(h.world, h.comps, 1).some(
        (event) => event.kind === COMBAT_EVENT_DEATH,
      ),
    ).toBe(true);
    expect(unitsLostOf(h.world, h.comps, 1)).toBe(0);
    expect(unitsLostOf(h.world, h.comps, PLAYER_ONE)).toBe(0);

    // Unit duel: one militia falls, its owner's ledger counts exactly it.
    const duel = harness(13);
    addLedgers(duel);
    const a = spawnCombatUnit(
      duel.world,
      duel.comps,
      "militia",
      10.5,
      10.5,
      PLAYER_ONE,
    );
    const b = spawnCombatUnit(duel.world, duel.comps, "militia", 12.5, 10.5, 1);
    (
      duel.world.rowsByComponentId.get(duel.comps.combatId)?.get(a) as number[]
    )[2] = 3;
    duel.world.inbox.submit({
      kind: ATTACK_COMMAND_KIND,
      targetTick: 1,
      data: { attackerIds: [b], targetId: a },
    });
    for (let guard = 0; guard < 600; guard++) {
      step(duel.world);
      if (unitsLostOf(duel.world, duel.comps, PLAYER_ONE) === 1) break;
    }
    expect(unitsLostOf(duel.world, duel.comps, PLAYER_ONE)).toBe(1);
    expect(unitsLostOf(duel.world, duel.comps, 1)).toBe(0);
  });
});

describe("symmetric evaluator surface", () => {
  it("exposes one act-complete predicate that flips with the facts", () => {
    const { h } = raidConquest(11, PLAYER_ONE, 1);
    const ctx = { world: h.world, comps: h.comps };
    // Same function object, opposite verdicts once player one is razed.
    expect(CONQUEST_EVALUATOR.actComplete(ctx, PLAYER_ONE)).toBe(true);
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 1)).toBe(false);
  });
});

describe("difficulty reaction-latency stub (§2.8)", () => {
  /** Fog-honest empty view: the planner sees nothing, thinks anyway. */
  const emptyView = {
    viewer: 1,
    isVisible: () => true,
    isExplored: () => true,
    knownEntities: () => [],
    lastKnown: () => undefined,
  };

  function thinkCounts(latency: number | undefined, ticks: number) {
    const h = harness(17);
    createPlayerStockpile(h.world, h.comps, 1);
    const knowledge = createAiKnowledge({
      world: h.world,
      comps: h.comps,
      view: emptyView,
    });
    const telemetry = createPlannerTelemetry();
    registerSystem(
      h.world,
      createAiPlannerSystem({
        knowledge,
        strategy: {
          id: "idle-ladder",
          villagerTarget: 0,
          gatherWeights: { food: 1, wood: 0, gold: 0 },
          attackArmyThreshold: Number.MAX_SAFE_INTEGER,
          steps: [],
        },
        telemetry,
        ...(latency === undefined ? {} : { reactionLatency: latency }),
      }),
    );
    steps(h.world, ticks);
    return {
      think: telemetry.thinkCalls,
      incremental: telemetry.incrementalCalls,
    };
  }

  it("keeps normal play exactly on the base cadence", () => {
    const counts = thinkCounts(undefined, PLANNER_CADENCE_TICKS * 3);
    expect(counts.think).toBe(3);
    // Incremental probes fill every gap between full passes.
    expect(counts.incremental).toBe(PLANNER_CADENCE_TICKS * 3 - 3);
  });

  it("scales the decision interval ×3 on easy", () => {
    const counts = thinkCounts(
      AI_DIFFICULTY_LATENCY.easy,
      PLANNER_CADENCE_TICKS * 3,
    );
    expect(counts.think).toBe(1); // one pass per 90 ticks
    expect(counts.incremental).toBe(PLANNER_CADENCE_TICKS * 3 - 1);
    expect(AI_DIFFICULTY_LATENCY).toEqual({ easy: 3, normal: 1 });
  });

  it("rejects non-positive or fractional latencies loudly", () => {
    expect(() => thinkCounts(0, 5)).toThrow(/reactionLatency/);
    expect(() => thinkCounts(1.5, 5)).toThrow(/reactionLatency/);
  });
});

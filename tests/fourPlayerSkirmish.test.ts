import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import { createPlayerStockpile } from "../src/sim/core/stockpile";
import {
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
import { createCombatSystem } from "../src/sim/systems/combat";
import { getCombatRow } from "../src/sim/components/combat";
import { getBuildingRow } from "../src/sim/components/buildings";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  CONQUEST_EVALUATOR,
  SURRENDER_COMMAND_KIND,
  conquestDefeated,
  createVictorySystem,
  evaluateOutcome,
  type VictoryContext,
} from "../src/sim/systems/victory";
import {
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_ONGOING,
  VICTORY_STATUS_SURRENDERED,
  VICTORY_STATUS_WON,
  latestVictoryCheck,
} from "../src/sim/components/victory";
import { createDiplomacyMatrix } from "../src/sim/core/diplomacy";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
} from "../src/sim/ai/planner";
import { createAiKnowledge } from "../src/sim/ai/knowledge";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";

const SIZE = 64;

interface FourPlayerHarness {
  world: World;
  comps: SimComponents;
  diplomacy: ReturnType<typeof createDiplomacyMatrix>;
  paths: PathScheduler;
}

function createFourPlayerHarness(
  mode: "ffa" | "teams" = "ffa",
): FourPlayerHarness {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(42, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  const diplomacy = createDiplomacyMatrix(4, mode);

  // Register stockpiles for all 4 players
  for (let p = 0; p < 4; p++) {
    createPlayerStockpile(world, comps, p);
  }

  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createCombatSystem(comps, undefined, paths, diplomacy));
  registerSystem(world, createVictorySystem(comps, { diplomacy }));

  return { world, comps, diplomacy, paths };
}

describe("4-Player Skirmish Architecture (Issue #86 / #111)", () => {
  it("conquest in 4-player FFA requires ALL 3 opponents to be defeated", () => {
    const { world, comps, diplomacy } = createFourPlayerHarness("ffa");
    const ctx: VictoryContext = { world, comps, diplomacy };

    // Give each player 1 finished barracks
    stampFinishedBuilding(world, comps, "barracks", 10, 10, { playerId: 0 });
    const b1 = stampFinishedBuilding(world, comps, "barracks", 20, 10, {
      playerId: 1,
    });
    const b2 = stampFinishedBuilding(world, comps, "barracks", 10, 20, {
      playerId: 2,
    });
    const b3 = stampFinishedBuilding(world, comps, "barracks", 20, 20, {
      playerId: 3,
    });

    // Step 30 ticks so each player's initial military capacity is observed
    for (let i = 0; i < 30; i++) step(world);

    expect(conquestDefeated(ctx, 0)).toBe(false);
    expect(conquestDefeated(ctx, 1)).toBe(false);
    expect(conquestDefeated(ctx, 2)).toBe(false);
    expect(conquestDefeated(ctx, 3)).toBe(false);
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 0)).toBe(false);

    // Defeat Player 3 by razing their barracks
    (getBuildingRow(world, comps, b3) as number[])[0] = 0; // hp = 0

    // Step to tick 60
    for (let i = 0; i < 30; i++) step(world);

    expect(conquestDefeated(ctx, 3)).toBe(true);
    // Crucial Bugfix verification: Player 0 does NOT win just because Player 3 is defeated!
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 0)).toBe(false);
    expect(evaluateOutcome(world, comps, diplomacy).decided).toBe(false);

    // Defeat Player 2
    (getBuildingRow(world, comps, b2) as number[])[0] = 0;

    // Step to tick 90
    for (let i = 0; i < 30; i++) step(world);

    expect(conquestDefeated(ctx, 2)).toBe(true);
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 0)).toBe(false);
    expect(evaluateOutcome(world, comps, diplomacy).decided).toBe(false);

    // Defeat Player 1 (the final opponent)
    (getBuildingRow(world, comps, b1) as number[])[0] = 0;

    // Step to tick 120
    for (let i = 0; i < 30; i++) step(world);

    expect(conquestDefeated(ctx, 1)).toBe(true);
    // Now all opponents (1, 2, 3) are defeated!
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 0)).toBe(true);

    const outcome = evaluateOutcome(world, comps, diplomacy);
    expect(outcome.decided).toBe(true);
    expect(outcome.winners).toEqual([0]);
    expect(outcome.losers.map((l) => l.playerId).sort()).toEqual([1, 2, 3]);

    expect(latestVictoryCheck(world, comps, 0)?.status).toBe(
      VICTORY_STATUS_WON,
    );
    expect(latestVictoryCheck(world, comps, 1)?.status).toBe(
      VICTORY_STATUS_LOST,
    );
    expect(latestVictoryCheck(world, comps, 2)?.status).toBe(
      VICTORY_STATUS_LOST,
    );
    expect(latestVictoryCheck(world, comps, 3)?.status).toBe(
      VICTORY_STATUS_LOST,
    );
  });

  it("handles individual surrender in 4-player FFA without prematurely ending the match", () => {
    const { world, comps, diplomacy } = createFourPlayerHarness("ffa");

    // Establish capacity for all 4 players
    stampFinishedBuilding(world, comps, "barracks", 10, 10, { playerId: 0 });
    stampFinishedBuilding(world, comps, "barracks", 20, 10, { playerId: 1 });
    stampFinishedBuilding(world, comps, "barracks", 10, 20, { playerId: 2 });
    stampFinishedBuilding(world, comps, "barracks", 20, 20, { playerId: 3 });

    // Step to tick 1
    step(world);

    // Player 3 surrenders at tick 2
    world.inbox.submit({
      kind: SURRENDER_COMMAND_KIND,
      targetTick: 2,
      data: { playerId: 3 },
    });

    step(world); // tick 2: surrender executes

    const checkP3 = latestVictoryCheck(world, comps, 3);
    expect(checkP3?.status).toBe(VICTORY_STATUS_SURRENDERED);

    // Match MUST NOT be decided — 3 players remain!
    expect(evaluateOutcome(world, comps, diplomacy).decided).toBe(false);

    // Step to tick 30 (heartbeat check)
    for (let i = world.tick; i <= 30; i++) step(world);

    // Players 0, 1, 2 receive routine ongoing checks, but Player 3 stays surrendered
    expect(latestVictoryCheck(world, comps, 0)?.status).toBe(
      VICTORY_STATUS_ONGOING,
    );
    expect(latestVictoryCheck(world, comps, 1)?.status).toBe(
      VICTORY_STATUS_ONGOING,
    );
    expect(latestVictoryCheck(world, comps, 2)?.status).toBe(
      VICTORY_STATUS_ONGOING,
    );
    expect(latestVictoryCheck(world, comps, 3)?.status).toBe(
      VICTORY_STATUS_SURRENDERED,
    );

    // Player 2 surrenders at tick 32
    world.inbox.submit({
      kind: SURRENDER_COMMAND_KIND,
      targetTick: 32,
      data: { playerId: 2 },
    });
    for (let i = world.tick; i <= 32; i++) step(world);

    expect(latestVictoryCheck(world, comps, 2)?.status).toBe(
      VICTORY_STATUS_SURRENDERED,
    );
    expect(evaluateOutcome(world, comps, diplomacy).decided).toBe(false);

    // Player 1 surrenders at tick 34
    world.inbox.submit({
      kind: SURRENDER_COMMAND_KIND,
      targetTick: 34,
      data: { playerId: 1 },
    });
    for (let i = world.tick; i <= 34; i++) step(world);

    // Now only Player 0 remains alive! Player 0 wins!
    expect(latestVictoryCheck(world, comps, 0)?.status).toBe(
      VICTORY_STATUS_WON,
    );
    const finalOutcome = evaluateOutcome(world, comps, diplomacy);
    expect(finalOutcome.decided).toBe(true);
    expect(finalOutcome.winners).toEqual([0]);
    expect(finalOutcome.losers.map((l) => l.playerId).sort()).toEqual([
      1, 2, 3,
    ]);
  });

  it("2v2 Teams mode: units do not attack allies, and defeating enemy team awards victory to both allies", () => {
    const { world, comps, diplomacy } = createFourPlayerHarness("teams");
    const ctx: VictoryContext = { world, comps, diplomacy };

    // Team 0: Players 0 & 1
    // Team 1: Players 2 & 3
    expect(diplomacy.isAllied(0, 1)).toBe(true);
    expect(diplomacy.isHostile(0, 2)).toBe(true);

    // Spawn Player 0 and Player 1 units adjacent to each other
    const u0 = spawnCombatUnit(world, comps, "militia", 10, 10, 0);
    const u1 = spawnCombatUnit(world, comps, "militia", 10.5, 10, 1);

    // Step 5 ticks
    for (let i = 0; i < 5; i++) step(world);

    // Both units should still be alive at full HP (no friendly fire)
    const hp0 = getCombatRow(world, comps, u0)![2];
    const hp1 = getCombatRow(world, comps, u1)![2];
    expect(hp0).toBe(40);
    expect(hp1).toBe(40);

    // Give military capacity to Team 0 and Team 1
    stampFinishedBuilding(world, comps, "barracks", 5, 5, { playerId: 0 });
    stampFinishedBuilding(world, comps, "barracks", 10, 5, { playerId: 1 });
    const b2 = stampFinishedBuilding(world, comps, "barracks", 30, 30, {
      playerId: 2,
    });
    const b3 = stampFinishedBuilding(world, comps, "barracks", 35, 30, {
      playerId: 3,
    });

    // Step to tick 30 to record initial capacities
    for (let i = world.tick; i <= 30; i++) step(world);

    // Destroy Team 1's barracks
    (getBuildingRow(world, comps, b2) as number[])[0] = 0;
    (getBuildingRow(world, comps, b3) as number[])[0] = 0;

    // Step to tick 60
    for (let i = world.tick; i <= 60; i++) step(world);

    // Both allied players in Team 0 (Player 0 and Player 1) achieve victory together!
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 0)).toBe(true);
    expect(CONQUEST_EVALUATOR.actComplete(ctx, 1)).toBe(true);

    const outcome = evaluateOutcome(world, comps, diplomacy);
    expect(outcome.decided).toBe(true);
    expect(outcome.winners.slice().sort()).toEqual([0, 1]);
    expect(outcome.losers.map((l) => l.playerId).sort()).toEqual([2, 3]);

    expect(latestVictoryCheck(world, comps, 0)?.status).toBe(
      VICTORY_STATUS_WON,
    );
    expect(latestVictoryCheck(world, comps, 1)?.status).toBe(
      VICTORY_STATUS_WON,
    );
  });

  it("staggers AI planning cadence across 3 AI opponents (phaseOffset 0, 10, 20)", () => {
    const world = createWorld(99, {
      size: SIZE,
      layers: buildLayers(
        new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
        new Uint8Array(SIZE * SIZE),
      ),
    });
    const comps = defineSimComponents(world);

    for (let p = 0; p < 4; p++) {
      createPlayerStockpile(world, comps, p);
    }

    const emptyView = {
      viewer: 1,
      isVisible: () => true,
      isExplored: () => true,
      knownEntities: () => [],
      lastKnown: () => undefined,
    };

    const t1 = createPlannerTelemetry();
    const t2 = createPlannerTelemetry();
    const t3 = createPlannerTelemetry();

    const testStrategy = {
      id: "test-idle",
      villagerTarget: 0,
      gatherWeights: { food: 1, wood: 0, gold: 0 },
      attackArmyThreshold: 9999,
      steps: [],
    };

    // AI 1 (Player 1): phaseOffset = 0 -> ticks 30, 60, 90...
    const ai1 = createAiPlannerSystem({
      knowledge: createAiKnowledge({
        world,
        comps,
        view: { ...emptyView, viewer: 1 },
        player: 1,
      }),
      strategy: testStrategy,
      telemetry: t1,
      phaseOffset: 0,
    });

    // AI 2 (Player 2): phaseOffset = 10 -> ticks 10, 40, 70...
    const ai2 = createAiPlannerSystem({
      knowledge: createAiKnowledge({
        world,
        comps,
        view: { ...emptyView, viewer: 2 },
        player: 2,
      }),
      strategy: testStrategy,
      telemetry: t2,
      phaseOffset: 10,
    });

    // AI 3 (Player 3): phaseOffset = 20 -> ticks 20, 50, 80...
    const ai3 = createAiPlannerSystem({
      knowledge: createAiKnowledge({
        world,
        comps,
        view: { ...emptyView, viewer: 3 },
        player: 3,
      }),
      strategy: testStrategy,
      telemetry: t3,
      phaseOffset: 20,
    });

    registerSystem(world, ai1);
    registerSystem(world, ai2);
    registerSystem(world, ai3);

    // Step until tick 9
    for (let i = 0; i < 9; i++) step(world);
    expect(t1.thinkCalls).toBe(0);
    expect(t2.thinkCalls).toBe(0);
    expect(t3.thinkCalls).toBe(0);

    // Tick 10: AI 2 runs full pass!
    step(world);
    expect(t1.thinkCalls).toBe(0);
    expect(t2.thinkCalls).toBe(1);
    expect(t3.thinkCalls).toBe(0);

    // Step until tick 19
    for (let i = 10; i < 19; i++) step(world);
    expect(t1.thinkCalls).toBe(0);
    expect(t2.thinkCalls).toBe(1);
    expect(t3.thinkCalls).toBe(0);

    // Tick 20: AI 3 runs full pass!
    step(world);
    expect(t1.thinkCalls).toBe(0);
    expect(t2.thinkCalls).toBe(1);
    expect(t3.thinkCalls).toBe(1);

    // Step until tick 29
    for (let i = 20; i < 29; i++) step(world);
    // Tick 30: AI 1 runs full pass!
    step(world);
    expect(t1.thinkCalls).toBe(1);
    expect(t2.thinkCalls).toBe(1);
    expect(t3.thinkCalls).toBe(1);

    // Step until tick 39
    for (let i = 30; i < 39; i++) step(world);
    // Tick 40: AI 2 runs 2nd full pass!
    step(world);
    expect(t1.thinkCalls).toBe(1);
    expect(t2.thinkCalls).toBe(2);
    expect(t3.thinkCalls).toBe(1);

    // Step until tick 49
    for (let i = 40; i < 49; i++) step(world);
    // Tick 50: AI 3 runs 2nd full pass!
    step(world);
    expect(t1.thinkCalls).toBe(1);
    expect(t2.thinkCalls).toBe(2);
    expect(t3.thinkCalls).toBe(2);

    // Step until tick 59
    for (let i = 50; i < 59; i++) step(world);
    // Tick 60: AI 1 runs 2nd full pass!
    step(world);
    expect(t1.thinkCalls).toBe(2);
    expect(t2.thinkCalls).toBe(2);
    expect(t3.thinkCalls).toBe(2);

    // Confirmed: perfectly staggered phase offsets guarantee zero simultaneous full-pass think spikes!
  });
});

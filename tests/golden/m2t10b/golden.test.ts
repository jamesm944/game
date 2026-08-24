/**
 * M2-T10b golden harness — SPEC §2.11 conquest, REVERSE direction / #44.
 *
 * The mirrored scenario: the AI opponent's planner (real KnowledgeView,
 * real command drafts) spots player zero's lone barracks inside its
 * vision, arms its minimal attack trigger and razes it with two stamped
 * knights. The SAME evaluator code path that crowned the player in
 * m2t10a now crowns the AI:
 *
 *   - player zero HAD military production capacity (heartbeat metric 1)
 *     and lost it → LOST {reason: conquest};
 *   - AI_PLAYER completes the act → WON on the same cadence tick;
 *   - the attack draft targeted the legitimately visible building
 *     through fog-honest knowledge (m2t9's honesty contract, reused);
 *   - the recap ledger reads one side at zero units lost, structures
 *     only.
 *
 * Together with m2t10a this is the issue's "destroying all enemy
 * production triggers conquest BOTH DIRECTIONS" acceptance criterion,
 * pinned with milestone digests + a double-run canary.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { getBuildingRow } from "../../../src/sim/components/buildings";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type SimSystem,
  type World,
} from "../../../src/sim/core/world";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { createGatherSystem } from "../../../src/sim/systems/gather";
import {
  createPlacementSystem,
  stampFinishedBuilding,
} from "../../../src/sim/systems/placement";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createTrainingSystem } from "../../../src/sim/systems/training";
import { createAgeSystem } from "../../../src/sim/systems/age";
import { createCombatSystem } from "../../../src/sim/systems/combat";
import { createEquipmentSystem } from "../../../src/sim/systems/equipment";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../../../src/sim/systems/fog";
import { createPlayerAgeState } from "../../../src/sim/components/age";
import {
  CONQUEST_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  unitsLostOf,
} from "../../../src/sim/systems/victory";
import {
  VICTORY_PATH_CONQUEST,
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_ONGOING,
  VICTORY_STATUS_WON,
  readVictoryChecks,
} from "../../../src/sim/components/victory";
import { setupAiOpponent, AI_PLAYER } from "../../../src/sim/ai/bootstrap";
import { createAiKnowledge } from "../../../src/sim/ai/knowledge";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
} from "../../../src/sim/ai/planner";
import type { Strategy } from "../../../src/sim/ai/buildOrder";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const SIZE = 24;
const SEED = 20260904;
const LIMIT_TICKS = 1200;

/**
 * The minimal raid strategy (m2t9's attack-only mini): threshold 2, no
 * economy steps, terminal attack step — isolates the trigger.
 */
const raidStrategy: Strategy = {
  id: "raid-player-barracks",
  villagerTarget: 0,
  gatherWeights: { food: 1, wood: 0, gold: 0 },
  attackArmyThreshold: 2,
  steps: [
    {
      id: "attack",
      action: { kind: "attack" },
      complete: {
        kind: "armySize",
        unitId: "knight",
        count: Number.POSITIVE_INFINITY,
      },
      gate: {},
    },
  ],
};

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly barracksDestroyTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly p0OngoingMetrics: readonly number[];
  readonly aiTailStatus: number;
  readonly p0TailStatus: number;
  readonly tailTicksAgree: boolean;
  readonly actComplete: readonly boolean[];
  readonly attackTargetWasBarracks: boolean;
  readonly targetVisibleToAi: boolean;
  readonly aiUnitsLost: number;
  readonly p0UnitsLost: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runScenario(): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(SIZE, 2);
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  const comps: SimComponents = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  const systems: SimSystem[] = [
    createMovementSystem(comps, scheduler),
    createGatherSystem(comps, scheduler),
    createPlacementSystem(comps),
    createConstructionSystem(comps),
    createTrainingSystem(comps),
    createAgeSystem(comps),
    createCombatSystem(comps, undefined, scheduler),
    createEquipmentSystem(comps),
    createVictorySystem(comps),
  ];
  for (const system of systems) registerSystem(world, system);

  // ---- Player zero: ledgers + ONE primed barracks near the AI base ----
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 600, 100, 0, 0, 0, 0]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_ONE);
  const barracks = stampFinishedBuilding(world, comps, "barracks", 10, 6, {
    playerId: PLAYER_ONE,
  });
  (getBuildingRow(world, comps, barracks) as number[])[4] = 8;

  // ---- AI: base ledger pair, two stamped knights, real planner --------
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [],
  });
  spawnCombatUnit(world, comps, "knight", 7.5, 6.5, AI_PLAYER);
  spawnCombatUnit(world, comps, "knight", 7.5, 7.5, AI_PLAYER);

  fog.recomputeAll();

  const knowledge = createAiKnowledge({
    world,
    comps,
    view: fog.knowledgeFor(AI_PLAYER),
  });
  const telemetry = createPlannerTelemetry();
  registerSystem(
    world,
    createAiPlannerSystem({
      knowledge,
      strategy: raidStrategy,
      telemetry,
    }),
  );

  let barracksDestroyTick = -1;
  let decidedTick = -1;
  const digests: { tick: number; digest: string }[] = [];

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;

    const tick = world.tick;
    if (
      barracksDestroyTick < 0 &&
      getBuildingRow(world, comps, barracks) === undefined
    ) {
      barracksDestroyTick = tick;
    }
    if (decidedTick < 0 && evaluateOutcome(world, comps).decided) {
      decidedTick = tick;
    }
    if (tick % 30 === 0 || tick === LIMIT_TICKS) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
    if (decidedTick >= 0 && tick >= decidedTick + 60) break; // freeze proof
  }

  const p0Entries = readVictoryChecks(world, comps, PLAYER_ONE);
  const aiEntries = readVictoryChecks(world, comps, AI_PLAYER);
  const drafts = telemetry.attackDrafts;

  return {
    digests,
    finalTick: world.tick,
    decidedTick,
    barracksDestroyTick,
    outcome: evaluateOutcome(world, comps),
    p0OngoingMetrics: p0Entries
      .filter(
        (entry) =>
          entry.status === VICTORY_STATUS_ONGOING &&
          entry.pathCode === VICTORY_PATH_CONQUEST,
      )
      .map((entry) => entry.metric),
    aiTailStatus: aiEntries.at(-1)!.status,
    p0TailStatus: p0Entries.at(-1)!.status,
    tailTicksAgree:
      aiEntries.at(-1)!.tick === p0Entries.at(-1)!.tick &&
      aiEntries.length === p0Entries.length,
    actComplete: [
      CONQUEST_EVALUATOR.actComplete({ world, comps }, PLAYER_ONE),
      CONQUEST_EVALUATOR.actComplete({ world, comps }, AI_PLAYER),
    ],
    attackTargetWasBarracks:
      drafts.length === 1 && drafts[0]!.targetId === barracks,
    targetVisibleToAi: drafts.length === 1 && drafts[0]!.targetVisibleToAi,
    aiUnitsLost: unitsLostOf(world, comps, AI_PLAYER),
    p0UnitsLost: unitsLostOf(world, comps, PLAYER_ONE),
  };
}

let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m2t10b — AI conquest", () => {
  it("ends the mirrored game in an AI conquest victory", () => {
    const run = mainRun();

    expect(run.barracksDestroyTick).toBeGreaterThan(0);
    // Timerless cadence decision, same-tick legal (combat precedes
    // victory inside one step).
    expect(run.decidedTick).toBeGreaterThanOrEqual(run.barracksDestroyTick);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([AI_PLAYER]);
    expect(run.outcome.losers).toEqual([
      { playerId: PLAYER_ONE, reason: "conquest" },
    ]);
  });

  it("runs the same evaluator code path in the reverse direction", () => {
    const run = mainRun();

    // Capacity stood at the first heartbeat, then fell to zero.
    expect(run.p0OngoingMetrics[0]).toBe(1);
    expect(run.p0TailStatus).toBe(VICTORY_STATUS_LOST);
    expect(run.aiTailStatus).toBe(VICTORY_STATUS_WON);
    expect(run.tailTicksAgree).toBe(true);
    expect(run.actComplete).toEqual([false, true]);
  });

  it("raided through fog-honest knowledge without unit losses", () => {
    const run = mainRun();

    expect(run.attackTargetWasBarracks).toBe(true);
    expect(run.targetVisibleToAi).toBe(true);
    expect(run.aiUnitsLost).toBe(0);
    expect(run.p0UnitsLost).toBe(0);
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = mainRun();

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests.length).toBeGreaterThan(3);
    expect(run.digests).toMatchSnapshot();

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.barracksDestroyTick).toBe(run.barracksDestroyTick);
    expect(second.outcome).toEqual(run.outcome);
  });
});

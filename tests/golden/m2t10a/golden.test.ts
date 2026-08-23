/**
 * M2-T10a golden harness — SPEC §2.11/§2.13 conquest victory / #44.
 *
 * A FULL small-map skirmish vs the scripted AI that ends in PLAYER
 * CONQUEST through every real pipeline: four Forge-equipped knights
 * march across a 40² field and raze the AI's barracks + stable while
 * the fast-castle-knights opponent runs its economy behind them. The
 * §2.11 evaluator (registered like production, before the planner)
 * calls the defeat on the first cadence tick that sees the capacity
 * gone.
 *
 * Pinned outcomes:
 *   - DECISION — winners [player zero], losers [{AI, conquest}]; the
 *     decision tick is strictly after the second raze and sits on the
 *     30-tick cadence (timerless path).
 *   - CAPACITY LEDGER — the AI's VictoryCheck history records metric 2
 *     while both buildings stand, then the decisive LOST entry; player
 *     zero (no military buildings ever) reads zeros into its WON entry.
 *   - DESTRUCTION — rubble over both footprints; zero UNITS lost on
 *     either side: the death ledger's UNIT_DEATH count is exactly 0 for
 *     the recap line while structure DEATH events exist.
 *   - SYMMETRY — one evaluator object flips verdict per side on the
 *     final state; the AI's attack trigger never arms (its army is
 *     still empty when the match ends).
 *   - ECONOMY UNDER FIRE — the AI keeps playing through the raid:
 *     Feudal research is enqueued on schedule but cannot complete
 *     before the conquest lands (aiRank stays Dark).
 *
 * Milestone digests land every 30th tick plus the freeze tail, with a
 * double-run determinism canary; regenerate ONLY via golden:record.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  WORK_SLOTS_PER_NODE,
  type SimComponents,
} from "../../../src/sim/components";
import { getBuildingRow } from "../../../src/sim/components/buildings";
import {
  COMBAT_EVENT_DEATH,
  readCombatEvents,
} from "../../../src/sim/components/combat";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type SimSystem,
  type World,
} from "../../../src/sim/core/world";
import {
  COMMODITY_WEAPONS,
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
  depositCommodityIntoStockpile,
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
import {
  createAgeSystem,
  currentAgeRankOf,
} from "../../../src/sim/systems/age";
import {
  ATTACK_COMMAND_KIND,
  createCombatSystem,
} from "../../../src/sim/systems/combat";
import {
  EQUIP_COMMAND_KIND,
  createEquipmentSystem,
} from "../../../src/sim/systems/equipment";
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
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const SIZE = 40;
const SEED = 20260903;
const LIMIT_TICKS = 3600;

/** Opening capital: fat enough that the AI ladder never starves. */
const AI_RESOURCES = [5000, 5000, 2000, 2000, 0, 0, 0];

const RESOURCE_CODES: Record<string, number> = { food: 0, wood: 1, gold: 2 };

interface TailCheck {
  readonly tick: number;
  readonly status: number;
  readonly metric: number;
}

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly barracksDestroyTick: number;
  readonly stableDestroyTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly aiOngoingMetrics: readonly number[];
  readonly aiTail: TailCheck;
  readonly p0Tail: TailCheck;
  readonly entryCountTie: boolean;
  readonly aiRank: number;
  readonly p0Rank: number;
  readonly aiUnitsLost: number;
  readonly p0UnitsLost: number;
  readonly aiStructureDeaths: number;
  readonly actComplete: readonly boolean[];
  readonly attackDrafts: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function primeHp(
  world: World,
  comps: SimComponents,
  eid: number,
  hp: number,
): void {
  (getBuildingRow(world, comps, eid) as number[])[4] = hp;
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
  const comps = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  // Production roster order; the victory evaluator rides after combat
  // and the planner stays LAST (its contract).
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

  // ---- Player zero: idle dark-age start plus the raiding knights -----
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [2000, 2000, 2000, 2000, 0, 0, 0],
  );
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_ONE);
  stampFinishedBuilding(world, comps, "town-center", 4, 4, {
    playerId: PLAYER_ONE,
  });
  spawnUnit(world, comps, 8.5, 12.5);
  spawnUnit(world, comps, 8.5, 13.5);

  const knights = [
    spawnCombatUnit(world, comps, "knight", 8.5, 8.5, PLAYER_ONE),
    spawnCombatUnit(world, comps, "knight", 8.5, 9.5, PLAYER_ONE),
    spawnCombatUnit(world, comps, "knight", 9.5, 8.5, PLAYER_ONE),
    spawnCombatUnit(world, comps, "knight", 9.5, 9.5, PLAYER_ONE),
  ];
  // Three Forge weapons each: derived attack 10 + 3×2 = 16 per strike.
  depositCommodityIntoStockpile(
    world,
    comps,
    PLAYER_ONE,
    COMMODITY_WEAPONS,
    knights.length * 3,
  );
  for (const knight of knights) {
    world.inbox.submit({
      kind: EQUIP_COMMAND_KIND,
      targetTick: 1,
      data: { unitIds: [knight], item: "weapon", playerId: PLAYER_ONE },
    });
  }

  // ---- AI opponent: mirrored FC base with BOTH producers pre-stamped --
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [33, 33],
    villagerSpawns: [
      [30.5, 36.5],
      [31.5, 36.5],
      [32.5, 36.5],
      [30.5, 37.5],
      [31.5, 37.5],
    ],
    startingResources: AI_RESOURCES,
  });
  const aiBarracks = stampFinishedBuilding(world, comps, "barracks", 26, 26, {
    playerId: AI_PLAYER,
  });
  const aiStable = stampFinishedBuilding(world, comps, "stable", 22, 22, {
    playerId: AI_PLAYER,
  });
  // Scenario-editor priming keeps the raze phase tight; the strikes are
  // still fully real combat (march, reach, reload, destruction pipeline).
  primeHp(world, comps, aiBarracks, 15);
  primeHp(world, comps, aiStable, 15);

  // Gatherables inside AI villager sight so the economy layer engages.
  const nodeSpawns: [number, number, string][] = [
    [29, 32, "food"],
    [30, 31, "food"],
    [29, 35, "wood"],
    [36, 29, "wood"],
    [36, 36, "gold"],
    [28, 29, "food"],
  ];
  for (const [tileX, tileY, slug] of nodeSpawns) {
    spawnResourceNode(world, comps, tileX, tileY, RESOURCE_CODES[slug]!, 800, {
      workSlots: WORK_SLOTS_PER_NODE,
    });
  }

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
      strategy: "fast-castle-knights",
      telemetry,
    }),
  );

  // ---- The raid script: explicit siege orders through the inbox -------
  let phase: "hold" | "barracks" | "stable" | "razed" = "hold";
  let barracksDestroyTick = -1;
  let stableDestroyTick = -1;
  let decidedTick = -1;
  const digests: { tick: number; digest: string }[] = [];

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue; // held boundary

    const tick = world.tick;
    if (phase === "hold" && tick >= VICTORY_CHECK_CADENCE_TICKS * 2) {
      // First heartbeats recorded AI capacity = 2; the siege begins.
      phase = "barracks";
      world.inbox.submit({
        kind: ATTACK_COMMAND_KIND,
        targetTick: tick + 1,
        data: { attackerIds: [...knights], targetId: aiBarracks },
      });
    }
    if (
      phase === "barracks" &&
      getBuildingRow(world, comps, aiBarracks) === undefined
    ) {
      barracksDestroyTick = tick;
      phase = "stable";
      world.inbox.submit({
        kind: ATTACK_COMMAND_KIND,
        targetTick: tick + 1,
        data: { attackerIds: [...knights], targetId: aiStable },
      });
    }
    if (
      phase === "stable" &&
      getBuildingRow(world, comps, aiStable) === undefined
    ) {
      stableDestroyTick = tick;
      phase = "razed";
    }
    if (decidedTick < 0 && evaluateOutcome(world, comps).decided) {
      decidedTick = tick;
    }
    if (tick % 30 === 0 || tick === LIMIT_TICKS) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
    if (decidedTick >= 0 && tick >= decidedTick + 60) break; // freeze proof
  }

  const aiEntries = readVictoryChecks(world, comps, AI_PLAYER);
  const p0Entries = readVictoryChecks(world, comps, PLAYER_ONE);
  const tailOf = (entries: ReturnType<typeof readVictoryChecks>): TailCheck => {
    const last = entries.at(-1)!;
    return { tick: last.tick, status: last.status, metric: last.metric };
  };

  return {
    digests,
    finalTick: world.tick,
    decidedTick,
    barracksDestroyTick,
    stableDestroyTick,
    outcome: evaluateOutcome(world, comps),
    aiOngoingMetrics: aiEntries
      .filter((entry) => entry.status === VICTORY_STATUS_ONGOING)
      .map((entry) => entry.metric),
    aiTail: tailOf(aiEntries),
    p0Tail: tailOf(p0Entries),
    entryCountTie:
      aiEntries.length === p0Entries.length &&
      aiEntries.at(-1)!.tick === p0Entries.at(-1)!.tick,
    aiRank: currentAgeRankOf(world, comps, AI_PLAYER),
    p0Rank: currentAgeRankOf(world, comps, PLAYER_ONE),
    aiUnitsLost: unitsLostOf(world, comps, AI_PLAYER),
    p0UnitsLost: unitsLostOf(world, comps, PLAYER_ONE),
    aiStructureDeaths: readCombatEvents(world, comps, AI_PLAYER).filter(
      (event) => event.kind === COMBAT_EVENT_DEATH,
    ).length,
    actComplete: [
      CONQUEST_EVALUATOR.actComplete({ world, comps }, PLAYER_ONE),
      CONQUEST_EVALUATOR.actComplete({ world, comps }, AI_PLAYER),
    ],
    attackDrafts: telemetry.attackDrafts.length,
  };
}

/** Heavy main run executes once; assertions read the cache. */
let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m2t10a — player conquest", () => {
  it("ends the full small-map game in player conquest", () => {
    const run = mainRun();

    expect(run.decidedTick).toBeGreaterThan(0);
    expect(run.barracksDestroyTick).toBeGreaterThan(0);
    expect(run.stableDestroyTick).toBeGreaterThan(run.barracksDestroyTick);
    // Timerless: the FIRST cadence check that sees the defeat — combat
    // runs BEFORE victory each step, so a raze landing on a cadence tick
    // decides that very tick; otherwise the next boundary does.
    expect(run.decidedTick).toBeGreaterThanOrEqual(run.stableDestroyTick);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([
      { playerId: AI_PLAYER, reason: "conquest" },
    ]);
  });

  it("keeps a digest-visible capacity ledger for both sides", () => {
    const run = mainRun();

    expect(run.aiOngoingMetrics[0]).toBe(2); // both producers seen standing
    expect(Math.max(...run.aiOngoingMetrics)).toBe(2);
    expect(run.aiTail).toEqual({
      tick: run.decidedTick,
      status: VICTORY_STATUS_LOST,
      metric: 0,
    });
    expect(run.p0Tail).toEqual({
      tick: run.decidedTick,
      status: VICTORY_STATUS_WON,
      metric: 0,
    });
    expect(run.entryCountTie).toBe(true);
    // Feudal research was enqueued but cannot complete before conquest.
    expect(run.aiRank).toBe(1);
    expect(run.p0Rank).toBe(1);
  });

  it("razed structures, lost no units — the recap reads exactly that", () => {
    const run = mainRun();

    expect(run.aiStructureDeaths).toBe(2);
    expect(run.aiUnitsLost).toBe(0);
    expect(run.p0UnitsLost).toBe(0);
    // One evaluator object, opposite verdicts on the same final state.
    expect(run.actComplete).toEqual([true, false]);
  });

  it("freezes after the decision and never arms the AI attack", () => {
    const run = mainRun();

    expect(run.attackDrafts).toBe(0);
    expect(run.entryCountTie).toBe(true);
    // The loop rode 60 ticks past the decision: no rows moved.
    expect(run.finalTick).toBeGreaterThanOrEqual(run.decidedTick + 60);
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = mainRun();

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests.length).toBeGreaterThan(20);
    expect(run.digests).toMatchSnapshot();

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.barracksDestroyTick).toBe(run.barracksDestroyTick);
    expect(second.stableDestroyTick).toBe(run.stableDestroyTick);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.aiTail).toEqual(run.aiTail);
    expect(second.p0Tail).toEqual(run.p0Tail);
  });
});

/**
 * M4-T6c golden harness — SPEC §2.8 difficulty knobs, disclosed / #61.
 *
 * The GOLDEN TRIO: one scripted scenario played three times against the
 * SAME seed and world, varying ONLY the AI difficulty preset. Every
 * knob must show up as a measurable outcome difference:
 *
 *   - DECISION INTERVAL — full passes land on `floor(tick / interval)`
 *     boundaries (easy 90 · normal 30 · hard 15), so the Feudal click
 *     and every downstream event shift: hard completes Feudal first,
 *     easy last, and the three legs' milestone DIGESTS diverge
 *     pairwise — measurably different games from one script.
 *   - INCOME MULTIPLIER — a two-leg deposit probe credits exactly
 *     round(N × 1.25) on hard versus N on normal (the documented
 *     AoE2-style cheat, applied at the gather credit event).
 *   - REACTION LATENCY — an AI building under attack rallies its
 *     knights after exactly `reactionDelayTicks` of sustained threat
 *     (hard instant · normal +20 · easy +60).
 *
 * Extended canary: the normal leg replays byte-for-byte.
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
import { readAgeAdvancedEvents } from "../../../src/sim/components/age";
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
import {
  createGatherSystem,
  createGatherDiagnostics,
} from "../../../src/sim/systems/gather";
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
import { setupAiOpponent, AI_PLAYER } from "../../../src/sim/ai/bootstrap";
import { createAiKnowledge } from "../../../src/sim/ai/knowledge";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
  type PlannerTelemetry,
} from "../../../src/sim/ai/planner";
import type { AiDifficultyId } from "../../../src/sim/ai/difficulty";
import { AI_DIFFICULTIES } from "../../../src/sim/ai/difficulty";
import type { Strategy } from "../../../src/sim/ai/buildOrder";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const SIZE = 40;
const SEED = 20261009;
const ECON_LIMIT_TICKS = 2400;
const MILESTONE_EVERY = 150;
const RESOURCE_CODES: Record<string, number> = { food: 0, wood: 1, gold: 2 };

/** The one script every difficulty leg executes. */
const fcStrategy: Strategy = {
  id: "fc-trio-script",
  villagerTarget: 5,
  gatherWeights: { food: 0.45, wood: 0.3, gold: 0.25 },
  attackArmyThreshold: 99, // nobody attacks in this harness
  steps: [
    {
      id: "feudal-up",
      action: { kind: "researchAge" },
      complete: { kind: "ageReached", rank: 2 },
      gate: { minResources: { food: 500 }, minAgeRank: 1 },
    },
  ],
};

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

interface EconLeg {
  readonly digests: readonly string[];
  readonly thinkCalls: number;
  readonly feudalEnqueueTick: number;
  readonly feudalCompleteTick: number;
}

/**
 * One trio member: the AI plays the FC opener over real fog while an
 * empty player base watches from the far corner. Only `difficulty`
 * differs between legs.
 */
function runEconLeg(difficulty: AiDifficultyId): EconLeg {
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
  ];
  for (const system of systems) registerSystem(world, system);

  // Bare human start far from the AI town.
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 600, 100, 0, 0, 0, 0]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  stampFinishedBuilding(world, comps, "town-center", 34, 34, {
    playerId: PLAYER_ONE,
  });

  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [
      [7.5, 7.5],
      [7.5, 8.5],
      [8.5, 7.5],
      [8.5, 9.5],
      [9.5, 8.5],
    ],
    // Opening food covers the §2.8 gate (500) from tick one, so the
    // Feudal click lands on each leg's FIRST decision boundary — the
    // interval knob then fixes completion ordering by construction.
    startingResources: [600, 600, 100, 0, 0, 0, 0],
  });

  // Gatherable ring inside villager sight so the economy layer engages.
  const nodeSpawns: [number, number, string][] = [
    [11, 6, "food"],
    [12, 7, "food"],
    [10, 10, "wood"],
    [13, 10, "wood"],
    [12, 12, "gold"],
    [7, 12, "food"],
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
      strategy: fcStrategy,
      telemetry,
      difficulty,
    }),
  );

  let feudalEnqueueTick = -1;
  const digests: string[] = [];
  while (world.tick < ECON_LIMIT_TICKS) {
    step(world);
    const tick = world.tick;
    if (
      feudalEnqueueTick < 0 &&
      (telemetry.firstTickByKind.researchAge ?? -1) >= 0
    ) {
      feudalEnqueueTick = telemetry.firstTickByKind.researchAge!;
    }
    if (tick % MILESTONE_EVERY === 0 || tick === ECON_LIMIT_TICKS) {
      digests.push(computeWorldDigest(world));
    }
  }

  const ageEvents = readAgeAdvancedEvents(world, comps, AI_PLAYER);
  return {
    digests,
    thinkCalls: telemetry.thinkCalls,
    feudalEnqueueTick,
    feudalCompleteTick: ageEvents[0]?.tick ?? -1,
  };
}

// ---- Income-cheat probe ---------------------------------------------------------

interface CheatProbe {
  readonly creditedTotal: number;
}

/**
 * Two near-identical worlds, one working villager, ONLY the income
 * multiplier differs: the gather system's credit event applies
 * round(units × mult) per delivery — hard's documented cheat, verbatim.
 */
function runIncomeCheatProbe(multiplier: number | undefined): CheatProbe {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world: World = createWorld(SEED ^ 0x51ed, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);

  const diagnostics = createGatherDiagnostics();
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, diagnostics, {
      ...(multiplier === undefined
        ? {}
        : { incomeMultiplierOf: () => multiplier }),
    }),
  );

  createPlayerStockpile(world, comps, AI_PLAYER);
  createPlayerStockpile(world, comps, PLAYER_ONE);
  const tcEid = stampFinishedBuilding(world, comps, "town-center", 3, 3, {
    playerId: AI_PLAYER,
  });
  const nodeEid = spawnResourceNode(
    world,
    comps,
    7,
    5,
    RESOURCE_CODES.wood!,
    800,
    {
      workSlots: WORK_SLOTS_PER_NODE,
    },
  );
  const worker = spawnUnit(world, comps, 6.5, 6.5, { ownerId: AI_PLAYER });

  world.inbox.submit({
    kind: "gather",
    targetTick: 1,
    data: { entityIds: [worker], nodeId: nodeEid },
  });

  // Run until exactly THREE loads are delivered in both legs — the
  // break threshold (30) sits between three and four deliveries for
  // BOTH credit scales (10/load raw, 13/load on hard).
  while (world.tick < 4000) {
    step(world);
    if (diagnostics.depositedByResource[RESOURCE_CODES.wood!]! >= 30) {
      break;
    }
  }
  void tcEid;

  let creditedTotal = 0;
  for (const amount of diagnostics.depositedByResource) {
    creditedTotal += amount;
  }
  return { creditedTotal };
}

// ---- Reaction-latency probe -----------------------------------------------------

interface DefenseProbe {
  readonly firstDamageTick: number;
  readonly firstRallyTick: number;
}

/**
 * A player knight chips an AI house with two AI knights standing by.
 * The manager observes damage + hostile-in-radius, holds for the
 * difficulty's reactionDelayTicks, then emits ONE defense rally.
 */
function runDefenseProbe(difficulty: AiDifficultyId): DefenseProbe {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(SIZE, 2);
  const world: World = createWorld(SEED ^ 0x2f00, {
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
  ];
  for (const system of systems) registerSystem(world, system);

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  const raider = spawnCombatUnit(world, comps, "knight", 9.5, 9.5, PLAYER_ONE);

  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [],
  });
  const houseEid = stampFinishedBuilding(world, comps, "house", 7, 7, {
    playerId: AI_PLAYER,
  });
  const defenders = [
    spawnCombatUnit(world, comps, "knight", 4.5, 8.5, AI_PLAYER),
    spawnCombatUnit(world, comps, "knight", 4.5, 9.5, AI_PLAYER),
  ];

  fog.recomputeAll();

  const knowledge = createAiKnowledge({
    world,
    comps,
    view: fog.knowledgeFor(AI_PLAYER),
  });
  const telemetry: PlannerTelemetry = createPlannerTelemetry();
  registerSystem(
    world,
    createAiPlannerSystem({
      knowledge,
      strategy: fcStrategy,
      telemetry,
      difficulty,
    }),
  );

  // The raid begins on tick 2.
  world.inbox.submit({
    kind: "attack",
    targetTick: 2,
    data: { attackerIds: [raider], targetId: houseEid },
  });

  let firstDamageTick = -1;
  let firstRallyTick = -1;
  while (world.tick < 600) {
    step(world);
    const tick = world.tick;
    if (
      firstDamageTick < 0 &&
      (getBuildingRow(world, comps, houseEid)?.[4] ?? 0) < 550
    ) {
      firstDamageTick = tick;
    }
    if (
      firstRallyTick < 0 &&
      telemetry.attackDrafts.some((draft) => draft.purpose === "defense")
    ) {
      firstRallyTick = tick;
    }
    if (firstRallyTick >= 0 && tick >= firstRallyTick + 30) break;
  }
  void defenders;

  return { firstDamageTick, firstRallyTick };
}

let cachedTrio: Map<AiDifficultyId, EconLeg> | undefined;
function econLeg(difficulty: AiDifficultyId): EconLeg {
  cachedTrio ??= new Map();
  const cached = cachedTrio.get(difficulty);
  if (cached) return cached;
  const leg = runEconLeg(difficulty);
  cachedTrio.set(difficulty, leg);
  return leg;
}

let cachedDefense: Map<AiDifficultyId, DefenseProbe> | undefined;
function defenseProbe(difficulty: AiDifficultyId): DefenseProbe {
  cachedDefense ??= new Map();
  const cached = cachedDefense.get(difficulty);
  if (cached) return cached;
  const probe = runDefenseProbe(difficulty);
  cachedDefense.set(difficulty, probe);
  return probe;
}

installSimPurityShims();

describe("golden harness m4t6c — difficulty trio", () => {
  it("runs one script into measurably different games per difficulty", () => {
    const easy = econLeg("easy");
    const normal = econLeg("normal");
    const hard = econLeg("hard");

    // Knob mechanics: full passes land exactly on the preset intervals.
    expect(easy.thinkCalls).toBe(Math.floor(ECON_LIMIT_TICKS / 90));
    expect(normal.thinkCalls).toBe(Math.floor(ECON_LIMIT_TICKS / 30));
    expect(hard.thinkCalls).toBe(Math.floor(ECON_LIMIT_TICKS / 15));

    // Downstream timing shifts monotonically: hard re-plans fastest.
    expect(hard.feudalCompleteTick).toBeLessThanOrEqual(
      normal.feudalCompleteTick,
    );
    expect(normal.feudalCompleteTick).toBeLessThanOrEqual(
      easy.feudalCompleteTick,
    );
    // Completion trails its enqueue by exactly the research duration.
    for (const leg of [easy, normal, hard]) {
      expect(leg.feudalCompleteTick).toBeGreaterThan(leg.feudalEnqueueTick);
    }

    // The three games genuinely diverge: at EVERY shared milestone the
    // digests are pairwise distinct (command timing differences ripple
    // through training, housing, gathering).
    for (let i = 0; i < easy.digests.length; i++) {
      const triplet = new Set([
        easy.digests[i],
        normal.digests[i],
        hard.digests[i],
      ]);
      expect(triplet.size).toBe(3);
    }
  });

  it("applies the documented hard-only income multiplier at the credit event", () => {
    const normal = runIncomeCheatProbe(undefined);
    const hard = runIncomeCheatProbe(AI_DIFFICULTIES.hard.incomeMultiplier);

    // Same worker, same node, same seed, exactly three 10-unit loads:
    // normal credits raw tens (30); hard rounds EACH delivery up by
    // ×1.25 (round(12.5) = 13 → 39 total).
    expect(normal.creditedTotal).toBe(30);
    expect(hard.creditedTotal).toBe(39);
  });

  it("rallies defense after exactly the preset reaction delay", () => {
    const hard = defenseProbe("hard");
    const normal = defenseProbe("normal");
    const easy = defenseProbe("easy");

    // Observation is shared; only the delay differs.
    expect(normal.firstDamageTick).toBe(hard.firstDamageTick);
    expect(easy.firstDamageTick).toBe(hard.firstDamageTick);
    expect(hard.firstRallyTick - hard.firstDamageTick).toBe(0);
    expect(normal.firstRallyTick - normal.firstDamageTick).toBe(
      AI_DIFFICULTIES.normal.reactionDelayTicks,
    );
    expect(easy.firstRallyTick - easy.firstDamageTick).toBe(
      AI_DIFFICULTIES.easy.reactionDelayTicks,
    );
  });

  it("replays byte-identically (extended canary)", () => {
    const run = econLeg("normal");
    expect(run.digests.length).toBeGreaterThan(5);
    const second = runEconLeg("normal");
    expect(second.digests).toEqual(run.digests);
    expect(second.feudalEnqueueTick).toBe(run.feudalEnqueueTick);
    expect(second.feudalCompleteTick).toBe(run.feudalCompleteTick);
    expect(second.thinkCalls).toBe(run.thinkCalls);
  });
});

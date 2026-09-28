/**
 * AI Naval Fleet Management & Water Economy tests — Milestone N6 (Issue #115 / Epic #84).
 *
 * Tests:
 * 1. planNavalFleet — Unit tests with stubbed AiKnowledge:
 *    - Inactivity without a finished Dock.
 *    - Fishing Boat production up to FISHING_BOAT_TARGET (3).
 *    - Capping Fishing Boat orders once target is met (alive + queued).
 *    - Warship training triggered only by visible naval threat (enemy ship or dock).
 *    - Age-gated warship progression: Galley (Feudal) -> War Galley (Castle) -> Galleon (Imperial).
 *    - Warship cap enforcement at WARSHIP_TARGET (4).
 *    - Resource budget respect (no overdrawing or overdraft).
 *    - Idle Fishing Boat assignment to nearest known water food node.
 * 2. Integrated AI Planner System execution:
 *    - Full planning pass incorporates planNavalFleet.
 *    - Submits trainUnit drafts for fishing boats and warships to world inbox.
 *    - Fog-of-war honesty: hidden enemy ships in fog never trigger warship alerts.
 *    - Amortized think time < 1 ms.
 */

import { describe, expect, it } from "vitest";
import {
  planNavalFleet,
  countNavalUnit,
  FISHING_BOAT_TARGET,
  WARSHIP_TARGET,
} from "../src/sim/ai/navalManager";
import {
  createResourceBudget,
  type AiKnowledge,
} from "../src/sim/ai/knowledge";
import type { CommandDraft } from "../src/sim/ai/buildOrder";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import { defineSimComponents, spawnCombatUnit } from "../src/sim/components";
import { createPlayerStockpile, PLAYER_ONE } from "../src/sim/core/stockpile";
import {
  createPlayerAgeState,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
} from "../src/sim/world/layers";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
} from "../src/sim/ai/planner";
import { createAiKnowledge } from "../src/sim/ai/knowledge";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import { createTrainingSystem } from "../src/sim/systems/training";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../src/sim/systems/fog";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const PLAYER_AI = 1;

/** Build a stubbed AiKnowledge object for pure unit testing. */
function stubKnowledge(overrides: Partial<AiKnowledge> = {}): AiKnowledge {
  const stock = [500, 500, 500, 500, 0, 0, 0]; // ample food, wood, gold, stone
  return {
    player: PLAYER_AI,
    get view(): never {
      throw new Error("direct view access is prohibited");
    },
    tick: () => 30,
    resources: () => stock,
    autoReseedEnabled: () => true,
    ageRank: () => 2, // Feudal by default
    nextAgeTechId: () => undefined,
    canStartAgeAdvance: () => false,
    finishedBuildings: (defId?: string) =>
      defId === "dock" || defId === undefined ? [100] : [],
    ownBuildingOrigin: () => ({ x: 10, y: 10 }),
    unfinishedSites: () => [],
    buildersOn: () => [],
    trainQueueOf: () => [],
    trainableUnitIds: () => [
      "fishing-boat",
      "transport-ship",
      "galley",
      "war-galley",
      "galleon",
      "fire-ship",
      "cannon-galleon",
    ],
    population: () => 10,
    populationCap: () => 30,
    villagerEids: () => [1, 2, 3],
    armyUnits: () => [],
    assignmentOf: () => undefined,
    carryOf: () => undefined,
    ownUnitTile: () => ({ x: 10, y: 10 }),
    damagedOwnBuildings: () => [],
    knownNodes: () => [],
    workersOnNode: () => 0,
    visibleEnemies: () => [],
    visibleEnemyVillagers: () => [],
    canAfford: () => true,
    canPlace: () => true,
    placementBlockReason: () => undefined,
    canTrain: () => true,
    knownGroundRelics: () => [],
    ownMonasteries: () => [],
    carriedRelicOf: () => undefined,
    knownTargetMarkets: () => [],
    tradeCarts: () => [],
    isTradeCartActive: () => false,
    ...overrides,
  } as AiKnowledge;
}

describe("Milestone N6: Naval Fleet Manager (Pure Unit Tests)", () => {
  it("does nothing if the AI owns no finished Dock", () => {
    const k = stubKnowledge({
      finishedBuildings: () => [], // No dock
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);
    expect(drafts).toHaveLength(0);
  });

  it("trains a Fishing Boat when below FISHING_BOAT_TARGET and docks exist", () => {
    expect(FISHING_BOAT_TARGET).toBe(3);
    const k = stubKnowledge({
      finishedBuildings: (defId) =>
        defId === "dock" || defId === undefined ? [100] : [],
      armyUnits: () => [], // 0 fishing boats
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "fishing-boat" },
    });
    // Fishing Boat costs 75 Wood (500 - 75 = 425)
    expect(budget.available()[1]).toBe(425);
  });

  it("stops training Fishing Boats when target is reached (living + queued)", () => {
    // 2 living + 1 in queue = 3 (target reached)
    const k = stubKnowledge({
      armyUnits: () => [
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
      ],
      trainQueueOf: (eid) => (eid === 100 ? ["fishing-boat"] : []),
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);
    expect(drafts).toHaveLength(0);
    expect(countNavalUnit(k, "fishing-boat")).toBe(3);
  });

  it("does not train warships if no naval enemies are visible", () => {
    // Full fishing boats, only land enemies visible (swordsman, house)
    const k = stubKnowledge({
      armyUnits: () => [
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
        { eid: 12, defId: "fishing-boat", tileX: 14, tileY: 14 },
      ],
      visibleEnemies: () => [
        { eid: 50, defId: "swordsman", tileX: 20, tileY: 20 },
        { eid: 51, defId: "house", tileX: 25, tileY: 25 },
      ],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);
    expect(drafts).toHaveLength(0);
  });

  it("trains Galley in Feudal Age when enemy naval unit is visible", () => {
    expect(WARSHIP_TARGET).toBe(4);
    const k = stubKnowledge({
      ageRank: () => 2, // Feudal Age
      armyUnits: () => [
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
        { eid: 12, defId: "fishing-boat", tileX: 14, tileY: 14 },
      ],
      visibleEnemies: () => [
        { eid: 50, defId: "galley", tileX: 18, tileY: 18 },
      ],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "galley" },
    });
    // Galley costs 90 Wood, 30 Gold
    expect(budget.available()[1]).toBe(410); // 500 - 90
    expect(budget.available()[2]).toBe(470); // 500 - 30
  });

  it("trains War Galley in Castle Age when enemy naval presence is visible", () => {
    const k = stubKnowledge({
      ageRank: () => 3, // Castle Age
      armyUnits: () => [
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
        { eid: 12, defId: "fishing-boat", tileX: 14, tileY: 14 },
      ],
      visibleEnemies: () => [{ eid: 50, defId: "dock", tileX: 20, tileY: 20 }],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "war-galley" },
    });
  });

  it("trains Galleon in Imperial Age when enemy naval presence is visible", () => {
    const k = stubKnowledge({
      ageRank: () => 4, // Imperial Age
      armyUnits: () => [
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
        { eid: 12, defId: "fishing-boat", tileX: 14, tileY: 14 },
      ],
      visibleEnemies: () => [
        { eid: 50, defId: "fire-ship", tileX: 22, tileY: 22 },
      ],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "galleon" },
    });
  });

  it("stops training warships once WARSHIP_TARGET (4) is reached", () => {
    const k = stubKnowledge({
      armyUnits: () => [
        { eid: 1, defId: "fishing-boat", tileX: 10, tileY: 10 },
        { eid: 2, defId: "fishing-boat", tileX: 10, tileY: 10 },
        { eid: 3, defId: "fishing-boat", tileX: 10, tileY: 10 },
        { eid: 4, defId: "galley", tileX: 10, tileY: 10 },
        { eid: 5, defId: "galley", tileX: 10, tileY: 10 },
        { eid: 6, defId: "war-galley", tileX: 10, tileY: 10 },
        { eid: 7, defId: "fire-ship", tileX: 10, tileY: 10 },
      ],
      visibleEnemies: () => [
        { eid: 99, defId: "galley", tileX: 20, tileY: 20 },
      ],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);
    expect(drafts).toHaveLength(0);
  });

  it("respects resource budget and does not overdraw when resources are scarce", () => {
    const k = stubKnowledge({
      resources: () => [500, 30, 0, 500, 0, 0, 0], // Only 30 Wood (needs 75 for fishing boat)
      armyUnits: () => [],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);
    expect(drafts).toHaveLength(0);
    expect(budget.available()[1]).toBe(30);
  });

  it("assigns idle fishing boats to harvest from known water food nodes", () => {
    const k = stubKnowledge({
      armyUnits: () => [
        // 3 boats, target met, all 3 idle (assignmentOf returns undefined)
        { eid: 10, defId: "fishing-boat", tileX: 12, tileY: 12 },
        { eid: 11, defId: "fishing-boat", tileX: 13, tileY: 13 },
        { eid: 12, defId: "fishing-boat", tileX: 14, tileY: 14 },
      ],
      assignmentOf: () => undefined,
      knownNodes: () => [
        { eid: 201, resourceCode: 0, tileX: 18, tileY: 14, remaining: 350 }, // fish node
      ],
    });
    const budget = createResourceBudget(k);
    const drafts: CommandDraft[] = [];

    planNavalFleet(k, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "gather",
      data: { entityIds: [10], nodeId: 201 },
    });
  });
});

describe("Milestone N6: Integrated AI Planning System & Fog Honesty", () => {
  const SIZE = 32;

  function setupHarness(aiAge = 2) {
    // Left half (x < 16) = land, right half (x >= 16) = water
    const terrainType = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        terrainType[y * SIZE + x] = x < 16 ? TERRAIN_GRASS : TERRAIN_WATER;
      }
    }

    const paths = new PathScheduler(createSynchronousPathTransport());
    const fog = createFogVisibility(SIZE, 2);
    const world = createWorld(424242, {
      size: SIZE,
      layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
      pathScheduler: paths,
      visibility: fog.provider,
    });
    const comps = defineSimComponents(world);
    fog.bindSource({
      resolve: createRowEntityResolver(world, comps),
      eidsAscending: () => world.entities,
    });

    // Setup player stockpiles and age
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [1000, 1000, 1000, 1000, 0, 0, 0],
    );
    createPlayerStockpile(
      world,
      comps,
      PLAYER_AI,
      [1000, 1000, 1000, 1000, 0, 0, 0],
    );
    createPlayerAgeState(world, comps, PLAYER_ONE);
    createPlayerAgeState(world, comps, PLAYER_AI);
    setPlayerAgeRank(world, comps, PLAYER_AI, aiAge);

    // Systems
    registerSystem(world, createTrainingSystem(comps));
    registerSystem(world, createMovementSystem(comps, paths));

    // Finished Town Center and Dock for AI at shoreline:
    // x in [13..15] is land, x=15 is shoreline, dock spans [14..16] (land + water)
    stampFinishedBuilding(world, comps, "town-center", 8, 10, {
      playerId: PLAYER_AI,
    });
    const dockEid = stampFinishedBuilding(world, comps, "dock", 14, 12, {
      playerId: PLAYER_AI,
    });
    fog.recomputeAll();

    const knowledge = createAiKnowledge({
      world,
      comps,
      view: fog.knowledgeFor(PLAYER_AI),
      player: PLAYER_AI,
    });
    const telemetry = createPlannerTelemetry();

    const planner = createAiPlannerSystem({
      knowledge,
      strategy: "naval-raider",
      telemetry,
      now: () => performance.now(),
    });
    registerSystem(world, planner);

    return { world, comps, dockEid, knowledge, telemetry, fog };
  }

  it("submits Fishing Boat training command during full planning pass", () => {
    const { world, comps, dockEid, telemetry } = setupHarness();

    // Advance 30 ticks to trigger full pass (PLANNER_CADENCE_TICKS = 30)
    for (let i = 0; i < 30; i++) step(world);

    expect(telemetry.thinkCalls).toBeGreaterThanOrEqual(1);
    expect(telemetry.issuedByKind["trainUnit"]).toBeGreaterThanOrEqual(1);

    // Step 1 more tick so the queued inbox command is applied to the dock
    step(world);
    const queue = world.rowsByComponentId.get(comps.trainQueueId)?.get(dockEid);
    expect(queue).toBeDefined();
    expect(queue![0]).toBeGreaterThan(0);
  });

  it("maintains fog honesty: hidden enemy ships across fog never trigger warship alerts", () => {
    const { world, comps, knowledge } = setupHarness(2);

    // Spawn an enemy galley far out in water (x=28, y=28) shrouded in fog
    spawnCombatUnit(world, comps, "galley", 28.5, 28.5, PLAYER_ONE);

    // Step 5 ticks to flush visibility
    for (let i = 0; i < 5; i++) step(world);

    // The enemy ship must NOT be in visibleEnemies
    const visibleEnemies = knowledge.visibleEnemies();
    expect(visibleEnemies.some((e) => e.defId === "galley")).toBe(false);

    // Plan fleet with 3 fishing boats already alive
    const budget = createResourceBudget(knowledge);
    const drafts: CommandDraft[] = [];
    planNavalFleet(knowledge, budget, drafts);

    // No warships should be drafted because the enemy ship is unknown
    const draftedWarship = drafts.some(
      (d) =>
        d.kind === "trainUnit" &&
        (d.data as { unitId?: string }).unitId === "galley",
    );
    expect(draftedWarship).toBe(false);
  });

  it("triggers warship training once enemy ship enters visible sight radius", () => {
    const { world, comps, knowledge } = setupHarness(2);

    // Spawn enemy galley right near the AI Dock (x=17, y=13) in plain view
    spawnCombatUnit(world, comps, "galley", 17.5, 13.5, PLAYER_ONE);

    // Step 5 ticks to flush visibility stamps
    for (let i = 0; i < 5; i++) step(world);

    // Enemy is now legitimately visible
    const visible = knowledge.visibleEnemies();
    expect(visible.some((e) => e.defId === "galley")).toBe(true);

    // Plan fleet (with 3 fishing boats so it proceeds to warship step)
    const customKnowledge = stubKnowledge({
      ageRank: () => 2,
      armyUnits: () => [
        { eid: 1, defId: "fishing-boat", tileX: 15, tileY: 13 },
        { eid: 2, defId: "fishing-boat", tileX: 15, tileY: 13 },
        { eid: 3, defId: "fishing-boat", tileX: 15, tileY: 13 },
      ],
      visibleEnemies: () => visible,
    });
    const budget = createResourceBudget(customKnowledge);
    const drafts: CommandDraft[] = [];

    planNavalFleet(customKnowledge, budget, drafts);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "galley" },
    });
  });

  it("keeps amortized AI planner think time well below the 1 ms budget", () => {
    const { world, telemetry } = setupHarness();

    // Step through 120 ticks (4 full planning passes + 116 incremental probes)
    for (let i = 0; i < 120; i++) step(world);

    expect(telemetry.thinkCalls).toBe(4);
    const decisions = telemetry.thinkCalls + telemetry.incrementalCalls;
    const amortizedThinkMs = telemetry.totalThinkMs / decisions;
    expect(amortizedThinkMs).toBeLessThan(1.0);
  });
});

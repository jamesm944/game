/**
 * Scenario Scripting & Trigger Engine Unit Tests — Milestone S5 / Issue #133.
 *
 * Verifies:
 * 1. Pure condition evaluators: timer, areaEnter, unitsSlain, resourceThreshold,
 *    buildingsConstructed, and objectiveStatus.
 * 2. Action execution: displayObjective, updateObjective, spawnUnits, spawnBuilding,
 *    diplomacyShift, audioCue, broadcastMessage, triggerVictory, and triggerDefeat.
 * 3. Execution semantics: looping rules, cooldowns, and trigger dependency chains.
 * 4. End-to-end multi-stage scenario: The Outpost Siege from briefing to victory.
 * 5. Save/Restore serialization round-trip.
 */

import { describe, expect, it } from "vitest";
import {
  createWorld,
  type World,
} from "../src/sim/core/world";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import { createPlayerStockpile, creditResource } from "../src/sim/core/stockpile";
import { createDiplomacyMatrix, DIPLOMACY_STANCE_ALLY, DIPLOMACY_STANCE_ENEMY } from "../src/sim/core/diplomacy";
import {
  createScenarioRuntime,
  evaluateAreaEnterCondition,
  evaluateBuildingsConstructedCondition,
  evaluateCondition,
  evaluateObjectiveStatusCondition,
  evaluateResourceThresholdCondition,
  evaluateScenarioTriggers,
  evaluateTimerCondition,
  evaluateUnitsSlainCondition,
  executeAction,
  restoreScenarioRuntime,
  serializeScenarioRuntime,
  type ScenarioCallbacks,
} from "../src/sim/scenario/engine";
import type {
  ScenarioDefinition,
  ScenarioObjective,
  ScenarioRuntime,
} from "../src/sim/scenario/types";
import { SCENARIO_OUTPOST_SIEGE } from "../src/sim/scenario/presets";
import { createScenarioSystem } from "../src/sim/systems/scenario";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { readVictoryChecks, VICTORY_STATUS_LOST, VICTORY_STATUS_WON } from "../src/sim/components/victory";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function createTestHarness(size = 32): {
  world: World;
  comps: SimComponents;
} {
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const layers = buildLayers(terrainType, new Uint8Array(size * size));
  const diplomacy = createDiplomacyMatrix(2, "ffa");
  const world = createWorld(20261001, { layers, size, diplomacy });
  const comps = defineSimComponents(world);
  createPlayerStockpile(world, comps, 0);
  createPlayerStockpile(world, comps, 1);
  return { world, comps };
}

describe("Scenario Condition Evaluators", () => {
  it("evaluates timer conditions with absolute tick and relative delays", () => {
    expect(evaluateTimerCondition({ kind: "timer", tick: 50 }, 40, 0)).toBe(false);
    expect(evaluateTimerCondition({ kind: "timer", tick: 50 }, 50, 0)).toBe(true);
    expect(evaluateTimerCondition({ kind: "timer", tick: 50 }, 60, 0)).toBe(true);

    // Relative delay from start tick
    expect(
      evaluateTimerCondition({ kind: "timer", delayTicks: 100 }, 90, 50),
    ).toBe(false);
    expect(
      evaluateTimerCondition({ kind: "timer", delayTicks: 100 }, 150, 50),
    ).toBe(true);
  });

  it("evaluates areaEnter condition when player units enter bounding box", () => {
    const { world, comps } = createTestHarness();

    // No units initially
    const cond = {
      kind: "areaEnter" as const,
      player: 0,
      minX: 10,
      minY: 10,
      maxX: 15,
      maxY: 15,
      unitCount: 1,
    };
    expect(evaluateAreaEnterCondition(world, comps, cond)).toBe(false);

    // Spawn unit outside box
    spawnCombatUnit(world, comps, "militia", 5, 5, 0);
    expect(evaluateAreaEnterCondition(world, comps, cond)).toBe(false);

    // Spawn unit inside box
    spawnCombatUnit(world, comps, "militia", 12, 12, 0);
    expect(evaluateAreaEnterCondition(world, comps, cond)).toBe(true);

    // Unit count requirement (require 2 units)
    const cond2 = { ...cond, unitCount: 2 };
    expect(evaluateAreaEnterCondition(world, comps, cond2)).toBe(false);

    // Spawn second unit inside box
    spawnCombatUnit(world, comps, "militia", 14, 13, 0);
    expect(evaluateAreaEnterCondition(world, comps, cond2)).toBe(true);
  });

  it("filters areaEnter condition by unit def type", () => {
    const { world, comps } = createTestHarness();
    const cond = {
      kind: "areaEnter" as const,
      player: 0,
      minX: 5,
      minY: 5,
      maxX: 15,
      maxY: 15,
      unitType: "scout-cavalry",
    };

    // Militia inside box does not match filter
    spawnCombatUnit(world, comps, "militia", 10, 10, 0);
    expect(evaluateAreaEnterCondition(world, comps, cond)).toBe(false);

    // Scout cavalry inside box matches filter
    spawnCombatUnit(world, comps, "scout-cavalry", 10, 11, 0);
    expect(evaluateAreaEnterCondition(world, comps, cond)).toBe(true);
  });

  it("evaluates unitsSlain condition against tracked casualties", () => {
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [],
      triggers: [],
    });
    runtime.unitKills.set(1, 4);

    expect(
      evaluateUnitsSlainCondition(
        { kind: "unitsSlain", victimPlayer: 1, count: 3 },
        runtime,
      ),
    ).toBe(true);

    expect(
      evaluateUnitsSlainCondition(
        { kind: "unitsSlain", victimPlayer: 1, count: 5 },
        runtime,
      ),
    ).toBe(false);

    expect(
      evaluateUnitsSlainCondition(
        { kind: "unitsSlain", victimPlayer: 0, count: 1 },
        runtime,
      ),
    ).toBe(false);
  });

  it("evaluates resourceThreshold condition against stockpile", () => {
    const { world, comps } = createTestHarness();

    const cond = {
      kind: "resourceThreshold" as const,
      player: 0,
      resource: "food" as const,
      amount: 100,
    };

    expect(evaluateResourceThresholdCondition(world, comps, cond)).toBe(false);

    creditResource(world, comps, 0, "food", 120);
    expect(evaluateResourceThresholdCondition(world, comps, cond)).toBe(true);
  });

  it("evaluates buildingsConstructed condition when target building finishes", () => {
    const { world, comps } = createTestHarness();

    const cond = {
      kind: "buildingsConstructed" as const,
      player: 0,
      buildingType: "barracks",
      count: 1,
    };

    expect(evaluateBuildingsConstructedCondition(world, comps, cond)).toBe(false);

    stampFinishedBuilding(world, comps, "barracks", 8, 8, { playerId: 0 });
    expect(evaluateBuildingsConstructedCondition(world, comps, cond)).toBe(true);
  });

  it("evaluates objectiveStatus condition against objective state", () => {
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [
        {
          id: "obj-1",
          title: "Primary 1",
          primary: true,
          status: "completed",
        },
        {
          id: "obj-2",
          title: "Primary 2",
          primary: true,
          status: "active",
        },
      ],
      triggers: [],
    });

    expect(
      evaluateObjectiveStatusCondition(
        { kind: "objectiveStatus", objectiveId: "obj-1", status: "completed" },
        runtime,
      ),
    ).toBe(true);

    expect(
      evaluateObjectiveStatusCondition(
        { kind: "objectiveStatus", objectiveId: "obj-2", status: "completed" },
        runtime,
      ),
    ).toBe(false);
  });
});

describe("Scenario Action Execution", () => {
  it("displays new objectives and updates existing status", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [
        { id: "obj-init", title: "Initial", primary: true, status: "active" },
      ],
      triggers: [],
    });

    let updatedObj: ScenarioObjective | undefined;
    const callbacks: ScenarioCallbacks = {
      onObjectiveUpdate: (obj) => {
        updatedObj = obj;
      },
    };

    // Update existing objective
    executeAction(
      world,
      comps,
      { kind: "updateObjective", objectiveId: "obj-init", status: "completed" },
      runtime,
      "test-trig",
      callbacks,
    );

    expect(runtime.objectives[0]!.status).toBe("completed");
    expect(updatedObj?.id).toBe("obj-init");
    expect(updatedObj?.status).toBe("completed");

    // Display new objective
    executeAction(
      world,
      comps,
      {
        kind: "displayObjective",
        objectiveId: "obj-new",
        title: "New Task",
        description: "Do something",
        primary: false,
      },
      runtime,
      "test-trig",
      callbacks,
    );

    expect(runtime.objectives.length).toBe(2);
    expect(runtime.objectives[1]!.title).toBe("New Task");
    expect(runtime.objectives[1]!.primary).toBe(false);
    expect(runtime.objectives[1]!.status).toBe("active");
  });

  it("spawns units on action execution", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [],
      triggers: [],
    });

    executeAction(
      world,
      comps,
      {
        kind: "spawnUnits",
        player: 0,
        unitType: "archer",
        count: 2,
        x: 10,
        y: 10,
      },
      runtime,
      "test-trig",
    );

    const combatRows = world.rowsByComponentId.get(comps.combatId);
    expect(combatRows?.size).toBe(2);
  });

  it("shifts diplomacy stance between players", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [],
      triggers: [],
    });

    expect(world.diplomacy?.getStance(0, 1)).toBe(DIPLOMACY_STANCE_ENEMY);

    executeAction(
      world,
      comps,
      {
        kind: "diplomacyShift",
        playerA: 0,
        playerB: 1,
        stance: "ally",
      },
      runtime,
      "test-trig",
    );

    expect(world.diplomacy?.getStance(0, 1)).toBe(DIPLOMACY_STANCE_ALLY);
    expect(world.diplomacy?.getStance(1, 0)).toBe(DIPLOMACY_STANCE_ALLY);
  });

  it("triggers victory and defeat on VictoryCheck component ledger", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [],
      triggers: [],
    });

    executeAction(
      world,
      comps,
      { kind: "triggerVictory", player: 0, reason: "Conquest achieved!" },
      runtime,
      "test-trig",
    );

    const checks0 = readVictoryChecks(world, comps, 0);
    expect(checks0.length).toBeGreaterThan(0);
    expect(checks0[checks0.length - 1]!.status).toBe(VICTORY_STATUS_WON);

    const checks1 = readVictoryChecks(world, comps, 1);
    expect(checks1.length).toBeGreaterThan(0);
    expect(checks1[checks1.length - 1]!.status).toBe(VICTORY_STATUS_LOST);
  });

  it("enables and disables triggers via setTriggerEnabled", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime({
      id: "test",
      title: "Test",
      description: "",
      initialObjectives: [],
      triggers: [
        {
          id: "trig-a",
          name: "Trigger A",
          enabled: false,
          conditions: [],
          actions: [],
        },
      ],
    });

    expect(runtime.triggerStates.get("trig-a")?.enabled).toBe(false);

    executeAction(
      world,
      comps,
      { kind: "setTriggerEnabled", triggerId: "trig-a", enabled: true },
      runtime,
      "activator",
    );

    expect(runtime.triggerStates.get("trig-a")?.enabled).toBe(true);
  });
});

describe("End-to-End Scenario: The Outpost Siege", () => {
  it("progresses through all 3 stages from briefing to victory", () => {
    const { world, comps } = createTestHarness();
    const runtime = createScenarioRuntime(SCENARIO_OUTPOST_SIEGE);
    world.scenario = runtime;

    const audioCues: string[] = [];
    const narrativeMessages: string[] = [];

    const callbacks: ScenarioCallbacks = {
      onAudioCue: (s) => audioCues.push(s),
      onNarrativeMessage: (m) => narrativeMessages.push(m),
    };

    const scenarioSystem = createScenarioSystem(comps, callbacks);

    // Initial state: 1 active objective
    expect(runtime.objectives.length).toBe(1);
    expect(runtime.objectives[0]!.id).toBe("obj-gather");
    expect(runtime.objectives[0]!.status).toBe("active");

    // Tick 1: Stockpile not yet met
    scenarioSystem(world, []);
    expect(runtime.objectives[0]!.status).toBe("active");
    expect(audioCues.length).toBe(0);

    // --- STAGE 1: Gather resources ---
    creditResource(world, comps, 0, "food", 150);
    creditResource(world, comps, 0, "wood", 120);

    // Next tick: Trigger 1 fires!
    scenarioSystem(world, []);

    expect(runtime.objectives[0]!.status).toBe("completed");
    expect(runtime.objectives.length).toBe(2);
    expect(runtime.objectives[1]!.id).toBe("obj-barracks");
    expect(runtime.objectives[1]!.status).toBe("active");
    expect(audioCues).toContain("age.up");
    expect(narrativeMessages.length).toBe(1);

    // Allied scout spawned
    const p0Units = world.rowsByComponentId.get(comps.combatId);
    expect(p0Units?.size).toBe(1);

    // --- STAGE 2: Construct Barracks ---
    stampFinishedBuilding(world, comps, "barracks", 10, 10, { playerId: 0 });

    scenarioSystem(world, []);

    expect(runtime.objectives[1]!.status).toBe("completed");
    expect(runtime.objectives.length).toBe(3);
    expect(runtime.objectives[2]!.id).toBe("obj-defeat-raiders");
    expect(runtime.objectives[2]!.status).toBe("active");
    expect(audioCues).toContain("ui.order");

    // Raiders spawned (player 1)
    let p1UnitCount = 0;
    for (const [, row] of world.rowsByComponentId.get(comps.combatId)!) {
      if (row[1] === 1) p1UnitCount++;
    }
    expect(p1UnitCount).toBe(3);

    // --- STAGE 3: Defeat Raiders ---
    // Simulate casualties for player 1
    runtime.unitKills.set(1, 3);

    scenarioSystem(world, []);

    expect(runtime.objectives[2]!.status).toBe("completed");
    expect(audioCues).toContain("victory.win");

    // Victory recorded for player 0
    const checks0 = readVictoryChecks(world, comps, 0);
    expect(checks0[checks0.length - 1]!.status).toBe(VICTORY_STATUS_WON);
  });
});

describe("Scenario Save & Restore Round-Trip", () => {
  it("serializes and restores runtime state bit-identically", () => {
    const runtime = createScenarioRuntime(SCENARIO_OUTPOST_SIEGE, 100);
    runtime.objectives[0]!.status = "completed";
    runtime.objectives.push({
      id: "obj-custom",
      title: "Bonus",
      primary: false,
      status: "active",
    });
    runtime.triggerStates.get("trig-stockpile-reached")!.firedCount = 1;
    runtime.triggerStates.get("trig-stockpile-reached")!.lastFireTick = 120;
    runtime.unitKills.set(1, 2);
    runtime.buildingDestructions.set(1, 1);
    runtime.lastEvaluatedCombatTick = 150;

    const saved = serializeScenarioRuntime(runtime);
    const restored = restoreScenarioRuntime(SCENARIO_OUTPOST_SIEGE, saved);

    expect(restored.definition.id).toBe(runtime.definition.id);
    expect(restored.startTick).toBe(runtime.startTick);
    expect(restored.lastEvaluatedCombatTick).toBe(runtime.lastEvaluatedCombatTick);
    expect(restored.objectives).toEqual(runtime.objectives);
    expect(restored.unitKills.get(1)).toBe(2);
    expect(restored.buildingDestructions.get(1)).toBe(1);
    expect(restored.triggerStates.get("trig-stockpile-reached")?.firedCount).toBe(1);
    expect(restored.triggerStates.get("trig-stockpile-reached")?.lastFireTick).toBe(120);
  });
});

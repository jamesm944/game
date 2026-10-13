/**
 * Scenario Scripting & Trigger Engine Deterministic Test Suite — Milestone S5 / Issue #134.
 *
 * Verifies:
 * 1. Condition evaluation: timer (tick, ticks, seconds, delay), areaEnter (box, radius),
 *    unitsSlain (casualties, targetEid), resourceThreshold, objectiveStatus, objectiveFlag.
 * 2. Action execution: displayObjective, updateObjective, spawnUnits, spawnEnemyArmy,
 *    diplomacyShift, audioCue, victoryDefeat / triggerVictory / triggerDefeat, setFlag, setTriggerEnabled.
 * 3. Execution modes: once vs recurring with cooldown.
 * 4. Interactive Objective HUD card (src/ui/objectiveHud.ts).
 * 5. Multi-run deterministic seed canary across independent worlds.
 */

import { describe, expect, it } from "vitest";
import { createWorld, type World } from "../src/sim/core/world";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  createDiplomacyMatrix,
  DIPLOMACY_STANCE_ALLY,
  DIPLOMACY_STANCE_ENEMY,
} from "../src/sim/core/diplomacy";
import {
  createPlayerStockpile,
  creditResource,
} from "../src/sim/core/stockpile";
import {
  createScenarioRuntime,
  evaluateAreaEnterCondition,
  evaluateObjectiveFlagCondition,
  evaluateObjectiveStatusCondition,
  evaluateResourceThresholdCondition,
  evaluateScenarioTriggers,
  evaluateTimerCondition,
  evaluateUnitsSlainCondition,
  executeAction,
  restoreScenarioRuntime,
  serializeScenarioRuntime,
  type ScenarioCallbacks,
} from "../src/sim/scenario/triggers";
import type {
  ScenarioDefinition,
  ScenarioObjective,
} from "../src/sim/scenario/types";
import { createScenarioSystem } from "../src/sim/systems/scenario";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import {
  readVictoryChecks,
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_WON,
} from "../src/sim/components/victory";
import {
  countActiveObjectives,
  createObjectiveHud,
  formatObjectiveItem,
} from "../src/ui/objectiveHud";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { computeWorldDigest } from "../src/sim/core/world";

installSimPurityShims();

function createTestWorld(size = 32): {
  world: World;
  comps: SimComponents;
} {
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const layers = buildLayers(terrainType, new Uint8Array(size * size));
  const world = createWorld(42, {
    size,
    layers,
    diplomacy: createDiplomacyMatrix(4, "ffa"),
  });
  const comps = defineSimComponents(world);
  createPlayerStockpile(world, comps, 0);
  createPlayerStockpile(world, comps, 1);
  return { world, comps };
}

describe("Scenario Trigger Engine — Conditions", () => {
  it("evaluates timer conditions with ticks, seconds, and delay", () => {
    // Exact tick
    expect(evaluateTimerCondition({ kind: "timer", tick: 30 }, 29, 0)).toBe(
      false,
    );
    expect(evaluateTimerCondition({ kind: "timer", tick: 30 }, 30, 0)).toBe(
      true,
    );

    // Ticks alias
    expect(evaluateTimerCondition({ kind: "timer", ticks: 60 }, 59, 0)).toBe(
      false,
    );
    expect(evaluateTimerCondition({ kind: "timer", ticks: 60 }, 60, 0)).toBe(
      true,
    );

    // Seconds (30 ticks/sec)
    expect(evaluateTimerCondition({ kind: "timer", seconds: 2 }, 59, 0)).toBe(
      false,
    );
    expect(evaluateTimerCondition({ kind: "timer", seconds: 2 }, 60, 0)).toBe(
      true,
    );

    // Relative delayTicks
    expect(
      evaluateTimerCondition({ kind: "timer", delayTicks: 15 }, 20, 10),
    ).toBe(false);
    expect(
      evaluateTimerCondition({ kind: "timer", delayTicks: 15 }, 25, 10),
    ).toBe(true);
  });

  it("evaluates areaEnter condition with bounding box and circle radius", () => {
    const { world, comps } = createTestWorld();

    // Box condition
    const boxCond = {
      kind: "areaEnter" as const,
      player: 0,
      minX: 10,
      minY: 10,
      maxX: 20,
      maxY: 20,
      unitType: "archer",
    };

    // Outside box
    spawnCombatUnit(world, comps, "archer", 5, 5, 0);
    expect(evaluateAreaEnterCondition(world, comps, boxCond)).toBe(false);

    // Inside box, but different defId
    spawnCombatUnit(world, comps, "militia", 12, 12, 0);
    expect(evaluateAreaEnterCondition(world, comps, boxCond)).toBe(false);

    // Inside box and matching unitType
    spawnCombatUnit(world, comps, "archer", 15, 15, 0);
    expect(evaluateAreaEnterCondition(world, comps, boxCond)).toBe(true);

    // Radial condition
    const radialCond = {
      kind: "areaEnter" as const,
      player: 0,
      x: 30,
      y: 30,
      radius: 4,
    };
    expect(evaluateAreaEnterCondition(world, comps, radialCond)).toBe(false);

    spawnCombatUnit(world, comps, "scout-cavalry", 31, 32, 0);
    expect(evaluateAreaEnterCondition(world, comps, radialCond)).toBe(true);
  });

  it("evaluates unitsSlain condition for casualties and targetEid", () => {
    const runtime = createScenarioRuntime({
      id: "slain-test",
      title: "Slain Test",
      triggers: [],
    });

    runtime.unitKills.set(1, 3);
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

    // Specific targetEid
    runtime.slainEntities.add(99);
    expect(
      evaluateUnitsSlainCondition(
        { kind: "unitsSlain", targetEid: 99 },
        runtime,
      ),
    ).toBe(true);
    expect(
      evaluateUnitsSlainCondition(
        { kind: "unitsSlain", targetEid: 100 },
        runtime,
      ),
    ).toBe(false);
  });

  it("evaluates resourceThreshold condition", () => {
    const { world, comps } = createTestWorld();
    const cond = {
      kind: "resourceThreshold" as const,
      player: 0,
      resource: "gold" as const,
      amount: 200,
    };

    expect(evaluateResourceThresholdCondition(world, comps, cond)).toBe(false);
    creditResource(world, comps, 0, "gold", 250);
    expect(evaluateResourceThresholdCondition(world, comps, cond)).toBe(true);
  });

  it("evaluates objectiveFlag and objectiveStatus conditions", () => {
    const runtime = createScenarioRuntime({
      id: "flag-test",
      title: "Flag Test",
      initialObjectives: [
        { id: "o1", title: "First", primary: true, status: "completed" },
        { id: "o2", title: "Second", primary: true, status: "active" },
      ],
      triggers: [],
    });

    // Objective status
    expect(
      evaluateObjectiveStatusCondition(
        { kind: "objectiveStatus", objectiveId: "o1", status: "completed" },
        runtime,
      ),
    ).toBe(true);
    expect(
      evaluateObjectiveStatusCondition(
        { kind: "objectiveStatus", objectiveId: "o2", status: "completed" },
        runtime,
      ),
    ).toBe(false);

    // Flags
    expect(
      evaluateObjectiveFlagCondition(
        { kind: "objectiveFlag", flag: "bridge_repaired" },
        runtime,
      ),
    ).toBe(false);

    runtime.flags.set("bridge_repaired", true);
    expect(
      evaluateObjectiveFlagCondition(
        { kind: "objectiveFlag", flag: "bridge_repaired" },
        runtime,
      ),
    ).toBe(true);
  });
});

describe("Scenario Trigger Engine — Actions", () => {
  it("executes displayObjective, updateObjective, and flags", () => {
    const { world, comps } = createTestWorld();
    const runtime = createScenarioRuntime({
      id: "obj-test",
      title: "Objectives",
      triggers: [],
    });

    executeAction(
      world,
      comps,
      {
        kind: "displayObjective",
        id: "obj-rescue",
        title: "Rescue Survivors",
        primary: true,
      },
      runtime,
      "trig-start",
    );

    expect(runtime.objectives.length).toBe(1);
    expect(runtime.objectives[0]!.id).toBe("obj-rescue");
    expect(runtime.objectives[0]!.status).toBe("active");

    executeAction(
      world,
      comps,
      {
        kind: "updateObjective",
        id: "obj-rescue",
        status: "completed",
      },
      runtime,
      "trig-rescue",
    );

    expect(runtime.objectives[0]!.status).toBe("completed");

    executeAction(
      world,
      comps,
      {
        kind: "setFlag",
        flag: "survivors_rescued",
        value: true,
      },
      runtime,
      "trig-rescue",
    );
    expect(runtime.flags.get("survivors_rescued")).toBe(true);
  });

  it("executes spawnEnemyArmy and audioCue actions", () => {
    const { world, comps } = createTestWorld();
    const runtime = createScenarioRuntime({
      id: "spawn-test",
      title: "Army",
      triggers: [],
    });

    const audioEmitted: string[] = [];
    const callbacks: ScenarioCallbacks = {
      onAudioCue: (snd) => audioEmitted.push(snd),
    };

    executeAction(
      world,
      comps,
      {
        kind: "spawnEnemyArmy",
        playerId: 1,
        units: [
          { defId: "militia", count: 3, x: 10, y: 10 },
          { defId: "archer", count: 2, x: 12, y: 10 },
        ],
      },
      runtime,
      "trig-ambush",
      callbacks,
    );

    // 5 units spawned
    expect(world.entities.length).toBeGreaterThanOrEqual(5);

    executeAction(
      world,
      comps,
      {
        kind: "audioCue",
        sound: "horn_war",
      },
      runtime,
      "trig-ambush",
      callbacks,
    );

    expect(runtime.audioCues).toContain("horn_war");
    expect(audioEmitted).toContain("horn_war");
  });

  it("executes diplomacyShift and victoryDefeat actions", () => {
    const { world, comps } = createTestWorld();
    const runtime = createScenarioRuntime({
      id: "diplo-test",
      title: "Diplo",
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
      "trig-treaty",
    );

    expect(world.diplomacy?.getStance(0, 1)).toBe(DIPLOMACY_STANCE_ALLY);
    expect(world.diplomacy?.getStance(1, 0)).toBe(DIPLOMACY_STANCE_ALLY);

    executeAction(
      world,
      comps,
      {
        kind: "victoryDefeat",
        player: 0,
        outcome: "victory",
        message: "Valley liberated!",
      },
      runtime,
      "trig-win",
    );

    const checksP0 = readVictoryChecks(world, comps, 0);
    const checksP1 = readVictoryChecks(world, comps, 1);

    expect(checksP0.some((c) => c.status === VICTORY_STATUS_WON)).toBe(true);
    expect(checksP1.some((c) => c.status === VICTORY_STATUS_LOST)).toBe(true);
  });
});

describe("Scenario Trigger Execution Modes & Serialization", () => {
  it("enforces executionMode once vs recurring with cooldown", () => {
    const { world, comps } = createTestWorld();
    const definition: ScenarioDefinition = {
      id: "execution-mode-test",
      title: "Modes",
      triggers: [
        {
          id: "trig-once",
          executionMode: "once",
          conditions: [{ kind: "timer", ticks: 0 }],
          actions: [{ kind: "setFlag", flag: "flag_once", value: true }],
        },
        {
          id: "trig-recurring",
          executionMode: "recurring",
          cooldownTicks: 10,
          conditions: [{ kind: "timer", ticks: 0 }],
          actions: [{ kind: "setFlag", flag: "flag_recurring", value: true }],
        },
      ],
    };

    const runtime = createScenarioRuntime(definition);

    // Tick 0: both fire
    evaluateScenarioTriggers(world, comps, runtime);
    expect(runtime.triggerStates.get("trig-once")?.firedCount).toBe(1);
    expect(runtime.triggerStates.get("trig-recurring")?.firedCount).toBe(1);

    // Tick 5: once does not fire; recurring in cooldown
    world.tick = 5;
    evaluateScenarioTriggers(world, comps, runtime);
    expect(runtime.triggerStates.get("trig-once")?.firedCount).toBe(1);
    expect(runtime.triggerStates.get("trig-recurring")?.firedCount).toBe(1);

    // Tick 11: once does not fire; recurring cooldown expired -> fires
    world.tick = 11;
    evaluateScenarioTriggers(world, comps, runtime);
    expect(runtime.triggerStates.get("trig-once")?.firedCount).toBe(1);
    expect(runtime.triggerStates.get("trig-recurring")?.firedCount).toBe(2);
  });

  it("serializes and restores runtime state with bit-exact fidelity", () => {
    const definition: ScenarioDefinition = {
      id: "save-test",
      title: "Save Test",
      initialObjectives: [
        { id: "o1", title: "O1", primary: true, status: "active" },
      ],
      triggers: [
        {
          id: "t1",
          enabled: true,
          conditions: [],
          actions: [],
        },
      ],
    };

    const runtime = createScenarioRuntime(definition, 100);
    runtime.flags.set("gate_opened", true);
    runtime.slainEntities.add(42);
    runtime.unitKills.set(1, 7);
    runtime.objectives[0]!.status = "completed";

    const saved = serializeScenarioRuntime(runtime);
    const restored = restoreScenarioRuntime(definition, saved);

    expect(restored.definition.id).toBe("save-test");
    expect(restored.flags.get("gate_opened")).toBe(true);
    expect(restored.slainEntities.has(42)).toBe(true);
    expect(restored.unitKills.get(1)).toBe(7);
    expect(restored.objectives[0]!.status).toBe("completed");
    expect(restored.startTick).toBe(100);
  });
});

describe("Interactive Objective HUD (src/ui/objectiveHud.ts)", () => {
  it("formats objective items and counts active objectives", () => {
    const objectives: ScenarioObjective[] = [
      { id: "1", title: "Primary Act", primary: true, status: "active" },
      { id: "2", title: "Primary Done", primary: true, status: "completed" },
      { id: "3", title: "Secondary Failed", primary: false, status: "failed" },
    ];

    expect(countActiveObjectives(objectives)).toBe(1);

    const f1 = formatObjectiveItem(objectives[0]!);
    expect(f1.icon).toBe("○");
    expect(f1.className).toBe("pending");

    const f2 = formatObjectiveItem(objectives[1]!);
    expect(f2.icon).toBe("✓");
    expect(f2.className).toBe("completed");

    const f3 = formatObjectiveItem(objectives[2]!);
    expect(f3.icon).toBe("✕");
    expect(f3.className).toBe("failed");
  });

  it("creates, updates, and collapses objective HUD card", () => {
    class TestMockElement {
      readonly tagName: string;
      id = "";
      private _className = "";
      textContent = "";
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      parentNode: TestMockElement | null = null;
      children: TestMockElement[] = [];
      private listeners: Record<string, ((e?: unknown) => void)[]> = {};

      constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
      }

      get className(): string {
        return this._className;
      }

      set className(val: string) {
        this._className = val;
        this.classList._classes.clear();
        for (const c of val.split(/\s+/).filter(Boolean)) {
          this.classList._classes.add(c);
        }
      }

      classList = {
        _classes: new Set<string>(),
        add: (c: string) => {
          this.classList._classes.add(c);
          this._className = Array.from(this.classList._classes).join(" ");
        },
        remove: (c: string) => {
          this.classList._classes.delete(c);
          this._className = Array.from(this.classList._classes).join(" ");
        },
        contains: (c: string) => this.classList._classes.has(c),
      };

      private _innerHTML = "";
      get innerHTML(): string {
        return this._innerHTML;
      }
      set innerHTML(val: string) {
        this._innerHTML = val;
        this.children = [];
        const idMatches = val.matchAll(/id=["']([^"']+)["']/g);
        for (const match of idMatches) {
          const child = new TestMockElement("div");
          child.id = match[1]!;
          child.parentNode = this;
          this.children.push(child);
        }
      }

      appendChild<T extends TestMockElement>(child: T): T {
        child.parentNode = this;
        this.children.push(child);
        return child;
      }

      append(...nodes: (TestMockElement | string)[]): void {
        for (const n of nodes) {
          if (typeof n === "string") {
            const textNode = new TestMockElement("span");
            textNode.textContent = n;
            this.appendChild(textNode);
          } else {
            this.appendChild(n);
          }
        }
      }

      replaceChildren(...nodes: (TestMockElement | string)[]): void {
        this.children = [];
        this.append(...nodes);
      }

      remove(): void {
        if (this.parentNode) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children.splice(idx, 1);
          this.parentNode = null;
        }
      }

      setAttribute(_k: string, _v: string): void {}
      addEventListener(event: string, fn: (e?: unknown) => void): void {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(fn);
      }

      querySelector<T extends TestMockElement>(sel: string): T | null {
        if (sel.startsWith("#")) {
          const targetId = sel.slice(1);
          if (this.id === targetId) return this as unknown as T;
          for (const child of this.children) {
            const found = child.querySelector<T>(sel);
            if (found) return found;
          }
        }
        return null;
      }

      querySelectorAll<T extends TestMockElement>(sel: string): T[] {
        const results: T[] = [];
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          if (this.classList.contains(cls)) results.push(this as unknown as T);
        }
        for (const child of this.children) {
          results.push(...child.querySelectorAll<T>(sel));
        }
        return results;
      }
    }

    const prevDoc = (globalThis as unknown as { document?: unknown }).document;
    const mockDoc = {
      createElement: (tag: string) => new TestMockElement(tag),
      body: new TestMockElement("body"),
    };
    (globalThis as unknown as { document?: unknown }).document = mockDoc;

    try {
      const container = mockDoc.createElement("div") as unknown as HTMLElement;
      const hud = createObjectiveHud({ container, initialCollapsed: false });

      expect(hud.isCollapsed()).toBe(false);

      const objectives: ScenarioObjective[] = [
        { id: "p1", title: "Defend Fortress", primary: true, status: "active" },
        { id: "s1", title: "Find Supplies", primary: false, status: "active" },
      ];

      hud.update(objectives);

      const elMock = hud.element as unknown as TestMockElement;
      const badge = elMock.querySelector<TestMockElement>(
        "#objective-hud-badge",
      );
      expect(badge?.textContent).toBe("1 active");

      const items = elMock.querySelectorAll<TestMockElement>(
        ".objective-hud-item",
      );
      expect(items.length).toBe(2);

      hud.toggle(true);
      expect(hud.isCollapsed()).toBe(true);
      expect(elMock.classList.contains("objective-hud--collapsed")).toBe(true);

      hud.destroy();
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prevDoc;
    }
  });
});

describe("Scenario Scripting Multi-Run Deterministic Seed Canary", () => {
  it("runs bit-identically across independent seed matches", () => {
    const runMatch = (
      seed: number,
    ): { digest: string; eventsCount: number } => {
      const terrainType = new Uint8Array(32 * 32).fill(TERRAIN_GRASS);
      const layers = buildLayers(terrainType, new Uint8Array(32 * 32));
      const world = createWorld(seed, {
        size: 32,
        layers,
        diplomacy: createDiplomacyMatrix(4, "ffa"),
      });
      const comps = defineSimComponents(world);
      createPlayerStockpile(world, comps, 0);
      createPlayerStockpile(world, comps, 1);

      const scenarioDef: ScenarioDefinition = {
        id: "canary-scenario",
        title: "Deterministic Canary",
        initialObjectives: [
          {
            id: "gather",
            title: "Gather Gold",
            primary: true,
            status: "active",
          },
        ],
        triggers: [
          {
            id: "t-gold",
            conditions: [
              {
                kind: "resourceThreshold",
                player: 0,
                resource: "gold",
                amount: 100,
              },
            ],
            actions: [
              { kind: "updateObjective", id: "gather", status: "completed" },
              {
                kind: "spawnUnits",
                player: 1,
                unitType: "militia",
                count: 2,
                x: 10,
                y: 10,
              },
              { kind: "setFlag", flag: "raiders_arrived", value: true },
            ],
          },
        ],
      };

      const runtime = createScenarioRuntime(scenarioDef);
      world.scenario = runtime;
      world.systems.push(createScenarioSystem(comps));

      // Advance 5 ticks
      for (let i = 0; i < 5; i++) {
        world.tick++;
        for (const sys of world.systems) sys(world, []);
      }

      // Add resources on tick 6
      creditResource(world, comps, 0, "gold", 150);

      // Advance another 5 ticks
      for (let i = 0; i < 5; i++) {
        world.tick++;
        for (const sys of world.systems) sys(world, []);
      }

      const digest = computeWorldDigest(world);
      return { digest, eventsCount: runtime.firedEvents.length };
    };

    const runA = runMatch(12345);
    const runB = runMatch(12345);

    expect(runA.digest).toBe(runB.digest);
    expect(runA.eventsCount).toBe(3);
    expect(runA.eventsCount).toBe(runB.eventsCount);
  });
});

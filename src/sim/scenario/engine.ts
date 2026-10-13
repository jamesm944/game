/**
 * Deterministic Scenario Scripting & Trigger Engine — Milestone S5 / Issue #134.
 *
 * Implements:
 * 1. Deterministic trigger condition evaluation inside the simulation tick loop.
 * 2. Action dispatch: objective tracking, unit/building spawning, diplomacy shifts,
 *    audio cues, victory/defeat triggers, flags, and cross-trigger enabling.
 * 3. Combat casualty tracking from CombatEvents ledger rows.
 * 4. Zero-desync save/restore serialization.
 */

import { buildingIdOfCode, unitCodeOf } from "../../data/definitions";
import { RESOURCE_SLUGS } from "../../data/schema";
import type { SimComponents } from "../components";
import { getBuildingRow } from "../components/buildings";
import {
  COMBAT_EVENT_DEATH,
  COMBAT_EVENT_UNIT_DEATH,
  readCombatEvents,
  spawnCombatUnit,
} from "../components/combat";
import { spawnUnit } from "../components";
import { stockpileAmountsOf } from "../core/stockpile";
import {
  appendVictoryCheck,
  VICTORY_PATH_CONQUEST,
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_WON,
} from "../components/victory";
import {
  DIPLOMACY_STANCE_ALLY,
  DIPLOMACY_STANCE_ENEMY,
  DIPLOMACY_STANCE_NEUTRAL,
  type DiplomacyStance,
} from "../core/diplomacy";
import { ownerOfUnit } from "../components/owner";
import { stampFinishedBuilding } from "../systems/placement";
import { TICK_HZ, type World } from "../core/world";
import type {
  AreaEnterCondition,
  BuildingsConstructedCondition,
  ObjectiveFlagCondition,
  ObjectiveStatusCondition,
  ResourceThresholdCondition,
  ScenarioDefinition,
  ScenarioObjective,
  ScenarioRuntime,
  ScenarioSaveState,
  TimerCondition,
  TriggerAction,
  TriggerCondition,
  TriggerRuntimeState,
  UnitsSlainCondition,
} from "./types";

export interface ScenarioCallbacks {
  readonly onObjectiveUpdate?: (objective: ScenarioObjective) => void;
  readonly onAudioCue?: (sound: string) => void;
  readonly onNarrativeMessage?: (message: string, sender?: string) => void;
}

// ---------------------------------------------------------------------------
// Runtime Factory
// ---------------------------------------------------------------------------

export function createScenarioRuntime(
  definition: ScenarioDefinition,
  startTick = 0,
): ScenarioRuntime {
  const triggerStates = new Map<string, TriggerRuntimeState>();
  for (const trigger of definition.triggers) {
    triggerStates.set(trigger.id, {
      enabled: trigger.enabled ?? true,
      firedCount: 0,
      lastFireTick: undefined,
    });
  }

  const objectives: ScenarioObjective[] = (
    definition.initialObjectives ?? []
  ).map((o) => ({
    id: o.id,
    title: o.title,
    description: o.description,
    primary: o.primary,
    status: o.status,
  }));

  return {
    definition,
    objectives,
    triggerStates,
    firedEvents: [],
    flags: new Map<string, boolean>(),
    audioCues: [],
    slainEntities: new Set<number>(),
    unitKills: new Map<number, number>(),
    buildingDestructions: new Map<number, number>(),
    startTick,
    lastEvaluatedCombatTick: startTick,
  };
}

// ---------------------------------------------------------------------------
// Combat Casualty Tracking
// ---------------------------------------------------------------------------

export function updateScenarioCasualties(
  world: World,
  comps: Pick<SimComponents, "combatEventsId" | "stockpileId">,
  runtime: ScenarioRuntime,
): void {
  const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
  if (!stockpileRows) return;

  const currentTick = world.tick;
  if (currentTick <= runtime.lastEvaluatedCombatTick) return;

  for (const [, row] of stockpileRows) {
    const playerId = row[0];
    if (playerId === undefined) continue;

    const events = readCombatEvents(world, comps, playerId);
    for (const event of events) {
      if (
        event.tick > runtime.lastEvaluatedCombatTick &&
        event.tick <= currentTick
      ) {
        if (event.kind === COMBAT_EVENT_UNIT_DEATH) {
          runtime.slainEntities.add(event.victimEid);
          const count = runtime.unitKills.get(playerId) ?? 0;
          runtime.unitKills.set(playerId, count + 1);
        } else if (event.kind === COMBAT_EVENT_DEATH) {
          runtime.slainEntities.add(event.victimEid);
          const count = runtime.buildingDestructions.get(playerId) ?? 0;
          runtime.buildingDestructions.set(playerId, count + 1);
        }
      }
    }
  }

  runtime.lastEvaluatedCombatTick = currentTick;
}

// ---------------------------------------------------------------------------
// Condition Evaluators
// ---------------------------------------------------------------------------

export function evaluateTimerCondition(
  condition: TimerCondition,
  currentTick: number,
  startTick: number,
): boolean {
  if (condition.seconds !== undefined) {
    const targetTicks = Math.round(condition.seconds * TICK_HZ);
    if (currentTick < targetTicks) return false;
  }
  const tickTarget = condition.tick ?? condition.ticks;
  if (tickTarget !== undefined && currentTick < tickTarget) {
    return false;
  }
  if (
    condition.delayTicks !== undefined &&
    currentTick < startTick + condition.delayTicks
  ) {
    return false;
  }
  return true;
}

export function evaluateAreaEnterCondition(
  world: World,
  comps: Pick<
    SimComponents,
    "positionId" | "unitTagId" | "combatId" | "ownerId"
  >,
  condition: AreaEnterCondition,
): boolean {
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!posRows) return false;

  let count = 0;
  const requiredCount = condition.unitCount ?? 1;
  const targetPlayer = condition.player ?? 0;
  const expectedDef = condition.unitType ?? condition.defId;
  const expectedCode =
    expectedDef !== undefined ? unitCodeOf(expectedDef) : undefined;

  for (const [eid, pos] of posRows) {
    const px = pos[0];
    const py = pos[1];
    if (px === undefined || py === undefined) {
      continue;
    }

    if (
      condition.minX !== undefined &&
      condition.maxX !== undefined &&
      condition.minY !== undefined &&
      condition.maxY !== undefined
    ) {
      if (
        px < condition.minX ||
        px > condition.maxX ||
        py < condition.minY ||
        py > condition.maxY
      ) {
        continue;
      }
    } else if (
      condition.x !== undefined &&
      condition.y !== undefined &&
      condition.radius !== undefined
    ) {
      const dx = px - condition.x;
      const dy = py - condition.y;
      if (dx * dx + dy * dy > condition.radius * condition.radius) {
        continue;
      }
    }

    const owner = ownerOfUnit(world, comps, eid);
    if (owner !== targetPlayer) {
      continue;
    }

    if (expectedCode !== undefined) {
      const combatRow = world.rowsByComponentId.get(comps.combatId)?.get(eid);
      if (!combatRow || combatRow[0] !== expectedCode) {
        continue;
      }
    }

    count++;
    if (count >= requiredCount) {
      return true;
    }
  }

  return false;
}

export function evaluateUnitsSlainCondition(
  condition: UnitsSlainCondition,
  runtime: ScenarioRuntime,
): boolean {
  if (condition.targetEid !== undefined) {
    return runtime.slainEntities.has(condition.targetEid);
  }
  const requiredCount = condition.count ?? 1;
  if (condition.victimPlayer !== undefined) {
    const casualties = runtime.unitKills.get(condition.victimPlayer) ?? 0;
    return casualties >= requiredCount;
  }
  // Total casualties across all players
  let total = 0;
  for (const val of runtime.unitKills.values()) {
    total += val;
  }
  return total >= requiredCount;
}

export function evaluateResourceThresholdCondition(
  world: World,
  comps: Pick<SimComponents, "stockpileId">,
  condition: ResourceThresholdCondition,
): boolean {
  try {
    const resCode = RESOURCE_SLUGS.indexOf(condition.resource);
    if (resCode < 0) return false;
    const amounts = stockpileAmountsOf(world, comps, condition.player ?? 0);
    return (amounts[resCode] ?? 0) >= condition.amount;
  } catch {
    return false;
  }
}

export function evaluateBuildingsConstructedCondition(
  world: World,
  comps: Pick<SimComponents, "buildingId">,
  condition: BuildingsConstructedCondition,
): boolean {
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  if (!buildingRows) return false;

  let count = 0;
  const requiredCount = condition.count ?? 1;

  for (const [eid] of buildingRows) {
    const row = getBuildingRow(world, comps, eid);
    if (!row) continue;
    const owner = row[0];
    const defCode = row[1];
    if (owner !== condition.player || defCode === undefined) continue;

    const id = buildingIdOfCode(defCode);
    if (id === condition.buildingType) {
      count++;
      if (count >= requiredCount) {
        return true;
      }
    }
  }

  return false;
}

export function evaluateObjectiveStatusCondition(
  condition: ObjectiveStatusCondition,
  runtime: ScenarioRuntime,
): boolean {
  const objective = runtime.objectives.find(
    (o) => o.id === condition.objectiveId,
  );
  return objective?.status === condition.status;
}

export function evaluateObjectiveFlagCondition(
  condition: ObjectiveFlagCondition,
  runtime: ScenarioRuntime,
): boolean {
  const expected = condition.expectedValue ?? true;
  return (runtime.flags.get(condition.flag) ?? false) === expected;
}

export function evaluateCondition(
  world: World,
  comps: SimComponents,
  condition: TriggerCondition,
  runtime: ScenarioRuntime,
): boolean {
  switch (condition.kind) {
    case "timer":
      return evaluateTimerCondition(condition, world.tick, runtime.startTick);
    case "areaEnter":
      return evaluateAreaEnterCondition(world, comps, condition);
    case "unitsSlain":
      return evaluateUnitsSlainCondition(condition, runtime);
    case "resourceThreshold":
      return evaluateResourceThresholdCondition(world, comps, condition);
    case "buildingsConstructed":
      return evaluateBuildingsConstructedCondition(world, comps, condition);
    case "objectiveStatus":
      return evaluateObjectiveStatusCondition(condition, runtime);
    case "objectiveFlag":
      return evaluateObjectiveFlagCondition(condition, runtime);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Action Executors
// ---------------------------------------------------------------------------

function mapStanceToCode(
  stance: "ally" | "neutral" | "enemy" | DiplomacyStance,
): DiplomacyStance {
  if (typeof stance === "number") return stance;
  switch (stance) {
    case "ally":
      return DIPLOMACY_STANCE_ALLY;
    case "neutral":
      return DIPLOMACY_STANCE_NEUTRAL;
    case "enemy":
      return DIPLOMACY_STANCE_ENEMY;
  }
}

export function executeAction(
  world: World,
  comps: SimComponents,
  action: TriggerAction,
  runtime: ScenarioRuntime,
  triggerId: string,
  callbacks?: ScenarioCallbacks,
): void {
  runtime.firedEvents.push({
    tick: world.tick,
    triggerId,
    action,
  });

  switch (action.kind) {
    case "displayObjective": {
      const objId = action.objectiveId ?? action.id ?? "";
      const existing = runtime.objectives.find((o) => o.id === objId);
      const isPrimary = action.primary ?? action.type !== "secondary";
      if (existing) {
        if (action.status !== undefined) existing.status = action.status;
        callbacks?.onObjectiveUpdate?.(existing);
      } else {
        const newObj: ScenarioObjective = {
          id: objId,
          title: action.title,
          description: action.description,
          primary: isPrimary,
          status: action.status ?? "active",
        };
        runtime.objectives.push(newObj);
        callbacks?.onObjectiveUpdate?.(newObj);
      }
      break;
    }

    case "updateObjective": {
      const objId = action.objectiveId ?? action.id;
      const existing = runtime.objectives.find((o) => o.id === objId);
      if (existing) {
        existing.status = action.status;
        callbacks?.onObjectiveUpdate?.(existing);
      }
      break;
    }

    case "spawnUnits": {
      const defId = action.unitType ?? action.defId ?? "militia";
      const count = action.count ?? 1;
      for (let i = 0; i < count; i++) {
        const ox = (i % 3) * 0.6;
        const oy = Math.floor(i / 3) * 0.6;
        const x = action.x + ox;
        const y = action.y + oy;
        if (defId === "villager" || defId === "trade-cart") {
          spawnUnit(world, comps, x, y, { ownerId: action.player });
        } else {
          spawnCombatUnit(world, comps, defId, x, y, action.player);
        }
      }
      break;
    }

    case "spawnEnemyArmy": {
      const player = action.player ?? action.playerId ?? 1;
      const baseX = action.x ?? 0;
      const baseY = action.y ?? 0;
      let idx = 0;
      for (const u of action.units) {
        const defId = u.defId ?? u.unitType ?? "militia";
        const count = u.count ?? 1;
        const ux = u.x ?? baseX;
        const uy = u.y ?? baseY;
        for (let i = 0; i < count; i++) {
          const ox = (idx % 4) * 0.6;
          const oy = Math.floor(idx / 4) * 0.6;
          idx++;
          if (defId === "villager" || defId === "trade-cart") {
            spawnUnit(world, comps, ux + ox, uy + oy, { ownerId: player });
          } else {
            spawnCombatUnit(world, comps, defId, ux + ox, uy + oy, player);
          }
        }
      }
      break;
    }

    case "spawnBuilding": {
      try {
        stampFinishedBuilding(
          world,
          comps,
          action.buildingType,
          Math.floor(action.x),
          Math.floor(action.y),
          { playerId: action.player },
        );
      } catch {
        // Position may be blocked or out of bounds; safe no-op in simulation
      }
      break;
    }

    case "diplomacyShift": {
      if (world.diplomacy) {
        const code = mapStanceToCode(action.stance);
        world.diplomacy.setStance(action.playerA, action.playerB, code);
        world.diplomacy.setStance(action.playerB, action.playerA, code);
      }
      break;
    }

    case "audioCue": {
      const sound = action.sound ?? action.cue ?? "horn";
      runtime.audioCues.push(sound);
      callbacks?.onAudioCue?.(sound);
      break;
    }

    case "broadcastMessage": {
      callbacks?.onNarrativeMessage?.(action.message, action.sender);
      break;
    }

    case "triggerVictory": {
      appendVictoryCheck(world, comps, action.player, {
        tick: world.tick,
        pathCode: VICTORY_PATH_CONQUEST,
        status: VICTORY_STATUS_WON,
        metric: 0,
      });
      // Mark other players as lost
      const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
      if (stockpileRows) {
        for (const [, row] of stockpileRows) {
          const other = row[0];
          if (other !== undefined && other !== action.player) {
            appendVictoryCheck(world, comps, other, {
              tick: world.tick,
              pathCode: VICTORY_PATH_CONQUEST,
              status: VICTORY_STATUS_LOST,
              metric: 0,
            });
          }
        }
      }
      break;
    }

    case "triggerDefeat": {
      appendVictoryCheck(world, comps, action.player, {
        tick: world.tick,
        pathCode: VICTORY_PATH_CONQUEST,
        status: VICTORY_STATUS_LOST,
        metric: 0,
      });
      break;
    }

    case "victoryDefeat": {
      const player = action.player ?? action.playerId ?? 0;
      if (action.outcome === "victory") {
        appendVictoryCheck(world, comps, player, {
          tick: world.tick,
          pathCode: VICTORY_PATH_CONQUEST,
          status: VICTORY_STATUS_WON,
          metric: 0,
        });
        const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
        if (stockpileRows) {
          for (const [, row] of stockpileRows) {
            const other = row[0];
            if (other !== undefined && other !== player) {
              appendVictoryCheck(world, comps, other, {
                tick: world.tick,
                pathCode: VICTORY_PATH_CONQUEST,
                status: VICTORY_STATUS_LOST,
                metric: 0,
              });
            }
          }
        }
      } else {
        appendVictoryCheck(world, comps, player, {
          tick: world.tick,
          pathCode: VICTORY_PATH_CONQUEST,
          status: VICTORY_STATUS_LOST,
          metric: 0,
        });
      }
      break;
    }

    case "setFlag": {
      runtime.flags.set(action.flag, action.value);
      break;
    }

    case "setTriggerEnabled": {
      const state = runtime.triggerStates.get(action.triggerId);
      if (state) {
        state.enabled = action.enabled;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Tick Evaluation Loop
// ---------------------------------------------------------------------------

export function evaluateScenarioTriggers(
  world: World,
  comps: SimComponents,
  runtime: ScenarioRuntime,
  callbacks?: ScenarioCallbacks,
): void {
  // Update casualty counts from combat events
  updateScenarioCasualties(world, comps, runtime);

  for (const trigger of runtime.definition.triggers) {
    const state = runtime.triggerStates.get(trigger.id);
    if (!state || !state.enabled) {
      continue;
    }

    // Check execution mode (once vs recurring / looping)
    const isRecurring =
      trigger.executionMode === "recurring" || trigger.looping === true;
    if (!isRecurring && state.firedCount > 0) {
      continue;
    }
    if (
      trigger.cooldownTicks !== undefined &&
      state.lastFireTick !== undefined &&
      world.tick < state.lastFireTick + trigger.cooldownTicks
    ) {
      continue;
    }

    // Evaluate all conditions (logical AND)
    let allMet = true;
    for (const cond of trigger.conditions) {
      if (!evaluateCondition(world, comps, cond, runtime)) {
        allMet = false;
        break;
      }
    }

    if (allMet) {
      state.firedCount++;
      state.lastFireTick = world.tick;

      for (const action of trigger.actions) {
        executeAction(world, comps, action, runtime, trigger.id, callbacks);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Save & Restore Serialization
// ---------------------------------------------------------------------------

export function serializeScenarioRuntime(
  runtime: ScenarioRuntime,
): ScenarioSaveState {
  const triggerStatesEntries: [string, TriggerRuntimeState][] = [];
  for (const [id, state] of runtime.triggerStates.entries()) {
    triggerStatesEntries.push([
      id,
      {
        enabled: state.enabled,
        firedCount: state.firedCount,
        lastFireTick: state.lastFireTick,
      },
    ]);
  }

  return {
    definitionId: runtime.definition.id,
    objectives: runtime.objectives.map((o) => ({ ...o })),
    triggerStates: triggerStatesEntries,
    flags: [...runtime.flags.entries()],
    slainEntities: [...runtime.slainEntities],
    unitKills: [...runtime.unitKills.entries()],
    buildingDestructions: [...runtime.buildingDestructions.entries()],
    startTick: runtime.startTick,
    lastEvaluatedCombatTick: runtime.lastEvaluatedCombatTick,
  };
}

export function restoreScenarioRuntime(
  definition: ScenarioDefinition,
  saved: ScenarioSaveState,
): ScenarioRuntime {
  const triggerStates = new Map<string, TriggerRuntimeState>();
  for (const [id, state] of saved.triggerStates) {
    triggerStates.set(id, { ...state });
  }

  const objectives: ScenarioObjective[] = saved.objectives.map((o) => ({
    ...o,
  }));

  return {
    definition,
    objectives,
    triggerStates,
    firedEvents: [],
    flags: new Map(saved.flags ?? []),
    audioCues: [],
    slainEntities: new Set(saved.slainEntities ?? []),
    unitKills: new Map(saved.unitKills),
    buildingDestructions: new Map(saved.buildingDestructions),
    startTick: saved.startTick,
    lastEvaluatedCombatTick: saved.lastEvaluatedCombatTick,
  };
}

/**
 * Scenario Scripting & Trigger Engine Types — Milestone S5 / Issue #133 (Part of Epic #131).
 *
 * Defines the schema for:
 * 1. Conditions: timer, area entry, units slain, resource thresholds,
 *    buildings constructed, and prerequisite objective status.
 * 2. Actions: display/update objectives, spawn units/buildings, diplomacy shifts,
 *    audio cues, victory/defeat triggers, and trigger state management.
 * 3. Scenarios: definitions, objectives, trigger rules, and runtime state.
 *
 * Determinism: Pure functional types, reproducible integer/small-float math,
 * serializable to JSON for save/load and replay verification.
 */

import { RESOURCE_SLUGS } from "../../data/schema";
import type { DiplomacyStance } from "../core/diplomacy";

export type ResourceKind = (typeof RESOURCE_SLUGS)[number];

// ---------------------------------------------------------------------------
// 1. Trigger Conditions
// ---------------------------------------------------------------------------

export interface TimerCondition {
  readonly kind: "timer";
  /** Absolute sim tick (fires when currentTick >= tick). */
  readonly tick?: number | undefined;
  /** Alias for tick */
  readonly ticks?: number | undefined;
  /** Elapsed simulation time in seconds (fires when currentTick >= seconds * 30). */
  readonly seconds?: number | undefined;
  /** Relative delay in ticks from scenario start or trigger enable. */
  readonly delayTicks?: number | undefined;
}

export interface AreaEnterCondition {
  readonly kind: "areaEnter";
  /** Player whose units must enter the zone (defaults to 0). */
  readonly player?: number | undefined;
  /** Bounding box in tile coordinates. */
  readonly minX?: number | undefined;
  readonly minY?: number | undefined;
  readonly maxX?: number | undefined;
  readonly maxY?: number | undefined;
  /** Radial area center and radius in tile coordinates. */
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly radius?: number | undefined;
  /** Minimum unit count required in zone (defaults to 1). */
  readonly unitCount?: number | undefined;
  /** Optional unit definition filter (e.g. "scout-cavalry"). */
  readonly unitType?: string | undefined;
  readonly defId?: string | undefined;
}

export interface UnitsSlainCondition {
  readonly kind: "unitsSlain";
  /** Specific entity ID whose destruction satisfies this condition. */
  readonly targetEid?: number | undefined;
  /** Player that suffered the unit casualties. */
  readonly victimPlayer?: number | undefined;
  /** Player that dealt the kills (if specified). */
  readonly attackerPlayer?: number | undefined;
  /** Minimum casualty count required (defaults to 1). */
  readonly count?: number | undefined;
  /** Optional unit type filter. */
  readonly unitType?: string | undefined;
  readonly defId?: string | undefined;
}

export interface ResourceThresholdCondition {
  readonly kind: "resourceThreshold";
  readonly player?: number | undefined;
  readonly resource: ResourceKind;
  readonly amount: number;
}

export interface BuildingsConstructedCondition {
  readonly kind: "buildingsConstructed";
  readonly player: number;
  readonly buildingType: string;
  /** Minimum count of finished buildings (defaults to 1). */
  readonly count?: number | undefined;
}

export interface ObjectiveStatusCondition {
  readonly kind: "objectiveStatus";
  readonly objectiveId: string;
  readonly status: "active" | "completed" | "failed";
}

export interface ObjectiveFlagCondition {
  readonly kind: "objectiveFlag";
  readonly flag: string;
  readonly expectedValue?: boolean | undefined;
}

export type TriggerCondition =
  | TimerCondition
  | AreaEnterCondition
  | UnitsSlainCondition
  | ResourceThresholdCondition
  | BuildingsConstructedCondition
  | ObjectiveStatusCondition
  | ObjectiveFlagCondition;

// ---------------------------------------------------------------------------
// 2. Trigger Actions
// ---------------------------------------------------------------------------

export interface DisplayObjectiveAction {
  readonly kind: "displayObjective";
  readonly objectiveId?: string | undefined;
  readonly id?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly primary?: boolean | undefined;
  readonly type?: "primary" | "secondary" | undefined;
  readonly status?: "active" | "completed" | "failed" | undefined;
}

export interface UpdateObjectiveAction {
  readonly kind: "updateObjective";
  readonly objectiveId?: string | undefined;
  readonly id?: string | undefined;
  readonly status: "active" | "completed" | "failed";
}

export interface SpawnUnitsAction {
  readonly kind: "spawnUnits";
  readonly player: number;
  readonly unitType?: string | undefined;
  readonly defId?: string | undefined;
  readonly count?: number | undefined;
  readonly x: number;
  readonly y: number;
}

export interface ArmyUnitSpec {
  readonly defId?: string | undefined;
  readonly unitType?: string | undefined;
  readonly count?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export interface SpawnEnemyArmyAction {
  readonly kind: "spawnEnemyArmy";
  readonly player?: number | undefined;
  readonly playerId?: number | undefined;
  readonly units: readonly ArmyUnitSpec[];
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export interface SpawnBuildingAction {
  readonly kind: "spawnBuilding";
  readonly player: number;
  readonly buildingType: string;
  readonly x: number;
  readonly y: number;
}

export interface DiplomacyShiftAction {
  readonly kind: "diplomacyShift";
  readonly playerA: number;
  readonly playerB: number;
  readonly stance: "ally" | "neutral" | "enemy" | DiplomacyStance;
}

export interface AudioCueAction {
  readonly kind: "audioCue";
  readonly sound?: string | undefined;
  readonly cue?: string | undefined;
  readonly volume?: number | undefined;
}

export interface TriggerVictoryAction {
  readonly kind: "triggerVictory";
  readonly player: number;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
}

export interface TriggerDefeatAction {
  readonly kind: "triggerDefeat";
  readonly player: number;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
}

export interface VictoryDefeatAction {
  readonly kind: "victoryDefeat";
  readonly player?: number | undefined;
  readonly playerId?: number | undefined;
  readonly outcome: "victory" | "defeat";
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
}

export interface SetFlagAction {
  readonly kind: "setFlag";
  readonly flag: string;
  readonly value: boolean;
}

export interface SetTriggerEnabledAction {
  readonly kind: "setTriggerEnabled";
  readonly triggerId: string;
  readonly enabled: boolean;
}

export interface BroadcastMessageAction {
  readonly kind: "broadcastMessage";
  readonly message: string;
  readonly sender?: string | undefined;
}

export type TriggerAction =
  | DisplayObjectiveAction
  | UpdateObjectiveAction
  | SpawnUnitsAction
  | SpawnEnemyArmyAction
  | SpawnBuildingAction
  | DiplomacyShiftAction
  | AudioCueAction
  | TriggerVictoryAction
  | TriggerDefeatAction
  | VictoryDefeatAction
  | SetFlagAction
  | SetTriggerEnabledAction
  | BroadcastMessageAction;

// ---------------------------------------------------------------------------
// 3. Objectives & Trigger Definitions
// ---------------------------------------------------------------------------

export interface ScenarioObjective {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly primary: boolean;
  status: "active" | "completed" | "failed";
}

export interface ScenarioTrigger {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled?: boolean | undefined;
  /** Execution mode: "once" (disabled after firing) or "recurring" / "looping". */
  readonly executionMode?: "once" | "recurring" | undefined;
  /** If true, trigger can fire repeatedly once condition re-matches. */
  readonly looping?: boolean | undefined;
  /** Cooldown ticks before a looping trigger can fire again. */
  readonly cooldownTicks?: number | undefined;
  /** All conditions must match (logical AND). */
  readonly conditions: readonly TriggerCondition[];
  /** Actions executed sequentially when trigger fires. */
  readonly actions: readonly TriggerAction[];
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly initialObjectives?: readonly ScenarioObjective[] | undefined;
  readonly triggers: readonly ScenarioTrigger[];
}

// ---------------------------------------------------------------------------
// 4. Runtime & Save States
// ---------------------------------------------------------------------------

export interface TriggerRuntimeState {
  enabled: boolean;
  firedCount: number;
  lastFireTick?: number | undefined;
}

export interface ScenarioNarrativeEvent {
  readonly tick: number;
  readonly triggerId: string;
  readonly action: TriggerAction;
}

export interface ScenarioRuntime {
  readonly definition: ScenarioDefinition;
  readonly objectives: ScenarioObjective[];
  readonly triggerStates: Map<string, TriggerRuntimeState>;
  readonly firedEvents: ScenarioNarrativeEvent[];
  readonly flags: Map<string, boolean>;
  readonly audioCues: string[];
  readonly slainEntities: Set<number>;
  readonly unitKills: Map<number, number>; // victimPlayer -> count
  readonly buildingDestructions: Map<number, number>; // victimPlayer -> count
  readonly startTick: number;
  lastEvaluatedCombatTick: number;
}

export interface ScenarioSaveState {
  readonly definitionId: string;
  readonly objectives: readonly ScenarioObjective[];
  readonly triggerStates: readonly (readonly [string, TriggerRuntimeState])[];
  readonly flags: readonly (readonly [string, boolean])[];
  readonly slainEntities: readonly number[];
  readonly unitKills: readonly (readonly [number, number])[];
  readonly buildingDestructions: readonly (readonly [number, number])[];
  readonly startTick: number;
  readonly lastEvaluatedCombatTick: number;
}

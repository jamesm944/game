/**
 * AI orchestrator — SPEC §2.8 layers 1+2+3 / M2-T9 + M4-T6 (issues #43, #61).
 *
 * Registers as an ordinary SimSystem (LAST, after every gameplay
 * system) and thinks on the §2.8 cadence:
 *
 *   - FULL PASS every `decisionIntervalTicks` (30 × reactionLatency —
 *     the §2.8 difficulty knob; presets in ai/difficulty.ts): economy
 *     manager + build-order layer + military COUNTER-PICK training,
 *     in that fixed order, sharing one planning-time resource budget
 *     and one spot reservation so a single pass can never overdraw or
 *     double-place.
 *   - INCREMENTAL CHECK every other tick: the military manager's cheap
 *     probes — DEFENSE RALLY detection (own building damaged + hostile
 *     unit nearby, gated by the difficulty's reactionDelayTicks) and
 *     the one-shot OFFENSIVE trigger (utility-scored strike/raid target
 *     via militaryManager.ts). Both stay off the full-pass cadence so
 *     reaction latency does not wait for strategy replanning.
 *
 * Emissions enter the SHARED command inbox exactly like player orders:
 * `{kind, targetTick: now+1, data}` carrying `playerId`. The planner
 * never mutates component rows — its only world interaction is inbox
 * submission plus the read-only {@link AiKnowledge} seam, which is the
 * type-level fog-honesty guarantee the issue asks for.
 *
 * Budget instrumentation (§2.8 "<1 ms amortized"): think time is
 * measured ONLY through the injected `now` clock (tests pass
 * performance.now; production omits it, keeping the sim pure). The
 * golden fixture asserts amortized think < 1 ms.
 */

import {
  createResourceBudget,
  createSpotReservation,
  type AiKnowledge,
} from "./knowledge";
import {
  planBuildOrder,
  STRATEGIES,
  type BuildOrderMemory,
  type CommandDraft,
  type Strategy,
  type StrategyId,
} from "./buildOrder";
import { planEconomyCommands } from "./economyManager";
import {
  createMilitaryMemory,
  planCounterTraining,
  planDefenseRally,
  planMilitaryTechResearch,
  planMonkConversionSingle,
  planMonkConversions,
  planOffensive,
  planRelicCollection,
  planRelicCollectionSingle,
  planRelicDeposit,
  planRelicDepositSingle,
  planTributeTransfer,
  type MilitaryMemory,
} from "./militaryManager";
import { planTradeRoutes } from "./tradeManager";
import { planNavalFleet } from "./navalManager";
import { aiDifficultyOf, type AiDifficultyId } from "./difficulty";
import type { SimSystem, World } from "../core/world";

/** §2.8 cadence: one full planning pass per simulated second. */
export const PLANNER_CADENCE_TICKS = 30;

export interface PlannerTelemetry {
  /** Full-pass invocations. */
  thinkCalls: number;
  /** Incremental (defense/offense) check invocations. */
  incrementalCalls: number;
  /** Sum of measured think milliseconds (requires `now`). */
  totalThinkMs: number;
  /** Commands submitted, by kind. */
  issuedByKind: Record<string, number>;
  /** First tick each kind was submitted at. */
  firstTickByKind: Record<string, number>;
  /** Every attack draft with its fog-legality probe result. */
  attackDrafts: {
    tick: number;
    targetId: number;
    attackerCount: number;
    targetVisibleToAi: boolean;
    /** Manager classification: raid | strike | defense. */
    purpose: string;
  }[];
  /** Gather drafts whose node was inside AI knowledge at emission. */
  gatherDraftsKnown: number;
  /** Gather drafts total. */
  gatherDrafts: number;
  /** Counter-pick training drafts emitted (M4-T6). */
  counterTrains: number;
  /** Defense rally drafts emitted (M4-T6). */
  defenseRallies: number;
}

export function createPlannerTelemetry(): PlannerTelemetry {
  return {
    thinkCalls: 0,
    incrementalCalls: 0,
    totalThinkMs: 0,
    issuedByKind: {},
    firstTickByKind: {},
    attackDrafts: [],
    gatherDraftsKnown: 0,
    gatherDrafts: 0,
    counterTrains: 0,
    defenseRallies: 0,
  };
}

export interface AiPlannerOptions {
  readonly knowledge: AiKnowledge;
  /** Strategy id from the scripted set, or a fully custom strategy. */
  readonly strategy: StrategyId | Strategy;
  readonly telemetry?: PlannerTelemetry | undefined;
  /**
   * Difficulty preset id (§2.8 "disclosed knobs", M4-T6): sets the full
   * decision interval AND the defense reaction delay from
   * ai/difficulty.ts. Default "normal" — every pre-M4 fixture plays
   * byte-unaffected.
   */
  readonly difficulty?: AiDifficultyId | undefined;
  /**
   * Legacy low-level override (M2-T10 stub): multiplies the BASE 30-tick
   * cadence into the full-pass interval, beating any `difficulty`
   * preset for the interval knob. Must be a positive integer.
   */
  readonly reactionLatency?: number | undefined;
  /**
   * Optional wall-clock source for budget instrumentation ONLY — never
   * consulted for decisions, omitted in production to preserve sim
   * purity (tests inject performance.now).
   */
  readonly now?: (() => number) | undefined;
  /**
   * Phase offset in ticks for staggered full planning passes across multiple
   * AI players in 3+ player games (Issue #86 / #111). Defaults to 0.
   */
  readonly phaseOffset?: number | undefined;
  /**
   * Injectable cross-pass memories (SPEC §2.12 save/restore): the save
   * ticket serializes both so a restored session's planner keeps its
   * build-order and military state. Fresh memories when omitted.
   */
  readonly memory?: BuildOrderMemory | undefined;
  readonly militaryMemory?: MilitaryMemory | undefined;
}

/**
 * Build the AI SimSystem. Register AFTER all gameplay systems: drafts
 * target `tick + 1`, so they drain on the next boundary before any
 * system runs — identical to player commands queued mid-frame.
 */
export function createAiPlannerSystem(options: AiPlannerOptions): SimSystem {
  const strategy: Strategy =
    typeof options.strategy === "string"
      ? STRATEGIES[options.strategy]
      : options.strategy;
  const k = options.knowledge;
  const telemetry = options.telemetry ?? createPlannerTelemetry();
  const memory = options.memory ?? {};
  const militaryMemory = options.militaryMemory ?? createMilitaryMemory();
  const preset = aiDifficultyOf(options.difficulty);
  const latency = options.reactionLatency ?? 1;
  if (!Number.isInteger(latency) || latency < 1) {
    throw new Error(
      `reactionLatency must be a positive integer, got ${String(latency)}`,
    );
  }
  /**
   * Effective full-pass interval: the legacy latency multiplier when
   * given, else the difficulty preset's decision interval.
   */
  const fullPassIntervalTicks =
    options.reactionLatency === undefined
      ? preset.decisionIntervalTicks
      : PLANNER_CADENCE_TICKS * latency;
  const reactionDelayTicks = preset.reactionDelayTicks;

  const measure = <T>(think: () => T): T => {
    if (options.now === undefined) return think();
    const start = options.now();
    try {
      return think();
    } finally {
      telemetry.totalThinkMs += options.now() - start;
    }
  };

  const submit = (world: World, draft: CommandDraft): void => {
    world.inbox.submit({
      kind: draft.kind,
      targetTick: world.tick + 1,
      data: draft.data,
    });
    telemetry.issuedByKind[draft.kind] =
      (telemetry.issuedByKind[draft.kind] ?? 0) + 1;
    if (telemetry.firstTickByKind[draft.kind] === undefined) {
      telemetry.firstTickByKind[draft.kind] = world.tick;
    }
    if (draft.kind === "gather") {
      telemetry.gatherDrafts += 1;
      // Fog-legality probe recorded through the SAME view queries the
      // decision used — the honesty check rides the code path itself.
      const nodeId = draft.data.nodeId;
      if (
        typeof nodeId === "number" &&
        k.knownNodes().some((node) => node.eid === nodeId)
      ) {
        telemetry.gatherDraftsKnown += 1;
      }
    }
    if (draft.kind === "attack") {
      const targetId = draft.data.targetId;
      const attackerIds = draft.data.attackerIds;
      const purpose =
        typeof draft.data.purpose === "string" ? draft.data.purpose : "strike";
      telemetry.attackDrafts.push({
        tick: world.tick,
        targetId: typeof targetId === "number" ? targetId : -1,
        attackerCount: Array.isArray(attackerIds) ? attackerIds.length : 0,
        targetVisibleToAi:
          typeof targetId === "number" &&
          k.visibleEnemies().some((enemy) => enemy.eid === targetId),
        purpose,
      });
      if (purpose === "defense" || purpose === "defense-assist") {
        telemetry.defenseRallies += 1;
      }
    }
    if (draft.kind === "trainUnit" && draft.data.purpose === "counter") {
      telemetry.counterTrains += 1;
    }
  };

  const fullPass = (): CommandDraft[] => {
    const drafts: CommandDraft[] = [];
    const budget = createResourceBudget(k);
    const reserved = createSpotReservation();
    planEconomyCommands(
      k,
      {
        villagerTarget: strategy.villagerTarget,
        gatherWeights: strategy.gatherWeights,
      },
      budget,
      reserved,
      drafts,
    );
    const buildDraft = planBuildOrder(k, strategy, budget, reserved, memory);
    if (buildDraft !== undefined) drafts.push(buildDraft);
    planCounterTraining(k, budget, militaryMemory, drafts);
    planMilitaryTechResearch(k, budget, militaryMemory, drafts);
    planRelicDeposit(k, drafts);
    planRelicCollection(k, drafts);
    planMonkConversions(k, drafts);
    planTradeRoutes(k, drafts, budget);
    planNavalFleet(k, budget, drafts);
    const tributeDraft = planTributeTransfer(k, militaryMemory, k.tick());
    if (tributeDraft !== undefined) drafts.push(tributeDraft);
    return drafts;
  };

  /**
   * Incremental path between passes: cheap military probes — defense
   * rally first (protecting the economy beats everything), then relic
   * deposit/collection (§2.11 Relic path AI), then monk conversions of
   * high-value targets, then the one-shot scored offensive.
   */
  const incrementalCheck = (): CommandDraft | undefined => {
    const defense = planDefenseRally(k, militaryMemory, reactionDelayTicks);
    if (defense !== undefined) return defense;

    // Fast path: if the AI has no monks, skip relic and conversion probes entirely.
    const army = k.armyUnits();
    if (army.some((u) => u.defId === "monk")) {
      const deposit = planRelicDepositSingle(k);
      if (deposit !== undefined) return deposit;

      const collect = planRelicCollectionSingle(k);
      if (collect !== undefined) return collect;

      const conv = planMonkConversionSingle(k);
      if (conv !== undefined) return conv;
    }

    return planOffensive(k, strategy, memory);
  };

  return (world, _commands) => {
    void _commands;
    // Sync the fog dirty queue BEFORE deciding: units trained or sites
    // completed by THIS tick's systems are not stamped into the planes
    // until the post-step flush, and knownEntities() reads stamps —
    // without this, army counts lag same-tick spawns by one unit.
    // Deterministic and idempotent; the end-of-step flush stays a no-op.
    world.visibility.flushDirty();
    const tick = world.tick;
    const offset = options.phaseOffset ?? 0;
    const isFullPass =
      (((tick - offset) % fullPassIntervalTicks) + fullPassIntervalTicks) %
        fullPassIntervalTicks ===
      0;
    if (isFullPass) {
      telemetry.thinkCalls += 1;
      for (const draft of measure(fullPass)) submit(world, draft);
    } else {
      // Cheap incremental probes run EVERY non-full-pass tick — the
      // defense rally cannot wait a full decision interval to react.
      telemetry.incrementalCalls += 1;
      const draft = measure(incrementalCheck);
      if (draft !== undefined) submit(world, draft);
    }
  };
}

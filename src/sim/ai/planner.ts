/**
 * AI orchestrator — SPEC §2.8 layers 1+2 / M2-T9 (issue #43).
 *
 * Registers as an ordinary SimSystem (LAST, after every gameplay
 * system) and thinks on the §2.8 cadence:
 *
 *   - FULL PASS every 30 ticks: economy manager + build-order layer,
 *     in that fixed order, sharing one planning-time resource budget
 *     and one spot reservation so a single pass can never overdraw or
 *     double-place.
 *   - INCREMENTAL CHECK between passes: the minimal attack trigger
 *     only — cheap army-size/vision probes keep reaction latency off
 *     the 1 s cadence without re-running the whole plan.
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
import type { SimSystem, World } from "../core/world";

/** §2.8 cadence: one full planning pass per simulated second. */
export const PLANNER_CADENCE_TICKS = 30;

export interface PlannerTelemetry {
  /** Full-pass invocations. */
  thinkCalls: number;
  /** Incremental (attack-only) check invocations. */
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
  }[];
  /** Gather drafts whose node was inside AI knowledge at emission. */
  gatherDraftsKnown: number;
  /** Gather drafts total. */
  gatherDrafts: number;
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
  };
}

export interface AiPlannerOptions {
  readonly knowledge: AiKnowledge;
  /** Strategy id from the scripted set, or a fully custom strategy. */
  readonly strategy: StrategyId | Strategy;
  readonly telemetry?: PlannerTelemetry | undefined;
  /**
   * Optional wall-clock source for budget instrumentation ONLY — never
   * consulted for decisions, omitted in production to preserve sim
   * purity (tests inject performance.now).
   */
  readonly now?: (() => number) | undefined;
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
  const memory: BuildOrderMemory = {};

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
      telemetry.attackDrafts.push({
        tick: world.tick,
        targetId: typeof targetId === "number" ? targetId : -1,
        attackerCount: Array.isArray(attackerIds) ? attackerIds.length : 0,
        targetVisibleToAi:
          typeof targetId === "number" &&
          k.visibleEnemies().some((enemy) => enemy.eid === targetId),
      });
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
    return drafts;
  };

  /** Incremental path between passes: the minimal attack trigger. */
  const incrementalAttackCheck = (): CommandDraft | undefined => {
    if (memory.attackedTick !== undefined) return undefined;
    if (k.armyUnits().length < Math.max(strategy.attackArmyThreshold, 1)) {
      return undefined;
    }
    const buildDraft = planBuildOrder(
      k,
      strategy,
      createResourceBudget(k),
      createSpotReservation(),
      memory,
    );
    return buildDraft?.kind === "attack" ? buildDraft : undefined;
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
    if (tick % PLANNER_CADENCE_TICKS === 0) {
      telemetry.thinkCalls += 1;
      for (const draft of measure(fullPass)) submit(world, draft);
      return;
    }
    // Cheap incremental probe; v1 fires the attack trigger once per
    // match — re-arming is M4 military-manager territory.
    if (memory.attackedTick !== undefined) return;
    telemetry.incrementalCalls += 1;
    const draft = measure(incrementalAttackCheck);
    if (draft !== undefined) submit(world, draft);
  };
}

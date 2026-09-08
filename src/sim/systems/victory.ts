/**
 * Victory evaluators — SPEC §2.11 / M2-T10 (issue #44) + M4-T4 (#59) +
 * M4-T5 (#60).
 *
 * The §2.11 shared frame: every path = generator → accumulating metric →
 * completing act → victory timer (win on hold; Conquest timerless). The
 * {@link VictoryPathEvaluator} interface is that frame as data — one
 * evaluator per path, each carrying its stable row code, its hold-timer
 * length (undefined = timerless), an optional sustain threshold, a
 * per-player metric sampler for the digest rows and a per-player
 * completing-act probe.
 *
 * TIMED PATHS (M4-T4: Knowledge, Culture; M4-T5: Economic): the
 * recorded metric is the player's cumulative generator ledger (integer
 * milli-units), and each heartbeat stamps the extra SUSTAINING status
 * when the completing act stands AND the interval since the previous
 * check held the path's threshold rate. The win needs the act standing
 * while accumulated SUSTAINING spans cover timerTicks.
 *
 * HOLD-ONLY PATHS (M4-T5: Wonder, Relic) share the same timer with NO
 * threshold: every interval whose closing heartbeat finds the act
 * standing counts its full tick span. A completed Wonder holds through
 * the timer; a player holding ALL relics (every Relic row STORED in
 * their own finished Monasteries, at least one relic existing) does the
 * same. Destruction is the cancel key: razing the Wonder (or losing any
 * relic — capture-on-destruction grounds it again) breaks the act, the
 * heartbeats fall back to ONGOING and the hold freezes until the act
 * stands once more.
 *
 * Hold progress is derived purely from the player's own VictoryCheck
 * log — the exact rows the digests hash: an interval contributes its
 * tick span when the LATER check is SUSTAINING and nothing otherwise.
 * That makes the timer PAUSE whenever the sustaining condition breaks
 * and RESUME where it left off, replay-safe with zero hidden state;
 * decisions quantize to the 30-tick cadence.
 *
 * CONQUEST: "enemy military production capacity destroyed". The watched
 * quantity is the §2.6 military-production set (barracks / archery
 * range / stable — the T7 helper's MILITARY_PRODUCTION_BUILDING_IDS).
 * A player is DEFEATED when they once had finished military-production
 * capacity and now have none:
 *
 *   defeated(P) = capacityEverObserved(P) && liveCount(P) === 0
 *
 * Capacity history is reconstructed from the player's own digest-visible
 * VictoryCheck log (any recorded metric > 0) plus the current live count,
 * so the rule is replay-safe with zero hidden state. A player who never
 * built production capacity cannot be conquered — there is nothing to
 * destroy. Timerless: the decision lands on the FIRST check that sees a
 * defeat.
 *
 * SYMMETRY: every side runs the SAME evaluators through the SAME code
 * path — conquest reaches its verdict per side through one shared
 * predicate, Knowledge/Culture/Economic read each player's OWN ledger
 * rows, and Wonder/Relic probe each side's own buildings and relics.
 * The v1 AI charters no companies (SPEC §2.7) but an AI-owned Company
 * row would win through this identical code path.
 *
 * SURRENDER (§2.13 game flow): the `surrender` command marks its player
 * defeated immediately; every surviving opponent wins. After any
 * decision the evaluator freezes — no further VictoryCheck rows are
 * appended, so post-game digests stay stable while the world idles.
 *
 * Rows: every VICTORY_CHECK_CADENCE_TICKS each ledgered player receives
 * an ONGOING entry carrying their current metric; decisive entries land
 * at the decision tick. All of it rides the VictoryCheck component —
 * milestone digests show victory progress marching with the game.
 */

import {
  appendVictoryCheck,
  readVictoryChecks,
  latestVictoryCheck,
  VICTORY_PATH_CONQUEST,
  VICTORY_PATH_KNOWLEDGE,
  VICTORY_PATH_CULTURE,
  VICTORY_PATH_WONDER,
  VICTORY_PATH_RELIC,
  VICTORY_PATH_ECONOMIC,
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_ONGOING,
  VICTORY_STATUS_SUSTAINING,
  VICTORY_STATUS_SURRENDERED,
  VICTORY_STATUS_WON,
  type VictoryCheckEntry,
} from "../components/victory";
import {
  readCombatEvents,
  COMBAT_EVENT_UNIT_DEATH,
} from "../components/combat";
import { knowledgePointsOf } from "../components/knowledge";
import { prestigeOf } from "../components/culture";
import { branchOutputOf } from "../components/branchOutput";
import { relicsOf, RELIC_STORED } from "../components/relic";
import { buildingIdOfCode, victoryPathDefOf } from "../../data/definitions";
import {
  buildingDefsForVictoryPath,
  completingActDefOf,
} from "../../data/victoryRoles";
import { militaryProductionBuildingCount } from "./conquest";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

/** §2.8-adjacent cadence: victory checks ride the 1 s planning rhythm. */
export const VICTORY_CHECK_CADENCE_TICKS = 30;

/** Command kind conceding the match for the submitting player. */
export const SURRENDER_COMMAND_KIND = "surrender";

/** Everything an evaluator may read. Deliberately narrow and read-only. */
export interface VictoryContext {
  readonly world: World;
  readonly comps: SimComponents;
}

export interface VictoryPathEvaluator {
  /** Stable slug (diagnostics/UI). */
  readonly id: string;
  /** Stable u8 code stored in VictoryCheck rows — never renumbered. */
  readonly pathCode: number;
  /**
   * Hold ticks required after the act completes (win on hold). undefined
   * = timerless (Conquest): the decision fires on the first check that
   * sees the act complete.
   */
  readonly timerTicks: number | undefined;
  /**
   * Timed paths only: the minimum sustained metric (per sim minute)
   * each check must record for its interval to count toward the hold.
   * Undefined on timerless paths.
   */
  readonly thresholdPerMin?: number | undefined;
  /** Metric sample for THIS player, recorded in their check log. */
  metric(ctx: VictoryContext, playerId: number): number;
  /** Completing-act probe for THIS player (true = this player wins). */
  actComplete(ctx: VictoryContext, playerId: number): boolean;
}

// ---- Conquest ------------------------------------------------------------------

/**
 * THIS player's live military-production capacity — the conquest metric
 * (barracks + archery range + stable, finished buildings only).
 */
export function conquestCapacityOf(
  ctx: VictoryContext,
  playerId: number,
): number {
  return militaryProductionBuildingCount(ctx.world, ctx.comps, playerId);
}

/**
 * Whether P ever held finished military-production capacity: readable
 * from P's own VictoryCheck history (any positive metric) or the current
 * live count. Pure function of digest-visible rows.
 */
function conquestCapacityEverSeen(
  ctx: VictoryContext,
  playerId: number,
): boolean {
  if (conquestCapacityOf(ctx, playerId) > 0) return true;
  return readVictoryChecks(ctx.world, ctx.comps, playerId).some(
    (entry) =>
      entry.pathCode === VICTORY_PATH_CONQUEST &&
      entry.status === VICTORY_STATUS_ONGOING &&
      entry.metric > 0,
  );
}

/**
 * Conquest defeat predicate for ONE player (symmetric: callers run the
 * same function for every side).
 */
export function conquestDefeated(
  ctx: VictoryContext,
  playerId: number,
): boolean {
  return (
    conquestCapacityEverSeen(ctx, playerId) &&
    conquestCapacityOf(ctx, playerId) === 0
  );
}

/** The M2 baseline path set: exactly one entry — conquest. */
export const CONQUEST_EVALUATOR: VictoryPathEvaluator = {
  id: "conquest",
  pathCode: VICTORY_PATH_CONQUEST,
  timerTicks: undefined, // timerless per §2.11
  thresholdPerMin: undefined,
  metric: conquestCapacityOf,
  // P's act completes when every ENEMY is defeated — same predicate
  // both directions, evaluated per side.
  actComplete: (ctx, playerId) =>
    victoryPlayerIds(ctx.world, ctx.comps).some(
      (other) => other !== playerId && conquestDefeated(ctx, other),
    ),
};

// ---- Timed paths (§2.11 Knowledge / Culture / Economic / hold-only) ------------

/**
 * Trailing span the HUD/decision readouts average the rate over: the
 * per-minute figure between the cumulative counter now and its oldest
 * recorded sample within this window. Long enough to smooth lumpy
 * generator output (daily lessons, festival bursts), short enough that
 * progress reads responsively.
 */
export const VICTORY_RATE_WINDOW_TICKS = 3600;

/** Ticks in one sim minute (30 Hz × 60 s) — the per-min rate scale. */
export const TICKS_PER_SIM_MINUTE = 1800;

/** Milli-units per whole unit — thresholds are declared per minute. */
const MILLI_PER_UNIT = 1000;

/**
 * One player's non-decisive check history for one path — the ONGOING/
 * SUSTAINING heartbeat tail the timed-path math derives everything
 * from. Fresh array each call; digest rows stay untouched.
 */
function heartbeatHistoryOf(
  ctx: VictoryContext,
  playerId: number,
  pathCode: number,
): VictoryCheckEntry[] {
  return readVictoryChecks(ctx.world, ctx.comps, playerId).filter(
    (entry) =>
      entry.pathCode === pathCode &&
      (entry.status === VICTORY_STATUS_ONGOING ||
        entry.status === VICTORY_STATUS_SUSTAINING),
  );
}

/** Per-minute milli-rate over ONE check interval (0 on zero span). */
export function intervalRateMilliOf(
  previous: Pick<VictoryCheckEntry, "tick" | "metric">,
  current: Pick<VictoryCheckEntry, "tick" | "metric">,
): number {
  const span = current.tick - previous.tick;
  if (span <= 0) return 0;
  const delta = current.metric - previous.metric;
  if (delta <= 0) return 0;
  return Math.round((delta * TICKS_PER_SIM_MINUTE) / span);
}

/**
 * The sustained rate for one gated timed path right now: the
 * cumulative counter's delta across the trailing window scaled to a
 * per-minute milli figure, anchored on the OLDEST recorded heartbeat
 * inside the window. Pure read of digest-visible rows. Hold-only paths
 * (no thresholdPerMin) have no rate to sustain — callers skip this.
 */
function trailingRateMilliOf(
  ctx: VictoryContext,
  path: VictoryPathEvaluator,
  playerId: number,
): number {
  const now = path.metric(ctx, playerId);
  // Heartbeats ascend by tick; the first one inside the window is the
  // oldest anchor. A zero-span anchor (only this very tick's own row)
  // has no elapsed time to average over.
  const anchor = heartbeatHistoryOf(ctx, playerId, path.pathCode).find(
    (entry) => ctx.world.tick - entry.tick <= VICTORY_RATE_WINDOW_TICKS,
  );
  if (anchor === undefined || anchor.tick >= ctx.world.tick) return 0;
  return intervalRateMilliOf(anchor, { tick: ctx.world.tick, metric: now });
}

/**
 * Accumulated hold ticks for ONE timed path from the player's own log:
 * every interval between consecutive heartbeats counts its tick span
 * when the LATER check carries SUSTAINING (act standing +, on gated
 * paths, the interval rate at/above threshold). Intervals under a
 * broken condition count nothing — the timer pauses and resumes
 * exactly as §2.11 prescribes. Decisions quantize to the cadence.
 */
export function sustainedHoldTicksOf(
  ctx: VictoryContext,
  path: Pick<VictoryPathEvaluator, "pathCode" | "thresholdPerMin">,
  playerId: number,
): number {
  const history = heartbeatHistoryOf(ctx, playerId, path.pathCode);
  let hold = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.status === VICTORY_STATUS_SUSTAINING) {
      hold += history[i]!.tick - history[i - 1]!.tick;
    }
  }
  return hold;
}

/** True when `playerId` owns a finished building of any of `defIds`. */
function ownsFinishedBuilding(
  ctx: VictoryContext,
  playerId: number,
  defIds: readonly string[],
): boolean {
  const buildingRows = ctx.world.rowsByComponentId.get(ctx.comps.buildingId);
  if (!buildingRows) return false;
  for (const row of buildingRows.values()) {
    if (row[0] !== playerId) continue;
    if (defIds.includes(buildingIdOfCode(row[1]!))) return true;
  }
  return false;
}

type VictoryRolePath = "knowledge" | "culture";

interface TimedPathGate {
  readonly timerTicks: number;
  readonly thresholdPerMin: number;
}

/** Resolve the completing-act sustain gate for one timed path. */
function timedPathGate(path: VictoryRolePath): TimedPathGate {
  const act = completingActDefOf(path)?.victory;
  if (
    act?.sustainPerMin === undefined ||
    act.holdTicks === undefined ||
    act.sustainPerMin <= 0 ||
    act.holdTicks <= 0
  ) {
    throw new Error(
      `victory path ${JSON.stringify(path)} has no completing-act sustain gate in its definition set`,
    );
  }
  return { timerTicks: act.holdTicks, thresholdPerMin: act.sustainPerMin };
}

/** Resolve the completing-act hold timer for one hold-only path. */
function holdOnlyGate(path: "wonder" | "relic"): number {
  const act = completingActDefOf(path)?.victory;
  if (act?.holdTicks === undefined || act.holdTicks <= 0) {
    throw new Error(
      `victory path ${JSON.stringify(path)} has no completing-act hold timer in its definition set`,
    );
  }
  return act.holdTicks;
}

/** Finished-building probe over the path's completing-act defs. */
function makeCompletingActProbe(
  path: VictoryRolePath,
): (ctx: VictoryContext, playerId: number) => boolean {
  const defIds = buildingDefsForVictoryPath(path)
    .filter(
      (def) =>
        def.victory?.sustainPerMin !== undefined ||
        def.victory?.holdTicks !== undefined,
    )
    .map((def) => def.id);
  return (ctx, playerId) => ownsFinishedBuilding(ctx, playerId, defIds);
}

/** The §2.11 Knowledge path: School output + research lumps → Academy. */
export const KNOWLEDGE_EVALUATOR: VictoryPathEvaluator = (() => {
  const gate = timedPathGate("knowledge");
  return {
    id: "knowledge",
    pathCode: VICTORY_PATH_KNOWLEDGE,
    timerTicks: gate.timerTicks,
    thresholdPerMin: gate.thresholdPerMin,
    metric: (ctx, playerId) =>
      knowledgePointsOf(ctx.world, ctx.comps, playerId),
    actComplete: makeCompletingActProbe("knowledge"),
  };
})();

/** The §2.11 Culture path: monuments + happiness + festivals → Grand Monument. */
export const CULTURE_EVALUATOR: VictoryPathEvaluator = (() => {
  const gate = timedPathGate("culture");
  return {
    id: "culture",
    pathCode: VICTORY_PATH_CULTURE,
    timerTicks: gate.timerTicks,
    thresholdPerMin: gate.thresholdPerMin,
    metric: (ctx, playerId) => prestigeOf(ctx.world, ctx.comps, playerId),
    actComplete: makeCompletingActProbe("culture"),
  };
})();

// ---- M4-T5: Wonder / Relic / Economic -------------------------------------------

/** This player's live count of finished Wonder buildings. */
export function wonderCountOf(ctx: VictoryContext, playerId: number): number {
  const defIds = buildingDefsForVictoryPath("wonder").map((def) => def.id);
  let count = 0;
  const buildingRows = ctx.world.rowsByComponentId.get(ctx.comps.buildingId);
  if (!buildingRows) return 0;
  for (const row of buildingRows.values()) {
    if (row[0] !== playerId) continue;
    if (defIds.includes(buildingIdOfCode(row[1]!))) count += 1;
  }
  return count;
}

/**
 * The finished Monastery defs — the relic path's storage targets.
 * Empty while the content set ships no such building.
 */
function monasteryDefIds(): string[] {
  return buildingDefsForVictoryPath("relic")
    .filter((def) => def.victory?.holdTicks !== undefined)
    .map((def) => def.id);
}

/** Relics of THIS player stored inside their own finished monasteries. */
export function relicsHeldOf(ctx: VictoryContext, playerId: number): number {
  const monasteryIds = monasteryDefIds();
  if (monasteryIds.length === 0) return 0;
  let held = 0;
  for (const { row } of relicsOf(ctx.world, ctx.comps)) {
    if (row.state !== RELIC_STORED) continue;
    // Stored in a FINISHED monastery this player owns (a razed holder
    // has no Building row left to satisfy the probe).
    const holderRow = ctx.world.rowsByComponentId
      .get(ctx.comps.buildingId)
      ?.get(row.holderEid);
    if (
      holderRow &&
      holderRow[0] === playerId &&
      monasteryIds.includes(buildingIdOfCode(holderRow[1]!))
    ) {
      held += 1;
    }
  }
  return held;
}

/**
 * The §2.11 Relic completing act: at least one relic exists and THIS
 * player holds enough relics inside their own finished monasteries.
 * The winning threshold is min(3, total relics on the map) so that
 * two-relic golden maps (m4t5b) still require both while standard
 * skirmish maps (5 relics) require exactly 3 — matching AoE2 rules.
 * A zero-relic vacuous truth is explicitly NOT an act — a monastery
 * alone must never win.
 */
export function relicActCompleteOf(
  ctx: VictoryContext,
  playerId: number,
): boolean {
  const all = relicsOf(ctx.world, ctx.comps);
  if (all.length === 0) return false;
  const threshold = Math.min(3, all.length);
  return relicsHeldOf(ctx, playerId) >= threshold;
}

/**
 * The §2.11 Economic completing act: owning ≥1 Company (SPEC §2.11 —
 * no completing-act building). Reads Company rows only.
 */
export function ownsCompanyOf(ctx: VictoryContext, playerId: number): boolean {
  for (const [, row] of ctx.world.rowsByComponentId.get(ctx.comps.companyId) ??
    []) {
    if (row[0] === playerId) return true;
  }
  return false;
}

/** The §2.11 Wonder path: complete the Wonder, hold through the timer. */
export const WONDER_EVALUATOR: VictoryPathEvaluator = (() => {
  const timer = holdOnlyGate("wonder");
  return {
    id: "wonder",
    pathCode: VICTORY_PATH_WONDER,
    timerTicks: timer,
    thresholdPerMin: undefined, // hold-only: standing Wonder suffices
    metric: wonderCountOf,
    actComplete: (ctx, playerId) => wonderCountOf(ctx, playerId) > 0,
  };
})();

/** The §2.11 Relic path: hold ALL Relics through the timer. */
export const RELIC_EVALUATOR: VictoryPathEvaluator = (() => {
  const timer = holdOnlyGate("relic");
  return {
    id: "relic",
    pathCode: VICTORY_PATH_RELIC,
    timerTicks: timer,
    thresholdPerMin: undefined, // hold-only: holding every relic suffices
    metric: relicsHeldOf,
    actComplete: relicActCompleteOf,
  };
})();

/**
 * The §2.11 Economic path: aggregate Branch output market-value/min
 * sustained ≥N while owning ≥1 Company for T minutes. Gate lives in
 * the victory-path definition JSON ("economic-path"), not a building —
 * the act is company ownership itself.
 */
export const ECONOMIC_EVALUATOR: VictoryPathEvaluator = (() => {
  const gate = victoryPathDefOf("economic-path");
  return {
    id: "economic",
    pathCode: VICTORY_PATH_ECONOMIC,
    timerTicks: gate.holdTicks,
    thresholdPerMin: gate.sustainPerMin,
    metric: (ctx, playerId) => branchOutputOf(ctx.world, ctx.comps, playerId),
    actComplete: ownsCompanyOf,
  };
})();

/**
 * Default evaluators registered by createVictorySystem: conquest plus
 * the M4-T4/M4-T5 timed paths, running symmetrically for every side.
 */
export const DEFAULT_VICTORY_PATHS: readonly VictoryPathEvaluator[] = [
  CONQUEST_EVALUATOR,
  KNOWLEDGE_EVALUATOR,
  CULTURE_EVALUATOR,
  WONDER_EVALUATOR,
  RELIC_EVALUATOR,
  ECONOMIC_EVALUATOR,
];

// ---- Player enumeration & outcome ------------------------------------------------

/** Distinct stockpile-ledger owners, ascending — everyone in the match. */
export function victoryPlayerIds(world: World, comps: SimComponents): number[] {
  const owners = new Set<number>();
  for (const row of world.rowsByComponentId.get(comps.stockpileId)?.values() ??
    []) {
    owners.add(row[0]!);
  }
  return [...owners].sort((a, b) => a - b);
}

/** Why a player left the match. */
export type DefeatReason =
  | "conquest"
  | "surrender"
  | "knowledge"
  | "culture"
  | "wonder"
  | "relic"
  | "economic";

/** Defeat reason for a decisive LOST tail entry, by its path code. */
function defeatReasonOfPathCode(pathCode: number): DefeatReason {
  switch (pathCode) {
    case VICTORY_PATH_KNOWLEDGE:
      return "knowledge";
    case VICTORY_PATH_CULTURE:
      return "culture";
    case VICTORY_PATH_WONDER:
      return "wonder";
    case VICTORY_PATH_RELIC:
      return "relic";
    case VICTORY_PATH_ECONOMIC:
      return "economic";
    default:
      return "conquest";
  }
}

export interface DefeatRecord {
  readonly playerId: number;
  readonly reason: DefeatReason;
}

export interface VictoryOutcome {
  readonly decided: boolean;
  /** Players whose completing act stands (empty on a mutual draw). */
  readonly winners: readonly number[];
  readonly losers: readonly DefeatRecord[];
}

const UNDECIDED: VictoryOutcome = {
  decided: false,
  winners: [],
  losers: [],
};

/**
 * The current outcome, derived purely from the players' VictoryCheck
 * logs — the exact rows the digests hash. Undecided until someone holds
 * a WON/LOST/SURRENDERED tail entry.
 */
export function evaluateOutcome(
  world: World,
  comps: SimComponents,
): VictoryOutcome {
  const winners: number[] = [];
  const losers: DefeatRecord[] = [];
  for (const playerId of victoryPlayerIds(world, comps)) {
    const tail = latestVictoryCheck(world, comps, playerId);
    if (tail?.status === VICTORY_STATUS_WON) winners.push(playerId);
    else if (tail?.status === VICTORY_STATUS_LOST) {
      losers.push({
        playerId,
        reason: defeatReasonOfPathCode(tail.pathCode),
      });
    } else if (tail?.status === VICTORY_STATUS_SURRENDERED) {
      losers.push({ playerId, reason: "surrender" });
    }
  }
  if (winners.length === 0 && losers.length === 0) return UNDECIDED;
  return { decided: true, winners, losers };
}

// ---- The system ------------------------------------------------------------------

export interface VictorySystemOptions {
  /** Evaluators to run; defaults to conquest + the M4-T4/T5 timed paths. */
  readonly paths?: readonly VictoryPathEvaluator[] | undefined;
}

/** HUD/readout summary for one path from one player's perspective. */
export interface VictoryPathReadout {
  readonly id: string;
  readonly pathCode: number;
  /** Current metric sample (capacity / standing counts; timed: cumulative milli). */
  readonly metric: number;
  /**
   * Sustained per-minute rate for gated timed paths (undefined on
   * timerless and hold-only paths).
   */
  readonly ratePerMinMilli: number | undefined;
  readonly thresholdPerMin: number | undefined;
  readonly actComplete: boolean;
  /** Accumulated qualifying hold ticks (0 on timerless paths). */
  readonly holdTicks: number;
  readonly timerTicks: number | undefined;
  /** Noun the panel prints the metric with ("capacity", "relics"…). */
  readonly metricNoun: string;
}

/** The metric noun each default path displays in the HUD panel. */
function metricNounOf(path: VictoryPathEvaluator): string {
  switch (path.id) {
    case "wonder":
      return "wonders";
    case "relic":
      return "relics";
    default:
      return "capacity";
  }
}

/**
 * The full per-path picture for one player, straight off the digest
 * rows — the HUD panel and tests share this so chrome cannot drift
 * from what the sim will decide.
 */
export function victoryPathReadout(
  ctx: VictoryContext,
  path: VictoryPathEvaluator,
  playerId: number,
): VictoryPathReadout {
  const gated = path.thresholdPerMin !== undefined;
  return {
    id: path.id,
    pathCode: path.pathCode,
    metric: path.metric(ctx, playerId),
    ratePerMinMilli: gated
      ? trailingRateMilliOf(ctx, path, playerId)
      : undefined,
    thresholdPerMin: path.thresholdPerMin,
    actComplete: path.actComplete(ctx, playerId),
    holdTicks: sustainedHoldTicksOf(ctx, path, playerId),
    timerTicks: path.timerTicks,
    metricNoun: metricNounOf(path),
  };
}

/** Every default path's readout for one player. */
export function victoryPathReadouts(
  world: World,
  comps: SimComponents,
  playerId: number,
): VictoryPathReadout[] {
  const ctx: VictoryContext = { world, comps };
  return DEFAULT_VICTORY_PATHS.map((path) =>
    victoryPathReadout(ctx, path, playerId),
  );
}

/**
 * Build the victory SimSystem. Register LAST (after combat and the AI
 * planner) so checks observe fully settled state: destruction torn down,
 * rubble spawned, planner drafts already submitted for next tick.
 *
 * Timed paths must declare a positive hold timer; a sustain threshold
 * is optional (hold-only Wonder/Relic) but when declared it must be
 * positive — a half-specified gated path could never win or would win
 * without sustaining, so it fails loudly at registration.
 */
export function createVictorySystem(
  comps: SimComponents,
  options: VictorySystemOptions = {},
): SimSystem {
  const paths = options.paths ?? DEFAULT_VICTORY_PATHS;
  for (const path of paths) {
    if (path.timerTicks === undefined) {
      if (path.thresholdPerMin !== undefined) {
        throw new Error(
          `victory path ${JSON.stringify(path.id)} declares a threshold but no hold timer`,
        );
      }
      continue;
    }
    if (path.timerTicks <= 0) {
      throw new Error(
        `timed victory path ${JSON.stringify(path.id)} needs a positive hold timer`,
      );
    }
    const threshold = path.thresholdPerMin;
    if (threshold !== undefined && threshold <= 0) {
      throw new Error(
        `gated victory path ${JSON.stringify(path.id)} needs a positive sustain threshold`,
      );
    }
  }
  /** Frozen once decided; derivable from the rows themselves on restore. */
  let decided = false;

  return (world, commands) => {
    // ---- Surrender commands resolve first (their target tick may also
    // be a cadence tick; the frozen flag keeps ordering well-defined).
    for (const command of commands) {
      if (command.kind !== SURRENDER_COMMAND_KIND) continue;
      if (!command.data) throw new Error("surrender requires command data");
      applySurrender(world, comps, command.data, () => {
        decided = true;
      });
    }
    if (decided || world.tick % VICTORY_CHECK_CADENCE_TICKS !== 0) return;
    runChecks(world, comps, paths, () => {
      decided = true;
    });
  };
}

function applySurrender(
  world: World,
  comps: SimComponents,
  data: Readonly<Record<string, unknown>>,
  freeze: () => void,
): void {
  const raw = data.playerId;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error("surrender playerId must be a non-negative integer");
  }
  if (evaluateOutcome(world, comps).decided) return; // post-game no-op
  const players = victoryPlayerIds(world, comps);
  if (!players.includes(raw)) {
    throw new Error(`surrender player ${String(raw)} has no ledger`);
  }
  appendVictoryCheck(world, comps, raw, {
    tick: world.tick,
    pathCode: VICTORY_PATH_CONQUEST,
    status: VICTORY_STATUS_SURRENDERED,
    metric: conquestCapacityOf({ world, comps }, raw),
  });
  for (const other of players) {
    if (other === raw) continue;
    appendVictoryCheck(world, comps, other, {
      tick: world.tick,
      pathCode: VICTORY_PATH_CONQUEST,
      status: VICTORY_STATUS_WON,
      metric: conquestCapacityOf({ world, comps }, other),
    });
  }
  freeze();
}

function runChecks(
  world: World,
  comps: SimComponents,
  paths: readonly VictoryPathEvaluator[],
  freeze: () => void,
): void {
  const ctx: VictoryContext = { world, comps };
  const players = victoryPlayerIds(world, comps);

  for (const path of paths) {
    // Completing-act winners: timerless paths decide on the act alone
    // (M2 conquest); timed paths additionally demand the accumulated
    // hold — every SUSTAINING interval since the log began — to cover
    // the path's timer. Same code path for both sides.
    const winnersNow = players.filter((playerId) => {
      if (!path.actComplete(ctx, playerId)) return false;
      if (path.timerTicks === undefined) return true;
      return sustainedHoldTicksOf(ctx, path, playerId) >= path.timerTicks;
    });
    if (winnersNow.length === 0) continue;
    const winnerSet = new Set(winnersNow);
    // Losers first, then winners ascending — pinned row order.
    for (const playerId of players) {
      if (winnerSet.has(playerId)) continue;
      appendVictoryCheck(world, comps, playerId, {
        tick: world.tick,
        pathCode: path.pathCode,
        status: VICTORY_STATUS_LOST,
        metric: path.metric(ctx, playerId),
      });
    }
    for (const playerId of winnersNow) {
      appendVictoryCheck(world, comps, playerId, {
        tick: world.tick,
        pathCode: path.pathCode,
        status: VICTORY_STATUS_WON,
        metric: path.metric(ctx, playerId),
      });
    }
    freeze();
    return; // decided — nothing else appends this tick
  }

  // Routine heartbeat: one entry per player and path, ascending. Timed
  // paths stamp SUSTAINING when the completing act stands AND — on
  // gated paths (Knowledge/Culture/Economic) — the interval since
  // their previous heartbeat held the threshold rate. Hold-only paths
  // (Wonder/Relic) stamp whenever the act stands. That status bit is
  // exactly what the hold-timer sum reads, so the pause/resume ledger
  // lives in digest rows only.
  for (const playerId of players) {
    for (const path of paths) {
      const metric = path.metric(ctx, playerId);
      let status = VICTORY_STATUS_ONGOING;
      const actStands = path.actComplete(ctx, playerId);
      if (actStands && path.thresholdPerMin !== undefined) {
        const tail = heartbeatHistoryOf(ctx, playerId, path.pathCode).at(-1);
        const rate =
          tail === undefined
            ? 0
            : intervalRateMilliOf(tail, { tick: world.tick, metric });
        if (rate >= path.thresholdPerMin * MILLI_PER_UNIT) {
          status = VICTORY_STATUS_SUSTAINING;
        }
      } else if (actStands && path.timerTicks !== undefined) {
        status = VICTORY_STATUS_SUSTAINING;
      }
      appendVictoryCheck(world, comps, playerId, {
        tick: world.tick,
        pathCode: path.pathCode,
        status,
        metric,
      });
    }
  }
}

// ---- Death-ledger reads (stats recap) ---------------------------------------------

/**
 * Units lost by ONE player: the UNIT_DEATH entries in their own
 * CombatEvents death ledger (structure razes carry the separate _DEATH
 * kind, so fallen units count exactly).
 */
export function unitsLostOf(
  world: World,
  comps: SimComponents,
  playerId: number,
): number {
  let lost = 0;
  for (const event of readCombatEvents(world, comps, playerId)) {
    if (event.kind === COMBAT_EVENT_UNIT_DEATH) lost += 1;
  }
  return lost;
}

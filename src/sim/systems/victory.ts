/**
 * Victory evaluators — SPEC §2.11 / M2-T10 (issue #44).
 *
 * The §2.11 shared frame: every path = generator → accumulating metric →
 * completing act → victory timer (win on hold; Conquest timerless). The
 * {@link VictoryPathEvaluator} interface is that frame as data — one
 * evaluator per path, each carrying its stable row code, its hold-timer
 * length (undefined = timerless), a per-player metric sampler for the
 * digest rows and a per-player completing-act probe. Generator hooks
 * (School output, Prestige/min …) arrive with the Knowledge/Culture/
 * Economic content paths in M3+; conquest needs none.
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
 * destroy; economic-only play stays alive by design until M3 adds the
 * other paths. Timerless: the decision lands on the FIRST check that
 * sees a defeat, symmetrically for both sides through the SAME code
 * path (the issue's "evaluators run symmetrically").
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
  VICTORY_STATUS_LOST,
  VICTORY_STATUS_ONGOING,
  VICTORY_STATUS_SURRENDERED,
  VICTORY_STATUS_WON,
} from "../components/victory";
import {
  readCombatEvents,
  COMBAT_EVENT_UNIT_DEATH,
} from "../components/combat";
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
  metric: conquestCapacityOf,
  // P's act completes when every ENEMY is defeated — same predicate
  // both directions, evaluated per side.
  actComplete: (ctx, playerId) =>
    victoryPlayerIds(ctx.world, ctx.comps).some(
      (other) => other !== playerId && conquestDefeated(ctx, other),
    ),
};

/** Default evaluators registered by createVictorySystem. */
export const DEFAULT_VICTORY_PATHS: readonly VictoryPathEvaluator[] = [
  CONQUEST_EVALUATOR,
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
export type DefeatReason = "conquest" | "surrender";

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
    const status = latestVictoryCheck(world, comps, playerId)?.status;
    if (status === VICTORY_STATUS_WON) winners.push(playerId);
    else if (status === VICTORY_STATUS_LOST)
      losers.push({ playerId, reason: "conquest" });
    else if (status === VICTORY_STATUS_SURRENDERED)
      losers.push({ playerId, reason: "surrender" });
  }
  if (winners.length === 0 && losers.length === 0) return UNDECIDED;
  return { decided: true, winners, losers };
}

// ---- The system ------------------------------------------------------------------

export interface VictorySystemOptions {
  /** Evaluators to run; defaults to the M2 conquest set. */
  readonly paths?: readonly VictoryPathEvaluator[] | undefined;
}

/**
 * Build the victory SimSystem. Register LAST (after combat and the AI
 * planner) so checks observe fully settled state: destruction torn down,
 * rubble spawned, planner drafts already submitted for next tick.
 *
 * Timed paths are frame-complete but content-less in M2: registering an
 * evaluator WITH a hold timer throws loudly until Wonder/Relic/Knowledge
 * timers ship with their generators (M3+) — silently ignoring a timer
 * would fake-decide matches.
 */
export function createVictorySystem(
  comps: SimComponents,
  options: VictorySystemOptions = {},
): SimSystem {
  const paths = options.paths ?? DEFAULT_VICTORY_PATHS;
  for (const path of paths) {
    if (path.timerTicks !== undefined) {
      throw new Error(
        `victory path ${JSON.stringify(path.id)} carries a hold timer — timed paths need their §2.11 generators (M3+)`,
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
    // Timerless decision (M2): the first check where any player's
    // completing act stands decides the match — winners complete it,
    // every other ledgered player loses. Same code path for both sides;
    // conquest reaches here through CONQUEST_EVALUATOR.actComplete.
    const winnersNow = players.filter((playerId) =>
      path.actComplete(ctx, playerId),
    );
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

  // Routine heartbeat: one ONGOING entry per player and path, ascending.
  for (const playerId of players) {
    for (const path of paths) {
      appendVictoryCheck(world, comps, playerId, {
        tick: world.tick,
        pathCode: path.pathCode,
        status: VICTORY_STATUS_ONGOING,
        metric: path.metric(ctx, playerId),
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

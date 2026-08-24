/**
 * Victory component definitions — SPEC §2.11 / M2-T10.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/combat sets; registration is one strictly ascending
 * alphabetical sequence (components/index.ts defineSimComponents), pinning
 * digest/save iteration order forever (world.ts). VictoryCheck sorts after
 * Velocity, so it appends LAST — existing fixture digests are untouched
 * because worlds without a victory evaluator simply carry no rows here.
 *
 * Canonical row layout (arity is part of the digest contract):
 * - VictoryCheck (variable): [entryCount, tick₀, pathCode₀, status₀,
 *   metric₀, …] — append-only per-player evaluation log on the player's
 *   ledger entity (mirroring AgeAdvanced / CombatEvents). The §2.11
 *   evaluator appends one entry per player every VICTORY_CHECK_CADENCE_
 *   TICKS while the match is undecided, then the decisive WON/LOST/
 *   SURRENDERED entries freeze the game. Every entry is digest-visible by
 *   construction, so milestone digests show victory progress marching and
 *   replays can re-derive the decision without hidden state.
 *
 * Path/status codes are stable u8 values, never renumbered — they live in
 * hashed digest bytes forever.
 */

import type { ComponentRows, World } from "../core/world";

export const VICTORY_CHECK = "VictoryCheck" as const;

/** Row arity per victory component — pinned for digest stability. */
export const VICTORY_COMPONENT_ARITIES: readonly [string, number][] = [
  [VICTORY_CHECK, -1], // variable-length evaluation log
];

/** Component ids the victory system reads/writes. */
export interface VictoryComponents {
  readonly victoryCheckId: number;
}

/** §2.11 path codes. Conquest ships in M2; Knowledge/Culture in M4-T4. */
export const VICTORY_PATH_CONQUEST = 0;
export const VICTORY_PATH_KNOWLEDGE = 1;
export const VICTORY_PATH_CULTURE = 2;

/** VictoryCheck status codes. */
export const VICTORY_STATUS_ONGOING = 0;
export const VICTORY_STATUS_WON = 1;
export const VICTORY_STATUS_LOST = 2;
/** A player conceded via the surrender command (§2.13 game flow). */
export const VICTORY_STATUS_SURRENDERED = 3;
/**
 * Timed-path heartbeat (M4-T4): the completing act stands AND the
 * interval since the previous check sustained at/above the path's
 * threshold — this check's interval counts toward the hold timer.
 * Plain ONGOING means the interval did not qualify (timer paused).
 */
export const VICTORY_STATUS_SUSTAINING = 4;

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** One decoded digest-visible evaluation result for one player. */
export interface VictoryCheckEntry {
  readonly tick: number;
  readonly pathCode: number;
  readonly status: number;
  /** Path metric sample (conquest: own live military-production count). */
  readonly metric: number;
}

function requirePlayerLedgerEid(
  world: World,
  stockpileId: number,
  playerId: number,
): number {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `player id must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  for (const [eid, row] of requireRows(world, stockpileId)) {
    if (row[0] === playerId) return eid;
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

/** Append one evaluation entry to `playerId`'s log on their ledger entity. */
export function appendVictoryCheck(
  world: World,
  comps: Pick<VictoryLedgerComponents, "victoryCheckId"> & {
    stockpileId: number;
  },
  playerId: number,
  entry: VictoryCheckEntry,
): void {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.victoryCheckId);
  const row = rows.get(eid);
  const next = row ? [...row] : [0];
  next.push(entry.tick, entry.pathCode, entry.status, entry.metric);
  next[0] = (next[0] ?? 0) + 1;
  rows.set(eid, next);
}

/** Decoded copy of one player's evaluation log (fresh array each call). */
export function readVictoryChecks(
  world: World,
  comps: Pick<VictoryLedgerComponents, "victoryCheckId"> & {
    stockpileId: number;
  },
  playerId: number,
): VictoryCheckEntry[] {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const row = world.rowsByComponentId.get(comps.victoryCheckId)?.get(eid);
  if (!row) return [];
  const entries: VictoryCheckEntry[] = [];
  for (let i = 0; i < row[0]!; i++) {
    entries.push({
      tick: row[1 + i * 4]!,
      pathCode: row[2 + i * 4]!,
      status: row[3 + i * 4]!,
      metric: row[4 + i * 4]!,
    });
  }
  return entries;
}

/** Latest evaluation entry for one player, or undefined before the first. */
export function latestVictoryCheck(
  world: World,
  comps: Pick<VictoryLedgerComponents, "victoryCheckId"> & {
    stockpileId: number;
  },
  playerId: number,
): VictoryCheckEntry | undefined {
  const entries = readVictoryChecks(world, comps, playerId);
  return entries.at(-1);
}

/**
 * Structural slice of SimComponents the victory row helpers need — kept
 * local so systems can depend on this file without pulling the full
 * component set into every signature.
 */
export type VictoryLedgerComponents = VictoryComponents;

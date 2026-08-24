/**
 * Prestige Ledger component — SPEC §2.11 Culture path / M4-T4.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). PrestigeLedger slots between
 * Position and ProductionCycle ("Position" < "Prestige…" < "Production…").
 *
 * Canonical row layout (arity is part of the digest contract) —
 * PrestigeLedger (1): [milliPrestige].
 *
 * One row per player, attached to their ledger entity (the Stockpile
 * entity, mirroring VictoryCheck/CombatEvents). milliPrestige is the
 * CUMULATIVE lifetime prestige in thousandths of a point — the §2.11
 * generator credits it (systems/culture.ts: monument income, population
 * happiness/morale surplus, festival bursts), and the victory evaluator
 * derives the sustained prestige/min metric purely from deltas of this
 * digest-visible counter across the player's own VictoryCheck log.
 * Lazily attached: a world that never earns prestige carries zero rows
 * and every legacy digest stays byte-identical.
 */

import type { ComponentRows, World } from "../core/world";

export const PRESTIGE_LEDGER = "PrestigeLedger" as const;

/** Row arity per culture component — pinned for digest stability. */
export const PRESTIGE_LEDGER_ARITY = 1;

/** Component id the culture system reads/writes. */
export interface CultureLedgerComponents {
  readonly prestigeLedgerId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
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

/**
 * Credit `milli` thousandths of a Prestige point to `playerId`'s
 * cumulative counter. Creates the row lazily on first credit.
 */
export function creditPrestige(
  world: World,
  comps: Pick<CultureLedgerComponents, "prestigeLedgerId"> & {
    stockpileId: number;
  },
  playerId: number,
  milli: number,
): void {
  if (!Number.isInteger(milli) || milli <= 0) {
    throw new Error("prestige credit must be a positive integer milli amount");
  }
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.prestigeLedgerId);
  const row = rows.get(eid);
  if (row) row[0] = row[0]! + milli;
  else rows.set(eid, [milli]);
}

/** Cumulative lifetime prestige in milli-units for one player (0 before). */
export function prestigeOf(
  world: World,
  comps: Pick<CultureLedgerComponents, "prestigeLedgerId"> & {
    stockpileId: number;
  },
  playerId: number,
): number {
  for (const eid of world.entities) {
    const owner = world.rowsByComponentId.get(comps.stockpileId)?.get(eid);
    if (owner?.[0] !== playerId) continue;
    return (
      world.rowsByComponentId.get(comps.prestigeLedgerId)?.get(eid)?.[0] ?? 0
    );
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

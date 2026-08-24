/**
 * Branch Output Ledger component — SPEC §2.11 Economic path / M4-T5
 * (issue #60).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). BranchOutputLedger slots
 * between Branch and Building ("Branch" < "BranchOutput…" < "Bu…").
 *
 * Canonical row layout (arity is part of the digest contract) —
 * BranchOutputLedger (1): [milliValue].
 *
 * One row per player, attached to their ledger entity (the Stockpile
 * entity, mirroring KnowledgePoints/PrestigeLedger). milliValue is the
 * CUMULATIVE lifetime market value — in integer thousandths of a
 * credit — of ALL output credited at the player's COMPANY BRANCHES.
 * The companies layer's output observer credits it at every branch
 * credit event (full market value, not just the treasury share), and
 * the §2.11 Economic evaluator derives the sustained value/min metric
 * purely from deltas of this digest-visible counter across the
 * player's own VictoryCheck log. Lazily attached: a world that never
 * runs a branch carries zero rows and every legacy digest stays
 * byte-identical.
 */

import type { ComponentRows, World } from "../core/world";

export const BRANCH_OUTPUT_LEDGER = "BranchOutputLedger" as const;

/** Row arity per economic-ledger component — pinned for digest stability. */
export const BRANCH_OUTPUT_LEDGER_ARITY = 1;

/** Component id the economic path reads/writes. */
export interface BranchLedgerComponents {
  readonly branchOutputLedgerId: number;
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
 * Credit `milli` thousandths of a market-value credit to `playerId`'s
 * cumulative branch-output counter. Creates the row lazily on first
 * credit.
 */
export function creditBranchOutput(
  world: World,
  comps: Pick<BranchLedgerComponents, "branchOutputLedgerId"> & {
    stockpileId: number;
  },
  playerId: number,
  milli: number,
): void {
  if (!Number.isInteger(milli) || milli <= 0) {
    throw Error(`branch output credit must be a positive integer milli amount`);
  }
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.branchOutputLedgerId);
  const row = rows.get(eid);
  if (row) row[0] = row[0]! + milli;
  else rows.set(eid, [milli]);
}

/** Cumulative lifetime branch output in milli-credits for one player. */
export function branchOutputOf(
  world: World,
  comps: Pick<BranchLedgerComponents, "branchOutputLedgerId"> & {
    stockpileId: number;
  },
  playerId: number,
): number {
  for (const eid of world.entities) {
    const owner = world.rowsByComponentId.get(comps.stockpileId)?.get(eid);
    if (owner?.[0] !== playerId) continue;
    return (
      world.rowsByComponentId.get(comps.branchOutputLedgerId)?.get(eid)?.[0] ??
      0
    );
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

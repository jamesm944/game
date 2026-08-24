/**
 * Knowledge Points component — SPEC §2.11 Knowledge path / M4-T4.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). KnowledgePoints slots between
 * JobCooldown and Lessons ("Job…" < "Kno" < "Les").
 *
 * Canonical row layout (arity is part of the digest contract) —
 * KnowledgePoints (1): [milliKP].
 *
 * One row per player, attached to their ledger entity (the Stockpile
 * entity, mirroring VictoryCheck/CombatEvents). milliKP is the
 * CUMULATIVE lifetime knowledge output in thousandths of a point — the
 * §2.11 generator credits it (systems/knowledge.ts: School lessons,
 * teacher-scaled; lump awards per completed research), and the victory
 * evaluator derives the sustained KP/min metric purely from deltas of
 * this digest-visible counter across the player's own VictoryCheck log.
 * Lazily attached: a world that never studies carries zero rows and
 * every legacy digest stays byte-identical.
 */

import type { ComponentRows, World } from "../core/world";

export const KNOWLEDGE_POINTS = "KnowledgePoints" as const;

/** Row arity per knowledge component — pinned for digest stability. */
export const KNOWLEDGE_POINTS_ARITY = 1;

/** Component id the knowledge systems read/write. */
export interface KnowledgeLedgerComponents {
  readonly knowledgePointsId: number;
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
 * Credit `milli` thousandths of a Knowledge Point to `playerId`'s
 * cumulative counter. Creates the row lazily on first credit.
 */
export function creditKnowledgePoints(
  world: World,
  comps: Pick<KnowledgeLedgerComponents, "knowledgePointsId"> & {
    stockpileId: number;
  },
  playerId: number,
  milli: number,
): void {
  if (!Number.isInteger(milli) || milli <= 0) {
    throw Error(`knowledge credit must be a positive integer milli amount`);
  }
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.knowledgePointsId);
  const row = rows.get(eid);
  if (row) row[0] = row[0]! + milli;
  else rows.set(eid, [milli]);
}

/** Cumulative lifetime KP in milli-units for one player (0 before any). */
export function knowledgePointsOf(
  world: World,
  comps: Pick<KnowledgeLedgerComponents, "knowledgePointsId"> & {
    stockpileId: number;
  },
  playerId: number,
): number {
  for (const eid of world.entities) {
    const owner = world.rowsByComponentId.get(comps.stockpileId)?.get(eid);
    if (owner?.[0] !== playerId) continue;
    return (
      world.rowsByComponentId.get(comps.knowledgePointsId)?.get(eid)?.[0] ?? 0
    );
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

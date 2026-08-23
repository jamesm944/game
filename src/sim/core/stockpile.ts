/**
 * Per-player stockpile ledger — SPEC §2.6 / M1-T9.
 *
 * Stockpiled amounts live in a `Stockpile` component row, one entity
 * per player, layout `[ownerPlayerId, food, wood, gold, stone, iron,
 * coal, clay]` — amount slot k+1 holds gatherable code k. Self-
 * identifying rows mean no hidden eid↔player registry anywhere.
 *
 * Keeping the ledger inside the component store makes it digest-visible
 * for free (SPEC §7): topbar counts and golden digests read the exact
 * same rows.
 *
 * Deposits happen ONLY inside step() — the gather system calls
 * `depositIntoStockpile` while advancing Deliver activities — so every
 * mutation is a deterministic replay event. Render/UI code reads via
 * `stockpileSnapshot` after stepping and never writes.
 */

import {
  RESOURCE_COUNT,
  requireResourceCode,
  type EconomyComponents,
} from "../components/economy";
import { spawnEntity, type ComponentRows, type World } from "./world";

export const STOCKPILE = "Stockpile" as const;
export const DROP_OFF = "DropOff" as const;

/**
 * M1 has exactly one player; ids stay explicit so M2 can add the AI
 * opponent without reshaping rows or commands.
 */
export const PLAYER_ONE = 0;

function requireComponentRows(
  world: World,
  componentId: number,
): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** Row arity per stockpile component — pinned for digest stability. */
export const STOCKPILE_COMPONENT_ARITIES: readonly [string, number][] = [
  [DROP_OFF, 1],
  [STOCKPILE, RESOURCE_COUNT + 1],
];

export interface StockpileComponents {
  readonly dropoffId: number;
  readonly stockpileId: number;
}

function requireOwnerRow(
  world: World,
  comps: Pick<StockpileComponents, "stockpileId">,
  playerId: number,
): number[] {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `player id must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  const rows = requireComponentRows(world, comps.stockpileId);
  // Few players exist, so a linear scan per access is nothing.
  for (const row of rows.values()) {
    if (row[0] === playerId) return row;
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

/**
 * Spawn one player's stockpile entity holding an amount slot per
 * gatherable resource. `initialAmounts` seeds starting resources
 * (indexed by resource code) — how scenarios and golden fixtures grant
 * opening capital; production worlds omit it for a zeroed ledger.
 * Returns its entity id.
 */
export function createPlayerStockpile(
  world: World,
  comps: Pick<StockpileComponents, "stockpileId">,
  playerId: number = PLAYER_ONE,
  initialAmounts?: readonly number[] | undefined,
): number {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `player id must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  if (initialAmounts !== undefined) {
    if (initialAmounts.length !== RESOURCE_COUNT) {
      throw new Error(
        `initial amounts must hold exactly ${String(RESOURCE_COUNT)} entries, got ${String(initialAmounts.length)}`,
      );
    }
    for (const amount of initialAmounts) {
      if (!Number.isInteger(amount) || amount < 0) {
        throw new Error(
          `initial amounts must be non-negative integers, got ${String(amount)}`,
        );
      }
    }
  }
  const eid = spawnEntity(world);
  const row = [
    playerId,
    ...(initialAmounts ?? new Array<number>(RESOURCE_COUNT).fill(0)),
  ];
  requireComponentRows(world, comps.stockpileId).set(eid, row);
  return eid;
}

/**
 * Spawn one drop-off point owned by `playerId`. Its Position row gives
 * travel legs their target; workers deposit into the owner's pool.
 */
export function createDropOffPoint(
  world: World,
  comps: StockpileComponents & { positionId: number },
  x: number,
  y: number,
  playerId: number = PLAYER_ONE,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `drop-off point needs finite coordinates, got (${String(x)}, ${String(y)})`,
    );
  }
  const eid = spawnEntity(world);
  requireComponentRows(world, comps.positionId).set(eid, [x, y]);
  requireComponentRows(world, comps.dropoffId).set(eid, [playerId]);
  return eid;
}

/** Owning player of a drop-off entity, or undefined when not one. */
export function dropOffOwnerOf(
  world: World,
  comps: Pick<StockpileComponents, "dropoffId">,
  dropoffEid: number,
): number | undefined {
  const row = requireComponentRows(world, comps.dropoffId).get(dropoffEid);
  return row ? row[0]! : undefined;
}

/** Credit `amount` of one resource to the owning player's stockpile. */
export function depositIntoStockpile(
  world: World,
  comps: EconomyComponents & StockpileComponents,
  playerId: number,
  resourceCode: number,
  amount: number,
): void {
  requireResourceCode(resourceCode);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `deposit amount must be a positive integer, got ${String(amount)}`,
    );
  }
  const row = requireOwnerRow(world, comps, playerId);
  row[resourceCode + 1]! += amount;
}

/** Read-only copy of one player's amounts indexed by resource code. */
export function stockpileAmountsOf(
  world: World,
  comps: Pick<StockpileComponents, "stockpileId">,
  playerId: number,
): readonly number[] {
  return requireOwnerRow(world, comps, playerId).slice(1);
}

/** Total stockpiled across every player for one resource code. */
export function totalStockpiled(
  world: World,
  comps: Pick<StockpileComponents, "stockpileId">,
  resourceCode: number,
): number {
  requireResourceCode(resourceCode);
  let total = 0;
  for (const row of requireComponentRows(world, comps.stockpileId).values()) {
    total += row[resourceCode + 1]!;
  }
  return total;
}

/**
 * Snapshot every player's amounts for UI polling (topbar reads this
 * once per rendered frame), keyed by stockpile entity id.
 */
export function stockpileSnapshot(
  world: World,
  comps: Pick<StockpileComponents, "stockpileId">,
): ReadonlyMap<number, readonly number[]> {
  const snapshot = new Map<number, readonly number[]>();
  for (const [eid, row] of requireComponentRows(world, comps.stockpileId)) {
    snapshot.set(eid, row.slice(1));
  }
  return snapshot;
}

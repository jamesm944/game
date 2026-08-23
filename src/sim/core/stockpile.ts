/**
 * Per-player stockpile ledger — SPEC §2.6 / M1-T9, drop-off filters
 * M2-T2, commodity ledger M2-T3.
 *
 * Stockpiled amounts live in a `Stockpile` component row, one entity
 * per player, layout `[ownerPlayerId, food, wood, gold, stone, iron,
 * coal, clay]` — amount slot k+1 holds gatherable code k. Crafted
 * commodities (SPEC §2.6 depth-1 table) stockpile ALONGSIDE resources
 * in a sibling `CommodityStockpile` row on the SAME player entity:
 * `[ownerPlayerId, planks, bricks, tools, weapons, armor, meals]`.
 * Self-identifying rows mean no hidden eid↔player registry anywhere.
 *
 * Drop-off points carry `[ownerPlayerId, acceptedResourceMask]`: bit k
 * of the mask set means gatherable code k may deposit here (the
 * per-building `dropoffFilters` lists of SPEC §2.6, resolved into rows
 * at completion so the gather system never consults definitions on its
 * hot path and saves stay self-describing). Stamping a mask keeps the
 * acceptance decision digest-visible state, not hidden config.
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
  RESOURCE_NAMES,
  requireResourceCode,
  type EconomyComponents,
} from "../components/economy";
import { COMMODITY_SLUGS, RESOURCE_SLUGS } from "../../data/schema";
import { spawnEntity, type ComponentRows, type World } from "./world";

export const STOCKPILE = "Stockpile" as const;
export const COMMODITY_STOCKPILE = "CommodityStockpile" as const;
export const DROP_OFF = "DropOff" as const;

/**
 * Commodity codes — stable u8 enum values baked into rows, never
 * reordered. Order mirrors COMMODITY_SLUGS in data/schema.ts (SPEC
 * §2.6 depth-1 table: planks bricks tools weapons armor meals).
 */
export const COMMODITY_PLANKS = 0;
export const COMMODITY_BRICKS = 1;
export const COMMODITY_TOOLS = 2;
export const COMMODITY_WEAPONS = 3;
export const COMMODITY_ARMOR = 4;
export const COMMODITY_MEALS = 5;
/** Active commodity count (the full §2.6 depth-1 set). */
export const COMMODITY_COUNT = 6;

/** Human-readable commodity names indexed by commodity code. */
export const COMMODITY_NAMES: readonly string[] = [
  "planks",
  "bricks",
  "tools",
  "weapons",
  "armor",
  "meals",
];

/** Commodity slug → stable code (order IS the code order). */
export function commodityCodeOfSlug(slug: string): number {
  const index = COMMODITY_SLUGS.indexOf(
    slug as (typeof COMMODITY_SLUGS)[number],
  );
  if (index < 0) {
    throw new Error(`unknown commodity slug: ${JSON.stringify(slug)}`);
  }
  return index;
}

export function requireCommodityCode(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code >= COMMODITY_COUNT) {
    throw new Error(`unknown commodity code: ${String(code)}`);
  }
  return code;
}

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
  [COMMODITY_STOCKPILE, COMMODITY_COUNT + 1],
  [DROP_OFF, 2],
  [STOCKPILE, RESOURCE_COUNT + 1],
];

/**
 * Bitmask accepting every active gatherable code (SPEC §2.6, seven
 * slugs) — the default for raw drop-off points that declare no filter
 * list.
 */
export const ALL_RESOURCES_MASK = (1 << RESOURCE_COUNT) - 1;

/**
 * Resolve accepted resource codes into a row mask: bit k set = gatherable
 * code k deposits here. Every code is validated loudly; an empty list
 * yields a mask that accepts nothing (a legal but useless drop-off).
 */
export function acceptedResourceMask(codes: readonly number[]): number {
  let mask = 0;
  for (const code of codes) {
    requireResourceCode(code);
    mask |= 1 << code;
  }
  return mask;
}

export interface StockpileComponents {
  readonly commodityStockpileId: number;
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
 * `acceptedCodes` restricts which gatherable slugs may deposit here
 * (SPEC §2.6 filter lists); omitting it accepts every active resource —
 * the raw M1-style depot behavior.
 */
export function createDropOffPoint(
  world: World,
  comps: StockpileComponents & { positionId: number },
  x: number,
  y: number,
  playerId: number = PLAYER_ONE,
  acceptedCodes?: readonly number[] | undefined,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `drop-off point needs finite coordinates, got (${String(x)}, ${String(y)})`,
    );
  }
  const eid = spawnEntity(world);
  requireComponentRows(world, comps.positionId).set(eid, [x, y]);
  requireComponentRows(world, comps.dropoffId).set(eid, [
    playerId,
    acceptedCodes === undefined
      ? ALL_RESOURCES_MASK
      : acceptedResourceMask(acceptedCodes),
  ]);
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

/**
 * True when the drop-off entity exists AND its filter mask admits
 * `resourceCode`. The gather system consults this both when CHOOSING a
 * deposit target (cheapest accepting point) and again at the deposit
 * event itself, so a rejected resource is never credited.
 */
export function dropOffAccepts(
  world: World,
  comps: Pick<StockpileComponents, "dropoffId">,
  dropoffEid: number,
  resourceCode: number,
): boolean {
  const row = requireComponentRows(world, comps.dropoffId).get(dropoffEid);
  if (!row) return false;
  requireResourceCode(resourceCode);
  return (row[1]! & (1 << resourceCode)) !== 0;
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

// ---- Commodity ledger (M2-T3, SPEC §2.6 depth-1 table) -----------------------

function requireCommodityRow(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
): number[] {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `player id must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  const rows = requireComponentRows(world, comps.commodityStockpileId);
  for (const row of rows.values()) {
    if (row[0] === playerId) return row;
  }
  throw new Error(`player ${String(playerId)} has no commodity stockpile`);
}

/**
 * Attach a zeroed CommodityStockpile row to the player's EXISTING
 * stockpile entity — commodities stockpile alongside resources on one
 * ledger entity per player (SPEC §2.6). Throws when no Stockpile row
 * exists yet; call it right after createPlayerStockpile.
 */
export function createCommodityStockpile(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId" | "stockpileId">,
  playerId: number = PLAYER_ONE,
): void {
  const resourceRows = requireComponentRows(world, comps.stockpileId);
  let ownerEid: number | undefined;
  for (const [eid, row] of resourceRows) {
    if (row[0] === playerId) {
      ownerEid = eid;
      break;
    }
  }
  if (ownerEid === undefined) {
    throw new Error(`player ${String(playerId)} has no stockpile entity`);
  }
  requireComponentRows(world, comps.commodityStockpileId).set(ownerEid, [
    playerId,
    ...new Array<number>(COMMODITY_COUNT).fill(0),
  ]);
}

/** Credit `amount` of one commodity to the owning player's ledger. */
export function depositCommodityIntoStockpile(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
  commodityCode: number,
  amount: number,
): void {
  requireCommodityCode(commodityCode);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `commodity deposit amount must be a positive integer, got ${String(amount)}`,
    );
  }
  const row = requireCommodityRow(world, comps, playerId);
  row[commodityCode + 1]! += amount;
}

/** Debit `amount` of one commodity; throws when the ledger runs short. */
export function withdrawCommodityFromStockpile(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
  commodityCode: number,
  amount: number,
): void {
  requireCommodityCode(commodityCode);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `commodity withdraw amount must be a positive integer, got ${String(amount)}`,
    );
  }
  const row = requireCommodityRow(world, comps, playerId);
  const held = row[commodityCode + 1]!;
  if (held < amount) {
    throw new Error(
      `cannot withdraw ${String(amount)} ${COMMODITY_NAMES[commodityCode]}, commodity stockpile holds ${String(held)}`,
    );
  }
  row[commodityCode + 1]! -= amount;
}

/** One player's commodity amounts indexed by commodity code. */
export function commodityAmountsOf(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
): readonly number[] {
  return requireCommodityRow(world, comps, playerId).slice(1);
}

/** One player's held amount of a single commodity code. */
export function commodityAmountOf(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
  commodityCode: number,
): number {
  requireCommodityCode(commodityCode);
  const row = requireCommodityRow(world, comps, playerId);
  return row[commodityCode + 1]!;
}

/**
 * Lenient variant: a player with NO commodity ledger simply holds zero
 * of everything (pre-production worlds, legacy fixtures).
 */
export function commodityAmountOfOrZero(
  world: World,
  comps: Pick<StockpileComponents, "commodityStockpileId">,
  playerId: number,
  commodityCode: number,
): number {
  requireCommodityCode(commodityCode);
  const rows = world.rowsByComponentId.get(comps.commodityStockpileId);
  if (!rows) return 0;
  for (const row of rows.values()) {
    if (row[0] === playerId) return row[commodityCode + 1] ?? 0;
  }
  return 0;
}

/**
 * Held amount for ANY §2.6 slug across both ledgers — gatherables read
 * the resource rows, commodities the sibling commodity rows. UI and
 * production IO use this so callers never branch on slug families.
 */
export function ledgerAmountOfSlug(
  world: World,
  comps: StockpileComponents,
  playerId: number,
  slug: string,
): number {
  const resourceCode = RESOURCE_SLUGS.indexOf(
    slug as (typeof RESOURCE_SLUGS)[number],
  );
  if (resourceCode >= 0) {
    return stockpileAmountsOf(world, comps, playerId)[resourceCode] ?? 0;
  }
  return commodityAmountOf(world, comps, playerId, commodityCodeOfSlug(slug));
}

interface LedgerDebit {
  readonly row: number[];
  readonly index: number;
  readonly qty: number;
  readonly name: string;
}

function resolveLedgerDebits(
  world: World,
  comps: StockpileComponents,
  playerId: number,
  entries: readonly { readonly defId: string; readonly qty: number }[],
): LedgerDebit[] {
  const debits: LedgerDebit[] = [];
  for (const { defId, qty } of entries) {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`ledger debit qty must be a positive integer`);
    }
    const resourceCode = RESOURCE_SLUGS.indexOf(
      defId as (typeof RESOURCE_SLUGS)[number],
    );
    if (resourceCode >= 0) {
      debits.push({
        row: requireOwnerRow(world, comps, playerId),
        index: resourceCode + 1,
        qty,
        name: RESOURCE_NAMES[resourceCode]!,
      });
    } else {
      const code = commodityCodeOfSlug(defId);
      debits.push({
        row: requireCommodityRow(world, comps, playerId),
        index: code + 1,
        qty,
        name: COMMODITY_NAMES[code]!,
      });
    }
  }
  return debits;
}

/** First uncovered entry across both ledgers, or undefined when all fit. */
function resolveLedgerShortfall(
  world: World,
  comps: StockpileComponents,
  playerId: number,
  entries: readonly { readonly defId: string; readonly qty: number }[],
): { qty: number; name: string; held: number } | undefined {
  for (const debit of resolveLedgerDebits(world, comps, playerId, entries)) {
    const held = debit.row[debit.index]!;
    if (held < debit.qty) {
      return { qty: debit.qty, name: debit.name, held };
    }
  }
  return undefined;
}

/**
 * Atomic multi-slug debit across BOTH ledgers: every entry is checked
 * before anything is subtracted, so a short ledger leaves both rows
 * untouched (same conservation discipline as costs.payCosts). Entries
 * take the recipe-IO shape {defId, qty} and may mix gatherables with
 * commodities.
 */
export function debitLedgerSlugs(
  world: World,
  comps: StockpileComponents,
  playerId: number,
  entries: readonly { readonly defId: string; readonly qty: number }[],
  what: string,
): void {
  const failure = resolveLedgerShortfall(world, comps, playerId, entries);
  if (failure !== undefined) {
    throw new Error(
      `cannot afford ${what}: needs ${String(failure.qty)} ${failure.name}, stockpile holds ${String(failure.held)}`,
    );
  }
  for (const debit of resolveLedgerDebits(world, comps, playerId, entries)) {
    debit.row[debit.index]! -= debit.qty;
  }
}

/** True when every entry is covered by the two ledgers. */
export function canDebitLedgerSlugs(
  world: World,
  comps: StockpileComponents,
  playerId: number,
  entries: readonly { readonly defId: string; readonly qty: number }[],
): boolean {
  return resolveLedgerShortfall(world, comps, playerId, entries) === undefined;
}

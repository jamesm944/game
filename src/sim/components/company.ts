/**
 * Company components — SPEC §2.7 / M4-T2 (issue #57).
 *
 * Components register through the world ComponentRegistry alongside the
 * management sets; registration is one strictly alphabetical sequence
 * (components/index.ts defineSimComponents), pinning digest/save order
 * forever (world.ts). The three M4-T2 names slot into that sequence
 * without disturbing any existing neighbor: Body < Branch < Building;
 * CommodityStockpile < Company < DropOff; Traits < TreasuryDelta <
 * VictoryCheck.
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - Branch (2): [companyEid, joinedTick] — attached to a FINISHED
 *   building that a company absorbed as a branch workplace. Row present
 *   ⇔ the building belongs to the company; seizing/dissolving deletes
 *   it (a later ticket). The building side is the natural home: the
 *   output-routing seam reads exactly this row on every credit event.
 * - Company (variable): [ownerPlayerId, focusDomainCode,
 *   treasuryMilli, sharePct, frozenFlag, nameCharCount, char₀, …] —
 *   one row per chartered company on its own entity. The treasury is
 *   VIRTUAL CREDIT in integer thousandths (milli-credits), so every
 *   accrual is exact integer math — platform float drift cannot touch
 *   a golden digest. sharePct is the whole-percent output share each
 *   branch routes to the treasury (default 20). frozenFlag gates the
 *   staffing pass (and later expansion) but never production. The
 *   charter name rides the row as printable-ASCII char codes so the
 *   player-authored label stays digest-visible without a side table.
 * - TreasuryDelta (variable): [entryCount, tick₀, milli₀, tick₁,
 *   milli₁, …] — rolling ledger tail per company, newest entry last,
 *   oldest dropped beyond TREASURY_TAIL_ENTRIES. One entry per tick
 *   with non-zero accrual; the oversight panel reads exactly this row.
 *
 * Market values are pure data here: the documented credits-per-unit
 * table every branch share splits against. Values stay whole credits;
 * with whole-percent shares the milli-credit delta of one output event
 * is exactly qty × value × pct × 10 — no rounding anywhere.
 */

import { requireDomainCode } from "./management";
import type { ComponentRows, World } from "../core/world";

export const BRANCH = "Branch" as const;
export const COMPANY = "Company" as const;
export const TREASURY_DELTA = "TreasuryDelta" as const;

/** Row arity per company component — pinned for digest stability. */
export const BRANCH_ARITY = 2;
/** Variable-length Company row: fixed head + name char codes. */
export const COMPANY_ARITY = -1;
/** Variable-length rolling ledger tail. */
export const TREASURY_DELTA_ARITY = -1;

/** Component ids the company systems read/write. */
export interface CompanyComponents {
  readonly companyId: number;
  readonly branchId: number;
  readonly treasuryDeltaId: number;
}

// ---- Documented tuning constants ---------------------------------------------

/** Charter name bounds — printable ASCII only (row-safe, UI-safe). */
export const COMPANY_NAME_MAX_CHARS = 24;
/**
 * Default branch output share routed to the treasury (SPEC §2.7):
 * configurable per company through setCompanyShare, applied as
 * whole percent.
 */
export const DEFAULT_SHARE_PCT = 20;
/** Rolling ledger tail length per company (entries beyond drop off). */
export const TREASURY_TAIL_ENTRIES = 12;

/**
 * Output market value in whole credits per unit, keyed by §2.6 slug.
 * Gatherables price their raw labor; depth-1 commodities price the
 * chain value-add. Every producible/gatherable slug MUST appear — the
 * routing observer throws loudly on an unknown slug rather than
 * silently dropping treasury income.
 */
export const MARKET_VALUE_PER_UNIT: Readonly<Record<string, number>> = {
  food: 2,
  wood: 1,
  gold: 3,
  stone: 2,
  iron: 4,
  coal: 4,
  clay: 3,
  planks: 5,
  bricks: 8,
  tools: 15,
  weapons: 25,
  armor: 30,
  meals: 10,
};

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Company -------------------------------------------------------------------

export interface CompanyRow {
  readonly ownerPlayerId: number;
  readonly focusDomain: number;
  /** Virtual credit balance in integer milli-credits. */
  readonly treasuryMilli: number;
  /** Whole-percent branch output share (0–100). */
  readonly sharePct: number;
  readonly frozen: boolean;
  /** Decoded charter name. */
  readonly name: string;
}

/**
 * Validate and encode a charter name into row char codes: 1–24
 * printable ASCII characters (codes 32–126).
 */
export function encodeCompanyName(name: string): number[] {
  if (name.length < 1 || name.length > COMPANY_NAME_MAX_CHARS) {
    throw new Error(
      `company name must be 1–${String(COMPANY_NAME_MAX_CHARS)} characters, got ${String(name.length)}`,
    );
  }
  const codes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (!Number.isInteger(code) || code < 32 || code > 126) {
      throw new Error(
        `company name must be printable ASCII (code ${String(code)} at index ${String(i)})`,
      );
    }
    codes.push(code);
  }
  return codes;
}

/** Attach/overwrite the Company row on a freshly chartered entity. */
export function setCompanyRow(
  world: World,
  comps: Pick<CompanyComponents, "companyId">,
  companyEid: number,
  fields: {
    readonly ownerPlayerId: number;
    readonly focusDomain: number;
    readonly sharePct?: number | undefined;
    readonly name: string;
  },
): void {
  const sharePct = fields.sharePct ?? DEFAULT_SHARE_PCT;
  if (!Number.isInteger(sharePct) || sharePct < 0 || sharePct > 100) {
    throw new Error(`company share must be a whole percent 0–100`);
  }
  requireDomainCode(fields.focusDomain);
  const codes = encodeCompanyName(fields.name);
  requireRows(world, comps.companyId).set(companyEid, [
    fields.ownerPlayerId,
    fields.focusDomain,
    0,
    sharePct,
    0,
    codes.length,
    ...codes,
  ]);
}

/** Live Company row fields for one company entity, or undefined. */
export function companyRowOf(
  world: World,
  comps: Pick<CompanyComponents, "companyId">,
  companyEid: number,
): CompanyRow | undefined {
  const row = world.rowsByComponentId.get(comps.companyId)?.get(companyEid);
  if (!row) return undefined;
  const nameLen = row[5] ?? 0;
  let name = "";
  for (let i = 0; i < nameLen; i++) {
    name += String.fromCharCode(row[6 + i] ?? 32);
  }
  return {
    ownerPlayerId: row[0]!,
    focusDomain: row[1]!,
    treasuryMilli: row[2]!,
    sharePct: row[3]!,
    frozen: row[4] === 1,
    name,
  };
}

/** Add integer milli-credits to one company's virtual treasury. */
export function addTreasuryMilli(
  world: World,
  comps: Pick<CompanyComponents, "companyId">,
  companyEid: number,
  milli: number,
): void {
  const row = requireRows(world, comps.companyId).get(companyEid);
  if (!row) throw new Error(`entity ${String(companyEid)} has no Company row`);
  row[2] = row[2]! + milli;
}

/** Overwrite one company's branch output share (whole percent 0–100). */
export function setCompanySharePct(
  world: World,
  comps: Pick<CompanyComponents, "companyId">,
  companyEid: number,
  sharePct: number,
): void {
  if (!Number.isInteger(sharePct) || sharePct < 0 || sharePct > 100) {
    throw new Error(
      `company share must be a whole percent 0–100, got ${String(sharePct)}`,
    );
  }
  const row = requireRows(world, comps.companyId).get(companyEid);
  if (!row) throw new Error(`entity ${String(companyEid)} has no Company row`);
  row[3] = sharePct;
}

/** Set/clear one company's freeze flag. */
export function setCompanyFrozen(
  world: World,
  comps: Pick<CompanyComponents, "companyId">,
  companyEid: number,
  frozen: boolean,
): void {
  const row = requireRows(world, comps.companyId).get(companyEid);
  if (!row) throw new Error(`entity ${String(companyEid)} has no Company row`);
  row[4] = frozen ? 1 : 0;
}

// ---- Branch ----------------------------------------------------------------------

/** Attach/replace the Branch row on a workplace building. */
export function setBranchRow(
  world: World,
  comps: Pick<CompanyComponents, "branchId">,
  buildingEid: number,
  companyEid: number,
  tick: number,
): void {
  requireRows(world, comps.branchId).set(buildingEid, [companyEid, tick]);
}

/** Live Branch row for a building, or undefined when not a branch. */
export function branchRowOf(
  world: World,
  comps: Pick<CompanyComponents, "branchId">,
  buildingEid: number,
): { companyEid: number; joinedTick: number } | undefined {
  const row = world.rowsByComponentId.get(comps.branchId)?.get(buildingEid);
  if (!row) return undefined;
  return { companyEid: row[0]!, joinedTick: row[1]! };
}

export function clearBranchRow(
  world: World,
  comps: Pick<CompanyComponents, "branchId">,
  buildingEid: number,
): boolean {
  return (
    world.rowsByComponentId.get(comps.branchId)?.delete(buildingEid) ?? false
  );
}

// ---- TreasuryDelta -----------------------------------------------------------------

/**
 * Append one ledger entry to a company's rolling tail, dropping the
 * oldest entries beyond TREASURY_TAIL_ENTRIES. `milli` must be a
 * positive integer — zero/no-op ticks never write history.
 */
export function appendTreasuryDelta(
  world: World,
  comps: Pick<CompanyComponents, "treasuryDeltaId">,
  companyEid: number,
  tick: number,
  milli: number,
): void {
  if (!Number.isInteger(milli) || milli <= 0) {
    throw new Error(
      `treasury delta must be a positive integer milli-credit amount, got ${String(milli)}`,
    );
  }
  const row = requireRows(world, comps.treasuryDeltaId).get(companyEid);
  const entry = [tick, milli];
  if (!row) {
    requireRows(world, comps.treasuryDeltaId).set(companyEid, [1, ...entry]);
    return;
  }
  const count = row[0]!;
  row.push(...entry);
  if (count + 1 > TREASURY_TAIL_ENTRIES) {
    // Drop the OLDEST entry (slots 1–2), keeping the newest tail.
    row.splice(1, 2);
  } else {
    row[0] = count + 1;
  }
}

export interface TreasuryDeltaEntry {
  readonly tick: number;
  readonly milli: number;
}

/** Decoded copy of a company's ledger tail, oldest first. */
export function treasuryDeltasOf(
  world: World,
  comps: Pick<CompanyComponents, "treasuryDeltaId">,
  companyEid: number,
): TreasuryDeltaEntry[] {
  const row = world.rowsByComponentId
    .get(comps.treasuryDeltaId)
    ?.get(companyEid);
  if (!row) return [];
  const count = Math.min(row[0] ?? 0, TREASURY_TAIL_ENTRIES);
  const entries: TreasuryDeltaEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({ tick: row[1 + i * 2]!, milli: row[2 + i * 2]! });
  }
  return entries;
}

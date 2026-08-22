/**
 * Definition-cost payment — SPEC §2.6 / M1-T10.
 *
 * Shared by placement (building costs escrowed up front) and training
 * (unit costs debited at enqueue). Payments are ATOMIC: every entry is
 * checked against the owner's stockpile row before ANY subtraction, so
 * a failed payment leaves the ledger untouched — resource conservation
 * (SPEC §7 property tests) is never at risk.
 */

import { RESOURCE_SLUGS } from "../../data/schema";
import { RESOURCE_NAMES, requireResourceCode } from "../components/economy";
import type { World } from "../core/world";

/** Minimal component surface these helpers need. */
export interface CostComponents {
  readonly stockpileId: number;
}

/** Gatherable slug → stable resource code (order IS the code order). */
export function resourceCodeOfSlug(slug: string): number {
  const index = RESOURCE_SLUGS.indexOf(slug as (typeof RESOURCE_SLUGS)[number]);
  if (index < 0) {
    throw new Error(`unknown cost resource slug: ${JSON.stringify(slug)}`);
  }
  return requireResourceCode(index);
}

export interface CostLedger {
  readonly [slug: string]: number;
}

function stockpileRowOf(
  world: World,
  comps: Pick<CostComponents, "stockpileId">,
  playerId: number,
): number[] | undefined {
  const rows = world.rowsByComponentId.get(comps.stockpileId);
  if (!rows) throw new Error("unregistered Stockpile component");
  for (const candidate of rows.values()) {
    if (candidate[0] === playerId) return candidate;
  }
  return undefined;
}

/** True when the player's stockpile covers every nonzero cost entry. */
export function canAffordCosts(
  world: World,
  comps: Pick<CostComponents, "stockpileId">,
  playerId: number,
  costs: CostLedger,
): boolean {
  const row = stockpileRowOf(world, comps, playerId);
  if (!row) return false;
  for (const [slug, amount] of Object.entries(costs)) {
    if (amount <= 0) continue;
    const code = resourceCodeOfSlug(slug);
    if ((row[code + 1] ?? 0) < amount) return false;
  }
  return true;
}

/**
 * Atomically debit every cost entry from the player's stockpile row.
 * Throws (leaving the ledger untouched) when unaffordable; `what`
 * names the purchase in the error message.
 */
export function payCosts(
  world: World,
  comps: Pick<CostComponents, "stockpileId">,
  playerId: number,
  costs: CostLedger,
  what: string,
): void {
  const row = stockpileRowOf(world, comps, playerId);
  if (!row) {
    throw new Error(`player ${String(playerId)} has no stockpile entity`);
  }
  const debits: [number, number][] = [];
  for (const [slug, amount] of Object.entries(costs)) {
    if (amount <= 0) continue;
    const code = resourceCodeOfSlug(slug);
    const held = row[code + 1]!;
    if (held < amount) {
      throw new Error(
        `cannot afford ${what}: needs ${String(amount)} ${RESOURCE_NAMES[code]}, stockpile holds ${String(held)}`,
      );
    }
    debits.push([code, amount]);
  }
  for (const [code, amount] of debits) {
    row[code + 1]! -= amount;
  }
}

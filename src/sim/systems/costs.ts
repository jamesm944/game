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
import { getCivBonuses } from "../core/civilization";
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

/**
 * Calculate the effective costs of a unit, building, or tech for a player
 * taking into account civilization bonuses (e.g. Goths -25% infantry cost,
 * Byzantines -25% counter-unit cost, Britons -50% TC wood, Franks -25% castle stone,
 * Byzantines -33% Imperial Age cost).
 *
 * If no civilizations are configured or no bonuses apply, returns `target.costs` untouched.
 */
export function effectiveCosts(
  world: World,
  playerId: number,
  target: {
    readonly id: string;
    readonly costs: CostLedger;
    readonly armorClasses?: readonly string[] | undefined;
  },
): CostLedger {
  if (!world.civilizations || world.civilizations.size === 0) {
    return target.costs;
  }
  const bonuses = getCivBonuses(world, playerId);
  if (bonuses.length === 0) {
    return target.costs;
  }

  let modified = false;
  const result: Record<string, number> = { ...target.costs };

  for (const bonus of bonuses) {
    let matches = false;
    if (
      bonus.target === `unit:${target.id}` ||
      bonus.target === `building:${target.id}` ||
      bonus.target === `tech:${target.id}`
    ) {
      matches = true;
    } else if (bonus.target.startsWith("class:") && target.armorClasses) {
      const cls = bonus.target.slice("class:".length);
      if (target.armorClasses.includes(cls)) {
        matches = true;
      }
    }
    if (!matches) continue;

    if (bonus.stat === "cost:all") {
      for (const res of Object.keys(result)) {
        const current = result[res]!;
        if (bonus.op === "mult") {
          result[res] = Math.round(current * bonus.value);
          modified = true;
        } else if (bonus.op === "add") {
          result[res] = Math.max(0, current + bonus.value);
          modified = true;
        }
      }
    } else if (bonus.stat.startsWith("cost:")) {
      const res = bonus.stat.slice("cost:".length);
      if (result[res] !== undefined) {
        const current = result[res]!;
        if (bonus.op === "mult") {
          result[res] = Math.round(current * bonus.value);
          modified = true;
        } else if (bonus.op === "add") {
          result[res] = Math.max(0, current + bonus.value);
          modified = true;
        }
      }
    }
  }

  return modified ? result : target.costs;
}

/**
 * Trade route & cart planning — SPEC §2.6 / Content Breadth (V14 / issue #103).
 *
 * Runs inside the AI planner to manage trade routes:
 * 1. Finds own finished markets and known foreign/target markets.
 * 2. Assigns any idle trade carts to trade routes targeting the closest known market.
 * 3. Trains trade carts at own markets up to a cap (default 2)
 *    when population headroom and budget allow.
 */

import { unitDefOf } from "../../data/definitions";
import type { CommandDraft } from "./buildOrder";
import type { AiKnowledge, ResourceBudget } from "./knowledge";

export const MAX_AI_TRADE_CARTS = 2;

export function planTradeRoutes(
  k: AiKnowledge,
  out: CommandDraft[],
  budget?: ResourceBudget,
): void {
  const ownMarkets = k.finishedBuildings("market");
  if (ownMarkets.length === 0) return;

  const targetMarkets = k.knownTargetMarkets();
  if (targetMarkets.length === 0) return;

  const carts = k.tradeCarts();

  // 1. Assign idle trade carts to the nearest target market
  for (const cart of carts) {
    if (k.isTradeCartActive(cart.eid)) continue;

    let bestMarket = targetMarkets[0]!;
    let bestDistSq =
      (cart.tileX - bestMarket.tileX) ** 2 + (cart.tileY - bestMarket.tileY) ** 2;
    for (let i = 1; i < targetMarkets.length; i++) {
      const tm = targetMarkets[i]!;
      const d =
        (cart.tileX - tm.tileX) ** 2 + (cart.tileY - tm.tileY) ** 2;
      if (d < bestDistSq || (d === bestDistSq && tm.eid < bestMarket.eid)) {
        bestDistSq = d;
        bestMarket = tm;
      }
    }

    out.push({
      kind: "assignTradeRoute",
      data: {
        cartId: cart.eid,
        targetMarketId: bestMarket.eid,
      },
    });
  }

  // 2. Train trade carts up to MAX_AI_TRADE_CARTS if affordable & pop allows
  if (carts.length < MAX_AI_TRADE_CARTS && k.population() < k.populationCap()) {
    const cartDef = unitDefOf("trade-cart");
    const affordable =
      budget !== undefined
        ? budget.afford(cartDef.costs)
        : k.canAfford(cartDef.costs);
    if (affordable) {
      for (const marketEid of ownMarkets) {
        if (!k.canTrain(marketEid, "trade-cart")) continue;
        if (budget !== undefined) budget.debit(cartDef.costs);
        out.push({
          kind: "trainUnit",
          data: {
            siteEid: marketEid,
            unitId: "trade-cart",
            purpose: "trade",
          },
        });
        break;
      }
    }
  }
}

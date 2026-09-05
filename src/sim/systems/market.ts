/**
 * Market & Trade System — SPEC §2.6 / Content Breadth (V9 / issue #80).
 *
 * Implements:
 * 1. Commodity exchange commands (`marketExchange`):
 *    - buy: exchange gold for wood, food, or stone
 *    - sell: exchange wood, food, or stone for gold
 *    - rate model: 100 goods sell for 70g; 100 goods buy for 130g
 *    - requires player to own at least one finished Market
 * 2. Trade route commands (`tradeRoute`):
 *    - target Market selected for a Trade Cart
 *    - Cart travels between origin and target Markets
 *    - Upon arrival at target Market, picks up gold based on distance:
 *      gold = max(5, floor(distance / 2))
 *    - Cart travels back to origin Market and deposits gold into player's stockpile
 */

import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import {
  RESOURCE_FOOD,
  RESOURCE_WOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
} from "../components/economy";
import type { SimCommand } from "../core/inbox";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

export const MARKET_EXCHANGE_COMMAND_KIND = "marketExchange";
export const TRADE_ROUTE_COMMAND_KIND = "tradeRoute";

export interface MarketSystemOptions {
  readonly comps: SimComponents;
}

export interface ActiveTradeRoute {
  unitEid: number;
  originMarketEid: number;
  targetMarketEid: number;
  state: "to_target" | "to_origin";
  carriedGold: number;
}

function stockpileRowOf(
  world: World,
  stockpileId: number,
  playerId: number,
): number[] | undefined {
  const rows = world.rowsByComponentId.get(stockpileId);
  if (!rows) return undefined;
  for (const candidate of rows.values()) {
    if (candidate[0] === playerId) return candidate;
  }
  return undefined;
}

export function playerHasFinishedMarket(
  world: World,
  comps: SimComponents,
  playerId: number,
): boolean {
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  if (!buildingRows) return false;
  for (const [eid, row] of buildingRows) {
    if (row[0] === playerId) {
      const bDef = buildingDefOf(buildingIdOfCode(row[1]!));
      if (bDef.id === "market") {
        const siteRow = world.rowsByComponentId
          .get(comps.buildingSiteId)
          ?.get(eid);
        if (!siteRow) {
          return true;
        }
      }
    }
  }
  return false;
}

export function executeMarketExchange(
  world: World,
  comps: SimComponents,
  playerId: number,
  action: "buy" | "sell",
  resource: "wood" | "food" | "stone",
  amount: number = 100,
): { success: boolean; error?: string } {
  if (!playerHasFinishedMarket(world, comps, playerId)) {
    return { success: false, error: "Market required to trade commodities" };
  }

  const stockpile = stockpileRowOf(world, comps.stockpileId, playerId);
  if (!stockpile) {
    return {
      success: false,
      error: `Stockpile not found for player ${playerId}`,
    };
  }

  let resCode = RESOURCE_FOOD;
  if (resource === "wood") resCode = RESOURCE_WOOD;
  else if (resource === "stone") resCode = RESOURCE_STONE;

  const lots = Math.max(1, Math.floor(amount / 100));
  const goodsAmount = lots * 100;
  const sellGold = lots * 70;
  const buyGold = lots * 130;

  if (action === "sell") {
    const held = stockpile[resCode + 1] ?? 0;
    if (held < goodsAmount) {
      return {
        success: false,
        error: `Insufficient ${resource}: needs ${goodsAmount}, has ${held}`,
      };
    }
    stockpile[resCode + 1]! -= goodsAmount;
    stockpile[RESOURCE_GOLD + 1]! += sellGold;
    return { success: true };
  } else {
    // buy
    const goldHeld = stockpile[RESOURCE_GOLD + 1] ?? 0;
    if (goldHeld < buyGold) {
      return {
        success: false,
        error: `Insufficient gold: needs ${buyGold}, has ${goldHeld}`,
      };
    }
    stockpile[RESOURCE_GOLD + 1]! -= buyGold;
    stockpile[resCode + 1]! += goodsAmount;
    return { success: true };
  }
}

export function createMarketSystem(options: MarketSystemOptions): SimSystem {
  const { comps } = options;
  const activeRoutes = new Map<number, ActiveTradeRoute>();

  return function marketSystem(
    world: World,
    commands: readonly SimCommand[],
  ): void {
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const moveTargetRows = world.rowsByComponentId.get(comps.moveTargetId);
    const ownerRows = world.rowsByComponentId.get(comps.ownerId);

    // 1. Process Inbox Commands
    for (const cmd of commands) {
      if (cmd.kind === MARKET_EXCHANGE_COMMAND_KIND && cmd.data) {
        const data = cmd.data as {
          playerId?: number;
          action?: "buy" | "sell";
          resource?: "wood" | "food" | "stone";
          amount?: number;
        };
        if (
          typeof data.playerId === "number" &&
          (data.action === "buy" || data.action === "sell") &&
          (data.resource === "wood" ||
            data.resource === "food" ||
            data.resource === "stone")
        ) {
          executeMarketExchange(
            world,
            comps,
            data.playerId,
            data.action,
            data.resource,
            data.amount ?? 100,
          );
        }
      } else if (cmd.kind === TRADE_ROUTE_COMMAND_KIND && cmd.data) {
        const data = cmd.data as { unitEid?: number; targetMarketEid?: number };
        if (
          typeof data.unitEid === "number" &&
          typeof data.targetMarketEid === "number" &&
          posRows?.has(data.unitEid) &&
          posRows?.has(data.targetMarketEid)
        ) {
          let ownerId = ownerRows?.get(data.unitEid)?.[0];
          if (ownerId === undefined) {
            ownerId = world.rowsByComponentId
              .get(comps.combatId)
              ?.get(data.unitEid)?.[1];
          }
          if (ownerId === undefined) ownerId = 0;

          // Find closest finished own Market as origin
          let bestOriginEid: number | undefined;
          let bestOriginDistSq = Infinity;
          const cartPos = posRows.get(data.unitEid)!;

          const buildingRows = world.rowsByComponentId.get(comps.buildingId);
          if (buildingRows) {
            for (const [bEid, bRow] of buildingRows) {
              if (bRow[0] === ownerId && bEid !== data.targetMarketEid) {
                const bDef = buildingDefOf(buildingIdOfCode(bRow[1]!));
                if (bDef.id === "market") {
                  const siteRow = world.rowsByComponentId
                    .get(comps.buildingSiteId)
                    ?.get(bEid);
                  if (!siteRow) {
                    const mPos = posRows.get(bEid);
                    if (mPos) {
                      const dSq =
                        (mPos[0]! - cartPos[0]!) ** 2 +
                        (mPos[1]! - cartPos[1]!) ** 2;
                      if (dSq < bestOriginDistSq) {
                        bestOriginDistSq = dSq;
                        bestOriginEid = bEid;
                      }
                    }
                  }
                }
              }
            }
          }

          if (bestOriginEid !== undefined) {
            activeRoutes.set(data.unitEid, {
              unitEid: data.unitEid,
              originMarketEid: bestOriginEid,
              targetMarketEid: data.targetMarketEid,
              state: "to_target",
              carriedGold: 0,
            });

            const targetPos = posRows.get(data.targetMarketEid);
            if (targetPos && moveTargetRows) {
              moveTargetRows.set(data.unitEid, [targetPos[0]!, targetPos[1]!]);
            }
          }
        }
      }
    }

    // 2. Advance Active Trade Routes
    if (activeRoutes.size === 0 || !posRows || !moveTargetRows) return;

    for (const [unitEid, route] of activeRoutes) {
      const cartPos = posRows.get(unitEid);
      const originPos = posRows.get(route.originMarketEid);
      const targetPos = posRows.get(route.targetMarketEid);

      if (!cartPos || !originPos || !targetPos) {
        activeRoutes.delete(unitEid);
        continue;
      }

      const targetCenterX = targetPos[0]!;
      const targetCenterY = targetPos[1]!;
      const originCenterX = originPos[0]!;
      const originCenterY = originPos[1]!;

      if (route.state === "to_target") {
        const distSq =
          (cartPos[0]! - targetCenterX) ** 2 +
          (cartPos[1]! - targetCenterY) ** 2;
        if (distSq <= 3.5 * 3.5) {
          // Arrived at target market -> load gold cargo based on distance
          const marketDist = Math.hypot(
            originCenterX - targetCenterX,
            originCenterY - targetCenterY,
          );
          route.carriedGold = Math.max(5, Math.floor(marketDist * 0.5));
          route.state = "to_origin";
          moveTargetRows.set(unitEid, [originCenterX, originCenterY]);
        }
      } else if (route.state === "to_origin") {
        const distSq =
          (cartPos[0]! - originCenterX) ** 2 +
          (cartPos[1]! - originCenterY) ** 2;
        if (distSq <= 3.5 * 3.5) {
          // Arrived home -> deposit gold
          let ownerId = ownerRows?.get(unitEid)?.[0];
          if (ownerId === undefined) {
            ownerId = world.rowsByComponentId
              .get(comps.combatId)
              ?.get(unitEid)?.[1];
          }
          if (ownerId === undefined) ownerId = 0;
          const stockpile = stockpileRowOf(world, comps.stockpileId, ownerId);
          if (stockpile && route.carriedGold > 0) {
            stockpile[RESOURCE_GOLD + 1]! += route.carriedGold;
          }
          route.carriedGold = 0;
          route.state = "to_target";
          moveTargetRows.set(unitEid, [targetCenterX, targetCenterY]);
        }
      }
    }
  };
}

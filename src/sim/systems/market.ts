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
export const ASSIGN_TRADE_ROUTE_COMMAND_KIND = "assignTradeRoute";

export const DEFAULT_TRADE_WAIT_TICKS = 15;

export type TradeRouteState = "to_target" | "loading" | "to_origin" | "unloading";

export interface ActiveTradeRoute {
  unitEid: number;
  originMarketEid: number;
  targetMarketEid: number;
  state: TradeRouteState;
  carriedGold: number;
  waitTicks: number;
}

export interface MarketSystemOptions {
  readonly comps: SimComponents;
  readonly tradeWaitTicks?: number;
}

const WORLD_ACTIVE_ROUTES = new WeakMap<World, Map<number, ActiveTradeRoute>>();

export function getActiveTradeRoutes(world: World): Map<number, ActiveTradeRoute> {
  let routes = WORLD_ACTIVE_ROUTES.get(world);
  if (!routes) {
    routes = new Map();
    WORLD_ACTIVE_ROUTES.set(world, routes);
  }
  return routes;
}

export function activeTradeCartsCountForMarket(
  world: World,
  marketEid: number,
): number {
  const routes = getActiveTradeRoutes(world);
  let count = 0;
  for (const route of routes.values()) {
    if (route.originMarketEid === marketEid || route.targetMarketEid === marketEid) {
      count++;
    }
  }
  return count;
}

export function activeTradeRoutesCountForPlayer(
  world: World,
  comps: SimComponents,
  playerId: number,
): number {
  const routes = getActiveTradeRoutes(world);
  let count = 0;
  const ownerRows = world.rowsByComponentId.get(comps.ownerId);
  for (const route of routes.values()) {
    let owner = ownerRows?.get(route.unitEid)?.[0];
    if (owner === undefined) {
      owner = world.rowsByComponentId.get(comps.combatId)?.get(route.unitEid)?.[1];
    }
    if (owner === undefined) owner = 0;
    if (owner === playerId) count++;
  }
  return count;
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
  const { comps, tradeWaitTicks = 0 } = options;

  return function marketSystem(
    world: World,
    commands: readonly SimCommand[],
  ): void {
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const moveTargetRows = world.rowsByComponentId.get(comps.moveTargetId);
    const ownerRows = world.rowsByComponentId.get(comps.ownerId);
    const buildingRows = world.rowsByComponentId.get(comps.buildingId);
    const activeRoutes = getActiveTradeRoutes(world);

    // Helper to issue movement to target coordinates (A* pathfinding + direct target)
    const dispatchMove = (unitEid: number, destX: number, destY: number): void => {
      moveTargetRows?.set(unitEid, [destX, destY]);
      world.inbox.submit({
        kind: "groupMove",
        targetTick: world.tick + 1,
        data: { entityIds: [unitEid], x: destX, y: destY },
      });
    };

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
      } else if (
        (cmd.kind === TRADE_ROUTE_COMMAND_KIND ||
          cmd.kind === ASSIGN_TRADE_ROUTE_COMMAND_KIND) &&
        cmd.data
      ) {
        const data = cmd.data as {
          unitEid?: number;
          cartId?: number;
          targetMarketEid?: number;
          targetMarketId?: number;
        };
        const unitEid = data.cartId ?? data.unitEid;
        const targetMarketEid = data.targetMarketId ?? data.targetMarketEid;

        if (
          typeof unitEid === "number" &&
          typeof targetMarketEid === "number" &&
          posRows?.has(unitEid) &&
          posRows?.has(targetMarketEid)
        ) {
          let ownerId = ownerRows?.get(unitEid)?.[0];
          if (ownerId === undefined) {
            ownerId = world.rowsByComponentId
              .get(comps.combatId)
              ?.get(unitEid)?.[1];
          }
          if (ownerId === undefined) ownerId = 0;

          // Find closest finished own Market as origin
          let bestOriginEid: number | undefined;
          let bestOriginDistSq = Infinity;
          const cartPos = posRows.get(unitEid)!;

          if (buildingRows) {
            for (const [bEid, bRow] of buildingRows) {
              if (bRow[0] === ownerId && bEid !== targetMarketEid) {
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
            activeRoutes.set(unitEid, {
              unitEid,
              originMarketEid: bestOriginEid,
              targetMarketEid,
              state: "to_target",
              carriedGold: 0,
              waitTicks: 0,
            });

            const targetPos = posRows.get(targetMarketEid);
            if (targetPos) {
              dispatchMove(unitEid, targetPos[0]!, targetPos[1]!);
            }
          }
        }
      }
    }

    // 2. Advance Active Trade Routes
    if (activeRoutes.size === 0 || !posRows) return;

    for (const [unitEid, route] of activeRoutes) {
      // Validate entity vitality
      if (!world.entities.includes(unitEid)) {
        activeRoutes.delete(unitEid);
        continue;
      }
      if (
        !world.entities.includes(route.originMarketEid) ||
        !world.entities.includes(route.targetMarketEid)
      ) {
        activeRoutes.delete(unitEid);
        continue;
      }

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
          // Arrived at target market -> calculate gold cargo based on distance and rate
          const marketDist = Math.hypot(
            originCenterX - targetCenterX,
            originCenterY - targetCenterY,
          );
          const targetRow = buildingRows?.get(route.targetMarketEid);
          let tradeRate = 0.5;
          if (targetRow) {
            const bDef = buildingDefOf(buildingIdOfCode(targetRow[1]!));
            if (bDef.tradeRate !== undefined) tradeRate = bDef.tradeRate;
          }
          route.carriedGold = Math.max(5, Math.floor(marketDist * tradeRate));

          if (tradeWaitTicks > 0) {
            route.state = "loading";
            route.waitTicks = tradeWaitTicks;
          } else {
            route.state = "to_origin";
            dispatchMove(unitEid, originCenterX, originCenterY);
          }
        }
      } else if (route.state === "loading") {
        route.waitTicks--;
        if (route.waitTicks <= 0) {
          route.state = "to_origin";
          dispatchMove(unitEid, originCenterX, originCenterY);
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

          if (tradeWaitTicks > 0) {
            route.state = "unloading";
            route.waitTicks = tradeWaitTicks;
          } else {
            route.state = "to_target";
            dispatchMove(unitEid, targetCenterX, targetCenterY);
          }
        }
      } else if (route.state === "unloading") {
        route.waitTicks--;
        if (route.waitTicks <= 0) {
          route.state = "to_target";
          dispatchMove(unitEid, targetCenterX, targetCenterY);
        }
      }
    }
  };
}

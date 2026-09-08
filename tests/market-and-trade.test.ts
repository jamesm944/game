import { describe, expect, it } from "vitest";
import { buildingDefOf, unitDefOf } from "../src/data/definitions";
import {
  activeTradeCartsCountForMarket,
  ASSIGN_TRADE_ROUTE_COMMAND_KIND,
  createMarketSystem,
  executeMarketExchange,
  getActiveTradeRoutes,
  MARKET_EXCHANGE_COMMAND_KIND,
  playerHasFinishedMarket,
  TRADE_ROUTE_COMMAND_KIND,
} from "../src/sim/systems/market";
import { planTradeRoutes } from "../src/sim/ai/tradeManager";
import { createResourceBudget, type AiKnowledge } from "../src/sim/ai/knowledge";
import type { CommandDraft } from "../src/sim/ai/buildOrder";
import {
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../src/sim/components/economy";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { spawnCombatUnit } from "../src/sim/components/combat";
import {
  createWorld,
  despawnEntity,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { formatMarketSummary } from "../src/ui/buildingPanel";
import { defineSimComponents, type SimComponents } from "../src/sim/components";
import { createPlayerStockpile } from "../src/sim/core/stockpile";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { createPlacementSystem } from "../src/sim/systems/placement";

const SIZE = 48;
const PLAYER_ONE = 0;
const PLAYER_TWO = 1;

interface Harness {
  world: World;
  comps: SimComponents;
}

function createHarness(): Harness {
  const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
  const world = createWorld(20260824, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createMarketSystem({ comps }));

  // Seed stockpiles: [food, wood, gold, stone, iron, coal, clay]
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [500, 500, 500, 500, 0, 0, 0],
  );
  createPlayerStockpile(
    world,
    comps,
    PLAYER_TWO,
    [500, 500, 500, 500, 0, 0, 0],
  );

  return { world, comps };
}

describe("V9: Market & Trade Carts (Issue #80)", () => {
  it("market and trade-cart definitions exist with correct attributes", () => {
    const market = buildingDefOf("market");
    expect(market.id).toBe("market");
    expect(market.footprint).toEqual({ width: 4, height: 4 });
    expect(market.ageGate).toBe("feudal");
    expect(market.hp).toBe(1800);
    expect(market.costs).toEqual({ wood: 175 });
    expect(market.trainQueue?.trainable.map((t) => t.unitId)).toContain(
      "trade-cart",
    );

    const cart = unitDefOf("trade-cart");
    expect(cart.id).toBe("trade-cart");
    expect(cart.hp).toBe(70);
    expect(cart.speed).toBe(1.0);
    expect(cart.costs).toEqual({ wood: 100, gold: 50 });
  });

  it("commodity exchange requires a finished market", () => {
    const { world, comps } = createHarness();

    // Initially no market -> exchange fails
    expect(playerHasFinishedMarket(world, comps, PLAYER_ONE)).toBe(false);
    const result = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "sell",
      "wood",
      100,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Market required");

    // Stamp a finished market for player
    stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    expect(playerHasFinishedMarket(world, comps, PLAYER_ONE)).toBe(true);
  });

  it("buys and sells resources at pinned rates (sell 100 -> +70g, buy 100 -> -130g)", () => {
    const { world, comps } = createHarness();

    stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });

    const stockpileRow = [
      ...world.rowsByComponentId.get(comps.stockpileId)!.values(),
    ].find((r) => r[0] === PLAYER_ONE)!;

    // Initial stockpile: 500 food, 500 wood, 500 gold, 500 stone

    // 1. Sell 100 wood -> 400 wood, 570 gold
    const sellWood = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "sell",
      "wood",
      100,
    );
    expect(sellWood.success).toBe(true);
    expect(stockpileRow[RESOURCE_WOOD + 1]).toBe(400);
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(570);

    // 2. Sell 200 food -> 300 food, 570 + 140 = 710 gold
    const sellFood = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "sell",
      "food",
      200,
    );
    expect(sellFood.success).toBe(true);
    expect(stockpileRow[RESOURCE_FOOD + 1]).toBe(300);
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(710);

    // 3. Sell 100 stone -> 400 stone, 710 + 70 = 780 gold
    const sellStone = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "sell",
      "stone",
      100,
    );
    expect(sellStone.success).toBe(true);
    expect(stockpileRow[RESOURCE_STONE + 1]).toBe(400);
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(780);

    // 4. Buy 100 wood -> 500 wood, 780 - 130 = 650 gold
    const buyWood = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "buy",
      "wood",
      100,
    );
    expect(buyWood.success).toBe(true);
    expect(stockpileRow[RESOURCE_WOOD + 1]).toBe(500);
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(650);

    // 5. Unaffordable buy rejected cleanly
    stockpileRow[RESOURCE_GOLD + 1] = 50;
    const failBuy = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "buy",
      "wood",
      100,
    );
    expect(failBuy.success).toBe(false);
    expect(failBuy.error).toContain("Insufficient gold");
    expect(stockpileRow[RESOURCE_WOOD + 1]).toBe(500); // untouched

    // 6. Unaffordable sell rejected cleanly
    stockpileRow[RESOURCE_STONE + 1] = 50;
    const failSell = executeMarketExchange(
      world,
      comps,
      PLAYER_ONE,
      "sell",
      "stone",
      100,
    );
    expect(failSell.success).toBe(false);
    expect(failSell.error).toContain("Insufficient stone");
    expect(stockpileRow[RESOURCE_STONE + 1]).toBe(50); // untouched
  });

  it("processes marketExchange command through world inbox", () => {
    const { world, comps } = createHarness();

    stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });

    const stockpileRow = [
      ...world.rowsByComponentId.get(comps.stockpileId)!.values(),
    ].find((r) => r[0] === PLAYER_ONE)!;
    stockpileRow[RESOURCE_WOOD + 1] = 300;
    stockpileRow[RESOURCE_GOLD + 1] = 100;

    // Submit marketExchange command for tick 1
    world.inbox.submit({
      kind: MARKET_EXCHANGE_COMMAND_KIND,
      targetTick: 1,
      data: {
        playerId: PLAYER_ONE,
        action: "sell",
        resource: "wood",
        amount: 100,
      },
    });

    step(world);

    expect(stockpileRow[RESOURCE_WOOD + 1]).toBe(200);
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(170);
  });

  it("trade carts navigate trade routes between markets and generate gold", () => {
    const { world, comps } = createHarness();

    // Create home market at (10, 10)
    stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    // Create foreign market at (30, 10) - distance is 20 tiles
    const targetMarketEid = stampFinishedBuilding(
      world,
      comps,
      "market",
      30,
      10,
      {
        playerId: PLAYER_TWO,
      },
    );

    // Spawn trade cart next to home market
    const cartEid = spawnCombatUnit(
      world,
      comps,
      "trade-cart",
      15,
      12,
      PLAYER_ONE,
    );

    const stockpileRow = [
      ...world.rowsByComponentId.get(comps.stockpileId)!.values(),
    ].find((r) => r[0] === PLAYER_ONE)!;
    const initialGold = stockpileRow[RESOURCE_GOLD + 1] ?? 0;

    // Start trade route
    world.inbox.submit({
      kind: TRADE_ROUTE_COMMAND_KIND,
      targetTick: 1,
      data: {
        unitEid: cartEid,
        targetMarketEid: targetMarketEid,
      },
    });

    // Step world to process command
    step(world);

    const posRows = world.rowsByComponentId.get(comps.positionId)!;

    // Move cart near target market
    posRows.set(cartEid, [31, 12]);
    step(world); // cart reaches target market, loads gold (distance ~ 20 tiles -> 10 gold)

    // Move cart back near home market
    posRows.set(cartEid, [12, 12]);
    step(world); // cart deposits gold at home market

    const finalGold = stockpileRow[RESOURCE_GOLD + 1]!;
    expect(finalGold).toBeGreaterThan(initialGold);
    expect(finalGold - initialGold).toBe(10); // floor(20 * 0.5) = 10
  });

  it("supports assignTradeRoute command with { cartId, targetMarketId } syntax", () => {
    const { world, comps } = createHarness();

    stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    const targetMarketEid = stampFinishedBuilding(
      world,
      comps,
      "market",
      30,
      10,
      { playerId: PLAYER_TWO },
    );

    const cartEid = spawnCombatUnit(
      world,
      comps,
      "trade-cart",
      15,
      12,
      PLAYER_ONE,
    );

    world.inbox.submit({
      kind: ASSIGN_TRADE_ROUTE_COMMAND_KIND,
      targetTick: 1,
      data: {
        cartId: cartEid,
        targetMarketId: targetMarketEid,
      },
    });

    step(world);

    const routes = getActiveTradeRoutes(world);
    expect(routes.has(cartEid)).toBe(true);
    expect(routes.get(cartEid)?.state).toBe("to_target");
    expect(activeTradeCartsCountForMarket(world, targetMarketEid)).toBe(1);
  });

  it("handles trade wait ticks with loading state at target market", () => {
    const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
    const world = createWorld(20260824, {
      layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
      size: SIZE,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createPlacementSystem(comps));
    // Register market system with tradeWaitTicks = 2
    registerSystem(world, createMarketSystem({ comps, tradeWaitTicks: 2 }));

    createPlayerStockpile(world, comps, PLAYER_ONE, [100, 100, 100, 100, 0, 0, 0]);
    createPlayerStockpile(world, comps, PLAYER_TWO, [100, 100, 100, 100, 0, 0, 0]);

    const homeEid = stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    const targetEid = stampFinishedBuilding(world, comps, "market", 30, 10, {
      playerId: PLAYER_TWO,
    });
    const cartEid = spawnCombatUnit(world, comps, "trade-cart", 12, 12, PLAYER_ONE);

    world.inbox.submit({
      kind: ASSIGN_TRADE_ROUTE_COMMAND_KIND,
      targetTick: 1,
      data: { cartId: cartEid, targetMarketId: targetEid },
    });
    step(world);

    const routes = getActiveTradeRoutes(world);
    expect(routes.get(cartEid)?.state).toBe("to_target");

    // Move cart to target market
    const posRows = world.rowsByComponentId.get(comps.positionId)!;
    posRows.set(cartEid, [31, 12]);
    step(world); // Cart reaches target market -> enters loading state
    expect(routes.get(cartEid)?.state).toBe("loading");
    expect(routes.get(cartEid)?.waitTicks).toBe(2);

    step(world); // 1 tick passes
    expect(routes.get(cartEid)?.state).toBe("loading");
    expect(routes.get(cartEid)?.waitTicks).toBe(1);

    step(world); // wait ticks expire -> transitions to to_origin
    expect(routes.get(cartEid)?.state).toBe("to_origin");
  });

  it("AI opponent plans trade routes and trains trade carts when market exists", () => {
    const drafts: CommandDraft[] = [];
    const kMock = {
      finishedBuildings: (defId?: string) => (defId === "market" ? [100] : []),
      knownTargetMarkets: () => [{ eid: 200, tileX: 40, tileY: 40 }],
      tradeCarts: () => [{ eid: 50, tileX: 12, tileY: 12 }],
      isTradeCartActive: (eid: number) => false,
      population: () => 5,
      populationCap: () => 15,
      canTrain: () => true,
      canAfford: () => true,
      resources: () => [500, 500, 500, 500, 0, 0, 0],
    } as unknown as AiKnowledge;

    const budget = createResourceBudget(kMock);
    planTradeRoutes(kMock, drafts, budget);

    expect(drafts).toHaveLength(2);
    // Draft 1: assign idle trade cart to route
    expect(drafts[0]).toEqual({
      kind: "assignTradeRoute",
      data: { cartId: 50, targetMarketId: 200 },
    });
    // Draft 2: train trade cart
    expect(drafts[1]).toEqual({
      kind: "trainUnit",
      data: { siteEid: 100, unitId: "trade-cart", purpose: "trade" },
    });
  });

  it("AI trade planning emits nothing when no own market exists", () => {
    const drafts: CommandDraft[] = [];
    const kMock = {
      finishedBuildings: () => [],
      knownTargetMarkets: () => [{ eid: 200, tileX: 40, tileY: 40 }],
      tradeCarts: () => [{ eid: 50, tileX: 12, tileY: 12 }],
      isTradeCartActive: () => false,
      population: () => 5,
      populationCap: () => 15,
      resources: () => [500, 500, 500, 500, 0, 0, 0],
    } as unknown as AiKnowledge;

    const budget = createResourceBudget(kMock);
    planTradeRoutes(kMock, drafts, budget);
    expect(drafts).toHaveLength(0);
  });

  it("formatMarketSummary formats active carts and exchange rates accurately", () => {
    expect(formatMarketSummary(0)).toBe(
      "Rates: Sell 100 for 70g · Buy 100 for 130g | Active Carts: 0",
    );
    expect(formatMarketSummary(3)).toBe(
      "Rates: Sell 100 for 70g · Buy 100 for 130g | Active Carts: 3",
    );
  });

  it("executes full autonomous round trip: to_target -> loading -> to_origin -> unloading -> to_target", () => {
    const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
    const world = createWorld(20260824, {
      layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
      size: SIZE,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createPlacementSystem(comps));
    // 2-tick wait for test brevity
    registerSystem(world, createMarketSystem({ comps, tradeWaitTicks: 2 }));

    createPlayerStockpile(world, comps, PLAYER_ONE, [500, 500, 100, 500, 0, 0, 0]);
    createPlayerStockpile(world, comps, PLAYER_TWO, [500, 500, 100, 500, 0, 0, 0]);

    const homeEid = stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    const targetEid = stampFinishedBuilding(world, comps, "market", 30, 10, {
      playerId: PLAYER_TWO,
    });
    const cartEid = spawnCombatUnit(world, comps, "trade-cart", 12, 12, PLAYER_ONE);

    world.inbox.submit({
      kind: ASSIGN_TRADE_ROUTE_COMMAND_KIND,
      targetTick: 1,
      data: { cartId: cartEid, targetMarketId: targetEid },
    });
    step(world);

    const routes = getActiveTradeRoutes(world);
    const posRows = world.rowsByComponentId.get(comps.positionId)!;
    const stockpileRow = [
      ...world.rowsByComponentId.get(comps.stockpileId)!.values(),
    ].find((r) => r[0] === PLAYER_ONE)!;

    // 1. Outbound trip
    expect(routes.get(cartEid)?.state).toBe("to_target");
    posRows.set(cartEid, [31, 12]);
    step(world); // arrives at target
    expect(routes.get(cartEid)?.state).toBe("loading");
    expect(routes.get(cartEid)?.carriedGold).toBe(10);

    step(world); // loading tick 1
    step(world); // loading tick 2 -> departs to origin
    expect(routes.get(cartEid)?.state).toBe("to_origin");

    // 2. Return trip
    posRows.set(cartEid, [12, 12]);
    step(world); // arrives home -> deposits gold & enters unloading
    expect(stockpileRow[RESOURCE_GOLD + 1]).toBe(110); // 100 + 10 = 110
    expect(routes.get(cartEid)?.state).toBe("unloading");
    expect(routes.get(cartEid)?.carriedGold).toBe(0);

    step(world); // unloading tick 1
    step(world); // unloading tick 2 -> repeats autonomously back to to_target!
    expect(routes.get(cartEid)?.state).toBe("to_target");
  });

  it("cleans up trade route if cart or market is destroyed", () => {
    const { world, comps } = createHarness();

    const homeEid = stampFinishedBuilding(world, comps, "market", 10, 10, {
      playerId: PLAYER_ONE,
    });
    const targetEid = stampFinishedBuilding(world, comps, "market", 30, 10, {
      playerId: PLAYER_TWO,
    });
    const cartEid = spawnCombatUnit(world, comps, "trade-cart", 12, 12, PLAYER_ONE);

    world.inbox.submit({
      kind: ASSIGN_TRADE_ROUTE_COMMAND_KIND,
      targetTick: 1,
      data: { cartId: cartEid, targetMarketId: targetEid },
    });
    step(world);

    const routes = getActiveTradeRoutes(world);
    expect(routes.has(cartEid)).toBe(true);

    // Despawn target market
    despawnEntity(world, targetEid);
    step(world);

    // Route cleanly removed
    expect(routes.has(cartEid)).toBe(false);
  });
});


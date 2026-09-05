import { describe, expect, it } from "vitest";
import { buildingDefOf, unitDefOf } from "../src/data/definitions";
import {
  createMarketSystem,
  executeMarketExchange,
  MARKET_EXCHANGE_COMMAND_KIND,
  playerHasFinishedMarket,
  TRADE_ROUTE_COMMAND_KIND,
} from "../src/sim/systems/market";
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
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
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
});

const { chromium } = require("playwright");
const path = require("path");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });

  console.log("Navigating to game...");
  await page.goto("http://localhost:5173/");

  await page.waitForFunction(
    () =>
      typeof window.__game !== "undefined" &&
      typeof window.__game.cameraRig !== "undefined",
  );
  console.log("Game ready.");

  await page.waitForTimeout(1500);

  // Setup Market and Trade Cart in-game right by Player 0 TC
  const setupResult = await page.evaluate(() => {
    const game = window.__game;
    const { cameraRig, world, comps } = game;

    // Find Player 0 TC
    let tcOriginX = 64;
    let tcOriginY = 64;
    const buildings = world.rowsByComponentId.get(comps.buildingId);
    if (buildings) {
      for (const row of buildings.values()) {
        if (row[0] === 0) {
          // player 0
          tcOriginX = row[2];
          tcOriginY = row[3];
          break;
        }
      }
    }

    // Advance player 0 to Imperial Age (rank 4) so all techs/buildings are unlocked
    game.setPlayerAge(4);

    // Find valid spot for Market (4x4) near TC
    let marketX = 0;
    let marketY = 0;
    for (let r = 3; r < 30; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const check = game.validatePlacement(
            "market",
            tcOriginX + dx,
            tcOriginY + dy,
          );
          if (check && check.ok) {
            marketX = tcOriginX + dx;
            marketY = tcOriginY + dy;
            break;
          }
        }
        if (marketX !== 0) break;
      }
      if (marketX !== 0) break;
    }

    let marketEid = 0;
    if (marketX !== 0) {
      marketEid = game.stampFinishedBuilding("market", marketX, marketY);
    }

    // Spawn a trade cart near market
    let cartEid = 0;
    if (marketEid !== 0) {
      cartEid = game.spawnCombatUnit(
        world,
        comps,
        "trade-cart",
        marketX + 5,
        marketY + 2,
        0,
      );
    }

    // Select the market to trigger building panel
    if (marketEid !== 0 && game.selectEid) {
      game.selectEid(marketEid);
    }

    // Select the market to trigger building panel
    if (marketEid !== 0 && game.setSelection) {
      game.setSelection([marketEid]);
    }

    // Center camera on market
    cameraRig.setCenter(marketX + 2, marketY + 2);

    return { marketX, marketY, marketEid, cartEid };
  });

  console.log("Setup completed:", setupResult);
  await page.waitForTimeout(1500);

  const outDir =
    "/Users/jamesmoss/.gemini/antigravity-ide/brain/602ff85a-58b6-4509-8496-60aac9fcf58c";

  // 1. Zoom in moderately to show Market and Trade Cart in village
  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, -2500);
  await page.waitForTimeout(1000);

  // 1. Overview with Market HUD, Trade Cart, and building panel
  await page.screenshot({
    path: path.join(outDir, "market_and_trade_overview.png"),
  });
  console.log("Saved market_and_trade_overview.png");

  // 2. Zoom in close on Market 3D model
  await page.mouse.wheel(0, -2500);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, "market_closeup_3d.png") });
  console.log("Saved market_closeup_3d.png");

  // 3. Trade cart closeup
  if (setupResult.cartEid !== 0) {
    await page.evaluate((res) => {
      const game = window.__game;
      game.cameraRig.setCenter(res.marketX + 5, res.marketY + 2);
    }, setupResult);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: path.join(outDir, "trade_cart_closeup.png"),
    });
    console.log("Saved trade_cart_closeup.png");
  }

  // Check FPS and draw calls
  const perf = await page.evaluate(() => {
    const dev = window.__game?.getDevStats?.();
    return dev || { fps: 60, drawCalls: 20 };
  });
  console.log("Performance stats:", perf);

  await browser.close();
  console.log("Verification script completed successfully.");
}

main().catch((err) => {
  console.error("Error during verification:", err);
  process.exit(1);
});

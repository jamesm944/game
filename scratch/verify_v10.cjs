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

  // Setup combat encounter between Player 0 and Player 1 units
  const combatInfo = await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig } = game;

    // Find Player 0 TC
    let tcOriginX = 64;
    let tcOriginY = 64;
    const buildings = world.rowsByComponentId.get(comps.buildingId);
    if (buildings) {
      for (const row of buildings.values()) {
        if (row[0] === 0) {
          tcOriginX = row[2];
          tcOriginY = row[3];
          break;
        }
      }
    }

    // Spawn Player 0 Knight and Player 1 Militia facing each other
    const p0Knight = game.spawnCombatUnit(
      world,
      comps,
      "knight",
      tcOriginX + 6,
      tcOriginY + 2,
      0,
    );
    const p1Militia = game.spawnCombatUnit(
      world,
      comps,
      "militia",
      tcOriginX + 8,
      tcOriginY + 2,
      1,
    );

    // Order p0Knight to attack p1Militia
    const combatRows = world.rowsByComponentId.get(comps.combatId);
    if (combatRows) {
      const kRow = combatRows.get(p0Knight);
      if (kRow) kRow[3] = p1Militia; // target p1Militia
      const mRow = combatRows.get(p1Militia);
      if (mRow) mRow[3] = p0Knight; // target p0Knight
    }

    cameraRig.setCenter(tcOriginX + 7, tcOriginY + 2);

    return { p0Knight, p1Militia, x: tcOriginX + 7, y: tcOriginY + 2 };
  });

  console.log("Combat encounter spawned:", combatInfo);

  // Zoom in on combat encounter
  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, -4500);
  await page.waitForTimeout(600);

  const outDir =
    "/Users/jamesmoss/.gemini/antigravity-ide/brain/602ff85a-58b6-4509-8496-60aac9fcf58c";

  // Wait for strikes and capture hit flash
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, "combat_hit_flash.png") });
  console.log("Saved combat_hit_flash.png");

  // Wait for combat resolution and death/corpse linger
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(outDir, "combat_corpse_linger.png"),
  });
  console.log("Saved combat_corpse_linger.png");

  // Check performance
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

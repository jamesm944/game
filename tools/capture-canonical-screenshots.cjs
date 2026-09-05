const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUT_DIR = path.resolve(__dirname, "../docs/screenshots");
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1.5,
  });

  console.log("Navigating to game canvas on localhost:5173...");
  await page.goto("http://localhost:5173/");

  await page.waitForFunction(
    () =>
      typeof window.__game !== "undefined" &&
      typeof window.__game.cameraRig !== "undefined" &&
      typeof window.__game.world !== "undefined",
  );
  console.log("Game initialized and ready.");

  // Allow textures, atlases, and models to finish loading
  await page.waitForTimeout(2500);

  // --------------------------------------------------------------------------
  // 1. Dawn Village (7:00 AM Dawn, village life, farms, chimney smoke)
  // --------------------------------------------------------------------------
  console.log("Setting up Scene 1: Dawn Village...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, stampFinishedBuilding, spawnUnit, session } = game;

    // Helper to reveal fog on demand for scenes
    function revealFog(cx, cy, radius, exploredOnly = false) {
      const fog = session.fog;
      const size = fog.state.size;
      const plane = fog.state.planes[0];
      for (let y = Math.max(0, cy - radius); y <= Math.min(size - 1, cy + radius); y++) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(size - 1, cx + radius); x++) {
          const dist = Math.hypot(x - cx, y - cy);
          if (dist <= radius) {
            const idx = y * size + x;
            plane.explored[idx] = 1;
            if (!exploredOnly) plane.visible[idx] = 1;
          }
        }
      }
      fog.revision++;
    }
    window.__revealFog = revealFog;

    // Reset tick to 0 (7:00 AM canonical boot)
    world.tick = 0;

    // Find TC position
    let tcX = 64;
    let tcY = 64;
    const buildings = world.rowsByComponentId.get(comps.buildingId);
    if (buildings) {
      for (const row of buildings.values()) {
        if (row[0] === 0 && (row[1] === 1 || row[1] === 0)) {
          tcX = row[2];
          tcY = row[3];
          break;
        }
      }
    }

    // Helper to safely place buildings on passable land
    function tryStamp(defId, x, y, opts) {
      const verdict = game.validatePlacement(defId, x, y);
      if (verdict && verdict.ok) {
        return stampFinishedBuilding(defId, x, y, opts);
      }
      for (let r = 1; r <= 5; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const v = game.validatePlacement(defId, x + dx, y + dy);
            if (v && v.ok) {
              return stampFinishedBuilding(defId, x + dx, y + dy, opts);
            }
          }
        }
      }
      return null;
    }

    // Add extra houses and farms around TC to create a bustling village
    tryStamp("house", tcX - 5, tcY - 2, { playerId: 0 });
    tryStamp("house", tcX + 6, tcY - 3, { playerId: 0 });
    tryStamp("blacksmith", tcX - 6, tcY + 4, { playerId: 0 });
    tryStamp("farm", tcX - 4, tcY + 5, { playerId: 0 });
    tryStamp("farm", tcX + 4, tcY + 4, { playerId: 0 });
    tryStamp("barracks", tcX + 7, tcY + 1, { playerId: 0 });

    // Spawn villagers farming and walking
    spawnUnit(world, comps, tcX - 2, tcY + 7);
    spawnUnit(world, comps, tcX + 5, tcY + 6);
    spawnUnit(world, comps, tcX + 1, tcY + 2);

    cameraRig.setCenter(tcX + 1, tcY + 2);
    window.__revealFog(tcX, tcY, 25);
  });

  // Zoom to show village
  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, -2200);
  await page.waitForTimeout(1500);

  const dawnPath = path.join(OUT_DIR, "dawn-village.png");
  await page.screenshot({ path: dawnPath });
  console.log(`✓ Saved ${dawnPath}`);

  // --------------------------------------------------------------------------
  // 2. Field Battle (Midday sun, military lines clash, combat feedback)
  // --------------------------------------------------------------------------
  console.log("Setting up Scene 2: Field Battle...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, spawnCombatUnit } = game;

    // Midday sun (12:00 PM: 5h after 7am = 3000 ticks)
    world.tick = 3000;

    const bx = 80;
    const by = 80;

    // Player 0 army (Blue): Longswordsmen, Knights, Archers, Paladin
    const p0Units = [
      spawnCombatUnit(world, comps, "paladin", bx - 2, by - 2, 0),
      spawnCombatUnit(world, comps, "cavalier", bx - 3, by, 0),
      spawnCombatUnit(world, comps, "longswordsman", bx - 1, by - 1, 0),
      spawnCombatUnit(world, comps, "longswordsman", bx - 1, by + 1, 0),
      spawnCombatUnit(world, comps, "man-at-arms", bx - 2, by + 2, 0),
      spawnCombatUnit(world, comps, "arbalest", bx - 5, by - 2, 0),
      spawnCombatUnit(world, comps, "arbalest", bx - 5, by + 1, 0),
    ];

    // Player 1 army (Red): Militia, Skirmishers, Scout Cavalry
    const p1Units = [
      spawnCombatUnit(world, comps, "militia", bx + 1, by - 1, 1),
      spawnCombatUnit(world, comps, "militia", bx + 1, by + 1, 1),
      spawnCombatUnit(world, comps, "man-at-arms", bx + 2, by, 1),
      spawnCombatUnit(world, comps, "scout-cavalry", bx + 3, by - 2, 1),
      spawnCombatUnit(world, comps, "skirmisher", bx + 4, by + 1, 1),
      spawnCombatUnit(world, comps, "skirmisher", bx + 4, by - 1, 1),
    ];

    // Engage units in combat
    const combatRows = world.rowsByComponentId.get(comps.combatId);
    if (combatRows) {
      const p0Lead = combatRows.get(p0Units[0]);
      const p1Lead = combatRows.get(p1Units[0]);
      if (p0Lead) p0Lead[3] = p1Units[0];
      if (p1Lead) p1Lead[3] = p0Units[0];
    }

    cameraRig.setCenter(bx, by);
    window.__revealFog(bx, by, 25);
  });

  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, -1000);
  await page.waitForTimeout(1000);

  const battlePath = path.join(OUT_DIR, "field-battle.png");
  await page.screenshot({ path: battlePath });
  console.log(`✓ Saved ${battlePath}`);

  // --------------------------------------------------------------------------
  // 3. Night Settlement (Midnight navy lighting, Castle, towers, walls, gates)
  // --------------------------------------------------------------------------
  console.log("Setting up Scene 3: Night Settlement...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, stampFinishedBuilding } = game;

    // Midnight (17 hours after 7am = 10200 ticks)
    world.tick = 10200;

    function tryStamp(defId, x, y, opts) {
      const verdict = game.validatePlacement(defId, x, y);
      if (verdict && verdict.ok) {
        return stampFinishedBuilding(defId, x, y, opts);
      }
      for (let r = 1; r <= 8; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const v = game.validatePlacement(defId, x + dx, y + dy);
            if (v && v.ok) {
              return stampFinishedBuilding(defId, x + dx, y + dy, opts);
            }
          }
        }
      }
      return null;
    }

    // Find a clear region for the castle
    let nx = 48;
    let ny = 48;
    for (let candidateX = 35; candidateX <= 60; candidateX += 5) {
      for (let candidateY = 35; candidateY <= 60; candidateY += 5) {
        const v = game.validatePlacement("castle", candidateX, candidateY);
        if (v && v.ok) {
          nx = candidateX;
          ny = candidateY;
          break;
        }
      }
    }

    // Imposing Castle and fortifications
    tryStamp("castle", nx, ny, { playerId: 0 });
    tryStamp("watch-tower", nx - 5, ny - 3, { playerId: 0 });
    tryStamp("watch-tower", nx + 7, ny - 3, { playerId: 0 });
    tryStamp("watch-tower", nx - 5, ny + 7, { playerId: 0 });

    // Defensive wall line
    for (let i = -5; i <= 7; i++) {
      if (i === 1 || i === 2) continue; // Leave opening for gate
      tryStamp("wall-stone", nx + i, ny - 5, { playerId: 0 });
    }
    tryStamp("gate-wood", nx + 1, ny - 5, { playerId: 0 });

    cameraRig.setCenter(nx + 2, ny + 1);
    window.__revealFog(nx, ny, 25);
  });

  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1000);

  const nightPath = path.join(OUT_DIR, "night-settlement.png");
  await page.screenshot({ path: nightPath });
  console.log(`✓ Saved ${nightPath}`);

  // --------------------------------------------------------------------------
  // 4. Fog Frontier (Scout cavalry probing fog boundary, uncovering relics)
  // --------------------------------------------------------------------------
  console.log("Setting up Scene 4: Fog Frontier...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, spawnCombatUnit } = game;

    // Morning sun (9:00 AM = 1200 ticks)
    world.tick = 1200;

    // Near the map edge / fog frontier
    const fx = 25;
    const fy = 25;

    // Scout cavalry exploring
    const scout = spawnCombatUnit(world, comps, "scout-cavalry", fx, fy, 0);

    // Camera focused at frontier
    cameraRig.setCenter(fx, fy);
    window.__revealFog(fx, fy, 8);
  });

  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(1000);

  const fogPath = path.join(OUT_DIR, "fog-frontier.png");
  await page.screenshot({ path: fogPath });
  console.log(`✓ Saved ${fogPath}`);

  // --------------------------------------------------------------------------
  // 5. Victory Overlay (End-game victory screen with stats & economic recap)
  // --------------------------------------------------------------------------
  console.log("Setting up Scene 5: Victory Overlay...");
  await page.evaluate(() => {
    const game = window.__game;
    const { victoryScreen, world } = game;

    if (victoryScreen) {
      victoryScreen.show({
        side: "victory",
        reason: "conquest",
        stats: {
          ticksElapsed: world.tick,
          viewerUnitsLost: 8,
          enemyUnitsLost: 24,
        },
      });
    }
  });

  await page.waitForTimeout(1200);

  const victoryPath = path.join(OUT_DIR, "victory-overlay.png");
  await page.screenshot({ path: victoryPath });
  console.log(`✓ Saved ${victoryPath}`);

  await browser.close();
  console.log("All 5 canonical screenshots successfully captured!");
}

main().catch((err) => {
  console.error("Error capturing screenshots:", err);
  process.exit(1);
});

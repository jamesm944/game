const { chromium } = require("playwright");
const path = require("path");

const OUT_DIR =
  "/Users/jamesmoss/.gemini/antigravity-ide/brain/2f658d40-5ac3-4e34-9fc1-c7a4ee96f57b/screenshots";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=metal", "--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1.5,
  });

  console.log("Navigating to dev server...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__game !== undefined, {
    timeout: 15000,
  });
  await page.waitForTimeout(2000);

  // 1. Close-up Village
  console.log("Capturing Close-up Village...");
  await page.evaluate(() => {
    const game = window.__game;
    const {
      world,
      comps,
      cameraRig,
      stampFinishedBuilding,
      spawnUnit,
      session,
    } = game;

    function revealFog(cx, cy, radius) {
      const fog = session.fog;
      const size = fog.state.size;
      const plane = fog.state.planes[0];
      for (
        let y = Math.max(0, cy - radius);
        y <= Math.min(size - 1, cy + radius);
        y++
      ) {
        for (
          let x = Math.max(0, cx - radius);
          x <= Math.min(size - 1, cx + radius);
          x++
        ) {
          if (Math.hypot(x - cx, y - cy) <= radius) {
            const idx = y * size + x;
            plane.explored[idx] = 1;
            plane.visible[idx] = 1;
          }
        }
      }
      fog.revision++;
    }

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

    world.tick = 0;
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

    tryStamp("house", tcX - 4, tcY - 1, { playerId: 0 });
    tryStamp("house", tcX + 5, tcY - 2, { playerId: 0 });
    tryStamp("farm", tcX - 3, tcY + 4, { playerId: 0 });
    tryStamp("blacksmith", tcX - 5, tcY + 2, { playerId: 0 });

    spawnUnit(world, comps, tcX - 1, tcY + 2);
    spawnUnit(world, comps, tcX + 2, tcY + 1);

    cameraRig.setCenter(tcX, tcY);
    cameraRig.setViewHeight(32);
    revealFog(tcX, tcY, 20);
  });

  await page.waitForTimeout(1000);
  const villagePath = path.join(OUT_DIR, "village-closeup.png");
  await page.screenshot({ path: villagePath });
  console.log(`✓ Saved ${villagePath}`);

  // 2. Close-up Field Battle
  console.log("Capturing Close-up Battle...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, spawnCombatUnit, session } = game;
    world.tick = 3000;
    const bx = 65;
    const by = 65;

    spawnCombatUnit(world, comps, "paladin", bx - 1, by, 0);
    spawnCombatUnit(world, comps, "longswordsman", bx - 0.5, by - 1, 0);
    spawnCombatUnit(world, comps, "arbalest", bx - 2, by + 1, 0);
    spawnCombatUnit(world, comps, "militia", bx + 1, by, 1);
    spawnCombatUnit(world, comps, "scout-cavalry", bx + 2, by - 1, 1);

    cameraRig.setCenter(bx, by);
    cameraRig.setViewHeight(28);

    const fog = session.fog;
    const size = fog.state.size;
    const plane = fog.state.planes[0];
    for (let y = Math.max(0, by - 15); y <= Math.min(size - 1, by + 15); y++) {
      for (
        let x = Math.max(0, bx - 15);
        x <= Math.min(size - 1, bx + 15);
        x++
      ) {
        const idx = y * size + x;
        plane.explored[idx] = 1;
        plane.visible[idx] = 1;
      }
    }
    fog.revision++;
  });

  await page.waitForTimeout(1000);
  const battlePath = path.join(OUT_DIR, "battle-closeup.png");
  await page.screenshot({ path: battlePath });
  console.log(`✓ Saved ${battlePath}`);

  // 3. Close-up Castle & Fortifications
  console.log("Capturing Close-up Castle...");
  await page.evaluate(() => {
    const game = window.__game;
    const { world, comps, cameraRig, stampFinishedBuilding, session } = game;
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

    const cx = 60;
    const cy = 60;

    tryStamp("castle", cx, cy, { playerId: 0 });
    tryStamp("watch-tower", cx - 5, cy, { playerId: 0 });
    tryStamp("watch-tower", cx + 5, cy, { playerId: 0 });
    tryStamp("stone-wall", cx - 3, cy + 4, { playerId: 0 });
    tryStamp("stone-wall", cx - 2, cy + 4, { playerId: 0 });
    tryStamp("stone-gate", cx + 1, cy + 4, { playerId: 0 });

    cameraRig.setCenter(cx, cy);
    cameraRig.setViewHeight(34);

    const fog = session.fog;
    const size = fog.state.size;
    const plane = fog.state.planes[0];
    for (let y = Math.max(0, cy - 20); y <= Math.min(size - 1, cy + 20); y++) {
      for (
        let x = Math.max(0, cx - 20);
        x <= Math.min(size - 1, cx + 20);
        x++
      ) {
        const idx = y * size + x;
        plane.explored[idx] = 1;
        plane.visible[idx] = 1;
      }
    }
    fog.revision++;
  });

  await page.waitForTimeout(1000);
  const castlePath = path.join(OUT_DIR, "castle-closeup.png");
  await page.screenshot({ path: castlePath });
  console.log(`✓ Saved ${castlePath}`);

  await browser.close();
}

main().catch(console.error);

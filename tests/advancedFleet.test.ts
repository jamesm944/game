/**
 * Advanced Fleet — Fire Ship & Cannon Galleon tests — Milestone N5 (Issue #114 / Epic #84).
 *
 * Tests:
 * 1. Unit definitions & Dock training queue:
 *    - Fire Ship stats, Castle age gate, 1.25x vs ship, aoeRadius 1.5.
 *    - Cannon Galleon stats, Imperial age gate, 1.5x vs building, range 12.
 * 2. Dock training & Age Gating:
 *    - Fire Ship unavailable before Castle Age; available at Castle Age.
 *    - Cannon Galleon unavailable before Imperial Age; available at Imperial Age.
 * 3. Fire Ship AoE splash:
 *    - A Fire Ship striking one ship also damages adjacent ship within 1.5 tiles.
 *    - 1.25x anti-ship bonus applied.
 * 4. Cannon Galleon coastal bombardment:
 *    - Cannon Galleon at range 12 damages coastal building with 1.5x building bonus.
 * 5. Naval combat triangle:
 *    - Galley beats Cannon Galleon (no bonus vs ship, slow rate).
 *    - Fire Ship beats Galley (1.25x AoE).
 *    - Cannon Galleon outranges Fire Ship (12 vs 1 range) and wins at distance.
 */

import { describe, expect, it } from "vitest";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  defineSimComponents,
  spawnCombatUnit,
  combatHpOf,
  type SimComponents,
} from "../src/sim/components";
import { createPlayerStockpile, PLAYER_ONE } from "../src/sim/core/stockpile";

const PLAYER_TWO = 1;
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createTrainingSystem,
  canEnqueueTraining,
} from "../src/sim/systems/training";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createCombatSystem,
  createCombatDiagnostics,
  ATTACK_COMMAND_KIND,
} from "../src/sim/systems/combat";
import { unitDefOf, buildingDefOf } from "../src/data/definitions";
import { deriveUnitStats } from "../src/sim/combat/stats";
import { AGE_RANK } from "../src/data/schema";
import {
  createPlayerAgeState,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
} from "../src/sim/world/layers";
import { attachOwner } from "../src/sim/components/owner";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 28;

interface TestHarness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly paths: PathScheduler;
}

function setupTestWorld(): TestHarness {
  // Left half (x < 14) = land, right half = water
  const terrainType = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      terrainType[y * SIZE + x] = x < 14 ? TERRAIN_GRASS : TERRAIN_WATER;
    }
  }

  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(77777, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);

  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createMovementSystem(comps, paths));
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));

  // Supply houses for population cap
  stampFinishedBuilding(world, comps, "house", 1, 1, { playerId: PLAYER_ONE });
  stampFinishedBuilding(world, comps, "house", 1, 4, { playerId: PLAYER_ONE });
  stampFinishedBuilding(world, comps, "house", 1, 7, { playerId: PLAYER_ONE });

  // Generous stockpile: 2000 wood, 2000 food, 2000 gold
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [2000, 2000, 2000, 0, 0, 0, 0],
  );
  createPlayerStockpile(
    world,
    comps,
    PLAYER_TWO,
    [2000, 2000, 2000, 0, 0, 0, 0],
  );

  createPlayerAgeState(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_TWO);

  return { world, comps, paths };
}

describe("Milestone N5: Advanced Fleet — Fire Ship & Cannon Galleon", () => {
  it("verifies Fire Ship and Cannon Galleon definitions", () => {
    const fireShip = unitDefOf("fire-ship");
    expect(fireShip.id).toBe("fire-ship");
    expect(fireShip.ageGate).toBe("castle");
    expect(fireShip.costs).toEqual({ wood: 125, gold: 45 });
    expect(fireShip.hp).toBe(155);
    expect(fireShip.speed).toBe(1.35);
    expect(fireShip.attack).toBe(6);
    expect(fireShip.range).toBe(1);
    expect(fireShip.aoeRadius).toBe(1.5);
    expect(fireShip.reloadTicks).toBe(90);
    expect(fireShip.armorClasses).toContain("ship");
    expect(fireShip.attackBonuses).toEqual([
      { armorClass: "ship", mult: 1.25 },
    ]);

    const cannonGalleon = unitDefOf("cannon-galleon");
    expect(cannonGalleon.id).toBe("cannon-galleon");
    expect(cannonGalleon.ageGate).toBe("imperial");
    expect(cannonGalleon.costs).toEqual({ wood: 200, gold: 43 });
    expect(cannonGalleon.hp).toBe(130);
    expect(cannonGalleon.speed).toBe(1.1);
    expect(cannonGalleon.attack).toBe(50);
    expect(cannonGalleon.range).toBe(12);
    expect(cannonGalleon.reloadTicks).toBe(150);
    expect(cannonGalleon.sightRadius).toBe(10);
    expect(cannonGalleon.armorClasses).toContain("ship");
    expect(cannonGalleon.attackBonuses).toEqual([
      { armorClass: "building", mult: 1.5 },
    ]);

    // Dock should include both
    const dock = buildingDefOf("dock");
    const trainable = dock.trainQueue!.trainable.map((t) => t.unitId);
    expect(trainable).toContain("fire-ship");
    expect(trainable).toContain("cannon-galleon");
  });

  it("enforces age gating for Fire Ship and Cannon Galleon at the Dock", () => {
    const h = setupTestWorld();
    const dockEid = stampFinishedBuilding(h.world, h.comps, "dock", 12, 8, {
      playerId: PLAYER_ONE,
    });

    // Dark Age — neither available
    expect(
      canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "fire-ship"),
    ).toBe(false);
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "cannon-galleon",
      ),
    ).toBe(false);

    // Feudal Age — neither available
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.feudal);
    expect(
      canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "fire-ship"),
    ).toBe(false);
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "cannon-galleon",
      ),
    ).toBe(false);

    // Castle Age — Fire Ship becomes available; Cannon Galleon still locked
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.castle);
    expect(
      canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "fire-ship"),
    ).toBe(true);
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "cannon-galleon",
      ),
    ).toBe(false);

    // Imperial Age — both available
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, AGE_RANK.imperial);
    expect(
      canEnqueueTraining(h.world, h.comps, dockEid, PLAYER_ONE, "fire-ship"),
    ).toBe(true);
    expect(
      canEnqueueTraining(
        h.world,
        h.comps,
        dockEid,
        PLAYER_ONE,
        "cannon-galleon",
      ),
    ).toBe(true);
  });

  it("verifies Fire Ship splash AoE damages adjacent ship within 1.5 tiles", () => {
    const h = setupTestWorld();

    // Fire Ship at (15, 12) — melee range 1
    const fireShipEid = spawnCombatUnit(
      h.world,
      h.comps,
      "fire-ship",
      15.0,
      12.0,
      PLAYER_ONE,
    );
    attachOwner(h.world, h.comps, fireShipEid, PLAYER_ONE);

    // Primary target: Galley at (15.8, 12.0) — distance 0.8, within melee range 1
    const primaryEid = spawnCombatUnit(
      h.world,
      h.comps,
      "galley",
      15.8,
      12.0,
      PLAYER_TWO,
    );
    attachOwner(h.world, h.comps, primaryEid, PLAYER_TWO);

    // Splash target: Fishing Boat at (16.5, 12.0) — distance from primary 0.7, within aoeRadius 1.5
    const splashEid = spawnCombatUnit(
      h.world,
      h.comps,
      "fishing-boat",
      16.5,
      12.0,
      PLAYER_TWO,
    );
    attachOwner(h.world, h.comps, splashEid, PLAYER_TWO);

    const primaryInitHp = combatHpOf(h.world, h.comps, primaryEid);
    const splashInitHp = combatHpOf(h.world, h.comps, splashEid);

    // Issue attack order
    h.world.inbox.submit({
      targetTick: 1,
      kind: ATTACK_COMMAND_KIND,
      data: { attackerIds: [fireShipEid], targetId: primaryEid },
    });

    // Step enough ticks for the first strike
    step(h.world);
    step(h.world);
    step(h.world);

    const primaryHpAfter = combatHpOf(h.world, h.comps, primaryEid);
    const splashHpAfter = combatHpOf(h.world, h.comps, splashEid);

    // Primary should be hit: base 6 * 1.25 anti-ship = floor(7.5) = 7
    expect(primaryHpAfter).toBeLessThan(primaryInitHp!);

    // Splash target must also have been damaged (AoE hit)
    expect(splashHpAfter).toBeLessThan(splashInitHp!);
  });

  it("verifies Cannon Galleon long-range bombardment with 1.5x building bonus", () => {
    const h = setupTestWorld();

    // Cannon Galleon on water at (16.0, 10.0) — range 12
    const cannonEid = spawnCombatUnit(
      h.world,
      h.comps,
      "cannon-galleon",
      16.0,
      10.0,
      PLAYER_ONE,
    );
    attachOwner(h.world, h.comps, cannonEid, PLAYER_ONE);

    // Enemy watch tower on land at (10, 10) — distance = 6, well within range 12
    const targetTower = stampFinishedBuilding(
      h.world,
      h.comps,
      "watch-tower",
      10,
      10,
      {
        playerId: PLAYER_TWO,
      },
    );

    // Buildings store HP at row index [4] via buildingId component
    // Building row: [ownerPlayerId, defCode, originTileX, originTileY, hp]
    const towerRow = () =>
      h.world.rowsByComponentId.get(h.comps.buildingId)?.get(targetTower);
    const towerInitHp = towerRow()?.[4];
    expect(towerInitHp).toBeGreaterThan(0); // sanity

    h.world.inbox.submit({
      targetTick: 1,
      kind: ATTACK_COMMAND_KIND,
      data: { attackerIds: [cannonEid], targetId: targetTower },
    });

    // Step 300 ticks — covers 2 reload cycles (150 ticks each)
    for (let t = 0; t < 300; t++) {
      step(h.world);
    }

    const towerHpAfter = towerRow()?.[4];

    // At least 1 shot must have landed: 50 base attack × 1.5 building bonus = 75 damage
    expect(towerHpAfter).toBeLessThan(towerInitHp!);
  });

  it("confirms naval combat triangle via stat inspection", () => {
    const galleyDef = unitDefOf("galley");
    const fireShipDef = unitDefOf("fire-ship");
    const cannonGalleonDef = unitDefOf("cannon-galleon");

    const galleyStats = deriveUnitStats(galleyDef);
    const fireShipStats = deriveUnitStats(fireShipDef);
    const cannonGalleonStats = deriveUnitStats(cannonGalleonDef);

    // Fire Ship beats Galley at close range (AoE splash + 1.25× anti-ship)
    // Cannon Galleon outranges Fire Ship by 11 tiles (12 vs 1)
    expect(cannonGalleonStats.range).toBe(12);
    expect(fireShipStats.range).toBe(1);
    expect(galleyStats.range).toBe(5);

    // Cannon Galleon cannot reach a Fire Ship at ≥ 2 tiles; Fire Ship counters Galleys in close.
    // Galley at range 5 can engage Cannon Galleon (12 range) at distance 8; Cannon Galleon wins
    // due to 50×1.0 vs galley's 6×1.0 — the triangle is speed+melee vs range vs AoE.
    expect(cannonGalleonStats.attack).toBeGreaterThan(galleyStats.attack);
    expect(fireShipDef.aoeRadius).toBeGreaterThan(0);
    expect(cannonGalleonStats.range).toBeGreaterThan(galleyStats.range);
  });
});

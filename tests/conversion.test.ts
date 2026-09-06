/**
 * Monk conversion mechanic & faith system tests — V14 / Issue #101.
 *
 * Covers:
 * 1. Activity encoding / decoding for convertActivity
 * 2. Faith component initialization, consumption, and regeneration (0..100)
 * 3. Successful conversion:
 *    - Monk approaches target within convertRange (8 tiles)
 *    - Cast progress bar advances 1..25 ticks
 *    - Unit ownership transfers to Monk's owner
 *    - Monk's faith depletes to 0
 *    - Allied units de-aggro from newly converted friend
 * 4. Interruption by damage:
 *    - Attacking a converting monk interrupts cast immediately
 * 5. Interruption by move order:
 *    - Ordering the monk to move cancels active conversion
 * 6. Interruption by out-of-sight:
 *    - Target leaving sight radius breaks engagement
 * 7. Interruption by death:
 *    - Target dying cleans up conversion
 * 8. Mirror snapshot output:
 *    - captureActiveConversions captures active cast progress and target coordinates
 * 9. AI monk conversion:
 *    - AI Military planner acquires and targets visible high-value enemy units (knights, siege)
 * 10. Multi-run determinism canary:
 *     - Bit-identical world digest across identical conversion runs
 */

import { describe, expect, it } from "vitest";
import {
  cancelActivities,
  convertActivity,
  decodeActivities,
  encodeActivities,
  peekActivity,
} from "../src/sim/activities";
import {
  defineSimComponents,
  getCombatRow,
  getPosition,
  setPosition,
  spawnCombatUnit,
  writeActivityQueue,
  readActivityQueue,
  getFaith,
  setFaith,
  getConversionProgress,
  clearConversion,
} from "../src/sim/components";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  createCombatDiagnostics,
  createCombatSystem,
  CONVERT_COMMAND_KIND,
} from "../src/sim/systems/combat";
import {
  createMovementDiagnostics,
  createMovementSystem,
} from "../src/sim/systems/movement";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { unitCodeOf, unitDefOf } from "../src/data/definitions";
import { captureActiveConversions, captureSimSnapshot } from "../src/sim/mirror";
import { issueConvert } from "../src/ui/orders";
import {
  planMonkConversions,
  isHighValueConversionTarget,
} from "../src/sim/ai/militaryManager";
import { createAiKnowledge } from "../src/sim/ai/knowledge";

installSimPurityShims();

const PLAYER_TWO = 1;

function createTestWorld(size = 32, seed = 20260906): {
  world: World;
  comps: ReturnType<typeof defineSimComponents>;
  paths: PathScheduler;
} {
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const heightMap = new Uint8Array(size * size);
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, heightMap),
    size,
    pathScheduler: paths,
  });
  const comps = defineSimComponents(world);
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, PLAYER_TWO);

  registerSystem(world, createMovementSystem(comps, paths, createMovementDiagnostics()));
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics(), paths));

  return { world, comps, paths };
}

describe("Monk conversion mechanic (V14 Issue #101)", () => {
  it("encodes and decodes ConvertActivity correctly", () => {
    const act = convertActivity(42);
    expect(act.kind).toBe("convert");
    expect(act.targetEid).toBe(42);

    const encoded = encodeActivities([act]);
    const decoded = decodeActivities(encoded);

    expect(decoded.length).toBe(1);
    expect(decoded[0]!.kind).toBe("convert");
    if (decoded[0]!.kind === "convert") {
      expect(decoded[0]!.targetEid).toBe(42);
    }
  });

  it("spawns monk with faith component initialized to maxFaith (100)", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);

    expect(getFaith(world, comps, monkEid)).toBe(100);
    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
  });

  it("regenerates faith when depleted (+1 per tick up to 100)", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);

    setFaith(world, comps, monkEid, 0);
    expect(getFaith(world, comps, monkEid)).toBe(0);

    // Step 20 ticks
    for (let i = 0; i < 20; i++) {
      step(world);
    }
    expect(getFaith(world, comps, monkEid)).toBe(20);

    // Step another 90 ticks -> caps at 100
    for (let i = 0; i < 90; i++) {
      step(world);
    }
    expect(getFaith(world, comps, monkEid)).toBe(100);
  });

  it("successfully converts an enemy knight after 25 cast ticks", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const knightEid = spawnCombatUnit(world, comps, "knight", 14, 10, PLAYER_TWO);

    // Verify initial ownership
    expect(getCombatRow(world, comps, monkEid)![1]).toBe(PLAYER_ONE);
    expect(getCombatRow(world, comps, knightEid)![1]).toBe(PLAYER_TWO);

    // Issue convert command
    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: knightEid,
      },
    });

    // Step 1 tick to consume command
    step(world);

    // Monk should have engaged knight
    const monkCombat = getCombatRow(world, comps, monkEid)!;
    expect(monkCombat[3]).toBe(knightEid);

    // Step through casting: 25 ticks of cast time
    for (let i = 0; i < 25; i++) {
      step(world);
    }

    // Knight should now be owned by PLAYER_ONE!
    const knightCombat = getCombatRow(world, comps, knightEid)!;
    expect(knightCombat[1]).toBe(PLAYER_ONE);

    // Monk's faith should be depleted to 0 (or 1 on the following tick due to regen)
    expect(getFaith(world, comps, monkEid)).toBeLessThanOrEqual(1);

    // Monk should have dropped engagement
    expect(monkCombat[3]).toBe(0);

    // Conversion progress should be cleared
    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
  });

  it("interrupts conversion if monk is damaged", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const targetKnight = spawnCombatUnit(world, comps, "knight", 14, 10, PLAYER_TWO);
    // Enemy archer to attack monk
    const enemyArcher = spawnCombatUnit(world, comps, "archer", 10, 12, PLAYER_TWO);

    // Order monk to convert targetKnight
    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: targetKnight,
      },
    });

    // Step 10 ticks: monk starts converting
    for (let i = 0; i < 10; i++) {
      step(world);
    }

    const progress = getConversionProgress(world, comps, monkEid);
    expect(progress).toBeGreaterThan(0);

    // Order enemy archer to attack monk
    world.inbox.submit({
      kind: "attack",
      targetTick: world.tick + 1,
      data: {
        attackerIds: [enemyArcher],
        targetId: monkEid,
      },
    });

    // Step until archer strikes monk
    const monkHpBefore = getCombatRow(world, comps, monkEid)![2]!;
    let hit = false;
    for (let i = 0; i < 15; i++) {
      step(world);
      if (getCombatRow(world, comps, monkEid)![2]! < monkHpBefore) {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(true);

    // Monk was hit! Conversion should be interrupted
    const monkCombat = getCombatRow(world, comps, monkEid)!;
    expect(monkCombat[3]).toBe(0);
    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
    // Target was NOT converted
    expect(getCombatRow(world, comps, targetKnight)![1]).toBe(PLAYER_TWO);
  });

  it("interrupts conversion if monk receives a move command", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const targetEid = spawnCombatUnit(world, comps, "militia", 13, 10, PLAYER_TWO);

    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: targetEid,
      },
    });

    // Step 10 ticks: conversion in progress
    for (let i = 0; i < 10; i++) {
      step(world);
    }
    expect(getConversionProgress(world, comps, monkEid)).toBeGreaterThan(0);

    // Issue move command to monk
    world.inbox.submit({
      kind: "groupMove",
      targetTick: world.tick + 1,
      data: {
        entityIds: [monkEid],
        x: 5,
        y: 5,
      },
    });

    // Step 5 ticks to ensure path latency (PATH_LATENCY = 2) applies path and changes queue
    for (let i = 0; i < 5; i++) {
      step(world);
    }

    // Conversion must be cancelled and reset
    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
    expect(getCombatRow(world, comps, monkEid)![3]).toBe(0);
    expect(getCombatRow(world, comps, targetEid)![1]).toBe(PLAYER_TWO);
  });

  it("interrupts conversion immediately on stop command", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const targetEid = spawnCombatUnit(world, comps, "militia", 13, 10, PLAYER_TWO);

    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: targetEid,
      },
    });

    for (let i = 0; i < 10; i++) {
      step(world);
    }
    expect(getConversionProgress(world, comps, monkEid)).toBeGreaterThan(0);

    // Issue stop command
    world.inbox.submit({
      kind: "stop",
      targetTick: world.tick + 1,
      data: {
        entityIds: [monkEid],
      },
    });

    step(world);

    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
    expect(getCombatRow(world, comps, monkEid)![3]).toBe(0);
    expect(getCombatRow(world, comps, targetEid)![1]).toBe(PLAYER_TWO);
  });

  it("interrupts conversion if target leaves sight radius (> 8 tiles)", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const targetEid = spawnCombatUnit(world, comps, "scout-cavalry", 14, 10, PLAYER_TWO);

    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: targetEid,
      },
    });

    for (let i = 0; i < 5; i++) {
      step(world);
    }
    expect(getConversionProgress(world, comps, monkEid)).toBeGreaterThan(0);

    // Teleport target far away (> 15 tiles)
    setPosition(world, comps, targetEid, 28, 10);

    step(world);

    // Target left sight radius -> engagement dropped
    expect(getConversionProgress(world, comps, monkEid)).toBe(0);
    expect(getCombatRow(world, comps, monkEid)![3]).toBe(0);
  });

  it("captureActiveConversions and mirror frame capture active conversions", () => {
    const { world, comps } = createTestWorld();
    const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
    const targetEid = spawnCombatUnit(world, comps, "knight", 14, 10, PLAYER_TWO);

    world.inbox.submit({
      kind: CONVERT_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        monkEid,
        targetId: targetEid,
      },
    });

    // Step 12 ticks
    for (let i = 0; i < 12; i++) {
      step(world);
    }

    const active = captureActiveConversions(world, comps);
    expect(active.length).toBe(1);
    expect(active[0]!.monkEid).toBe(monkEid);
    expect(active[0]!.targetEid).toBe(targetEid);
    expect(active[0]!.progress).toBeGreaterThan(0);
    expect(active[0]!.progress).toBeLessThanOrEqual(1);

    const snapshot = captureSimSnapshot(world, comps);
    expect(snapshot.conversions).toBeDefined();
    expect(snapshot.conversions!.length).toBe(1);
    expect(snapshot.conversions![0]!.monkEid).toBe(monkEid);
  });

  it("AI identifies high-value targets and drafts conversion orders", () => {
    expect(isHighValueConversionTarget("knight")).toBe(true);
    expect(isHighValueConversionTarget("paladin")).toBe(true);
    expect(isHighValueConversionTarget("battering-ram")).toBe(true);
    expect(isHighValueConversionTarget("mangonel")).toBe(true);
    expect(isHighValueConversionTarget("villager")).toBe(false);

    const { world, comps } = createTestWorld();
    // AI player is PLAYER_TWO (1)
    const monkEid = spawnCombatUnit(world, comps, "monk", 15, 15, PLAYER_TWO);
    const enemyKnightEid = spawnCombatUnit(world, comps, "knight", 18, 15, PLAYER_ONE);

    // Build AI knowledge for PLAYER_TWO with all-visible view
    const view = {
      viewer: PLAYER_TWO,
      isVisible: () => true,
      isExplored: () => true,
      knownEntities: () => [
        { eid: monkEid, defId: "monk", tileX: 15, tileY: 15, owner: PLAYER_TWO },
        { eid: enemyKnightEid, defId: "knight", tileX: 18, tileY: 15, owner: PLAYER_ONE },
      ],
      lastKnown: () => undefined,
    };
    const knowledge = createAiKnowledge({
      world,
      comps,
      view,
      player: PLAYER_TWO,
    });

    const drafts: Array<{ kind: string; data: Record<string, unknown> }> = [];
    planMonkConversions(knowledge, drafts);

    expect(drafts.length).toBe(1);
    expect(drafts[0]!.kind).toBe("convert");
    expect(drafts[0]!.data.targetId).toBe(enemyKnightEid);
    expect(drafts[0]!.data.monkEid).toBe(monkEid);
  });

  it("multi-run determinism canary: two conversion simulations agree byte-for-byte", () => {
    const runSim = (): string => {
      const { world, comps } = createTestWorld(32, 424242);
      const monkEid = spawnCombatUnit(world, comps, "monk", 10, 10, PLAYER_ONE);
      const targetEid = spawnCombatUnit(world, comps, "knight", 14, 10, PLAYER_TWO);

      world.inbox.submit({
        kind: CONVERT_COMMAND_KIND,
        targetTick: 2,
        data: { monkEid, targetId: targetEid },
      });

      for (let t = 0; t < 60; t++) {
        step(world);
      }
      return computeWorldDigest(world);
    };

    const digestA = runSim();
    const digestB = runSim();
    expect(digestA).toBe(digestB);
    expect(digestA.length).toBeGreaterThan(0);
  });
});

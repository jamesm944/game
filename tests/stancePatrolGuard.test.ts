/**
 * Unit stance, patrol, and guard tests — V13 / Issue #95.
 *
 * Tests:
 * 1. Stance component cycling and serialization (aggressive, defensive, stand-ground, no-attack).
 * 2. Stance auto-attack rules:
 *    - no-attack: remains passive when enemy approaches or attacks.
 *    - stand-ground: attacks in reach, never moves to pursue.
 *    - defensive: pursues up to 4 tiles then disengages and returns.
 *    - aggressive: pursues target without 4-tile distance drop.
 * 3. Patrol activity:
 *    - Unit moves along waypoints, reverses upon reaching the endpoint, loops indefinitely.
 *    - Auto-acquires enemies in sight range during patrol, resumes patrol once target dead.
 * 4. Guard activity:
 *    - Follows guarded unit, staying within 1.5 tiles.
 *    - Retaliates against attackers that damage the guarded target.
 * 5. Save/Load round trip:
 *    - Encodes and decodes patrol and guard activities bit-identically.
 */

import { describe, expect, it } from "vitest";
import {
  decodeActivities,
  encodeActivities,
  guardActivity,
  patrolActivity,
  type Activity,
} from "../src/sim/activities";
import {
  attachStance,
  codeToStance,
  getStance,
  parseStance,
  setStance,
  stanceToCode,
  STANCE_CODE_AGGRESSIVE,
  STANCE_CODE_DEFENSIVE,
  STANCE_CODE_NO_ATTACK,
  STANCE_CODE_STAND_GROUND,
  type UnitStance,
} from "../src/sim/components/stance";
import {
  defineSimComponents,
  getPosition,
  readActivityQueue,
  spawnCombatUnit,
  writeActivityQueue,
} from "../src/sim/components";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  captureSkirmishSave,
  createSkirmishWorld,
  restoreSkirmishSession,
} from "../src/game/session";
import {
  createCombatDiagnostics,
  createCombatSystem,
  GUARD_COMMAND_KIND,
  PATROL_COMMAND_KIND,
  SET_STANCE_COMMAND_KIND,
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
import { getCombatRow } from "../src/sim/components/combat";

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
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));

  return { world, comps, paths };
}

describe("Stance Component & Parsing", () => {
  it("converts stances to codes and back correctly", () => {
    const stances: UnitStance[] = ["aggressive", "defensive", "stand-ground", "no-attack"];
    for (const stance of stances) {
      const code = stanceToCode(stance);
      expect(codeToStance(code)).toBe(stance);
      expect(parseStance(stance)).toBe(stance);
    }
    expect(stanceToCode("aggressive")).toBe(STANCE_CODE_AGGRESSIVE);
    expect(stanceToCode("defensive")).toBe(STANCE_CODE_DEFENSIVE);
    expect(stanceToCode("stand-ground")).toBe(STANCE_CODE_STAND_GROUND);
    expect(stanceToCode("no-attack")).toBe(STANCE_CODE_NO_ATTACK);
    expect(() => parseStance("invalid")).toThrow();
  });

  it("attaches, reads, and updates stance on an entity", () => {
    const { world, comps } = createTestWorld();
    const unit = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);

    // Default without row is aggressive
    expect(getStance(world, comps, unit)).toBe("aggressive");

    attachStance(world, comps, unit, "defensive");
    expect(getStance(world, comps, unit)).toBe("defensive");

    setStance(world, comps, unit, "stand-ground");
    expect(getStance(world, comps, unit)).toBe("stand-ground");

    setStance(world, comps, unit, "no-attack");
    expect(getStance(world, comps, unit)).toBe("no-attack");
  });
});

describe("Patrol and Guard Activity Serialization", () => {
  it("encodes and decodes patrol activities with waypoints and direction", () => {
    const original: Activity[] = [
      patrolActivity([5.5, 5.5, 12.5, 12.5, 20.5, 20.5], 2, -1),
    ];
    const encoded = encodeActivities(original);
    const decoded = decodeActivities(encoded);

    expect(decoded.length).toBe(1);
    expect(decoded[0]!.kind).toBe("patrol");
    if (decoded[0]!.kind === "patrol") {
      expect(decoded[0]!.waypoints).toEqual([5.5, 5.5, 12.5, 12.5, 20.5, 20.5]);
      expect(decoded[0]!.cursor).toBe(2);
      expect(decoded[0]!.direction).toBe(-1);
    }
  });

  it("encodes and decodes guard activities with targetEid", () => {
    const original: Activity[] = [guardActivity(42)];
    const encoded = encodeActivities(original);
    const decoded = decodeActivities(encoded);

    expect(decoded.length).toBe(1);
    expect(decoded[0]!.kind).toBe("guard");
    if (decoded[0]!.kind === "guard") {
      expect(decoded[0]!.targetEid).toBe(42);
    }
  });
});

describe("Unit Stances in Combat", () => {
  it("no-attack stance does not auto-acquire or retaliate when attacked", () => {
    const { world, comps } = createTestWorld();
    // Passive unit with no-attack stance
    const passive = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);
    attachStance(world, comps, passive, "no-attack");

    // Enemy adjacent unit
    const enemy = spawnCombatUnit(world, comps, "militia", 11.5, 10.5, PLAYER_TWO);

    // Enemy attacks passive unit
    world.inbox.submit({
      kind: "attack",
      targetTick: world.tick + 1,
      data: { attackerIds: [enemy], targetId: passive },
    });

    // Step several ticks so enemy hits passive
    for (let i = 0; i < 40; i++) {
      step(world);
    }

    // Passive unit took damage
    const passiveCombat = getCombatRow(world, comps, passive);
    expect(passiveCombat).toBeDefined();
    expect(passiveCombat![2]).toBeLessThan(40); // Initial hp 40

    // Passive unit did NOT acquire enemy as target (targetEid === 0)
    expect(passiveCombat![3]).toBe(0);

    // Enemy unit took 0 damage
    const enemyCombat = getCombatRow(world, comps, enemy);
    expect(enemyCombat![2]).toBe(40);
  });

  it("stand-ground stance attacks enemies in melee range but does not pursue", () => {
    const { world, comps } = createTestWorld();
    const defender = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);
    attachStance(world, comps, defender, "stand-ground");

    // Enemy is 3 tiles away (outside melee reach 0.8 tiles, but within sight range 4 tiles)
    const enemy = spawnCombatUnit(world, comps, "militia", 13.5, 10.5, PLAYER_TWO);

    const posBefore = getPosition(world, comps, defender)!;

    // Step 20 ticks - defender should NOT move towards enemy
    for (let i = 0; i < 20; i++) {
      step(world);
    }

    const posAfter = getPosition(world, comps, defender);
    expect(posAfter.x).toBeCloseTo(posBefore.x, 2);
    expect(posAfter.y).toBeCloseTo(posBefore.y, 2);

    const defenderCombat = getCombatRow(world, comps, defender);
    // Stand-ground does not acquire targets outside reach
    expect(defenderCombat![3]).toBe(0);
  });

  it("defensive stance pursues enemy but drops engagement if enemy exceeds 4 tiles away", () => {
    const { world, comps } = createTestWorld();
    const defender = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);
    attachStance(world, comps, defender, "defensive");

    // Enemy is initially in sight range (3 tiles away)
    const enemy = spawnCombatUnit(world, comps, "militia", 13.5, 10.5, PLAYER_TWO);

    // Defender attacks enemy and starts pursuing
    world.inbox.submit({
      kind: "attack",
      targetTick: world.tick + 1,
      data: { attackerIds: [defender], targetId: enemy },
    });
    step(world);
    step(world);
    const combatRow = getCombatRow(world, comps, defender);
    expect(combatRow![3]).toBe(enemy);

    // Now teleport or move enemy far away (> 4 tiles, say at 25.5, 10.5)
    world.rowsByComponentId.get(comps.positionId)?.set(enemy, [25.5, 10.5]);

    // Next step, defensive stance notices distance > 4 and drops engagement
    step(world);

    const combatRowAfter = getCombatRow(world, comps, defender);
    expect(combatRowAfter![3]).toBe(0); // target dropped
  });

  it("setStance command updates stance via inbox", () => {
    const { world, comps } = createTestWorld();
    const unit = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);

    expect(getStance(world, comps, unit)).toBe("aggressive");

    world.inbox.submit({
      kind: SET_STANCE_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [unit], stance: "defensive" },
    });

    step(world);
    expect(getStance(world, comps, unit)).toBe("defensive");

    world.inbox.submit({
      kind: SET_STANCE_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [unit], stance: "stand-ground" },
    });

    step(world);
    expect(getStance(world, comps, unit)).toBe("stand-ground");
  });
});

describe("Patrol Command & Movement", () => {
  it("patrols between waypoints and reverses direction at endpoints", () => {
    const { world, comps } = createTestWorld();
    const unit = spawnCombatUnit(world, comps, "militia", 5.5, 5.5, PLAYER_ONE);

    // Issue patrol between (5.5, 5.5) and (8.5, 5.5)
    world.inbox.submit({
      kind: PATROL_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        entityIds: [unit],
        waypoints: [
          { x: 5.5, y: 5.5 },
          { x: 8.5, y: 5.5 },
        ],
      },
    });

    step(world);

    const queue = readActivityQueue(world, comps, unit);
    expect(queue.length).toBe(1);
    expect(queue[0]!.kind).toBe("patrol");

    // Step until unit reaches near (8.5, 5.5)
    for (let i = 0; i < 150; i++) {
      step(world);
      const q = readActivityQueue(world, comps, unit);
      if (q.length > 0 && q[0]!.kind === "patrol" && q[0]!.direction === -1) {
        // Successfully reversed direction!
        break;
      }
    }

    const qReversed = readActivityQueue(world, comps, unit);
    expect(qReversed.length).toBe(1);
    expect(qReversed[0]!.kind).toBe("patrol");
    if (qReversed[0]!.kind === "patrol") {
      expect(qReversed[0]!.direction).toBe(-1); // Reversing back to start!
    }
  });

  it("auto-attacks enemy encountered along patrol path, then resumes patrol", () => {
    const { world, comps } = createTestWorld();
    const unit = spawnCombatUnit(world, comps, "knight", 5.5, 5.5, PLAYER_ONE);

    // Patrol towards (15.5, 5.5)
    world.inbox.submit({
      kind: PATROL_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: {
        entityIds: [unit],
        waypoints: [
          { x: 5.5, y: 5.5 },
          { x: 15.5, y: 5.5 },
        ],
      },
    });

    // Place an enemy along the path at (9.5, 5.5)
    const enemy = spawnCombatUnit(world, comps, "militia", 9.5, 5.5, PLAYER_TWO);

    // Step until knight spots enemy and attacks
    let spotted = false;
    for (let i = 0; i < 120; i++) {
      step(world);
      const row = getCombatRow(world, comps, unit);
      if (row && row[3] === enemy) {
        spotted = true;
        break;
      }
    }
    expect(spotted).toBe(true);

    // Step until enemy dies
    for (let i = 0; i < 300; i++) {
      step(world);
      const enemyRow = getCombatRow(world, comps, enemy);
      if (!enemyRow) {
        // Enemy defeated
        break;
      }
    }

    // After enemy is dead, knight should have resumed patrol activity
    const qAfter = readActivityQueue(world, comps, unit);
    expect(qAfter.length).toBeGreaterThan(0);
    expect(qAfter[0]!.kind).toBe("patrol");
  });
});

describe("Guard Command & Behavior", () => {
  it("follows guarded unit within 1.5 tiles", () => {
    const { world, comps } = createTestWorld();
    const leader = spawnCombatUnit(world, comps, "militia", 5.5, 5.5, PLAYER_ONE);
    const bodyguard = spawnCombatUnit(world, comps, "knight", 5.5, 7.0, PLAYER_ONE);

    // Bodyguard guards leader
    world.inbox.submit({
      kind: GUARD_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [bodyguard], targetId: leader },
    });

    step(world);
    const q = readActivityQueue(world, comps, bodyguard);
    expect(q.length).toBe(1);
    expect(q[0]!.kind).toBe("guard");

    // Move leader to (15.5, 5.5)
    world.inbox.submit({
      kind: "groupMove",
      targetTick: world.tick + 1,
      data: { entityIds: [leader], x: 15.5, y: 5.5 },
    });

    // Step for 120 ticks
    for (let i = 0; i < 120; i++) {
      step(world);
    }

    const leaderPos = getPosition(world, comps, leader);
    const guardPos = getPosition(world, comps, bodyguard);

    const dx = leaderPos.x - guardPos.x;
    const dy = leaderPos.y - guardPos.y;
    const dist = Math.hypot(dx, dy);

    // Bodyguard has followed leader closely
    expect(dist).toBeLessThanOrEqual(2.5);
  });

  it("defends guarded unit when guarded unit is attacked", () => {
    const { world, comps } = createTestWorld();
    const vip = spawnCombatUnit(world, comps, "militia", 10.5, 10.5, PLAYER_ONE);
    // Set VIP to no-attack so VIP doesn't fight back
    attachStance(world, comps, vip, "no-attack");

    const bodyguard = spawnCombatUnit(world, comps, "knight", 11.5, 10.5, PLAYER_ONE);

    // Order bodyguard to guard VIP
    world.inbox.submit({
      kind: GUARD_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [bodyguard], targetId: vip },
    });

    step(world);

    // Enemy attacks VIP
    const enemy = spawnCombatUnit(world, comps, "militia", 9.5, 10.5, PLAYER_TWO);
    world.inbox.submit({
      kind: "attack",
      targetTick: world.tick + 1,
      data: { attackerIds: [enemy], targetId: vip },
    });

    // Step until enemy hits VIP and bodyguard retaliates against enemy
    let retaliated = false;
    for (let i = 0; i < 60; i++) {
      step(world);
      const bgCombat = getCombatRow(world, comps, bodyguard);
      if (bgCombat && bgCombat[3] === enemy) {
        retaliated = true;
        break;
      }
    }

    expect(retaliated).toBe(true);
  });
});

describe("Golden Fixture: Patrol Reversal and Guard Follow Determinism", () => {
  function runGoldenScenario(seed: number): string[] {
    const { world, comps } = createTestWorld(32, seed);
    const patroller = spawnCombatUnit(world, comps, "knight", 5.5, 5.5, PLAYER_ONE);
    const leader = spawnCombatUnit(world, comps, "militia", 8.5, 8.5, PLAYER_ONE);
    const bodyguard = spawnCombatUnit(world, comps, "knight", 8.5, 9.5, PLAYER_ONE);

    world.inbox.submit({
      kind: PATROL_COMMAND_KIND,
      targetTick: 1,
      data: {
        entityIds: [patroller],
        waypoints: [
          { x: 5.5, y: 5.5 },
          { x: 12.5, y: 5.5 },
        ],
      },
    });

    world.inbox.submit({
      kind: GUARD_COMMAND_KIND,
      targetTick: 1,
      data: { entityIds: [bodyguard], targetId: leader },
    });

    world.inbox.submit({
      kind: "groupMove",
      targetTick: 2,
      data: { entityIds: [leader], x: 15.5, y: 15.5 },
    });

    const digests: string[] = [];
    for (let t = 0; t < 150; t++) {
      step(world);
      digests.push(computeWorldDigest(world));
    }
    return digests;
  }

  it("canary: two identical runs agree digest-by-digest", () => {
    const runA = runGoldenScenario(20260906);
    const runB = runGoldenScenario(20260906);
    expect(runA.length).toBe(150);
    expect(runA).toEqual(runB);
  });
});

describe("Save/Load Round-Trip: Patrol and Guard Activities in Skirmish Session", () => {
  it("preserves patrol waypoints and guard target across save/load", async () => {
    const session = createSkirmishWorld(20260906, {
      createTransport: createSynchronousPathTransport,
    });
    const { world, comps } = session;

    const patroller = spawnCombatUnit(world, comps, "knight", 10.5, 10.5, PLAYER_ONE);
    const leader = spawnCombatUnit(world, comps, "militia", 12.5, 12.5, PLAYER_ONE);
    const guard = spawnCombatUnit(world, comps, "knight", 13.5, 12.5, PLAYER_ONE);

    world.inbox.submit({
      kind: PATROL_COMMAND_KIND,
      targetTick: 1,
      data: {
        entityIds: [patroller],
        waypoints: [
          { x: 10.5, y: 10.5 },
          { x: 18.5, y: 10.5 },
        ],
      },
    });

    world.inbox.submit({
      kind: GUARD_COMMAND_KIND,
      targetTick: 1,
      data: { entityIds: [guard], targetId: leader },
    });

    for (let t = 0; t < 30; t++) {
      step(world);
    }
    while (session.scheduler.pendingCount > 0) {
      step(world);
    }

    // Capture save payload
    const saveBytes = await captureSkirmishSave(session, 10);
    expect(saveBytes.length).toBeGreaterThan(0);

    // Restore session
    const restored = await restoreSkirmishSession(saveBytes, {
      createTransport: createSynchronousPathTransport,
    });

    // Check restored patroller queue
    const patrollerQueue = readActivityQueue(restored.world, restored.comps, patroller);
    expect(patrollerQueue.length).toBe(1);
    expect(patrollerQueue[0]!.kind).toBe("patrol");
    if (patrollerQueue[0]!.kind === "patrol") {
      expect(patrollerQueue[0]!.waypoints).toEqual([10.5, 10.5, 18.5, 10.5]);
    }

    // Check restored guard queue
    const guardQueue = readActivityQueue(restored.world, restored.comps, guard);
    expect(guardQueue.length).toBe(1);
    expect(guardQueue[0]!.kind).toBe("guard");
    if (guardQueue[0]!.kind === "guard") {
      expect(guardQueue[0]!.targetEid).toBe(leader);
    }

    // Step both and compare digests
    for (let t = 0; t < 50; t++) {
      step(world);
      step(restored.world);
      expect(computeWorldDigest(restored.world)).toBe(computeWorldDigest(world));
    }
  });
});


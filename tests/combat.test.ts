/**
 * Combat core unit tests — SPEC §2.5 / M2-T5.
 *
 * Covers the pieces that don't need a full golden run: the full
 * damage-counter table snapshotted straight from the loaded unit
 * definitions (every attacker × every defender), derived-stat tech
 * effects, the max(1, …) damage floor, engagement activity encoding,
 * and clean entity despawn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TECH_DEF_CODES,
  UNIT_DEFINITIONS,
  techCodeOf,
  unitDefOf,
} from "../src/data/definitions";
import { ARMOR_CLASSES } from "../src/data/schema";
import {
  attackActivity,
  attackMoveActivity,
  decodeActivities,
  encodeActivities,
  moveActivity,
} from "../src/sim/activities";
import {
  defineSimComponents,
  readActivityQueue,
  spawnCombatUnit,
  spawnUnit,
  writeActivityQueue,
  type SimComponents,
} from "../src/sim/components";
import { assignNode } from "../src/sim/components/economy";
import {
  getCombatRow,
  markTechResearched,
  researchedTechCodesOf,
} from "../src/sim/components/combat";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  despawnEntity,
  registerSystem,
  spawnEntity,
  step,
  type World,
} from "../src/sim/core/world";
import {
  STOP_COMMAND_KIND,
  createCombatDiagnostics,
  createCombatSystem,
} from "../src/sim/systems/combat";
import {
  bonusMultiplierOf,
  deriveUnitStats,
  strikeDamage,
} from "../src/sim/combat/stats";

const realRandom = Math.random;
const realDateNow = Date.now;

beforeEach(() => {
  Math.random = () => {
    throw new Error("sim purity violation: Math.random");
  };
  Date.now = () => {
    throw new Error("sim purity violation: Date.now");
  };
});

afterEach(() => {
  Math.random = realRandom;
  Date.now = realDateNow;
});

const UNIT_IDS = [...UNIT_DEFINITIONS.keys()].sort();

describe("damage counter table (SPEC §2.5)", () => {
  /**
   * The full N×N strike table GENERATED FROM DEFINITIONS: baseline
   * stats, no researched techs. Any content or formula change lands
   * here first.
   */
  it("snapshots every attacker × defender pairing", () => {
    const table: Record<string, Record<string, number>> = {};
    for (const attackerId of UNIT_IDS) {
      const attacker = unitDefOf(attackerId);
      const attackerStats = deriveUnitStats(attacker);
      table[attackerId] = {};
      for (const defenderId of UNIT_IDS) {
        const defender = unitDefOf(defenderId);
        table[attackerId]![defenderId] = strikeDamage(
          attacker,
          attackerStats,
          defender,
          deriveUnitStats(defender),
        );
      }
    }
    expect(table).toMatchSnapshot();
  });

  it("keeps every strike meaningful with a floor of 1", () => {
    for (const attackerId of UNIT_IDS) {
      const attacker = unitDefOf(attackerId);
      const attackerStats = deriveUnitStats(attacker);
      for (const defenderId of UNIT_IDS) {
        const defender = unitDefOf(defenderId);
        expect(
          strikeDamage(
            attacker,
            attackerStats,
            defender,
            deriveUnitStats(defender),
          ),
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("applies armor-class attack bonuses multiplicatively", () => {
    // Skirmisher ×3 vs archer-class targets (AoE2 skirmisher role).
    const skirmisher = unitDefOf("skirmisher");
    expect(bonusMultiplierOf(skirmisher, ["archer"])).toBe(3);
    expect(bonusMultiplierOf(skirmisher, ["infantry"])).toBe(1);
    expect(
      bonusMultiplierOf(skirmisher, ["archer", "infantry", "cavalry"]),
    ).toBe(3);
    // Knight raids civilians at ×1.5.
    const knight = unitDefOf("knight");
    expect(bonusMultiplierOf(knight, ["civilian"])).toBe(1.5);
    expect(bonusMultiplierOf(knight, ["cavalry"])).toBe(1);
  });

  it("derives ranged reach and reload from definitions", () => {
    const archerStats = deriveUnitStats(unitDefOf("archer"));
    expect(archerStats.range).toBe(4);
    expect(archerStats.reloadTicks).toBe(60);
    const militiaStats = deriveUnitStats(unitDefOf("militia"));
    expect(militiaStats.range).toBe(0.5); // schema melee default
    expect(militiaStats.reloadTicks).toBe(60);
  });

  it("zeros every armor class until techs contribute", () => {
    const stats = deriveUnitStats(unitDefOf("man-at-arms"));
    for (const armorClass of ARMOR_CLASSES) {
      expect(stats.armorByClass[armorClass]).toBe(0);
    }
    // Traits (M3) and equipment (M2-T6) contribute their documented
    // zero: baseline derivation equals raw definition numbers.
    expect(stats.attack).toBe(unitDefOf("man-at-arms").attack);
    expect(stats.speed).toBe(unitDefOf("man-at-arms").speed);
  });

  it("folds researched stat techs into derived stats on read", () => {
    const world = createWorld(7);
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE);

    markTechResearched(world, comps, PLAYER_ONE, techCodeOf("forging"));
    markTechResearched(world, comps, PLAYER_ONE, techCodeOf("scale-mail"));
    const codes = new Set(researchedTechCodesOf(world, comps, PLAYER_ONE));
    expect(codes.size).toBe(2);

    // Forging: class:infantry attack +1 → militia 4→5. Scale Mail:
    // melee+pierce armor +1 fold into the infantry pool → 2.
    const militiaStats = deriveUnitStats(unitDefOf("militia"), {
      researchedTechCodes: codes,
    });
    expect(militiaStats.attack).toBe(5);
    expect(militiaStats.armorByClass.infantry).toBe(2);
    // Non-matching classes stay untouched.
    expect(militiaStats.armorByClass.cavalry).toBe(0);

    // Armor changes the counter outcome: forged 5 attack − 2 armor → 3
    // (the attacker benefits from its own smithy techs too).
    const attackerStats = deriveUnitStats(unitDefOf("militia"), {
      researchedTechCodes: codes,
    });
    expect(
      strikeDamage(
        unitDefOf("militia"),
        attackerStats,
        unitDefOf("militia"),
        militiaStats,
      ),
    ).toBe(3);

    // Unresearched context derives the untouched 4-vs-4 baseline.
    expect(
      strikeDamage(
        unitDefOf("militia"),
        deriveUnitStats(unitDefOf("militia")),
        unitDefOf("militia"),
        deriveUnitStats(unitDefOf("militia")),
      ),
    ).toBe(4);
  });

  it("maps every registered tech code back to its definition", () => {
    // The derivation loop resolves codes through TECH_DEF_CODES; every
    // loaded tech must survive that inverse lookup.
    expect(TECH_DEF_CODES.size).toBeGreaterThan(0);
    for (const id of TECH_DEF_CODES.keys()) {
      expect(techCodeOf(id)).toBeGreaterThan(0);
    }
  });
});

describe("combat activities encode round-trip", () => {
  it("serializes attack and attackMove into the numeric stream", () => {
    const attack = attackActivity(42);
    const march = attackMoveActivity([10.5, 20.5]);
    const longMarch = attackMoveActivity([1.5, 2.5, 3.5, 4.5]);
    longMarch.cursor = 2;
    const queue = [attack, march, longMarch];
    const decoded = decodeActivities(encodeActivities(queue));
    expect(decoded).toEqual(queue);
  });

  it("rejects malformed attack payloads loudly", () => {
    expect(() => attackActivity(0)).toThrow(/positive integer/);
    expect(() => attackMoveActivity([1])).toThrow(/even number/);
    expect(() => decodeActivities([1, 5, 1, 0])).toThrow(/malformed target/);
  });
});

describe("entity despawn (death cleanup primitive)", () => {
  it("removes the entity and every component row at once", () => {
    const world = createWorld(9);
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE);
    const eid = spawnCombatUnit(world, comps, "militia", 4.5, 4.5, PLAYER_ONE);
    expect(rowsCount(world, comps.combatId)).toBe(1);

    expect(despawnEntity(world, eid)).toBe(true);
    expect(despawnEntity(world, eid)).toBe(false);
    expect(world.entities.includes(eid)).toBe(false);
    expect(rowsCount(world, comps.combatId)).toBe(0);
    for (const rows of world.rowsByComponentId.values()) {
      expect(rows.has(eid)).toBe(false);
    }

    // A later spawn allocates the NEXT id — dead ids never return.
    const next = spawnEntity(world);
    expect(next).toBe(eid + 1);
    expect(computeWorldDigest(world)).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });
});

describe("stop command (M2-T6, SPEC §2.13)", () => {
  function stopHarness(): {
    world: World;
    comps: SimComponents;
  } {
    const world = createWorld(11);
    const comps = defineSimComponents(world);
    registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));
    createPlayerStockpile(world, comps, PLAYER_ONE);
    createPlayerStockpile(world, comps, 1);
    return { world, comps };
  }

  it("cancels queues, drops engagements and releases claims", () => {
    const { world, comps } = stopHarness();
    const a = spawnCombatUnit(world, comps, "militia", 5.5, 5.5, PLAYER_ONE);
    const b = spawnCombatUnit(world, comps, "militia", 6.1, 5.5, 1);
    // A gather claim + an engagement to tear down.
    assignNode(world, comps, a, 99);
    world.inbox.submit({
      kind: "attack",
      targetTick: world.tick + 1,
      data: { attackerIds: [a], targetId: b },
    });
    step(world);
    expect(getCombatRow(world, comps, a)![3]).toBe(b);

    world.inbox.submit({
      kind: STOP_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [a, b] },
    });
    step(world);
    // Both sides halt cleanly: stopping only `a` would let b's ongoing
    // engagement re-trigger a-retaliation next strike (correct combat
    // behavior — stopped units still fight back when actively hit).
    expect(readActivityQueue(world, comps, a)).toEqual([]);
    expect(readActivityQueue(world, comps, b)).toEqual([]);
    expect(getCombatRow(world, comps, a)![3]).toBe(0);
    expect(getCombatRow(world, comps, b)![3]).toBe(0);
    expect(getAssignedNodeForTest(world, comps, a)).toBeUndefined();
  });

  it("stops villagers too — any ActivityQueue holder halts", () => {
    const { world, comps } = stopHarness();
    const villager = spawnUnit(world, comps, 8.5, 8.5, { baseSpeed: 1 });
    writeQueueMove(world, comps, villager);

    world.inbox.submit({
      kind: STOP_COMMAND_KIND,
      targetTick: world.tick + 1,
      data: { entityIds: [villager] },
    });
    step(world);
    expect(readActivityQueue(world, comps, villager)).toEqual([]);
  });

  function getAssignedNodeForTest(
    world: World,
    comps: SimComponents,
    eid: number,
  ): readonly number[] | undefined {
    return world.rowsByComponentId.get(comps.assignedNodeId)?.get(eid);
  }

  function writeQueueMove(
    world: World,
    comps: SimComponents,
    eid: number,
  ): void {
    writeActivityQueue(world, comps, eid, [moveActivity([9.5, 9.5])]);
  }
});

function rowsCount(world: World, componentId: number): number {
  return world.rowsByComponentId.get(componentId)!.size;
}

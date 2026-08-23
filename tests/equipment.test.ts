/**
 * Equipment system + derived-stat tests — SPEC §2.5 / M2-T6.
 *
 * Covers the equip command's ledger discipline (atomic multi-unit
 * debit from the CommodityStockpile, loud rejections for non-military
 * or unknown targets), the derived-stat fold (equipment counts never
 * stored, only read), and the pinned duel fixture: an equipped militia
 * kills a default-fisted twin measurably faster AND keeps more of its
 * own hp while doing it — "equipped military beats default-fisted".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unitDefOf } from "../src/data/definitions";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { getCombatRow } from "../src/sim/components/combat";
import {
  equipmentCountsOf,
  getEquipmentRow,
} from "../src/sim/components/equipment";
import {
  COMMODITY_ARMOR,
  COMMODITY_WEAPONS,
  PLAYER_ONE,
  commodityAmountOf,
  createCommodityStockpile,
  createPlayerStockpile,
  depositCommodityIntoStockpile,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  ARMOR_EQUIP_BONUS,
  WEAPON_ATTACK_BONUS,
  deriveUnitStats,
  strikeDamage,
} from "../src/sim/combat/stats";
import {
  EQUIP_COMMAND_KIND,
  createEquipmentSystem,
} from "../src/sim/systems/equipment";
import {
  ATTACK_COMMAND_KIND,
  createCombatDiagnostics,
  createCombatSystem,
} from "../src/sim/systems/combat";

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

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
}

function harness(weapons = 3, armor = 3): Harness {
  const world = createWorld(20260823);
  const comps = defineSimComponents(world);
  registerSystem(world, createEquipmentSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 200, 200, 0, 0, 0, 0]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  // Seed Forge outputs directly (production itself is M2-T3 coverage).
  for (let i = 0; i < weapons; i++) {
    depositCommodityIntoStockpile(
      world,
      comps,
      PLAYER_ONE,
      COMMODITY_WEAPONS,
      1,
    );
  }
  for (let i = 0; i < armor; i++) {
    depositCommodityIntoStockpile(world, comps, PLAYER_ONE, COMMODITY_ARMOR, 1);
  }
  return { world, comps };
}

function equip(h: Harness, unitIds: number[], item: string): void {
  h.world.inbox.submit({
    kind: EQUIP_COMMAND_KIND,
    targetTick: h.world.tick + 1,
    data: { unitIds, item },
  });
}

describe("equip command", () => {
  it("debits the commodity ledger and attaches Equipment rows", () => {
    const h = harness();
    const unit = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      5.5,
      5.5,
      PLAYER_ONE,
    );

    equip(h, [unit], "weapon");
    step(h.world);
    expect(getEquipmentRow(h.world, h.comps, unit)).toEqual([1, 0]);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_WEAPONS),
    ).toBe(2);

    equip(h, [unit], "armor");
    step(h.world);
    expect(getEquipmentRow(h.world, h.comps, unit)).toEqual([1, 1]);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_ARMOR),
    ).toBe(2);
    void equipmentCountsOf;
  });

  it("equips a whole squad in one order and debits once per item", () => {
    const h = harness(4, 4);
    const a = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      5.5,
      5.5,
      PLAYER_ONE,
    );
    const b = spawnCombatUnit(
      h.world,
      h.comps,
      "man-at-arms",
      8.5,
      5.5,
      PLAYER_ONE,
    );

    equip(h, [a, b], "weapon");
    step(h.world);
    expect(equipmentCountsOf(h.world, h.comps, a).weapons).toBe(1);
    expect(equipmentCountsOf(h.world, h.comps, b).weapons).toBe(1);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_WEAPONS),
    ).toBe(2);
  });

  it("is atomic across the squad: a short ledger equips nobody", () => {
    const h = harness(1, 0);
    const a = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      5.5,
      5.5,
      PLAYER_ONE,
    );
    const b = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      8.5,
      5.5,
      PLAYER_ONE,
    );

    equip(h, [a, b], "weapon"); // needs 2, ledger holds 1
    expect(() => step(h.world)).toThrow(/weapons/);
    expect(
      commodityAmountOf(h.world, h.comps, PLAYER_ONE, COMMODITY_WEAPONS),
    ).toBe(1);
    expect(getEquipmentRow(h.world, h.comps, a)).toBeUndefined();
    expect(getEquipmentRow(h.world, h.comps, b)).toBeUndefined();
  });

  it("rejects non-combatants and unknown slots loudly", () => {
    const h = harness();
    const villager = spawnUnit(h.world, h.comps, 5.5, 5.5);
    equip(h, [villager], "weapon");
    expect(() => step(h.world)).toThrow(/no Combat row/);

    const monk = spawnCombatUnit(
      h.world,
      h.comps,
      "monk",
      7.5,
      5.5,
      PLAYER_ONE,
    );
    equip(h, [monk], "armor"); // monk carries no equipmentSlots at all
    expect(() => step(h.world)).toThrow(/equipment slot/);

    const militia = spawnCombatUnit(
      h.world,
      h.comps,
      "militia",
      9.5,
      5.5,
      PLAYER_ONE,
    );
    equip(h, [militia], "shield");
    expect(() => step(h.world)).toThrow(/item must be/);
  });
});

describe("derived stats fold equipment on read", () => {
  it("adds flat attack per weapon and armor over owned classes", () => {
    const militia = unitDefOf("militia");
    const baseline = deriveUnitStats(militia);
    expect(baseline.attack).toBe(4);
    expect(baseline.armorByClass.infantry).toBe(0);

    const equipped = deriveUnitStats(militia, {
      equipment: { weapons: 1, armor: 1 },
    });
    expect(equipped.attack).toBe(4 + WEAPON_ATTACK_BONUS);
    expect(equipped.armorByClass.infantry).toBe(ARMOR_EQUIP_BONUS);
    // Untagged classes stay untouched.
    expect(equipped.armorByClass.cavalry).toBe(0);

    const stacked = deriveUnitStats(militia, {
      equipment: { weapons: 2, armor: 2 },
    });
    expect(stacked.attack).toBe(4 + 2 * WEAPON_ATTACK_BONUS);
    expect(stacked.armorByClass.infantry).toBe(2 * ARMOR_EQUIP_BONUS);
  });

  it("changes strike outcomes both ways of the duel", () => {
    const militia = unitDefOf("militia");
    const bare = deriveUnitStats(militia);
    const equipped = deriveUnitStats(militia, {
      equipment: { weapons: 1, armor: 1 },
    });
    // Equipped lands 4+2 − 0 = 6 on the bare twin…
    expect(strikeDamage(militia, equipped, militia, bare)).toBe(6);
    // …and the bare twin only chips 4 − 1 = 3 back.
    expect(strikeDamage(militia, bare, militia, equipped)).toBe(3);
  });
});

describe("pinned duel fixture: equipped beats default-fisted", () => {
  interface DuelResult {
    readonly killTick: number;
    readonly winnerHp: number;
  }

  /**
   * One militia (player 0) brawls another militia (player 1) standing
   * inside melee reach. Both auto-retaliate, so the duel runs itself
   * on the reload cadence until the loser dies. `equipAttacker`
   * decides whether player 0 marches in with Forge gear.
   */
  function runDuel(equipAttacker: boolean): DuelResult {
    const world = createWorld(77);
    const comps = defineSimComponents(world);
    registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));
    registerSystem(world, createEquipmentSystem(comps));
    createPlayerStockpile(world, comps, PLAYER_ONE);
    createPlayerStockpile(world, comps, 1);
    createCommodityStockpile(world, comps, PLAYER_ONE);

    const attacker = spawnCombatUnit(
      world,
      comps,
      "militia",
      10.5,
      10.5,
      PLAYER_ONE,
    );
    const defender = spawnCombatUnit(world, comps, "militia", 11.1, 10.5, 1);
    if (equipAttacker) {
      depositCommodityIntoStockpile(
        world,
        comps,
        PLAYER_ONE,
        COMMODITY_WEAPONS,
        1,
      );
      depositCommodityIntoStockpile(
        world,
        comps,
        PLAYER_ONE,
        COMMODITY_ARMOR,
        1,
      );
      world.inbox.submit({
        kind: EQUIP_COMMAND_KIND,
        targetTick: 1,
        data: { unitIds: [attacker], item: "weapon" },
      });
      world.inbox.submit({
        kind: EQUIP_COMMAND_KIND,
        targetTick: 1,
        data: { unitIds: [attacker], item: "armor" },
      });
    }
    world.inbox.submit({
      kind: ATTACK_COMMAND_KIND,
      targetTick: 2,
      data: { attackerIds: [attacker], targetId: defender },
    });

    let winnerHp = -1;
    let killTick = -1;
    while (world.tick < 3000) {
      step(world);
      if (!world.entities.includes(defender)) {
        killTick = world.tick;
        winnerHp = getCombatRow(world, comps, attacker)![2]!;
        break;
      }
    }
    if (killTick < 0) throw new Error("duel never concluded");
    return { killTick, winnerHp };
  }

  it("the equipped militia ends the duel earlier and healthier", () => {
    const bareRun = runDuel(false);
    const gearedRun = runDuel(true);

    // Both duels conclude with the defender dead.
    expect(bareRun.killTick).toBeGreaterThan(0);
    expect(gearedRun.killTick).toBeGreaterThan(0);
    // Measurable delta #1: weapons +2 / armor +1 close the fight sooner.
    expect(gearedRun.killTick).toBeLessThan(bareRun.killTick);
    // Measurable delta #2: the winner keeps strictly more hp — armor
    // chips the return fire from 4 down to 3 per strike.
    expect(gearedRun.winnerHp).toBeGreaterThan(bareRun.winnerHp);
    expect(gearedRun.winnerHp).toBeGreaterThan(0);
  });
});

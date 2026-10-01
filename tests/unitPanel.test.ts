import { describe, expect, it } from "vitest";
import {
  formatUnitCardTitle,
  formatUnitHpBar,
  formatUnitStats,
  groupUnitsByType,
  type SelectedUnitSummary,
} from "../src/ui/unitPanel";

function makeUnit(
  eid: number,
  unitId: string,
  hp: number,
  maxHp: number,
  opts: Partial<SelectedUnitSummary> = {},
): SelectedUnitSummary {
  return {
    eid,
    unitId,
    name: unitId.charAt(0).toUpperCase() + unitId.slice(1),
    hp,
    maxHp,
    attack: 8,
    armor: 1,
    speed: 1.2,
    ownerId: 0,
    isMilitary: true,
    ...opts,
  };
}

describe("unitPanel formatUnitHpBar", () => {
  it("formats healthy units (>50%) as green", () => {
    const res = formatUnitHpBar(90, 100);
    expect(res.pct).toBe(90);
    expect(res.color).toBe("#22c55e");
    expect(res.label).toBe("90 / 100");
  });

  it("formats damaged units (26-50%) as yellow", () => {
    const res = formatUnitHpBar(40, 100);
    expect(res.pct).toBe(40);
    expect(res.color).toBe("#eab308");
    expect(res.label).toBe("40 / 100");
  });

  it("formats critical units (<=25%) as red", () => {
    const res = formatUnitHpBar(15, 100);
    expect(res.pct).toBe(15);
    expect(res.color).toBe("#ef4444");
    expect(res.label).toBe("15 / 100");
  });

  it("clamps out-of-range hp values", () => {
    const over = formatUnitHpBar(150, 100);
    expect(over.pct).toBe(100);
    expect(over.label).toBe("100 / 100");

    const under = formatUnitHpBar(-10, 100);
    expect(under.pct).toBe(0);
    expect(under.label).toBe("0 / 100");
  });
});

describe("unitPanel formatUnitCardTitle", () => {
  it("formats unnamed unit with definition name", () => {
    const unit = makeUnit(1, "knight", 100, 100);
    expect(formatUnitCardTitle(unit)).toBe("Knight");
  });

  it("includes pop name when unit has an individual identity", () => {
    const unit = makeUnit(1, "villager", 25, 25, { popName: "Alric" });
    expect(formatUnitCardTitle(unit)).toBe("Alric (Villager)");
  });
});

describe("unitPanel formatUnitStats", () => {
  it("formats melee unit stats line", () => {
    const unit = makeUnit(1, "militia", 40, 40, {
      attack: 6,
      armor: 1,
      speed: 0.9,
    });
    const stats = formatUnitStats(unit);
    expect(stats).toContain("⚔ 6");
    expect(stats).toContain("🛡 1");
    expect(stats).toContain("🏃 0.9");
    expect(stats).not.toContain("🏹");
  });

  it("includes range for ranged units", () => {
    const unit = makeUnit(2, "archer", 30, 30, {
      attack: 4,
      armor: 0,
      range: 4,
      speed: 1.0,
    });
    const stats = formatUnitStats(unit);
    expect(stats).toContain("🏹 4");
  });
});

describe("unitPanel groupUnitsByType", () => {
  it("aggregates units by unitId", () => {
    const units: SelectedUnitSummary[] = [
      makeUnit(1, "knight", 100, 100),
      makeUnit(2, "knight", 80, 100),
      makeUnit(3, "archer", 30, 30),
      makeUnit(4, "villager", 25, 25),
    ];

    const groups = groupUnitsByType(units);
    expect(groups.length).toBe(3);

    const knightGroup = groups.find((g) => g.unitId === "knight");
    expect(knightGroup).toBeDefined();
    expect(knightGroup?.count).toBe(2);
    expect(knightGroup?.totalHp).toBe(180);
    expect(knightGroup?.totalMaxHp).toBe(200);

    const archerGroup = groups.find((g) => g.unitId === "archer");
    expect(archerGroup?.count).toBe(1);
  });
});

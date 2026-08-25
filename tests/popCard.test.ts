/**
 * Pop card exporter & formatters — SPEC §2.13 / M3-T9 (issue #54).
 *
 * The sim-side read-row exporter (sim/popCard.ts) must surface every
 * card field from digest-visible rows; the UI formatting helpers turn
 * that data into the card's lines. No DOM here — the seam stays
 * unbroken, exactly like the other chrome modules.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getCombatRow,
  spawnCombatUnit,
  spawnUnit,
} from "../src/sim/components";
import { setComponentValues } from "../src/sim/core/world";
import {
  addInjuryStack,
  BODY_PART_LEG_L,
  BODY_PART_SLUGS,
  BODY_PART_TORSO,
} from "../src/sim/components/body";
import { enterRouting } from "../src/sim/components/morale";
import { awardPractice, grantKnowledge } from "../src/sim/systems/skills";
import { activityLabelOf, buildPopCard } from "../src/sim/popCard";
import {
  formatBodyStrip,
  formatImpairmentLine,
  formatMoraleLine,
  formatPopCardTitle,
  formatSkillBarLabel,
} from "../src/ui/popCard";
import {
  attackActivity,
  eatActivity,
  gatherActivity,
  leisureActivity,
  sleepActivity,
  LEISURE_VENUE_TAVERN,
} from "../src/sim/activities";
import { createWorld } from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";

function world(): ReturnType<typeof createWorld> {
  return createWorld(20260824, {
    layers: buildLayers(
      new Uint8Array(16 * 16).fill(TERRAIN_GRASS),
      new Uint8Array(16 * 16),
    ),
  });
}

describe("activity labels", () => {
  it("names every queue head a card can show", () => {
    expect(activityLabelOf(undefined)).toBe("Idle");
    expect(
      activityLabelOf({ kind: "move", waypoints: [1, 2], cursor: 0 }),
    ).toBe("Walking");
    expect(activityLabelOf(gatherActivity(10))).toBe("Gathering");
    expect(activityLabelOf(attackActivity(3))).toBe("Fighting");
    expect(activityLabelOf(eatActivity(2))).toBe("Eating");
    expect(activityLabelOf(sleepActivity(50))).toBe("Sleeping");
    expect(activityLabelOf(sleepActivity(50, true))).toBe("Napping");
    expect(activityLabelOf(leisureActivity(LEISURE_VENUE_TAVERN, 2))).toBe(
      "At the tavern",
    );
  });
});

describe("buildPopCard exporter", () => {
  it("returns undefined for entities without an Identity row", () => {
    const w = world();
    const comps = defineSimComponents(w);
    // A bare spawned entity (no rows at all) and a villager without
    // identity both have no card.
    const rowless = spawnUnit(w, comps, 5.5, 5.5);
    expect(buildPopCard(w, comps, rowless)).toBeUndefined();
  });

  it("renders every field for a fresh named arrival", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, {
      identity: true,
      body: true,
      morale: true,
    });
    const card = buildPopCard(w, comps, eid)!;
    expect(card).toBeDefined();
    expect(card.name.length).toBeGreaterThan(0);
    expect(card.ageDays).toBeGreaterThan(0); // arrivals start adult-aged
    expect(card.lifestage).toBe("adult");
    expect(card.originLabel).toBe("arrival");
    expect(card.traits.length).toBeGreaterThanOrEqual(1);
    expect(card.skills).toEqual([]); // novice sheet untouched
    expect(card.bodyParts.map((part) => part.part)).toEqual([
      ...BODY_PART_SLUGS,
    ]);
    for (const part of card.bodyParts) {
      expect(part.status).toBe("healthy");
    }
    expect(card.injuries).toEqual([]);
    expect(card.scars).toEqual([]);
    expect(card.hp).toBeUndefined(); // not a combatant
    expect(card.morale).toEqual({ value: 100, breakPoint: 12, routing: false });
    expect(card.activity).toBe("Idle");
  });

  it("splits knowledge vs practice on the skill bars", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, { identity: true });
    grantKnowledge(w, comps, eid, "gathering", 500);
    awardPractice(w, comps, eid, "gathering", 500);
    awardPractice(w, comps, eid, "gathering", 500); // practice pulls ahead
    const card = buildPopCard(w, comps, eid)!;
    expect(card.skills).toHaveLength(1);
    const bar = card.skills[0]!;
    expect(bar.slug).toBe("gathering");
    expect(bar.level).toBeGreaterThanOrEqual(1);
    // 500 of 1500 total XP is theory.
    expect(bar.knowledgeShare01).toBeCloseTo(500 / 1500, 6);
    expect(formatSkillBarLabel(bar)).toMatch(
      /^gathering \d+ \(33% knowledge\)$/,
    );
  });

  it("shows per-part injury status and permanent scars", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, {
      identity: true,
      body: true,
    });
    // Canonical Body row in hand-written shape ([stackCount, stacks…,
    // scarCount, scars…]): one open torso wound + one head scar.
    setComponentValues(w, comps.bodyId, eid, [
      1,
      BODY_PART_TORSO,
      40,
      1500,
      1,
      2, // head
      55,
    ]);
    const card = buildPopCard(w, comps, eid)!;
    const torso = card.bodyParts.find((part) => part.part === "torso")!;
    const headPart = card.bodyParts.find((part) => part.part === "head")!;
    expect(torso.status).toBe("injured");
    expect(torso.severity).toBe(40);
    expect(headPart.status).toBe("scarred");
    expect(card.injuries).toHaveLength(1);
    expect(card.scars).toHaveLength(1);
    expect(formatBodyStrip(card)).toContain("torso:injured 40");
    expect(formatBodyStrip(card)).toContain("head:scarred");
  });

  it("reflects combat hp and the routing override", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnCombatUnit(w, comps, "militia", 5.5, 5.5, 0, {
      identity: true,
      body: true,
      morale: true,
    });
    getCombatRow(w, comps, eid)![2] = 17;
    enterRouting(
      w.rowsByComponentId.get(comps.moraleId)!.get(eid)!,
      99,
      w.tick,
    );
    const card = buildPopCard(w, comps, eid)!;
    expect(card.hp).toEqual({ current: 17, max: 40 });
    expect(card.morale?.routing).toBe(true);
    expect(card.activity).toBe("Fleeing!");
    expect(formatMoraleLine(card)).toContain("ROUTING");
  });

  it("surfaces the derived impairment multipliers (M5-T4 §2.13)", () => {
    const w = world();
    const comps = defineSimComponents(w);
    // Healthy: neutral — the card hides the line entirely.
    const healthy = spawnUnit(w, comps, 5.5, 5.5, {
      identity: true,
      body: true,
    });
    const okCard = buildPopCard(w, comps, healthy)!;
    expect(okCard.impairments).toEqual({
      speedMult: 1,
      attackMult: 1,
      workMult: 1,
    });
    expect(formatImpairmentLine(okCard)).toBe("");
    // One open leg wound at half group capacity: legs shave speed by
    // IMPAIRMENT_MAX_PENALTY_PCT × 0.5 → ×0.75; arms/vitals untouched.
    const hurt = spawnUnit(w, comps, 6.5, 5.5, {
      identity: true,
      body: true,
    });
    addInjuryStack(w, comps, hurt, BODY_PART_LEG_L, 50, 1500);
    const card = buildPopCard(w, comps, hurt)!;
    expect(card.impairments.speedMult).toBeCloseTo(0.75, 6);
    expect(card.impairments.workMult).toBe(1);
    expect(card.impairments.attackMult).toBe(1);
    expect(formatImpairmentLine(card)).toBe("impairs speed ×0.75");
  });

  it("omits the break point for Pops without a Morale row", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, { identity: true }); // no morale
    const card = buildPopCard(w, comps, eid)!;
    expect(card.morale).toBeDefined();
    expect(card.morale?.breakPoint).toBeUndefined();
    expect(card.morale?.routing).toBe(false);
    expect(formatMoraleLine(card)).toBe(
      `morale ${String(card.morale!.value)}/100`,
    );
  });
});

describe("pop card formatters", () => {
  it("formats the title line", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, { identity: true });
    const card = buildPopCard(w, comps, eid)!;
    expect(formatPopCardTitle(card)).toBe(
      `${card.name} · ${card.ageDays.toFixed(1)} days · adult · arrival`,
    );
  });

  it("formats the morale line with the derived break point", () => {
    const w = world();
    const comps = defineSimComponents(w);
    const eid = spawnUnit(w, comps, 5.5, 5.5, {
      identity: true,
      morale: true,
    });
    const card = buildPopCard(w, comps, eid)!;
    expect(formatMoraleLine(card)).toBe("morale 100/100 · breaks ≤ 12");
  });
});

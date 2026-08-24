/**
 * Social system — SPEC §2.4 leisure, bonds & rivals / M3-T7 (issue #52).
 *
 * Pins the evening machine end to end through the SHARED command
 * interface (the brain emits exactly these leisure commands):
 *   - venue outings execute on arrival: gold sinks debit the owner
 *     ledger, morale lands, and digest-visible SocialEvents rows record
 *     every completed visit;
 *   - visits accumulate pairwise Relationship values (capped at ±100)
 *     and lift both moods when the host is home;
 *   - strong bonds BUFFER a morale shock (the T9 seam): a fully-bonded
 *     Pop shrugs off 60% of one;
 *   - a married brothel visitor rolls discovery: spouse morale shock,
 *     marriage-pair damage, JEALOUSY event rows;
 *   - a bonded Pop's death at a living killer's hand forms a RIVAL in
 *     one stroke (RIVAL_FORMED row, pair driven to/below −50).
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readNeeds,
  setNeedLevels,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { spawnCombatUnit } from "../src/sim/components/combat";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  LEISURE_VENUE_BROTHEL,
  LEISURE_VENUE_TAVERN,
  LEISURE_VENUE_VISIT,
} from "../src/sim/activities";
import {
  BROTHEL_GOLD_COST,
  TAVERN_GOLD_COST,
  VISIT_BOND_INCREMENT,
  applyBufferedMoraleShock,
  createSocialDiagnostics,
  createSocialSystem,
  type SocialDiagnostics,
} from "../src/sim/systems/social";
import { createCombatSystem } from "../src/sim/systems/combat";
import { spawnHousehold } from "../src/sim/components/household";
import {
  BOND_CAP,
  RIVAL_THRESHOLD,
  adjustRelationship,
  relationshipValueOf,
  setRelationship,
  strongestBondOf,
} from "../src/sim/components/relationship";
import {
  SOCIAL_EVENT_JEALOUSY,
  SOCIAL_EVENT_RIVAL_FORMED,
  SOCIAL_EVENT_VISIT,
  readSocialEvents,
} from "../src/sim/components/socialEvents";
import { traitCodeOf } from "../src/sim/data/traits";
import { unitCodeOf, unitDefOf } from "../src/data/definitions";
import type { LifecycleConfig } from "../src/sim/systems/lifecycle";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 32;
/** Compressed clock: 600-tick days so jealousy rolls rotate quickly. */
const DAY_TICKS = 600;
const CONFIG: LifecycleConfig = {
  dayTicks: DAY_TICKS,
  adultAgeDays: 3,
  elderAgeDays: 12,
  lifespanDays: 15,
};

interface Scenario {
  readonly world: World;
  readonly comps: SimComponents;
  readonly social: SocialDiagnostics;
}

function openWorld(seed: number, gold = 500): Scenario {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createCombatSystem(comps, undefined, scheduler));
  const social = createSocialDiagnostics();
  registerSystem(
    world,
    createSocialSystem({ comps, lifecycleConfig: CONFIG, diagnostics: social }),
  );
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 600, gold, 0, 0, 0, 0]);
  return { world, comps, social };
}

/** Force one Pop's Traits row to exactly one slug (test staging). */
function forceTraits(s: Scenario, eid: number, slug: string): void {
  s.world.rowsByComponentId
    .get(s.comps.traitsId)!
    .set(eid, [traitCodeOf(slug)]);
}

/** Submit a leisure order through the shared inbox (the brain's shape). */
function bookLeisure(
  s: Scenario,
  eid: number,
  venueCode: number,
  targetEid: number,
  x: number,
  y: number,
): void {
  s.world.inbox.submit({
    kind: "leisure",
    targetTick: s.world.tick + 1,
    data: { entityIds: [eid], venueCode, targetEid, x, y },
  });
}

/** Step until one more outing resolves (completes or bounces broke). */
function awaitLeisureDone(s: Scenario): void {
  const before = s.social.leisuresCompleted + s.social.brokeArrivals;
  for (let guard = 0; guard < DAY_TICKS * 2; guard++) {
    step(s.world);
    if (s.social.leisuresCompleted + s.social.brokeArrivals > before) return;
  }
  throw new Error("leisure outing never completed");
}

installSimPurityShims();

describe("venue outings", () => {
  it("sinks tavern gold from the owner ledger and buffs morale", () => {
    const s = openWorld(20260824);
    const tavern = stampFinishedBuilding(s.world, s.comps, "tavern", 14, 14, {
      playerId: PLAYER_ONE,
    });
    const pop = spawnUnit(s.world, s.comps, 6.5, 6.5, { identity: true });
    setNeedLevels(s.world, s.comps, pop, { food: 100, rest: 100, morale: 40 });

    bookLeisure(s, pop, LEISURE_VENUE_TAVERN, tavern, 15, 15);
    awaitLeisureDone(s);

    expect(stockpileAmountsOf(s.world, s.comps, PLAYER_ONE)[2]).toBe(
      500 - TAVERN_GOLD_COST,
    );
    expect(readNeeds(s.world, s.comps, pop)!.morale).toBe(55);
    expect(s.social.goldSpent).toBe(TAVERN_GOLD_COST);
    // The evening landed on the owner's SocialEvents log with its sink.
    const events = readSocialEvents(s.world, s.comps, PLAYER_ONE);
    expect(
      events.some(
        (e) => e.kind === SOCIAL_EVENT_VISIT && e.amount === -TAVERN_GOLD_COST,
      ),
    ).toBe(true);
  });

  it("brothel is the bigger sink", () => {
    const s = openWorld(20260824);
    const brothel = stampFinishedBuilding(s.world, s.comps, "brothel", 14, 14, {
      playerId: PLAYER_ONE,
    });
    const pop = spawnUnit(s.world, s.comps, 6.5, 6.5, { identity: true });

    bookLeisure(s, pop, LEISURE_VENUE_BROTHEL, brothel, 15, 15);
    awaitLeisureDone(s);

    expect(stockpileAmountsOf(s.world, s.comps, PLAYER_ONE)[2]).toBe(
      500 - BROTHEL_GOLD_COST,
    );
    expect(BROTHEL_GOLD_COST).toBeGreaterThan(TAVERN_GOLD_COST);
  });

  it("a broke arrival cancels politely without going into debt", () => {
    const s = openWorld(20260824, /* gold */ 2);
    const brothel = stampFinishedBuilding(s.world, s.comps, "brothel", 14, 14, {
      playerId: PLAYER_ONE,
    });
    const pop = spawnUnit(s.world, s.comps, 6.5, 6.5, { identity: true });

    bookLeisure(s, pop, LEISURE_VENUE_BROTHEL, brothel, 15, 15);
    awaitLeisureDone(s);

    expect(stockpileAmountsOf(s.world, s.comps, PLAYER_ONE)[2]).toBe(2);
    expect(s.social.brokeArrivals).toBe(1);
  });
});

describe("social bonds", () => {
  it("visits accumulate pairwise bonds toward the cap", () => {
    const s = openWorld(20260824);
    const houseA = stampFinishedBuilding(s.world, s.comps, "house", 8, 8, {
      playerId: PLAYER_ONE,
    });
    const houseB = stampFinishedBuilding(s.world, s.comps, "house", 20, 8, {
      playerId: PLAYER_ONE,
    });
    void houseB;
    const host = spawnUnit(s.world, s.comps, 9.5, 10.5, { identity: true });
    // Clear of both footprints — a Pop stamped inside a building can
    // never steer out.
    const guest = spawnUnit(s.world, s.comps, 21.5, 10.5, { identity: true });
    spawnHousehold(s.world, s.comps, {
      playerId: PLAYER_ONE,
      homeEid: houseA,
      headEid: host,
      partnerEid: guest,
      nextBirthRollTick: 999999999,
    });

    for (let i = 0; i < 12; i++) {
      // Aim at the household center like the brain's visit candidates do;
      // the system plans a perimeter door from it.
      bookLeisure(s, guest, LEISURE_VENUE_VISIT, host, 9, 9);
      awaitLeisureDone(s);
    }

    const bond = relationshipValueOf(s.world, s.comps, guest, host)!;
    expect(bond).toBeGreaterThan(0);
    expect(bond).toBeLessThanOrEqual(BOND_CAP);
    // Twelve visits × +10 would overshoot; the cap holds at exactly 100.
    expect(bond).toBe(Math.min(BOND_CAP, 12 * VISIT_BOND_INCREMENT));
    // Both parties enjoyed the evenings.
    expect(readNeeds(s.world, s.comps, host)!.morale).toBeGreaterThan(90);
  });

  it("strong bonds buffer a morale shock (the T9 seam)", () => {
    const s = openWorld(20260824);
    const bonded = spawnUnit(s.world, s.comps, 8.5, 8.5, { identity: true });
    const friend = spawnUnit(s.world, s.comps, 9.5, 8.5, { identity: true });
    const lonely = spawnUnit(s.world, s.comps, 10.5, 8.5, { identity: true });
    setRelationship(s.world, s.comps, bonded, friend, BOND_CAP);

    expect(strongestBondOf(s.world, s.comps, bonded)).toBe(BOND_CAP);
    expect(strongestBondOf(s.world, s.comps, lonely)).toBe(0);

    const appliedBonded = applyBufferedMoraleShock(
      s.world,
      s.comps,
      bonded,
      20,
    );
    const appliedLonely = applyBufferedMoraleShock(
      s.world,
      s.comps,
      lonely,
      20,
    );

    expect(appliedLonely).toBe(20);
    expect(appliedBonded).toBe(Math.round(20 * 0.4)); // 60% buffered
    expect(readNeeds(s.world, s.comps, bonded)!.morale).toBe(
      100 - appliedBonded,
    );
    expect(readNeeds(s.world, s.comps, lonely)!.morale).toBe(80);
  });

  it("bond values clamp at both rails", () => {
    const s = openWorld(20260824);
    const a = spawnUnit(s.world, s.comps, 8.5, 8.5, { identity: true });
    const b = spawnUnit(s.world, s.comps, 9.5, 8.5, { identity: true });
    setRelationship(s.world, s.comps, a, b, 99);
    expect(adjustRelationship(s.world, s.comps, a, b, 50)).toBe(BOND_CAP);
    setRelationship(s.world, s.comps, a, b, -99);
    expect(adjustRelationship(s.world, s.comps, a, b, -50)).toBe(-BOND_CAP);
    // Canonical pair key: either argument order reads the same row.
    expect(relationshipValueOf(s.world, s.comps, b, a)).toBe(-BOND_CAP);
  });
});

describe("jealousy & rivals", () => {
  it("married brothel visitors risk discovery — shock, damage, drama rows", () => {
    const s = openWorld(777001);
    const house = stampFinishedBuilding(s.world, s.comps, "house", 8, 8, {
      playerId: PLAYER_ONE,
    });
    const brothel = stampFinishedBuilding(s.world, s.comps, "brothel", 22, 22, {
      playerId: PLAYER_ONE,
    });
    const husband = spawnUnit(s.world, s.comps, 9.5, 10.5, { identity: true });
    const wife = spawnUnit(s.world, s.comps, 8.5, 9.5, { identity: true });
    spawnHousehold(s.world, s.comps, {
      playerId: PLAYER_ONE,
      homeEid: house,
      headEid: husband,
      partnerEid: wife,
      nextBirthRollTick: 999999999,
    });
    forceTraits(s, husband, "hedonist");
    forceTraits(s, wife, "jealous");
    setNeedLevels(s.world, s.comps, wife, { food: 100, rest: 100, morale: 80 });

    // Evening after evening at the brothel until discovery fires (the
    // roll is seeded per (seed, visitor, day); jealous spouse doubles it).
    for (let day = 0; day < 12 && s.social.jealousyEvents === 0; day++) {
      setNeedLevels(s.world, s.comps, wife, {
        food: 100,
        rest: 100,
        morale: 80,
      });
      bookLeisure(s, husband, LEISURE_VENUE_BROTHEL, brothel, 23, 23);
      awaitLeisureDone(s);
      // Advance into the next compressed day so the roll domain rotates.
      while (s.world.tick % DAY_TICKS !== 0) step(s.world);
    }

    expect(s.social.jealousyEvents).toBeGreaterThanOrEqual(1);
    // The spouse took the shock and the marriage took the damage.
    expect(readNeeds(s.world, s.comps, wife)!.morale).toBeLessThan(80);
    expect(
      relationshipValueOf(s.world, s.comps, husband, wife)!,
    ).toBeLessThanOrEqual(-35);
    const events = readSocialEvents(s.world, s.comps, PLAYER_ONE);
    expect(events.some((e) => e.kind === SOCIAL_EVENT_JEALOUSY)).toBe(true);
  });

  it("a bonded friend's death at a living killer's hand forms a rival", () => {
    const s = openWorld(20260824);
    const victim = spawnUnit(s.world, s.comps, 8.5, 8.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    const survivor = spawnUnit(s.world, s.comps, 9.5, 8.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    setRelationship(s.world, s.comps, survivor, victim, 50);

    // Named Pops carry no Combat row by default; stage one so the
    // villager is a legal attack target (spawnCombatUnit layout).
    s.world.rowsByComponentId
      .get(s.comps.combatId)!
      .set(victim, [
        unitCodeOf("villager"),
        PLAYER_ONE,
        unitDefOf("villager").hp,
        0,
        0,
      ]);

    const militia = spawnCombatUnit(s.world, s.comps, "militia", 20.5, 20.5, 1);
    // The killer's strikes log on its owner's ledger — give player 1 one.
    createPlayerStockpile(s.world, s.comps, 1, [0, 0, 0, 0, 0, 0, 0]);
    s.world.inbox.submit({
      kind: "attack",
      targetTick: s.world.tick + 1,
      data: { attackerIds: [militia], targetId: victim },
    });
    let guard = 0;
    while (
      s.world.rowsByComponentId.get(s.comps.unitTagId)!.has(victim) &&
      guard < 4000
    ) {
      step(s.world);
      guard += 1;
    }
    expect(guard).toBeLessThan(4000); // the death really happened

    // The grudge drives the (survivor, killer) pair past the threshold.
    expect(s.social.grudgesApplied).toBe(1);
    expect(
      relationshipValueOf(s.world, s.comps, survivor, militia)!,
    ).toBeLessThanOrEqual(RIVAL_THRESHOLD);
    expect(s.social.rivalriesFormed).toBe(1);
    const events = readSocialEvents(s.world, s.comps, PLAYER_ONE);
    expect(events.some((e) => e.kind === SOCIAL_EVENT_RIVAL_FORMED)).toBe(true);
  });
});

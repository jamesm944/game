/**
 * Morale, routing & rally unit tests — SPEC §2.5 / M3-T9 (issue #54).
 *
 * Covers the pieces the golden battle pins only implicitly: the derived
 * break point (traits/melee/wounds), the shock pipeline (family and
 * companion deaths through the real CombatEvents ledgers, buffered by
 * bond strength per the T7 API), break→route with flee geometry and
 * order suppression, rally-by-ally recovery, safe exits, self-damage
 * shocks, and routers that never fight back under fire.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getCombatRow,
  readActivityQueue,
  readNeeds,
  setNeedLevels,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import { addInjuryStack, BODY_PART_TORSO } from "../src/sim/components/body";
import { setRelationship } from "../src/sim/components/relationship";
import { spawnHousehold } from "../src/sim/components/household";
import { enterRouting, isRoutingOf } from "../src/sim/components/morale";
import { traitCodeOf } from "../src/sim/data/traits";
import { xpToReachLevel } from "../src/sim/data/skills";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  createWorld,
  despawnEntity,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../src/sim/systems/combat";
import {
  COMPANION_DEATH_MORALE_SHOCK,
  FAMILY_DEATH_MORALE_SHOCK,
  MORALE_BREAK_BASE,
  MORALE_BREAK_BRAVE_DELTA,
  MORALE_BREAK_COWARD_DELTA,
  MORALE_BREAK_PER_MELEE_LEVEL,
  MORALE_BREAK_PER_WOUND_FRACTION,
  SELF_DAMAGE_MORALE_SHOCK,
  createMoraleDiagnostics,
  createMoraleSystem,
  moraleBreakPointOf,
  type MoraleDiagnostics,
} from "../src/sim/systems/morale";
import { awardPractice } from "../src/sim/systems/skills";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

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

installSimPurityShims();

const SEED = 20260824;

interface Harness {
  world: World;
  comps: SimComponents;
  diagnostics: MoraleDiagnostics;
}

/** Combat + morale over an all-grass map; both players have ledgers. */
function harness(): Harness {
  const world = createWorld(SEED, {
    layers: buildLayers(
      new Uint8Array(40 * 40).fill(TERRAIN_GRASS),
      new Uint8Array(40 * 40),
    ),
  });
  const comps = defineSimComponents(world);
  const diagnostics = createMoraleDiagnostics();
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));
  registerSystem(world, createMoraleSystem(comps, diagnostics));
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);
  return { world, comps, diagnostics };
}

/**
 * A named militia soldier carrying needs + morale. The trait sheet is
 * pinned (default traitless ⇒ the documented base break point) so no
 * seeded brave/coward roll shifts a fixture's thresholds.
 */
function soldier(
  h: Harness,
  x: number,
  y: number,
  owner: number,
  traits: readonly string[] = [],
): number {
  const eid = spawnCombatUnit(h.world, h.comps, "militia", x, y, owner, {
    identity: true,
    body: true,
    morale: true,
  });
  h.world.rowsByComponentId.get(h.comps.traitsId)!.set(
    eid,
    traits.map((slug) => traitCodeOf(slug)),
  );
  return eid;
}

function moraleOf(h: Harness, eid: number): number {
  return readNeeds(h.world, h.comps, eid)!.morale;
}

function orderAttack(
  h: Harness,
  attackerIds: readonly number[],
  targetId: number,
): void {
  h.world.inbox.submit({
    kind: "attack",
    targetTick: h.world.tick + 1,
    data: { attackerIds: [...attackerIds], targetId },
  });
}

describe("derived break point (SPEC §2.5, computed on read)", () => {
  it("gives a plain Pop exactly the base point", () => {
    const h = harness();
    const eid = soldier(h, 5.5, 5.5, PLAYER_ONE);
    expect(moraleBreakPointOf(h.world, h.comps, eid)).toBe(MORALE_BREAK_BASE);
  });

  it("brave holds longer, coward breaks sooner", () => {
    const h = harness();
    const brave = soldier(h, 5.5, 5.5, PLAYER_ONE, ["brave"]);
    const coward = soldier(h, 6.5, 5.5, PLAYER_ONE, ["coward"]);
    expect(moraleBreakPointOf(h.world, h.comps, brave)).toBe(
      MORALE_BREAK_BASE + MORALE_BREAK_BRAVE_DELTA,
    );
    expect(moraleBreakPointOf(h.world, h.comps, coward)).toBe(
      MORALE_BREAK_BASE + MORALE_BREAK_COWARD_DELTA,
    );
  });

  it("melee veterancy steadies nerves", () => {
    const h = harness();
    const veteran = soldier(h, 5.5, 5.5, PLAYER_ONE);
    awardPractice(h.world, h.comps, veteran, "melee", xpToReachLevel(3));
    expect(moraleBreakPointOf(h.world, h.comps, veteran)).toBe(
      MORALE_BREAK_BASE + MORALE_BREAK_PER_MELEE_LEVEL * 3,
    );
  });

  it("open wounds raise the point by the documented fraction", () => {
    const h = harness();
    const wounded = soldier(h, 5.5, 5.5, PLAYER_ONE);
    addInjuryStack(h.world, h.comps, wounded, BODY_PART_TORSO, 50, 1500);
    expect(moraleBreakPointOf(h.world, h.comps, wounded)).toBe(
      MORALE_BREAK_BASE + Math.round(MORALE_BREAK_PER_WOUND_FRACTION * 0.5),
    );
  });
});

describe("bond-buffered vs unbuffered death shock (measurable)", () => {
  it("a strong bond lands measurably less companion shock than a weak one", () => {
    const h = harness();
    // Victim dies to E's one blow; two COMPANION witnesses watch from
    // beyond any threat radius so nothing routes and the meters tell
    // the tale: same shock, different bond strengths, different landings.
    const victim = soldier(h, 12.5, 12.5, PLAYER_ONE);
    const strongBond = soldier(h, 3.5, 3.5, PLAYER_ONE);
    const weakBond = soldier(h, 30.5, 30.5, PLAYER_ONE);
    const enemy = soldier(h, 13.1, 12.5, 1);
    setRelationship(h.world, h.comps, strongBond, victim, 80);
    setRelationship(h.world, h.comps, weakBond, victim, 20);
    for (const eid of [strongBond, weakBond]) {
      setNeedLevels(h.world, h.comps, eid, {
        food: 100,
        rest: 100,
        morale: 100,
      });
    }
    getCombatRow(h.world, h.comps, victim)![2] = 2; // dies to one blow

    orderAttack(h, [enemy], victim);
    step(h.world); // strike lands, victim dies, morale consumes the log

    expect(readNeeds(h.world, h.comps, victim)).toBeUndefined(); // dead
    const strongLoss = 100 - moraleOf(h, strongBond);
    const weakLoss = 100 - moraleOf(h, weakBond);
    // Both qualify as companions (≥ COMPANION_BOND_MIN). The T7 buffer
    // at bond 80 absorbs 48% (22 → 11); at bond 20 it absorbs 12%
    // (22 → 19). The strong bond measurably cushions the grief.
    expect(strongLoss).toBe(Math.round(COMPANION_DEATH_MORALE_SHOCK * 0.52));
    expect(weakLoss).toBe(Math.round(COMPANION_DEATH_MORALE_SHOCK * 0.88));
    expect(strongLoss).toBeLessThan(weakLoss);
    expect(h.diagnostics.shockApplied).toBe(strongLoss + weakLoss);
    // Neither routed: no living hostile within any of their radii.
    expect(h.diagnostics.routedTotal).toBe(0);
  });

  it("family deaths shock household members with the full weight", () => {
    const h = harness();
    const homeEid = stampFinishedBuilding(h.world, h.comps, "house", 4, 4, {
      playerId: PLAYER_ONE,
    });
    const head = soldier(h, 2.9, 6.5, PLAYER_ONE);
    const partner = soldier(h, 4.2, 6.5, PLAYER_ONE);
    spawnHousehold(h.world, h.comps, {
      playerId: PLAYER_ONE,
      homeEid,
      headEid: head,
      partnerEid: partner,
      nextBirthRollTick: 999_999_999,
    });
    const enemy = soldier(h, 4.9, 6.5, 1); // adjacent — schedulerless reach
    getCombatRow(h.world, h.comps, partner)![2] = 2;

    orderAttack(h, [enemy], partner);
    step(h.world);

    // No bond between the spouses: the FULL family shock lands…
    expect(100 - moraleOf(h, head)).toBe(FAMILY_DEATH_MORALE_SHOCK);
    // …and nobody routes: a meter of 70 sits far above any break point.
    expect(h.diagnostics.routedTotal).toBe(0);
  });
});

describe("self-damage shock", () => {
  it("every landed blow stings the victim's own meter", () => {
    const h = harness();
    const target = soldier(h, 12.5, 12.5, PLAYER_ONE);
    const enemy = soldier(h, 13.1, 12.5, 1);
    setNeedLevels(h.world, h.comps, target, {
      food: 100,
      rest: 100,
      morale: 50,
    });
    orderAttack(h, [enemy], target);
    step(h.world);
    expect(moraleOf(h, target)).toBe(50 - SELF_DAMAGE_MORALE_SHOCK);
    expect(isRoutingOf(h.world, h.comps, target)).toBe(false);
  });
});

describe("routing + rally fixture (issue #54 acceptance)", () => {
  interface RoutingFixture {
    h: Harness;
    victim: number;
    witness: number;
    enemy: number;
  }

  /**
   * A bonded pair meets an enemy; the witness sits rattled at morale 20
   * (above the base break point of 12). One blow kills the companion,
   * the buffered shock pushes the witness below the point, and they
   * route. `withAlly` parks a full-morale ally inside rally radius.
   */
  function routingFixture(withAlly: boolean): RoutingFixture & {
    rallyAlly: number | undefined;
  } {
    const h = harness();
    const victim = soldier(h, 12.5, 12.5, PLAYER_ONE);
    // The witness stands INSIDE the enemy's melee reach so the
    // schedulerless fixture can actually trade blows (no movement
    // system here), but WEST of it so flight points away.
    const witness = soldier(h, 12.4, 12.5, PLAYER_ONE);
    const enemy = soldier(h, 13.1, 12.5, 1);
    const rallyAlly = withAlly ? soldier(h, 10.0, 14.0, PLAYER_ONE) : undefined;
    setRelationship(h.world, h.comps, witness, victim, 80);
    setNeedLevels(h.world, h.comps, witness, {
      food: 100,
      rest: 100,
      morale: 20,
    });
    getCombatRow(h.world, h.comps, victim)![2] = 2; // dies to one blow
    return { h, victim, witness, enemy, rallyAlly };
  }

  function fleeLegTail(
    h: Harness,
    eid: number,
  ): { x: number; y: number } | undefined {
    const head = readActivityQueue(h.world, h.comps, eid)[0];
    if (head === undefined || head.kind !== "move") return undefined;
    return {
      x: head.waypoints[head.waypoints.length - 2]!,
      y: head.waypoints[head.waypoints.length - 1]!,
    };
  }

  function breakTheWitness(fixture: RoutingFixture): void {
    orderAttack(fixture.h, [fixture.enemy], fixture.victim);
    step(fixture.h.world); // strike, death, shock, break — all in one tick
  }

  it("breaks into flight away from the threat and ignores orders until rallied", () => {
    const { h, victim, witness, enemy, rallyAlly } = routingFixture(true);
    expect(rallyAlly).toBeDefined();
    void victim;

    breakTheWitness({ h, victim, witness, enemy });

    // BROKEN: the buffered companion shock (round(22·0.52) = 11) drops
    // the witness from 20 to 9, below the base break point of 12.
    expect(moraleOf(h, witness)).toBe(9);
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(true);
    expect(h.diagnostics.routedTotal).toBe(1);
    expect(
      h.world.rowsByComponentId.get(h.comps.moraleId)!.get(witness)![1],
    ).toBe(enemy);
    // Flee geometry: the leg aims WEST — away from the eastern threat.
    const tail = fleeLegTail(h, witness)!;
    expect(tail.x).toBeLessThan(12.4 - 4);
    expect(Math.abs(tail.y - 12.5)).toBeLessThan(0.01);
    const moveTarget = h.world.rowsByComponentId
      .get(h.comps.moveTargetId)!
      .get(witness)!;
    expect(moveTarget[0]).toBe(tail.x);
    expect(moveTarget[1]).toBe(tail.y);

    // ORDERS IGNORED while routing: an explicit attack order cannot
    // stick — combat sheds the router's engagement before the strike
    // pass and the morale pass re-stamps the flee leg the same tick.
    orderAttack(h, [witness], enemy);
    step(h.world);
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(true);
    expect(readActivityQueue(h.world, h.comps, witness)[0]?.kind).toBe("move");
    expect(getCombatRow(h.world, h.comps, witness)![3]).toBe(0);
    expect(h.diagnostics.ordersSuppressed).toBeGreaterThanOrEqual(1);

    // RALLIED: the adjacent full-morale ally restores 6 per rare pass
    // until the meter clears the break point plus margin.
    let steps = 0;
    while (isRoutingOf(h.world, h.comps, witness) && steps < 4000) {
      step(h.world);
      steps += 1;
    }
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(false);
    expect(steps).toBeLessThan(4000);
    expect(h.diagnostics.ralliesApplied).toBeGreaterThanOrEqual(1);
    expect(h.diagnostics.ralliedExits).toBe(1);
    expect(h.diagnostics.safeExits).toBe(0);
    expect(moraleOf(h, witness)).toBeGreaterThanOrEqual(
      moraleBreakPointOf(h.world, h.comps, witness) + 10,
    );

    // ORDERS STICK AGAIN once steady: the same order engages normally.
    orderAttack(h, [witness], enemy);
    step(h.world);
    expect(getCombatRow(h.world, h.comps, witness)![3]).toBe(enemy);
  });

  it("routers keep taking hits but never fight back", () => {
    const { h, victim, witness, enemy } = routingFixture(false);
    breakTheWitness({ h, victim, witness, enemy });
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(true);

    // The enemy mows the router down: the router's own target column
    // stays pinned at zero until the death it cannot prevent. Strikes
    // land on the 60-tick reload cadence.
    const hpBefore = getCombatRow(h.world, h.comps, witness)![2]!;
    expect(hpBefore).toBeGreaterThan(0);
    let guard = 0;
    while (guard < 3000) {
      orderAttack(h, [enemy], witness);
      step(h.world);
      if (isRoutingOf(h.world, h.comps, witness)) {
        expect(getCombatRow(h.world, h.comps, witness)![3]).toBe(0);
      }
      guard += 1;
      if (getCombatRow(h.world, h.comps, witness) === undefined) break;
    }
    expect(guard).toBeLessThan(3000); // actually died
    expect(getCombatRow(h.world, h.comps, witness)).toBeUndefined(); // down
  });

  it("exits through the SAFE door when the threat dies", () => {
    const { h, victim, witness, enemy } = routingFixture(false);
    breakTheWitness({ h, victim, witness, enemy });
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(true);

    despawnEntity(h.world, enemy);
    step(h.world);
    expect(isRoutingOf(h.world, h.comps, witness)).toBe(false);
    expect(h.diagnostics.safeExits).toBe(1);
    expect(h.diagnostics.ralliedExits).toBe(0);
    // Safe ≠ recovered: the meter keeps its wound well under the exit…
    expect(moraleOf(h, witness)).toBeLessThan(
      moraleBreakPointOf(h.world, h.comps, witness) + 10,
    );
    // …and the flight queue is dropped — the Pop stands down.
    expect(readActivityQueue(h.world, h.comps, witness)).toEqual([]);
  });
});

describe("routing state rows", () => {
  it("enter/exit stamp and clear the digest-visible flags", () => {
    const h = harness();
    const eid = soldier(h, 5.5, 5.5, PLAYER_ONE);
    const row = h.world.rowsByComponentId.get(h.comps.moraleId)!.get(eid)!;
    expect(row).toEqual([0, 0, 0]);
    enterRouting(row, 42, h.world.tick);
    expect(row).toEqual([1, 42, 0]);
    expect(isRoutingOf(h.world, h.comps, eid)).toBe(true);
  });
});

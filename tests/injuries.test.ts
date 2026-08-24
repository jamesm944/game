/**
 * Injuries & impairments unit tests — SPEC §2.5 / M3-T4 (issue #49).
 *
 * Covers the pieces that don't need a full golden run: the seeded
 * strike→part allocation weights (torso/head 50, arms 30, legs 20),
 * impairment multipliers degrading movement/attack/gather from stacked
 * wounds, the heal-vs-scar-vs-death outcome machine pinned across
 * seeds, wound-death routing through the death pipeline with claim
 * release, and rowless no-op compatibility.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachBody,
  BODY_PART_ARM_L,
  BODY_PART_HEAD,
  BODY_PART_LEG_L,
  BODY_PART_TORSO,
  bodyRowOf,
  cumulativeActiveSeverityFromRow,
  addInjuryStack,
  injuryImpairmentOf,
  readInjuries,
  readScars,
} from "../src/sim/components/body";
import {
  defineSimComponents,
  setMoveTarget,
  spawnUnit,
  writeActivityQueue,
  type SimComponents,
} from "../src/sim/components";
import { assignNode } from "../src/sim/components/economy";
import { moveActivity } from "../src/sim/activities";
import { unitDefOf } from "../src/data/definitions";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  applyStrikeInjuries,
  createInjuriesSystem,
  HEAL_SEVERITY_PER_RARE_TICK,
  INJURY_DURATION_TICKS,
  PART_WEIGHT_BASIS_POINTS,
  partCodeForRoll,
  strikePartRoll,
} from "../src/sim/systems/injuries";
import { deriveUnitStats, strikeDamage } from "../src/sim/combat/stats";
import { resolveGatherInterval } from "../src/sim/systems/skills";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

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

function makeWorld(seed: number): {
  world: World;
  comps: SimComponents;
} {
  const world = createWorld(seed);
  const comps = defineSimComponents(world);
  return { world, comps };
}

/** A Pop with an Owner row + player ledger (wound deaths can log). */
function spawnWoundedPop(
  world: World,
  comps: SimComponents,
  x: number,
  y: number,
): number {
  createPlayerStockpile(world, comps, PLAYER_ONE);
  return spawnUnit(world, comps, x, y, { ownerId: PLAYER_ONE });
}

// ---- Seeded allocation -------------------------------------------------------------

describe("strike→part allocation (#49 weights)", () => {
  it("rolls land inside the documented group bands", () => {
    // Deterministic sweep over a (seed × victim × tick × stack) grid:
    // torso+head 50%, arms 30%, legs 20% — band edges live in
    // PART_WEIGHT_BASIS_POINTS.
    let torsoHead = 0;
    let arms = 0;
    let legs = 0;
    const samples = 60_000;
    for (let i = 0; i < samples; i++) {
      const roll = strikePartRoll(1000 + i, i % 97, i % 997, i % 5);
      if (roll < PART_WEIGHT_BASIS_POINTS[1]!) torsoHead += 1;
      else if (roll < PART_WEIGHT_BASIS_POINTS[3]!) arms += 1;
      else legs += 1;
    }
    expect(torsoHead / samples).toBeGreaterThan(0.48);
    expect(torsoHead / samples).toBeLessThan(0.52);
    expect(arms / samples).toBeGreaterThan(0.28);
    expect(arms / samples).toBeLessThan(0.32);
    expect(legs / samples).toBeGreaterThan(0.18);
    expect(legs / samples).toBeLessThan(0.22);
  });

  it("is a pure function of (seed, victim, tick, stacks)", () => {
    expect(strikePartRoll(42, 7, 100, 2)).toBe(strikePartRoll(42, 7, 100, 2));
    // Any input change re-rolls (statistical spot-check on four axes).
    const base = strikePartRoll(42, 7, 100, 2);
    const variants = [
      strikePartRoll(43, 7, 100, 2),
      strikePartRoll(42, 8, 100, 2),
      strikePartRoll(42, 7, 101, 2),
      strikePartRoll(42, 7, 100, 3),
    ];
    expect(variants.some((variant) => variant !== base)).toBe(true);
  });

  it("allocates combat strikes to Body rows, same seed ⇒ same wounds", () => {
    const outcomes: string[] = [];
    for (const seed of [5, 6, 7]) {
      const { world, comps } = makeWorld(seed);
      const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
      attachBody(world, comps, eid);
      world.tick = 9;
      for (let blow = 0; blow < 4; blow++) {
        applyStrikeInjuries(world, comps, eid, 3);
      }
      const injuries = readInjuries(world, comps, eid)!;
      expect(injuries.length).toBeGreaterThan(0);
      // Severity conservation: 4 blows × 3 damage × 2 severity/damage.
      expect(injuries.reduce((total, entry) => total + entry.severity, 0)).toBe(
        24,
      );
      outcomes.push(JSON.stringify(injuries));
    }
    expect(new Set(outcomes).size).toBe(outcomes.length);
  });
});

// ---- Impairments -------------------------------------------------------------------

describe("impairment multipliers degrade speed/attack/work", () => {
  it("leg wounds slow movement measurably", () => {
    const runDistance = (woundedLegSeverity: number): number => {
      const scheduler = new PathScheduler(createSynchronousPathTransport());
      const world = createWorld(20260824, {
        size: 24,
        layers: buildLayers(
          new Uint8Array(24 * 24).fill(TERRAIN_GRASS),
          new Uint8Array(24 * 24),
        ),
        pathScheduler: scheduler,
      });
      const comps = defineSimComponents(world);
      registerSystem(world, createMovementSystem(comps, scheduler));
      const eid = spawnUnit(world, comps, 4.5, 12.0, { baseSpeed: 1 });
      attachBody(world, comps, eid);
      if (woundedLegSeverity > 0) {
        addInjuryStack(
          world,
          comps,
          eid,
          BODY_PART_LEG_L,
          woundedLegSeverity,
          INJURY_DURATION_TICKS,
        );
      }
      writeActivityQueue(world, comps, eid, [moveActivity([16.5, 12.0])]);
      // The MoveTarget row must agree with the march (stall recovery
      // re-paths against it — a stale row drags the unit home).
      setMoveTarget(world, comps, eid, 16.5, 12.0);
      for (let tick = 0; tick < 300; tick++) step(world);
      const pos = world.rowsByComponentId.get(comps.positionId)!.get(eid)!;
      return pos[0]! - 4.5;
    };

    const healthy = runDistance(0);
    const wounded = runDistance(50); // half-capacity leg trauma → ×0.75

    expect(wounded).toBeLessThan(healthy);
    const ratio = wounded / healthy;
    expect(ratio).toBeGreaterThan(0.72);
    expect(ratio).toBeLessThan(0.78);
  });

  it("arm wounds dull attack and slow gathering", () => {
    const { world, comps } = makeWorld(11);
    const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
    attachBody(world, comps, eid);
    addInjuryStack(
      world,
      comps,
      eid,
      BODY_PART_ARM_L,
      40,
      INJURY_DURATION_TICKS,
    );

    // Derived attack scales by the arm factor (aim, SPEC §2.5).
    const impairment = injuryImpairmentOf(world, comps, eid);
    expect(impairment.attackMult).toBeCloseTo(0.8, 10);
    const militia = unitDefOf("militia");
    const woundedStats = deriveUnitStats(militia, {
      impairment: {
        attackMult: impairment.attackMult,
        speedMult: impairment.speedMult,
      },
    });
    expect(woundedStats.attack).toBeCloseTo(3.2, 10);
    // And the counter formula feels it through the derived stats.
    expect(
      strikeDamage(militia, woundedStats, militia, deriveUnitStats(militia)),
    ).toBe(3); // floor(4 × 0.8) − 0

    // Gather interval stretches: base ticks divided by the work factor.
    const twin = spawnUnit(world, comps, 9.5, 9.5, {});
    attachBody(world, comps, twin);
    expect(resolveGatherInterval(world, comps, twin, 30)).toBe(30);
    expect(resolveGatherInterval(world, comps, eid, 30)).toBe(38); // round(30/0.8)
  });

  it("head/torso vitals degrade everything at once", () => {
    const { world, comps } = makeWorld(13);
    const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
    attachBody(world, comps, eid);
    addInjuryStack(
      world,
      comps,
      eid,
      BODY_PART_HEAD,
      60,
      INJURY_DURATION_TICKS,
    );
    addInjuryStack(
      world,
      comps,
      eid,
      BODY_PART_TORSO,
      40,
      INJURY_DURATION_TICKS,
    );
    const impairment = injuryImpairmentOf(world, comps, eid);
    expect(impairment.speedMult).toBeCloseTo(0.5, 10);
    expect(impairment.attackMult).toBeCloseTo(0.5, 10);
    expect(impairment.workMult).toBeCloseTo(0.5, 10);
  });

  it("clamps per-part capacity and ignores rowless entities", () => {
    const { world, comps } = makeWorld(17);
    const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
    attachBody(world, comps, eid);
    const stored = addInjuryStack(
      world,
      comps,
      eid,
      BODY_PART_LEG_L,
      250,
      INJURY_DURATION_TICKS,
    );
    expect(stored).toBe(100); // clamped to PART_INJURY_CAPACITY
    expect(cumulativeActiveSeverityFromRow(bodyRowOf(world, comps, eid)!)).toBe(
      100,
    );
    // A saturated limb ignores overflow entirely.
    expect(
      addInjuryStack(
        world,
        comps,
        eid,
        BODY_PART_LEG_L,
        10,
        INJURY_DURATION_TICKS,
      ),
    ).toBe(0);

    // Rowless entity: allocation no-ops non-fatally, multipliers neutral.
    const bare = spawnUnit(world, comps, 8.5, 8.5, {});
    expect(applyStrikeInjuries(world, comps, bare, 5)).toEqual({
      storedSeverity: 0,
      fatal: false,
    });
    expect(injuryImpairmentOf(world, comps, bare)).toEqual({
      speedMult: 1,
      attackMult: 1,
      workMult: 1,
    });
  });
});

// ---- Heal vs scar vs death -----------------------------------------------------------

describe("heal-vs-scar-vs-death outcomes (deterministic across seeds)", () => {
  const SEEDS = [3, 44, 555, 20260824];

  function advanceRareTicks(
    world: World,
    comps: SimComponents,
    eid: number,
    rareTicks: number,
  ): void {
    registerSystemOnce(world, comps);
    let processed = 0;
    while (processed < rareTicks) {
      const before = world.tick;
      step(world);
      if (world.tick !== before && (world.tick + eid) % 250 === 0) {
        processed += 1;
      }
    }
  }

  const systemsByWorld = new WeakMap<World, SimComponents>();
  function registerSystemOnce(world: World, comps: SimComponents): void {
    if (systemsByWorld.get(world) !== comps) {
      systemsByWorld.set(world, comps);
      registerSystem(world, createInjuriesSystem(comps));
    }
  }

  it("light wounds heal clean; heavy ones scar permanently", () => {
    for (const seed of SEEDS) {
      const { world, comps } = makeWorld(seed);
      const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
      attachBody(world, comps, eid);
      // Light: drains fully inside its recovery window → clean heal.
      addInjuryStack(
        world,
        comps,
        eid,
        BODY_PART_LEG_L,
        12,
        INJURY_DURATION_TICKS,
      );
      // Heavy: cannot drain 30 severity in six rare ticks (18 max) →
      // heals-at-full-severity into a permanent residual scar.
      addInjuryStack(
        world,
        comps,
        eid,
        BODY_PART_TORSO,
        30,
        INJURY_DURATION_TICKS,
      );

      advanceRareTicks(world, comps, eid, 7);

      expect(readInjuries(world, comps, eid)).toEqual([]);
      const scars = readScars(world, comps, eid)!;
      expect(scars).toEqual([
        {
          part: "torso",
          severity: 30 - 6 * HEAL_SEVERITY_PER_RARE_TICK,
        },
      ]);
      // Scar permanence: further time never removes it.
      advanceRareTicks(world, comps, eid, 20);
      expect(readScars(world, comps, eid)).toEqual(scars);
      expect(readInjuries(world, comps, eid)).toEqual([]);
    }
  });

  it("cumulative severity past the threshold kills through the death pipeline", () => {
    for (const seed of SEEDS) {
      const { world, comps } = makeWorld(seed);
      const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
      attachBody(world, comps, eid);
      // Two heavy stacks on distinct parts — cumulative 130 exceeds the
      // whole-body threshold regardless of where strikes would land.
      addInjuryStack(
        world,
        comps,
        eid,
        BODY_PART_LEG_L,
        65,
        INJURY_DURATION_TICKS,
      );
      addInjuryStack(
        world,
        comps,
        eid,
        BODY_PART_TORSO,
        65,
        INJURY_DURATION_TICKS,
      );
      // A held job claim dies with the entity (claims ARE rows).
      assignNode(world, comps, eid, 999);
      const digestBefore = computeWorldDigest(world);

      advanceRareTicks(world, comps, eid, 1);

      expect(world.entities.includes(eid)).toBe(false);
      for (const rows of world.rowsByComponentId.values()) {
        expect(rows.has(eid)).toBe(false);
      }
      expect(computeWorldDigest(world)).not.toBe(digestBefore);
      const deaths = readAllCombatEvents(world, comps).filter(
        (entry) => entry.kind === 3,
      );
      expect(deaths.length).toBe(1);
      expect(deaths[0]!.victimEid).toBe(eid);
      expect(deaths[0]!.attackerEid).toBe(0); // nobody landed the blow
    }
  });

  it("combat strikes turn lethal by accumulated wounds alone", () => {
    // Pre-load one leg to 90 severity, then land ONE 30-damage blow.
    // The seeded roll picks the part; the test reads that roll first
    // and pre-loads a DIFFERENT part so the blow always stores its full
    // 60 severity → cumulative 150 crosses the threshold with NO hp
    // involvement at all. Same seed ⇒ same verdict, forever.
    for (const seed of [21, 77, 2026]) {
      const { world, comps } = makeWorld(seed);
      const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
      attachBody(world, comps, eid);
      world.tick = 5;
      const roll = strikePartRoll(seed, eid, 5, 1); // stackCount after preload
      const struckPart = partCodeForRoll(roll);
      const preloadedPart =
        struckPart === BODY_PART_LEG_L ? BODY_PART_TORSO : BODY_PART_LEG_L;
      addInjuryStack(
        world,
        comps,
        eid,
        preloadedPart,
        90,
        INJURY_DURATION_TICKS,
      );

      const outcome = applyStrikeInjuries(world, comps, eid, 30);
      expect(outcome.storedSeverity).toBe(60);
      expect(outcome.fatal).toBe(true);
      // The caller routes this through its kill pipeline; no hp was
      // ever touched — wounds alone were lethal.
    }
  });

  it("replays bit-identically: same seed, same wound ledger", () => {
    const run = (): string => {
      const { world, comps } = makeWorld(20260824);
      const eid = spawnWoundedPop(world, comps, 4.5, 4.5);
      attachBody(world, comps, eid);
      world.tick = 3;
      for (let blow = 0; blow < 6; blow++) {
        applyStrikeInjuries(world, comps, eid, 4);
      }
      advanceRareTicks(world, comps, eid, 3);
      return JSON.stringify([
        readInjuries(world, comps, eid),
        readScars(world, comps, eid),
        computeWorldDigest(world),
      ]);
    };
    expect(run()).toBe(run());
  });
});

// ---- Shared helpers ------------------------------------------------------------------

interface RawCombatEvent {
  readonly kind: number;
  readonly victimEid: number;
  readonly attackerEid: number;
  readonly amount: number;
}

function readAllCombatEvents(
  world: World,
  comps: SimComponents,
): RawCombatEvent[] {
  const out: RawCombatEvent[] = [];
  for (const ledgerEid of world.rowsByComponentId
    .get(comps.stockpileId)!
    .keys()) {
    const row = world.rowsByComponentId
      .get(comps.combatEventsId)
      ?.get(ledgerEid);
    if (!row) continue;
    for (let i = 0; i < row[0]!; i++) {
      out.push({
        kind: row[2 + i * 5]!,
        attackerEid: row[3 + i * 5]!,
        victimEid: row[4 + i * 5]!,
        amount: row[5 + i * 5]!,
      });
    }
  }
  return out;
}

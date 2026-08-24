/**
 * Sunday Morning Mass — SPEC §2.4 weekly cycle / M3-T8 (issue #53).
 *
 * Pins the communal half of the rest day end to end:
 *   - pure band math (isMassTime, massBookingTickFor) on both clocks;
 *   - BOOKING: with a finished Church, every adult books a staggered
 *     [Move, Leisure{MASS}] chain inside the Sunday morning band — once
 *     (cooldown + queue guards), children never, and nothing without a
 *     church or off the rest day;
 *   - EXPIRY: stale Mass heads are cancelled without effects once the
 *     band closes;
 *   - EXECUTION (through the social system): arriving attendees take
 *     the broad morale buff (Pious add their extra weight), reinforce
 *     bonds pairwise with co-attendees gathered at the church, log a
 *     SocialEvent MASS row, and stamp the one-outing cooldown.
 */
import { describe, expect, it } from "vitest";
import {
  LEISURE_VENUE_MASS,
  enqueueActivity,
  leisureActivity,
} from "../src/sim/activities";
import {
  defineSimComponents,
  readActivityQueue,
  readNeeds,
  setNeedLevels,
  spawnUnit,
  writeActivityQueue,
} from "../src/sim/components";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { POP_ORIGIN_BIRTH } from "../src/sim/components/pop";
import {
  SOCIAL_EVENT_MASS,
  readSocialEvents,
} from "../src/sim/components/socialEvents";
import { relationshipValueOf } from "../src/sim/components/relationship";
import { jobCooldownActive } from "../src/sim/components/jobCooldown";
import { traitCodeOf } from "../src/sim/data/traits";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  normalizeLifecycleConfig,
} from "../src/sim/systems/lifecycle";
import {
  MASS_CLOSE_MINUTE,
  MASS_OPEN_MINUTE,
  createMassDiagnostics,
  createMassSystem,
  isMassTime,
  massBookingTickFor,
} from "../src/sim/systems/mass";
import {
  createSocialDiagnostics,
  createSocialSystem,
} from "../src/sim/systems/social";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

/** 600-tick days whose natural-borns stay children for ages. */
const COMPRESSED = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 200,
  elderAgeDays: 201,
  lifespanDays: 202,
});

function openWorld(seed: number) {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const size = 32;
  const world = createWorld(seed, {
    size,
    layers: buildLayers(
      new Uint8Array(size * size).fill(TERRAIN_GRASS),
      new Uint8Array(size * size),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  return { world, comps };
}

interface MassVillage {
  world: ReturnType<typeof openWorld>["world"];
  comps: ReturnType<typeof openWorld>["comps"];
  diagnostics: ReturnType<typeof createMassDiagnostics>;
}

function massVillage(seed: number, withChurch: boolean): MassVillage {
  const { world, comps } = openWorld(seed);
  const diagnostics = createMassDiagnostics();
  registerSystem(
    world,
    createMassSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: COMPRESSED,
      diagnostics,
    }),
  );
  createPlayerStockpile(world, comps, PLAYER_ONE, [500, 500, 100, 0, 0, 0, 0]);
  if (withChurch) {
    stampFinishedBuilding(world, comps, "church", 14, 14, {
      playerId: PLAYER_ONE,
    });
  }
  return { world, comps, diagnostics };
}

function spawnAdult(v: MassVillage, x: number, y: number): number {
  return spawnUnit(v.world, v.comps, x, y, {
    identity: true,
    ownerId: PLAYER_ONE,
  });
}

installSimPurityShims();

describe("mass band math", () => {
  it("opens only on Sunday mornings, 09:00–11:00", () => {
    expect(MASS_OPEN_MINUTE).toBe(9 * 60);
    expect(MASS_CLOSE_MINUTE).toBe(11 * 60);

    // Compressed day 6 starts at tick 3,600; minute M lands at
    // tick 3,600 + M × 600 / 1440.
    const at = (minute: number): number =>
      6 * 600 + Math.floor((minute * 600) / 1440);
    expect(isMassTime(at(8 * 60), COMPRESSED)).toBe(false);
    expect(isMassTime(at(9 * 60), COMPRESSED)).toBe(true);
    expect(isMassTime(at(10 * 60), COMPRESSED)).toBe(true);
    expect(isMassTime(at(11 * 60), COMPRESSED)).toBe(false);
    // Saturday morning at the same hour: no Mass.
    expect(isMassTime(at(9 * 60) - 600, COMPRESSED)).toBe(false);
    // Monday 09:00 under the canonical clock: no Mass either.
    expect(isMassTime(5400, DEFAULT_LIFECYCLE_CONFIG)).toBe(false);

    // Bookings stagger deterministically inside the band.
    for (let eid = 1; eid <= 40; eid++) {
      const booking = massBookingTickFor(eid, 6, COMPRESSED);
      expect(booking).toBe(massBookingTickFor(eid, 6, COMPRESSED));
      expect(booking).toBeGreaterThanOrEqual(6 * 600);
      expect(booking).toBeLessThanOrEqual(6 * 600 + 230);
    }
  });
});

describe("mass booking", () => {
  it("books every adult a Mass chain on Sunday morning when a Church stands", () => {
    const v = massVillage(20260923, true);
    const adults = [spawnAdult(v, 12.5, 12.5), spawnAdult(v, 15.5, 15.5)];
    // Sunday morning, past every jittered departure minute.
    v.world.tick = 6 * 600 + 240;
    step(v.world);

    let churchEid = 0;
    for (const eid of v.world.entities) {
      const row = v.world.rowsByComponentId.get(v.comps.buildingId)?.get(eid);
      if (row) churchEid = eid;
    }
    expect(churchEid).toBeGreaterThan(0);

    for (const eid of adults) {
      const queue = readActivityQueue(v.world, v.comps, eid);
      expect(queue).toHaveLength(2);
      expect(queue[0]!.kind).toBe("move");
      const head = queue[1]!;
      expect(head.kind).toBe("leisure");
      if (head.kind === "leisure") {
        expect(head.venueCode).toBe(LEISURE_VENUE_MASS);
        expect(head.targetEid).toBe(churchEid);
      }
      // One Mass per Sunday: the self cooldown runs through the wake.
      expect(jobCooldownActive(v.world, v.comps, eid, v.world.tick)).toBe(true);
    }
    expect(v.diagnostics.massesPlanned).toBe(2);
    // A later pass does not double-book while the cooldown lives.
    step(v.world);
    expect(v.diagnostics.massesPlanned).toBe(2);
  });

  it("books nobody without a finished Church and nothing off the band", () => {
    const v = massVillage(20260924, false);
    const eid = spawnAdult(v, 12.5, 12.5);
    v.world.tick = 6 * 600 + 240; // Sunday mid-band
    step(v.world);
    expect(readActivityQueue(v.world, v.comps, eid)).toHaveLength(0);
    expect(v.diagnostics.massesPlanned).toBe(0);

    // Same minute on Monday (day 7): no Mass even with a church.
    const c = massVillage(20260925, true);
    const monday = spawnAdult(c, 12.5, 12.5);
    c.world.tick = 7 * 600 + 240;
    step(c.world);
    expect(readActivityQueue(c.world, c.comps, monday)).toHaveLength(0);
  });

  it("children keep Sundays at home", () => {
    const v = massVillage(20260926, true);
    // Natural-born under COMPRESSED's 200-day adulthood: still a child.
    const child = spawnUnit(v.world, v.comps, 13.5, 13.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
      ownerId: PLAYER_ONE,
    });
    v.world.tick = 6 * 600 + 240;
    step(v.world);
    expect(readActivityQueue(v.world, v.comps, child)).toHaveLength(0);
    expect(v.diagnostics.massesPlanned).toBe(0);
  });

  it("cancels stale Mass heads without effects once the band closes", () => {
    const v = massVillage(20260927, true);
    const eid = spawnAdult(v, 20.5, 20.5); // far away, never arrives
    // Pre-seed a Mass head as if its approach leg already dropped.
    const queue = readActivityQueue(v.world, v.comps, eid);
    enqueueActivity(queue, leisureActivity(LEISURE_VENUE_MASS, 1));
    writeActivityQueue(v.world, v.comps, eid, queue);
    // Walk into Monday noon.
    v.world.tick = 7 * 600 + Math.floor((720 * 600) / 1440);
    step(v.world);
    expect(readActivityQueue(v.world, v.comps, eid)).toHaveLength(0);
    expect(v.diagnostics.expiredMasses).toBe(1);
  });
});

describe("mass execution (through the social system)", () => {
  function congregation(seed: number) {
    const { world, comps } = openWorld(seed);
    const socialDiagnostics = createSocialDiagnostics();
    registerSystem(
      world,
      createSocialSystem({
        comps,
        players: [PLAYER_ONE],
        lifecycleConfig: COMPRESSED,
        diagnostics: socialDiagnostics,
      }),
    );
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [500, 500, 100, 0, 0, 0, 0],
    );
    const church = stampFinishedBuilding(world, comps, "church", 12, 12, {
      playerId: PLAYER_ONE,
    });
    // Two attendees already gathered inside the bond radius; one carries
    // the Pious trait for the §2.4 "extra weight".
    const pious = spawnUnit(world, comps, 12.5, 14.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    const plain = spawnUnit(world, comps, 14.5, 12.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    world.rowsByComponentId
      .get(comps.traitsId)!
      .set(pious, [traitCodeOf("pious")]);
    for (const eid of [pious, plain]) {
      setNeedLevels(world, comps, eid, { food: 100, rest: 100, morale: 50 });
      const queue = readActivityQueue(world, comps, eid);
      enqueueActivity(queue, leisureActivity(LEISURE_VENUE_MASS, church));
      writeActivityQueue(world, comps, eid, queue);
    }
    // An arrival parked inside a NON-church target's radius must cancel
    // clean: no blessing, no bond, just a dropped head.
    const house = stampFinishedBuilding(world, comps, "house", 24, 4, {
      playerId: PLAYER_ONE,
    });
    const lost = spawnUnit(world, comps, 24.5, 5.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    setNeedLevels(world, comps, lost, { food: 100, rest: 100, morale: 50 });
    const lostQueue = readActivityQueue(world, comps, lost);
    enqueueActivity(lostQueue, leisureActivity(LEISURE_VENUE_MASS, house));
    writeActivityQueue(world, comps, lost, lostQueue);
    return { world, comps, church, pious, plain, lost, socialDiagnostics };
  }

  it("buffs attendee morale (Pious extra), reinforces bonds, logs MASS", () => {
    const c = congregation(20260928);
    step(c.world);

    // Heads dropped exactly once each.
    expect(readActivityQueue(c.world, c.comps, c.pious)).toHaveLength(0);
    expect(readActivityQueue(c.world, c.comps, c.plain)).toHaveLength(0);
    // Broad buff + Pious bonus.
    expect(readNeeds(c.world, c.comps, c.pious)?.morale).toBe(50 + 18 + 8);
    expect(readNeeds(c.world, c.comps, c.plain)?.morale).toBe(50 + 18);
    // Pairwise reinforcement between the two co-attendees (both orders).
    expect(relationshipValueOf(c.world, c.comps, c.pious, c.plain)).toBe(16);
    // Digest-visible event log.
    const events = readSocialEvents(c.world, c.comps, PLAYER_ONE);
    expect(events.filter((e) => e.kind === SOCIAL_EVENT_MASS)).toHaveLength(2);
    // One outing per Pop per Sunday: cooldowns stamped at completion.
    expect(jobCooldownActive(c.world, c.comps, c.pious, c.world.tick)).toBe(
      true,
    );
    expect(c.socialDiagnostics.massesCompleted).toBe(2);
    expect(c.socialDiagnostics.massBondIncrements).toBe(2);
    expect(c.socialDiagnostics.massMoraleGranted).toBe(44);
  });

  it("cancels arrivals whose target is not a church", () => {
    const c = congregation(20260929);
    step(c.world);
    expect(readActivityQueue(c.world, c.comps, c.lost)).toHaveLength(0);
    expect(readNeeds(c.world, c.comps, c.lost)?.morale).toBe(50); // no blessing
    expect(c.socialDiagnostics.massesCompleted).toBe(2); // only the pair
  });
});

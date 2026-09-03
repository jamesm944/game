/**
 * Schedules unit coverage — SPEC §2.4 day/night, schedules & sleep /
 * M3-T6 (issue #51).
 *
 * Pure schedule math (role windows, night band wraparound, ±90 s
 * deterministic jitter, wake ticks, housing × crowding refill,
 * derived deprivation multiplier, nap lengths); the deprivation
 * gather-rate fixture (a deprived twin measurably underperforms — the
 * acceptance criterion's measurable penalty); the nap micro-sleep loop;
 * the night-bedding chain with its exactly-once wake refill; the
 * essential-role stub; and the render-side lighting tint table.
 */
import { describe, expect, it } from "vitest";
import { peekActivity } from "../src/sim/activities";
import {
  defineSimComponents,
  readActivityQueue,
  readNeeds,
  spawnUnit,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { createMovementSystem } from "../src/sim/systems/movement";
import { createNeedsSystem } from "../src/sim/systems/needs";
import { resolveGatherInterval } from "../src/sim/systems/skills";
import { setNeedLevels } from "../src/sim/components/needs";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  minuteOfDay,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../src/sim/systems/lifecycle";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { spawnHousehold } from "../src/sim/components/household";
import {
  DAYS_PER_WEEK,
  DEPRIVATION_WORK_MULT,
  DEPRIVED_REST_LEVEL,
  ESSENTIAL_ROLES,
  NAP_REST_LEVEL,
  NAP_REST_RESTORE,
  REST_DAY_ESSENTIAL_ROLES,
  REST_DAY_PRODUCTION_SLOT_FRACTION,
  SUNDAY_DAY_INDEX,
  SUNDAY_LEISURE_UTILITY_MULT,
  SUNDAY_WORK_UTILITY_MULT,
  TRANSITION_JITTER_SIM_SECONDS,
  WEEKDAY_NAMES,
  bedTileFor,
  crowdingFactorOf,
  createSchedulesDiagnostics,
  createSchedulesSystem,
  deprivationWorkMultiplierOf,
  housingQualityOf,
  isCoreWorkTime,
  isEssentialRole,
  isRestDay,
  isRestDayEssentialRole,
  isRoleWorkTime,
  isSleepTime,
  napTicksFor,
  restDayProductionSlotsOf,
  roleWorkWindowMinutes,
  sleepRestRefillOf,
  transitionJitterTicks,
  wakeTickFor,
  weekdayIndexOf,
  weekdayNameOf,
} from "../src/sim/systems/schedules";
import { lightingTintAtMinute, lightingTintAtTick } from "../src/render/mirror";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const CANONICAL: LifecycleConfig = normalizeLifecycleConfig({
  dayTicks: 14_400,
  clockOffsetMinutes: 0,
});
const BOOT_CANONICAL: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG;
const COMPRESSED = normalizeLifecycleConfig({ dayTicks: 600 });

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
  return { world, comps, scheduler };
}

installSimPurityShims();

describe("schedule windows (§2.4 clock)", () => {
  it("windows roles around the 06:00–18:00 base with offsets", () => {
    expect(roleWorkWindowMinutes("gather")).toEqual([360, 1080]);
    expect(roleWorkWindowMinutes("build")).toEqual([390, 1110]);
    expect(roleWorkWindowMinutes("produce")).toEqual([330, 1050]);

    // Canonical clock: 10 ticks per sim-minute.
    expect(isRoleWorkTime("gather", 3600, CANONICAL)).toBe(true); // 06:00
    expect(isRoleWorkTime("gather", 3599, CANONICAL)).toBe(false);
    expect(isRoleWorkTime("gather", 10799, CANONICAL)).toBe(true); // 17:59:50
    expect(isRoleWorkTime("gather", 10800, CANONICAL)).toBe(false); // 18:00
    expect(isRoleWorkTime("produce", 3300, CANONICAL)).toBe(true); // 05:30
    expect(isRoleWorkTime("build", 3300, CANONICAL)).toBe(false);
    expect(isCoreWorkTime(3599, CANONICAL)).toBe(false);
    expect(isCoreWorkTime(3600, CANONICAL)).toBe(true);

    // Compressed clocks scale the same wall fractions.
    expect(isRoleWorkTime("gather", 150, COMPRESSED)).toBe(true); // 06:00
    expect(isRoleWorkTime("gather", 149, COMPRESSED)).toBe(false);
  });

  it("night band wraps midnight: 22:00–05:00", () => {
    expect(minuteOfDay(13199, CANONICAL)).toBe(1319);
    expect(isSleepTime(13199, CANONICAL)).toBe(false); // 21:59
    expect(isSleepTime(13200, CANONICAL)).toBe(true); // 22:00
    expect(isSleepTime(14399, CANONICAL)).toBe(true); // 23:59:50
    expect(isSleepTime(0, CANONICAL)).toBe(true); // midnight
    expect(isSleepTime(2999, CANONICAL)).toBe(true); // 04:59:50
    expect(isSleepTime(3000, CANONICAL)).toBe(false); // 05:00
  });

  it("boots at 07:00 AM on default production clock", () => {
    expect(minuteOfDay(0, BOOT_CANONICAL)).toBe(420);
    // Villagers are awake at 07:00 AM boot:
    expect(isSleepTime(0, BOOT_CANONICAL)).toBe(false);
  });

  it("jitter is bounded, deterministic, and clock-proportional", () => {
    let sawNonzero = false;
    for (let eid = 1; eid <= 400; eid++) {
      for (const day of [0, 1, 7]) {
        const canonical = transitionJitterTicks(eid, day, CANONICAL);
        expect(Math.abs(canonical)).toBeLessThanOrEqual(
          Math.round(
            (TRANSITION_JITTER_SIM_SECONDS * CANONICAL.dayTicks) / 86400,
          ),
        );
        expect(canonical).toBe(transitionJitterTicks(eid, day, CANONICAL));
        const compressed = transitionJitterTicks(eid, day, COMPRESSED);
        expect(Math.abs(compressed)).toBeLessThanOrEqual(1);
        if (canonical !== 0) sawNonzero = true;
      }
    }
    expect(sawNonzero).toBe(true); // the hash actually spreads
  });

  it("bedded-at-night sleepers wake the NEXT 05:00; stragglers today", () => {
    // 22:00 of day 0 → the NEXT day's 05:00 (day 1 starts at 14,400).
    expect(wakeTickFor(13200, CANONICAL)).toBe(17400);
    expect(wakeTickFor(2999, CANONICAL)).toBe(3000); // 04:59 → same-day 05:00
    expect(wakeTickFor(550, COMPRESSED)).toBe(725); // compressed parity
  });
});

describe("sleep quality = housing × crowding (§2.4)", () => {
  it("scores buildings, crowds households, and scales the refill", () => {
    expect(housingQualityOf("house")).toBe(1);
    expect(housingQualityOf("town-center")).toBe(0.6);
    expect(housingQualityOf("mill")).toBeCloseTo(0.5);

    expect(crowdingFactorOf(3, 5)).toBe(1); // everyone has room
    expect(crowdingFactorOf(5, 5)).toBe(1);
    expect(crowdingFactorOf(6, 5)).toBeCloseTo(0.8); // 20% over
    expect(crowdingFactorOf(10, 5)).toBe(0.25); // hard floor at double
    expect(crowdingFactorOf(4, 0)).toBe(0); // capacity-less roof

    expect(sleepRestRefillOf(1, 1)).toBe(100); // perfect night
    expect(sleepRestRefillOf(0.6, 1)).toBe(60); // TC barracks life
    expect(sleepRestRefillOf(1, 0.25)).toBe(25); // packed house
    expect(sleepRestRefillOf(1, 0)).toBe(0);
  });

  it("derives deprivation from the Rest meter alone", () => {
    const { world, comps } = openWorld(20260901);
    const rested = spawnUnit(world, comps, 5.5, 5.5, { identity: true });
    const drained = spawnUnit(world, comps, 6.5, 5.5, { identity: true });
    const legacy = spawnUnit(world, comps, 7.5, 5.5); // rowless
    setNeedLevels(world, comps, rested, { food: 100, rest: 100, morale: 100 });
    setNeedLevels(world, comps, drained, {
      food: 100,
      rest: DEPRIVED_REST_LEVEL - 1,
      morale: 100,
    });
    expect(deprivationWorkMultiplierOf(world, comps, rested)).toBe(1);
    expect(deprivationWorkMultiplierOf(world, comps, drained)).toBe(
      DEPRIVATION_WORK_MULT,
    );
    expect(deprivationWorkMultiplierOf(world, comps, legacy)).toBe(1);
  });

  it("gather-rate fixture: a deprived twin measurably underperforms", () => {
    const { world, comps } = openWorld(20260902);
    const rested = spawnUnit(world, comps, 5.5, 5.5, { identity: true });
    const deprived = spawnUnit(world, comps, 6.5, 5.5, { identity: true });
    setNeedLevels(world, comps, rested, { food: 100, rest: 100, morale: 100 });
    setNeedLevels(world, comps, deprived, {
      food: 100,
      rest: DEPRIVED_REST_LEVEL - 5,
      morale: 100,
    });
    // Same novice sheet, only last night's sleep differs: the deprived
    // twin swings measurably slower (rest slope × deprivation stack).
    const base = resolveGatherInterval(world, comps, rested, 30);
    const stretched = resolveGatherInterval(world, comps, deprived, 30);
    expect(base).toBe(30);
    expect(stretched).toBeGreaterThan(40);
    expect(stretched / base).toBeGreaterThanOrEqual(1.3);
  });

  it("naps are short, scaled, and gated on the Rest meter", () => {
    expect(napTicksFor(CANONICAL)).toBe(150);
    expect(napTicksFor(COMPRESSED)).toBe(6);
    expect(NAP_REST_LEVEL).toBeGreaterThan(DEPRIVED_REST_LEVEL);
    expect(NAP_REST_RESTORE).toBeGreaterThan(0);
  });
});

describe("schedule steering", () => {
  function housedVillage(seed: number) {
    const bag = openWorld(seed);
    const { world, comps } = bag;
    registerSystem(world, createMovementSystem(comps, bag.scheduler));
    registerSystem(world, createNeedsSystem(comps));
    const schedulesDiagnostics = createSchedulesDiagnostics();
    registerSystem(
      world,
      createSchedulesSystem({
        comps,
        players: [PLAYER_ONE],
        diagnostics: schedulesDiagnostics,
        lifecycleConfig: CANONICAL,
      }),
    );
    createPlayerStockpile(world, comps, PLAYER_ONE, [500, 500, 0, 0, 0, 0, 0]);
    const homeEid = stampFinishedBuilding(world, comps, "house", 8, 8, {
      playerId: PLAYER_ONE,
    });
    const head = spawnUnit(world, comps, 7.5, 11.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    const partner = spawnUnit(world, comps, 8.5, 11.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    spawnHousehold(world, comps, {
      playerId: PLAYER_ONE,
      homeEid,
      headEid: head,
      partnerEid: partner,
      nextBirthRollTick: 999999999,
    });
    return { ...bag, homeEid, head, partner, schedulesDiagnostics };
  }

  it("beds housed Pops in the night band at their own bed slot", () => {
    const v = housedVillage(20260903);
    // 21:00 day 0 — inside the evening, before the band.
    v.world.tick = 12600;
    step(v.world);
    expect(readActivityQueue(v.world, v.comps, v.head)).toHaveLength(0);
    // Cross into the band (22:00 + worst-case jitter) and past it.
    for (let i = 0; i < 1500 && v.world.tick < 13400; i++) step(v.world);
    const queue = readActivityQueue(v.world, v.comps, v.head);
    const head = peekActivity(queue);
    expect(
      head?.kind === "sleep" || queue.some((a) => a.kind === "sleep"),
    ).toBe(true);
    if (head?.kind === "sleep") {
      expect(head.isNap).toBe(false);
      expect(head.wakeTick).toBe(wakeTickFor(v.world.tick, CANONICAL));
    }
    expect(v.schedulesDiagnostics.beddedNights).toBe(2); // head + partner
  });

  it("pops the Sleep head exactly once and refills Rest by quality", () => {
    const v = housedVillage(20260904);
    setNeedLevels(v.world, v.comps, v.head, {
      food: 100,
      rest: 40,
      morale: 100,
    });
    v.world.tick = 12700; // 21:10 — bedded once the band opens
    // Phase 1: wait for the Sleep head to appear.
    for (;;) {
      step(v.world);
      if (
        readActivityQueue(v.world, v.comps, v.head).some(
          (a) => a.kind === "sleep",
        )
      ) {
        break;
      }
      if (v.world.tick > 15000) throw new Error("never bedded");
    }
    // Phase 2: wait for the wake pop (movement parks sleepers; only the
    // schedules pass can remove the head).
    for (;;) {
      step(v.world);
      if (
        !readActivityQueue(v.world, v.comps, v.head).some(
          (a) => a.kind === "sleep",
        )
      ) {
        break;
      }
      if (v.world.tick > 40000) throw new Error("never woke");
    }
    // House quality 1 × crowding 2/5 → factor 1 ⇒ full-meter refill.
    expect(readNeeds(v.world, v.comps, v.head)?.rest).toBe(100);
    const wakes = v.schedulesDiagnostics.wakesCompleted;
    expect(wakes).toBeGreaterThanOrEqual(1);
    // No double refill on subsequent ticks (only ordinary decay moves it).
    const restAfterWake = readNeeds(v.world, v.comps, v.head)?.rest ?? -1;
    for (let i = 0; i < 30; i++) step(v.world);
    const restLater = readNeeds(v.world, v.comps, v.head)?.rest ?? -1;
    expect(restLater).toBeLessThanOrEqual(restAfterWake);
    expect(v.schedulesDiagnostics.wakesCompleted).toBe(wakes);
  }, 30_000);

  it("homeless named Pops are never bedded (they just tire)", () => {
    const v = housedVillage(20260905);
    const vagrant = spawnUnit(v.world, v.comps, 20.5, 20.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    v.world.tick = 12600;
    for (let i = 0; i < 200; i++) step(v.world);
    expect(
      readActivityQueue(v.world, v.comps, vagrant).some(
        (a) => a.kind === "sleep",
      ),
    ).toBe(false);
  });

  it("idle drained Pops nap through the work shift and regain a bite", () => {
    const bag = openWorld(20260906);
    const { world, comps } = bag;
    registerSystem(world, createMovementSystem(comps, bag.scheduler));
    registerSystem(world, createNeedsSystem(comps));
    const schedulesDiagnostics = createSchedulesDiagnostics();
    registerSystem(
      world,
      createSchedulesSystem({
        comps,
        players: [PLAYER_ONE],
        diagnostics: schedulesDiagnostics,
      }),
    );
    const sleeper = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    setNeedLevels(world, comps, sleeper, {
      food: 100,
      rest: NAP_REST_LEVEL - 5,
      morale: 100,
    });
    world.tick = 4000; // 06:40 — core shift
    step(world);
    const queue = readActivityQueue(world, comps, sleeper);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.kind).toBe("sleep");
    expect(queue[0]!.kind === "sleep" && queue[0]!.isNap).toBe(true);
    // Ride out the nap and catch the completion tick.
    for (;;) {
      step(world);
      if (readActivityQueue(world, comps, sleeper).length === 0) break;
      if (world.tick > 5000) throw new Error("nap never ended");
    }
    expect(readNeeds(world, comps, sleeper)?.rest).toBe(
      NAP_REST_LEVEL - 5 + NAP_REST_RESTORE,
    );
    expect(schedulesDiagnostics.napsTaken).toBe(1);
  });

  it("hungry idles go eat instead of napping", () => {
    const bag = openWorld(20260907);
    const { world, comps } = bag;
    registerSystem(world, createMovementSystem(comps, bag.scheduler));
    registerSystem(world, createNeedsSystem(comps));
    registerSystem(
      world,
      createSchedulesSystem({
        comps,
        players: [PLAYER_ONE],
        diagnostics: createSchedulesDiagnostics(),
      }),
    );
    createPlayerStockpile(world, comps, PLAYER_ONE, [500, 0, 0, 0, 0, 0, 0]);
    createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
    const hungry = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    // Hungry AND exhausted: the meal must win the idle slot.
    setNeedLevels(world, comps, hungry, {
      food: 30,
      rest: NAP_REST_LEVEL - 5,
      morale: 100,
    });
    world.tick = 4000; // 06:40 — core shift
    step(world);
    const queue = readActivityQueue(world, comps, hungry);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.some((a) => a.kind === "sleep")).toBe(false);
  });

  it("assigns every household member a deterministic perimeter bed slot", () => {
    const v = housedVillage(20260908);
    const beds = [v.head, v.partner].map((eid) =>
      bedTileFor(v.world, v.comps, v.homeEid, eid)!,
    );
    // Deterministic…
    expect(beds[0]).toEqual(bedTileFor(v.world, v.comps, v.homeEid, v.head)!);
    expect(beds[1]).toEqual(
      bedTileFor(v.world, v.comps, v.homeEid, v.partner)!,
    );
    // …and on the ring-1 perimeter of the 2×2 house centered (9.5, 9.5).
    for (const bed of beds) {
      const dx = Math.abs(bed.x - 9.5);
      const dy = Math.abs(bed.y - 9.5);
      expect(Math.max(dx, dy)).toBeLessThanOrEqual(3);
      expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("essential-role exception stub", () => {
  it("ships empty in M3 but answers honestly", () => {
    expect(ESSENTIAL_ROLES).toEqual([]);
    expect(isEssentialRole(undefined)).toBe(false);
    expect(isEssentialRole("gather")).toBe(false);
  });
});

describe("weekly cycle (M3-T8, §2.4 7 named days / Sunday rest)", () => {
  it("names seven days Monday-first with Sunday seventh", () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect([...WEEKDAY_NAMES]).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(SUNDAY_DAY_INDEX).toBe(6);
    for (let day = 0; day < 21; day++) {
      expect(weekdayNameOf(day)).toBe(WEEKDAY_NAMES[weekdayIndexOf(day)]);
    }
    // The cycle rolls: week two repeats week one, and negative indices
    // wrap cleanly.
    expect(weekdayNameOf(0)).toBe("monday");
    expect(weekdayNameOf(6)).toBe("sunday");
    expect(weekdayNameOf(7)).toBe("monday");
    expect(weekdayNameOf(13)).toBe("sunday");
    expect(weekdayNameOf(-1)).toBe("sunday");
  });

  it("flags exactly every seventh dawn as the rest day", () => {
    // Canonical clock: day N starts at N × 14,400. Days 0–5 are
    // workdays (every pre-T8 fixture stays put); day 6 is Sunday.
    expect(isRestDay(0, CANONICAL)).toBe(false);
    expect(isRestDay(14_400 * 5 + 14_399, CANONICAL)).toBe(false);
    expect(isRestDay(14_400 * 6, CANONICAL)).toBe(true);
    expect(isRestDay(14_400 * 6 + 7_200, CANONICAL)).toBe(true);
    expect(isRestDay(14_400 * 7, CANONICAL)).toBe(false);
    // Compressed clocks compress the calendar identically.
    const day6 = 6 * COMPRESSED.dayTicks;
    expect(isRestDay(day6 - 1, COMPRESSED)).toBe(false);
    expect(isRestDay(day6, COMPRESSED)).toBe(true);
    expect(isRestDay(day6 + COMPRESSED.dayTicks, COMPRESSED)).toBe(false);
  });

  it("rest-day essentials keep production staffed at half slots", () => {
    expect(REST_DAY_ESSENTIAL_ROLES).toEqual(["produce"]);
    expect(isRestDayEssentialRole("produce")).toBe(true);
    expect(isRestDayEssentialRole("gather")).toBe(false);
    expect(isRestDayEssentialRole("build")).toBe(false);
    expect(isRestDayEssentialRole(undefined)).toBe(false);

    // Half crew, rounding up so a lone baker never loses the oven; a
    // slotless building stays slotless.
    expect(REST_DAY_PRODUCTION_SLOT_FRACTION).toBe(0.5);
    expect(restDayProductionSlotsOf(0)).toBe(0);
    expect(restDayProductionSlotsOf(1)).toBe(1);
    expect(restDayProductionSlotsOf(2)).toBe(1);
    expect(restDayProductionSlotsOf(3)).toBe(2);
    expect(restDayProductionSlotsOf(4)).toBe(2);

    // And the brain's Sunday weighting leans leisure/home over work.
    expect(SUNDAY_WORK_UTILITY_MULT).toBeLessThan(1);
    expect(SUNDAY_LEISURE_UTILITY_MULT).toBeGreaterThan(1);
  });
});

describe("render-side lighting tint (M3-T6)", () => {
  it("lerps the §2.4 keyframe table and wraps at midnight", () => {
    const tint = new Float32Array(3);
    lightingTintAtMinute(720, tint); // noon: full daylight
    expect([...tint]).toEqual([1, 1, 1]);
    lightingTintAtMinute(0, tint); // deep night
    expect(tint[0]).toBeCloseTo(0.38);
    lightingTintAtMinute(1439, tint); // one minute before wrap ≈ night
    expect(tint[0]).toBeCloseTo(0.38, 1);
    lightingTintAtMinute(-5, tint); // clamped
    expect(tint[0]).toBeCloseTo(0.38);
    lightingTintAtMinute(1500, tint);
    expect(tint[0]).toBeCloseTo(0.38);

    // Dawn warms monotonically toward the sunrise stop.
    const early = new Float32Array(3);
    const late = new Float32Array(3);
    lightingTintAtMinute(310, early);
    lightingTintAtMinute(350, late);
    expect(late[0]!).toBeGreaterThan(early[0]!);
    expect(late[1]!).toBeGreaterThan(early[1]!);
  });

  it("maps world ticks through the canonical clock", () => {
    const tint = new Float32Array(3);
    // Boot is 07:00 AM (420 min). Noon (720 min) is 300 min = 3000 ticks later:
    lightingTintAtTick(3000, tint);
    expect([...tint]).toEqual([1, 1, 1]);
    // Midnight (0 min) is 1020 min = 10200 ticks later:
    lightingTintAtTick(10200, tint);
    expect(tint[0]).toBeCloseTo(0.38);
    expect(tint[1]).toBeCloseTo(0.44);
    expect(tint[2]).toBeCloseTo(0.65);
  });
});

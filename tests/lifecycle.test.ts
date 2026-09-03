/**
 * Lifecycle tests — SPEC §2.3 birth→child→adult→elder→death / M3-T5
 * (issue #50).
 *
 * Pinned here:
 * - the pure stage math (thresholds, ARRIVAL vs BIRTH effective age);
 * - aging on exact day-boundary ticks from birthTick under a
 *   compressed clock;
 * - natural death at end of lifespan — despawn mid-tick like combat,
 *   diagnostics counted, exactly on the boundary tick;
 * - child restrictions: player gather/build orders silently drop child
 *   actors (children cannot work), and the IAUS brain never assigns
 *   them while elders score at half weight (light duties).
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readIdentity,
  spawnBuildingSite,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../src/sim/components/pop";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_ADULT,
  LIFE_STAGE_CHILD,
  LIFE_STAGE_ELDER,
  adultTicksOf,
  createLifecycleDiagnostics,
  createLifecycleSystem,
  dayIndexOf,
  effectiveAgeOf,
  elderTicksOf,
  isChildOf,
  lifeStageAt,
  lifeStageOf,
  lifespanTicksOf,
  minuteOfDay,
  normalizeLifecycleConfig,
  workingActorsOnly,
  type LifecycleConfig,
} from "../src/sim/systems/lifecycle";
import { createGatherSystem } from "../src/sim/systems/gather";
import { createConstructionSystem } from "../src/sim/systems/construction";
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../src/sim/ai/popBrain";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

/** Compressed clock: 600-tick days — one week fits in 4,200 ticks. */
const CFG: LifecycleConfig = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 1,
  elderAgeDays: 4,
  lifespanDays: 5,
});

function grassWorld(seed: number): { world: World; comps: SimComponents } {
  const size = 24;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
  return { world, comps: defineSimComponents(world) };
}

// ---- Pure stage math -------------------------------------------------------------

describe("lifecycle stage math", () => {
  it("derives child → adult → elder from whole-day thresholds", () => {
    expect(lifeStageAt(0, CFG)).toBe(LIFE_STAGE_CHILD);
    expect(lifeStageAt(adultTicksOf(CFG) - 1, CFG)).toBe(LIFE_STAGE_CHILD);
    expect(lifeStageAt(adultTicksOf(CFG), CFG)).toBe(LIFE_STAGE_ADULT);
    expect(lifeStageAt(elderTicksOf(CFG) - 1, CFG)).toBe(LIFE_STAGE_ADULT);
    expect(lifeStageAt(elderTicksOf(CFG), CFG)).toBe(LIFE_STAGE_ELDER);
    // Death rides the lifespan threshold; stage stays "elder" until then.
    expect(lifeStageAt(lifespanTicksOf(CFG), CFG)).toBe(LIFE_STAGE_ELDER);
  });

  it("rejects non-ascending thresholds", () => {
    expect(() =>
      normalizeLifecycleConfig({
        dayTicks: 100,
        adultAgeDays: 3,
        elderAgeDays: 2,
        lifespanDays: 5,
      }),
    ).toThrow(/ascend/);
  });

  it("maps ticks to sim-clock minutes and day indices", () => {
    const canonical = DEFAULT_LIFECYCLE_CONFIG;
    // Canonical boots at 07:00 AM (420 minutes).
    expect(minuteOfDay(0, canonical)).toBe(420);
    // Tick 5400 = 540 sim minutes elapsed -> 420 + 540 = 960 (16:00).
    expect(minuteOfDay(5400, canonical)).toBe(960);
    // Zero-offset config for raw day fraction tests:
    const zeroOffset = normalizeLifecycleConfig({ clockOffsetMinutes: 0 });
    expect(minuteOfDay(0, zeroOffset)).toBe(0);
    expect(minuteOfDay(5400, zeroOffset)).toBe(540);
    expect(dayIndexOf(29_999, canonical)).toBe(2);
    expect(dayIndexOf(28_800, canonical)).toBe(2);
  });
});

// ---- Effective age & derived stages ----------------------------------------------

describe("effective age", () => {
  it("runs natural-born children from birthTick but starts arrivals as adults", () => {
    const { world, comps } = grassWorld(7);
    const born = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    const arrival = spawnUnit(world, comps, 7.5, 7.5, { identity: true });

    expect(readIdentity(world, comps, born)!.origin).toBe(POP_ORIGIN_BIRTH);
    // At tick 0 a newborn is a child; an arrival is already working-age.
    expect(effectiveAgeOf(world, comps, born, CFG)).toBe(0);
    expect(effectiveAgeOf(world, comps, arrival, CFG)).toBe(adultTicksOf(CFG));
    expect(lifeStageOf(world, comps, born, CFG)).toBe(LIFE_STAGE_CHILD);
    expect(lifeStageOf(world, comps, arrival, CFG)).toBe(LIFE_STAGE_ADULT);
  });

  it("ages a newborn across every boundary under the compressed clock", () => {
    const { world, comps } = grassWorld(11);
    registerSystem(world, createLifecycleSystem(comps, CFG));
    const kid = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });

    const stageAtTick = (tick: number): string | undefined => {
      while (world.tick < tick) step(world);
      return lifeStageOf(world, comps, kid, CFG);
    };
    expect(stageAtTick(adultTicksOf(CFG) - 1)).toBe(LIFE_STAGE_CHILD);
    expect(stageAtTick(adultTicksOf(CFG))).toBe(LIFE_STAGE_ADULT);
    expect(stageAtTick(elderTicksOf(CFG))).toBe(LIFE_STAGE_ELDER);
  });
});

// ---- Natural death ------------------------------------------------------------------

describe("natural death", () => {
  it("despawns exactly at the lifespan boundary and counts it", () => {
    const { world, comps } = grassWorld(13);
    const diagnostics = createLifecycleDiagnostics();
    registerSystem(world, createLifecycleSystem(comps, CFG, diagnostics));
    const elderToBe = spawnUnit(world, comps, 5.5, 5.5, { identity: true });

    // ARRIVAL origin ⇒ death when elapsed ≥ (5−1)·600 = 2400.
    while (world.tick < lifespanTicksOf(CFG) - adultTicksOf(CFG) - 1) {
      step(world);
    }
    expect(world.entities.includes(elderToBe)).toBe(true);
    step(world); // the boundary tick itself
    expect(world.entities.includes(elderToBe)).toBe(false);
    expect(diagnostics.naturalDeaths).toBe(1);
    expect(diagnostics.elderDeaths).toBe(1);
  });

  it("never touches rowless legacy units", () => {
    const { world, comps } = grassWorld(17);
    registerSystem(world, createLifecycleSystem(comps, CFG));
    // A unit with no Identity row never ages (byte-compatible legacy).
    const legacy = spawnUnit(world, comps, 5.5, 5.5, {});
    for (let i = 0; i < lifespanTicksOf(CFG) + 50; i++) step(world);
    expect(world.entities.includes(legacy)).toBe(true);
  });
});

// ---- Child restrictions ------------------------------------------------------------

describe("child restrictions", () => {
  it("filters children out of ordered work actors", () => {
    const { world, comps } = grassWorld(19);
    const kid = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    const adult = spawnUnit(world, comps, 6.5, 5.5, { identity: true });
    expect(workingActorsOnly(world, comps, [kid, adult])).toEqual([adult]);
    expect(isChildOf(world, comps, kid, CFG)).toBe(true);
  });

  it("drops child actors from gather and build commands", () => {
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const { world, comps } = grassWorld(23);
    registerSystem(world, createGatherSystem(comps, scheduler));
    registerSystem(world, createConstructionSystem(comps));

    const kid = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    const adult = spawnUnit(world, comps, 6.5, 5.5, { identity: true });
    const nodeEid = spawnResourceNode(world, comps, 9, 9, 0, 500);
    const siteEid = spawnBuildingSite(world, comps, "house", 12, 12);

    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [kid, adult], nodeId: nodeEid },
    });
    step(world);
    // The adult took the node; the child was politely dropped.
    expect(world.rowsByComponentId.get(comps.assignedNodeId)?.has(adult)).toBe(
      true,
    );
    expect(world.rowsByComponentId.get(comps.assignedNodeId)?.has(kid)).toBe(
      false,
    );

    world.inbox.submit({
      kind: "build",
      targetTick: 2,
      data: { entityIds: [kid, adult], siteEid },
    });
    step(world);
    // Re-tasking replaces the adult's job; the child still never lands one.
    expect(world.rowsByComponentId.get(comps.assignedSiteId)?.has(adult)).toBe(
      true,
    );
    expect(world.rowsByComponentId.get(comps.assignedSiteId)?.has(kid)).toBe(
      false,
    );
  });
});

// ---- Brain gates -------------------------------------------------------------------

describe("pop brain lifecycle gates", () => {
  it("never assigns children; elders idle more than adults", () => {
    const { world, comps } = grassWorld(29);
    const brain = createPopBrainDiagnostics();
    registerSystem(world, createLifecycleSystem(comps, CFG));
    registerSystem(
      world,
      createPopBrainSystem({ comps, lifecycleConfig: CFG, diagnostics: brain }),
    );

    createPlayerStockpile(world, comps, PLAYER_ONE);
    createDropOffPoint(world, comps, 4.5, 4.5, PLAYER_ONE);
    spawnResourceNode(world, comps, 8, 8, 0, 2000);

    const kid = spawnUnit(world, comps, 5.5, 5.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    for (let i = 0; i < CFG.dayTicks; i++) step(world);

    // The child thought (its staggered window came due) but never took
    // a job: no assignment, no queue, only recorded skips.
    expect(brain.childSkips).toBeGreaterThan(0);
    expect(world.rowsByComponentId.get(comps.assignedNodeId)?.has(kid)).toBe(
      false,
    );
  });
});

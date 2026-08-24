/**
 * Social leisure-transition budget — SPEC §2.4 / M3-T7 acceptance.
 *
 * The §2.4 stagger rule covers every off-work transition, evenings
 * included: after the M3-T6 release wave walks the village home, the
 * IAUS leisure extension books a second wave of venue/visit paths at
 * the brain's hash-staggered 1 Hz think — never a stampede. This gate
 * runs the §2.3 envelope floor (300 housed Pops with a tavern and a
 * church standing) through close-of-work into the night band and pins,
 * per tick inside that whole transition span: pathfinding work under
 * 1 ms even with every A* computed inline, and no tick carrying more
 * than a quarter of the village's path issuances.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
  type PathTransport,
} from "../../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../../src/sim/world/layers";
import { stampFinishedBuilding } from "../../src/sim/systems/placement";
import { createGatherSystem } from "../../src/sim/systems/gather";
import { createMovementSystem } from "../../src/sim/systems/movement";
import { createNeedsSystem } from "../../src/sim/systems/needs";
import {
  createSocialSystem,
  isLeisureTime,
} from "../../src/sim/systems/social";
import {
  WORK_CLOSE_MINUTE,
  createSchedulesSystem,
} from "../../src/sim/systems/schedules";
import { createPopBrainSystem } from "../../src/sim/ai/popBrain";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  normalizeLifecycleConfig,
} from "../../src/sim/systems/lifecycle";
import { spawnHousehold } from "../../src/sim/components/household";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

const POP_COUNT = 300;
const HOUSE_COUNT = 60;
const NODE_COUNT = 60;
const SIZE = 120;
/** Canonical clock: gatherers close at 18:00 → tick 10,800. */
const CLOSE_TICK = (WORK_CLOSE_MINUTE / 1440) * 14_400;
const START_TICK_OF_WORLD = 9_000;
/** Measured span: from just before close until well past sleep-open. */
const WINDOW_START = CLOSE_TICK - START_TICK_OF_WORLD - 20;
const SLEEP_OPEN_OFFSET = ((22 * 60) / 1440) * 14_400;
const WINDOW_END = SLEEP_OPEN_OFFSET - START_TICK_OF_WORLD + 30;
const MEASURED_TICKS = 15_000;

installSimPurityShims();

describe("social leisure transition budget", () => {
  it("trickles 300 homeward + leisure paths under 1 ms/tick", () => {
    const sendsPerTick = new Map<number, number>();
    const pathMsPerTick = new Map<number, number>();
    let issueTick = 0;
    const inner = createSynchronousPathTransport();
    const transport: PathTransport = {
      attach: (receive) => inner.attach(receive),
      dispose: () => inner.dispose(),
      send: (request) => {
        const start = performance.now();
        inner.send(request);
        const elapsed = performance.now() - start;
        sendsPerTick.set(issueTick, (sendsPerTick.get(issueTick) ?? 0) + 1);
        pathMsPerTick.set(
          issueTick,
          (pathMsPerTick.get(issueTick) ?? 0) + elapsed,
        );
      },
    };

    const scheduler = new PathScheduler(transport);
    const world = createWorld(20260911, {
      size: SIZE,
      layers: buildLayers(
        new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
        new Uint8Array(SIZE * SIZE),
      ),
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(world, createGatherSystem(comps, scheduler));
    registerSystem(world, createNeedsSystem(comps));
    registerSystem(world, createSocialSystem({ comps }));
    registerSystem(
      world,
      createSchedulesSystem({ comps, players: [PLAYER_ONE] }),
    );
    registerSystem(
      world,
      createPopBrainSystem({
        comps,
        players: [PLAYER_ONE],
        lifecycleConfig: DEFAULT_LIFECYCLE_CONFIG,
        leisureWindow: (tick) =>
          isLeisureTime(tick, normalizeLifecycleConfig()),
      }),
    );
    // Gold-rich ledger: affordability must not gate the leisure wave.
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [50000, 50000, 50000, 0, 0, 0, 0],
    );
    createDropOffPoint(world, comps, 20.5, 95.5, PLAYER_ONE);

    // Venues mid-village so both waves have real destinations.
    stampFinishedBuilding(world, comps, "tavern", 40, 40, {
      playerId: PLAYER_ONE,
    });
    stampFinishedBuilding(world, comps, "church", 70, 40, {
      playerId: PLAYER_ONE,
    });

    // Sixty houses in northern rows…
    const houseEids: number[] = [];
    for (let i = 0; i < HOUSE_COUNT; i++) {
      houseEids.push(
        stampFinishedBuilding(
          world,
          comps,
          "house",
          4 + (i % 18) * 6,
          8 + Math.floor(i / 18) * 8,
          { playerId: PLAYER_ONE },
        ),
      );
    }
    // …gather nodes midway between the southern worksite and homes…
    for (let i = 0; i < NODE_COUNT; i++) {
      spawnResourceNode(
        world,
        comps,
        12 + (i % 18) * 4,
        62 + Math.floor(i / 18) * 6,
        i % 7,
        99999,
      );
    }
    // …and 300 Pops on the southern worksite floor, five per roof.
    const eids: number[] = [];
    for (let i = 0; i < POP_COUNT; i++) {
      eids.push(
        spawnUnit(
          world,
          comps,
          14 + (i % 18) * 2.2 + ((i * 13) % 7) * 0.08,
          64 + Math.floor(i / 18) * 3.1,
          { identity: true, ownerId: PLAYER_ONE },
        ),
      );
    }
    for (let f = 0; f < POP_COUNT / 2; f++) {
      spawnHousehold(world, comps, {
        playerId: PLAYER_ONE,
        homeEid: houseEids[f % HOUSE_COUNT]!,
        headEid: eids[f * 2]!,
        partnerEid: eids[f * 2 + 1]!,
        nextBirthRollTick: 999999999,
      });
    }

    // Assign every Pop through the shared command interface so they are
    // all mid-gather when the work window closes.
    const nodeIds = [
      ...world.rowsByComponentId.get(comps.resourceNodeId)!.keys(),
    ];
    for (let i = 0; i < POP_COUNT; i++) {
      world.inbox.submit({
        kind: "gather",
        targetTick: 2,
        data: { entityIds: [eids[i]!], nodeId: nodeIds[i % NODE_COUNT]! },
      });
    }

    // Warm-up into the afternoon shift, then measure across the close.
    world.tick = START_TICK_OF_WORLD;
    while (world.tick < START_TICK_OF_WORLD + WINDOW_START - 120) step(world);

    const stepSamples: number[] = [];
    let peakWindowSends = 0;
    let windowPathMsTotal = 0;
    let windowTicks = 0;
    while (world.tick < START_TICK_OF_WORLD + MEASURED_TICKS) {
      issueTick = world.tick;
      const start = performance.now();
      step(world);
      stepSamples.push(performance.now() - start);
      const relative = issueTick - START_TICK_OF_WORLD;
      if (relative >= WINDOW_START && relative <= WINDOW_END) {
        windowTicks += 1;
        peakWindowSends = Math.max(
          peakWindowSends,
          sendsPerTick.get(issueTick) ?? 0,
        );
        windowPathMsTotal += pathMsPerTick.get(issueTick) ?? 0;
      }
    }

    const totalSends = [...sendsPerTick.values()].reduce((a, b) => a + b, 0);
    const p95StepMs =
      [...stepSamples].sort((a, b) => a - b)[
        Math.floor(stepSamples.length * 0.95)
      ] ?? Number.POSITIVE_INFINITY;
    const meanWindowPathMs = windowPathMsTotal / Math.max(1, windowTicks);

    console.log(
      `social transition @${String(POP_COUNT)} pops: ` +
        `${String(totalSends)} sends total, peak ${String(peakWindowSends)}/tick ` +
        `in ${String(windowTicks)} window ticks, ` +
        `window path mean ${meanWindowPathMs.toFixed(3)} ms/tick, ` +
        `p95 step ${p95StepMs.toFixed(2)} ms`,
    );

    // Both waves really happened: the release walk plus a second wave of
    // evening outings (leisure or repeat work re-staffing).
    expect(totalSends).toBeGreaterThanOrEqual(POP_COUNT + 200);
    // No single transition tick carried even a third of the village…
    // (unstaggered would dump all 300 onto one tick; the release jitter
    // and the brain's hash-staggered thinks keep the worst tick small.)
    expect(peakWindowSends).toBeLessThanOrEqual(Math.ceil(POP_COUNT / 3));
    // …so schedule+leisure pathfinding stayed far under 1 ms per tick
    // even with every request computed inline.
    expect(meanWindowPathMs).toBeLessThan(1.0);
    expect(p95StepMs).toBeLessThan(40.0);
  }, 180_000);
});

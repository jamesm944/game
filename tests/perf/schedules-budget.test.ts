/**
 * Schedules transition budget — SPEC §2.4 / M3-T6 acceptance.
 *
 * "Off-work transitions staggered per-Pop ±90 s jitter (paths trickle,
 * never stampede)." This gate pins that at the §2.3 envelope floor
 * (300 assigned Pops): when the gatherer work window closes at 18:00,
 * every evening release plans one homeward path, and the deterministic
 * (eid, day) hash spreads those issuances across the jitter window
 * instead of dumping them onto a single tick. Inside the transition
 * window the pathfinding work per tick must stay under 1 ms even with
 * every A* computed inline on the main thread; later stall-sidestep
 * re-paths are the movement system's existing recovery behavior and are
 * reported, not gated here.
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
  TRANSITION_JITTER_SIM_SECONDS,
  WORK_CLOSE_MINUTE,
  createSchedulesSystem,
} from "../../src/sim/systems/schedules";
import { spawnHousehold } from "../../src/sim/components/household";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

const POP_COUNT = 300;
const HOUSE_COUNT = 60;
const NODE_COUNT = 60; // 8 slots each ≥ the whole workforce
const SIZE = 120;
/** Canonical clock: 10 ticks per sim-minute; gatherers close at 18:00. */
const CLOSE_TICK = (WORK_CLOSE_MINUTE / 1440) * 14_400; // 10,800
const JITTER_HALF_SPAN_TICKS = Math.round(
  (TRANSITION_JITTER_SIM_SECONDS * 14_400) / 86_400,
); // ±15
/** World is parked in the afternoon so the close arrives quickly. */
const START_TICK_OF_WORLD = 9_000;
const CLOSE_OFFSET = CLOSE_TICK - START_TICK_OF_WORLD;
/** The measured schedule-transition window: close ± full jitter. */
const WINDOW_START = CLOSE_OFFSET - JITTER_HALF_SPAN_TICKS - 5;
const WINDOW_END = CLOSE_OFFSET + JITTER_HALF_SPAN_TICKS + 15;
const MEASURED_TICKS = 2_400;

installSimPurityShims();

describe("schedules transition budget", () => {
  it("trickles 300 end-of-work homeward paths under 1 ms/tick", () => {
    // Instrumented synchronous transport: counts issuances and times
    // the inline A* (the work a real worker would absorb) per tick.
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
    const world = createWorld(20260910, {
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
    registerSystem(
      world,
      createSchedulesSystem({
        comps,
        players: [PLAYER_ONE],
      }),
    );
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [5000, 5000, 0, 0, 0, 0, 0],
    );
    createDropOffPoint(world, comps, 20.5, 95.5, PLAYER_ONE);

    // Sixty houses in well-spaced northern rows…
    const houseEids: number[] = [];
    for (let i = 0; i < HOUSE_COUNT; i++) {
      houseEids.push(
        stampFinishedBuilding(
          world,
          comps,
          "house",
          4 + (i % 18) * 6,
          4 + Math.floor(i / 18) * 8,
          { playerId: PLAYER_ONE },
        ),
      );
    }
    // …gather nodes midway between the southern worksite and the homes…
    const nodeEids: number[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      nodeEids.push(
        spawnResourceNode(
          world,
          comps,
          12 + (i % 18) * 4,
          62 + Math.floor(i / 18) * 6,
          i % 7,
          99999,
        ),
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
    for (let i = 0; i < POP_COUNT; i++) {
      world.inbox.submit({
        kind: "gather",
        targetTick: 2,
        data: { entityIds: [eids[i]!], nodeId: nodeEids[i % NODE_COUNT]! },
      });
    }

    // Warm-up into the afternoon shift, then measure past full close.
    world.tick = START_TICK_OF_WORLD;
    while (world.tick < START_TICK_OF_WORLD + WINDOW_START - 120) step(world);
    expect(world.tick).toBeLessThan(START_TICK_OF_WORLD + CLOSE_OFFSET);

    const stepSamples: number[] = [];
    let peakWindowSends = 0;
    let windowPathMsTotal = 0;
    let windowTicks = 0;
    while (world.tick < START_TICK_OF_WORLD + MEASURED_TICKS) {
      issueTick = world.tick; // sends during this step bucket here
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
    const meanStepMs =
      stepSamples.reduce((a, b) => a + b, 0) / stepSamples.length;
    const p95StepMs =
      [...stepSamples].sort((a, b) => a - b)[
        Math.floor(stepSamples.length * 0.95)
      ] ?? Number.POSITIVE_INFINITY;
    const meanWindowPathMs = windowPathMsTotal / Math.max(1, windowTicks);

    // The transition really happened: essentially every assigned Pop
    // issued its homeward path around the close…
    expect(totalSends).toBeGreaterThanOrEqual(POP_COUNT - 20);
    // …but inside the transition window no single tick carried even a
    // quarter of the village (unstaggered would spike to the full
    // population onto one tick).
    expect(peakWindowSends).toBeLessThanOrEqual(Math.ceil(POP_COUNT / 4));
    // …so schedule-driven pathfinding stayed far under 1 ms per tick
    // even with every request computed inline.
    expect(meanWindowPathMs).toBeLessThan(1.0);
    // Sanity ceiling on whole-step cost (crowd steering dominates).
    expect(p95StepMs).toBeLessThan(40.0);

    console.log(
      `schedules transition @${String(POP_COUNT)} pops: ` +
        `${String(totalSends)} sends total, peak ${String(peakWindowSends)}/tick ` +
        `in window (${String(windowTicks)} ticks), ` +
        `window path mean ${meanWindowPathMs.toFixed(3)} ms/tick, ` +
        `step mean ${meanStepMs.toFixed(2)} ms, p95 ${p95StepMs.toFixed(2)} ms`,
    );
  }, 120_000);
});

/**
 * M4-T5a golden harness — SPEC §2.11 Wonder victory / issue #60.
 *
 * A FULL two-player game ends in a WONDER win: the very expensive
 * Imperial completing act (the wonder definition's victory role pins
 * holdTicks; no sustain gate — a standing Wonder IS the condition) is
 * stamped mid-run and the hold-only frame banks every SUSTAINING
 * heartbeat interval until the accumulated hold crosses the timer. The
 * evaluator decides on the first cadence tick whose closed-interval
 * SUSTAINING sum covers timerTicks.
 *
 * Pinned here:
 * - milestone digests every 250th tick plus the freeze tail;
 * - a legible hold trace: per-cadence readouts (act state, accumulated
 *   hold) proving NO interval counts before the Wonder stands and the
 *   hold climbs monotonically once it does;
 * - semantic gates: decision lands on the cadence, winners [player]
 *   with losers [{AI, wonder}], and the decisive tick is the FIRST
 *   crossing of the hold timer;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import {
  VICTORY_CHECK_CADENCE_TICKS,
  WONDER_EVALUATOR,
  createVictorySystem,
  evaluateOutcome,
  victoryPathReadout,
} from "../../../src/sim/systems/victory";
import {
  VICTORY_PATH_WONDER,
  VICTORY_STATUS_SUSTAINING,
  readVictoryChecks,
} from "../../../src/sim/components/victory";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const SIZE = 32;
const SEED = 20261001;
const LIMIT_TICKS = 1400;
const MILESTONE_EVERY = 250;
const WONDER_TICK = 450;

interface TracePoint {
  readonly tick: number;
  readonly actComplete: boolean;
  readonly metric: number;
  readonly holdTicks: number;
}

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly wonderTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly trace: readonly TracePoint[];
  readonly sustainingBeforeAct: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runScenario(): RunState {
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
  });
  const comps: SimComponents = defineSimComponents(world);

  // Victory LAST per its contract (nothing else runs in this fixture).
  registerSystem(world, createVictorySystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);

  let decidedTick = -1;
  let wonderTick = -1;
  const digests: { tick: number; digest: string }[] = [];
  const trace: TracePoint[] = [];
  const ctx = () => ({ world, comps });

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;

    // Mid-run completing act: the Wonder stands from here on.
    if (tick === WONDER_TICK) {
      stampFinishedBuilding(world, comps, "wonder", 14, 14, {
        playerId: PLAYER_ONE,
      });
      wonderTick = tick;
    }

    if (tick % VICTORY_CHECK_CADENCE_TICKS === 0) {
      const readout = victoryPathReadout(ctx(), WONDER_EVALUATOR, PLAYER_ONE);
      trace.push({
        tick,
        actComplete: readout.actComplete,
        metric: readout.metric,
        holdTicks: readout.holdTicks,
      });
    }
    if (tick % MILESTONE_EVERY === 0 || tick === LIMIT_TICKS) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
    if (decidedTick < 0 && evaluateOutcome(world, comps).decided) {
      decidedTick = tick;
    }
    if (decidedTick >= 0 && tick >= decidedTick + 90) break; // freeze proof
  }

  return {
    digests,
    finalTick: world.tick,
    decidedTick,
    wonderTick,
    outcome: evaluateOutcome(world, comps),
    trace,
    sustainingBeforeAct: readVictoryChecks(world, comps, PLAYER_ONE).filter(
      (entry) =>
        entry.status === VICTORY_STATUS_SUSTAINING &&
        entry.pathCode === VICTORY_PATH_WONDER &&
        entry.tick < WONDER_TICK,
    ).length,
  };
}

/** The map layers come from buildLayers directly; nothing to recompute. */
let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t5a — player wonder victory", () => {
  it("ends the full game in a held-wonder win", () => {
    const run = mainRun();

    expect(run.wonderTick).toBe(WONDER_TICK);
    expect(run.decidedTick).toBeGreaterThan(run.wonderTick);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([{ playerId: 1, reason: "wonder" }]);
  });

  it("counts no hold interval before the Wonder stands", () => {
    const run = mainRun();

    expect(run.sustainingBeforeAct).toBe(0);
    let lastHold = 0;
    for (const point of run.trace) {
      if (!point.actComplete) {
        expect(point.holdTicks).toBe(0);
      } else {
        // Hold progress is monotone once the act stands.
        expect(point.holdTicks).toBeGreaterThanOrEqual(lastHold);
        lastHold = point.holdTicks;
      }
    }
  });

  it("crosses the hold timer exactly once, at the decision", () => {
    const run = mainRun();
    const timer = WONDER_EVALUATOR.timerTicks!;

    const preDecision = run.trace.filter(
      (point) => point.tick <= run.decidedTick,
    );
    const firstCrossing = preDecision.findIndex(
      (point) => point.holdTicks >= timer,
    );
    expect(firstCrossing).toBeGreaterThan(0);
    for (let i = 0; i < firstCrossing; i++) {
      expect(preDecision[i]!.holdTicks).toBeLessThan(timer);
    }
    expect(run.decidedTick).toBe(
      preDecision[firstCrossing]!.tick + VICTORY_CHECK_CADENCE_TICKS,
    );
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = mainRun();

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests.length).toBeGreaterThan(4);
    expect(run.digests).toMatchSnapshot();
    expect(run.finalTick).toBeLessThanOrEqual(LIMIT_TICKS);

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.trace).toEqual(run.trace);
  });
});

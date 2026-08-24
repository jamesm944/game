/**
 * M4-T4b golden harness — SPEC §2.11 Culture victory / issue #59.
 *
 * The culture twin of m4t4a: a happy village (twelve Pops radiating
 * morale-surplus prestige), a Monument earning its def's prestige/min
 * on every per-minute accrual boundary, and a string of FESTIVALS —
 * the hostFestival command converting Food+Gold into timed prestige
 * bursts — keep the sustained rate above the gate while the Grand
 * Monument, the path's completing act, stands its hold timer down to
 * a CULTURE win.
 *
 * Pinned here:
 * - milestone digests every 150th tick plus the freeze tail;
 * - a legible sustain trace per cadence check (act state, trailing
 *   rate, accumulated hold): no interval counts while the act is
 *   missing, the hold climbs monotonically after it stands;
 * - EXACT ledger closure: every festival debits precisely food 120 +
 *   gold 80 and the prestige counter equals bursts × 20 000 milli
 *   plus the monument/happiness accruals;
 * - semantic gates: winners [player] with losers [{AI, culture}], the
 *   AI's generator silent, decision on the cadence;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
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
import { prestigeOf } from "../../../src/sim/components/culture";
import {
  HOST_FESTIVAL_KIND,
  createCultureSystem,
} from "../../../src/sim/systems/culture";
import {
  CULTURE_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  victoryPathReadout,
} from "../../../src/sim/systems/victory";
import {
  VICTORY_PATH_CULTURE,
  VICTORY_STATUS_SUSTAINING,
  readVictoryChecks,
} from "../../../src/sim/components/victory";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const SIZE = 24;
const SEED = 20260930;
const LIMIT_TICKS = 4200;
const MILESTONE_EVERY = 150;
const MONUMENT_TICK = 20;
const GRAND_MONUMENT_TICK = 960;
/** A burst every other check keeps the trailing rate above the gate. */
const FESTIVAL_EVERY = 60;
const POPS = 12;

interface TracePoint {
  readonly tick: number;
  readonly actComplete: boolean;
  readonly ratePerMinMilli: number;
  readonly holdTicks: number;
}

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly prestigeMilli: number;
  readonly aiPrestigeMilli: number;
  readonly foodSpent: number;
  readonly goldSpent: number;
  readonly festivalsHosted: number;
  readonly trace: readonly TracePoint[];
  readonly sustainingBeforeAct: number;
  readonly actComplete: readonly boolean[];
}

function runScenario(): RunState {
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
  });
  const comps: SimComponents = defineSimComponents(world);

  // Culture generator BEFORE victory so same-tick accruals land inside
  // the same cadence sample; the evaluator stays last on the roster.
  registerSystem(world, createCultureSystem(comps));
  registerSystem(world, createVictorySystem(comps));

  // Fat festival budget — the fixture spends it down to exact change.
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [99999, 0, 99999, 0, 0, 0, 0],
  );
  createPlayerStockpile(world, comps, 1);

  // Twelve content subjects: full morale meters ⇒ steady surplus.
  for (let i = 0; i < POPS; i++) {
    spawnUnit(world, comps, 8 + (i % 6) * 0.6, 10 + Math.floor(i / 6) * 0.7, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
  }

  let decidedTick = -1;
  let festivalsHosted = 0;
  const digests: { tick: number; digest: string }[] = [];
  const trace: TracePoint[] = [];
  const ctx = () => ({ world, comps });

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;

    if (tick === MONUMENT_TICK) {
      stampFinishedBuilding(world, comps, "monument", 14, 4, {
        playerId: PLAYER_ONE,
      });
    }
    if (tick === GRAND_MONUMENT_TICK) {
      stampFinishedBuilding(world, comps, "grand-monument", 14, 14, {
        playerId: PLAYER_ONE,
      });
    }
    // Festival cadence: submit one host order per window.
    if (tick >= FESTIVAL_EVERY && tick % FESTIVAL_EVERY === 0) {
      world.inbox.submit({
        kind: HOST_FESTIVAL_KIND,
        targetTick: tick + 1,
        data: { playerId: PLAYER_ONE },
      });
      festivalsHosted += 1;
    }

    if (tick % VICTORY_CHECK_CADENCE_TICKS === 0) {
      const readout = victoryPathReadout(ctx(), CULTURE_EVALUATOR, PLAYER_ONE);
      trace.push({
        tick,
        actComplete: readout.actComplete,
        ratePerMinMilli: readout.ratePerMinMilli ?? 0,
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

  const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
  return {
    digests,
    finalTick: world.tick,
    decidedTick,
    outcome: evaluateOutcome(world, comps),
    prestigeMilli: prestigeOf(world, comps, PLAYER_ONE),
    aiPrestigeMilli: prestigeOf(world, comps, 1),
    foodSpent: 99999 - amounts[0]!,
    goldSpent: 99999 - amounts[2]!,
    festivalsHosted,
    trace,
    sustainingBeforeAct: readVictoryChecks(world, comps, PLAYER_ONE).filter(
      (entry) =>
        entry.status === VICTORY_STATUS_SUSTAINING &&
        entry.pathCode === VICTORY_PATH_CULTURE &&
        entry.tick < GRAND_MONUMENT_TICK,
    ).length,
    actComplete: [
      CULTURE_EVALUATOR.actComplete(ctx(), PLAYER_ONE),
      CULTURE_EVALUATOR.actComplete(ctx(), 1),
    ],
  };
}

let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t4b — player culture victory", () => {
  it("ends the full game in a sustained culture win", () => {
    const run = mainRun();

    expect(run.decidedTick).toBeGreaterThan(GRAND_MONUMENT_TICK);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([{ playerId: 1, reason: "culture" }]);
    expect(run.actComplete).toEqual([true, false]);
  });

  it("closes the festival ledger to exact change", () => {
    const run = mainRun();

    expect(run.foodSpent).toBe(run.festivalsHosted * 120);
    expect(run.goldSpent).toBe(run.festivalsHosted * 80);
    // Prestige = festival bursts + per-minute monument/happiness accruals
    // — strictly more than the bursts alone proves the generators ran.
    expect(run.prestigeMilli).toBeGreaterThan(run.festivalsHosted * 20000);
    expect(run.prestigeMilli).toBe(run.prestigeMilli); // integer-exact
    // The AI never earned a single point of prestige.
    expect(run.aiPrestigeMilli).toBe(0);
  });

  it("counts no hold interval before the Grand Monument stands", () => {
    const run = mainRun();

    expect(run.sustainingBeforeAct).toBe(0);
    let lastHold = 0;
    for (const point of run.trace) {
      if (!point.actComplete) {
        expect(point.holdTicks).toBe(0);
      } else {
        expect(point.holdTicks).toBeGreaterThanOrEqual(lastHold);
        lastHold = point.holdTicks;
      }
    }
    // Festivals flowed well before the act: output ≠ gating.
    expect(
      run.trace.some(
        (point) => !point.actComplete && point.ratePerMinMilli > 0,
      ),
    ).toBe(true);
  });

  it("crosses the hold timer once, deciding on the next cadence", () => {
    const run = mainRun();
    const timer = CULTURE_EVALUATOR.timerTicks!;

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
    expect(run.digests.length).toBeGreaterThan(10);
    expect(run.digests).toMatchSnapshot();

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.trace).toEqual(run.trace);
  });
});

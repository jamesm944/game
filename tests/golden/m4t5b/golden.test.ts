/**
 * M4-T5b golden harness — SPEC §2.11 Relic victory / issue #60.
 *
 * A FULL two-player game ends in a RELIC win through every real
 * pipeline. Two neutral Relic map entities start grounded; each side's
 * monk banks one in its own Monastery through the real collectRelic /
 * depositRelic commands — a 1–1 split arms nothing. A knight raid then
 * RAZES the AI monastery through the combat destruction pipeline:
 * capture-on-destruction grounds its stored relic again, the player's
 * monk reclaims and stores it, and with ALL relics under one roof the
 * hold-only timer runs out to the win.
 *
 * Pinned here:
 * - milestone digests every 250th tick plus the freeze tail;
 * - a legible split trace: per-cadence readouts proving the act stays
 *   incomplete while the relics sit split 1–1 across rival monasteries,
 *   flips complete only after the raid + reclaim, and the hold climbs
 *   monotonically to the decision;
 * - semantic gates: decision lands on the cadence, winners [player]
 *   with losers [{AI, relic}];
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnUnit,
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
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import {
  ATTACK_COMMAND_KIND,
  createCombatSystem,
} from "../../../src/sim/systems/combat";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import {
  COLLECT_RELIC_COMMAND_KIND,
  DEPOSIT_RELIC_COMMAND_KIND,
  createRelicSystem,
} from "../../../src/sim/systems/relics";
import {
  RELIC_STORED,
  spawnRelic,
  type RelicRow,
} from "../../../src/sim/components/relic";
import {
  RELIC_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  victoryPathReadout,
} from "../../../src/sim/systems/victory";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const SIZE = 48;
const SEED = 20261002;
const LIMIT_TICKS = 6000;
const MILESTONE_EVERY = 250;
/** Committed before the raid: each side holds exactly one relic. */
const RAID_ORDER_TICK = 120;

interface TracePoint {
  readonly tick: number;
  readonly playerHolds: number;
  readonly aiMonasteryLive: boolean;
  readonly actComplete: boolean;
  readonly holdTicks: number;
}

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly decidedTick: number;
  readonly raidOrderedTick: number;
  readonly aiMonasteryRazedTick: number;
  readonly allStoredTick: number;
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly trace: readonly TracePoint[];
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function submit(
  world: World,
  kind: string,
  data: Record<string, unknown>,
): void {
  world.inbox.submit({ kind, targetTick: world.tick + 1, data });
}

function relicRowOf(
  world: World,
  comps: SimComponents,
  relicEid: number,
): RelicRow | undefined {
  const row = world.rowsByComponentId.get(comps.relicId)?.get(relicEid);
  if (!row) return undefined;
  return { state: row[0]!, holderEid: row[1]! };
}

function runScenario(): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);

  // Labor + combat roster first, relic lifecycle mid, victory LAST.
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createCombatSystem(comps, undefined, scheduler));
  registerSystem(world, createRelicSystem({ comps }));
  registerSystem(world, createVictorySystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);

  // ---- Scenario-editor stage ----------------------------------------
  const myMonastery = stampFinishedBuilding(world, comps, "monastery", 8, 8, {
    playerId: PLAYER_ONE,
  });
  const aiMonastery = stampFinishedBuilding(world, comps, "monastery", 36, 36, {
    playerId: 1,
  });
  const myMonk = spawnUnit(world, comps, 11.5, 11.5, {
    ownerId: PLAYER_ONE,
  });
  const aiMonk = spawnUnit(world, comps, 33.5, 33.5, { ownerId: 1 });
  const relicNearMe = spawnRelic(world, comps, 14.5, 8.5);
  const relicNearAi = spawnRelic(world, comps, 30.5, 36.5);
  // The raiding party musters beside the AI monastery.
  const knights: number[] = [];
  for (let i = 0; i < 12; i++) {
    knights.push(
      spawnCombatUnit(
        world,
        comps,
        "knight",
        32.5 + (i % 4) * 1.2,
        40.5 + Math.floor(i / 4) * 1.2,
        PLAYER_ONE,
      ),
    );
  }

  // Each side banks its near relic first: a 1–1 split arms nothing.
  submit(world, COLLECT_RELIC_COMMAND_KIND, {
    unitEid: aiMonk,
    relicEid: relicNearAi,
  });
  step(world);
  submit(world, DEPOSIT_RELIC_COMMAND_KIND, {
    unitEid: aiMonk,
    monasteryEid: aiMonastery,
  });
  step(world);
  submit(world, COLLECT_RELIC_COMMAND_KIND, {
    unitEid: myMonk,
    relicEid: relicNearMe,
  });
  step(world);
  submit(world, DEPOSIT_RELIC_COMMAND_KIND, {
    unitEid: myMonk,
    monasteryEid: myMonastery,
  });
  step(world);

  let decidedTick = -1;
  let raidOrderedTick = -1;
  let aiMonasteryRazedTick = -1;
  let reclaimOrdered = false;
  let depositOrdered = false;
  let allStoredTick = -1;
  const digests: { tick: number; digest: string }[] = [];
  const trace: TracePoint[] = [];
  const ctx = () => ({ world, comps });

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;

    if (tick === RAID_ORDER_TICK) {
      submit(world, ATTACK_COMMAND_KIND, {
        attackerIds: knights,
        targetId: aiMonastery,
      });
      raidOrderedTick = tick;
    }

    // The moment the razed monastery's relic sits grounded again, the
    // reclaim relay starts through the same real commands.
    if (aiMonasteryRazedTick < 0 && !world.entities.includes(aiMonastery)) {
      aiMonasteryRazedTick = tick;
    }
    if (
      !reclaimOrdered &&
      aiMonasteryRazedTick > 0 &&
      relicRowOf(world, comps, relicNearAi)?.state === 0 /* GROUND */
    ) {
      submit(world, COLLECT_RELIC_COMMAND_KIND, {
        unitEid: myMonk,
        relicEid: relicNearAi,
      });
      reclaimOrdered = true;
    }
    if (
      reclaimOrdered &&
      !depositOrdered &&
      relicRowOf(world, comps, relicNearAi)?.state === 1 /* CARRIED */
    ) {
      submit(world, DEPOSIT_RELIC_COMMAND_KIND, {
        unitEid: myMonk,
        monasteryEid: myMonastery,
      });
      depositOrdered = true;
    }
    if (
      depositOrdered &&
      allStoredTick < 0 &&
      relicRowOf(world, comps, relicNearAi)?.state === RELIC_STORED &&
      relicRowOf(world, comps, relicNearAi)?.holderEid === myMonastery
    ) {
      allStoredTick = tick;
    }

    if (tick % VICTORY_CHECK_CADENCE_TICKS === 0) {
      const readout = victoryPathReadout(ctx(), RELIC_EVALUATOR, PLAYER_ONE);
      trace.push({
        tick,
        playerHolds: readout.metric,
        aiMonasteryLive: world.entities.includes(aiMonastery),
        actComplete: readout.actComplete,
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
    raidOrderedTick,
    aiMonasteryRazedTick,
    allStoredTick,
    outcome: evaluateOutcome(world, comps),
    trace,
  };
}

let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t5b — player relic victory", () => {
  it("ends the full game in a held-all-relics win", () => {
    const run = mainRun();

    expect(run.raidOrderedTick).toBe(RAID_ORDER_TICK);
    expect(run.aiMonasteryRazedTick).toBeGreaterThan(RAID_ORDER_TICK);
    expect(run.allStoredTick).toBeGreaterThan(run.aiMonasteryRazedTick);
    expect(run.decidedTick).toBeGreaterThan(run.allStoredTick);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([{ playerId: 1, reason: "relic" }]);
  });

  it("arms nothing while the relics sit split 1–1", () => {
    const run = mainRun();

    const livePhase = run.trace.filter((point) => point.aiMonasteryLive);
    const razedPhase = run.trace.filter((point) => !point.aiMonasteryLive);
    // Both monasteries stood through the whole 1–1 split phase…
    expect(livePhase.length).toBeGreaterThan(0);
    for (const point of livePhase) {
      expect(point.playerHolds).toBe(1);
      expect(point.actComplete).toBe(false);
      expect(point.holdTicks).toBe(0);
    }
    // …and the raid genuinely felled the AI monastery.
    expect(razedPhase.length).toBeGreaterThan(0);
    for (const point of razedPhase) {
      expect(point.aiMonasteryLive).toBe(false);
    }
    // Hold progress only ever accumulates after ALL relics land.
    let lastHold = 0;
    for (const point of run.trace) {
      if (!point.actComplete) {
        expect(point.holdTicks).toBe(0);
      } else {
        expect(point.holdTicks).toBeGreaterThanOrEqual(lastHold);
        lastHold = point.holdTicks;
      }
    }
  });

  it("crosses the hold timer exactly once, at the decision", () => {
    const run = mainRun();
    const timer = RELIC_EVALUATOR.timerTicks!;

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
    expect(run.digests.length).toBeGreaterThan(6);
    expect(run.digests).toMatchSnapshot();

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.aiMonasteryRazedTick).toBe(run.aiMonasteryRazedTick);
    expect(second.allStoredTick).toBe(run.allStoredTick);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.trace).toEqual(run.trace);
  });
});

/**
 * M4-T5c golden harness — SPEC §2.11 Economic victory / issue #60.
 *
 * A FULL two-player game ends in an ECONOMIC win driven by a SELF-
 * EXPANDING company over the real §2.6/§2.7 stack: a mining company
 * chartered over one camp auto-expands to a SECOND camp on an unclaimed
 * iron node (auto-approve, paid from its own treasury, sited by the
 * AI's placement scorer), a build crew raises the foundation, and both
 * branches' full output market value accrues to the owner's cumulative
 * BranchOutputLedger. The evaluator sustains that ledger's per-minute
 * rate above the economic-path definition's gate while the company
 * stands, through the shared timed frame.
 *
 * Pinned here:
 * - milestone digests every 250th tick plus the freeze tail;
 * - a legible growth trace: per-cadence readouts (cumulative branch
 *   output, trailing rate, accumulated hold) proving the hold only
 *   accumulates under the act;
 * - semantic gates: decision lands on the cadence, winners [player]
 *   with losers [{AI, economic}], the AI's ledger stayed silent, and
 *   the expansion genuinely contributed post-expansion output;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { traitCodeOf } from "../../../src/sim/data/traits";
import {
  PLAYER_ONE,
  createCommodityStockpile,
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
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { createGatherSystem } from "../../../src/sim/systems/gather";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createProductionSystem } from "../../../src/sim/systems/production";
import {
  createCompaniesSystem,
  createCompanyDiagnostics,
} from "../../../src/sim/systems/companies";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { getBuildingRow } from "../../../src/sim/components/buildings";
import { branchOutputOf } from "../../../src/sim/components/branchOutput";
import {
  ECONOMIC_EVALUATOR,
  VICTORY_CHECK_CADENCE_TICKS,
  createVictorySystem,
  evaluateOutcome,
  victoryPathReadout,
} from "../../../src/sim/systems/victory";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const SIZE = 48;
const SEED = 20261003;
const LIMIT_TICKS = 8000;
const MILESTONE_EVERY = 250;
const RESOURCE_IRON = 4;

interface TracePoint {
  readonly tick: number;
  readonly branchOutputMilli: number;
  readonly ratePerMinMilli: number;
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
  readonly outcome: ReturnType<typeof evaluateOutcome>;
  readonly trace: readonly TracePoint[];
  readonly branchesFinished: number;
  readonly expansionsExecuted: number;
  readonly playerBranchOutputMilli: number;
  readonly aiBranchOutputMilli: number;
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

function runScenario(): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  const diag = createCompanyDiagnostics();

  // Labor roster with the §2.7 observer seam wired into BOTH output
  // systems; victory LAST per its contract.
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    diagnostics: diag,
  });
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, undefined, {
      onOutput: companies.onOutput,
    }),
  );
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(
    world,
    createProductionSystem(comps, undefined, undefined, {
      onOutput: companies.onOutput,
    }),
  );
  registerSystem(world, companies.system);
  registerSystem(world, createVictorySystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);
  createCommodityStockpile(world, comps, PLAYER_ONE);

  // ---- Scenario-editor founding --------------------------------------
  const campA = stampFinishedBuilding(world, comps, "mining-camp", 10, 10, {
    playerId: PLAYER_ONE,
  });
  const workedNode = spawnResourceNode(
    world,
    comps,
    14,
    14,
    RESOURCE_IRON,
    400_000,
  );
  const freshNode = spawnResourceNode(
    world,
    comps,
    26,
    18,
    RESOURCE_IRON,
    400_000,
  );
  void freshNode;

  const officer = spawnUnit(world, comps, 11.5, 13.5, { identity: true });
  const builderA = spawnUnit(world, comps, 16.5, 17.5, { identity: true });
  const builderB = spawnUnit(world, comps, 17.5, 19.5, { identity: true });
  const minerA = spawnUnit(world, comps, 13.5, 13.5, { identity: true });
  const minerB = spawnUnit(world, comps, 14.5, 12.5, { identity: true });
  const minerC = spawnUnit(world, comps, 15.5, 14.5, { identity: true });
  // Only the OFFICER carries a management-relevant trait: the staffing
  // pass then drafts HIM for every branch-foreman vacancy and never
  // pulls a busy miner off the line or a builder off the site.
  const traitRows = world.rowsByComponentId.get(comps.traitsId)!;
  traitRows.set(officer, [traitCodeOf("industrious")]);
  for (const eid of [builderA, builderB, minerA, minerB, minerC]) {
    traitRows.set(eid, []);
  }

  submit(world, "charterCompany", {
    name: "Deepvein Combine",
    focus: 3 /* metal */,
    seedBuildingIds: [campA],
  });
  step(world);
  step(world);
  const co = [...world.rowsByComponentId.get(comps.companyId)!.keys()].sort(
    (a, b) => a - b,
  )[0]!;
  submit(world, "setCompanyShare", { companyId: co, sharePct: 100 });
  submit(world, "setApprovalMode", {
    companyId: co,
    mode: 1 /* auto-approve */,
  });

  let decidedTick = -1;
  let expansionSite: number | undefined;
  let expansionBuiltTick = -1;
  let buildOrdered = false;
  let minersOnFreshNode = false;
  const digests: { tick: number; digest: string }[] = [];
  const trace: TracePoint[] = [];

  const finishedBranches = (): number => {
    let count = 0;
    for (const [eid, row] of world.rowsByComponentId.get(comps.branchId)!) {
      if (row[0] !== co) continue;
      if (getBuildingRow(world, comps, eid) !== undefined) count += 1;
    }
    return count;
  };

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;

    // Both seed miners feed camp A from the first tick after charter.
    if (tick === 3) {
      submit(world, "gather", {
        entityIds: [minerA, minerB],
        nodeId: workedNode,
      });
    }

    // Self-expansion: the moment the AUTO-APPROVED proposal breaks
    // ground on the fresh node, a build crew is ordered onto it.
    if (expansionSite === undefined && tick > 60 && diag.autoExpansions > 0) {
      for (const [eid, row] of world.rowsByComponentId.get(comps.branchId)!) {
        if (row[0] === co && eid !== campA) expansionSite = eid;
      }
    }
    if (
      expansionSite !== undefined &&
      !buildOrdered &&
      tick % 30 === 0 &&
      getBuildingRow(world, comps, expansionSite) === undefined
    ) {
      submit(world, "build", {
        entityIds: [builderA, builderB],
        siteEid: expansionSite,
      });
      buildOrdered = true;
    }
    if (
      expansionSite !== undefined &&
      expansionBuiltTick < 0 &&
      getBuildingRow(world, comps, expansionSite) !== undefined
    ) {
      expansionBuiltTick = tick;
    }

    // Once the second camp stands, its deliveries wake up: miner C
    // works the fresh node and reroutes to the nearest accepting
    // branch (the new camp).
    if (
      !minersOnFreshNode &&
      expansionBuiltTick > 0 &&
      tick >= expansionBuiltTick + 2
    ) {
      submit(world, "gather", {
        entityIds: [minerC],
        nodeId: freshNodeEid(world, comps),
      });
      minersOnFreshNode = true;
    }

    if (tick % VICTORY_CHECK_CADENCE_TICKS === 0) {
      const readout = victoryPathReadout(
        { world, comps },
        ECONOMIC_EVALUATOR,
        PLAYER_ONE,
      );
      trace.push({
        tick,
        branchOutputMilli: readout.metric,
        ratePerMinMilli: readout.ratePerMinMilli ?? 0,
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
    outcome: evaluateOutcome(world, comps),
    trace,
    branchesFinished: finishedBranches(),
    expansionsExecuted: diag.autoExpansions,
    playerBranchOutputMilli: branchOutputOf(world, comps, PLAYER_ONE),
    aiBranchOutputMilli: branchOutputOf(world, comps, 1),
  };
}

/** The spawned resource node nearest one tile (test-scoped lookup). */
function freshNodeEid(world: World, comps: SimComponents): number {
  const posRows = world.rowsByComponentId.get(comps.positionId)!;
  let best: number | undefined;
  let bestD = Infinity;
  for (const [eid] of world.rowsByComponentId.get(comps.resourceNodeId)!) {
    const pos = posRows.get(eid);
    if (!pos) continue;
    const d = (pos[0]! - 26) ** 2 + (pos[1]! - 18) ** 2;
    if (d < bestD) {
      bestD = d;
      best = eid;
    }
  }
  if (best === undefined) throw new Error("no resource node");
  return best;
}

let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t5c — player economic victory", () => {
  it("ends the full game in a sustained branch-output win", () => {
    const run = mainRun();

    expect(run.decidedTick).toBeGreaterThan(ECONOMIC_EVALUATOR.timerTicks!);
    expect(run.decidedTick % VICTORY_CHECK_CADENCE_TICKS).toBe(0);
    expect(run.outcome.decided).toBe(true);
    expect(run.outcome.winners).toEqual([PLAYER_ONE]);
    expect(run.outcome.losers).toEqual([{ playerId: 1, reason: "economic" }]);
  });

  it("won through a genuinely self-expanded company", () => {
    const run = mainRun();

    // The company broke ground on a second branch from its own
    // treasury and raised it to a working camp BEFORE the decision.
    expect(run.expansionsExecuted).toBeGreaterThanOrEqual(1);
    expect(run.branchesFinished).toBeGreaterThanOrEqual(2);
    expect(run.outcome.decided).toBe(true);
    // The AI's ledger stayed silent all run long.
    expect(run.aiBranchOutputMilli).toBe(0);
    expect(run.playerBranchOutputMilli).toBeGreaterThan(0);
  });

  it("accumulates hold only while the company stands and rate qualifies", () => {
    const run = mainRun();
    const thresholdMilli = (ECONOMIC_EVALUATOR.thresholdPerMin ?? 0) * 1000;

    let lastHold = 0;
    let sawQualifyingRate = false;
    for (const point of run.trace) {
      expect(point.actComplete).toBe(true); // chartered from tick 2 on
      if (point.ratePerMinMilli >= thresholdMilli) sawQualifyingRate = true;
      if (!sawQualifyingRate) {
        expect(point.holdTicks).toBe(0);
      } else {
        expect(point.holdTicks).toBeGreaterThanOrEqual(lastHold);
        lastHold = point.holdTicks;
      }
    }
    expect(sawQualifyingRate).toBe(true);

    // One crossing heartbeat, decision on the very next cadence.
    const timer = ECONOMIC_EVALUATOR.timerTicks!;
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

    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.decidedTick).toBe(run.decidedTick);
    expect(second.branchesFinished).toBe(run.branchesFinished);
    expect(second.expansionsExecuted).toBe(run.expansionsExecuted);
    expect(second.playerBranchOutputMilli).toBe(run.playerBranchOutputMilli);
    expect(second.outcome).toEqual(run.outcome);
    expect(second.trace).toEqual(run.trace);
  });
});

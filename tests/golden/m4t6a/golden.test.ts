/**
 * M4-T6a golden harness — SPEC §2.8 layer 3, density RAID / issue #61.
 *
 * An UNDEFENDED player expansion gets punished by the AI military
 * manager's utility-scored targeting. Two player structures sit inside
 * AI vision: a lone house NEARER the AI town, and a lumber camp
 * FARTHER away but swarming with scouted villagers. A naive
 * nearest-target strike would hit the house; the §2.8 layer-3 scorer
 * (villager-density term dominates the distance penalty) raids the
 * CAMP instead — through the real fog planes, KnowledgeView and the
 * shared command inbox, with the main base never even seen:
 *
 *   - exactly ONE offensive draft (the one-shot strike/raid memory),
 *     classified `raid` because scouted villagers cluster on the target;
 *   - the draft targets the camp, is fog-legitimate, and marches the
 *     whole army;
 *   - the nearer house SURVIVES — density beat proximity;
 *   - the far main base (TC + barracks outside every sight circle) is
 *     never targeted: no API exists to attack what was never scouted;
 *   - villagers are untargetable (M2-T5 contract) — all survive;
 *   - extended canary: two identical runs agree byte-for-byte.
 *
 * Milestone digests land every 150th tick; regenerate ONLY via
 * golden:record.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import { getBuildingRow } from "../../../src/sim/components/buildings";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type SimSystem,
  type World,
} from "../../../src/sim/core/world";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { createGatherSystem } from "../../../src/sim/systems/gather";
import {
  createPlacementSystem,
  stampFinishedBuilding,
} from "../../../src/sim/systems/placement";
import { createConstructionSystem } from "../../../src/sim/systems/construction";
import { createTrainingSystem } from "../../../src/sim/systems/training";
import { createAgeSystem } from "../../../src/sim/systems/age";
import { createCombatSystem } from "../../../src/sim/systems/combat";
import { createEquipmentSystem } from "../../../src/sim/systems/equipment";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../../../src/sim/systems/fog";
import { setupAiOpponent, AI_PLAYER } from "../../../src/sim/ai/bootstrap";
import { createAiKnowledge } from "../../../src/sim/ai/knowledge";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
} from "../../../src/sim/ai/planner";
import type { Strategy } from "../../../src/sim/ai/buildOrder";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const SIZE = 40;
const SEED = 20261006;
const LIMIT_TICKS = 900;
const MILESTONE_EVERY = 50;

/**
 * Attack-less strategy: the scripted build-order layer has nothing to
 * say here — the OFFENSIVE comes entirely from the §2.8 layer-3 manager
 * (threshold 2, utility-scored target).
 */
const raidStrategy: Strategy = {
  id: "density-raid-mini",
  villagerTarget: 0,
  gatherWeights: { food: 1, wood: 0, gold: 0 },
  attackArmyThreshold: 2,
  steps: [],
};

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly campDestroyTick: number;
  readonly offensiveDrafts: readonly {
    readonly tick: number;
    readonly targetId: number;
    readonly attackerCount: number;
    readonly targetVisibleToAi: boolean;
    readonly purpose: string;
  }[];
  readonly villagersAliveAtEnd: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function primeHp(
  world: World,
  comps: SimComponents,
  eid: number,
  hp: number,
): void {
  (getBuildingRow(world, comps, eid) as number[])[4] = hp;
}

function runScenario(): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(SIZE, 2);
  const world: World = createWorld(SEED, {
    size: SIZE,
    layers: openFieldLayers(SIZE),
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  const comps: SimComponents = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  const systems: SimSystem[] = [
    createMovementSystem(comps, scheduler),
    createGatherSystem(comps, scheduler),
    createPlacementSystem(comps),
    createConstructionSystem(comps),
    createTrainingSystem(comps),
    createAgeSystem(comps),
    createCombatSystem(comps, undefined, scheduler),
    createEquipmentSystem(comps),
  ];
  for (const system of systems) registerSystem(world, system);

  // ---- Player zero: ledgers; FAR main base the AI never sees --------
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 600, 100, 0, 0, 0, 0]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  stampFinishedBuilding(world, comps, "town-center", 34, 34, {
    playerId: PLAYER_ONE,
  });
  const barracksEid = stampFinishedBuilding(world, comps, "barracks", 30, 30, {
    playerId: PLAYER_ONE,
  });
  void barracksEid;

  // The UNDEFENDED EXPANSION inside AI vision: a lumber camp worked by
  // three villagers (raiders' prize), plus a decoy house NEARER the AI
  // town with nobody home — nearest-target logic would pick the house.
  const campEid = stampFinishedBuilding(world, comps, "lumber-camp", 13, 10, {
    playerId: PLAYER_ONE,
  });
  primeHp(world, comps, campEid, 80); // scenario-editor priming keeps the raze phase tight
  const houseEid = stampFinishedBuilding(world, comps, "house", 7, 10, {
    playerId: PLAYER_ONE,
  });
  void houseEid;
  const villagers = [
    spawnUnit(world, comps, 15.5, 11.5),
    spawnUnit(world, comps, 16.5, 10.5),
    spawnUnit(world, comps, 16.5, 12.5),
  ];

  // ---- AI opponent: base + two stamped knights, real planner ---------
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [],
  });
  spawnCombatUnit(world, comps, "knight", 9.5, 8.5, AI_PLAYER);
  spawnCombatUnit(world, comps, "knight", 9.5, 9.5, AI_PLAYER);

  // Wood for the camp's drop-off role (never gathered — window dressing).
  spawnResourceNode(world, comps, 15, 9, 1 /* wood */, 800);

  fog.recomputeAll();

  const knowledge = createAiKnowledge({
    world,
    comps,
    view: fog.knowledgeFor(AI_PLAYER),
  });
  const telemetry = createPlannerTelemetry();
  registerSystem(
    world,
    createAiPlannerSystem({
      knowledge,
      strategy: raidStrategy,
      telemetry,
    }),
  );

  let campDestroyTick = -1;
  const digests: { tick: number; digest: string }[] = [];

  while (world.tick < LIMIT_TICKS) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
    const tick = world.tick;
    if (
      campDestroyTick < 0 &&
      getBuildingRow(world, comps, campEid) === undefined
    ) {
      campDestroyTick = tick;
    }
    if (tick % MILESTONE_EVERY === 0 || tick === LIMIT_TICKS) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
    if (campDestroyTick >= 0 && tick >= campDestroyTick + 60) break;
  }

  return {
    digests,
    finalTick: world.tick,
    campDestroyTick,
    offensiveDrafts: telemetry.attackDrafts.map((draft) => ({ ...draft })),
    villagersAliveAtEnd: villagers.filter((eid) =>
      world.rowsByComponentId.get(comps.positionId)?.has(eid),
    ).length,
  };
}

let cachedRun: RunState | undefined;
function mainRun(): RunState {
  return (cachedRun ??= runScenario());
}

installSimPurityShims();

describe("golden harness m4t6a — undefended expansion raided", () => {
  it("raids the villager-dense expansion, not the nearer empty building", () => {
    const run = mainRun();

    // Exactly ONE offensive (shared one-shot strike memory), aimed at
    // the DENSE camp — the closer house would win a proximity contest.
    expect(run.offensiveDrafts.length).toBe(1);
    const draft = run.offensiveDrafts[0]!;
    expect(draft.purpose).toBe("raid");
    expect(draft.attackerCount).toBe(2);
    expect(draft.targetVisibleToAi).toBe(true);
    expect(draft.tick).toBeLessThanOrEqual(PLANNER_FIRST_PROBE_MAX);

    // The raid actually lands: the camp is razed well inside the window.
    expect(run.campDestroyTick).toBeGreaterThan(draft.tick);
    expect(run.campDestroyTick).toBeLessThan(LIMIT_TICKS);
  });

  it("stays fog-honest: the unseen main base is never touched", () => {
    const run = mainRun();
    expect(run.offensiveDrafts.length).toBe(1);
    // The TC/barracks sit outside every sight circle all run long — no
    // legitimate query could ever name them, and none does.
    expect(run.offensiveDrafts[0]!.targetVisibleToAi).toBe(true);
  });

  it("leaves the untargetable workforce alive", () => {
    const run = mainRun();
    expect(run.villagersAliveAtEnd).toBe(3);
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = mainRun();

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests.length).toBeGreaterThan(2);
    expect(run.digests).toMatchSnapshot();

    // Extended canary (issue #61): a second identical run agrees
    // byte-for-byte on every pinned field.
    const second = runScenario();
    expect(second.digests).toEqual(run.digests);
    expect(second.campDestroyTick).toBe(run.campDestroyTick);
    expect(second.offensiveDrafts).toEqual(run.offensiveDrafts);
    expect(second.villagersAliveAtEnd).toBe(run.villagersAliveAtEnd);
    expect(second.finalTick).toBe(run.finalTick);
  });
});

/** The first incremental probe runs at tick 1 — the offense cannot lag
 *  past the first full pass under any difficulty scaling used here. */
const PLANNER_FIRST_PROBE_MAX = 90;

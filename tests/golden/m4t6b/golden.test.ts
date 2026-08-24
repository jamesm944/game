/**
 * M4-T6b golden harness — SPEC §2.8 layer 3, counter-picks / issue #61.
 *
 * A scouted enemy ARCHER MASS reshapes the AI's training through the
 * §2.5 counter tables: skirmishers carry attackBonuses
 * `{armorClass:"archer", mult:3}`, so against a visible archer ball the
 * military manager's composition scorer rates them strictly above every
 * alternative the archery range can produce (archers themselves score
 * zero — no bonuses either way) and trains them instead:
 *
 *   - with the mass in vision: `trainUnit` drafts flow (purpose
 *     `counter`), EVERY one a skirmisher;
 *   - negative control: the SAME world without the archers trains
 *     nothing — counters key off scouted composition only, never fire
 *     on a hunch;
 *   - extended canary: two identical runs agree byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../../../src/sim/components";
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
import { COUNTER_TRAIN_CAP } from "../../../src/sim/ai/militaryManager";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const SIZE = 40;

/** Fat opening so affordability never gates the counter line. */
const AI_RESOURCES = [2000, 3000, 1000, 0, 0, 0, 0];

/**
 * Passive strategy: no economy steps, no army threshold — every
 * trainUnit draft in this harness comes from the counter scorer.
 */
const passiveStrategy: Strategy = {
  id: "counter-observe-mini",
  villagerTarget: 0,
  gatherWeights: { food: 1, wood: 0, gold: 0 },
  attackArmyThreshold: Number.MAX_SAFE_INTEGER,
  steps: [],
};

interface RunState {
  readonly digests: readonly {
    readonly tick: number;
    readonly digest: string;
  }[];
  readonly finalTick: number;
  readonly counterTrains: number;
  readonly queuedAndAliveByDef: Readonly<Record<string, number>>;
  readonly nonSkirmisherTrainDrafts: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runScenario(withArcherMass: boolean): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(SIZE, 2);
  const world: World = createWorld(withArcherMass ? 20261007 : 20261008, {
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

  // ---- Player zero: bare ledger (+ optional archer mass in vision) ---
  createPlayerStockpile(world, comps, PLAYER_ONE, [200, 600, 100, 0, 0, 0, 0]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  if (withArcherMass) {
    for (let i = 0; i < 8; i++) {
      spawnCombatUnit(
        world,
        comps,
        "archer",
        9.5 + (i % 4),
        10.5 + Math.floor(i / 4),
        PLAYER_ONE,
      );
    }
  }

  // ---- AI opponent: Feudal age, archery range up, housing headroom ---
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [],
    startingResources: AI_RESOURCES,
  });
  // Scenario-editor privilege: pin the ladder to Feudal so the range's
  // production gates are open (the counter scorer itself never reads
  // rank — canEnqueueTraining does).
  for (const [, row] of world.rowsByComponentId.get(comps.ageStateId)!) {
    if (row[0] === AI_PLAYER) (row as number[])[1] = 2;
  }
  stampFinishedBuilding(world, comps, "archery-range", 5, 7, {
    playerId: AI_PLAYER,
  });
  stampFinishedBuilding(world, comps, "house", 8, 3, { playerId: AI_PLAYER });

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
      strategy: passiveStrategy,
      telemetry,
    }),
  );

  const digests: { tick: number; digest: string }[] = [];
  while (world.tick < 1500) {
    step(world);
    const tick = world.tick;
    if (tick % 250 === 0 || tick === 1500) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  // Count living + queued units by definition id.
  const byDef: Record<string, number> = {};
  for (const eid of knowledge.armyUnits()) {
    byDef[eid.defId] = (byDef[eid.defId] ?? 0) + 1;
  }
  for (const eid of knowledge.finishedBuildings("archery-range")) {
    void eid;
    for (const unitId of knowledge.trainQueueOf(eid)) {
      byDef[unitId] = (byDef[unitId] ?? 0) + 1;
    }
  }

  return {
    digests,
    finalTick: world.tick,
    counterTrains: telemetry.counterTrains,
    queuedAndAliveByDef: byDef,
    // Every draft this strategy could emit is manager-owned; anything
    // not a counter would show up as a non-skirmisher train order.
    nonSkirmisherTrainDrafts:
      (telemetry.issuedByKind.trainUnit ?? 0) -
      telemetry.counterTrains +
      Object.entries(byDef)
        .filter(([defId]) => defId !== "skirmisher")
        .reduce((sum, [, count]) => sum + count, 0),
  };
}

let cachedWithMass: RunState | undefined;
let cachedWithout: RunState | undefined;

installSimPurityShims();

describe("golden harness m4t6b — composition counter-pick", () => {
  it("answers a scouted archer mass with skirmishers, exclusively", () => {
    cachedWithMass ??= runScenario(true);
    const run = cachedWithMass;

    // The scorer fired repeatedly (capped) once the mass was scouted…
    expect(run.counterTrains).toBeGreaterThanOrEqual(3);
    expect(run.counterTrains).toBeLessThanOrEqual(COUNTER_TRAIN_CAP);
    // …and EVERY trained head is a skirmisher — the strict-improvement
    // gate keeps the range's own archer line silent against archers.
    expect(run.queuedAndAliveByDef.skirmisher).toBeGreaterThanOrEqual(3);
    expect(run.nonSkirmisherTrainDrafts).toBe(0);
  });

  it("trains nothing without scouted composition (fog-honest control)", () => {
    cachedWithout ??= runScenario(false);
    const run = cachedWithout;

    expect(run.counterTrains).toBe(0);
    expect(run.queuedAndAliveByDef.skirmisher).toBeUndefined();
    expect(Object.keys(run.queuedAndAliveByDef)).toEqual([]);
  });

  it("records milestone digests and replays byte-identically", () => {
    const run = (cachedWithMass ??= runScenario(true));

    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();

    // Extended canary (issue #61): second identical run agrees exactly.
    const second = runScenario(true);
    expect(second.digests).toEqual(run.digests);
    expect(second.counterTrains).toBe(run.counterTrains);
    expect(second.queuedAndAliveByDef).toEqual(run.queuedAndAliveByDef);
    expect(second.finalTick).toBe(run.finalTick);
  });
});

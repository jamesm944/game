/**
 * M2-T9 golden harness — SPEC §2.8 AI build-order + economy / issue #43.
 *
 * The scripted fast-castle-knights opponent runs layers 1+2 against the
 * pinned seed-20260901 symmetric field while player zero idles. Every
 * AI action enters the world through the SHARED command inbox exactly
 * like a human order; the planner is an ordinary registered system
 * (last), thinking on the §2.8 30-tick cadence with incremental attack
 * probes between passes.
 *
 * Pinned outcomes:
 *   - BUILD ORDER — Feudal research enqueues off the opening surplus
 *     while the dark-age barracks rises in parallel; Stable follows at
 *     rank 2; Castle waits for both prior-age buildings; knights muster
 *     to four. Exact ladder events and first-tick pins ride the
 *     telemetry, digests pin the bytes.
 *   - ECONOMY — villager queue saturation toward twelve, houses on ring
 *     slots ahead of demand, builder pulls above the gatherer floor,
 *     weight-balanced forage assignment; no polite gate rejections ever
 *     fire because every emission pre-flights through knowledge.
 *   - FOG HONESTY — bases live outside each other's planes: the attack
 *     trigger never arms (no vision → no order) and EVERY gather target
 *     was inside AI knowledge at emission, verified on the same view
 *     queries the decision used.
 *   - BUDGET — amortized planner think stays under the §2.8 <1 ms via
 *     an injected performance.now clock (never Date.now in sim).
 *   - ATTACK SEMANTICS — a second, tiny scenario proves the trigger
 *     DOES fire when a legitimate enemy stands in vision: two stamped
 *     knights charge the one visible house and never the far dark TC.
 *
 * Milestone digests land every 30th tick plus final with a double-run
 * determinism canary; regenerate ONLY via `npm run golden:record`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  WORK_SLOTS_PER_NODE,
  type SimComponents,
} from "../../../src/sim/components";
import { resourceCodeOfSlug } from "../../../src/sim/systems/costs";
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
  stockpileAmountsOf,
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
import {
  createAgeSystem,
  currentAgeRankOf,
} from "../../../src/sim/systems/age";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../../../src/sim/systems/combat";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../../../src/sim/systems/fog";
import {
  createPlayerAgeState,
  readAgeAdvancedEvents,
  readGateRejections,
} from "../../../src/sim/components/age";
import {
  createCommodityStockpile,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { setupAiOpponent, AI_PLAYER } from "../../../src/sim/ai/bootstrap";
import { createAiKnowledge } from "../../../src/sim/ai/knowledge";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
  PLANNER_CADENCE_TICKS,
} from "../../../src/sim/ai/planner";
import type { StrategyId } from "../../../src/sim/ai/buildOrder";

const RESOURCE_SLUGS = [
  "food",
  "wood",
  "gold",
  "stone",
  "iron",
  "coal",
  "clay",
] as const;

interface StockpileSeed {
  readonly food: number;
  readonly wood: number;
  readonly gold: number;
  readonly stone: number;
  readonly iron: number;
  readonly coal: number;
  readonly clay: number;
}

interface GoldenNode {
  readonly tileX: number;
  readonly tileY: number;
  readonly resource: (typeof RESOURCE_SLUGS)[number];
  readonly amount: number;
}

interface GoldenSide {
  readonly tcOrigin: readonly [number, number];
  readonly villagers: readonly (readonly [number, number])[];
  readonly stockpile: StockpileSeed;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly playerZero: GoldenSide;
  readonly ai: GoldenSide & { readonly strategy: StrategyId };
  readonly nodes: readonly GoldenNode[];
}

function stockOf(seed: StockpileSeed): number[] {
  return RESOURCE_SLUGS.map((slug) => {
    const value = seed[slug];
    if (typeof value !== "number") {
      throw new Error(`fixture stockpile.${slug} must be a number`);
    }
    return value;
  });
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;
  for (const key of ["playerZero", "ai"] as const) {
    if (typeof box[key] !== "object" || box[key] === null) {
      throw new Error(`fixture case.json: ${key} must be an object`);
    }
  }
  const playerZero = box.playerZero as Record<string, unknown>;
  const ai = box.ai as Record<string, unknown>;
  if (!Array.isArray(box.nodes)) {
    throw new Error("fixture case.json: nodes must be an array");
  }
  const side = (entry: Record<string, unknown>): GoldenSide => ({
    tcOrigin: entry.tcOrigin as [number, number],
    villagers: entry.villagers as readonly [number, number][],
    stockpile: entry.stockpile as StockpileSeed,
  });
  return {
    name: String(box.name),
    seed: box.seed as number,
    size: box.size as number,
    ticks: box.ticks as number,
    milestoneEvery: box.milestoneEvery as number,
    playerZero: side(playerZero),
    ai: { ...side(ai), strategy: ai.strategy as StrategyId },
    nodes: (box.nodes as Record<string, unknown>[]).map((node) => ({
      tileX: node.tileX as number,
      tileY: node.tileY as number,
      resource: node.resource as (typeof RESOURCE_SLUGS)[number],
      amount: node.amount as number,
    })),
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

/** Plain-comparable final state so canaries deep-equal trivially. */
interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  // ---- AI outcome ----
  readonly aiRank: number;
  readonly p0Rank: number;
  readonly aiAgeEvents: readonly (readonly [number, number])[];
  readonly aiVillagers: number;
  readonly aiKnights: number;
  readonly aiArmy: number;
  readonly aiBarracks: number;
  readonly aiStable: number;
  readonly aiHouses: number;
  readonly aiPopCap: number;
  readonly aiStock: readonly number[];
  readonly aiGateRejections: number;
  // ---- Planner behavior ----
  readonly telemetry: {
    readonly thinkCalls: number;
    readonly incrementalCalls: number;
    readonly totalThinkMs: number;
    readonly issuedByKind: Readonly<Record<string, number>>;
    readonly firstTickByKind: Readonly<Record<string, number>>;
    readonly attackDrafts: readonly unknown[];
    readonly gatherDrafts: number;
    readonly gatherDraftsKnown: number;
  };
  readonly visibleEnemiesAtEnd: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runMainScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(fixture.size, 2);
  const world: World = createWorld(fixture.seed, {
    size: fixture.size,
    layers: openFieldLayers(fixture.size),
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
  ];
  for (const system of systems) registerSystem(world, system);

  // Player zero: idle dark-age start (the human side of the matchup).
  for (const [x, y] of fixture.playerZero.villagers) {
    spawnUnit(world, comps, x, y);
  }
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    stockOf(fixture.playerZero.stockpile),
  );
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_ONE);
  stampFinishedBuilding(
    world,
    comps,
    "town-center",
    fixture.playerZero.tcOrigin[0],
    fixture.playerZero.tcOrigin[1],
    { playerId: PLAYER_ONE },
  );

  // AI opponent: mirrored start, explicit Owner rows on its villagers.
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: fixture.ai.tcOrigin,
    villagerSpawns: fixture.ai.villagers,
    startingResources: stockOf(fixture.ai.stockpile),
  });

  for (const node of fixture.nodes) {
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      resourceCodeOfSlug(node.resource),
      node.amount,
      { workSlots: WORK_SLOTS_PER_NODE },
    );
  }

  // Map-gen full fog recompute (SPEC §2.9) before the loop starts.
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
      strategy: fixture.ai.strategy,
      telemetry,
      now: () => performance.now(),
    }),
  );

  const digests: MilestoneDigest[] = [];
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue; // held boundary: no double record
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const army = knowledge.armyUnits();
  return {
    digests,
    finalTick: world.tick,
    aiRank: currentAgeRankOf(world, comps, AI_PLAYER),
    p0Rank: currentAgeRankOf(world, comps, PLAYER_ONE),
    aiAgeEvents: readAgeAdvancedEvents(world, comps, AI_PLAYER).map(
      (event) => [event.tick, event.ageRank] as [number, number],
    ),
    aiVillagers: knowledge.villagerEids().length,
    aiKnights: army.filter((unit) => unit.defId === "knight").length,
    aiArmy: army.length,
    aiBarracks: knowledge.finishedBuildings("barracks").length,
    aiStable: knowledge.finishedBuildings("stable").length,
    aiHouses: knowledge.finishedBuildings("house").length,
    aiPopCap: knowledge.populationCap(),
    aiStock: [...stockpileAmountsOf(world, comps, AI_PLAYER)],
    aiGateRejections: readGateRejections(world, comps, AI_PLAYER).length,
    telemetry: {
      thinkCalls: telemetry.thinkCalls,
      incrementalCalls: telemetry.incrementalCalls,
      totalThinkMs: telemetry.totalThinkMs,
      issuedByKind: { ...telemetry.issuedByKind },
      firstTickByKind: { ...telemetry.firstTickByKind },
      attackDrafts: [...telemetry.attackDrafts],
      gatherDrafts: telemetry.gatherDrafts,
      gatherDraftsKnown: telemetry.gatherDraftsKnown,
    },
    visibleEnemiesAtEnd: knowledge.visibleEnemies().length,
  };
}

/** Heavy main run executes once; every assertion reads the cache. */
let cachedRun: RunState | undefined;
function mainRun(fixture: GoldenCase): RunState {
  return (cachedRun ??= runMainScenario(fixture));
}

// ---- Mini scenario: the attack trigger vs fog ----------------------------------

interface MiniRunState {
  readonly finalTick: number;
  readonly houseEid: number;
  readonly attackDrafts: readonly {
    readonly tick: number;
    readonly targetId: number;
    readonly attackerCount: number;
    readonly targetVisibleToAi: boolean;
  }[];
  readonly strikes: number;
  readonly knightTilesFinal: readonly (readonly [number, number])[];
}

/**
 * A tiny custom strategy isolates the minimal attack trigger: threshold
 * 2, single terminal step, no prerequisites.
 */
const attackOnlyStrategy = {
  id: "attack-only-mini" as const,
  villagerTarget: 0,
  gatherWeights: { food: 1, wood: 0, gold: 0 },
  attackArmyThreshold: 2,
  steps: [
    {
      id: "attack",
      action: { kind: "attack" as const },
      complete: {
        kind: "armySize" as const,
        unitId: "knight",
        count: Number.POSITIVE_INFINITY,
      },
      gate: {},
    },
  ],
};

function runMiniScenario(): MiniRunState {
  const size = 24;
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = createFogVisibility(size, 2);
  const world = createWorld(77, {
    size,
    layers: openFieldLayers(size),
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  const comps = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createGatherSystem(comps, scheduler));
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createAgeSystem(comps));
  const combatDiagnostics = createCombatDiagnostics();
  registerSystem(
    world,
    createCombatSystem(comps, combatDiagnostics, scheduler),
  );

  // AI base + ledger; no starting villagers (knights arrive stamped).
  setupAiOpponent(world, comps, {
    player: AI_PLAYER,
    tcOrigin: [3, 3],
    villagerSpawns: [],
  });

  // Player zero needs a ledger (combat event logs ride Stockpile rows).
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createCommodityStockpile(world, comps, PLAYER_ONE);

  // Player zero: ONE house inside AI sight (~7 tiles from TC center)
  // and one far town center deep in darkness.
  const houseEid = stampFinishedBuilding(world, comps, "house", 10, 6, {
    playerId: PLAYER_ONE,
  });
  stampFinishedBuilding(world, comps, "town-center", 20, 20, {
    playerId: PLAYER_ONE,
  });

  // Two stamped AI knights on open ground east of their TC: threshold
  // met immediately (never spawn ON the TC footprint — impassable).
  const knightA = spawnCombatUnit(world, comps, "knight", 7.5, 6.5, AI_PLAYER);
  const knightB = spawnCombatUnit(world, comps, "knight", 7.5, 7.5, AI_PLAYER);

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
      strategy: attackOnlyStrategy,
      telemetry,
    }),
  );

  while (world.tick < 420) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue;
  }

  return {
    finalTick: world.tick,
    houseEid,
    attackDrafts: telemetry.attackDrafts.map((draft) => ({ ...draft })),
    strikes: combatDiagnostics.strikes,
    knightTilesFinal: [
      [
        Math.floor(
          world.rowsByComponentId.get(comps.positionId)?.get(knightA)?.[0] ??
            -1,
        ),
        Math.floor(
          world.rowsByComponentId.get(comps.positionId)?.get(knightA)?.[1] ??
            -1,
        ),
      ],
      [
        Math.floor(
          world.rowsByComponentId.get(comps.positionId)?.get(knightB)?.[0] ??
            -1,
        ),
        Math.floor(
          world.rowsByComponentId.get(comps.positionId)?.get(knightB)?.[1] ??
            -1,
        ),
      ],
    ],
  };
}

installSimPurityShims();

describe("golden harness m2t9", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = mainRun(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    expect(run.digests.length).toBeGreaterThan(200);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  }, 30_000);

  it("executes the full FC build order to Castle knights on the pinned seed", () => {
    const run = mainRun(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.aiRank).toBe(3);
    expect(run.p0Rank).toBe(1); // the idle human stays in the Dark Age
    // Feudal completes on enqueue(t30) + 3900 − 1 (AoE2 research
    // duration); Castle once both prior-age buildings stand (~t5.2k)
    // + 4800 − 1. M3-T2: AI builders carry Skills rows, so construction
    // practice speeds their later sites — Castle lands 3 ticks of
    // boosted work earlier.
    expect(run.aiAgeEvents).toEqual([
      [3930, 2],
      [9960, 3],
    ]);

    // Exactly one foundation per definition, all finished; knights
    // mustered to four; saturation landed on the twelve-villager target.
    expect(run.aiBarracks).toBe(1);
    expect(run.aiStable).toBe(1);
    expect(run.aiKnights).toBe(4);
    expect(run.aiArmy).toBe(4);
    expect(run.aiVillagers).toBe(12);
    expect(run.aiPopCap).toBe(15);
    expect(run.aiHouses).toBe(2);

    // Every layer spoke the shared command interface.
    const issued = run.telemetry.issuedByKind;
    expect(issued.placeBuilding).toBe(4); // 2 houses + barracks + stable
    expect(issued.trainVillager).toBe(7); // + 5 starting = 12
    expect(issued.trainUnit).toBe(4);
    expect(issued.researchAge).toBe(2);
    expect(issued.build).toBeGreaterThan(0);
    expect(issued.gather).toBeGreaterThan(0);
    // Feudal clicked on the very first planning pass off the opening
    // surplus; the knight line opens on the SAME pass that observes the
    // Castle rank (the planner runs after this tick's systems).
    expect(run.telemetry.firstTickByKind.researchAge).toBe(
      PLANNER_CADENCE_TICKS,
    );
    expect(run.telemetry.firstTickByKind.trainUnit).toBe(
      run.aiAgeEvents[1]![0],
    );

    // Pre-flight hygiene: not one polite refusal all game.
    expect(run.aiGateRejections).toBe(0);
    // The bank closed in surplus after 10.2k ticks of scripted spending.
    expect(run.aiStock.every((amount) => amount >= 0)).toBe(true);
  });

  it("stays fog-honest through the planner code path", () => {
    const run = mainRun(fixture);

    // Bases are outside each other's planes: nothing enemy was EVER
    // visible, so the minimal attack trigger never armed…
    expect(run.visibleEnemiesAtEnd).toBe(0);
    expect(run.telemetry.attackDrafts).toEqual([]);
    // …and every gather decision targeted a node inside AI knowledge,
    // probed through the same view queries that produced it.
    expect(run.telemetry.gatherDrafts).toBeGreaterThan(0);
    expect(run.telemetry.gatherDraftsKnown).toBe(run.telemetry.gatherDrafts);
  });

  it("amortized planner think stays under the §2.8 1 ms budget", () => {
    const run = mainRun(fixture);

    const decisions = run.telemetry.thinkCalls + run.telemetry.incrementalCalls;
    expect(run.telemetry.thinkCalls).toBe(
      Math.floor(fixture.ticks / PLANNER_CADENCE_TICKS),
    );
    expect(decisions).toBeGreaterThan(1000);
    // §2.8: "<1 ms amortized" across every planning decision — full
    // passes plus the cheap incremental probes between them.
    expect(run.telemetry.totalThinkMs / decisions).toBeLessThan(1);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = mainRun(fixture);
    const second = runMainScenario(fixture);
    // Wall-clock think time is instrumentation, not sim state — every
    // deterministic field must still agree exactly.
    expect(second.digests).toEqual(first.digests);
    expect({
      ...second,
      telemetry: { ...second.telemetry, totalThinkMs: 0 },
    }).toEqual({
      ...first,
      telemetry: { ...first.telemetry, totalThinkMs: 0 },
    });
  }, 30_000);

  it("attack trigger fires only on legitimately visible enemies", () => {
    const mini = runMiniScenario();

    // Exactly one attack, aimed at the ONE enemy inside AI vision.
    expect(mini.attackDrafts.length).toBe(1);
    const draft = mini.attackDrafts[0]!;
    expect(draft.targetVisibleToAi).toBe(true);
    expect(draft.attackerCount).toBe(2);
    expect(draft.targetId).toBe(mini.houseEid);
    expect(draft.tick).toBeLessThanOrEqual(PLANNER_CADENCE_TICKS);
    // Both knights marched east/south toward the fight.
    expect(mini.knightTilesFinal[0]![0]).toBeGreaterThan(7);
    expect(mini.knightTilesFinal[1]![0]).toBeGreaterThan(7);
    expect(mini.strikes).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Skirmish session lifecycle — M2-T10 game flow (issue #44).
 *
 * {@link createSkirmishWorld} is THE two-player start: everything
 * production main.ts used to inline — world + components + full system
 * roster (victory evaluator included, AI planner last), the human dark-
 * age capital at map center, the AI opponent mirrored through the map
 * center via the existing setupAiOpponent bootstrap, ringed resource
 * nodes and the map-gen fog recompute. Browser and headless tests share
 * one code path, so a restarted world is byte-for-byte what a fresh
 * page load would have built.
 *
 * RESTART-TO-FRESH-WORLD: a match ends → the victory overlay's Restart
 * button stashes a NEW u32 seed ({@link stashNextSeed}) and the app
 * re-boots; boot consumes it ({@link consumeNextSeed}) so the next
 * createSkirmishWorld runs the SAME bootstrap from a different seed.
 * The teardown is total (the page discards the JS heap), which for a
 * framework-free static build is the honest way to drop every
 * world/renderer binding without a dispose graph. Seeds come from
 * {@link freshSeed} (app-level randomness — never sim code); tests
 * inject their own rng to stay deterministic.
 */

import {
  defineSimComponents,
  getBuildingRow,
  populationOf,
  spawnResourceNode,
  spawnUnit,
  WORK_SLOTS_PER_NODE,
  type SimComponents,
} from "../sim/components";
import {
  AGEOF_FORMAT_VERSION,
  SaveFormatError,
  assertMapHash,
  decodeAgeof,
  encodeAgeof,
} from "./saveManager";
import {
  parsePayload,
  snapshotPayload,
  type CompaniesSaveState,
} from "../sim/save/serialize";
import type { PlannerSaveState } from "../sim/save/serialize";
import { applyFogSnapshot, captureFogSnapshot } from "../sim/systems/fog";
import {
  createFogVisibility,
  createRowEntityResolver,
  type FogVisibilityHandle,
} from "../sim/systems/fog";
import { restorePrng, serializePrngState } from "../sim/core/prng";
import { SIM_VERSION } from "../sim/version";
import { fnv1a64 } from "../sim/core/digest";
import { serializeLayers } from "../sim/world/layers";
import { computeWorldDigest } from "../sim/core/world";
import type { BuildOrderMemory } from "../sim/ai/buildOrder";
import type { MilitaryMemory } from "../sim/ai/militaryManager";
import {
  createCompaniesPersistentState,
  type CompaniesPersistentState,
} from "../sim/systems/companies";
import { buildingIdOfCode } from "../data/definitions";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
} from "../sim/core/stockpile";
import { createPlayerAgeState } from "../sim/components/age";
import { createWorld, registerSystem, type World } from "../sim/core/world";
import { PathScheduler, type PathTransport } from "../sim/path/scheduler";
import { ReplayRecorder } from "../sim/replay/record";
import { createMovementSystem } from "../sim/systems/movement";
import { createGatherSystem } from "../sim/systems/gather";
import {
  createPlacementSystem,
  stampFinishedBuilding,
  validatePlacement,
} from "../sim/systems/placement";
import { createConstructionSystem } from "../sim/systems/construction";
import { createTrainingSystem } from "../sim/systems/training";
import { createProductionSystem } from "../sim/systems/production";
import { createAgeSystem } from "../sim/systems/age";
import { createCombatSystem } from "../sim/systems/combat";
import { createEquipmentSystem } from "../sim/systems/equipment";
import { createSkillsSystem } from "../sim/systems/skills";
import { createInjuriesSystem } from "../sim/systems/injuries";
import { createNeedsSystem } from "../sim/systems/needs";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  createLifecycleSystem,
  minuteOfDay,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../sim/systems/lifecycle";
import { createHouseholdsSystem } from "../sim/systems/households";
import { createSchoolSystem } from "../sim/systems/school";
import { createKnowledgeSystem } from "../sim/systems/knowledge";
import { createCultureSystem } from "../sim/systems/culture";
import { createRelicSystem } from "../sim/systems/relics";
import { createMarketSystem } from "../sim/systems/market";
import { spawnRelic } from "../sim/components/relic";
import { createMassSystem, MASS_CLOSE_MINUTE } from "../sim/systems/mass";
import { createSchedulesSystem, isRestDay } from "../sim/systems/schedules";
import { createSocialSystem, isLeisureTime } from "../sim/systems/social";
import { createMoraleSystem } from "../sim/systems/morale";
import { createPopBrainSystem } from "../sim/ai/popBrain";
import { createManagementSystem } from "../sim/systems/management";
import {
  createCompaniesSystem,
  type OutputObservers,
} from "../sim/systems/companies";
import { createVictorySystem } from "../sim/systems/victory";
import { buildingRectOf } from "../sim/components/buildings";
import { AI_PLAYER, mirrorOrigin, setupAiOpponent } from "../sim/ai/bootstrap";
import { createAiKnowledge, type AiKnowledge } from "../sim/ai/knowledge";
import {
  createAiPlannerSystem,
  createPlannerTelemetry,
  type PlannerTelemetry,
} from "../sim/ai/planner";
import { STRATEGY_IDS, type StrategyId } from "../sim/ai/buildOrder";
import { aiDifficultyOf, type AiDifficultyId } from "../sim/ai/difficulty";
import { scatterResourceNodes } from "../sim/mapgen/resources";
import { createScenarioSystem } from "../sim/systems/scenario";
import { createScenarioRuntime } from "../sim/scenario/engine";
import type {
  ScenarioDefinition,
  ScenarioRuntime,
} from "../sim/scenario/types";

/** Dark-age start scale carried over from the M1-T10 dev world. */
export const STARTING_VILLAGERS = 5;

/** Opening stockpile — the documented skirmish seed capital. */
export const STARTING_RESOURCES = [200, 600, 100, 0, 0, 0, 0] as const;

/** Demo node ring: keep gatherables near BOTH bases (main.ts parity). */
const NODE_RING_RADIUS = 26;
const NODE_CANDIDATES = 96;
const NODE_TARGET = 32;

export interface SkirmishWorldOptions {
  /** Grid edge in tiles; defaults to the §2.1 120-tile skirmish grid. */
  readonly size?: number | undefined;
  /**
   * Path transport factory. Production passes the worker transport
   * (game/paths.ts); headless tests pass the synchronous transport.
   */
  readonly createTransport: () => PathTransport;
  /**
   * Lifecycle timescale for every M3 system (clock, schedules, school,
   * households, social, mass, pop brain). Defaults to the canonical
   * §2.4 clock; compressed golden fixtures (M3-T10) pass their own.
   */
  readonly lifecycleConfig?: LifecycleConfig | undefined;
  /**
   * AI opponent difficulty (M4-T6, SPEC §2.8 "disclosed knobs").
   * Defaults to "normal"; the chosen preset drives the planner's
   * decision interval + reaction delay and — on hard — the documented
   * ×1.25 income multiplier on the AI's gather deposits. Surfaced on
   * {@link SkirmishWorld.aiDifficulty} so the HUD badge can disclose it.
   */
  readonly aiDifficulty?: AiDifficultyId | undefined;
  /**
   * AI build-order opening strategy (M2-T9 / Polish pass).
   * Defaults to "fast-castle-knights". "random" selects deterministically from
   * available strategies using the match seed.
   */
  readonly aiStrategy?: StrategyId | "random" | undefined;
  /**
   * Replay recording (M5-T3, SPEC §2.12): when provided, the bootstrap
   * attaches it BEFORE any command is submitted so AI opening drafts
   * classify as sim-internal. Callers then beginPlay()/stepWorld()
   * through the recorder; restored saves never record.
   */
  readonly replay?: ReplayRecorder | undefined;
  /**
   * Whether to spawn neutral relics on the map (issue #76 / §2.11).
   * Enabled in production play; omitted in headless test fixtures to
   * preserve byte-identical golden digests. Can be boolean or number.
   */
  readonly spawnRelics?: boolean | number | undefined;
  /**
   * Optional scripted scenario definition or runtime (Milestone S5 / #134).
   */
  readonly scenario?: ScenarioDefinition | ScenarioRuntime | undefined;
}

export interface SkirmishWorld {
  readonly seed: number;
  readonly world: World;
  readonly comps: SimComponents;
  readonly scheduler: PathScheduler;
  readonly fog: FogVisibilityHandle;
  /** The AI's fog-honest knowledge surface (viewer = AI_PLAYER). */
  readonly aiKnowledge: AiKnowledge;
  readonly aiTelemetry: PlannerTelemetry;
  /** Resolved difficulty preset id (defaults "normal"). */
  readonly aiDifficulty: AiDifficultyId;
  /** Resolved AI opening strategy. */
  readonly aiStrategy: StrategyId;
  /**
   * Persistent closure state the digest never sees (SPEC §2.12): the
   * save path serializes these; restore re-injects them before any
   * system runs, so a loaded session plans identically to a fresh one.
   */
  readonly aiMemory: BuildOrderMemory;
  readonly militaryMemory: MilitaryMemory;
  readonly companiesPersistent: CompaniesPersistentState;
}

/**
 * Stand up one complete two-player skirmish from a seed. Pure function
 * of (seed, options): same seed ⇒ byte-identical world at tick 0.
 */
export interface SkirmishPersistentStates {
  readonly companies: CompaniesPersistentState;
  readonly aiMemory: BuildOrderMemory;
  readonly militaryMemory: MilitaryMemory;
}

function createSkirmishPersistentStates(): SkirmishPersistentStates {
  return {
    companies: createCompaniesPersistentState(),
    aiMemory: {},
    militaryMemory: { threatSince: new Map(), countersTrained: 0 },
  };
}

/**
 * The production system roster — IDENTICAL for fresh boots and save
 * restores. Registration order matters: the companies ledger observes
 * every output credit event (wired into gather + production BEFORE
 * they register), the victory evaluator runs after combat, and the AI
 * planner stays LAST per its contract.
 */
function wireSkirmishSystems(
  world: World,
  comps: SimComponents,
  scheduler: PathScheduler,
  fog: FogVisibilityHandle,
  lifecycleConfig: LifecycleConfig,
  difficulty: ReturnType<typeof aiDifficultyOf>,
  persistent: SkirmishPersistentStates,
  strategy: StrategyId = "fast-castle-knights",
): { aiKnowledge: AiKnowledge; aiTelemetry: PlannerTelemetry } {
  // M4-T2: the companies ledger observes every output credit event, so
  // its observer wires into gather + production BEFORE they register;
  // the companies system itself runs after the delegation layer.
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    persistentState: persistent.companies,
  });
  const outputObservers: OutputObservers = {
    onOutput: companies.onOutput,
    // M4-T6: the hard-difficulty income cheat rides the same credit
    // event the companies ledger taps — AI player only, disclosed in
    // the HUD difficulty badge (ui/hud.ts).
    incomeMultiplierOf: (playerId) =>
      playerId === AI_PLAYER ? difficulty.incomeMultiplier : undefined,
  };
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, undefined, outputObservers),
  );
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));
  registerSystem(
    world,
    createProductionSystem(comps, undefined, undefined, outputObservers),
  );
  registerSystem(world, createAgeSystem(comps));
  registerSystem(world, createCombatSystem(comps, undefined, scheduler));
  // M3-T4: rare-tick wound pass runs after combat (strikes allocate
  // during the combat step; this pass heals/scars/kills over time).
  registerSystem(world, createInjuriesSystem(comps));
  // M3-T2: rare-tick rust pass runs after the awarding systems so it
  // observes this tick's practice stamps.
  registerSystem(world, createSkillsSystem(comps));
  registerSystem(world, createEquipmentSystem(comps));
  registerSystem(world, createVictorySystem(comps));
  // M3-T3: needs decay/eating runs after the labor planners so an
  // emergency hunger release sticks until the next tick; the IAUS pop
  // brain serves the HUMAN side's idle Pops only — the AI opponent
  // keeps its own planner stack (SPEC §2.8 layering).
  registerSystem(world, createNeedsSystem(comps));
  // M3-T5: lifecycle (natural deaths), households (daily formation +
  // seeded birth rolls) and school (9am–3pm teacher-gated lessons)
  // run before popBrain so the brain's child/elder gates see this
  // tick's transitions.
  registerSystem(world, createLifecycleSystem(comps, lifecycleConfig));
  registerSystem(world, createHouseholdsSystem(comps, lifecycleConfig));
  // M4-T4: the §2.11 Knowledge generator observes every attended lesson
  // through the school pass's hook, so its credits are replay events;
  // the research-lump sweep runs as its own system beside the school.
  const knowledge = createKnowledgeSystem({ comps });
  registerSystem(
    world,
    createSchoolSystem(comps, lifecycleConfig, undefined, {
      onLesson: knowledge.onLesson,
    }),
  );
  registerSystem(world, knowledge.system);
  // M4-T4: the §2.11 Culture generator — monument income, happiness
  // surplus accrual and festival commands feed the PrestigeLedger.
  registerSystem(world, createCultureSystem(comps));
  // M4-T5: the §2.11 Relic lifecycle — collectRelic/depositRelic move
  // map relics between the ground, monk carries and Monastery storage;
  // the victory evaluator reads the resulting rows on its own cadence.
  registerSystem(world, createRelicSystem({ comps }));
  // Content Breadth (V9): Market commodity trading & Trade Cart routes
  registerSystem(world, createMarketSystem({ comps }));
  // M3-T8: the Sunday Morning Mass planner books communal [Move,
  // Leisure{MASS}] chains whenever a finished Church stands — before
  // social (which executes arrivals) and schedules (whose night band
  // still outranks any late booking).
  registerSystem(
    world,
    createMassSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig,
    }),
  );
  // M3-T7: social (leisure venues, bonds, rivals) consumes the brain's
  // leisure commands and runs before schedules so the 22:00 bedding
  // cancels still-standing outing chains on the same tick.
  registerSystem(
    world,
    createSocialSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig,
    }),
  );
  // M3-T9: morale shocks/routing/rally consume combat's event logs and
  // read the settled meters; registered after social (independent
  // ledger cursors), before schedules so a rallied router's empty
  // queue is employable the same tick its panic ends.
  registerSystem(world, createMoraleSystem(comps));
  // M3-T6: day/night schedules steer the human village through work
  // windows, staggered evening releases and the 22:00–05:00 sleep band
  // (quality-scaled wake refills, deprivation napping). Scoped to the
  // HUMAN side like the pop brain — the AI opponent's planner stack is
  // never interrupted by bedtime.
  registerSystem(
    world,
    createSchedulesSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig,
    }),
  );
  registerSystem(
    world,
    createPopBrainSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig,
      // M3-T7: evenings switch idle thinks from work to venue scoring.
      leisureWindow: (tick) => isLeisureTime(tick, lifecycleConfig),
      // M3-T8: Sundays run the rest-day space — essential-only work at
      // reduced weight, private leisure once Morning Mass is over.
      restDay: (tick) => isRestDay(tick, lifecycleConfig),
      restDayLeisureWindow: (tick) =>
        minuteOfDay(tick, lifecycleConfig) >= MASS_CLOSE_MINUTE,
    }),
  );
  // M4-T1: the §2.7 delegation layer — foremen + domain managers serve
  // the HUMAN side at the same 1 Hz cadence as the pop brain they sit
  // above; direct player orders ride OrderLock rows and always win.
  // Registered after every labor system so same-tick order rows exist
  // before the lock sweep validates them.
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE] }),
  );
  // M4-T2: the §2.7 companies layer — charters, branch treasuries fed
  // by the output share, exclusive branch staffing, freeze flag. Runs
  // after delegation so staffing sees this tick's lock sweep, before
  // the AI planner per its last-on-the-roster contract.
  registerSystem(world, companies.system);

  const aiKnowledge = createAiKnowledge({
    world,
    comps,
    view: fog.knowledgeFor(AI_PLAYER),
  });
  const aiTelemetry = createPlannerTelemetry();
  registerSystem(
    world,
    createAiPlannerSystem({
      knowledge: aiKnowledge,
      strategy,
      telemetry: aiTelemetry,
      difficulty: difficulty.id,
      memory: persistent.aiMemory,
      militaryMemory: persistent.militaryMemory,
    }),
  );

  // S5: Scenario Scripting & Trigger Engine (#134)
  registerSystem(world, createScenarioSystem(comps));

  return { aiKnowledge, aiTelemetry };
}

/**
 * Stand up one complete two-player skirmish from a seed. Pure function
 * of (seed, options): same seed ⇒ byte-identical world at tick 0.
 */
export function createSkirmishWorld(
  seed: number,
  options: SkirmishWorldOptions,
): SkirmishWorld {
  const lifecycleConfig = normalizeLifecycleConfig(
    options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG,
  );
  const difficulty = aiDifficultyOf(options.aiDifficulty);
  const chosenStrategy: StrategyId =
    options.aiStrategy === "random"
      ? STRATEGY_IDS[Math.abs(seed) % STRATEGY_IDS.length]!
      : (options.aiStrategy ?? "fast-castle-knights");
  const scheduler = new PathScheduler(options.createTransport());
  const size = options.size ?? 120;
  const fog = createFogVisibility(size, 2);
  const world = createWorld(seed, {
    size,
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  if (options.scenario) {
    if ("definition" in options.scenario) {
      world.scenario = options.scenario;
    } else {
      world.scenario = createScenarioRuntime(options.scenario);
    }
  }
  const comps = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  // Replay recording (M5-T3): attach BEFORE the bootstrap submits its
  // AI opening drafts so every sim-generated command classifies as
  // internal and stays out of the artifact.
  options.replay?.attach(world, world.inbox);

  const persistent = createSkirmishPersistentStates();
  const roster = wireSkirmishSystems(
    world,
    comps,
    scheduler,
    fog,
    lifecycleConfig,
    difficulty,
    persistent,
    chosenStrategy,
  );

  // ---- Human start: ledger + age ladder + central TC + villagers ------
  const centerSpot = centralPassableTiles(world, 1)[0]!;
  createPlayerStockpile(world, comps, PLAYER_ONE, [...STARTING_RESOURCES]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_ONE);
  const playerTcOrigin = findHumanTcOrigin(world, comps);
  stampFinishedBuilding(
    world,
    comps,
    "town-center",
    playerTcOrigin.x,
    playerTcOrigin.y,
    { playerId: PLAYER_ONE },
  );
  spawnStartVillagers(world, comps, centerSpot);

  // ---- AI opponent: mirrored TC through the map center ----------------
  const playerTcRect = buildingRectOf(
    world,
    comps,
    requirePlayerTcEid(world, comps),
  );
  const aiAnchor = mirrorOrigin(
    playerTcRect?.x ?? Math.floor(centerSpot.x),
    playerTcRect?.y ?? Math.floor(centerSpot.y),
    3,
    3,
    size,
  );
  const aiTcOrigin = findAiTcOrigin(world, comps, aiAnchor);
  setupAiOpponent(world, comps, {
    tcOrigin: [aiTcOrigin.x, aiTcOrigin.y],
    villagerSpawns: [],
    startingResources: [...STARTING_RESOURCES],
  });
  {
    const spots = passableTilesNear(
      world,
      aiTcOrigin.x + 1.5,
      aiTcOrigin.y + 4.5,
      STARTING_VILLAGERS * 2,
    );
    let spawned = 0;
    for (const spot of spots) {
      if (spawned >= STARTING_VILLAGERS) break;
      spawnUnit(world, comps, spot.x, spot.y, {
        ownerId: AI_PLAYER,
        identity: true,
        body: true,
        morale: true,
      });
      spawned += 1;
    }
  }

  // ---- Gatherable ring near both bases ---------------------------------
  const scattered = scatterResourceNodes(world.layers, seed ^ 0x9e3779b9, {
    count: NODE_CANDIDATES,
  })
    .filter((node) => {
      const nearPlayer =
        (node.tileX + 0.5 - centerSpot.x) ** 2 +
          (node.tileY + 0.5 - centerSpot.y) ** 2 <=
        NODE_RING_RADIUS ** 2;
      const nearAi =
        (node.tileX + 0.5 - (aiTcOrigin.x + 1.5)) ** 2 +
          (node.tileY + 0.5 - (aiTcOrigin.y + 1.5)) ** 2 <=
        NODE_RING_RADIUS ** 2;
      return nearPlayer || nearAi;
    })
    .slice(0, NODE_TARGET);
  for (const node of scattered) {
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      node.resourceCode,
      node.amount,
      { workSlots: WORK_SLOTS_PER_NODE },
    );
  }

  // ---- Neutral sacred relics (issue #76 / SPEC §2.11) -----------------
  if (options.spawnRelics) {
    const relicTarget =
      typeof options.spawnRelics === "number" ? options.spawnRelics : 5;
    spawnSkirmishRelics(
      world,
      comps,
      seed ^ 0x5a5a5a5a,
      relicTarget,
      centerSpot,
      { x: aiTcOrigin.x + 1.5, y: aiTcOrigin.y + 1.5 },
    );
  }

  // Map-gen full fog recompute (§2.9) — the ONLY non-incremental pass.
  fog.recomputeAll();

  return {
    seed,
    world,
    comps,
    scheduler,
    fog,
    aiKnowledge: roster.aiKnowledge,
    aiTelemetry: roster.aiTelemetry,
    aiDifficulty: difficulty.id,
    aiStrategy: chosenStrategy,
    aiMemory: persistent.aiMemory,
    militaryMemory: persistent.militaryMemory,
    companiesPersistent: persistent.companies,
  };
}

function spawnSkirmishRelics(
  world: World,
  comps: SimComponents,
  seed: number,
  count: number,
  playerCenter: { x: number; y: number },
  aiCenter: { x: number; y: number },
): void {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  let rng = seed >>> 0;
  const nextRng = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };

  const minBaseDistSq = 18 * 18;
  const margin = 10;
  let spawned = 0;
  let attempts = 0;

  while (spawned < count && attempts < 200) {
    attempts++;
    const tx = margin + Math.floor(nextRng() * (size - margin * 2));
    const ty = margin + Math.floor(nextRng() * (size - margin * 2));
    if (passability[ty * size + tx] !== 1) continue;

    const dPlayerSq =
      (tx + 0.5 - playerCenter.x) ** 2 + (ty + 0.5 - playerCenter.y) ** 2;
    const dAiSq = (tx + 0.5 - aiCenter.x) ** 2 + (ty + 0.5 - aiCenter.y) ** 2;
    if (dPlayerSq < minBaseDistSq || dAiSq < minBaseDistSq) continue;

    spawnRelic(world, comps, tx + 0.5, ty + 0.5);
    spawned++;
  }
}

function centralPassableTiles(
  world: World,
  count: number,
): { x: number; y: number }[] {
  const size = world.layers.size;
  const c = (size - 1) / 2;
  const found: { x: number; y: number; d2: number }[] = [];
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (world.layers.derivedPassability[ty * size + tx] !== 1) continue;
      const dx = tx + 0.5 - c;
      const dy = ty + 0.5 - c;
      found.push({ x: tx + 0.5, y: ty + 0.5, d2: dx * dx + dy * dy });
    }
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.slice(0, count).map(({ x, y }) => ({ x, y }));
}

function passableTilesNear(
  world: World,
  targetX: number,
  targetY: number,
  count: number,
): { x: number; y: number }[] {
  const size = world.layers.size;
  const found: { x: number; y: number; d2: number }[] = [];
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (world.layers.derivedPassability[ty * size + tx] !== 1) continue;
      const dx = tx + 0.5 - targetX;
      const dy = ty + 0.5 - targetY;
      found.push({ x: tx + 0.5, y: ty + 0.5, d2: dx * dx + dy * dy });
    }
  }
  return found
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, count)
    .map(({ x, y }) => ({ x, y }));
}

function spawnStartVillagers(
  world: World,
  comps: SimComponents,
  centerSpot: { x: number; y: number },
): void {
  for (const spot of passableTilesNear(
    world,
    centerSpot.x,
    centerSpot.y,
    STARTING_VILLAGERS * 3,
  )) {
    // Skip spots the start TC already covers (it stamped after listing).
    let covered = false;
    for (const eid of world.entities) {
      const rect = buildingRectOf(world, comps, eid);
      if (
        rect &&
        spot.x >= rect.x &&
        spot.x < rect.x + rect.width &&
        spot.y >= rect.y &&
        spot.y < rect.y + rect.height
      ) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    spawnUnit(world, comps, spot.x, spot.y, {
      identity: true,
      body: true,
      morale: true,
    });
    if (populationOf(world, comps) >= STARTING_VILLAGERS) break;
  }
}

function requirePlayerTcEid(world: World, comps: SimComponents): number {
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (
      row &&
      row[0] === PLAYER_ONE &&
      buildingIdOfCode(row[1]!) === "town-center"
    ) {
      return eid;
    }
  }
  throw new Error("player town center missing before AI bootstrap");
}

/**
 * First central candidate whose 3×3 footprint stamps cleanly. The first
 * candidate reproduces the historical blind stamp exactly (center tile,
 * offset −1,−2), so seeds that already booted are byte-identical; seeds
 * whose center footprint straddles water fall through to the next
 * nearest passable candidate instead of throwing at boot.
 */
function findHumanTcOrigin(
  world: World,
  comps: SimComponents,
): { x: number; y: number } {
  for (const spot of centralPassableTiles(world, 40)) {
    const tileX = Math.floor(spot.x) - 1;
    const tileY = Math.floor(spot.y) - 2;
    // Bootstrap privilege mirrors stampFinishedBuilding: age gate and
    // fog ignored, geometry still enforced.
    if (
      validatePlacement(world, comps, "town-center", tileX, tileY, PLAYER_ONE, {
        ignoreAgeGate: true,
        ignoreFog: true,
      }).ok
    ) {
      return { x: tileX, y: tileY };
    }
  }
  throw new Error("no valid town-center site near the map center");
}

/** First mirrored candidate whose 3×3 footprint stamps cleanly. */
function findAiTcOrigin(
  world: World,
  comps: SimComponents,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  for (const spot of passableTilesNear(
    world,
    anchor.x + 1.5,
    anchor.y + 1.5,
    40,
  )) {
    const tileX = Math.floor(spot.x) - 1;
    const tileY = Math.floor(spot.y) - 1;
    // Bootstrap privilege mirrors stampFinishedBuilding: age gate and
    // fog ignored, geometry still enforced.
    if (
      validatePlacement(world, comps, "town-center", tileX, tileY, AI_PLAYER, {
        ignoreAgeGate: true,
        ignoreFog: true,
      }).ok
    ) {
      return { x: tileX, y: tileY };
    }
  }
  throw new Error("no valid AI town-center site near the mirrored anchor");
}

// ---- Restart seed handoff ------------------------------------------------------

const NEXT_SEED_STORAGE_KEY = "ageofwind.nextSeed";

/** Minimal storage surface (localStorage in production, Map fake in tests). */
export interface SeedStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A fresh u32 seed for the next world, never colliding with `previous`.
 * App-level randomness (the sim never calls this); inject `rng` in tests.
 */
export function freshSeed(
  previous: number | undefined,
  rng: () => number = Math.random,
): number {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = Math.floor(rng() * 0x100000000) >>> 0;
    if (candidate !== previous) return candidate;
  }
  // 2⁻⁶⁴ collision odds collapsed into a defined tail: flip one bit.
  return (previous ?? 0) ^ 1;
}

export function stashNextSeed(store: SeedStore, seed: number): void {
  store.setItem(NEXT_SEED_STORAGE_KEY, String(seed));
}

/**
 * Consume the stashed restart seed, if any. Invalid or missing entries
 * return undefined (boot falls back to the dev seed); the key is always
 * cleared so one stash fires exactly one restart.
 */
export function consumeNextSeed(store: SeedStore): number | undefined {
  const raw = store.getItem(NEXT_SEED_STORAGE_KEY);
  store.removeItem(NEXT_SEED_STORAGE_KEY);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 0xffffffff ||
    Number.isNaN(parsed)
  ) {
    return undefined;
  }
  return parsed;
}

// ---- Save / restore (M5-T2, SPEC §2.12, issue #64) -----------------------------

/**
 * A save was attempted while path requests are still in flight. Saves
 * happen ONLY at quiet step boundaries: pending responses carry system
 * closures that cannot survive serialization, so the manager retries
 * next tick instead of saving a world that would resume diverged.
 */
export class SaveNotSafeError extends Error {
  constructor() {
    super(
      "cannot save now — path requests are still in flight; retry on the next step boundary",
    );
    this.name = "SaveNotSafeError";
  }
}

/** Serialized planner memory (plain data for the payload section). */
function plannerSaveStateOf(session: SkirmishWorld): PlannerSaveState {
  return {
    attackedTick: session.aiMemory.attackedTick,
    threatSince: session.militaryMemory.threatSince,
    lastRallyTick: session.militaryMemory.lastRallyTick,
    countersTrained: session.militaryMemory.countersTrained,
  };
}

function companiesSaveStateOf(session: SkirmishWorld): CompaniesSaveState {
  return {
    lastOutputTickByBuilding:
      session.companiesPersistent.lastOutputTickByBuilding,
    lastOrganicFoundingTick:
      session.companiesPersistent.lastOrganicFoundingTick,
  };
}

/**
 * Capture the whole session as `.ageof` container bytes. Throws
 * {@link SaveNotSafeError} when the path pipeline has not drained —
 * callers (autosave cadence, pause menu) simply retry next tick.
 */
export async function captureSkirmishSave(
  session: SkirmishWorld,
  playtimeSeconds: number,
): Promise<Uint8Array> {
  if (session.scheduler.pendingCount > 0) throw new SaveNotSafeError();
  const payload = snapshotPayload({
    world: session.world,
    playtimeSeconds,
    fog: captureFogSnapshot(session.fog),
    companies: companiesSaveStateOf(session),
    planner: plannerSaveStateOf(session),
  });
  return encodeAgeof(
    {
      seed: session.world.seed,
      tick: session.world.tick,
      playtimeSeconds,
      mapHash: fnv1a64(serializeLayers(session.world.layers)),
    },
    payload,
  );
}

export interface RestoredSkirmishSession extends SkirmishWorld {
  /** Simulated tick the save was taken at (= world.tick after restore). */
  readonly restoredFromTick: number;
  /** Play time carried in the header, resumed by the caller's clock. */
  readonly playtimeSeconds: number;
}

/**
 * Rebuild a full skirmish session from `.ageof` container bytes.
 *
 * Restore does NOT replay (SPEC §2.12): a fresh world allocates from
 * the stored seed + map, every section copies back byte-exactly, and
 * the §7 digest recipe re-runs against the stored stateDigest as the
 * free corruption check. Validation is loud, in order: magic → format
 * version → framing → gzip → map hash → sim/registry identity → digest.
 */
export async function restoreSkirmishSession(
  bytes: Uint8Array,
  options: SkirmishWorldOptions,
): Promise<RestoredSkirmishSession> {
  const { meta, payload } = decodeAgeof(bytes);
  const parsed = parsePayload(payload);
  assertMapHash(meta, parsed.mapBytes);
  if (meta.formatVersion !== AGEOF_FORMAT_VERSION) {
    throw new SaveFormatError(
      `.ageof format ${String(meta.formatVersion)} unsupported (this build reads ${String(AGEOF_FORMAT_VERSION)})`,
    );
  }
  if (parsed.simVersion !== SIM_VERSION) {
    throw new SaveFormatError(
      `save came from sim ${JSON.stringify(parsed.simVersion)}, this build is ${JSON.stringify(SIM_VERSION)} — incompatible`,
    );
  }

  const fog = createFogVisibility(parsed.fog.size, parsed.fog.playerCount);
  const scheduler = new PathScheduler(options.createTransport());
  const world = createWorld(meta.seed, {
    layers: parsed.layers,
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  const comps = defineSimComponents(world);
  const localNames = world.registry.namesInOrder();
  if (
    localNames.length !== parsed.registryNames.length ||
    localNames.some((name, i) => name !== parsed.registryNames[i])
  ) {
    throw new SaveFormatError(
      `save component registry mismatch — save carries [${parsed.registryNames.join(", ")}], this build registers [${localNames.join(", ")}]`,
    );
  }
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  // Roster FIRST (systems run only during step()), then byte-copy the
  // core state in before any of it can execute.
  const persistent = createSkirmishPersistentStates();
  const chosenStrategy: StrategyId =
    options.aiStrategy === "random"
      ? STRATEGY_IDS[Math.abs(meta.seed) % STRATEGY_IDS.length]!
      : (options.aiStrategy ?? "fast-castle-knights");
  const roster = wireSkirmishSystems(
    world,
    comps,
    scheduler,
    fog,
    normalizeLifecycleConfig(
      options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG,
    ),
    aiDifficultyOf(options.aiDifficulty),
    persistent,
    chosenStrategy,
  );

  world.tick = meta.tick;
  world.lastAllocatedEid = parsed.lastAllocatedEid;
  world.entities.length = 0;
  for (const eid of parsed.entities) world.entities.push(eid);
  world.prng = restorePrng(serializePrngState(parsed.prngWords));
  world.inbox.restoreState(meta.tick, parsed.commands);

  for (const name of localNames) {
    const id = world.registry.idOf(name);
    const rows = world.rowsByComponentId.get(id);
    if (!rows) throw new Error(`unregistered component id: ${String(id)}`);
    rows.clear();
    for (const [eid, values] of parsed.componentRows.get(name) ?? []) {
      rows.set(eid, [...values]);
    }
  }

  // Sight stamps rebuild from the restored rows, then planes + memory
  // ghosts copy over them verbatim (explored history is NOT derivable).
  fog.recomputeAll();
  applyFogSnapshot(fog, parsed.fog);

  persistent.companies.lastOutputTickByBuilding.clear();
  for (const [eid, tick] of parsed.companies.lastOutputTickByBuilding) {
    persistent.companies.lastOutputTickByBuilding.set(eid, tick);
  }
  persistent.companies.lastOrganicFoundingTick.clear();
  for (const [player, tick] of parsed.companies.lastOrganicFoundingTick) {
    persistent.companies.lastOrganicFoundingTick.set(player, tick);
  }
  persistent.aiMemory.attackedTick = parsed.planner.attackedTick;
  persistent.militaryMemory.threatSince.clear();
  for (const [eid, tick] of parsed.planner.threatSince) {
    persistent.militaryMemory.threatSince.set(eid, tick);
  }
  persistent.militaryMemory.lastRallyTick = parsed.planner.lastRallyTick;
  persistent.militaryMemory.countersTrained = parsed.planner.countersTrained;

  // THE corruption check: one canonical serializer serves hashing and
  // persistence, so a byte-perfect copy reproduces the digest exactly.
  const actualDigest = computeWorldDigest(world);
  if (actualDigest !== parsed.stateDigest) {
    throw new SaveFormatError(
      `.ageof digest verification failed: save says ${parsed.stateDigest}, rebuilt world hashes ${actualDigest} — the file is corrupted or from an incompatible build`,
    );
  }

  return {
    seed: meta.seed,
    world,
    comps,
    scheduler,
    fog,
    aiKnowledge: roster.aiKnowledge,
    aiTelemetry: roster.aiTelemetry,
    aiDifficulty: aiDifficultyOf(options.aiDifficulty).id,
    aiStrategy: chosenStrategy,
    aiMemory: persistent.aiMemory,
    militaryMemory: persistent.militaryMemory,
    companiesPersistent: persistent.companies,
    restoredFromTick: meta.tick,
    playtimeSeconds: meta.playtimeSeconds,
  };
}

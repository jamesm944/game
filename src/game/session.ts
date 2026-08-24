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
import { buildingIdOfCode } from "../data/definitions";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
} from "../sim/core/stockpile";
import { createPlayerAgeState } from "../sim/components/age";
import { createWorld, registerSystem, type World } from "../sim/core/world";
import { PathScheduler, type PathTransport } from "../sim/path/scheduler";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../sim/systems/fog";
import type { FogVisibilityHandle } from "../sim/systems/fog";
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
import { aiDifficultyOf, type AiDifficultyId } from "../sim/ai/difficulty";
import { scatterResourceNodes } from "../sim/mapgen/resources";

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
  const scheduler = new PathScheduler(options.createTransport());
  const size = options.size ?? 120;
  const fog = createFogVisibility(size, 2);
  const world = createWorld(seed, {
    size,
    pathScheduler: scheduler,
    visibility: fog.provider,
  });
  const comps = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  // System roster mirrors production registration order; the victory
  // evaluator runs after combat (settled destruction state) and the AI
  // planner stays LAST per its contract.
  // M4-T2: the companies ledger observes every output credit event, so
  // its observer wires into gather + production BEFORE they register;
  // the companies system itself runs after the delegation layer.
  const companies = createCompaniesSystem({ comps, players: [PLAYER_ONE] });
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

  // ---- Human start: ledger + age ladder + central TC + villagers ------
  const centerSpot = centralPassableTiles(world, 1)[0]!;
  createPlayerStockpile(world, comps, PLAYER_ONE, [...STARTING_RESOURCES]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createPlayerAgeState(world, comps, PLAYER_ONE);
  stampFinishedBuilding(
    world,
    comps,
    "town-center",
    Math.floor(centerSpot.x) - 1,
    Math.floor(centerSpot.y) - 2,
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
      strategy: "fast-castle-knights",
      telemetry: aiTelemetry,
      difficulty: difficulty.id,
    }),
  );

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

  // Map-gen full fog recompute (§2.9) — the ONLY non-incremental pass.
  fog.recomputeAll();

  return {
    seed,
    world,
    comps,
    scheduler,
    fog,
    aiKnowledge,
    aiTelemetry,
    aiDifficulty: difficulty.id,
  };
}

// ---- Spawn-site helpers (verbatim semantics from main.ts) ---------------------

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

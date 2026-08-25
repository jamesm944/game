/**
 * M5-T5 balance pass — Dark→Feudal→Castle→Imperial economy ramp
 * benchmark (issue #67, SPEC §2.6 "Baseline numbers = documented AoE2
 * values").
 *
 * A scripted macro plays the opening through the REAL command surface
 * (gather → drop-off → trainVillager → placeBuilding/build →
 * researchAge) on the lean production roster — movement, gather,
 * placement, construction, training and the age system — with labor
 * CONTINUOUS (no day/night systems registered), matching AoE2's
 * always-on worker assumption. Per-villager income emerges from the
 * same constants the shipped game uses: 30-tick extraction per unit,
 * carry 10, definition speeds/costs/train times.
 *
 * DOCUMENTED TARGETS (game clock at 30 ticks/s; 1 game-min = 1800t).
 * Reference points are AoE2 build-order literature timings for a PURE
 * ECONOMIC BOOM — continuous villager production, no army, no idle
 * workers — which is exactly what this script plays:
 *
 *   Age        AoE2 boom-line   Midpoint   Accept band (±20%)
 *   ---------- ---------------- ---------- ---------------------
 *   Feudal     reached ~9:00    tick 16200 [12960 .. 19440]
 *   Castle     reached ~17:30   tick 31500 [25200 .. 37800]
 *   Imperial   reached ~22:30   tick 40500 [32400 .. 48600]
 *
 * The macro is deliberately ordinary: continuous villager production
 * under the housed pause, a flat 50/30/20 food/wood/gold split, three
 * builders per site, age advances enqueued the moment their AoE2 costs
 * (500f · 800f200g · 1000f800g) and AoE2 research times (2:10 · 2:40 ·
 * 2:50) allow. Headless, deterministic seed, purity shims on.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getAssignedSite,
  getBuildingSiteRow,
  populationCapOf,
  populationOf,
  readActivityQueue,
  readTrainQueue,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import {
  buildingDefOf,
  buildingIdOfCode,
  techDefOf,
  unitDefOf,
} from "../../src/data/definitions";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { installSimPurityShims } from "../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../src/sim/world/layers";
import { createMovementSystem } from "../../src/sim/systems/movement";
import { createGatherSystem } from "../../src/sim/systems/gather";
import {
  createPlacementSystem,
  stampFinishedBuilding,
  validatePlacement,
} from "../../src/sim/systems/placement";
import { createConstructionSystem } from "../../src/sim/systems/construction";
import { createTrainingSystem } from "../../src/sim/systems/training";
import {
  RESEARCH_AGE_KIND,
  canStartAgeAdvance,
  createAgeSystem,
  currentAgeRankOf,
  nextAgeTechIdOf,
} from "../../src/sim/systems/age";
import { canAffordCosts } from "../../src/sim/systems/costs";
import {
  TRAIN_VILLAGER_KIND,
  canEnqueueTraining,
} from "../../src/sim/systems/training";
import {
  getInventory,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_WOOD,
} from "../../src/sim/components/economy";
import { RESOURCE_SLUGS } from "../../src/data/schema";

installSimPurityShims();

const SIZE = 72;
const SEED = 20260905;
const START_VILLAGERS = 5;
/** Skirmish seed capital (session.ts STARTING_RESOURCES). */
const STARTING_CAPITAL = [200, 600, 100, 0, 0, 0, 0] as const;

/** Planner runs on this cadence (every half sim-second). */
const MACRO_CADENCE = 15;
/** Hard stall guard — Imperial past this tick fails loudly. */
const RAMP_TICK_LIMIT = 70000;

/**
 * Documented acceptance bands (see file header): [midpoint, ±20%].
 * Ticks at 30/s; AoE2 reference clock converted 1 game-min = 1800t.
 */
const FEUDAL_BAND: readonly [number, number] = [12960, 19440];
const CASTLE_BAND: readonly [number, number] = [25200, 37800];
const IMPERIAL_BAND: readonly [number, number] = [32400, 48600];

interface RampResult {
  readonly feudalTick: number | undefined;
  readonly castleTick: number | undefined;
  readonly imperialTick: number | undefined;
  readonly finalPopulation: number;
}

// ---- Scripted macro ---------------------------------------------------------

type Bucket = "food" | "wood" | "gold";

const DESIRED_SPLIT: Readonly<Record<Bucket, number>> = {
  food: 0.5,
  wood: 0.3,
  gold: 0.2,
};
/** Fixed bucket priority when deficits tie (stable, deterministic). */
const BUCKET_ORDER: readonly Bucket[] = ["food", "wood", "gold"];
const BUILDERS_PER_SITE = 3;
/** Queue depth kept on the TC (AoE2-style continuous production). */
const QUEUE_DEPTH = 5;

function macroRamp(): RampResult {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(SEED, {
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
  registerSystem(world, createPlacementSystem(comps));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createTrainingSystem(comps));
  registerSystem(world, createAgeSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE, [...STARTING_CAPITAL]);

  // ---- Start town: finished TC + starting villagers ringing it.
  let tcEid = 0;
  let tcX = 0;
  let tcY = 0;
  outerTc: for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.floor(SIZE / 2) - 1 + dx;
      const y = Math.floor(SIZE / 2) - 1 + dy;
      if (validatePlacement(world, comps, "town-center", x, y).ok) {
        tcEid = stampFinishedBuilding(world, comps, "town-center", x, y);
        tcX = x;
        tcY = y;
        break outerTc;
      }
    }
  }
  if (tcEid === 0) throw new Error("ramp fixture could not stamp a TC");

  // ---- Resource fields near town (generous amounts: the benchmark
  // measures RATE constants, not depletion management).
  const nodeIdOf: Record<Bucket, number[]> = { food: [], wood: [], gold: [] };
  const plantCluster = (
    bucket: Bucket,
    offsetX: number,
    offsetY: number,
    count: number,
    amount: number,
    code: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      nodeIdOf[bucket].push(
        spawnResourceNode(
          world,
          comps,
          tcX + offsetX + (i % 2),
          tcY + offsetY + Math.floor(i / 2),
          code,
          amount,
        ),
      );
    }
  };
  plantCluster("food", 7, -3, 4, 10000, RESOURCE_FOOD);
  plantCluster("food", 7, 1, 2, 10000, RESOURCE_FOOD);
  // Wood + gold also sit in the east wedge: Move legs steer directly,
  // so every work target must be reachable without crossing the TC
  // footprint the villagers spawn beside.
  plantCluster("wood", 11, 2, 3, 10000, RESOURCE_WOOD);
  plantCluster("gold", 9, 9, 3, 10000, RESOURCE_GOLD);

  // Spawn strip sits BETWEEN the node fields and the building grid —
  // placements may not overlap units (placement validates terrain and
  // structures only), and a unit phased inside a fresh foundation jams
  // its steering permanently.
  const villagers: number[] = [];
  for (let i = 0; i < START_VILLAGERS; i++) {
    villagers.push(spawnUnit(world, comps, tcX + 4.5 + i, tcY + 12.5));
  }

  // ---- Controller state -------------------------------------------------------
  /** Villager → resource bucket assignment (controller bookkeeping). */
  const bucketOf = new Map<number, Bucket>();
  /** House placement cursor over the precomputed slot grid. */
  let houseCursor = 0;
  const HOUSE_GRID_SLOTS = 49;
  const buildingsPlaced = new Set<string>();
  let lastRank = currentAgeRankOf(world, comps, PLAYER_ONE);
  const completionTicks: Record<string, number | undefined> = {
    feudal: undefined,
    castle: undefined,
    imperial: undefined,
  };

  const submit = (
    kind: string,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    world.inbox.submit({ kind, targetTick: world.tick + 1, data });
  };
  // Trained villagers pop from the TC as fresh entities: discover every
  // new non-military unit (ActivityQueue+UnitTag, no Combat row) so the
  // controller actually employs them.
  const known = new Set<number>(villagers);
  const discoverNewVillagers = (): void => {
    for (const eid of world.entities) {
      if (known.has(eid)) continue;
      const unitRows = world.rowsByComponentId.get(comps.unitTagId);
      if (!unitRows?.has(eid)) continue;
      const queueRows = world.rowsByComponentId.get(comps.activityQueueId);
      if (!queueRows?.has(eid)) continue;
      if (world.rowsByComponentId.get(comps.combatId)?.has(eid)) continue;
      known.add(eid);
      villagers.push(eid);
    }
  };
  const alive = (): number[] =>
    villagers.filter((eid) => world.entities.includes(eid));

  const placeNearTown = (defId: string): void => {
    const fp = buildingDefOf(defId).footprint;
    // Southeast slot grid only: Move legs steer directly (no per-order
    // A*), so sites must stay on the spawn side of the TC where a
    // straight approach never clips a footprint — the jam-free wedge.
    for (let attempt = 0; attempt < HOUSE_GRID_SLOTS; attempt++) {
      const slot = (houseCursor + attempt) % HOUSE_GRID_SLOTS;
      const col = slot % 7;
      const row = Math.floor(slot / 7);
      const x = tcX + 5 + col * (fp.width + 1);
      const y = tcY + 15 + row * (fp.height + 1);
      if (x < 0 || y < 0 || x + fp.width >= SIZE || y + fp.height >= SIZE) {
        continue;
      }
      if (!validatePlacement(world, comps, defId, x, y).ok) continue;
      houseCursor = (slot + 1) % HOUSE_GRID_SLOTS;
      submit("placeBuilding", { defId, tileX: x, tileY: y });
      return;
    }
    throw new Error(`macro could not site ${defId}`);
  };

  /** Population-cap contribution of the player's unfinished sites. */
  const pendingPopCap = (): { extra: number; houses: number } => {
    let extra = 0;
    let houses = 0;
    for (const eid of world.entities) {
      const row = getBuildingSiteRow(world, comps, eid);
      if (!row || row[0] !== PLAYER_ONE) continue;
      const def = buildingDefOf(buildingIdOfCode(row[1]!));
      extra += def.populationCap;
      if (def.id === "house") houses += 1;
    }
    return { extra, houses };
  };

  const pendingSites = (): number[] => {
    const sites: number[] = [];
    for (const eid of world.entities) {
      if (getBuildingSiteRow(world, comps, eid) !== undefined) sites.push(eid);
    }
    return sites.sort((a, b) => a - b);
  };

  const macroPass = (): void => {
    // 1) Age advance: enqueue the moment it is legal AND affordable.
    if (canStartAgeAdvance(world, comps, PLAYER_ONE)) {
      const tech = techDefOf(nextAgeTechIdOf(lastRank)!);
      if (canAffordCosts(world, comps, PLAYER_ONE, tech.costs)) {
        submit(RESEARCH_AGE_KIND, { playerId: PLAYER_ONE });
      }
    }

    // 2) Continuous villager production under the housed pause.
    const queued = readTrainQueue(world, comps, tcEid).length;
    if (
      queued < QUEUE_DEPTH &&
      canEnqueueTraining(world, comps, tcEid, PLAYER_ONE) &&
      canAffordCosts(world, comps, PLAYER_ONE, unitDefOf("villager").costs)
    ) {
      submit(TRAIN_VILLAGER_KIND, { siteEid: tcEid });
    }

    // 3) Housing ahead of the cap (one house in flight at a time).
    const cap = populationCapOf(world, comps, PLAYER_ONE);
    const pending = pendingPopCap();
    if (
      pending.houses === 0 &&
      populationOf(world, comps, PLAYER_ONE) >= cap + pending.extra - 1 &&
      canAffordCosts(world, comps, PLAYER_ONE, buildingDefOf("house").costs)
    ) {
      placeNearTown("house");
    }

    // 4) Prerequisite buildings per target age (each placed once).
    const rank = currentAgeRankOf(world, comps, PLAYER_ONE);
    const wantBuildings: string[] = [];
    if (rank >= 2) wantBuildings.push("barracks", "blacksmith");
    if (rank >= 3) wantBuildings.push("archery-range");
    for (const defId of wantBuildings) {
      if (buildingsPlaced.has(defId)) continue;
      if (
        canAffordCosts(world, comps, PLAYER_ONE, buildingDefOf(defId).costs)
      ) {
        buildingsPlaced.add(defId);
        placeNearTown(defId);
      }
    }

    // 5) Idle sweep: staff pending sites first, else rebalance gathers.
    // A villager holding an AssignedSite row is ON SITE DUTY even while
    // its walk leg is between heads (in-range builders contribute with
    // an empty queue) — only the construction system releases them, on
    // completion. Never second-guess that row here.
    discoverNewVillagers();
    const sites = pendingSites();
    const living = alive();
    const builderCountOf = (site: number): number => {
      let count = 0;
      for (const other of living) {
        if (getAssignedSite(world, comps, other) === site) count += 1;
      }
      return count;
    };
    for (const eid of living) {
      const assigned = getAssignedSite(world, comps, eid);
      // Site staffing preempts everything (AoE2 order semantics: build
      // re-tasks a working villager; the construction system replaces
      // the old job and releases the crew on completion).
      const understaffed = sites.find(
        (site) => site !== assigned && builderCountOf(site) < BUILDERS_PER_SITE,
      );
      if (understaffed !== undefined) {
        submit("build", { entityIds: [eid], siteEid: understaffed });
        continue;
      }
      if (assigned !== undefined) continue;
      if (readActivityQueue(world, comps, eid).length > 0) continue;
      // Rebalance: largest positive deficit wins, stable order breaks ties.
      const counts: Record<Bucket, number> = { food: 0, wood: 0, gold: 0 };
      for (const other of living) {
        const bucket = bucketOf.get(other);
        if (bucket !== undefined) counts[bucket] += 1;
      }
      let pick: Bucket | undefined;
      let bestDeficit = 0;
      for (const bucket of BUCKET_ORDER) {
        const deficit = DESIRED_SPLIT[bucket] * living.length - counts[bucket];
        if (deficit > bestDeficit + 1e-9) {
          bestDeficit = deficit;
          pick = bucket;
        }
      }
      pick ??= BUCKET_ORDER[living.length % BUCKET_ORDER.length]!;
      // Workers carry ONE resource kind: a villager with full hands
      // follows its LOAD (finishes the delivery chain, empties them,
      // and is re-picked next pass) — the gather command refuses
      // mixed loads.
      const carried = getInventory(world, comps, eid);
      if (carried !== undefined && carried.amount > 0) {
        pick = RESOURCE_SLUGS[carried.resourceCode] as Bucket;
      }
      bucketOf.set(eid, pick);
      const nodes = nodeIdOf[pick];
      submit("gather", {
        entityIds: [eid],
        nodeId: nodes[living.indexOf(eid) % nodes.length]!,
      });
    }
  };

  // Rank-promotion bookkeeping runs AFTER every step (not inside the
  // pass): the final promotion exits the while loop before another
  // macroPass could observe it.
  const recordPromotions = (): void => {
    const promoted = currentAgeRankOf(world, comps, PLAYER_ONE);
    while (lastRank < promoted) {
      lastRank += 1;
      const key =
        lastRank === 2 ? "feudal" : lastRank === 3 ? "castle" : "imperial";
      if (completionTicks[key] === undefined) {
        completionTicks[key] = world.tick;
      }
    }
  };

  while (
    world.tick < RAMP_TICK_LIMIT &&
    currentAgeRankOf(world, comps, PLAYER_ONE) < 4
  ) {
    if (world.tick % MACRO_CADENCE === 0) macroPass();
    step(world);
    recordPromotions();
  }

  return {
    feudalTick: completionTicks.feudal,
    castleTick: completionTicks.castle,
    imperialTick: completionTicks.imperial,
    finalPopulation: populationOf(world, comps, PLAYER_ONE),
  };
}

// ---- Suites --------------------------------------------------------------------

describe("economy ramp benchmark (SPEC §2.6, issue #67)", () => {
  // One full macro run feeds every gate: the simulation is the fixture.
  let run: RampResult;

  beforeAll(() => {
    run = macroRamp();
    console.log(
      `[balance] ramp ticks (30/s): feudal=${String(run.feudalTick)} ` +
        `castle=${String(run.castleTick)} imperial=${String(run.imperialTick)} ` +
        `pop=${String(run.finalPopulation)}`,
    );
  }, 600_000);

  it("reaches Feudal within ±20% of the AoE2-reasonable budget", () => {
    expect(run.feudalTick).toBeDefined();
    expect(run.feudalTick!).toBeGreaterThanOrEqual(FEUDAL_BAND[0]);
    expect(run.feudalTick!).toBeLessThanOrEqual(FEUDAL_BAND[1]);
    expect(run.finalPopulation).toBeGreaterThan(START_VILLAGERS);
  });

  it("reaches Castle within ±20% of the AoE2-reasonable budget", () => {
    expect(run.castleTick).toBeDefined();
    expect(run.castleTick!).toBeGreaterThanOrEqual(CASTLE_BAND[0]);
    expect(run.castleTick!).toBeLessThanOrEqual(CASTLE_BAND[1]);
  });

  it("reaches Imperial within ±20% of the AoE2-reasonable budget", () => {
    expect(run.imperialTick).toBeDefined();
    expect(run.imperialTick!).toBeLessThanOrEqual(IMPERIAL_BAND[1]);
    expect(run.imperialTick!).toBeGreaterThanOrEqual(IMPERIAL_BAND[0]);
  });
});

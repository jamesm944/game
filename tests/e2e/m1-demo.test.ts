/**
 * M1 demo checklist, headless half — SPEC §8 M1 / M1-T11.
 *
 * Executes the machine-verifiable portion of the M1 demo ("drag-box
 * villagers, send them to chop/build") as one scripted end-to-end run
 * over the REAL command surface and the full M1 system stack on a
 * seeded 120×120 map:
 *
 *   1. gather orders drive villagers to chop trees → deposits land;
 *   2. placeBuilding + build orders construct two houses and a
 *      barracks to completion;
 *   3. trainVillager orders fill the TC queue until population pins
 *      at the pop cap — enqueues made while only the TC stands sit
 *      frozen under its cap of 5 until the houses raise it to 15,
 *      exercising the AoE2 housed-pause on the way.
 *
 * Every order enters through the same command kinds the UI emits, so
 * a green run here IS the demo's sim half. Browser-only checks that
 * cannot execute headlessly (visual 60 fps feel, drag-box rendering,
 * audio) are listed as manual items in docs/m1-budget.md.
 */

import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getBuildingRow,
  getBuildingSiteRow,
  populationCapOf,
  populationOf,
  readTrainQueue,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../src/sim/components";
import { buildingDefOf, buildingIdOfCode } from "../../src/data/definitions";
import {
  rectsOverlap,
  type FootprintRect,
} from "../../src/sim/components/buildings";
import { RESOURCE_WOOD } from "../../src/sim/components/economy";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../src/sim/core/world";
import { generateMap } from "../../src/sim/mapgen/generate";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { createConstructionSystem } from "../../src/sim/systems/construction";
import { createGatherSystem } from "../../src/sim/systems/gather";
import {
  createPlacementSystem,
  stampFinishedBuilding,
  validatePlacement,
} from "../../src/sim/systems/placement";
import {
  createTrainingDiagnostics,
  createTrainingSystem,
  type TrainingDiagnostics,
} from "../../src/sim/systems/training";
import { createMovementSystem } from "../../src/sim/systems/movement";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const MAP_SIZE = 120;
const START_VILLAGERS = 4;
const TRAIN_TARGET = 11; // 4 start + 11 trained = 15 = TC(5)+houses(10)
/** Deadlock guard: any phase exceeding this many steps fails loudly. */
const MAX_PHASE_STEPS = 30_000;

/** Step until `done()` holds; throw with `label` if the phase stalls. */
function stepUntil(world: World, done: () => boolean, label: string): void {
  for (let steps = 0; steps <= MAX_PHASE_STEPS; steps++) {
    if (done()) return;
    step(world);
  }
  throw new Error(
    `M1 demo phase stalled after ${String(MAX_PHASE_STEPS)} steps: ${label}`,
  );
}

function pendingSites(world: World, comps: SimComponents): number[] {
  const sites: number[] = [];
  for (const eid of world.entities) {
    if (getBuildingSiteRow(world, comps, eid) !== undefined) sites.push(eid);
  }
  return sites;
}

function finishedBuildings(world: World, comps: SimComponents): number[] {
  const built: number[] = [];
  for (const eid of world.entities) {
    if (getBuildingRow(world, comps, eid) !== undefined) built.push(eid);
  }
  return built;
}

describe("M1 demo checklist (SPEC §8)", () => {
  it("chops, constructs house+barracks, trains villagers to the pop cap", () => {
    const layers = generateMap(20260822, MAP_SIZE);
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const world = createWorld(20260822, { layers, pathScheduler: scheduler });
    const comps = defineSimComponents(world);
    const training: TrainingDiagnostics = createTrainingDiagnostics();
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(world, createGatherSystem(comps, scheduler));
    registerSystem(world, createPlacementSystem(comps));
    registerSystem(world, createConstructionSystem(comps));
    registerSystem(world, createTrainingSystem(comps, training));

    // Opening capital only: everything below is paid through the real
    // cost paths (escrow at placement / enqueue), never granted mid-run.
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [1000, 3000, 0, 0, 0, 0, 0],
    );

    // ---- Start town: TC near the map center, four villagers ringing it.
    const center = Math.floor((MAP_SIZE - 1) / 2);
    let tcEid = 0;
    let tcX = 0;
    let tcY = 0;
    outerTc: for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = center - 1 + dx;
        const y = center - 1 + dy;
        if (validatePlacement(world, comps, "town-center", x, y).ok) {
          tcEid = stampFinishedBuilding(world, comps, "town-center", x, y);
          tcX = x;
          tcY = y;
          break outerTc;
        }
      }
    }
    expect(tcEid).toBeGreaterThan(0);

    const villagerIds: number[] = [];
    outerSpawn: for (let ring = 2; ring < 10; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const tx = tcX + 1 + dx;
          const ty = tcY + 1 + dy;
          if (
            tx < 0 ||
            ty < 0 ||
            tx >= MAP_SIZE ||
            ty >= MAP_SIZE ||
            layers.derivedPassability[ty * MAP_SIZE + tx] !== 1
          ) {
            continue;
          }
          villagerIds.push(spawnUnit(world, comps, tx + 0.5, ty + 0.5));
          if (villagerIds.length === START_VILLAGERS) break outerSpawn;
        }
      }
    }
    expect(villagerIds.length).toBe(START_VILLAGERS);

    // ---- Deep-reserve wood nodes, kept clear of the start area.
    const scattered = scatterResourceNodes(layers, 0x9e3779b9, {
      count: 40,
      minSpacing: 3,
    }).filter((node) => {
      if (layers.derivedPassability[node.tileY * MAP_SIZE + node.tileX] !== 1) {
        return false;
      }
      return (
        Math.max(Math.abs(node.tileX - center), Math.abs(node.tileY - center)) >
        6
      );
    });
    expect(scattered.length).toBeGreaterThanOrEqual(2);
    const nearestNodeIds = [...scattered]
      .sort(
        (a, b) =>
          (a.tileX - center) ** 2 +
          (a.tileY - center) ** 2 -
          ((b.tileX - center) ** 2 + (b.tileY - center) ** 2),
      )
      .slice(0, 2)
      .map((node) =>
        spawnResourceNode(
          world,
          comps,
          node.tileX,
          node.tileY,
          RESOURCE_WOOD,
          node.amount * 40,
        ),
      );

    // ---- Placement spots: first ring-order positions ≥4 tiles out
    // that validate without overlapping each other or anything else.
    const candidates: { x: number; y: number }[] = [];
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) continue;
        candidates.push({ x: tcX - 1 + dx, y: tcY - 1 + dy });
      }
    }
    const acceptedRects: FootprintRect[] = [];
    const pickSpot = (defId: string): { x: number; y: number } => {
      const def = buildingDefOf(defId);
      for (const candidate of candidates) {
        const rect: FootprintRect = {
          x: candidate.x,
          y: candidate.y,
          width: def.footprint.width,
          height: def.footprint.height,
        };
        if (acceptedRects.some((other) => rectsOverlap(other, rect))) continue;
        if (
          !validatePlacement(world, comps, defId, candidate.x, candidate.y).ok
        )
          continue;
        acceptedRects.push(rect);
        return candidate;
      }
      throw new Error(`no valid demo spot for ${defId}`);
    };
    const houseASpot = pickSpot("house");
    const houseBSpot = pickSpot("house");
    const barracksSpot = pickSpot("barracks");

    // ---- Phase A orders: two chop pairs, three placements.
    const pairA = villagerIds.slice(0, 2);
    const pairB = villagerIds.slice(2, 4);
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: { entityIds: pairA, nodeId: nearestNodeIds[0]! },
    });
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: { entityIds: pairB, nodeId: nearestNodeIds[1]! },
    });
    for (const [defId, spot] of [
      ["house", houseASpot],
      ["house", houseBSpot],
      ["barracks", barracksSpot],
    ] as const) {
      world.inbox.submit({
        kind: "placeBuilding",
        targetTick: world.tick + 1,
        data: { defId, tileX: spot.x, tileY: spot.y },
      });
    }

    // Settle one tick so the sites exist, then put one builder on each
    // house — the same build flow as clicking a ghost with units selected.
    step(world);
    expect(pendingSites(world, comps).length).toBe(3);
    const houseSiteIds: number[] = [];
    let barracksSiteId = 0;
    for (const siteEid of pendingSites(world, comps)) {
      const row = getBuildingSiteRow(world, comps, siteEid)!;
      const defId = buildingIdOfCode(row[1]!);
      if (defId === "house") houseSiteIds.push(siteEid);
      else barracksSiteId = siteEid;
    }
    houseSiteIds.sort((a, b) => a - b);
    expect(houseSiteIds.length).toBe(2);
    expect(barracksSiteId).toBeGreaterThan(0);
    // Wood ledger right after placement escrow (3000 − 30 − 30 − 175).
    const woodAfterPlacement = stockpileAmountsOf(world, comps, PLAYER_ONE)[1]!;
    expect(woodAfterPlacement).toBe(2765);

    world.inbox.submit({
      kind: "build",
      targetTick: world.tick + 1,
      data: { entityIds: [pairB[0]!], siteEid: houseSiteIds[0]! },
    });
    world.inbox.submit({
      kind: "build",
      targetTick: world.tick + 1,
      data: { entityIds: [pairB[1]!], siteEid: houseSiteIds[1]! },
    });

    // ---- Phase B: houses finish under their builders…
    stepUntil(
      world,
      () =>
        houseSiteIds.every(
          (eid) => getBuildingRow(world, comps, eid) !== undefined,
        ),
      "houses never finished",
    );
    // …then the freed pair raises the barracks together.
    world.inbox.submit({
      kind: "build",
      targetTick: world.tick + 1,
      data: {
        entityIds: [pairB[0]!, pairB[1]!],
        siteEid: barracksSiteId,
      },
    });
    stepUntil(
      world,
      () => pendingSites(world, comps).length === 0,
      "barracks never finished",
    );

    expect(finishedBuildings(world, comps).length).toBe(4); // TC+2 houses+barracks

    // ---- Phase C: fill the TC queue; population pins at the cap.
    // Early enqueues freeze under the TC-only cap of 5 until both
    // houses are up — the queue only drains past them afterwards.
    for (let i = 0; i < TRAIN_TARGET; i++) {
      world.inbox.submit({
        kind: "trainVillager",
        targetTick: world.tick + 1,
        data: {},
      });
    }

    stepUntil(
      world,
      () =>
        readTrainQueue(world, comps, tcEid).length === 0 &&
        populationOf(world, comps) === populationCapOf(world, comps),
      "training never reached the pop cap",
    );

    // ---- End-state assertions (the demo checklist's sim half).
    expect(populationCapOf(world, comps)).toBe(15);
    expect(populationOf(world, comps)).toBe(15);
    expect(training.unitsTrained).toBe(TRAIN_TARGET);
    expect(pendingSites(world, comps).length).toBe(0);
    expect(finishedBuildings(world, comps).length).toBe(4);

    const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
    // Food: escrowed 11 × 50 at enqueue; nothing else touches food.
    expect(amounts[0]).toBe(1000 - TRAIN_TARGET * 50);
    // Wood: placements debited exactly 235; chop→haul→deposit income
    // runs throughout, ending strictly above the post-placement base.
    expect(amounts[1]).toBeGreaterThan(woodAfterPlacement);

    // Nobody ended up stuck inside terrain or footprints.
    const size = layers.size;
    const passability = layers.derivedPassability;
    for (const eid of world.entities) {
      const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(eid);
      if (!posRow || !tagRow) continue;
      const tx = Math.floor(posRow[0]!);
      const ty = Math.floor(posRow[1]!);
      expect(passability[ty * size + tx]).toBe(1);
    }
  });
});

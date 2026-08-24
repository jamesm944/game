/**
 * M3 sign-off budget scenario — SPEC §7 / M3-T10 (issue #55).
 *
 * The §7 CPU gates re-run at the M3 workload: 305 FULLY DEEP-SIMMED
 * Pops (Identity/Traits/Skills/Needs/Lessons/Body/Morale rows on every
 * villager) with the whole M3 stack live on the shared production
 * skirmish bootstrap — needs decay + eating, knowledge-vs-practice
 * rust, lifecycle + households + births, school lessons, day/night
 * schedules, leisure/social bonds and the IAUS pop brain — measured
 * across the DAILY TRANSITION ZOO rather than steady-state labor:
 *
 *   - 300 scenario villagers (5 start + 300 spawns) ordered onto a
 *     deep wood/food gather ring around the human town;
 *   - village venues stamped finished (4 houses, school, church,
     tavern) so households form, births roll, lessons teach, Mass
 *     books and paid-venue outings execute;
 *   - COMPRESSED CLOCK (LifecycleConfig dayTicks 600): one sim week is
 *     4,200 ticks instead of 100,800, so the 600-tick measured window
 *     deterministically contains the evening-release storm, the leisure
 *     planning wave, the 22:00 bedding storm, the dawn household-
 *     formation + birth-roll boundary and the 05:00 wake refills —
 *     the churniest recurring M3 load, which a canonical-clock window
 *     would only sample occasionally.
 *
 * Warm-up absorbs JIT + the initial path storm; MEASURED_TICKS feed
 * mean/p95/max; mirror snapshot copy is best-of-seven. Draw calls stay
 * a static composition approximation (GL context needed otherwise).
 */

import {
  spawnResourceNode,
  spawnUnit,
  populationOf,
  type SimComponents,
} from "../../src/sim/components";
import { RESOURCE_FOOD, RESOURCE_WOOD } from "../../src/sim/components/economy";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { step, type World } from "../../src/sim/core/world";
import { createSkirmishWorld } from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import {
  stampFinishedBuilding,
  validatePlacement,
} from "../../src/sim/systems/placement";
import { rectsOverlap } from "../../src/sim/components/buildings";
import type { LifecycleConfig } from "../../src/sim/systems/lifecycle";
import { buildingDefOf } from "../../src/data/definitions";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import { captureSimSnapshot } from "../../src/sim/mirror";
import { approximateDrawCalls } from "./budget-scenario";

/** Scenario scale: §7 envelope floor of 300+ deep-simmed Pops. */
export const VILLAGER_COUNT = 300;
export const EXTRA_NODE_COUNT = 30;
export const WARMUP_TICKS = 150;
/**
 * Half a compressed day: the measured window spans afternoon work, the
 * 18:00 staggered release, evening leisure planning, the 22:00 bedding,
 * the midnight→dawn household/birth boundary and the 05:00 wake.
 */
export const MEASURED_TICKS = 600;

/**
 * Compressed M3 fixture clock (SPEC §2.3 thresholds scaled so arrivals
 * stay working adults through the measured window while births still
 * land): 600 ticks/day, adult at 4 days, elder at 8, lifespan 11.
 */
export const M3_BUDGET_CLOCK: LifecycleConfig = {
  dayTicks: 600,
  adultAgeDays: 4,
  elderAgeDays: 8,
  lifespanDays: 11,
};

/** Scenario bank so births/outings never starve mid-measurement. */
const CAPITAL = [4000, 4000, 500, 0, 0, 0, 0];

export interface BudgetM3RunResult {
  readonly villagerCount: number;
  readonly measuredTicks: number;
  readonly meanTickMs: number;
  readonly p95TickMs: number;
  readonly maxTickMs: number;
  readonly mirrorCopyMs: number;
  readonly drawCallApprox: number;
  /** Household rows live when measurement ended (lifecycle active). */
  readonly householdsFormed: number;
  /** Named-Pop population when measurement ended (births landed). */
  readonly populationEnd: number;
}

/**
 * Stamp `defId` finished for `playerId` at the first valid non-
 * overlapping spot ring-searched outward from an anchor (bootstrap
 * privilege, mirrors stampFinishedBuilding's own validation).
 * Exported for the M4 budget scenario, which layers the delegation +
 * companies workload on top of this same village.
 */
export function stampVillageBuilding(
  world: World,
  comps: SimComponents,
  defId: string,
  anchorX: number,
  anchorY: number,
  acceptedRects: { x: number; y: number; width: number; height: number }[],
): number {
  const size = world.layers.size;
  const def = buildingDefOf(defId);
  for (let ring = 3; ring <= 20; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.floor(anchorX) + dx;
        const y = Math.floor(anchorY) + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const rect = {
          x,
          y,
          width: def.footprint.width,
          height: def.footprint.height,
        };
        if (acceptedRects.some((other) => rectsOverlap(other, rect))) continue;
        if (
          !validatePlacement(world, comps, defId, x, y, PLAYER_ONE, {
            ignoreAgeGate: true,
            ignoreFog: true,
          }).ok
        )
          continue;
        const eid = stampFinishedBuilding(world, comps, defId, x, y, {
          playerId: PLAYER_ONE,
        });
        acceptedRects.push(rect);
        return eid;
      }
    }
  }
  throw new Error(`budget-m3 found no valid spot for ${defId}`);
}

/** Run the full M3 workload and return its measured telemetry. */
export function runBudgetScenarioM3(): BudgetM3RunResult {
  // Session-tested seed: hosted map (no center water) with both bases.
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
    lifecycleConfig: M3_BUDGET_CLOCK,
  });
  const { world, comps } = session;

  for (const ledger of world.rowsByComponentId
    .get(comps.stockpileId)!
    .values()) {
    for (let code = 0; code < CAPITAL.length; code++) {
      ledger[code + 1] = CAPITAL[code]!;
    }
  }

  const townAnchor = townCenterAnchor(world, comps);
  const acceptedRects: {
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  for (const defId of [
    "house",
    "house",
    "house",
    "house",
    "school",
    "church",
    "tavern",
  ]) {
    stampVillageBuilding(
      world,
      comps,
      defId,
      townAnchor.x,
      townAnchor.y,
      acceptedRects,
    );
  }

  // Deep gather ring: half food, half wood, generous reserves so the
  // measured window never runs dry mid-phase.
  const extraNodes = scatterResourceNodes(world.layers, 0x51ed270b, {
    count: EXTRA_NODE_COUNT,
    minSpacing: 3,
  }).filter((node) => {
    const size = world.layers.size;
    if (world.layers.derivedPassability[node.tileY * size + node.tileX] !== 1)
      return false;
    return (
      Math.max(
        Math.abs(node.tileX - Math.floor(townAnchor.x)),
        Math.abs(node.tileY - Math.floor(townAnchor.y)),
      ) > 6
    );
  });
  if (extraNodes.length < EXTRA_NODE_COUNT / 2) {
    throw new Error("budget-m3 needs at least 15 scatterable nodes");
  }
  const nodeIds = extraNodes.map((node, index) =>
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      index % 2 === 0 ? RESOURCE_FOOD : RESOURCE_WOOD,
      node.amount * 40,
    ),
  );

  // 300 extra villagers, fully deep-simmed, ringed around the town.
  const villagerIds: number[] = [];
  spawnRinged(
    world,
    comps,
    townAnchor.x,
    townAnchor.y,
    VILLAGER_COUNT,
    2,
    (x, y) => {
      villagerIds.push(
        spawnUnit(world, comps, x, y, {
          ownerId: PLAYER_ONE,
          identity: true,
          body: true,
          morale: true,
        }),
      );
    },
  );

  // Gather orders: chunks of ten, round-robin across all nodes.
  const chunkSize = 10;
  for (let first = 0; first < VILLAGER_COUNT; first += chunkSize) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: {
        entityIds: villagerIds.slice(first, first + chunkSize),
        nodeId: nodeIds[(first / chunkSize) % nodeIds.length]!,
      },
    });
  }

  for (let i = 0; i < WARMUP_TICKS; i++) step(world);

  const samples: number[] = [];
  for (let i = 0; i < MEASURED_TICKS; i++) {
    const start = performance.now();
    step(world);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95TickMs = samples[Math.ceil(samples.length * 0.95) - 1]!;
  const meanTickMs =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const maxTickMs = samples[samples.length - 1]!;

  let frame = captureSimSnapshot(world, comps);
  captureSimSnapshot(world, comps, { reusable: frame });
  let mirrorCopyMs = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 7; attempt++) {
    const start = performance.now();
    frame = captureSimSnapshot(world, comps, { reusable: frame });
    mirrorCopyMs = Math.min(mirrorCopyMs, performance.now() - start);
  }

  return {
    villagerCount: VILLAGER_COUNT,
    measuredTicks: MEASURED_TICKS,
    meanTickMs,
    p95TickMs,
    maxTickMs,
    mirrorCopyMs,
    drawCallApprox: approximateDrawCalls(1), // villager billboards only
    householdsFormed: world.rowsByComponentId.get(comps.householdId)!.size,
    populationEnd: populationOf(world, comps, PLAYER_ONE),
  };
}

function townCenterAnchor(
  world: World,
  comps: SimComponents,
): { x: number; y: number } {
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (!row || row[0] !== PLAYER_ONE) continue;
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    // Town centers are the first stamped building of the bootstrap.
    return { x: pos[0]!, y: pos[1]! };
  }
  throw new Error("budget-m3: no player building found");
}

/**
 * Spawn `count` units ringed outward around an anchor on passable
 * tiles, starting at `minRing` so separate populations don't stack;
 * deterministic ring scan (same idiom as the M1/M2 helpers). Exported
 * for the M4 budget scenario.
 */
export function spawnRinged(
  world: World,
  comps: SimComponents,
  anchorX: number,
  anchorY: number,
  count: number,
  minRing: number,
  spawn: (x: number, y: number) => void,
): void {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  const baseX = Math.floor(anchorX);
  const baseY = Math.floor(anchorY);
  let placed = 0;
  for (let ring = minRing; placed < count && ring < 40; ring++) {
    for (let dy = -ring; dy <= ring && placed < count; dy++) {
      for (let dx = -ring; dx <= ring && placed < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = baseX + dx;
        const y = baseY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (passability[y * size + x] !== 1) continue;
        spawn(x + 0.5, y + 0.5);
        placed += 1;
      }
    }
  }
  if (placed < count) {
    throw new Error(
      `budget-m3 could only place ${String(placed)}/${String(count)} units`,
    );
  }
}

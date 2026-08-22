/**
 * M1 sign-off budget scenario — SPEC §7 / M1-T11.
 *
 * The canonical headless budget workload, shared verbatim by the perf
 * gate (tests/perf/budget.test.ts) and the recording tool
 * (`npx tsx tools/perf-record.ts`, which produced docs/m1-budget.md):
 *
 *   - real seeded 120×120 map, synchronous path transport;
 *   - 300 villagers ordered to chop wood in chunks of ten round-robin
 *     across ~60 deep-reserve nodes → continuous walk/chop/haul/repeat
 *     (steering, slot claims, A*-costed drop-off choice, deposits);
 *   - warm-up absorbs JIT + the initial path-request storm;
 *   - MEASURED_TICKS individually timed steps feed mean/p95/max;
 *   - mirror snapshot copy measured best-of-seven with a reusable frame.
 *
 * Draw calls cannot be read headlessly (renderer.info needs a GL
 * context), so callers get a STATIC scene-composition approximation
 * instead; GPU numbers stay manual per SPEC §7 (docs/m1-budget.md).
 */

import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import { RESOURCE_WOOD } from "../../src/sim/components/economy";
import {
  createPlayerStockpile,
  createDropOffPoint,
} from "../../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../../src/sim/core/world";
import { generateMap } from "../../src/sim/mapgen/generate";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import { captureSimSnapshot } from "../../src/sim/mirror";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { createGatherSystem } from "../../src/sim/systems/gather";
import { createMovementSystem } from "../../src/sim/systems/movement";

export const MAP_SIZE = 120;
export const VILLAGER_COUNT = 300;
export const NODE_COUNT = 60;
/** Ticks stepped before timing begins (JIT + initial path storm). */
export const WARMUP_TICKS = 120;
/** Individually timed ticks feeding the p95 sample (§7 scenario length). */
export const MEASURED_TICKS = 300;

/** SPEC §7 hard caps, measured on developer hardware. */
export const TICK_P95_BUDGET_MS = 8;
export const MIRROR_COPY_BUDGET_MS = 2;
/**
 * Documented CI tolerance: budgets ×4 when running on shared runners
 * (process.env.CI). Generous by design so a busy runner trips only on
 * real regressions; the nightly soak owns fine-grained telemetry.
 */
export const CI_TOLERANCE_MULTIPLIER = 4;

/**
 * Static approximation of renderer.info.render.calls from the CURRENT
 * render/ composition (one draw per role, verified against source):
 * merged terrain splat + one instanced billboard atlas per unit type +
 * buildings/sites InstancedMesh + selection-ring InstancedMesh + the
 * 5-mesh move-marker pool (all visible worst case) + build ghost. Fog
 * DataTextures are uploads, not draws.
 */
export function approximateDrawCalls(unitTypeCount: number): number {
  return 1 + unitTypeCount + 1 + 1 + 5 + 1;
}

export interface BudgetRunResult {
  readonly villagerCount: number;
  readonly measuredTicks: number;
  readonly meanTickMs: number;
  readonly p95TickMs: number;
  readonly maxTickMs: number;
  readonly mirrorCopyMs: number;
  readonly drawCallApprox: number;
}

/** Run the full §7 workload and return its measured telemetry. */
export function runBudgetScenario(): BudgetRunResult {
  const layers = generateMap(424242, MAP_SIZE);
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(20260822, { layers, pathScheduler: scheduler });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createGatherSystem(comps, scheduler));

  // Depot + stockpile near the map center (first passable tile).
  const center = Math.floor((MAP_SIZE - 1) / 2);
  let depotX = center;
  let depotY = center;
  outer: for (let radius = 0; radius < MAP_SIZE; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = center + dx;
        const y = center + dy;
        if (
          x >= 0 &&
          y >= 0 &&
          x < MAP_SIZE &&
          y < MAP_SIZE &&
          layers.derivedPassability[y * MAP_SIZE + x] === 1
        ) {
          depotX = x;
          depotY = y;
          break outer;
        }
      }
    }
  }
  createPlayerStockpile(world, comps);
  createDropOffPoint(world, comps, depotX + 0.5, depotY + 0.5);

  // Wood-forced nodes with deep reserves so nobody goes dry mid-run.
  const nodes = scatterResourceNodes(layers, 0x9e3779b9, {
    count: NODE_COUNT,
    minSpacing: 3,
  });
  if (nodes.length < NODE_COUNT / 2) {
    throw new Error("budget scenario needs at least 30 scattered nodes");
  }
  const nodeIds = nodes.map((node) =>
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      node.resourceCode !== RESOURCE_WOOD ? RESOURCE_WOOD : node.resourceCode,
      node.amount * 40,
    ),
  );

  // Villagers spread around the depot, one per passable tile.
  const unitIds: number[] = [];
  for (let ring = 1; unitIds.length < VILLAGER_COUNT && ring < 24; ring++) {
    for (let dy = -ring; dy <= ring && unitIds.length < VILLAGER_COUNT; dy++) {
      for (
        let dx = -ring;
        dx <= ring && unitIds.length < VILLAGER_COUNT;
        dx++
      ) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = depotX + dx;
        const y = depotY + dy;
        if (
          x < 0 ||
          y < 0 ||
          x >= MAP_SIZE ||
          y >= MAP_SIZE ||
          layers.derivedPassability[y * MAP_SIZE + x] !== 1
        ) {
          continue;
        }
        unitIds.push(spawnUnit(world, comps, x + 0.5, y + 0.5));
      }
    }
  }
  if (unitIds.length !== VILLAGER_COUNT) {
    throw new Error(
      `budget scenario could only place ${String(unitIds.length)}/${String(VILLAGER_COUNT)} villagers`,
    );
  }

  // Gather orders: chunks of ten, round-robin across all nodes — every
  // villager keeps cycling walk/chop/haul for the whole run.
  const chunkSize = 10;
  for (let first = 0; first < VILLAGER_COUNT; first += chunkSize) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: {
        entityIds: unitIds.slice(first, first + chunkSize),
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

  // Mirror copy: reusable-frame captures, best-of-seven single shots
  // (best-of keeps scheduler/GC noise out of the budget claim).
  let frame = captureSimSnapshot(world, comps);
  captureSimSnapshot(world, comps, { reusable: frame });
  let mirrorCopyMs = Infinity;
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
    drawCallApprox: approximateDrawCalls(1), // M1 renders villagers only
  };
}

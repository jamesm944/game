/**
 * Gather-loop headless perf gate — SPEC §7 ("Sim tick ≤ 8 ms hard cap").
 *
 * Runs a real 120×120 seeded map with 100 villagers looping full
 * gather→deliver→repeat cycles against scattered nodes and one shared
 * depot — the §7 population scale, exercising movement steering, slot
 * claims, A*-costed drop-off selection and stockpile deposits every
 * tick. Warm-up absorbs the initial path-request storm; then 240
 * consecutive steps are individually timed and the p95 must stay under
 * the 8 ms hard-cap budget (headless Node, no GPU).
 */

import { describe, expect, it } from "vitest";
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
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { createGatherSystem } from "../../src/sim/systems/gather";
import { createMovementSystem } from "../../src/sim/systems/movement";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const MAP_SIZE = 120;
const GATHERER_COUNT = 100;
const NODE_COUNT = 40;
/** Ticks stepped before timing begins (JIT + initial path storm). */
const WARMUP_TICKS = 60;
/** Individually timed ticks feeding the p95 sample. */
const MEASURED_TICKS = 240;
/** SPEC §7 hard cap for one 30 Hz sim tick, in milliseconds. */
const TICK_BUDGET_MS = 8;

describe("gather loop perf (SPEC §7)", () => {
  it("keeps the 30 Hz sim tick under 8 ms with 100 looping gatherers", () => {
    const layers = generateMap(424242, MAP_SIZE);
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const world = createWorld(20260822, {
      layers,
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(world, createGatherSystem(comps, scheduler));

    // Depot + stockpile near the map center.
    const center = (MAP_SIZE - 1) / 2;
    let depotX = Math.floor(center);
    let depotY = Math.floor(center);
    outer: for (let radius = 0; radius < MAP_SIZE; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.floor(center) + dx;
          const y = Math.floor(center) + dy;
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

    const nodes = scatterResourceNodes(layers, 0x9e3779b9, {
      count: NODE_COUNT,
      minSpacing: 3,
    });
    const nodeIds = nodes.map((node) =>
      spawnResourceNode(
        world,
        comps,
        node.tileX,
        node.tileY,
        // Guarantee wood so every villager group has a valid target even
        // if grass-heavy terrain skews the scatter's resource mix.
        node.resourceCode !== RESOURCE_WOOD ? RESOURCE_WOOD : node.resourceCode,
        node.amount * 20,
      ),
    );

    // Villagers spread around the depot in a grid of passable tiles.
    const unitIds: number[] = [];
    for (let ring = 1; unitIds.length < GATHERER_COUNT && ring < 12; ring++) {
      for (
        let dy = -ring;
        dy <= ring && unitIds.length < GATHERER_COUNT;
        dy++
      ) {
        for (
          let dx = -ring;
          dx <= ring && unitIds.length < GATHERER_COUNT;
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
          // One villager per tile keeps spawns uncrowded.
          unitIds.push(spawnUnit(world, comps, x + 0.5, y + 0.5));
        }
      }
    }
    expect(unitIds.length).toBe(GATHERER_COUNT);

    // Ten gather orders, ten villagers each, round-robin across nodes.
    for (let chunk = 0; chunk < 10; chunk++) {
      world.inbox.submit({
        kind: "gather",
        targetTick: world.tick + 1,
        data: {
          entityIds: unitIds.slice(chunk * 10, chunk * 10 + 10),
          nodeId: nodeIds[chunk % nodeIds.length]!,
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
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    const mean =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;

    // Telemetry for manual review on regressions.
    console.log(
      `gather-loop ${String(GATHERER_COUNT)} gatherers: ` +
        `mean ${mean.toFixed(3)} ms · p95 ${p95!.toFixed(3)} ms · ` +
        `max ${samples[samples.length - 1]!.toFixed(3)} ms`,
    );
    expect(p95!).toBeLessThan(TICK_BUDGET_MS);
  });
});

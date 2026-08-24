/**
 * Pop-brain think budget — SPEC §2.3 / M3-T3 (issue #48 acceptance).
 *
 * The IAUS scorer amortizes by staggering: at 300 Pops and a 1 Hz
 * think interval only ~10 Pops re-evaluate per tick, each scanning the
 * live candidate tables once. This gate pins the contract at the
 * §2.3 envelope floor: mean brain time per tick over a 300-tick
 * measured window on a 300-Pop town must stay under 1 ms — with the
 * candidate set deliberately rich (60 nodes, 10 sites, 5 kitchens).
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnBuildingSite,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../src/sim/world/layers";
import { stampFinishedBuilding } from "../../src/sim/systems/placement";
import {
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../../src/sim/ai/popBrain";
import { THINK_INTERVAL_TICKS } from "../../src/sim/ai/popBrain";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

const POP_COUNT = 300;
const NODE_COUNT = 60;
const SITE_COUNT = 10;
const KITCHEN_COUNT = 5;
const SIZE = 120;
const MEASURED_TICKS = 300;

installSimPurityShims();

describe("pop brain budget", () => {
  it("amortizes under 1 ms/tick while thinking for 300 Pops", () => {
    const world = createWorld(20260906, {
      size: SIZE,
      layers: buildLayers(
        new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
        new Uint8Array(SIZE * SIZE),
      ),
    });
    const comps = defineSimComponents(world);
    const brain = createPopBrainDiagnostics();
    registerSystem(
      world,
      createPopBrainSystem({
        comps,
        players: [PLAYER_ONE],
        diagnostics: brain,
      }),
    );
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [5000, 5000, 1000, 0, 0, 0, 0],
    );

    for (let i = 0; i < NODE_COUNT; i++) {
      const tile = 20 + (i % 30);
      spawnResourceNode(
        world,
        comps,
        tile,
        20 + Math.floor(i / 30),
        i % 7,
        9999,
      );
    }
    for (let i = 0; i < SITE_COUNT; i++) {
      spawnBuildingSite(world, comps, "house", 20 + i * 3, 60, {
        playerId: PLAYER_ONE,
      });
    }
    for (let i = 0; i < KITCHEN_COUNT; i++) {
      stampFinishedBuilding(world, comps, "kitchen", 70 + i * 4, 60, {
        playerId: PLAYER_ONE,
      });
    }
    for (let i = 0; i < POP_COUNT; i++) {
      spawnUnit(world, comps, 12 + (i % 50), 12 + Math.floor(i / 50), {
        identity: true,
      });
    }

    // Warm-up absorbs JIT + the first assignment wave.
    for (let i = 0; i < 60; i++) step(world);

    const samples: number[] = [];
    for (let i = 0; i < MEASURED_TICKS; i++) {
      const start = performance.now();
      step(world);
      samples.push(performance.now() - start);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 =
      [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ??
      Number.POSITIVE_INFINITY;

    // The stagger actually spread the load…
    expect(brain.thinks).toBeGreaterThan(
      (POP_COUNT / THINK_INTERVAL_TICKS) * (MEASURED_TICKS - 1),
    );
    // …and every scored think stayed cheap in aggregate.
    expect(mean).toBeLessThan(1.0);
    expect(p95).toBeLessThan(4.0);

    console.log(
      `popbrain @${String(POP_COUNT)} pops: mean ${mean.toFixed(3)} ms/tick, ` +
        `p95 ${p95.toFixed(3)} ms/tick over ${String(MEASURED_TICKS)} ticks ` +
        `(${String(brain.thinks)} thinks, ${String(brain.gathers + brain.builds + brain.produces)} assignments)`,
    );
  }, 60_000);
});

/**
 * Training system tests — SPEC §2.6/§2.13 / M1-T10.
 *
 * A stamped town-center on a hand-authored grass grid proves: queue
 * timing lands on the EXACT trainTime tick boundary, spawns land on
 * free passable perimeter tiles scanning clockwise rings, unit costs
 * are escrowed at enqueue, the population cap blocks ENQUEUE at the
 * limit AND freezes in-flight heads while housed (AoE2 behavior), the
 * queue resumes the tick housing frees up, and the finite queue
 * capacity rejects overflow.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getBuildingRow,
  getPosition,
  populationCapOf,
  populationOf,
  readTrainQueue,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  TRAIN_VILLAGER_KIND,
  createTrainingSystem,
} from "../src/sim/systems/training";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 16;

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
}

function harness(food = 400): Harness {
  const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
  const world = createWorld(424242, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createTrainingSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE, [food, 900, 0, 0, 0, 0, 0]);
  return { world, comps };
}

/** Stamp a finished town-center (3×3) and return its entity id. */
function stampTC(h: Harness, tileX = 4, tileY = 4): number {
  return stampFinishedBuilding(h.world, h.comps, "town-center", tileX, tileY, {
    playerId: PLAYER_ONE,
  });
}

/** Submit one trainVillager order for the very next tick. */
function train(h: Harness): void {
  h.world.inbox.submit({
    kind: TRAIN_VILLAGER_KIND,
    targetTick: h.world.tick + 1,
    data: {},
  });
}

describe("training system", () => {
  it("produces a villager on the EXACT trainTime tick boundary", () => {
    const h = harness();
    const tc = stampTC(h);
    expect(getBuildingRow(h.world, h.comps, tc)).toBeDefined();
    expect(populationOf(h.world, h.comps)).toBe(0);

    train(h);
    step(h.world); // enqueue + first countdown tick
    expect(readTrainQueue(h.world, h.comps, tc)).toHaveLength(1);
    // Food escrowed at enqueue time (AoE2-faithful).
    const rows = h.world.rowsByComponentId.get(h.comps.stockpileId)!;
    for (const row of rows.values()) expect(row[1]).toBe(400 - 50);

    for (let i = 0; i < 748; i++) step(h.world);
    expect(populationOf(h.world, h.comps)).toBe(0); // 1 tick early: none

    step(h.world); // the 750th countdown tick spawns the villager
    expect(populationOf(h.world, h.comps)).toBe(1);
    expect(readTrainQueue(h.world, h.comps, tc)).toHaveLength(0);
  });

  it("spawns onto free passable perimeter tiles, never inside footprints", () => {
    const h = harness(600);
    stampTC(h);
    for (let n = 0; n < 3; n++) {
      train(h);
      for (let i = 0; i < 751; i++) step(h.world);
      const eid = h.world.entities.at(-1)!;
      const pos = getPosition(h.world, h.comps, eid);
      const tx = Math.floor(pos.x);
      const ty = Math.floor(pos.y);
      // On a passable tile…
      expect(h.world.layers.derivedPassability[ty * SIZE + tx]).toBe(1);
      // …strictly OUTSIDE the TC footprint (4..6, 4..6).
      const outside = tx < 4 || tx > 6 || ty < 4 || ty > 6;
      expect(outside).toBe(true);
      // Within the searched ring depth around the footprint.
      expect(tx).toBeGreaterThanOrEqual(4 - 3);
      expect(ty).toBeGreaterThanOrEqual(4 - 3);
      expect(tx).toBeLessThanOrEqual(6 + 3);
      expect(ty).toBeLessThanOrEqual(6 + 3);
    }
    expect(populationOf(h.world, h.comps)).toBe(3);
  });

  it("blocks enqueue at the population cap", () => {
    const h = harness();
    stampTC(h); // cap 5
    for (let i = 0; i < 5; i++) {
      spawnUnit(h.world, h.comps, 2.5, 2.5 + i * 0.3);
    }
    expect(populationOf(h.world, h.comps)).toBe(5);
    expect(populationCapOf(h.world, h.comps)).toBe(5);
    train(h);
    expect(() => step(h.world)).toThrow(/population 5\/5 at cap/);
  });

  it("freezes an in-flight head while housed and resumes when housing lands", () => {
    const h = harness();
    stampTC(h); // cap 5
    for (let i = 0; i < 4; i++) {
      spawnUnit(h.world, h.comps, 2.5, 2.5 + i * 0.3);
    }
    train(h); // pop 4 + queued 0 < 5: accepted
    step(h.world);
    const tc = 2;
    const before = readTrainQueue(h.world, h.comps, tc)[0]!.remainingTicks;

    // Fill the map to the cap: the head must FREEZE (AoE2 housed stall).
    spawnUnit(h.world, h.comps, 3.5, 12.5);
    const frozenAt = readTrainQueue(h.world, h.comps, tc)[0]!.remainingTicks;
    for (let i = 0; i < 100; i++) step(h.world);
    expect(readTrainQueue(h.world, h.comps, tc)[0]!.remainingTicks).toBe(
      frozenAt,
    );

    // Build a house: cap rises to 10 and production resumes instantly.
    stampFinishedBuilding(h.world, h.comps, "house", 9, 9, {
      playerId: PLAYER_ONE,
    });
    expect(populationCapOf(h.world, h.comps)).toBe(10);
    step(h.world);
    expect(readTrainQueue(h.world, h.comps, tc)[0]!.remainingTicks).toBe(
      frozenAt - 1,
    );
    void before;
  });

  it("rejects entries past the finite queue capacity", () => {
    const h = harness(2000);
    stampTC(h);
    stampFinishedBuilding(h.world, h.comps, "house", 9, 9, {
      playerId: PLAYER_ONE,
    });
    stampFinishedBuilding(h.world, h.comps, "house", 12, 9, {
      playerId: PLAYER_ONE,
    });
    stampFinishedBuilding(h.world, h.comps, "house", 9, 12, {
      playerId: PLAYER_ONE,
    });
    expect(populationCapOf(h.world, h.comps)).toBe(20);
    const tc = 2;
    for (let i = 0; i < 15; i++) {
      train(h);
      step(h.world);
    }
    expect(readTrainQueue(h.world, h.comps, tc)).toHaveLength(15);
    train(h);
    expect(() => step(h.world)).toThrow(/training queue full/);
  });
});

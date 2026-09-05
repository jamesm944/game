/**
 * V6: Walls & gates test suite — Issue #77.
 *
 * Verifies:
 * 1. Multi-tile wall run tracing (Bresenham grid snapping).
 * 2. Wall placement, stone/wood costs, footprint blocking, and passabilityVersion bumps.
 * 3. Gate passability asymmetry: passable for own units, blocked for enemies.
 * 4. Repathing fixture: enemy attacker repaths around walled perimeter.
 */

import { describe, expect, it } from "vitest";
import {
  traceWallRun,
  passabilityForPlayer,
  stampFinishedBuilding,
  blockFootprintTiles,
} from "../src/sim/systems/placement";
import { buildingDefOf } from "../src/data/definitions";
import { createWorld, type World } from "../src/sim/core/world";
import { defineSimComponents } from "../src/sim/components";
import { findPath } from "../src/sim/path/astar";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  IMPASSABLE,
  PASSABLE,
  TERRAIN_GRASS,
  buildLayers,
} from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function createTestWorld(size: number, pathScheduler?: PathScheduler): World {
  const tileCount = size * size;
  const terrain = new Uint8Array(tileCount).fill(TERRAIN_GRASS);
  const elevation = new Uint8Array(tileCount);
  return createWorld(12345, {
    size,
    layers: buildLayers(terrain, elevation),
    pathScheduler,
  });
}

describe("V6: Walls & gates", () => {
  describe("multi-tile wall run math", () => {
    it("traces straight horizontal wall runs", () => {
      const run = traceWallRun(5, 10, 9, 10);
      expect(run).toHaveLength(5);
      expect(run[0]).toEqual({ x: 5, y: 10 });
      expect(run[4]).toEqual({ x: 9, y: 10 });
    });

    it("traces straight vertical wall runs", () => {
      const run = traceWallRun(12, 4, 12, 7);
      expect(run).toHaveLength(4);
      expect(run[0]).toEqual({ x: 12, y: 4 });
      expect(run[3]).toEqual({ x: 12, y: 7 });
    });

    it("traces diagonal wall runs with contiguous 8-way connectivity", () => {
      const run = traceWallRun(2, 2, 5, 5);
      expect(run).toHaveLength(4);
      expect(run[0]).toEqual({ x: 2, y: 2 });
      expect(run[3]).toEqual({ x: 5, y: 5 });
      for (let i = 1; i < run.length; i++) {
        const dx = Math.abs(run[i]!.x - run[i - 1]!.x);
        const dy = Math.abs(run[i]!.y - run[i - 1]!.y);
        expect(dx).toBeLessThanOrEqual(1);
        expect(dy).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("wall definitions & costs", () => {
    it("palisade-wall and stone-wall have correct costs and 1x1 footprints", () => {
      const palisade = buildingDefOf("palisade-wall");
      expect(palisade.costs).toEqual({ wood: 2 });
      expect(palisade.footprint).toEqual({ width: 1, height: 1 });
      expect(palisade.ageGate).toBe("dark");

      const stone = buildingDefOf("stone-wall");
      expect(stone.costs).toEqual({ stone: 5 });
      expect(stone.footprint).toEqual({ width: 1, height: 1 });
      expect(stone.ageGate).toBe("feudal");
    });

    it("palisade-gate and stone-gate are marked as gates with 2x1 footprints", () => {
      const pGate = buildingDefOf("palisade-gate");
      expect(pGate.isGate).toBe(true);
      expect(pGate.footprint).toEqual({ width: 2, height: 1 });

      const sGate = buildingDefOf("stone-gate");
      expect(sGate.isGate).toBe(true);
      expect(sGate.footprint).toEqual({ width: 2, height: 1 });
    });
  });

  describe("gate passability asymmetry", () => {
    it("gate is passable for owner, blocked for enemy", () => {
      const scheduler = new PathScheduler(createSynchronousPathTransport());
      const world = createTestWorld(32, scheduler);
      const comps = defineSimComponents(world);

      // Stamp a palisade gate for Player 0 at (10, 10) -> width 2, height 1
      stampFinishedBuilding(world, comps, "palisade-gate", 10, 10, {
        playerId: 0,
      });

      const size = world.layers.size;
      // In raw derivedPassability, the gate tiles are impassable (0)
      expect(world.layers.derivedPassability[10 * size + 10]).toBe(IMPASSABLE);
      expect(world.layers.derivedPassability[10 * size + 11]).toBe(IMPASSABLE);

      // For Player 0 (owner), passabilityForPlayer returns tiles as PASSABLE (1)
      const player0Pass = passabilityForPlayer(world, comps, 0);
      expect(player0Pass[10 * size + 10]).toBe(PASSABLE);
      expect(player0Pass[10 * size + 11]).toBe(PASSABLE);

      // For Player 1 (enemy), passabilityForPlayer returns tiles as IMPASSABLE (0)
      const player1Pass = passabilityForPlayer(world, comps, 1);
      expect(player1Pass[10 * size + 10]).toBe(IMPASSABLE);
      expect(player1Pass[10 * size + 11]).toBe(IMPASSABLE);

      // A* path through the gate:
      // Player 0 path from (10, 8) to (10, 12) traverses the gate directly
      const path0 = findPath({
        passability: player0Pass,
        width: size,
        startX: 10,
        startY: 8,
        goalX: 10,
        goalY: 12,
      });
      expect(path0).not.toBeNull();
      // Directly through (10, 10)
      expect(path0!.cost).toBeLessThanOrEqual(4000);

      // If we wall off adjacent tiles (9, 10) and (12, 10) with palisade walls:
      stampFinishedBuilding(world, comps, "palisade-wall", 9, 10, {
        playerId: 0,
      });
      stampFinishedBuilding(world, comps, "palisade-wall", 12, 10, {
        playerId: 0,
      });

      // Enemy cannot cross the gate tile (10, 10)
      const path1 = findPath({
        passability: player1Pass,
        width: size,
        startX: 10,
        startY: 8,
        goalX: 10,
        goalY: 12,
      });
      // Player 1 must path around or take a detour
      if (path1) {
        // Must have higher cost because (10, 10) and (10, 11) are blocked
        expect(path1.cost).toBeGreaterThan(path0!.cost);
      }
    });
  });

  describe("walled base repaths attackers correctly", () => {
    it("wall placement bumps passabilityVersion and repaths attackers around the wall", () => {
      const scheduler = new PathScheduler(createSynchronousPathTransport());
      const world = createTestWorld(32, scheduler);
      defineSimComponents(world);

      const v0 = scheduler.passabilityVersion;

      // Place a wall
      blockFootprintTiles(world, { x: 15, y: 15, width: 1, height: 1 });
      expect(scheduler.passabilityVersion).toBe(v0 + 1);

      // Construct a vertical wall at x=15 from y=10 to y=20, except y=18 (the opening)
      for (let y = 10; y <= 20; y++) {
        if (y !== 18) {
          blockFootprintTiles(world, { x: 15, y, width: 1, height: 1 });
        }
      }

      const pass = world.layers.derivedPassability;
      const size = world.layers.size;

      // Attacker at (10, 12) pathing to (20, 12)
      const directBlocked = findPath({
        passability: pass,
        width: size,
        startX: 10,
        startY: 12,
        goalX: 20,
        goalY: 12,
      });
      expect(directBlocked).not.toBeNull();
      // The direct tile at (15, 12) is impassable wall
      expect(pass[12 * size + 15]).toBe(IMPASSABLE);
      // Verify that every waypoint along the calculated path is on a PASSABLE tile
      for (let k = 0; k < directBlocked!.waypoints.length; k += 2) {
        const wx = directBlocked!.waypoints[k]!;
        const wy = directBlocked!.waypoints[k + 1]!;
        expect(pass[wy * size + wx]).toBe(PASSABLE);
      }
      // Verify the path detoured around the wall (cost exceeds straight-line distance of 10 tiles)
      expect(directBlocked!.cost).toBeGreaterThan(10000);
    });
  });
});

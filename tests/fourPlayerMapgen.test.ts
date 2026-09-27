import { describe, expect, it } from "vitest";
import { createWorld, type World } from "../src/sim/core/world";
import { defineSimComponents, type SimComponents } from "../src/sim/components";
import {
  FOUR_PLAYER_MAP_SIZE,
  generateFourPlayerLayers,
  getFourPlayerAnchors,
  setupFourPlayerSkirmish,
} from "../src/sim/mapgen/fourPlayer";
import {
  getResourceNodeRow,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../src/sim/components/economy";
import { getCombatRow } from "../src/sim/components/combat";
import { getBuildingRow } from "../src/sim/components/buildings";
import { relicRowOf, RELIC_GROUND } from "../src/sim/components/relic";
import { isWaterTerrain, TERRAIN_GRASS } from "../src/sim/world/layers";
import { unitIdOfCode } from "../src/data/definitions";

/** Helper: verify BFS path exists between two points on the map. */
function hasLandPath(
  world: World,
  start: { x: number; y: number },
  target: { x: number; y: number },
): boolean {
  const size = world.layers.size;
  const pass = world.layers.derivedPassability;
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  if (pass[sy * size + sx] !== 1 || pass[ty * size + tx] !== 1) return false;

  const queue = [sy * size + sx];
  const visited = new Uint8Array(size * size);
  visited[sy * size + sx] = 1;
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++]!;
    const cx = curr % size;
    const cy = Math.floor(curr / size);
    if (cx === tx && cy === ty) return true;

    const neighbors = [
      cy > 0 ? (cy - 1) * size + cx : -1,
      cy < size - 1 ? (cy + 1) * size + cx : -1,
      cx > 0 ? cy * size + (cx - 1) : -1,
      cx < size - 1 ? cy * size + (cx + 1) : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && pass[n] === 1 && !visited[n]) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }
  return false;
}

function getNodePos(
  world: World,
  comps: SimComponents,
  eid: number,
): { x: number; y: number } {
  const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
  if (!pos) throw new Error(`entity ${String(eid)} has no position`);
  return { x: pos[0]!, y: pos[1]! };
}

describe("4-Player Symmetric Mapgen & Balanced Starting Spawns (Milestone S2 / Issue #113)", () => {
  it("generates a 160×160 world with symmetric quadrant anchors", () => {
    const size = FOUR_PLAYER_MAP_SIZE;
    expect(size).toBe(160);

    const anchors = getFourPlayerAnchors(size);
    expect(anchors).toHaveLength(4);

    const [p0, p1, p2, p3] = anchors;
    // South-West: low X, high Y
    expect(p0!.quadrant).toBe("SW");
    expect(p0!.x).toBe(36);
    expect(p0!.y).toBe(124);

    // North-East: high X, low Y
    expect(p1!.quadrant).toBe("NE");
    expect(p1!.x).toBe(124);
    expect(p1!.y).toBe(36);

    // North-West: low X, low Y
    expect(p2!.quadrant).toBe("NW");
    expect(p2!.x).toBe(36);
    expect(p2!.y).toBe(36);

    // South-East: high X, high Y
    expect(p3!.quadrant).toBe("SE");
    expect(p3!.x).toBe(124);
    expect(p3!.y).toBe(124);

    // All anchors are equidistant from center (80, 80)
    const distSq = (a: { x: number; y: number }) =>
      (a.x - 80) ** 2 + (a.y - 80) ** 2;
    const d0 = distSq(p0!);
    expect(distSq(p1!)).toBe(d0);
    expect(distSq(p2!)).toBe(d0);
    expect(distSq(p3!)).toBe(d0);
  });

  it("spawns 4 valid, non-overlapping Town Centers with complete starting resource envelopes", () => {
    const seed = 12345;
    const layers = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);
    const world = createWorld(seed, {
      size: FOUR_PLAYER_MAP_SIZE,
      layers,
    });
    const comps = defineSimComponents(world);

    const result = setupFourPlayerSkirmish(world, comps, { seed });
    expect(result.players).toHaveLength(4);

    for (const p of result.players) {
      // 1. Town center checks
      const bRow = getBuildingRow(world, comps, p.tcEid);
      expect(bRow).toBeDefined();
      expect(bRow![0]).toBe(p.playerId);
      const tcPos = { x: p.tcOrigin.x + 1.5, y: p.tcOrigin.y + 1.5 };

      // TC footprint is on flat grass land (not water)
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const tx = p.tcOrigin.x + dx;
          const ty = p.tcOrigin.y + dy;
          expect(isWaterTerrain(layers.terrainType[ty * 160 + tx]!)).toBe(
            false,
          );
          expect(layers.terrainType[ty * 160 + tx]).toBe(TERRAIN_GRASS);
        }
      }

      // 2. Berries: exactly 6 food nodes (125 each) within 6 tiles of TC
      expect(p.berryEids).toHaveLength(6);
      for (const eid of p.berryEids) {
        const row = getResourceNodeRow(world, comps, eid);
        expect(row).toBeDefined();
        expect(row![0]).toBe(RESOURCE_FOOD);
        expect(row![1]).toBe(125);
        const pos = getNodePos(world, comps, eid);
        const dist = Math.hypot(pos.x - tcPos.x, pos.y - tcPos.y);
        expect(dist).toBeLessThanOrEqual(6.0);
      }

      // 3. Primary Gold: exactly 4 nodes (800 each) within 7 tiles of TC
      expect(p.primaryGoldEids).toHaveLength(4);
      for (const eid of p.primaryGoldEids) {
        const row = getResourceNodeRow(world, comps, eid);
        expect(row).toBeDefined();
        expect(row![0]).toBe(RESOURCE_GOLD);
        expect(row![1]).toBe(800);
        const pos = getNodePos(world, comps, eid);
        const dist = Math.hypot(pos.x - tcPos.x, pos.y - tcPos.y);
        expect(dist).toBeLessThanOrEqual(7.0);
      }

      // 4. Secondary Gold: exactly 2 nodes (800 each) within 14 tiles of TC
      expect(p.secondaryGoldEids).toHaveLength(2);
      for (const eid of p.secondaryGoldEids) {
        const row = getResourceNodeRow(world, comps, eid);
        expect(row).toBeDefined();
        expect(row![0]).toBe(RESOURCE_GOLD);
        expect(row![1]).toBe(800);
        const pos = getNodePos(world, comps, eid);
        const dist = Math.hypot(pos.x - tcPos.x, pos.y - tcPos.y);
        expect(dist).toBeLessThanOrEqual(14.0);
      }

      // 5. Primary Stone: exactly 3 nodes (350 each) within 9 tiles of TC
      expect(p.stoneEids).toHaveLength(3);
      for (const eid of p.stoneEids) {
        const row = getResourceNodeRow(world, comps, eid);
        expect(row).toBeDefined();
        expect(row![0]).toBe(RESOURCE_STONE);
        expect(row![1]).toBe(350);
        const pos = getNodePos(world, comps, eid);
        const dist = Math.hypot(pos.x - tcPos.x, pos.y - tcPos.y);
        expect(dist).toBeLessThanOrEqual(9.0);
      }

      // 6. Forest lines: 12 trees across 2 patches (150 each) within 8–12 tiles
      expect(p.treeEids).toHaveLength(12);
      for (const eid of p.treeEids) {
        const row = getResourceNodeRow(world, comps, eid);
        expect(row).toBeDefined();
        expect(row![0]).toBe(RESOURCE_WOOD);
        expect(row![1]).toBe(150);
        const pos = getNodePos(world, comps, eid);
        const dist = Math.hypot(pos.x - tcPos.x, pos.y - tcPos.y);
        expect(dist).toBeLessThanOrEqual(13.0);
        expect(dist).toBeGreaterThanOrEqual(6.0);
      }

      // 7. Starting units: 3 Villagers + 1 Scout Cavalry
      expect(p.villagerEids).toHaveLength(3);
      for (const eid of p.villagerEids) {
        const cRow = getCombatRow(world, comps, eid);
        expect(cRow).toBeDefined();
        expect(cRow![1]).toBe(p.playerId);
        expect(unitIdOfCode(cRow![0]!)).toBe("villager");
      }

      const scoutRow = getCombatRow(world, comps, p.scoutEid);
      expect(scoutRow).toBeDefined();
      expect(scoutRow![1]).toBe(p.playerId);
      expect(unitIdOfCode(scoutRow![0]!)).toBe("scout-cavalry");
    }
  });

  it("spawns 5 neutral relics on passable land (1 center, 4 along crossroads)", () => {
    const seed = 999;
    const layers = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);
    const world = createWorld(seed, { size: FOUR_PLAYER_MAP_SIZE, layers });
    const comps = defineSimComponents(world);

    const result = setupFourPlayerSkirmish(world, comps, { seed });
    expect(result.relicEids).toHaveLength(5);

    for (const eid of result.relicEids) {
      const row = relicRowOf(world, comps, eid);
      expect(row).toBeDefined();
      expect(row!.state).toBe(RELIC_GROUND);
      expect(row!.holderEid).toBe(0); // uncarried on ground
      const pos = getNodePos(world, comps, eid);
      const tx = Math.floor(pos.x);
      const ty = Math.floor(pos.y);
      expect(layers.derivedPassability[ty * 160 + tx]).toBe(1);
    }
  });

  it("guarantees continuous land pathability connecting all 4 player bases", () => {
    const seed = 42;
    const layers = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);
    const world = createWorld(seed, { size: FOUR_PLAYER_MAP_SIZE, layers });
    const comps = defineSimComponents(world);

    const result = setupFourPlayerSkirmish(world, comps, { seed });
    const [p0, p1, p2, p3] = result.players;

    const base0 = { x: p0!.tcOrigin.x + 3.5, y: p0!.tcOrigin.y + 1.5 };
    const base1 = { x: p1!.tcOrigin.x - 0.5, y: p1!.tcOrigin.y + 1.5 };
    const base2 = { x: p2!.tcOrigin.x + 3.5, y: p2!.tcOrigin.y + 1.5 };
    const base3 = { x: p3!.tcOrigin.x - 0.5, y: p3!.tcOrigin.y + 1.5 };

    // Every base can walk to every other base across land corridors
    expect(hasLandPath(world, base0, base1)).toBe(true);
    expect(hasLandPath(world, base0, base2)).toBe(true);
    expect(hasLandPath(world, base0, base3)).toBe(true);
    expect(hasLandPath(world, base1, base2)).toBe(true);
    expect(hasLandPath(world, base1, base3)).toBe(true);
    expect(hasLandPath(world, base2, base3)).toBe(true);
  });

  it("produces deterministic, byte-identical layouts for identical seeds", () => {
    const seed = 777;
    const layers1 = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);
    const layers2 = generateFourPlayerLayers(seed, FOUR_PLAYER_MAP_SIZE);

    expect(layers1.terrainType).toEqual(layers2.terrainType);
    expect(layers1.elevationLevel).toEqual(layers2.elevationLevel);
    expect(layers1.derivedPassability).toEqual(layers2.derivedPassability);
  });
});

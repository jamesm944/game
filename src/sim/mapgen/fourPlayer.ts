/**
 * 4-Player Skirmish Map Generation & Balanced Starting Spawns — Milestone S2 (Issue #113).
 *
 * Implements 160×160 4-quadrant symmetric world generation with guaranteed
 * starting resource envelopes and fair pathability connecting all 4 players:
 *
 * 1. 160×160 World Dimension:
 *    - Equidistant base anchors from map center (Cx = 80, Cy = 80):
 *      - Player 0 (Blue): South-West quadrant (36, 124)
 *      - Player 1 (Red): North-East quadrant (124, 36)
 *      - Player 2 (Green): North-West quadrant (36, 36)
 *      - Player 3 (Yellow): South-East quadrant (124, 124)
 *
 * 2. Guaranteed Local Starting Resource Envelope per Player:
 *    - 1 Town Center (3×3 footprint on flat, cleared terrain).
 *    - 1 Berry bush cluster (6 nodes, 125 food each) within 6 tiles of TC.
 *    - 1 Primary Gold deposit (4 nodes, 800 gold each) within 7 tiles of TC.
 *    - 1 Secondary Gold deposit (2 nodes, 800 gold each) within 14 tiles of TC.
 *    - 1 Primary Stone deposit (3 nodes, 350 stone each) within 9 tiles of TC.
 *    - 2 distinct Forest lines (6 trees each, 150 wood each) within 8–12 tiles of TC.
 *    - Starting units: 3 Villagers + 1 Scout Cavalry placed at the base perimeter.
 *
 * 3. Central Contestable Territory & Neutral Relics:
 *    - 5 Sacred Relics placed neutrally (1 at center, 4 along cardinal crossroads).
 *    - Guaranteed land connectivity connecting all 4 bases to the center.
 */

import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { createPrng } from "../core/prng";
import {
  buildLayers,
  isWaterTerrain,
  MAX_ELEVATION_LEVEL,
  TERRAIN_DEEP_WATER,
  TERRAIN_DIRT,
  TERRAIN_FOREST_FLOOR,
  TERRAIN_GRASS,
  TERRAIN_SHORE,
  TERRAIN_WATER,
  type WorldLayers,
} from "../world/layers";
import {
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_WOOD,
  spawnResourceNode,
} from "../components/economy";
import { stampFinishedBuilding } from "../systems/placement";
import { spawnCombatUnit } from "../components/combat";
import { spawnRelic } from "../components/relic";
import { createPlayerStockpile } from "../core/stockpile";
import { createPlayerAgeState } from "../components/age";
import { createDiplomacyMatrix, type DiplomacyMatrix } from "../core/diplomacy";
import { setPlayerCivilization } from "../core/civilization";
import type { SimComponents } from "../components";
import type { World } from "../core/world";

/** Default dimension for 4-player skirmish maps (160×160 = 25,600 tiles). */
export const FOUR_PLAYER_MAP_SIZE = 160;

/** Default starting resources per player (standard AoE2 skirmish bank). */
export const FOUR_PLAYER_STARTING_RESOURCES: readonly number[] = [
  200, // Food
  200, // Wood
  100, // Gold
  200, // Stone
  0, // Iron
  0, // Coal
  0, // Clay
];

/** Default 4-player asymmetric civilization assignment across players 0..3 (Milestone C1 / #118). */
export const DEFAULT_FOUR_PLAYER_CIVS: readonly string[] = [
  "britons",
  "franks",
  "goths",
  "byzantines",
];

/** Base anchor coordinates for 4 players in a 160×160 grid. */
export interface BaseAnchor {
  readonly playerId: number;
  readonly quadrant: "SW" | "NE" | "NW" | "SE";
  readonly x: number;
  readonly y: number;
  /** Angle in radians pointing towards the map center (80, 80). */
  readonly centerAngle: number;
}

/** Compute symmetric quadrant anchors for a given map dimension. */
export function getFourPlayerAnchors(
  size = FOUR_PLAYER_MAP_SIZE,
): readonly BaseAnchor[] {
  const low = Math.round(size * 0.225);
  const high = Math.round(size * 0.775);
  const cx = size / 2;
  const cy = size / 2;

  const anchors = [
    { playerId: 0, quadrant: "SW" as const, x: low, y: high },
    { playerId: 1, quadrant: "NE" as const, x: high, y: low },
    { playerId: 2, quadrant: "NW" as const, x: low, y: low },
    { playerId: 3, quadrant: "SE" as const, x: high, y: high },
  ];

  return anchors.map((a) => ({
    ...a,
    centerAngle: Math.atan2(cy - (a.y + 1.5), cx - (a.x + 1.5)),
  }));
}

export interface PlayerSpawnRecord {
  readonly playerId: number;
  readonly civId?: string | undefined;
  readonly tcEid: number;
  readonly tcOrigin: { readonly x: number; readonly y: number };
  readonly villagerEids: readonly number[];
  readonly scoutEid: number;
  readonly berryEids: readonly number[];
  readonly primaryGoldEids: readonly number[];
  readonly secondaryGoldEids: readonly number[];
  readonly stoneEids: readonly number[];
  readonly treeEids: readonly number[];
}

export type FourPlayerMapPreset =
  "continental" | "coastal" | "archipelago" | "islands";

export interface FourPlayerSetupResult {
  readonly diplomacy: DiplomacyMatrix;
  readonly players: readonly PlayerSpawnRecord[];
  readonly relicEids: readonly number[];
  readonly fishEids: readonly number[];
}

export interface FourPlayerSkirmishOptions {
  readonly size?: number | undefined;
  readonly seed?: number | undefined;
  readonly mode?: "ffa" | "teams" | undefined;
  readonly startingResources?: readonly number[] | undefined;
  readonly spawnRelics?: boolean | undefined;
  readonly preset?: FourPlayerMapPreset | undefined;
  readonly spawnFish?: boolean | undefined;
  readonly isIslandMap?: boolean | undefined;
  readonly civilizations?:
    ReadonlyMap<number, string> | Readonly<Record<number, string>> | undefined;
}

export type FourPlayerMapOptions = FourPlayerSkirmishOptions;

/**
 * Convenience generator for a 4-player island map layout (Issue #115).
 */
export function generateIslandLayers(
  seed: number,
  size: number = FOUR_PLAYER_MAP_SIZE,
): WorldLayers {
  return generateFourPlayerLayers(seed, size, "islands");
}

/**
 * Generate a 160×160 (or custom size) balanced 4-player skirmish map.
 * Ensures flat, cleared ground around each starting base. Supports
 * continental, coastal, archipelago, and islands terrain presets.
 */
export function generateFourPlayerLayers(
  seed: number,
  size: number = FOUR_PLAYER_MAP_SIZE,
  preset: FourPlayerMapPreset = "continental",
): WorldLayers {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`mapgen seed must be a u32 integer, got ${String(seed)}`);
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `mapgen size must be a positive integer, got ${String(size)}`,
    );
  }

  const prng = createPrng(seed);
  const draw = () => prng.nextFloat();

  const terrainNoises: NoiseFunction2D[] = [];
  for (let i = 0; i < 4; i++) terrainNoises.push(createNoise2D(draw));
  const elevationNoises: NoiseFunction2D[] = [];
  for (let i = 0; i < 3; i++) elevationNoises.push(createNoise2D(draw));

  const tileCount = size * size;
  const terrainType = new Uint8Array(tileCount);
  const elevationLevel = new Uint8Array(tileCount);
  const center = (size - 1) / 2;

  if (preset === "islands") {
    // 1. Open ocean background: deep water in central/distant ocean, water elsewhere
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const tx = (x - center) / 18;
        const ty = (y - center) / 18;
        const val = terrainNoises[0]!(tx, ty);
        terrainType[idx] = val < 0 ? TERRAIN_DEEP_WATER : TERRAIN_WATER;
        elevationLevel[idx] = 0;
      }
    }

    const anchors = getFourPlayerAnchors(size);

    // 2. Player home islands (radius 24 around each anchor)
    const islandRadius = 24;
    for (const anchor of anchors) {
      const ax = anchor.x + 1.5;
      const ay = anchor.y + 1.5;
      for (let dy = -islandRadius; dy <= islandRadius; dy++) {
        for (let dx = -islandRadius; dx <= islandRadius; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist > islandRadius) continue;
          const tx = Math.floor(ax + dx);
          const ty = Math.floor(ay + dy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;

          if (dist <= 16) {
            // Core base area: flat grass
            terrainType[idx] = TERRAIN_GRASS;
            elevationLevel[idx] = 1;
          } else if (dist <= 20) {
            // Island perimeter: grass/dirt
            const nVal = terrainNoises[0]!(tx / 10, ty / 10);
            terrainType[idx] = nVal < 0.2 ? TERRAIN_GRASS : TERRAIN_DIRT;
            elevationLevel[idx] = 1;
          } else if (dist <= 23) {
            // Shoreline
            terrainType[idx] = TERRAIN_SHORE;
            elevationLevel[idx] = 0;
          } else {
            terrainType[idx] = TERRAIN_WATER;
            elevationLevel[idx] = 0;
          }
        }
      }
    }

    // 3. Central relic islet (radius 10 around center)
    const cx = size / 2;
    const cy = size / 2;
    const centerRadius = 10;
    for (let dy = -centerRadius; dy <= centerRadius; dy++) {
      for (let dx = -centerRadius; dx <= centerRadius; dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist > centerRadius) continue;
        const tx = Math.floor(cx + dx);
        const ty = Math.floor(cy + dy);
        if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
        const idx = ty * size + tx;
        if (dist <= 7) {
          terrainType[idx] = TERRAIN_GRASS;
          elevationLevel[idx] = 1;
        } else if (dist <= 9) {
          terrainType[idx] = TERRAIN_SHORE;
          elevationLevel[idx] = 0;
        }
      }
    }

    // 4. Neutral islets at the 4 cardinal positions for relics
    const cardinalPositions = [
      { x: cx, y: cy - 32 },
      { x: cx, y: cy + 32 },
      { x: cx - 32, y: cy },
      { x: cx + 32, y: cy },
    ];
    for (const cpos of cardinalPositions) {
      const cRadius = 6;
      for (let dy = -cRadius; dy <= cRadius; dy++) {
        for (let dx = -cRadius; dx <= cRadius; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist > cRadius) continue;
          const tx = Math.floor(cpos.x + dx);
          const ty = Math.floor(cpos.y + dy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;
          if (dist <= 4) {
            terrainType[idx] = TERRAIN_GRASS;
            elevationLevel[idx] = 1;
          } else {
            terrainType[idx] = TERRAIN_SHORE;
            elevationLevel[idx] = 0;
          }
        }
      }
    }

    return buildLayers(terrainType, elevationLevel);
  }

  if (preset === "coastal") {
    // 1. Base procedural terrain from simplex noise
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const tx = (x - center) / 18;
        const ty = (y - center) / 18;
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let norm = 0;
        for (const n of terrainNoises) {
          sum += n(tx * freq, ty * freq) * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        const val = sum / norm;
        if (val < -0.3) terrainType[idx] = TERRAIN_SHORE;
        else if (val < 0.3) terrainType[idx] = TERRAIN_GRASS;
        else if (val < 0.55) terrainType[idx] = TERRAIN_DIRT;
        else terrainType[idx] = TERRAIN_FOREST_FLOOR;
        elevationLevel[idx] = 1;
      }
    }

    const cx = size / 2;
    const cy = size / 2;

    // 2. Large central sea (radius 40 around cx, cy)
    const seaRadius = 40;
    for (let dy = -seaRadius - 4; dy <= seaRadius + 4; dy++) {
      for (let dx = -seaRadius - 4; dx <= seaRadius + 4; dx++) {
        const dist = Math.hypot(dx, dy);
        const tx = Math.floor(cx + dx);
        const ty = Math.floor(cy + dy);
        if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
        const idx = ty * size + tx;
        if (dist <= seaRadius - 12) {
          terrainType[idx] = TERRAIN_DEEP_WATER;
          elevationLevel[idx] = 0;
        } else if (dist <= seaRadius) {
          terrainType[idx] = TERRAIN_WATER;
          elevationLevel[idx] = 0;
        } else if (dist <= seaRadius + 3) {
          terrainType[idx] = TERRAIN_SHORE;
          elevationLevel[idx] = 0;
        }
      }
    }

    const anchors = getFourPlayerAnchors(size);

    // 3. Clear base areas (radius 16 land around each anchor)
    for (const anchor of anchors) {
      const ax = anchor.x + 1.5;
      const ay = anchor.y + 1.5;
      const baseRadius = 16;
      for (let dy = -baseRadius; dy <= baseRadius; dy++) {
        for (let dx = -baseRadius; dx <= baseRadius; dx++) {
          const distSq = dx * dx + dy * dy;
          if (distSq > baseRadius * baseRadius) continue;
          const tx = Math.floor(ax + dx);
          const ty = Math.floor(ay + dy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;
          terrainType[idx] = TERRAIN_GRASS;
          elevationLevel[idx] = 1;
        }
      }
    }

    // 4. Perimeter land corridors connecting adjacent bases (SW-NW, NW-NE, NE-SE, SE-SW)
    const perimeterPairs = [
      [anchors[0]!, anchors[2]!], // SW to NW
      [anchors[2]!, anchors[1]!], // NW to NE
      [anchors[1]!, anchors[3]!], // NE to SE
      [anchors[3]!, anchors[0]!], // SE to SW
    ];
    for (const [a1, a2] of perimeterPairs) {
      if (!a1 || !a2) continue;
      const ax1 = a1.x + 1.5;
      const ay1 = a1.y + 1.5;
      const ax2 = a2.x + 1.5;
      const ay2 = a2.y + 1.5;
      const steps = 80;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax1 + (ax2 - ax1) * t;
        const py = ay1 + (ay2 - ay1) * t;
        const halfWidth = 5;
        for (let cdy = -halfWidth; cdy <= halfWidth; cdy++) {
          for (let cdx = -halfWidth; cdx <= halfWidth; cdx++) {
            const tx = Math.floor(px + cdx);
            const ty = Math.floor(py + cdy);
            if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
            const idx = ty * size + tx;
            if (isWaterTerrain(terrainType[idx]!)) {
              terrainType[idx] = TERRAIN_GRASS;
            }
            elevationLevel[idx] = 1;
          }
        }
      }
    }

    return buildLayers(terrainType, elevationLevel);
  }

  if (preset === "archipelago") {
    // 1. Water background
    for (let idx = 0; idx < tileCount; idx++) {
      terrainType[idx] = TERRAIN_WATER;
      elevationLevel[idx] = 0;
    }

    const anchors = getFourPlayerAnchors(size);

    // 2. 4 Home islands around anchors (radius 20)
    for (const anchor of anchors) {
      const ax = anchor.x + 1.5;
      const ay = anchor.y + 1.5;
      const iRadius = 20;
      for (let dy = -iRadius; dy <= iRadius; dy++) {
        for (let dx = -iRadius; dx <= iRadius; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist > iRadius) continue;
          const tx = Math.floor(ax + dx);
          const ty = Math.floor(ay + dy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;
          if (dist <= 15) {
            terrainType[idx] = TERRAIN_GRASS;
            elevationLevel[idx] = 1;
          } else if (dist <= 18) {
            terrainType[idx] = TERRAIN_DIRT;
            elevationLevel[idx] = 1;
          } else {
            terrainType[idx] = TERRAIN_SHORE;
            elevationLevel[idx] = 0;
          }
        }
      }
    }

    const cx = size / 2;
    const cy = size / 2;

    // 3. Intermediate neutral islets at cardinals and center
    const islets = [
      { x: cx, y: cy, r: 12 },
      { x: cx, y: cy - 35, r: 8 },
      { x: cx, y: cy + 35, r: 8 },
      { x: cx - 35, y: cy, r: 8 },
      { x: cx + 35, y: cy, r: 8 },
    ];
    for (const isl of islets) {
      for (let dy = -isl.r; dy <= isl.r; dy++) {
        for (let dx = -isl.r; dx <= isl.r; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist > isl.r) continue;
          const tx = Math.floor(isl.x + dx);
          const ty = Math.floor(isl.y + dy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;
          if (dist <= isl.r - 3) {
            terrainType[idx] = TERRAIN_GRASS;
            elevationLevel[idx] = 1;
          } else {
            terrainType[idx] = TERRAIN_SHORE;
            elevationLevel[idx] = 0;
          }
        }
      }
    }

    return buildLayers(terrainType, elevationLevel);
  }

  // Base procedural terrain & elevation (continental preset)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const tx = (x - center) / 18;
      const ty = (y - center) / 18;
      let sum = 0;
      let amp = 1;
      let freq = 1;
      let norm = 0;
      for (const n of terrainNoises) {
        sum += n(tx * freq, ty * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      const val = sum / norm;
      if (val < -0.45) terrainType[idx] = TERRAIN_SHORE;
      else if (val < 0.25) terrainType[idx] = TERRAIN_GRASS;
      else if (val < 0.5) terrainType[idx] = TERRAIN_DIRT;
      else terrainType[idx] = TERRAIN_FOREST_FLOOR;

      const ex = (x - center) / 26;
      const ey = (y - center) / 26;
      let eSum = 0;
      let eAmp = 1;
      let eFreq = 1;
      let eNorm = 0;
      for (const n of elevationNoises) {
        eSum += n(ex * eFreq, ey * eFreq) * eAmp;
        eNorm += eAmp;
        eAmp *= 0.5;
        eFreq *= 2;
      }
      const eVal = Math.round((eSum / eNorm + 1) * (MAX_ELEVATION_LEVEL / 2));
      elevationLevel[idx] = Math.min(MAX_ELEVATION_LEVEL, Math.max(0, eVal));
    }
  }

  const anchors = getFourPlayerAnchors(size);

  // 1. Clear each player's starting base area (radius 16) to flat, clear land
  for (const anchor of anchors) {
    const ax = anchor.x + 1.5;
    const ay = anchor.y + 1.5;
    const baseRadius = 16;
    for (let dy = -baseRadius; dy <= baseRadius; dy++) {
      for (let dx = -baseRadius; dx <= baseRadius; dx++) {
        const distSq = dx * dx + dy * dy;
        if (distSq > baseRadius * baseRadius) continue;
        const tx = Math.floor(ax + dx);
        const ty = Math.floor(ay + dy);
        if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
        const idx = ty * size + tx;

        // Immediate base center (radius 6) is clean grass for TC and immediate resources
        if (distSq <= 36) {
          terrainType[idx] = TERRAIN_GRASS;
        } else if (isWaterTerrain(terrainType[idx]!)) {
          terrainType[idx] = TERRAIN_GRASS;
        }
        // Smooth elevation around base to level 1 to avoid cliffs blocking buildings
        elevationLevel[idx] = 1;
      }
    }
  }

  // 2. Clear central contestable arena (radius 20) around (cx, cy)
  const cx = size / 2;
  const cy = size / 2;
  const centerRadius = 20;
  for (let dy = -centerRadius; dy <= centerRadius; dy++) {
    for (let dx = -centerRadius; dx <= centerRadius; dx++) {
      const distSq = dx * dx + dy * dy;
      if (distSq > centerRadius * centerRadius) continue;
      const tx = Math.floor(cx + dx);
      const ty = Math.floor(cy + dy);
      if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
      const idx = ty * size + tx;
      if (isWaterTerrain(terrainType[idx]!)) {
        terrainType[idx] = TERRAIN_GRASS;
      }
      elevationLevel[idx] = 1;
    }
  }

  // 3. Clear wide land corridors (width 8) connecting each base anchor to the center
  for (const anchor of anchors) {
    const ax = anchor.x + 1.5;
    const ay = anchor.y + 1.5;
    const steps = 100;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + (cx - ax) * t;
      const py = ay + (cy - ay) * t;
      const corridorWidth = 4; // half-width
      for (let cdy = -corridorWidth; cdy <= corridorWidth; cdy++) {
        for (let cdx = -corridorWidth; cdx <= corridorWidth; cdx++) {
          const tx = Math.floor(px + cdx);
          const ty = Math.floor(py + cdy);
          if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) continue;
          const idx = ty * size + tx;
          if (isWaterTerrain(terrainType[idx]!)) {
            terrainType[idx] = TERRAIN_GRASS;
          }
          elevationLevel[idx] = 1;
        }
      }
    }
  }

  return buildLayers(terrainType, elevationLevel);
}

/**
 * Setup a complete 4-player skirmish match:
 * - 4 isolated player stockpiles & age states
 * - 4-player diplomacy matrix (FFA or 2v2 Teams)
 * - 4 symmetric Town Centers
 * - Complete guaranteed starting resource envelopes (Berries, Gold, Stone, Trees)
 * - 3 Villagers + 1 Scout Cavalry per player
 * - 5 Neutral Sacred Relics
 */
export function setupFourPlayerSkirmish(
  world: World,
  comps: SimComponents,
  options: FourPlayerSkirmishOptions = {},
): FourPlayerSetupResult {
  const size = world.layers.size;
  const diplomacy = createDiplomacyMatrix(4, options.mode ?? "ffa");
  const startingResources =
    options.startingResources ?? FOUR_PLAYER_STARTING_RESOURCES;
  const anchors = getFourPlayerAnchors(size);

  const players: PlayerSpawnRecord[] = [];
  const occupiedTiles = new Set<number>();

  const isFreeTile = (tx: number, ty: number): boolean => {
    if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) return false;
    const idx = ty * size + tx;
    if (occupiedTiles.has(idx)) return false;
    if (world.layers.derivedPassability[idx] !== 1) return false;
    return true;
  };

  const occupy = (tx: number, ty: number) => {
    occupiedTiles.add(ty * size + tx);
  };

  // Helper to place a cluster of resource nodes near a target anchor
  const placeCluster = (
    centerX: number,
    centerY: number,
    resourceCode: number,
    amount: number,
    count: number,
    tcCenter: { x: number; y: number },
    maxDistFromTc?: number,
  ): number[] => {
    const eids: number[] = [];
    const candidates: { x: number; y: number; d2: number }[] = [];
    const maxR = 6;
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = Math.floor(centerX) + dx;
          const ty = Math.floor(centerY) + dy;
          if (!isFreeTile(tx, ty)) continue;
          const distToTc = Math.hypot(
            tx + 0.5 - tcCenter.x,
            ty + 0.5 - tcCenter.y,
          );
          if (maxDistFromTc !== undefined && distToTc > maxDistFromTc) continue;
          const distToCenter = dx * dx + dy * dy;
          candidates.push({ x: tx, y: ty, d2: distToCenter });
        }
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    for (const c of candidates) {
      if (eids.length >= count) break;
      if (!isFreeTile(c.x, c.y)) continue;
      occupy(c.x, c.y);
      const eid = spawnResourceNode(
        world,
        comps,
        c.x,
        c.y,
        resourceCode,
        amount,
      );
      eids.push(eid);
    }
    return eids;
  };

  // Process all 4 players symmetrically
  for (const anchor of anchors) {
    const { playerId, centerAngle } = anchor;

    // 0. Civilization assignment
    let civId: string | undefined;
    if (options.civilizations instanceof Map) {
      civId = options.civilizations.get(playerId);
    } else if (options.civilizations) {
      civId = (options.civilizations as Record<number, string>)[playerId];
    }
    if (!civId) {
      civId =
        DEFAULT_FOUR_PLAYER_CIVS[playerId % DEFAULT_FOUR_PLAYER_CIVS.length]!;
    }
    setPlayerCivilization(world, playerId, civId);

    // 1. Stockpile and Age
    createPlayerStockpile(world, comps, playerId, [...startingResources]);
    createPlayerAgeState(world, comps, playerId);

    // 2. Town Center (3×3 footprint)
    const tcX = anchor.x;
    const tcY = anchor.y;
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        occupy(tcX + dx, tcY + dy);
      }
    }
    const tcEid = stampFinishedBuilding(world, comps, "town-center", tcX, tcY, {
      playerId,
    });

    const tcCenter = { x: tcX + 1.5, y: tcY + 1.5 };

    // Helper for polar offsets from TC center
    const polarPoint = (angleOffset: number, distance: number) => {
      const a = centerAngle + angleOffset;
      return {
        x: tcCenter.x + Math.cos(a) * distance,
        y: tcCenter.y + Math.sin(a) * distance,
      };
    };

    // 3. Guaranteed Starting Resources:
    // a. Berry bushes: 6 nodes (125 food) at front-left (~3.8 tiles from TC center, max 6.0)
    const berryPos = polarPoint(-Math.PI / 6, 3.8);
    const berryEids = placeCluster(
      berryPos.x,
      berryPos.y,
      RESOURCE_FOOD,
      125,
      6,
      tcCenter,
      5.95,
    );

    // b. Primary Gold: 4 nodes (800 gold) at front-right (~4.8 tiles from TC center, max 7.0)
    const pGoldPos = polarPoint(Math.PI / 6, 4.8);
    const primaryGoldEids = placeCluster(
      pGoldPos.x,
      pGoldPos.y,
      RESOURCE_GOLD,
      800,
      4,
      tcCenter,
      6.95,
    );

    // c. Primary Stone: 3 nodes (350 stone) at flank-left (~6.2 tiles from TC center, max 9.0)
    const stonePos = polarPoint(-Math.PI / 2, 6.2);
    const stoneEids = placeCluster(
      stonePos.x,
      stonePos.y,
      RESOURCE_STONE,
      350,
      3,
      tcCenter,
      8.95,
    );

    // d. Secondary Gold: 2 nodes (800 gold) at flank-right (~10.5 tiles from TC center, max 14.0)
    const sGoldPos = polarPoint(Math.PI / 2, 10.5);
    const secondaryGoldEids = placeCluster(
      sGoldPos.x,
      sGoldPos.y,
      RESOURCE_GOLD,
      800,
      2,
      tcCenter,
      13.95,
    );

    // e. Forest line 1: 6 trees (150 wood) at rear-left (~8.5 tiles from TC center, max 12.5)
    const forest1Pos = polarPoint(-Math.PI * 0.75, 8.5);
    const forest1Eids = placeCluster(
      forest1Pos.x,
      forest1Pos.y,
      RESOURCE_WOOD,
      150,
      6,
      tcCenter,
      12.5,
    );

    // f. Forest line 2: 6 trees (150 wood) at rear-right (~8.8 tiles from TC center, max 12.5)
    const forest2Pos = polarPoint(Math.PI * 0.75, 8.8);
    const forest2Eids = placeCluster(
      forest2Pos.x,
      forest2Pos.y,
      RESOURCE_WOOD,
      150,
      6,
      tcCenter,
      12.5,
    );

    const treeEids = [...forest1Eids, ...forest2Eids];

    // 4. Starting Units:
    // 3 Villagers placed near the TC front entrance
    const villagerEids: number[] = [];
    const vCenter = polarPoint(0, 2.5);
    let vPlaced = 0;
    for (let r = 0; r <= 3 && vPlaced < 3; r++) {
      for (let dy = -r; dy <= r && vPlaced < 3; dy++) {
        for (let dx = -r; dx <= r && vPlaced < 3; dx++) {
          const vx = Math.floor(vCenter.x) + dx;
          const vy = Math.floor(vCenter.y) + dy;
          if (isFreeTile(vx, vy)) {
            occupy(vx, vy);
            const eid = spawnCombatUnit(
              world,
              comps,
              "villager",
              vx + 0.5,
              vy + 0.5,
              playerId,
              { body: true, morale: true },
            );
            villagerEids.push(eid);
            vPlaced++;
          }
        }
      }
    }

    // 1 Scout Cavalry placed at the front perimeter
    const scoutPos = polarPoint(0, 4.0);
    let scoutEid = 0;
    for (let r = 0; r <= 3 && scoutEid === 0; r++) {
      for (let dy = -r; dy <= r && scoutEid === 0; dy++) {
        for (let dx = -r; dx <= r && scoutEid === 0; dx++) {
          const sx = Math.floor(scoutPos.x) + dx;
          const sy = Math.floor(scoutPos.y) + dy;
          if (isFreeTile(sx, sy)) {
            occupy(sx, sy);
            scoutEid = spawnCombatUnit(
              world,
              comps,
              "scout-cavalry",
              sx + 0.5,
              sy + 0.5,
              playerId,
              { body: true, morale: true },
            );
          }
        }
      }
    }

    players.push({
      playerId,
      civId,
      tcEid,
      tcOrigin: { x: tcX, y: tcY },
      villagerEids,
      scoutEid,
      berryEids,
      primaryGoldEids,
      secondaryGoldEids,
      stoneEids,
      treeEids,
    });
  }

  // 5. Neutral Sacred Relics (1 center, 4 along cardinal crossroads)
  const relicEids: number[] = [];
  if (options.spawnRelics !== false) {
    const cx = size / 2;
    const cy = size / 2;
    const relicPositions = [
      { x: cx, y: cy }, // Center
      { x: cx, y: cy - 32 }, // North
      { x: cx, y: cy + 32 }, // South
      { x: cx - 32, y: cy }, // West
      { x: cx + 32, y: cy }, // East
    ];

    for (const pos of relicPositions) {
      const rx = Math.floor(pos.x);
      const ry = Math.floor(pos.y);
      let placed = false;
      for (let r = 0; r <= 3 && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            const tx = rx + dx;
            const ty = ry + dy;
            if (isFreeTile(tx, ty)) {
              occupy(tx, ty);
              const eid = spawnRelic(world, comps, tx + 0.5, ty + 0.5);
              relicEids.push(eid);
              placed = true;
            }
          }
        }
      }
    }
  }

  // 6. Fish Resource Nodes (in water tiles)
  const fishEids: number[] = [];
  if (options.spawnFish !== false) {
    const prng = createPrng(((options.seed ?? 12345) ^ 0xf158) >>> 0);
    const waterIndices: number[] = [];
    for (let idx = 0; idx < size * size; idx++) {
      if (isWaterTerrain(world.layers.terrainType[idx]!)) {
        waterIndices.push(idx);
      }
    }

    const targetFishCount = Math.min(32, Math.floor(waterIndices.length / 60));
    let attempts = 0;
    const maxAttempts = targetFishCount * 25;
    while (
      fishEids.length < targetFishCount &&
      attempts < maxAttempts &&
      waterIndices.length > 0
    ) {
      attempts++;
      const randIdx = Math.floor(prng.nextFloat() * waterIndices.length);
      const tileIdx = waterIndices[randIdx]!;
      const tx = tileIdx % size;
      const ty = Math.floor(tileIdx / size);

      if (occupiedTiles.has(tileIdx)) continue;

      let tooClose = false;
      for (const feid of fishEids) {
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(feid);
        if (pos) {
          const dx = Math.abs(pos[0]! - (tx + 0.5));
          const dy = Math.abs(pos[1]! - (ty + 0.5));
          if (Math.max(dx, dy) < 4) {
            tooClose = true;
            break;
          }
        }
      }
      if (tooClose) continue;

      occupy(tx, ty);
      const isDeep = world.layers.terrainType[tileIdx] === TERRAIN_DEEP_WATER;
      const amount = isDeep ? 350 : 200;
      const eid = spawnResourceNode(
        world,
        comps,
        tx,
        ty,
        RESOURCE_FOOD,
        amount,
      );
      fishEids.push(eid);
    }
  }

  return {
    diplomacy,
    players,
    relicEids,
    fishEids,
  };
}

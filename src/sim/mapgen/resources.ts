/**
 * Deterministic resource-node placement — SPEC §2.6 / M1-T9.
 *
 * Scatters gatherable nodes onto forest-floor (→ wood) and grass
 * (→ food/gold/stone) tiles. A pure function of (layers, seed, options):
 * all randomness flows from an sfc32 stream seeded independently of the
 * world tick stream, so the same seed always yields the same node set —
 * safe for fixtures and replays. Output is sorted by tile index so the
 * spawn order (and therefore entity ids) is canonical regardless of
 * draw order.
 */

import { createPrng } from "../core/prng";
import {
  isWaterTerrain,
  TERRAIN_FOREST_FLOOR,
  TERRAIN_GRASS,
  type WorldLayers,
} from "../world/layers";
import {
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../components/economy";

/** Gatherable amounts per resource code (AoE2-ish baselines). */
export const DEFAULT_NODE_AMOUNTS: readonly number[] = [125, 150, 80, 60];

export interface NodePlacement {
  readonly tileX: number;
  readonly tileY: number;
  /** Gatherable resource code (see components/economy). */
  readonly resourceCode: number;
  readonly amount: number;
}

export interface ScatterOptions {
  /** Target node count; may land lower on node-hostile terrain. */
  readonly count: number;
  /**
   * Amounts indexed by resource code; defaults to DEFAULT_NODE_AMOUNTS.
   */
  readonly amounts?: readonly number[] | undefined;
  /** Minimum Chebyshev spacing between nodes in tiles. */
  readonly minSpacing?: number | undefined;
  /** Attempt budget = count × this factor before giving up. */
  readonly attemptFactor?: number | undefined;
}

function defaultAmounts(): number[] {
  return [...DEFAULT_NODE_AMOUNTS];
}

/**
 * Scatter `count` nodes deterministically. Forest floor yields wood;
 * grass yields food (50%), gold (25%) or stone (25%) by PRNG draw.
 * Nodes never spawn on water and keep at least `minSpacing` tiles apart.
 */
export function scatterResourceNodes(
  layers: WorldLayers,
  seed: number,
  options: ScatterOptions,
): NodePlacement[] {
  const { count } = options;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `node count must be a non-negative integer, got ${String(count)}`,
    );
  }
  const amounts = options.amounts ?? defaultAmounts();
  const minSpacing = options.minSpacing ?? 2;
  const maxAttempts = Math.max(count, 1) * (options.attemptFactor ?? 60);
  const prng = createPrng(seed >>> 0);
  const size = layers.size;

  const placed: NodePlacement[] = [];
  let attempts = 0;
  while (placed.length < count && attempts < maxAttempts) {
    attempts += 1;
    const tileX = Math.floor(prng.nextFloat() * size);
    const tileY = Math.floor(prng.nextFloat() * size);
    const index = tileY * size + tileX;
    const terrain = layers.terrainType[index]!;
    if (isWaterTerrain(terrain)) continue;
    let resourceCode: number;
    if (terrain === TERRAIN_FOREST_FLOOR) {
      resourceCode = RESOURCE_WOOD;
    } else if (terrain === TERRAIN_GRASS) {
      const roll = prng.nextFloat();
      if (roll < 0.5) resourceCode = RESOURCE_FOOD;
      else if (roll < 0.75) resourceCode = RESOURCE_GOLD;
      else resourceCode = RESOURCE_STONE;
    } else {
      continue; // shore/dirt stay clear of clutter in M1
    }
    let tooClose = false;
    for (const other of placed) {
      const dx = Math.abs(other.tileX - tileX);
      const dy = Math.abs(other.tileY - tileY);
      if (Math.max(dx, dy) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    placed.push({
      tileX,
      tileY,
      resourceCode,
      amount: amounts[resourceCode]!,
    });
  }

  // Canonical spawn order independent of draw order.
  placed.sort((a, b) => a.tileY * size + a.tileX - (b.tileY * size + b.tileX));
  return placed;
}

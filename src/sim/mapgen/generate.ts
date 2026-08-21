/**
 * Seeded simplex mapgen — SPEC §2.1/§5.
 *
 * A pure function of (seed, size): all randomness flows from our sfc32
 * stream — each simplex-noise permutation table is built by drawing the
 * PRNG exactly 255 times, so octave construction ORDER IS CANONICAL and
 * pinned below; reordering or adding octaves changes every map ever
 * generated, like changing SFC32_WARMUP_ROUNDS.
 *
 * Terrain bands come from fBm over 4 terrain octaves; elevation is a
 * gentler 3-octave field quantized to integer levels 0–8 (data-only in
 * M1 per SPEC §2.2 — cliff passability lands with movement).
 */

import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { createPrng } from "../core/prng";
import {
  buildLayers,
  MAX_ELEVATION_LEVEL,
  TERRAIN_DEEP_WATER,
  TERRAIN_DIRT,
  TERRAIN_FOREST_FLOOR,
  TERRAIN_GRASS,
  TERRAIN_SHORE,
  TERRAIN_WATER,
  type WorldLayers,
} from "../world/layers";

/** Default skirmish grid: 120×120 tiles (SPEC §2.1 / ADR-0002). */
export const DEFAULT_MAP_SIZE = 120;

const TERRAIN_OCTAVES = 4;
const ELEVATION_OCTAVES = 3;
const TERRAIN_BASE_FREQUENCY = 1 / 18;
const ELEVATION_BASE_FREQUENCY = 1 / 26;
const OCTAVE_LACUNARITY = 2;
const OCTAVE_GAIN = 0.5;

/**
 * fBm output concentrates near 0 (std ≈ 0.25), so thresholds are tuned
 * for roughly: ~1% deep water, ~19% water, ~12% shore, ~48% grass,
 * ~13% dirt, ~7% forest floor.
 */
function terrainIdFor(n: number): number {
  if (n < -0.62) return TERRAIN_DEEP_WATER;
  if (n < -0.28) return TERRAIN_WATER;
  if (n < -0.12) return TERRAIN_SHORE;
  if (n < 0.3) return TERRAIN_GRASS;
  if (n < 0.52) return TERRAIN_DIRT;
  return TERRAIN_FOREST_FLOOR;
}

function fbm(noises: readonly NoiseFunction2D[], x: number, y: number): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (const noise of noises) {
    sum += noise(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= OCTAVE_GAIN;
    frequency *= OCTAVE_LACUNARITY;
  }
  return sum / norm;
}

export function generateMap(
  seed: number,
  size: number = DEFAULT_MAP_SIZE,
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

  // Canonical octave construction order: terrain ascending, then elevation.
  const terrainNoises: NoiseFunction2D[] = [];
  for (let i = 0; i < TERRAIN_OCTAVES; i++)
    terrainNoises.push(createNoise2D(draw));
  const elevationNoises: NoiseFunction2D[] = [];
  for (let i = 0; i < ELEVATION_OCTAVES; i++)
    elevationNoises.push(createNoise2D(draw));

  const tileCount = size * size;
  const terrainType = new Uint8Array(tileCount);
  const elevationLevel = new Uint8Array(tileCount);
  const centerOffset = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const tx = (x - centerOffset) * TERRAIN_BASE_FREQUENCY;
      const ty = (y - centerOffset) * TERRAIN_BASE_FREQUENCY;
      terrainType[index] = terrainIdFor(fbm(terrainNoises, tx, ty));
      const ex = (x - centerOffset) * ELEVATION_BASE_FREQUENCY;
      const ey = (y - centerOffset) * ELEVATION_BASE_FREQUENCY;
      const level = Math.round(
        (fbm(elevationNoises, ex, ey) + 1) * (MAX_ELEVATION_LEVEL / 2),
      );
      elevationLevel[index] = Math.min(MAX_ELEVATION_LEVEL, Math.max(0, level));
    }
  }

  return buildLayers(terrainType, elevationLevel);
}

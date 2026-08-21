/**
 * Tile-grid world layers — SPEC §2.1 / ADR-0002.
 *
 * A size×size world is three parallel Uint8Arrays: terrain type, integer
 * elevation level (0–8) and DERIVED passability. M1 passability rules:
 * water tiles are impassable, everything else walkable (cliff logic is
 * deferred to the movement ticket). Maps serialize as raw layer bytes —
 * terrain ‖ elevation ‖ passability — whose length encodes the grid
 * size (3·size²), hashed FNV-1a-64 for save headers and golden fixtures.
 */

import { fnv1a64Hex } from "../core/digest";

/**
 * Terrain ids are stable u8 enum values baked into saved maps — never
 * reorder or renumber.
 */
export const TERRAIN_DEEP_WATER = 0;
export const TERRAIN_WATER = 1;
export const TERRAIN_SHORE = 2;
export const TERRAIN_GRASS = 3;
export const TERRAIN_DIRT = 4;
export const TERRAIN_FOREST_FLOOR = 5;
export const TERRAIN_TYPE_COUNT = 6;

/** Human-readable terrain names indexed by terrain id. */
export const TERRAIN_TYPE_NAMES: readonly string[] = [
  "deep-water",
  "water",
  "shore",
  "grass",
  "dirt",
  "forest-floor",
];

export const MAX_ELEVATION_LEVEL = 8;

export const PASSABLE = 1;
export const IMPASSABLE = 0;

export interface WorldLayers {
  /** Grid is size×size tiles; tile = 1 world unit. */
  readonly size: number;
  /** Terrain id per tile (flat row-major index y·size + x). */
  readonly terrainType: Uint8Array;
  /** Integer elevation steps 0–8 per tile (data-only until movement). */
  readonly elevationLevel: Uint8Array;
  /** 1 = walkable, 0 = blocked; derived, never authored. */
  readonly derivedPassability: Uint8Array;
}

function requireGridSize(size: number): void {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `grid size must be a positive integer, got ${String(size)}`,
    );
  }
}

function requireTileCount(
  array: Uint8Array,
  where: string,
  tileCount: number,
): void {
  if (array.length !== tileCount) {
    throw new Error(
      `${where} layer must hold exactly ${String(tileCount)} tiles, got ${String(array.length)}`,
    );
  }
}

function validateTerrainValue(value: number, index: number): void {
  if (value >= TERRAIN_TYPE_COUNT) {
    throw new Error(
      `terrain byte ${String(index)} out of enum range: ${String(value)}`,
    );
  }
}

function validateElevationValue(value: number, index: number): void {
  if (value > MAX_ELEVATION_LEVEL) {
    throw new Error(
      `elevation byte ${String(index)} above level ${String(MAX_ELEVATION_LEVEL)}: ${String(value)}`,
    );
  }
}

/** M1 passability rule: water terrain blocks, all other terrain walks. */
export function isWaterTerrain(terrainId: number): boolean {
  return terrainId === TERRAIN_DEEP_WATER || terrainId === TERRAIN_WATER;
}

/** Derive the passability plane from a validated terrain plane. */
export function derivePassability(terrainType: Uint8Array): Uint8Array {
  const passability = new Uint8Array(terrainType.length);
  for (let i = 0; i < terrainType.length; i++) {
    const terrain = terrainType[i]!;
    validateTerrainValue(terrain, i);
    passability[i] = isWaterTerrain(terrain) ? IMPASSABLE : PASSABLE;
  }
  return passability;
}

/**
 * Assemble layers from authored planes, deriving passability. Throws
 * loudly on wrong lengths or out-of-range bytes rather than clamping —
 * bad map data must never silently become a playable map.
 */
export function buildLayers(
  terrainType: Uint8Array,
  elevationLevel: Uint8Array,
): WorldLayers {
  if (terrainType.length !== elevationLevel.length) {
    throw new Error(
      `layer length mismatch: terrain ${String(terrainType.length)} vs elevation ${String(elevationLevel.length)}`,
    );
  }
  const tileCount = terrainType.length;
  const size = Math.sqrt(tileCount);
  requireGridSize(size);
  for (let i = 0; i < tileCount; i++) {
    validateTerrainValue(terrainType[i]!, i);
    validateElevationValue(elevationLevel[i]!, i);
  }
  return {
    size,
    terrainType,
    elevationLevel,
    derivedPassability: derivePassability(terrainType),
  };
}

/**
 * Canonical raw map bytes: terrain ‖ elevation ‖ passability. Size is
 * recoverable from the byte length (3·size²) — no header needed here;
 * the `.ageof` container owns framing (SPEC §2.12).
 */
export function serializeLayers(layers: WorldLayers): Uint8Array {
  requireGridSize(layers.size);
  const tileCount = layers.size * layers.size;
  requireTileCount(layers.terrainType, "terrain", tileCount);
  requireTileCount(layers.elevationLevel, "elevation", tileCount);
  requireTileCount(layers.derivedPassability, "passability", tileCount);
  const bytes = new Uint8Array(tileCount * 3);
  bytes.set(layers.terrainType, 0);
  bytes.set(layers.elevationLevel, tileCount);
  bytes.set(layers.derivedPassability, tileCount * 2);
  return bytes;
}

/** Rebuild layers from canonical raw map bytes, validating everything. */
export function deserializeLayers(bytes: Uint8Array): WorldLayers {
  if (bytes.length === 0 || bytes.length % 3 !== 0) {
    throw new Error(
      `map bytes must be a nonzero multiple of 3 (three planes), got ${String(bytes.length)}`,
    );
  }
  const tileCount = bytes.length / 3;
  const size = Math.sqrt(tileCount);
  if (!Number.isInteger(size)) {
    throw new Error(
      `map bytes encode ${String(tileCount)} tiles, which is not a perfect square`,
    );
  }
  const terrainType = bytes.slice(0, tileCount);
  const elevationLevel = bytes.slice(tileCount, tileCount * 2);
  const storedPassability = bytes.slice(tileCount * 2, tileCount * 3);
  for (let i = 0; i < tileCount; i++) {
    validateTerrainValue(terrainType[i]!, i);
    validateElevationValue(elevationLevel[i]!, i);
  }
  const expectedPassability = derivePassability(terrainType);
  for (let i = 0; i < tileCount; i++) {
    if (storedPassability[i] !== expectedPassability[i]) {
      throw new Error(
        `passability plane inconsistent with terrain at tile ${String(i)}: stored ${String(storedPassability[i]!)}, expected ${String(expectedPassability[i]!)}`,
      );
    }
  }
  return {
    size,
    terrainType,
    elevationLevel,
    derivedPassability: storedPassability,
  };
}

/** FNV-1a-64 over the canonical raw map bytes, rendered `fnv1a64:<hex>`. */
export function layersHash(layers: WorldLayers): string {
  return fnv1a64Hex(serializeLayers(layers));
}

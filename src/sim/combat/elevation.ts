/**
 * Elevation combat modifiers — V15 / Issue #107.
 *
 * Pure, world-layer-aware helpers that compute:
 * 1. elevationAt(x, y)  — tile elevation level (0–8) for any world position.
 * 2. elevationDamageMultiplier — ±25% damage for high/low ground.
 * 3. elevationRangeBonus     — +1 range when attacker is above target.
 * 4. elevationSightBonus     — +1 sight radius when ≥2 levels above area.
 *
 * All functions are pure with respect to WorldLayers so they are trivially
 * testable and never touch mutable state.
 */

import type { WorldLayers } from "../world/layers";

/** Damage multiplier constants — SPEC §2.5 / Issue #107. */
export const HIGH_GROUND_DAMAGE_MULT = 1.25;
export const LOW_GROUND_DAMAGE_MULT = 0.75;

/** Minimum level difference to trigger the range/sight bonuses. */
export const ELEVATION_RANGE_BONUS_THRESHOLD = 1;
export const ELEVATION_SIGHT_BONUS_THRESHOLD = 2;

/**
 * Integer elevation level (0–8) of the tile containing world-position
 * (worldX, worldY). Out-of-bounds positions clamp to level 0.
 */
export function elevationAt(
  layers: WorldLayers,
  worldX: number,
  worldY: number,
): number {
  const tileX = Math.floor(worldX);
  const tileY = Math.floor(worldY);
  if (tileX < 0 || tileY < 0 || tileX >= layers.size || tileY >= layers.size) {
    return 0;
  }
  return layers.elevationLevel[tileY * layers.size + tileX] ?? 0;
}

/**
 * Damage multiplier to apply when the attacker is at `attackerElev` and
 * the target is at `targetElev`.
 *
 * - attacker higher  → 1.25  (+25% bonus)
 * - attacker lower   → 0.75  (−25% penalty)
 * - same elevation   → 1.0   (no change)
 */
export function elevationDamageMultiplier(
  attackerElev: number,
  targetElev: number,
): number {
  if (attackerElev > targetElev) return HIGH_GROUND_DAMAGE_MULT;
  if (attackerElev < targetElev) return LOW_GROUND_DAMAGE_MULT;
  return 1.0;
}

/**
 * Apply the elevation multiplier to a pre-calculated base damage value.
 *
 * Resulting integer is:
 *   Math.round(baseDamage × multiplier), clamped to ≥ 1.
 */
export function applyElevationDamage(
  baseDamage: number,
  attackerElev: number,
  targetElev: number,
): number {
  const mult = elevationDamageMultiplier(attackerElev, targetElev);
  if (mult === 1.0) return baseDamage; // fast path — most fights are flat
  return Math.max(1, Math.round(baseDamage * mult));
}

/**
 * Returns +1 if a ranged unit shooting from `attackerElev` toward a target
 * at `targetElev` gains the downhill range extension, otherwise 0.
 *
 * Criterion: attacker strictly above target by at least
 * ELEVATION_RANGE_BONUS_THRESHOLD level(s).
 */
export function elevationRangeBonus(
  attackerElev: number,
  targetElev: number,
): number {
  return attackerElev - targetElev >= ELEVATION_RANGE_BONUS_THRESHOLD ? 1 : 0;
}

/**
 * Returns +1 sight bonus when a unit stands at least
 * ELEVATION_SIGHT_BONUS_THRESHOLD levels above the reference elevation
 * (typically the map's mean or a specific neighbour's level), otherwise 0.
 */
export function elevationSightBonus(
  unitElev: number,
  referenceElev: number,
): number {
  return unitElev - referenceElev >= ELEVATION_SIGHT_BONUS_THRESHOLD ? 1 : 0;
}

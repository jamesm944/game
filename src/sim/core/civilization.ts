/**
 * Player Civilization helpers & bonus queries — Milestone C1 (Issue #118).
 *
 * Connects player IDs to CivilizationDefinitions, evaluates passive civ
 * bonuses, and validates unique unit production gating.
 */

import { CIV_DEFINITIONS } from "../../data/definitions";
import type { CivilizationDefinition, TechEffect } from "../../data/schema";
import type { World } from "./world";

/**
 * Get the civilization ID string for a player (e.g. "britons", "franks").
 * Returns undefined if no civilization is assigned.
 */
export function getPlayerCivilizationId(
  world: World,
  playerId: number,
): string | undefined {
  return world.civilizations?.get(playerId);
}

/**
 * Get the full CivilizationDefinition for a player, or undefined if unset.
 */
export function getPlayerCivilization(
  world: World,
  playerId: number,
): CivilizationDefinition | undefined {
  const civId = getPlayerCivilizationId(world, playerId);
  if (!civId) return undefined;
  return CIV_DEFINITIONS.get(civId);
}

/**
 * Assign or update a player's civilization in the world.
 */
export function setPlayerCivilization(
  world: World,
  playerId: number,
  civId: string,
): void {
  if (!world.civilizations) {
    world.civilizations = new Map<number, string>();
  }
  world.civilizations.set(playerId, civId);
}

/**
 * Retrieve all active passive bonus descriptors for a player.
 */
export function getCivBonuses(
  world: World,
  playerId: number,
): readonly TechEffect[] {
  const civ = getPlayerCivilization(world, playerId);
  return civ ? civ.bonuses : [];
}

/**
 * Returns which civilization owns `unitId` as its Unique Unit, or undefined.
 */
export function civOfUniqueUnit(unitId: string): string | undefined {
  for (const civ of CIV_DEFINITIONS.values()) {
    if (civ.uniqueUnitId === unitId) return civ.id;
  }
  return undefined;
}

/**
 * Returns true if `unitId` is a unique unit of ANY civilization.
 */
export function isUniqueUnit(unitId: string): boolean {
  return civOfUniqueUnit(unitId) !== undefined;
}

/**
 * Check whether a player is authorized to train `unitId`:
 * - Standard units: allowed for all players.
 * - Unique units: allowed ONLY if the player belongs to that unit's civilization
 *   (or if no civilizations are assigned in the world, e.g. sandbox/legacy mode).
 */
export function canPlayerTrainUnit(
  world: World,
  playerId: number,
  unitId: string,
): boolean {
  const requiredCiv = civOfUniqueUnit(unitId);
  if (!requiredCiv) return true; // standard unit
  const playerCiv = getPlayerCivilizationId(world, playerId);
  // If the world does not use civilizations at all, allow all units (sandbox/test compatibility)
  if (!world.civilizations || world.civilizations.size === 0) return true;
  return playerCiv === requiredCiv;
}

/** True when the effect's selector targets this unit definition. */
export function selectorMatches(
  selector: string,
  def: { readonly id: string; readonly armorClasses: readonly string[] },
): boolean {
  if (selector.startsWith("class:")) {
    return def.armorClasses.includes(selector.slice("class:".length));
  }
  if (selector.startsWith("unit:")) {
    return selector.slice("unit:".length) === def.id;
  }
  return false;
}

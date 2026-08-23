/**
 * Entity-definition registry — SPEC §3 / M2-T1.
 *
 * Loads every built-in definition through ./load.ts (three-round
 * discipline: parse all → validate all → fail loudly listing EVERY
 * error at once). The registries exposed here are the single lookup
 * surface for sim systems and UI; nothing may hand-roll its own def
 * table.
 *
 * Stable numeric def codes: digest-visible component rows carry u8
 * codes, not slugs. Codes are assigned once per process by ascending
 * slug order over the loaded set, so they are a pure function of the
 * definition content — deterministic across runs and platforms.
 */

import { builtinSources, loadDefinitions } from "./load";
import type {
  BuildingDefinition,
  RecipeDefinition,
  TechDefinition,
  UnitDefinition,
} from "./schema";

const REGISTRY = loadDefinitions(builtinSources());

export const UNIT_DEFINITIONS = REGISTRY.units;
export const BUILDING_DEFINITIONS = REGISTRY.buildings;
export const TECH_DEFINITIONS = REGISTRY.techs;
export const RECIPE_DEFINITIONS = REGISTRY.recipes;

/** u8 def codes assigned by ascending slug over each loaded family. */
function assignCodes<T extends { id: string }>(
  defs: ReadonlyMap<string, T>,
): ReadonlyMap<string, number> {
  const codes = new Map<string, number>();
  [...defs.keys()].sort().forEach((id, index) => {
    codes.set(id, index + 1);
  });
  return codes;
}

export const UNIT_DEF_CODES = assignCodes(REGISTRY.units);
export const BUILDING_DEF_CODES = assignCodes(REGISTRY.buildings);

export function unitDefOf(id: string): UnitDefinition {
  const def = REGISTRY.units.get(id);
  if (!def) throw new Error(`unknown unit definition: ${JSON.stringify(id)}`);
  return def;
}

export function buildingDefOf(id: string): BuildingDefinition {
  const def = REGISTRY.buildings.get(id);
  if (!def)
    throw new Error(`unknown building definition: ${JSON.stringify(id)}`);
  return def;
}

export function techDefOf(id: string): TechDefinition {
  const def = REGISTRY.techs.get(id);
  if (!def) throw new Error(`unknown tech definition: ${JSON.stringify(id)}`);
  return def;
}

export function recipeDefOf(id: string): RecipeDefinition {
  const def = REGISTRY.recipes.get(id);
  if (!def) throw new Error(`unknown recipe definition: ${JSON.stringify(id)}`);
  return def;
}

export function unitCodeOf(id: string): number {
  const code = UNIT_DEF_CODES.get(id);
  if (code === undefined)
    throw new Error(`unknown unit definition: ${JSON.stringify(id)}`);
  return code;
}

export function buildingCodeOf(id: string): number {
  const code = BUILDING_DEF_CODES.get(id);
  if (code === undefined)
    throw new Error(`unknown building definition: ${JSON.stringify(id)}`);
  return code;
}

export function buildingIdOfCode(code: number): string {
  for (const [id, candidate] of BUILDING_DEF_CODES) {
    if (candidate === code) return id;
  }
  throw new Error(`unknown building def code: ${String(code)}`);
}

export function unitIdOfCode(code: number): string {
  for (const [id, candidate] of UNIT_DEF_CODES) {
    if (candidate === code) return id;
  }
  throw new Error(`unknown unit def code: ${String(code)}`);
}

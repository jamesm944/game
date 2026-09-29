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
  CivilizationDefinition,
  RecipeDefinition,
  TechDefinition,
  UnitDefinition,
  VictoryPathDefinition,
} from "./schema";

const REGISTRY = loadDefinitions(builtinSources());

export const UNIT_DEFINITIONS = REGISTRY.units;
export const BUILDING_DEFINITIONS = REGISTRY.buildings;
export const TECH_DEFINITIONS = REGISTRY.techs;
export const RECIPE_DEFINITIONS = REGISTRY.recipes;
export const VICTORY_PATH_DEFINITIONS = REGISTRY.victoryPaths;
export const CIV_DEFINITIONS = REGISTRY.civs;

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

function assignCanonicalCodes<T extends { id: string }>(
  defs: ReadonlyMap<string, T>,
  canonicalIds: readonly string[],
): ReadonlyMap<string, number> {
  const codes = new Map<string, number>();
  let nextCode = 1;
  for (const id of canonicalIds) {
    if (defs.has(id)) {
      codes.set(id, nextCode++);
    }
  }
  const remaining = [...defs.keys()].filter((id) => !codes.has(id)).sort();
  for (const id of remaining) {
    codes.set(id, nextCode++);
  }
  return codes;
}

/** Canonical unit ids preserve u8 codes 1..8 across new additions. */
const CANONICAL_UNIT_IDS: readonly string[] = [
  "archer",
  "knight",
  "man-at-arms",
  "militia",
  "monk",
  "scout-cavalry",
  "skirmisher",
  "villager",
];

/** Canonical base building ids preserve u8 codes 1..25 across new additions. */
const CANONICAL_BUILDING_IDS: readonly string[] = [
  "archery-range",
  "barracks",
  "blacksmith",
  "brothel",
  "church",
  "farm",
  "forge",
  "grand-academy",
  "grand-monument",
  "house",
  "kiln",
  "kitchen",
  "lumber-camp",
  "mill",
  "mining-camp",
  "monastery",
  "monument",
  "sawpit",
  "school",
  "smithy",
  "stable",
  "tavern",
  "town-center",
  "watch-tower",
  "wonder",
];

/** Canonical tech ids preserve u8 codes 1..8 across new additions. */
const CANONICAL_TECH_IDS: readonly string[] = [
  "castle-age",
  "double-bit-axe",
  "feudal-age",
  "forging",
  "hand-cart",
  "imperial-age",
  "scale-mail",
  "wheelbarrow",
];

export const UNIT_DEF_CODES = assignCanonicalCodes(
  REGISTRY.units,
  CANONICAL_UNIT_IDS,
);
export const BUILDING_DEF_CODES = assignCanonicalCodes(
  REGISTRY.buildings,
  CANONICAL_BUILDING_IDS,
);
/** u8 recipe codes (ascending slug) — ProductionCycle rows carry these. */
export const RECIPE_DEF_CODES = assignCodes(REGISTRY.recipes);
/** u8 tech codes (ascending slug) — AgeResearch/GateRejected rows carry these. */
export const TECH_DEF_CODES = assignCanonicalCodes(
  REGISTRY.techs,
  CANONICAL_TECH_IDS,
);
/** u8 civ codes (ascending slug). */
export const CIV_DEF_CODES = assignCodes(REGISTRY.civs);

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

/** §2.11 victory-path constants (M4-T5 economic gate and friends). */
export function victoryPathDefOf(id: string): VictoryPathDefinition {
  const def = REGISTRY.victoryPaths.get(id);
  if (!def) {
    throw new Error(`unknown victory path definition: ${JSON.stringify(id)}`);
  }
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

export function recipeCodeOf(id: string): number {
  const code = RECIPE_DEF_CODES.get(id);
  if (code === undefined)
    throw new Error(`unknown recipe definition: ${JSON.stringify(id)}`);
  return code;
}

export function recipeIdOfCode(code: number): string {
  for (const [id, candidate] of RECIPE_DEF_CODES) {
    if (candidate === code) return id;
  }
  throw new Error(`unknown recipe def code: ${String(code)}`);
}

export function techCodeOf(id: string): number {
  const code = TECH_DEF_CODES.get(id);
  if (code === undefined)
    throw new Error(`unknown tech definition: ${JSON.stringify(id)}`);
  return code;
}

export function techIdOfCode(code: number): string {
  for (const [id, candidate] of TECH_DEF_CODES) {
    if (candidate === code) return id;
  }
  throw new Error(`unknown tech def code: ${String(code)}`);
}

export function civDefOf(id: string): CivilizationDefinition {
  const def = REGISTRY.civs.get(id);
  if (!def) throw new Error(`unknown civilization definition: ${JSON.stringify(id)}`);
  return def;
}

export function civCodeOf(id: string): number {
  const code = CIV_DEF_CODES.get(id);
  if (code === undefined)
    throw new Error(`unknown civilization definition: ${JSON.stringify(id)}`);
  return code;
}

export function civIdOfCode(code: number): string {
  for (const [id, candidate] of CIV_DEF_CODES) {
    if (candidate === code) return id;
  }
  throw new Error(`unknown civilization def code: ${String(code)}`);
}

/** Recipes of one building ascending by id — cached; content is static. */
export function recipesForBuilding(buildingId: string): RecipeDefinition[] {
  let list = RECIPES_BY_BUILDING.get(buildingId);
  if (!list) {
    list = [...REGISTRY.recipes.values()]
      .filter((recipe) => recipe.buildingId === buildingId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    RECIPES_BY_BUILDING.set(buildingId, list);
  }
  return list;
}

const RECIPES_BY_BUILDING = new Map<string, RecipeDefinition[]>();

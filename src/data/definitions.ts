/**
 * Entity-definition registry — SPEC §3 / M1-T10.
 *
 * Loads every built-in definition JSON and applies the Factorio
 * three-round discipline: parse all (JSON imports) → validate all →
 * fail loudly listing EVERY error at once. The registries exposed here
 * are the single lookup surface for sim systems and UI; nothing may
 * hand-roll its own def table.
 *
 * Stable numeric def codes: digest-visible component rows carry u8
 * codes, not slugs. Codes are assigned once per process by ascending
 * slug order over the loaded set, so they are a pure function of the
 * definition content — deterministic across runs and platforms.
 */

import houseJson from "./definitions/buildings/house.json";
import barracksJson from "./definitions/buildings/barracks.json";
import townCenterJson from "./definitions/buildings/town-center.json";
import villagerJson from "./definitions/units/villager.json";
import {
  buildingSchema,
  techSchema,
  recipeSchema,
  unitSchema,
  type BuildingDefinition,
  type RecipeDefinition,
  type TechDefinition,
  type UnitDefinition,
} from "./schema";

/** Every built-in definition as parsed-but-unvalidated values. */
const RAW_DEFINITIONS: readonly unknown[] = [
  houseJson,
  barracksJson,
  townCenterJson,
  villagerJson,
];

interface ValidatedSets {
  readonly units: ReadonlyMap<string, UnitDefinition>;
  readonly buildings: ReadonlyMap<string, BuildingDefinition>;
  readonly techs: ReadonlyMap<string, TechDefinition>;
  readonly recipes: ReadonlyMap<string, RecipeDefinition>;
}

/**
 * Round 2: validate everything, collecting all failures before round 3
 * throws them together — one broken JSON must not hide its siblings.
 */
function validateAll(raw: readonly unknown[]): ValidatedSets {
  const errors: string[] = [];
  const units = new Map<string, UnitDefinition>();
  const buildings = new Map<string, BuildingDefinition>();
  const techs = new Map<string, TechDefinition>();
  const recipes = new Map<string, RecipeDefinition>();

  for (const candidate of raw) {
    const probe = candidate as { kind?: unknown; id?: unknown };
    const label = typeof probe.id === "string" ? probe.id : "<missing id>";
    let parsed:
      UnitDefinition | BuildingDefinition | TechDefinition | RecipeDefinition;
    if (probe.kind === "unit") {
      const result = unitSchema.safeParse(candidate);
      if (!result.success) {
        errors.push(`unit ${label}: ${result.error.message}`);
        continue;
      }
      parsed = result.data;
    } else if (probe.kind === "building") {
      const result = buildingSchema.safeParse(candidate);
      if (!result.success) {
        errors.push(`building ${label}: ${result.error.message}`);
        continue;
      }
      parsed = result.data;
    } else if (probe.kind === "tech") {
      const result = techSchema.safeParse(candidate);
      if (!result.success) {
        errors.push(`tech ${label}: ${result.error.message}`);
        continue;
      }
      parsed = result.data;
    } else if (probe.kind === "recipe") {
      const result = recipeSchema.safeParse(candidate);
      if (!result.success) {
        errors.push(`recipe ${label}: ${result.error.message}`);
        continue;
      }
      parsed = result.data;
    } else {
      errors.push(`${label}: unknown or missing kind`);
      continue;
    }

    const buckets = {
      unit: units,
      building: buildings,
      tech: techs,
      recipe: recipes,
    } as const;
    const bucket = buckets[parsed.kind]!;
    if (bucket.has(parsed.id)) {
      errors.push(`${parsed.kind} ${parsed.id}: duplicate definition id`);
      continue;
    }
    bucket.set(parsed.id, parsed as never);
  }

  if (errors.length > 0) {
    throw new Error(
      `definition validation failed (${String(errors.length)}):\n  - ${errors.join("\n  - ")}`,
    );
  }
  return { units, buildings, techs, recipes };
}

const SETS = validateAll(RAW_DEFINITIONS);

export const UNIT_DEFINITIONS = SETS.units;
export const BUILDING_DEFINITIONS = SETS.buildings;

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

export const UNIT_DEF_CODES = assignCodes(SETS.units);
export const BUILDING_DEF_CODES = assignCodes(SETS.buildings);

export function unitDefOf(id: string): UnitDefinition {
  const def = SETS.units.get(id);
  if (!def) throw new Error(`unknown unit definition: ${JSON.stringify(id)}`);
  return def;
}

export function buildingDefOf(id: string): BuildingDefinition {
  const def = SETS.buildings.get(id);
  if (!def)
    throw new Error(`unknown building definition: ${JSON.stringify(id)}`);
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

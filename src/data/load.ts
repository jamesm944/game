/**
 * Definition pipeline loader — SPEC §3 / M2-T1.
 *
 * Collects every JSON under src/data/definitions/{units,buildings,
 * techs,recipes,victory}/ and applies the Factorio three-round prototype-stage
 * discipline: parse ALL sources → validate ALL definitions → fail
 * LOUDLY with ONE aggregated error listing every problem at once. A
 * broken file must never hide its siblings' failures.
 *
 * Source collection has two paths:
 * - Browser/Vite (build-time): `import.meta.glob(..., {query:"?raw",
 *   eager:true})` inlines every definition file's raw text at bundle
 *   time — no runtime filesystem access exists.
 * - Plain Node (tests/tools): resolved synchronously through
 *   `process.getBuiltinModule("node:fs")`, which needs no static or
 *   dynamic import that would leak into the browser graph.
 *
 * The registries exposed by ./definitions.ts are built from here and
 * are the single lookup surface for sim systems and UI.
 */

import {
  ARMOR_CLASSES,
  COMMODITY_SLUGS,
  RESOURCE_SLUGS,
  buildingSchema,
  recipeSchema,
  techSchema,
  unitSchema,
  victoryPathDefinitionSchema,
  type BuildingDefinition,
  type RecipeDefinition,
  type TechDefinition,
  type UnitDefinition,
  type VictoryPathDefinition,
} from "./schema";

/** One raw definition file: its label (for errors) and JSON text. */
export interface DefinitionSource {
  readonly label: string;
  readonly json: string;
}

/** Typed per-kind definition registries keyed by stable slug id. */
export interface DefinitionRegistry {
  readonly units: ReadonlyMap<string, UnitDefinition>;
  readonly buildings: ReadonlyMap<string, BuildingDefinition>;
  readonly techs: ReadonlyMap<string, TechDefinition>;
  readonly recipes: ReadonlyMap<string, RecipeDefinition>;
  readonly victoryPaths: ReadonlyMap<string, VictoryPathDefinition>;
}

export interface LoadDefinitionsOptions {
  /**
   * SPEC §2.6 hard rule: recipes take gatherable inputs only (chain
   * depth 1). The schema supports commodity-on-commodity inputs for
   * future expansion, but v1 content rejects them unless flipped.
   */
  readonly allowCommodityInputs?: boolean;
}

// ---- Source collection -------------------------------------------------------

type ViteRawGlob = Record<string, string>;

interface GlobImportMeta {
  glob?: (
    pattern: string,
    options: {
      query: "?raw";
      import: "default";
      eager: true;
    },
  ) => ViteRawGlob;
}

const DEFINITIONS_GLOB_PATTERN =
  "./definitions/{units,buildings,techs,recipes,victory}/*.json";
const DEFINITIONS_KIND_DIRS = [
  "units",
  "buildings",
  "techs",
  "recipes",
  "victory",
];

/**
 * Every built-in definition file as raw text, sorted by label so error
 * listing and downstream iteration are platform-independent.
 */
export function builtinSources(): DefinitionSource[] {
  const glob = (import.meta as unknown as GlobImportMeta).glob;
  if (typeof glob === "function") {
    const modules: ViteRawGlob = glob(DEFINITIONS_GLOB_PATTERN, {
      query: "?raw",
      import: "default",
      eager: true,
    });
    return toSortedSources(
      Object.entries(modules).map(([label, json]) => ({ label, json })),
    );
  }
  return toSortedSources(nodeSourceEntries());
}

function toSortedSources(entries: DefinitionSource[]): DefinitionSource[] {
  return entries.sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  );
}

/**
 * Node-compatible fallback: walk the four kind directories next to this
 * module and read every .json file. Reached only where Vite's
 * `import.meta.glob` was not applied (plain-node consumers); uses
 * `process.getBuiltinModule` so no node import survives bundling.
 */
function nodeSourceEntries(): DefinitionSource[] {
  const proc = (
    globalThis as Partial<{
      process: {
        getBuiltinModule?: (id: string) => unknown;
      };
    }>
  ).process;
  const builtin = proc?.getBuiltinModule?.("node:fs") as
    typeof import("node:fs") | undefined;
  const path = proc?.getBuiltinModule?.("node:path") as
    typeof import("node:path") | undefined;
  const url = proc?.getBuiltinModule?.("node:url") as
    typeof import("node:url") | undefined;
  if (!builtin || !path || !url || !import.meta.url.startsWith("file:")) {
    throw new Error(
      "definition sources unavailable: neither Vite import.meta.glob nor a Node filesystem is reachable",
    );
  }
  const baseDir = path.dirname(url.fileURLToPath(import.meta.url));
  const sources: DefinitionSource[] = [];
  for (const kindDir of DEFINITIONS_KIND_DIRS) {
    const dir = path.join(baseDir, "definitions", kindDir);
    if (!builtin.existsSync(dir)) continue;
    for (const entry of builtin.readdirSync(dir).sort()) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(dir, entry);
      sources.push({
        label: `./definitions/${kindDir}/${entry}`,
        json: builtin.readFileSync(file, "utf8"),
      });
    }
  }
  return sources;
}

// ---- Three-round load --------------------------------------------------------

interface RawEntry {
  readonly label: string;
  readonly data: unknown;
}

const KIND_SCHEMAS = {
  unit: unitSchema,
  building: buildingSchema,
  tech: techSchema,
  recipe: recipeSchema,
  victoryPath: victoryPathDefinitionSchema,
} as const;

type ParsedDefinition =
  | UnitDefinition
  | BuildingDefinition
  | TechDefinition
  | RecipeDefinition
  | VictoryPathDefinition;

function formatIssues(
  prefix: string,
  error: { issues: { path: PropertyKey[]; message: string }[] },
): string {
  const details = error.issues
    .map((issue) => {
      const at = issue.path.map(String).join(".");
      return at.length > 0 ? `${at}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return `${prefix}: ${details}`;
}

/**
 * Load definitions under the three-round discipline. Throws ONE error
 * listing EVERY problem when anything fails; returns typed registries
 * keyed by slug otherwise.
 */
export function loadDefinitions(
  sources: readonly DefinitionSource[],
  options: LoadDefinitionsOptions = {},
): DefinitionRegistry {
  // ---- Round 1: parse everything, collect every syntax failure.
  const errors: string[] = [];
  const parsed: RawEntry[] = [];
  for (const source of sources) {
    try {
      parsed.push({ label: source.label, data: JSON.parse(source.json) });
    } catch (cause) {
      errors.push(
        `parse ${source.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  // ---- Round 2: schema-validate everything, collecting all failures.
  const seen = new Map<string, string>();
  const units = new Map<string, UnitDefinition>();
  const buildings = new Map<string, BuildingDefinition>();
  const techs = new Map<string, TechDefinition>();
  const recipes = new Map<string, RecipeDefinition>();
  const victoryPaths = new Map<string, VictoryPathDefinition>();
  const validated: {
    readonly label: string;
    readonly def: ParsedDefinition;
  }[] = [];

  for (const entry of parsed) {
    const probe = entry.data as { kind?: unknown; id?: unknown } | null;
    const label =
      typeof probe?.id === "string" ? String(probe.id) : "<missing id>";
    const where = `${entry.label} (${label})`;
    const kindSchema =
      typeof probe?.kind === "string" && probe.kind in KIND_SCHEMAS
        ? KIND_SCHEMAS[probe.kind as keyof typeof KIND_SCHEMAS]
        : undefined;
    if (!kindSchema) {
      errors.push(`${where}: unknown or missing kind`);
      continue;
    }
    const result = kindSchema.safeParse(entry.data);
    if (!result.success) {
      errors.push(formatIssues(`schema ${where}`, result.error));
      continue;
    }
    const def = result.data as ParsedDefinition;
    const owner = seen.get(def.id);
    if (owner !== undefined) {
      errors.push(
        `${where}: duplicate definition id (already defined as ${owner})`,
      );
      continue;
    }
    seen.set(def.id, def.kind);
    validated.push({ label: entry.label, def });
    if (def.kind === "unit") units.set(def.id, def);
    else if (def.kind === "building") buildings.set(def.id, def);
    else if (def.kind === "tech") techs.set(def.id, def);
    else if (def.kind === "recipe") recipes.set(def.id, def);
    else victoryPaths.set(def.id, def);
  }

  // ---- Round 3: cross-validate references between loaded sets.
  const gatherables = new Set<string>(RESOURCE_SLUGS);
  const commodities = new Set<string>(COMMODITY_SLUGS);
  const armorClasses = new Set<string>(ARMOR_CLASSES);

  for (const { def } of validated) {
    switch (def.kind) {
      case "unit": {
        for (const armorClass of def.armorClasses) {
          if (!armorClasses.has(armorClass)) {
            errors.push(
              `unit ${def.id}: unknown armor class ${JSON.stringify(armorClass)} (known: ${ARMOR_CLASSES.join(", ")})`,
            );
          }
        }
        for (const bonus of def.attackBonuses) {
          if (!armorClasses.has(bonus.armorClass)) {
            errors.push(
              `unit ${def.id}: attackBonus references unknown armor class ${JSON.stringify(bonus.armorClass)} (known: ${ARMOR_CLASSES.join(", ")})`,
            );
          }
        }
        for (const prereq of def.techPrereqs) {
          if (!techs.has(prereq)) {
            errors.push(
              `unit ${def.id}: techPrereqs reference unknown tech ${JSON.stringify(prereq)}`,
            );
          }
        }
        break;
      }
      case "building": {
        if (def.trainQueue) {
          for (const trainable of def.trainQueue.trainable) {
            if (!units.has(trainable.unitId)) {
              errors.push(
                `building ${def.id}: trainQueue references unknown unit ${JSON.stringify(trainable.unitId)}`,
              );
            }
          }
        }
        for (const prereq of def.techPrereqs) {
          if (!techs.has(prereq)) {
            errors.push(
              `building ${def.id}: techPrereqs reference unknown tech ${JSON.stringify(prereq)}`,
            );
          }
        }
        // M4-T4: §2.11 role blocks must reference real gatherable slugs
        // (festival costs debit the resource ledger).
        if (def.victory?.festivalCosts !== undefined) {
          for (const slug of Object.keys(def.victory.festivalCosts)) {
            if (!gatherables.has(slug)) {
              errors.push(
                `building ${def.id}: festivalCosts reference unknown resource ${JSON.stringify(slug)} (known: ${RESOURCE_SLUGS.join(", ")})`,
              );
            }
          }
        }
        break;
      }
      case "tech": {
        for (const effect of def.effects) {
          if (effect.target.startsWith("class:")) {
            const armorClass = effect.target.slice("class:".length);
            if (!armorClasses.has(armorClass)) {
              errors.push(
                `tech ${def.id}: effect target references unknown armor class ${JSON.stringify(armorClass)}`,
              );
            }
          } else if (effect.target.startsWith("unit:")) {
            const unitId = effect.target.slice("unit:".length);
            if (!units.has(unitId)) {
              errors.push(
                `tech ${def.id}: effect target references unknown unit ${JSON.stringify(unitId)}`,
              );
            }
          }
          // Other selectors (activity:<id>, economy stats…) are freeform.
        }
        for (const prereq of def.techPrereqs) {
          if (!techs.has(prereq)) {
            errors.push(
              `tech ${def.id}: techPrereqs reference unknown tech ${JSON.stringify(prereq)}`,
            );
          }
        }
        break;
      }
      case "recipe": {
        if (!buildings.has(def.buildingId)) {
          errors.push(
            `recipe ${def.id}: buildingId references unknown building ${JSON.stringify(def.buildingId)}`,
          );
        }
        for (const input of def.inputs) {
          if (!gatherables.has(input.defId) && !commodities.has(input.defId)) {
            errors.push(
              `recipe ${def.id}: input references unknown def ${JSON.stringify(input.defId)} (inputs must be gatherable or commodity slugs)`,
            );
          } else if (
            commodities.has(input.defId) &&
            !options.allowCommodityInputs
          ) {
            errors.push(
              `recipe ${def.id}: commodity input ${JSON.stringify(input.defId)} violates the depth-1 hard rule (SPEC §2.6; content-blocked in v1)`,
            );
          }
        }
        if (
          !gatherables.has(def.output.defId) &&
          !commodities.has(def.output.defId)
        ) {
          errors.push(
            `recipe ${def.id}: output references unknown def ${JSON.stringify(def.output.defId)} (outputs must be gatherable or commodity slugs)`,
          );
        }
        if (def.techGate !== undefined && !techs.has(def.techGate)) {
          errors.push(
            `recipe ${def.id}: techGate references unknown tech ${JSON.stringify(def.techGate)}`,
          );
        }
        for (const prereq of def.techPrereqs) {
          if (!techs.has(prereq)) {
            errors.push(
              `recipe ${def.id}: techPrereqs reference unknown tech ${JSON.stringify(prereq)}`,
            );
          }
        }
        break;
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `definition validation failed (${String(errors.length)}):\n  - ${errors.join("\n  - ")}`,
    );
  }
  return { units, buildings, techs, recipes, victoryPaths };
}

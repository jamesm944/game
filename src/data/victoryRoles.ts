/**
 * §2.11 victory-role definition lookup — M4-T4 + M4-T5.
 *
 * The SPEC table pins every threshold/rate to Entity-definition JSON:
 * the completing-act buildings (Grand Academy / Grand Monument) declare
 * `sustainPerMin` + `holdTicks`, the generators (School / Monument)
 * their yields and festival economics. These helpers resolve that table
 * once per process — definitions are static content — so the evaluators
 * and generator systems never hardcode a number.
 */

import { BUILDING_DEFINITIONS } from "./definitions";
import type { BuildingDefinition, VictoryRole } from "./schema";

/** Buildings whose §2.11 role serves `path`, ascending by def id. */
export function buildingDefsForVictoryPath(
  path: VictoryRole["path"],
): BuildingDefinition[] {
  return [...BUILDING_DEFINITIONS.values()]
    .filter((def) => def.victory?.path === path)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The path's completing-act definition — the one carrying the gate
 * (sustainPerMin + holdTicks on Knowledge/Culture, holdTicks alone on
 * the M4-T5 hold-only Wonder/Monastery). Undefined while the content
 * set ships no such building (the path stays un-winnable but harmless).
 */
export function completingActDefOf(
  path: VictoryRole["path"],
): BuildingDefinition | undefined {
  return buildingDefsForVictoryPath(path).find(
    (def) =>
      def.victory?.sustainPerMin !== undefined ||
      def.victory?.holdTicks !== undefined,
  );
}

/** The path's generator defs (School, Monument …), ascending by id. */
export function generatorDefsOf(
  path: VictoryRole["path"],
): BuildingDefinition[] {
  return buildingDefsForVictoryPath(path).filter(
    (def) =>
      def.victory?.knowledgePerLesson !== undefined ||
      def.victory?.prestigePerMin !== undefined,
  );
}

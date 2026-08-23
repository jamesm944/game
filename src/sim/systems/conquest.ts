/**
 * Conquest victory metrics — SPEC §2.11 / M2-T7.
 *
 * The Conquest path keys off "enemy military production capacity
 * destroyed": the live count of MILITARY PRODUCTION buildings per
 * player. Baseline content pins that set to the three §2.6 production
 * buildings that train military units — barracks, archery range,
 * stable — while everything else (houses, mills, camps, the town
 * center) is economic and never gates conquest.
 *
 * Pure read over Building rows: FINISHED buildings only (a construction
 * site produces nothing yet), owned exactly by `playerId`. Exported for
 * the T10 victory evaluator; destruction (M2-T7 combat pipeline) drops
 * counts automatically because despawn removes the Building row.
 */

import type { SimComponents } from "../components";
import { getBuildingRow } from "../components/buildings";
import { buildingIdOfCode } from "../../data/definitions";
import type { World } from "../core/world";

/** Definition ids that count as military production capacity. */
export const MILITARY_PRODUCTION_BUILDING_IDS: readonly string[] = [
  "archery-range",
  "barracks",
  "stable",
];

const MILITARY_IDS = new Set<string>(MILITARY_PRODUCTION_BUILDING_IDS);

/** Entity ids of `playerId`'s live military production buildings, ascending eid. */
export function militaryProductionBuildingsOf(
  world: World,
  comps: Pick<SimComponents, "buildingId">,
  playerId: number,
): number[] {
  const out: number[] = [];
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    if (!MILITARY_IDS.has(buildingIdOfCode(row[1]!))) continue;
    out.push(eid);
  }
  return out;
}

/** Live military-production building count for one player (§2.11 conquest). */
export function militaryProductionBuildingCount(
  world: World,
  comps: Pick<SimComponents, "buildingId">,
  playerId: number,
): number {
  return militaryProductionBuildingsOf(world, comps, playerId).length;
}

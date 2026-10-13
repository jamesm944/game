/**
 * Military unit line upgrades & field transformation — Issue #135 / U1.
 *
 * Implements AoE2-style unit line progression:
 *   - Militia -> Man-at-Arms -> Long Swordsman -> Two-Handed Swordsman
 *   - Archer -> Crossbowman -> Arbalest
 *   - Scout Cavalry -> Light Cavalry
 *   - Knight -> Cavalier -> Paladin
 *
 * When an upgrade tech completes:
 *   1. All active units in the simulation belonging to that player automatically
 *      transform into the upgraded variant, gaining HP bonuses and updated speed.
 *   2. Existing in-flight training queues across the player's production buildings
 *      upgrade in-place to the new variant.
 *   3. Garrisoned units inside towers, castles, or TCs update in-place.
 *   4. Production buildings update their trainable roster so only the active tier
 *      is trainable.
 */

import type { SimComponents } from "../components";
import { readTrainQueue, writeTrainQueue } from "../components/buildings";
import { readGarrison, writeGarrison } from "../components/garrison";
import { researchedTechCodesOf } from "../components/combat";
import { getAgeResearchRow } from "../components/age";
import { isDefAgeUnlocked, ageLabelOf } from "./age";
import { canAffordCosts } from "./costs";
import {
  TECH_DEFINITIONS,
  techCodeOf,
  techDefOf,
  techIdOfCode,
  unitCodeOf,
  unitDefOf,
} from "../../data/definitions";
import {
  AGE_RANK,
  type BuildingDefinition,
  type TechDefinition,
} from "../../data/schema";
import type { World } from "../core/world";

/**
 * Returns a map of fromUnitId -> toUnitId for all researched upgrade techs of a player.
 */
export function playerUpgradeChains(
  world: World,
  comps: Pick<SimComponents, "researchedTechsId" | "stockpileId">,
  playerId: number,
): Map<string, string> {
  const chains = new Map<string, string>();
  const codes = researchedTechCodesOf(world, comps, playerId);
  for (const code of codes) {
    const tech = techDefOf(techIdOfCode(code));
    if (tech.unitUpgrade) {
      chains.set(tech.unitUpgrade.fromUnitId, tech.unitUpgrade.toUnitId);
    }
  }
  return chains;
}

/**
 * Resolves a unit id to its highest upgraded variant unlocked by the player.
 */
export function resolveUpgradedUnitId(
  world: World,
  comps: Pick<SimComponents, "researchedTechsId" | "stockpileId">,
  playerId: number,
  unitId: string,
): string {
  const chains = playerUpgradeChains(world, comps, playerId);
  let current = unitId;
  const visited = new Set<string>();
  while (chains.has(current) && !visited.has(current)) {
    visited.add(current);
    current = chains.get(current)!;
  }
  return current;
}

/**
 * Finds the upgrade tech that unlocks `unitId`, if any.
 */
export function upgradeTechForUnit(unitId: string): TechDefinition | undefined {
  for (const tech of TECH_DEFINITIONS.values()) {
    if (tech.unitUpgrade?.toUnitId === unitId) {
      return tech;
    }
  }
  return undefined;
}

/**
 * Returns true if a unit tier is unlocked for a player.
 * Base units (not the result of an upgrade) are always unlocked.
 * Upgraded variants require their corresponding upgrade tech to be researched.
 */
export function isUnitTierUnlocked(
  world: World,
  comps: Pick<SimComponents, "researchedTechsId" | "stockpileId">,
  playerId: number,
  unitId: string,
): boolean {
  const reqTech = upgradeTechForUnit(unitId);
  if (!reqTech) return true; // Base unit
  const codes = researchedTechCodesOf(world, comps, playerId);
  return codes.includes(techCodeOf(reqTech.id));
}

/**
 * Returns the active trainable unit IDs for a production building for a specific player.
 * Automatically maps unit lines to their active researched tier and filters out unresearched advanced tiers.
 */
export function activeTrainableUnitsFor(
  world: World,
  comps: Pick<SimComponents, "researchedTechsId" | "stockpileId">,
  playerId: number,
  buildingDef: BuildingDefinition,
): string[] {
  if (!buildingDef.trainQueue) return [];
  const rawList = buildingDef.trainQueue.trainable.map((t) => t.unitId);
  const result: string[] = [];
  const seenLines = new Set<string>();

  for (const uId of rawList) {
    // If this unit is an upgraded variant whose tech is NOT researched, don't show it directly.
    if (
      upgradeTechForUnit(uId) &&
      !isUnitTierUnlocked(world, comps, playerId, uId)
    ) {
      continue;
    }
    // Resolve to the highest tier currently unlocked in this unit's line.
    const activeTier = resolveUpgradedUnitId(world, comps, playerId, uId);
    if (!seenLines.has(activeTier)) {
      seenLines.add(activeTier);
      result.push(activeTier);
    }
  }

  return result;
}

export interface UnitUpgradeResult {
  readonly unitsTransformed: number;
  readonly queuesUpdated: number;
  readonly garrisonsUpdated: number;
}

/**
 * Executes the in-place transformation of all existing units, queues, and garrisons
 * belonging to `playerId` from `fromUnitId` to `toUnitId`.
 */
export function applyUnitUpgrade(
  world: World,
  comps: SimComponents,
  playerId: number,
  fromUnitId: string,
  toUnitId: string,
): UnitUpgradeResult {
  const fromCode = unitCodeOf(fromUnitId);
  const toCode = unitCodeOf(toUnitId);
  const fromDef = unitDefOf(fromUnitId);
  const toDef = unitDefOf(toUnitId);
  const hpBonus = Math.max(0, toDef.hp - fromDef.hp);

  let unitsTransformed = 0;
  // 1. Transform field units (Combat + UnitTag components)
  const combatRows = world.rowsByComponentId.get(comps.combatId);
  if (combatRows) {
    for (const [eid, row] of combatRows) {
      if (row[1] === playerId && row[0] === fromCode) {
        row[0] = toCode;
        row[2] = Math.min(toDef.hp, row[2]! + hpBonus);
        const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(eid);
        if (tagRow) {
          tagRow[0] = toDef.speed;
        }
        unitsTransformed++;
      }
    }
  }

  let queuesUpdated = 0;
  // 2. Update production queues across this player's buildings
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  if (buildingRows && comps.trainQueueId !== undefined) {
    for (const [eid, bRow] of buildingRows) {
      if (bRow[0] === playerId) {
        const queue = readTrainQueue(world, comps, eid);
        let modified = false;
        for (const entry of queue) {
          if (entry.unitCode === fromCode) {
            (entry as { unitCode: number }).unitCode = toCode;
            modified = true;
            queuesUpdated++;
          }
        }
        if (modified) {
          writeTrainQueue(world, comps, eid, queue);
        }
      }
    }
  }

  let garrisonsUpdated = 0;
  // 3. Update garrisoned units
  if (comps.garrisonId !== undefined) {
    const garrisonRows = world.rowsByComponentId.get(comps.garrisonId);
    if (garrisonRows) {
      for (const [eid] of garrisonRows) {
        const units = readGarrison(world, comps, eid);
        let modified = false;
        for (const u of units) {
          if (u.owner === playerId && u.unitCode === fromCode) {
            (u as { unitCode: number }).unitCode = toCode;
            (u as { hp: number }).hp = Math.min(toDef.hp, u.hp + hpBonus);
            (u as { maxHp: number }).maxHp = toDef.hp;
            modified = true;
            garrisonsUpdated++;
          }
        }
        if (modified) {
          writeGarrison(world, comps, eid, units);
        }
      }
    }
  }

  return { unitsTransformed, queuesUpdated, garrisonsUpdated };
}

export interface BuildingPanelTechOption {
  readonly techId: string;
  readonly name: string;
  readonly costString: string;
  readonly ageRequirement: string;
  readonly isResearched: boolean;
  readonly isResearching: boolean;
  readonly canResearch: boolean;
  readonly reasonDisabled?: string | undefined;
}

export interface BuildingPanelResearchStatus {
  readonly techId: string;
  readonly techName: string;
  readonly remainingTicks: number;
  readonly totalTicks: number;
  readonly progress01: number;
}

/**
 * Returns in-flight research status for a building, if any.
 */
export function buildingActiveResearch(
  world: World,
  comps: Pick<SimComponents, "ageResearchId">,
  buildingEid: number,
): BuildingPanelResearchStatus | undefined {
  const row = getAgeResearchRow(world, comps, buildingEid);
  if (!row) return undefined;
  const techId = techIdOfCode(row[1]!);
  const tech = techDefOf(techId);
  const remainingTicks = row[2]!;
  const totalTicks = tech.researchTime;
  const progress01 =
    totalTicks > 0
      ? Math.max(0, Math.min(1, 1 - remainingTicks / totalTicks))
      : 1;
  return {
    techId,
    techName: tech.name,
    remainingTicks,
    totalTicks,
    progress01,
  };
}

/**
 * Generates the full set of research options for a building (e.g. Blacksmith, Barracks, Range, Stable).
 */
export function buildingTechOptions(
  world: World,
  comps: Pick<
    SimComponents,
    "ageResearchId" | "ageStateId" | "researchedTechsId" | "stockpileId"
  >,
  playerId: number,
  buildingEid: number,
  buildingDef: BuildingDefinition,
): BuildingPanelTechOption[] {
  const options: BuildingPanelTechOption[] = [];
  const researchedCodes =
    comps.researchedTechsId !== undefined
      ? researchedTechCodesOf(world, comps, playerId)
      : [];
  const activeRow = getAgeResearchRow(world, comps, buildingEid);
  const activeTechCode = activeRow ? activeRow[1] : undefined;

  for (const tech of TECH_DEFINITIONS.values()) {
    if (tech.buildingId !== buildingDef.id) continue;
    const tCode = techCodeOf(tech.id);
    const isResearched = researchedCodes.includes(tCode);
    const isResearching = activeTechCode === tCode;
    const isAgeUnlocked = isDefAgeUnlocked(
      world,
      comps,
      playerId,
      tech.ageGate,
    );
    let prereqsMet = true;
    for (const prereqId of tech.techPrereqs) {
      if (!researchedCodes.includes(techCodeOf(prereqId))) {
        prereqsMet = false;
        break;
      }
    }
    const costParts: string[] = [];
    if (tech.costs.food) costParts.push(`${String(tech.costs.food)} food`);
    if (tech.costs.wood) costParts.push(`${String(tech.costs.wood)} wood`);
    if (tech.costs.gold) costParts.push(`${String(tech.costs.gold)} gold`);
    if (tech.costs.stone) costParts.push(`${String(tech.costs.stone)} stone`);
    const costStr = costParts.length > 0 ? costParts.join(" · ") : "free";

    const canAfford = canAffordCosts(world, comps, playerId, tech.costs);
    const isBusy = activeRow !== undefined;

    let canResearch = false;
    let reasonDisabled: string | undefined;

    if (isResearched) {
      reasonDisabled = "Researched";
    } else if (isResearching) {
      reasonDisabled = "Research in progress";
    } else if (!isAgeUnlocked) {
      reasonDisabled = `Requires ${ageLabelOf(AGE_RANK[tech.ageGate])}`;
    } else if (!prereqsMet) {
      reasonDisabled = "Prerequisites not met";
    } else if (isBusy) {
      reasonDisabled = "Building is researching";
    } else if (!canAfford) {
      reasonDisabled = "Insufficient resources";
    } else {
      canResearch = true;
    }

    options.push({
      techId: tech.id,
      name: tech.name,
      costString: costStr,
      ageRequirement: ageLabelOf(AGE_RANK[tech.ageGate]),
      isResearched,
      isResearching,
      canResearch,
      reasonDisabled,
    });
  }

  // Sort by age rank ascending, then alphabetically by name
  options.sort((a, b) => {
    const techA = techDefOf(a.techId);
    const techB = techDefOf(b.techId);
    const rankDiff = AGE_RANK[techA.ageGate] - AGE_RANK[techB.ageGate];
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return options;
}

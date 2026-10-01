/**
 * Idle Worker Management & Smart Economic Redistribution — V15 / Issue #106.
 *
 * Provides:
 * 1. findIdleVillagers: fast scanning of living player villagers without assigned
 *    resource node, construction site, or pending activity queue.
 * 2. smartRedistributeIdleWorkers: 1-click intelligent economic dispatch that
 *    calculates resource deficits from age-appropriate weights and assigns idle
 *    workers to nearest under-saturated nodes (wood, food, gold, stone).
 */

import { ownerOfUnit } from "../components/owner";
import { PLAYER_ONE } from "../core/stockpile";
import {
  getAssignedNode,
  RESOURCE_FOOD,
  RESOURCE_WOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_NAMES,
  WORK_SLOTS_PER_NODE,
} from "../components/economy";
import { getAssignedSite } from "../components/buildings";
import { readActivityQueue, type SimComponents } from "../components";
import { peekActivity } from "../activities";
import { unitIdOfCode } from "../../data/definitions";
import { currentAgeRankOf } from "../systems/age";
import type { World } from "../core/world";

/**
 * Returns entity IDs of living villagers owned by playerId that have
 * no current work assignments or pending activities.
 */
export function findIdleVillagers(
  world: World,
  comps: SimComponents,
  playerId: number = PLAYER_ONE,
): number[] {
  const idle: number[] = [];
  const combatRows = world.rowsByComponentId.get(comps.combatId);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!combatRows || !posRows) return idle;

  for (const eid of world.entities) {
    if (ownerOfUnit(world, comps, eid) !== playerId) continue;
    const combatRow = combatRows.get(eid);
    if (!combatRow || unitIdOfCode(combatRow[0]!) !== "villager") continue;
    if (!posRows.has(eid)) continue;

    // Check assignments and activity queue
    if (getAssignedNode(world, comps, eid) !== undefined) continue;
    if (getAssignedSite(world, comps, eid) !== undefined) continue;
    const queue = readActivityQueue(world, comps, eid);
    if (peekActivity(queue) !== undefined) continue;

    idle.push(eid);
  }
  return idle;
}

export interface RedistributionResult {
  readonly total: number;
  readonly byResource: Record<string, number>;
  readonly assignedEids: number[];
}

/**
 * Intelligently distributes idle villagers across available resource nodes
 * based on age-tiered target gather weights and node saturation.
 */
export function smartRedistributeIdleWorkers(
  world: World,
  comps: SimComponents,
  playerId: number = PLAYER_ONE,
): RedistributionResult {
  const idle = findIdleVillagers(world, comps, playerId);
  if (idle.length === 0) {
    return { total: 0, byResource: {}, assignedEids: [] };
  }

  // Determine target gather weights based on player's current age
  const ageRank = currentAgeRankOf(world, comps, playerId);
  const weights: Record<number, number> =
    ageRank === 1
      ? { [RESOURCE_FOOD]: 0.55, [RESOURCE_WOOD]: 0.35, [RESOURCE_GOLD]: 0.1 }
      : ageRank === 2
        ? { [RESOURCE_FOOD]: 0.45, [RESOURCE_WOOD]: 0.35, [RESOURCE_GOLD]: 0.2 }
        : ageRank === 3
          ? {
              [RESOURCE_FOOD]: 0.35,
              [RESOURCE_WOOD]: 0.3,
              [RESOURCE_GOLD]: 0.25,
              [RESOURCE_STONE]: 0.1,
            }
          : {
              [RESOURCE_FOOD]: 0.3,
              [RESOURCE_WOOD]: 0.35,
              [RESOURCE_GOLD]: 0.25,
              [RESOURCE_STONE]: 0.1,
            };

  const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
  if (!nodeRows) return { total: 0, byResource: {}, assignedEids: [] };

  const nodeResource = new Map<number, number>();
  const workersOnNode = new Map<number, number>();

  for (const [nodeEid, row] of nodeRows) {
    if (row[1]! <= 0) continue; // depleted
    nodeResource.set(nodeEid, row[0]!);
    workersOnNode.set(nodeEid, 0);
  }

  // Count current workers assigned to each resource
  const workersByResource = new Map<number, number>([
    [RESOURCE_FOOD, 0],
    [RESOURCE_WOOD, 0],
    [RESOURCE_GOLD, 0],
    [RESOURCE_STONE, 0],
  ]);

  const combatRows = world.rowsByComponentId.get(comps.combatId);
  for (const eid of world.entities) {
    if (ownerOfUnit(world, comps, eid) !== playerId) continue;
    const combatRow = combatRows?.get(eid);
    if (!combatRow || unitIdOfCode(combatRow[0]!) !== "villager") continue;

    const assignment = getAssignedNode(world, comps, eid);
    if (assignment) {
      const res = nodeResource.get(assignment.nodeEid);
      if (res !== undefined) {
        workersByResource.set(res, (workersByResource.get(res) ?? 0) + 1);
        workersOnNode.set(
          assignment.nodeEid,
          (workersOnNode.get(assignment.nodeEid) ?? 0) + 1,
        );
      }
    }
  }

  // Calculate deficits
  const totalWorkers =
    [...workersByResource.values()].reduce((a, b) => a + b, 0) + idle.length;

  const deficits = Object.entries(weights)
    .map(([resStr, weight]) => {
      const res = Number(resStr);
      return {
        resource: res,
        deficit:
          Math.round(weight * totalWorkers) - (workersByResource.get(res) ?? 0),
      };
    })
    .sort((a, b) => b.deficit - a.deficit || a.resource - b.resource);

  // For each idle worker, find the best under-saturated node
  const posRows = world.rowsByComponentId.get(comps.positionId);
  const byResourceCounts: Record<string, number> = {};
  const assignedEids: number[] = [];

  for (const villagerEid of idle) {
    const vPos = posRows?.get(villagerEid);
    const originX = vPos ? vPos[0]! : 0;
    const originY = vPos ? vPos[1]! : 0;

    let chosenNodeEid: number | undefined;
    let chosenResource: number | undefined;

    for (const { resource } of deficits) {
      let bestNode: number | undefined;
      let bestD = Number.POSITIVE_INFINITY;
      let bestWorkerCount = Number.POSITIVE_INFINITY;

      for (const [nodeEid, res] of nodeResource) {
        if (res !== resource) continue;
        const nodeRow = nodeRows.get(nodeEid);
        if (!nodeRow || nodeRow[1]! <= 0) continue;
        const cap = nodeRow[2] ?? WORK_SLOTS_PER_NODE;
        const currentWorkers = workersOnNode.get(nodeEid) ?? 0;
        if (currentWorkers >= cap) continue;

        const nodePos = posRows?.get(nodeEid);
        if (!nodePos) continue;
        const d = (nodePos[0]! - originX) ** 2 + (nodePos[1]! - originY) ** 2;

        if (
          currentWorkers < bestWorkerCount ||
          (currentWorkers === bestWorkerCount && d < bestD)
        ) {
          bestNode = nodeEid;
          bestWorkerCount = currentWorkers;
          bestD = d;
        }
      }

      if (bestNode !== undefined) {
        chosenNodeEid = bestNode;
        chosenResource = resource;
        break;
      }
    }

    if (chosenNodeEid !== undefined && chosenResource !== undefined) {
      world.inbox.submit({
        kind: "gather",
        targetTick: world.tick + 1,
        data: { entityIds: [villagerEid], nodeId: chosenNodeEid },
      });

      workersOnNode.set(
        chosenNodeEid,
        (workersOnNode.get(chosenNodeEid) ?? 0) + 1,
      );
      workersByResource.set(
        chosenResource,
        (workersByResource.get(chosenResource) ?? 0) + 1,
      );

      const resName = RESOURCE_NAMES[chosenResource] ?? "resource";
      byResourceCounts[resName] = (byResourceCounts[resName] ?? 0) + 1;
      assignedEids.push(villagerEid);
    }
  }

  return {
    total: assignedEids.length,
    byResource: byResourceCounts,
    assignedEids,
  };
}

/**
 * Format a human-readable feedback toast message summarizing redistribution.
 * e.g. "3 idle workers dispatched to wood (2) and food (1)"
 */
export function formatRedistributionMessage(res: RedistributionResult): string {
  if (res.total === 0) {
    return "No idle workers to redistribute";
  }
  const workerWord = res.total === 1 ? "idle worker" : "idle workers";
  const parts = Object.entries(res.byResource)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([r, count]) => `${r} (${String(count)})`);
  if (parts.length === 0) {
    return `${String(res.total)} ${workerWord} dispatched`;
  }
  return `⚡ ${String(res.total)} ${workerWord} dispatched to ${parts.join(" and ")}`;
}

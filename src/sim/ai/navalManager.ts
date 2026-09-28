/**
 * Naval Fleet Manager — Milestone N6 (Issue #115 / Epic #84).
 *
 * Supplements the scripted build-order layer with autonomous naval fleet
 * management. Runs inside the planner's full-pass as an additional query
 * AFTER the economy and build-order passes, so it shares the same
 * ResourceBudget and only spends resources the other layers have left.
 *
 * Responsibilities:
 * 1. **Fishing Boat production**: If the AI has a finished Dock but fewer
 *    than FISHING_BOAT_TARGET fishing boats (alive + queued), train one.
 *    This feeds the food economy without land-gatherer pressure.
 * 2. **Warship training**: If an enemy unit is visible on water and the AI
 *    has fewer than WARSHIP_TARGET warships, train a Galley (Feudal/Castle)
 *    or War Galley (Castle+). Uses the same `trainArmy` approach as the
 *    build-order layer but evaluates continuously rather than once via a
 *    scripted step.
 *
 * Design constraints:
 * - Emits AT MOST ONE command per call (like all other sub-planners).
 * - Reads only the `AiKnowledge` seam — no direct world/component access.
 * - Zero Three.js; pure deterministic sim logic.
 */

import type { AiKnowledge, ResourceBudget } from "./knowledge";
import type { CommandDraft } from "./buildOrder";
import { UNIT_DEF_CODES, unitDefOf } from "../../data/definitions";

/** Max Fishing Boats per AI player in a default skirmish. */
export const FISHING_BOAT_TARGET = 3;

/** Max active warships per AI player before the manager stops training. */
export const WARSHIP_TARGET = 4;

/**
 * Count living units of `unitId` in the AI's knowledge, plus any queued
 * in owned buildings — so we don't over-order while units are training.
 */
export function countNavalUnit(k: AiKnowledge, unitId: string): number {
  let n = 0;
  // Living units (fishing boats are in armyUnits for army/pop tracking)
  for (const u of k.armyUnits()) {
    if (u.defId === unitId) n += 1;
  }
  // Queued in any finished building's train queue
  for (const eid of k.finishedBuildings()) {
    for (const id of k.trainQueueOf(eid)) {
      if (id === unitId) n += 1;
    }
  }
  return n;
}

/**
 * Try to train `unitId` from an owned Dock that can enqueue it right now.
 * Returns a `trainUnit` CommandDraft or undefined if blocked.
 */
function tryTrainFrom(
  k: AiKnowledge,
  budget: ResourceBudget,
  unitId: string,
): CommandDraft | undefined {
  const def = unitDefOf(unitId);
  if (!budget.afford(def.costs)) return undefined;
  for (const eid of k.finishedBuildings("dock")) {
    if (!k.trainableUnitIds(eid).includes(unitId)) continue;
    if (!k.canTrain(eid, unitId)) continue;
    budget.debit(def.costs);
    return {
      kind: "trainUnit",
      data: { siteEid: eid, unitId },
    };
  }
  return undefined;
}

/**
 * Naval fleet planner. Call once per full planning pass, AFTER economy
 * and build-order planners have run, sharing their ResourceBudget.
 *
 * Priority order (first non-undefined draft wins):
 * 1. Train a Fishing Boat if below FISHING_BOAT_TARGET.
 * 2. Train a warship (galley/war-galley/galleon) if below WARSHIP_TARGET and
 *    enemy presence in water is visible.
 * 3. Assign idle fishing boats to gather from known food nodes (fish).
 *
 * Returns the first draft that can be emitted, or undefined.
 */
export function planNavalFleet(
  k: AiKnowledge,
  budget: ResourceBudget,
  drafts: CommandDraft[],
): void {
  // No dock → nothing to do.
  if (k.finishedBuildings("dock").length === 0) return;

  // 1. Fishing boat income: below cap → train one.
  const fishingBoats = countNavalUnit(k, "fishing-boat");
  if (fishingBoats < FISHING_BOAT_TARGET) {
    const draft = tryTrainFrom(k, budget, "fishing-boat");
    if (draft !== undefined) {
      drafts.push(draft);
      return; // one command per pass
    }
  }

  // 2. Warship training: only if an enemy is visible on water or has naval threat.
  const hasVisibleNavalEnemy = k.visibleEnemies().some((e) => {
    if (e.defId === "dock") return true;
    if (!UNIT_DEF_CODES.has(e.defId)) return false;
    return unitDefOf(e.defId).armorClasses.includes("ship");
  });

  if (hasVisibleNavalEnemy) {
    const warshipCount =
      countNavalUnit(k, "galley") +
      countNavalUnit(k, "war-galley") +
      countNavalUnit(k, "galleon") +
      countNavalUnit(k, "fire-ship") +
      countNavalUnit(k, "cannon-galleon");

    if (warshipCount < WARSHIP_TARGET) {
      // Prefer Galleon at Imperial Age+, War Galley at Castle Age+, fall back to Galley.
      const warshipId =
        k.ageRank() >= 4
          ? "galleon"
          : k.ageRank() >= 3
            ? "war-galley"
            : "galley";
      const draft = tryTrainFrom(k, budget, warshipId);
      if (draft !== undefined) {
        drafts.push(draft);
        return;
      }
    }
  }

  // 3. Idle Fishing Boat assignment: dispatch idle fishing boat to nearest known food node
  for (const u of k.armyUnits()) {
    if (u.defId === "fishing-boat" && k.assignmentOf(u.eid) === undefined) {
      const foodNodes = k.knownNodes(0).filter((n) => n.remaining > 0);
      if (foodNodes.length > 0) {
        let bestNode = foodNodes[0]!;
        let bestDist = Infinity;
        for (const node of foodNodes) {
          const dist = Math.hypot(node.tileX - u.tileX, node.tileY - u.tileY);
          if (dist < bestDist) {
            bestDist = dist;
            bestNode = node;
          }
        }
        drafts.push({
          kind: "gather",
          data: { entityIds: [u.eid], nodeId: bestNode.eid },
        });
        return;
      }
    }
  }
}

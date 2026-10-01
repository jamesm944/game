/**
 * Sim→audio bridge (render side): polls digest-visible sim event rows for NEW
 * entries since the last polled tick and maps them to audio intents. Read-only
 * against sim state — determinism untouched (SPEC §2.10). Lives in src/audio,
 * not src/sim, so the ADR-0001 seam stays one-directional.
 */

import {
  readCombatEvents,
  COMBAT_EVENT_DAMAGE,
} from "../sim/components/combat";
import { readAgeAdvancedEvents } from "../sim/components/age";
import type { SimComponents } from "../sim/components";
import type { World } from "../sim/core/world";
import type { AudioIntent } from "./intents";
import {
  RESOURCE_WOOD,
  RESOURCE_GOLD,
  RESOURCE_CLAY,
} from "../sim/components/economy";

const COMBAT_EVENT_DEATH_KINDS = new Set([1, 2, 3]);

function worldXOf(
  world: World,
  comps: SimComponents,
  eid: number,
): number | undefined {
  const row = world.rowsByComponentId.get(comps.positionId)?.get(eid);
  return row ? row[0] : undefined;
}

export function collectAudioIntents(
  world: World,
  comps: SimComponents,
  playerId: number,
  sinceTick: number,
): readonly AudioIntent[] {
  const intents: AudioIntent[] = [];
  try {
    for (const e of readCombatEvents(world, comps, playerId)) {
      if (e.tick <= sinceTick) continue;
      const worldX = worldXOf(world, comps, e.victimEid);
      const position = worldX !== undefined ? { worldX } : {};
      if (e.kind === COMBAT_EVENT_DAMAGE) {
        intents.push({ clip: "combat.strike", ...position, priority: 1 });
      } else if (COMBAT_EVENT_DEATH_KINDS.has(e.kind)) {
        intents.push({ clip: "combat.death", ...position, priority: 5 });
      }
    }
  } catch {
    /* ledger entity absent in minimal worlds */
  }

  // Age advancement events (V13, #98)
  try {
    for (const e of readAgeAdvancedEvents(world, comps, playerId)) {
      if (e.tick > sinceTick) {
        intents.push({ clip: "age.up", priority: 10 });
      }
    }
    // Opponent / AI age-ups: distinct tone (lower pitch: 0.82)
    const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
    if (stockpileRows) {
      for (const row of stockpileRows.values()) {
        const otherPlayer = row[0];
        if (otherPlayer !== undefined && otherPlayer !== playerId) {
          for (const e of readAgeAdvancedEvents(world, comps, otherPlayer)) {
            if (e.tick > sinceTick) {
              intents.push({ clip: "age.up", pitch: 0.82, priority: 8 });
            }
          }
        }
      }
    }
  } catch {
    /* age/stockpile components absent in minimal test worlds */
  }

  // Sample ambient villager work activity for the viewer player
  try {
    const ownerRows = comps.ownerId
      ? world.rowsByComponentId.get(comps.ownerId)
      : undefined;
    const assignedNodeRows = comps.assignedNodeId
      ? world.rowsByComponentId.get(comps.assignedNodeId)
      : undefined;
    const resourceNodeRows = comps.resourceNodeId
      ? world.rowsByComponentId.get(comps.resourceNodeId)
      : undefined;
    const assignedSiteRows = comps.assignedSiteId
      ? world.rowsByComponentId.get(comps.assignedSiteId)
      : undefined;

    if (assignedNodeRows && resourceNodeRows) {
      for (const [eid, row] of assignedNodeRows.entries()) {
        if (ownerRows?.get(eid)?.[0] !== playerId) continue;
        // Stagger strikes every ~30 ticks per worker
        if ((world.tick + eid * 7) % 30 !== 0) continue;
        const nodeEid = row[0];
        if (nodeEid === undefined || nodeEid < 0) continue;
        const resCode = resourceNodeRows.get(nodeEid)?.[0];
        const worldX = worldXOf(world, comps, eid);
        const position = worldX !== undefined ? { worldX } : {};
        if (resCode === RESOURCE_WOOD) {
          intents.push({ clip: "act.chop", ...position, priority: 1 });
        } else if (
          resCode !== undefined &&
          resCode >= RESOURCE_GOLD &&
          resCode <= RESOURCE_CLAY
        ) {
          intents.push({ clip: "act.mine", ...position, priority: 1 });
        }
      }
    }

    if (assignedSiteRows) {
      for (const [eid] of assignedSiteRows.entries()) {
        if (ownerRows?.get(eid)?.[0] !== playerId) continue;
        // Stagger construction strikes every ~35 ticks per builder
        if ((world.tick + eid * 11) % 35 !== 0) continue;
        const worldX = worldXOf(world, comps, eid);
        const position = worldX !== undefined ? { worldX } : {};
        intents.push({ clip: "act.build", ...position, priority: 1 });
      }
    }
  } catch {
    /* components absent in minimal test worlds */
  }

  return intents;
}

/** Day/night clock: 8-min day @30Hz → 10 ticks per sim minute, offset 7:00 AM. */
export function minuteOfDay(tick: number): number {
  return (Math.floor(tick / 10) + 420) % 1440;
}

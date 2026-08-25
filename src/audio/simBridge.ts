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
import type { SimComponents } from "../sim/components";
import type { World } from "../sim/core/world";
import type { AudioIntent } from "./intents";

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
  return intents;
}

/** Day/night clock: 8-min day @30Hz → 10 ticks per sim minute. */
export function minuteOfDay(tick: number): number {
  return Math.floor(tick / 10) % 1440;
}

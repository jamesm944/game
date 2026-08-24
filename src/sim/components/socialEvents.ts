/**
 * SocialEvents component — SPEC §2.4 social life / M3-T7 (issue #52).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/pop sets; registration is one strictly alphabetical sequence
 * (components/index.ts defineSimComponents), pinning digest/save
 * iteration order forever (world.ts). SocialEvents slots between Skills
 * and Stockpile.
 *
 * Append-only per-player event log on the player's ledger entity — the
 * CombatEvents shape exactly: SocialEvents (variable):
 * [entryCount, tick₀, kind₀, actorEid₀, targetEid₀, amount₀, …].
 * M3-T7 kinds: VISIT (a completed leisure visit; amount = bond delta,
 * or −gold spent at pay venues), JEALOUSY (discovered brothel visit:
 * spouse morale shock + relationship damage), RIVAL_FORMED (a pair's
 * bond crossed the rival threshold downward). M3-T8 adds MASS (a
 * completed Sunday Morning Mass attendance; amount = co-attendees
 * bonded with). Every event is digest-visible by construction, so
 * golden digests pin the village's social drama for free.
 */

import type { ComponentRows, World } from "../core/world";

export const SOCIAL_EVENTS = "SocialEvents" as const;

/**
 * Variable-length log rows (CombatEvents shape): the arity table lists
 * -1 to mark the count-led variable layout.
 */
export const SOCIAL_EVENTS_ARITY = -1;

/** Component ids the social system reads/writes. */
export interface SocialEventComponents {
  readonly socialEventsId: number;
}

/** SocialEvents entry kinds — stable u8 codes, never renumbered. */
export const SOCIAL_EVENT_VISIT = 0;
export const SOCIAL_EVENT_JEALOUSY = 1;
export const SOCIAL_EVENT_RIVAL_FORMED = 2;
export const SOCIAL_EVENT_MASS = 3;

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** One digest-visible social event. */
export interface SocialEvent {
  readonly tick: number;
  readonly kind: number;
  readonly actorEid: number;
  readonly targetEid: number;
  readonly amount: number;
}

function requirePlayerLedgerEid(
  world: World,
  stockpileId: number,
  playerId: number,
): number {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `player id must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  for (const [eid, row] of requireRows(world, stockpileId)) {
    if (row[0] === playerId) return eid;
  }
  throw new Error(`player ${String(playerId)} has no stockpile entity`);
}

/** Append one social event to `playerId`'s log on their ledger entity. */
export function appendSocialEvent(
  world: World,
  comps: Pick<SocialEventComponents, "socialEventsId"> & {
    stockpileId: number;
  },
  playerId: number,
  event: SocialEvent,
): void {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.socialEventsId);
  const row = rows.get(eid);
  const next = row ? [...row] : [0];
  next.push(
    event.tick,
    event.kind,
    event.actorEid,
    event.targetEid,
    event.amount,
  );
  next[0] = (next[0] ?? 0) + 1;
  rows.set(eid, next);
}

/** Decoded copy of one player's social events (fresh array each call). */
export function readSocialEvents(
  world: World,
  comps: Pick<SocialEventComponents, "socialEventsId"> & {
    stockpileId: number;
  },
  playerId: number,
): SocialEvent[] {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const row = world.rowsByComponentId.get(comps.socialEventsId)?.get(eid);
  if (!row) return [];
  const events: SocialEvent[] = [];
  for (let i = 0; i < row[0]!; i++) {
    events.push({
      tick: row[1 + i * 5]!,
      kind: row[2 + i * 5]!,
      actorEid: row[3 + i * 5]!,
      targetEid: row[4 + i * 5]!,
      amount: row[5 + i * 5]!,
    });
  }
  return events;
}

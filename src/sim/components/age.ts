/**
 * Age advancement component definitions — SPEC §2.11 / M2-T4.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/building/production sets; registration is one
 * strictly alphabetical sequence (components/index.ts
 * defineSimComponents), pinning digest/save iteration order forever
 * (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - AgeState (2): [ownerPlayerId, ageRank] — one row per player,
 *   attached to the SAME entity as the player's Stockpile rows
 *   (mirroring CommodityStockpile co-location). ageRank uses the
 *   AGE_RANK scale from data/schema.ts: 1=dark … 4=imperial.
 * - AgeResearch (3): [ownerPlayerId, techCode, remainingTicks] — the
 *   in-flight age advance on its researching building; mirrors
 *   ProductionCycle. techCode is the stable numeric code over the
 *   loaded tech set (data/definitions.ts, ascending slug).
 * - AgeAdvanced (variable): [entryCount, tick₀, ageRank₀, …] —
 *   append-only per-player event log written exactly when an advance
 *   completes inside step(); the audio bus's age-up jingle hook and
 *   victory evaluators read these rows instead of re-deriving history
 *   (SPEC §2.10 event-bus posture).
 * - GateRejected (variable): [entryCount, tick₀, handler₀, defCode₀,
 *   …] — append-only per-player log of every polite age-gate refusal
 *   across the place/train/research command handlers. `handler` is a
 *   GATE_HANDLER_* code; defCode lives in the handler's own family
 *   code space (building/unit/tech codes).
 */

import type { ComponentRows, World } from "../core/world";

export const AGE_ADVANCED = "AgeAdvanced" as const;
export const AGE_RESEARCH = "AgeResearch" as const;
export const AGE_STATE = "AgeState" as const;
export const GATE_REJECTED = "GateRejected" as const;

/** Row arity per age component — pinned for digest stability. */
export const AGE_COMPONENT_ARITIES: readonly [string, number][] = [
  [AGE_ADVANCED, -1], // variable-length event log
  [AGE_RESEARCH, 3],
  [AGE_STATE, 2],
  [GATE_REJECTED, -1], // variable-length rejection log
];

/** Which command handler produced a GateRejected entry. */
export const GATE_HANDLER_PLACE = 0;
export const GATE_HANDLER_TRAIN = 1;
export const GATE_HANDLER_RESEARCH = 2;

/** Starting rank of every player: SPEC §2.11 ladder bottom. */
export const AGE_DARK_RANK = 1;

/** Component ids the age systems read/write. */
export interface AgeComponents {
  readonly ageAdvancedId: number;
  readonly ageResearchId: number;
  readonly ageStateId: number;
  readonly gateRejectedId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Player state rows ------------------------------------------------------------

function requirePlayerEid(
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

/**
 * Attach dark-age AgeState to the player's existing ledger entity —
 * ages ride the same one-entity-per-player discipline as commodity
 * stockpiles. Throws when no Stockpile row exists yet; call it right
 * after createPlayerStockpile.
 */
export function createPlayerAgeState(
  world: World,
  comps: Pick<AgeComponents, "ageStateId"> & { stockpileId: number },
  playerId: number,
): void {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  requireRows(world, comps.ageStateId).set(eid, [playerId, AGE_DARK_RANK]);
}

/** Live age rank for `playerId`, or undefined before any age state exists. */
export function ageRankOf(
  world: World,
  comps: Pick<AgeComponents, "ageStateId">,
  playerId: number,
): number | undefined {
  const rows = world.rowsByComponentId.get(comps.ageStateId);
  if (!rows) return undefined;
  for (const row of rows.values()) {
    if (row[0] === playerId) return row[1];
  }
  return undefined;
}

/** Promote `playerId` to `rank` (creating the row when absent). */
export function setPlayerAgeRank(
  world: World,
  comps: Pick<AgeComponents, "ageStateId"> & { stockpileId: number },
  playerId: number,
  rank: number,
): void {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  requireRows(world, comps.ageStateId).set(eid, [playerId, rank]);
}

// ---- AgeResearch -------------------------------------------------------------------

/** Live AgeResearch row for `eid`, or undefined when not researching. */
export function getAgeResearchRow(
  world: World,
  comps: Pick<AgeComponents, "ageResearchId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.ageResearchId)?.get(eid);
}

/** Open (or reset) one building's in-flight advance. */
export function setAgeResearchRow(
  world: World,
  comps: Pick<AgeComponents, "ageResearchId">,
  eid: number,
  playerId: number,
  techCode: number,
  remainingTicks: number,
): void {
  requireRows(world, comps.ageResearchId).set(eid, [
    playerId,
    techCode,
    remainingTicks,
  ]);
}

/** Clear the research row (advance completed or building lost). */
export function clearAgeResearchRow(
  world: World,
  comps: Pick<AgeComponents, "ageResearchId">,
  eid: number,
): boolean {
  return world.rowsByComponentId.get(comps.ageResearchId)?.delete(eid) ?? false;
}

// ---- Event logs ---------------------------------------------------------------------

/** One digest-visible age-up completion event (jingle hook, SPEC §2.10). */
export interface AgeAdvancedEvent {
  readonly tick: number;
  readonly ageRank: number;
}

/**
 * Append one ageAdvanced entry to the player's event log. Variable rows
 * encode [count, tick₀, ageRank₀, …] exactly like MealConsumed —
 * systems only ever append inside step(), so replays see every event.
 */
export function appendAgeAdvancedEvent(
  world: World,
  comps: Pick<AgeComponents, "ageAdvancedId"> & { stockpileId: number },
  playerId: number,
  event: AgeAdvancedEvent,
): void {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.ageAdvancedId);
  const row = rows.get(eid);
  const next = row ? [...row] : [0];
  next.push(event.tick, event.ageRank);
  next[0] = (next[0] ?? 0) + 1;
  rows.set(eid, next);
}

/** Decoded copy of one player's age-up events (fresh array each call). */
export function readAgeAdvancedEvents(
  world: World,
  comps: Pick<AgeComponents, "ageAdvancedId"> & { stockpileId: number },
  playerId: number,
): AgeAdvancedEvent[] {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  const row = world.rowsByComponentId.get(comps.ageAdvancedId)?.get(eid);
  if (!row) return [];
  const events: AgeAdvancedEvent[] = [];
  for (let i = 0; i < row[0]!; i++) {
    events.push({ tick: row[1 + i * 2]!, ageRank: row[2 + i * 2]! });
  }
  return events;
}

/** One digest-visible gate-rejection record. */
export interface GateRejectedEntry {
  readonly tick: number;
  /** GATE_HANDLER_* constant naming the refusing handler. */
  readonly handler: number;
  /** Def code within the handler's own family (building/unit/tech). */
  readonly defCode: number;
}

/** Append one gate-rejection entry to the player's log. */
export function appendGateRejection(
  world: World,
  comps: Pick<AgeComponents, "gateRejectedId"> & { stockpileId: number },
  playerId: number,
  entry: GateRejectedEntry,
): void {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.gateRejectedId);
  const row = rows.get(eid);
  const next = row ? [...row] : [0];
  next.push(entry.tick, entry.handler, entry.defCode);
  next[0] = (next[0] ?? 0) + 1;
  rows.set(eid, next);
}

/** Decoded copy of one player's gate rejections (fresh array each call). */
export function readGateRejections(
  world: World,
  comps: Pick<AgeComponents, "gateRejectedId"> & { stockpileId: number },
  playerId: number,
): GateRejectedEntry[] {
  const eid = requirePlayerEid(world, comps.stockpileId, playerId);
  const row = world.rowsByComponentId.get(comps.gateRejectedId)?.get(eid);
  if (!row) return [];
  const entries: GateRejectedEntry[] = [];
  for (let i = 0; i < row[0]!; i++) {
    entries.push({
      tick: row[1 + i * 3]!,
      handler: row[2 + i * 3]!,
      defCode: row[3 + i * 3]!,
    });
  }
  return entries;
}

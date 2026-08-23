/**
 * Combat component definitions — SPEC §2.5 / M2-T5.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/building/production sets; registration is one
 * strictly alphabetical sequence (components/index.ts
 * defineSimComponents), pinning digest/save iteration order forever
 * (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - Combat (5): [defCode, ownerPlayerId, hp, targetEid, cooldownTicks] —
 *   one row per attack-capable unit, attached ONLY by spawnCombatUnit
 *   (legacy M1 spawns carry no Combat row and stay untargetable until a
 *   later ticket migrates them). defCode is the stable numeric unit code
 *   from data/definitions.ts; targetEid 0 = disengaged; cooldownTicks
 *   counts down to the next strike. Derived stats (attack, armor per
 *   class, range…) are NEVER stored here — they compute on read in
 *   sim/combat/stats.ts from the definition plus researched techs
 *   (SPEC §2.5 "derived stats, never stored").
 * - CombatEvents (variable): [entryCount, tick₀, kind₀, attackerEid₀,
 *   victimEid₀, amount₀, …] — append-only per-player event log on the
 *   player's ledger entity (mirroring AgeAdvanced). kind codes:
 *   COMBAT_EVENT_DAMAGE / _DEATH (victim-owner log) and
 *   COMBAT_EVENT_SHOT (attacker-owner log, one per ranged strike — the
 *   projectile stub row M2-T6 upgrades into real flight). Every damage
 *   event is digest-visible by construction.
 * - ResearchedTechs (variable): [entryCount, techCode₀, …] — completed,
 *   stat-bearing techs per player on the same ledger entity. Stat
 *   derivation reads this set on every computation; rows never cache
 *   its effects.
 */

import { UNIT_DEF_CODES, unitCodeOf, unitDefOf } from "../../data/definitions";
import type { UnitDefinition } from "../../data/schema";
import { spawnEntity, type ComponentRows, type World } from "../core/world";

export const COMBAT = "Combat" as const;
export const COMBAT_EVENTS = "CombatEvents" as const;
export const RESEARCHED_TECHS = "ResearchedTechs" as const;

/** Row arity per combat component — pinned for digest stability.
 *  ResearchedTechs registers mid-production alphabetically (between
 *  ProductionJob and ResourceNode) but belongs to this family. */
export const COMBAT_COMPONENT_ARITIES: readonly [string, number][] = [
  [COMBAT, 5],
  [COMBAT_EVENTS, -1], // variable-length event log
  [RESEARCHED_TECHS, -1], // variable-length completed-tech list
];

/** Component ids the combat systems read/write. */
export interface CombatComponents {
  readonly combatId: number;
  readonly combatEventsId: number;
  /** Registered with the production family's arity table (see index.ts). */
  readonly researchedTechsId: number;
}

/** CombatEvents entry kinds — stable u8 codes, never renumbered. */
export const COMBAT_EVENT_DAMAGE = 0;
export const COMBAT_EVENT_DEATH = 1;
export const COMBAT_EVENT_SHOT = 2;

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Combatant rows -----------------------------------------------------------

export interface SpawnCombatUnitOptions {
  readonly turnRate?: number | undefined;
  readonly radius?: number | undefined;
}

/**
 * Spawn one attack-capable unit: the full movement component set plus a
 * Combat row carrying `def.hp` at full health. Cruise speed comes from
 * the definition (SPEC §3); `options` may override the movement-only
 * personality fields exactly like spawnUnit.
 */
export function spawnCombatUnit(
  world: World,
  comps: CombatComponents & {
    positionId: number;
    velocityId: number;
    unitTagId: number;
    moveTargetId: number;
    activityQueueId: number;
  },
  defId: string,
  x: number,
  y: number,
  playerId: number,
  options: SpawnCombatUnitOptions = {},
): number {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `combat unit owner must be a non-negative integer, got ${String(playerId)}`,
    );
  }
  const def = unitDefOf(defId);
  // Reuse the plain spawner for the movement set, pinning cruise speed
  // to the definition instead of the M1 constant.
  const eid = spawnEntity(world);
  const rows = (id: number, values: number[]): void => {
    setRowsById(world, id, eid, values);
  };
  rows(comps.positionId, [x, y]);
  rows(comps.velocityId, [0, 0, 0, 0, 0, 0, 0, 0]);
  const turnRate = options.turnRate ?? defaultTurnRateFor(world.seed, eid);
  rows(comps.unitTagId, [
    def.speed,
    turnRate,
    options.radius ?? DEFAULT_COMBAT_RADIUS,
  ]);
  rows(comps.moveTargetId, [x, y]);
  rows(comps.activityQueueId, [0]); // encoded empty queue
  rows(comps.combatId, [
    unitCodeOf(def.id),
    playerId,
    def.hp,
    0, // targetEid — disengaged
    0, // cooldownTicks — free to strike
  ]);
  // Fog dirty mark (SPEC §2.9): the unit's sight circle (from its
  // definition's sightRadius) stamps at the next tick-boundary flush.
  world.visibility.markDirty("spawned", eid);
  return eid;
}

/** Default body radius for combat units (matches the M1 villager value). */
export const DEFAULT_COMBAT_RADIUS = 0.25;

const TURN_RATE_HASH_MULTIPLIER = 0x9e3779b9;

/**
 * Turn-rate personality hash mirroring components/index.ts — kept local
 * so the combat spawner owns one self-contained deterministic default.
 */
function defaultTurnRateFor(seed: number, eid: number): number {
  let z = (seed ^ Math.imul(eid, TURN_RATE_HASH_MULTIPLIER)) >>> 0 || 0x1;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  const unit = ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  return 5.5 + unit * 3.0;
}

function setRowsById(
  world: World,
  componentId: number,
  eid: number,
  values: readonly number[],
): void {
  requireRows(world, componentId).set(eid, [...values]);
}

/** Live Combat row for `eid`, or undefined when not a combatant. */
export function getCombatRow(
  world: World,
  comps: Pick<CombatComponents, "combatId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.combatId)?.get(eid);
}

export function combatHpOf(
  world: World,
  comps: Pick<CombatComponents, "combatId">,
  eid: number,
): number | undefined {
  return getCombatRow(world, comps, eid)?.[2];
}

/** The unit definition behind a Combat row (via its stable def code). */
export function combatDefOf(
  world: World,
  comps: Pick<CombatComponents, "combatId">,
  eid: number,
): UnitDefinition | undefined {
  const row = getCombatRow(world, comps, eid);
  if (!row) return undefined;
  for (const [id, code] of UNIT_CODE_ENTRIES) {
    if (code === row[0]) return unitDefOf(id);
  }
  throw new Error(`unknown unit def code in Combat row: ${String(row[0])}`);
}

/** Def codes sorted ascending once — Combat-row decoding never re-sorts. */
const UNIT_CODE_ENTRIES: readonly (readonly [string, number])[] = [
  ...UNIT_DEF_CODES.entries(),
].sort((a, b) => a[1] - b[1]);

// ---- Per-player ledgers ---------------------------------------------------------

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

/** One digest-visible combat event (damage/death to victims, shots fired). */
export interface CombatEvent {
  readonly tick: number;
  readonly kind: number;
  readonly attackerEid: number;
  readonly victimEid: number;
  readonly amount: number;
}

/** Append one combat event to `playerId`'s log on their ledger entity. */
export function appendCombatEvent(
  world: World,
  comps: Pick<CombatComponents, "combatEventsId"> & { stockpileId: number },
  playerId: number,
  event: CombatEvent,
): void {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.combatEventsId);
  const row = rows.get(eid);
  const next = row ? [...row] : [0];
  next.push(
    event.tick,
    event.kind,
    event.attackerEid,
    event.victimEid,
    event.amount,
  );
  next[0] = (next[0] ?? 0) + 1;
  rows.set(eid, next);
}

/** Decoded copy of one player's combat events (fresh array each call). */
export function readCombatEvents(
  world: World,
  comps: Pick<CombatComponents, "combatEventsId"> & { stockpileId: number },
  playerId: number,
): CombatEvent[] {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const row = world.rowsByComponentId.get(comps.combatEventsId)?.get(eid);
  if (!row) return [];
  const events: CombatEvent[] = [];
  for (let i = 0; i < row[0]!; i++) {
    events.push({
      tick: row[1 + i * 5]!,
      kind: row[2 + i * 5]!,
      attackerEid: row[3 + i * 5]!,
      victimEid: row[4 + i * 5]!,
      amount: row[5 + i * 5]!,
    });
  }
  return events;
}

/** Record a completed stat-tech on the player's researched set. Idempotent. */
export function markTechResearched(
  world: World,
  comps: Pick<CombatComponents, "researchedTechsId"> & { stockpileId: number },
  playerId: number,
  techCode: number,
): void {
  const eid = requirePlayerLedgerEid(world, comps.stockpileId, playerId);
  const rows = requireRows(world, comps.researchedTechsId);
  const row = rows.get(eid);
  if (!row) {
    rows.set(eid, [1, techCode]);
    return;
  }
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    if (row[1 + i] === techCode) return;
  }
  row.push(techCode);
  row[0] = count + 1;
}

/** Sorted ascending copy of the player's completed tech codes. */
export function researchedTechCodesOf(
  world: World,
  comps: Pick<CombatComponents, "researchedTechsId"> & { stockpileId: number },
  playerId: number,
): number[] {
  // The ledger entity is located through the Stockpile rows (whose
  // leading column IS the owner); ResearchedTechs rows are count-led.
  const ownerEid = ledgerEidOf(world, comps.stockpileId, playerId);
  if (ownerEid === undefined) return [];
  const row = world.rowsByComponentId
    .get(comps.researchedTechsId)
    ?.get(ownerEid);
  if (!row) return [];
  return [...row.slice(1)].sort((a, b) => a - b);
}

/** Ledger entity carrying a player's per-player rows, if any. */
export function ledgerEidOf(
  world: World,
  stockpileId: number,
  playerId: number,
): number | undefined {
  for (const [eid, row] of requireRows(world, stockpileId)) {
    if (row[0] === playerId) return eid;
  }
  return undefined;
}

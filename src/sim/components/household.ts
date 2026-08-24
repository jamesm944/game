/**
 * Household component — SPEC §2.3 family/household / M3-T5 (issue #50).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Household slots between
 * GateRejected and Identity.
 *
 * One row per FAMILY, on its own dedicated entity (the "family entity").
 * Identity.familyId carries that entity id, so a Pop's parents resolve
 * as householdRowOf(familyId).headEid/partnerEid and its home as
 * homeEid — parent links are digest-visible rows, never hidden maps.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Household (6): [playerId, homeEid, headEid, partnerEid,
 * nextBirthRollTick, birthCount].
 *
 * - playerId: owning player (families never span players).
 * - homeEid: the finished house building this family lives in. Housing
 *   capacity is checked against ITS populationCap at formation and at
 *   every daily birth roll.
 * - headEid/partnerEid: the founding couple. Dead members leave stale
 *   eids here by design; households.ts validates liveness lazily on its
 *   daily pass (the same posture combat uses for target references).
 * - nextBirthRollTick: world tick of the family's next seeded daily
 *   birth roll (day-boundary aligned; systems/households.ts owns it).
 * - birthCount: babies born into this family — append-only evidence of
 *   the births-scale-with-housed-families rule, digest-visible for free.
 */

import { setIdentityFamilyId } from "./pop";
import { spawnEntity, type ComponentRows, type World } from "../core/world";

export const HOUSEHOLD = "Household" as const;

/** Row arity per household component — pinned for digest stability. */
export const HOUSEHOLD_ARITY = 6;

/** Component id the households system reads/writes. */
export interface HouseholdComponents {
  readonly householdId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

export interface SpawnHouseholdOptions {
  readonly playerId: number;
  /** Finished house building the family lives in. */
  readonly homeEid: number;
  readonly headEid: number;
  readonly partnerEid: number;
  /** Tick of the family's first daily birth roll. */
  readonly nextBirthRollTick: number;
}

/**
 * Spawn one family entity carrying its Household row, and stamp
 * `familyEid` into BOTH partners' Identity rows. Callers must have
 * verified housing + food surplus; this helper is pure state creation.
 */
export function spawnHousehold(
  world: World,
  comps: HouseholdComponents & { identityId: number },
  options: SpawnHouseholdOptions,
): number {
  if (
    !Number.isInteger(options.playerId) ||
    options.playerId < 0 ||
    !Number.isInteger(options.homeEid) ||
    options.homeEid < 1 ||
    !Number.isInteger(options.headEid) ||
    options.headEid < 1 ||
    !Number.isInteger(options.partnerEid) ||
    options.partnerEid < 1 ||
    !Number.isInteger(options.nextBirthRollTick)
  ) {
    throw new Error(
      `spawnHousehold needs integer ids, got ${JSON.stringify(options)}`,
    );
  }
  const famEid = spawnEntity(world);
  requireRows(world, comps.householdId).set(famEid, [
    options.playerId,
    options.homeEid,
    options.headEid,
    options.partnerEid,
    options.nextBirthRollTick,
    0,
  ]);
  setIdentityFamily(world, comps, options.headEid, famEid);
  setIdentityFamily(world, comps, options.partnerEid, famEid);
  return famEid;
}

function setIdentityFamily(
  world: World,
  comps: HouseholdComponents & { identityId: number },
  eid: number,
  famEid: number,
): void {
  setIdentityFamilyId(world, comps, eid, famEid);
}

/** Live (mutable) Household row for one family entity. */
export function householdRowOf(
  world: World,
  comps: Pick<HouseholdComponents, "householdId">,
  famEid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.householdId)?.get(famEid);
}

/** Decoded Household fields for one family entity, or undefined. */
export interface HouseholdFields {
  readonly playerId: number;
  readonly homeEid: number;
  readonly headEid: number;
  readonly partnerEid: number;
  readonly nextBirthRollTick: number;
  readonly birthCount: number;
}

export function readHousehold(
  world: World,
  comps: Pick<HouseholdComponents, "householdId">,
  famEid: number,
): HouseholdFields | undefined {
  const row = householdRowOf(world, comps, famEid);
  if (!row) return undefined;
  return {
    playerId: row[0]!,
    homeEid: row[1]!,
    headEid: row[2]!,
    partnerEid: row[3]!,
    nextBirthRollTick: row[4]!,
    birthCount: row[5]!,
  };
}

/** Record one newborn against the family (birthCount += 1). */
export function countBirthInto(
  world: World,
  comps: Pick<HouseholdComponents, "householdId">,
  famEid: number,
): void {
  const row = householdRowOf(world, comps, famEid);
  if (!row) throw new Error(`entity ${String(famEid)} has no Household row`);
  row[5] = row[5]! + 1;
}

/** Advance the family's next daily birth-roll tick. */
export function scheduleNextBirthRoll(
  world: World,
  comps: Pick<HouseholdComponents, "householdId">,
  famEid: number,
  tick: number,
): void {
  const row = householdRowOf(world, comps, famEid);
  if (!row) throw new Error(`entity ${String(famEid)} has no Household row`);
  row[4] = tick;
}

/**
 * Households system — SPEC §2.3 family/household / M3-T5 (issue #50).
 *
 * One daily pass on every day boundary (tick % dayTicks === 0), two
 * phases, both ascending-eid deterministic:
 *
 *   1) FAMILY FORMATION — unmarried working-age Pops pair up when the
 *      village can support them: a finished house with spare capacity
 *      (its populationCap minus everyone already homed there must fit
 *      TWO more residents) AND a food surplus in the owner's ledger.
 *      Each couple claims the EMPTIEST house with room (ties by
 *      ascending eid), forming a Household row on its own family
 *      entity and stamping Identity.familyId on both partners. Elders
 *      (past work age) and children never form new families.
 *
 *   2) BIRTH ROLLS — every housed family rolls once per day against a
 *      dedicated sfc32 sub-stream keyed (seed, familyEid, dayIndex) —
 *      NEVER the shared world.prng stream (the pop.ts discipline: M3
 *      systems must not perturb the movement/economy replay streams).
 *      A successful roll spends BIRTH_FOOD_COST food and spawns a
 *      newborn CHILD beside the family's home (POP_ORIGIN_BIRTH, full
 *      Identity/Traits/Skills/Needs/Lessons/Body rows) whose familyId
 *      links it to both parents through the Household row. Births
 *      therefore scale exactly with housed families, and housing
 *      capacity + food gate every single one.
 *
 * Stale references are validated lazily: a family whose head AND
 * partner both died loses its row entirely; orphans keep their
 * familyId, and once that row is gone they may join a NEW family —
 * widows and orphans remarry, which is how grandchildren happen.
 * V1 lineage note: deeper ancestry is not tracked, so after a family
 * record ends its children are treated as unrelated for pairing.
 */

import {
  countBirthInto,
  householdRowOf,
  readHousehold,
  scheduleNextBirthRoll,
  spawnHousehold,
} from "../components/household";
import {
  FAMILY_UNASSIGNED,
  POP_ORIGIN_BIRTH,
  popStreamSeed,
  readIdentity,
  setIdentityFamilyId,
} from "../components/pop";
import { getBuildingRow, buildingRectOf } from "../components/buildings";
import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import { RESOURCE_FOOD } from "../components/economy";
import { canDebitLedgerSlugs, debitLedgerSlugs } from "../core/stockpile";
import { spawnUnit } from "../components";
import { createPrng } from "../core/prng";
import { findSpawnTile } from "./training";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_ADULT,
  dayIndexOf,
  lifeStageOf,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "./lifecycle";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/**
 * Food surplus a village needs before a NEW family forms (SPEC §2.3:
 * "household forms when housing + food surplus allow"). Roughly three
 * villager trainings' worth.
 */
export const FOOD_SURPLUS_FOR_HOUSEHOLD = 150;

/** Food spent per birth — a newborn is not free (AoE2 villager parity). */
export const BIRTH_FOOD_COST = 50;

/** Chance one housed family's daily birth roll succeeds. */
export const BIRTH_ROLL_CHANCE = 0.6;

/** Domain constant separating birth-roll streams from other seed uses. */
const BIRTH_STREAM_DOMAIN = 0x62697274; // "birt"

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface HouseholdDiagnostics {
  /** Families formed across the run. */
  familiesFormed: number;
  /** Birth rolls won (newborns spawned). */
  birthsRolled: number;
  /** Won rolls skipped for want of food or spare housing. */
  birthsBlocked: number;
}

export function createHouseholdDiagnostics(): HouseholdDiagnostics {
  return { familiesFormed: 0, birthsRolled: 0, birthsBlocked: 0 };
}

// ---- Internals -----------------------------------------------------------------

/** Every component id the households pass reads or writes. */
export type HouseholdSystemComponents = Pick<
  SimComponents,
  | "identityId"
  | "unitTagId"
  | "householdId"
  | "buildingId"
  | "positionId"
  | "activityQueueId"
  | "velocityId"
  | "moveTargetId"
  | "stockpileId"
  | "commodityStockpileId"
  | "dropoffId"
  | "ownerId"
>;

function requireRows(world: World, componentId: number): Map<number, number[]> {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) throw new Error("unregistered component");
  return rows as Map<number, number[]>;
}

/** Owning player of one named Pop (rowless legacy reads as player zero). */
function ownerOfPop(
  world: World,
  comps: HouseholdSystemComponents,
  eid: number,
): number {
  return requireRows(world, comps.ownerId).get(eid)?.[0] ?? 0;
}

/**
 * True when the Pop may join a NEW family: never assigned one, or its
 * old family row is gone (both founders dead — the line has ended).
 */
function isUnmarried(
  world: World,
  comps: HouseholdSystemComponents,
  eid: number,
): boolean {
  const identity = readIdentity(world, comps, eid)!;
  if (identity.familyId === FAMILY_UNASSIGNED) return true;
  return householdRowOf(world, comps, identity.familyId) === undefined;
}

/** Living named Pops, ascending eid. */
function aliveNamedPopsAscending(
  world: World,
  comps: HouseholdSystemComponents,
): number[] {
  const out: number[] = [];
  for (const eid of [...requireRows(world, comps.identityId).keys()].sort(
    (a, b) => a - b,
  )) {
    if (!requireRows(world, comps.unitTagId).has(eid)) continue;
    out.push(eid);
  }
  return out;
}

/** Everyone currently living at `homeEid` (family members + babies). */
function occupancyOf(
  world: World,
  comps: HouseholdSystemComponents,
  homeEid: number,
): number {
  let occupants = 0;
  for (const [famEid] of requireRows(world, comps.householdId)) {
    const household = readHousehold(world, comps, famEid);
    if (!household || household.homeEid !== homeEid) continue;
    // Dead founders stop occupying; their Identity rows are gone.
    if (readIdentity(world, comps, household.headEid)) occupants += 1;
    if (readIdentity(world, comps, household.partnerEid)) occupants += 1;
    occupants += household.birthCount;
  }
  return occupants;
}

function heldFoodOf(
  world: World,
  comps: HouseholdSystemComponents,
  playerId: number,
): number | undefined {
  for (const row of requireRows(world, comps.stockpileId).values()) {
    if (row[0] === playerId) return row[RESOURCE_FOOD + 1]!;
  }
  return undefined; // no ledger: this player has no household economy
}

interface HomeCandidate {
  readonly eid: number;
  readonly occupants: number;
}

/** Finished houses of `playerId` with `seatsNeeded` spare beds. */
function homesWithRoom(
  world: World,
  comps: HouseholdSystemComponents,
  playerId: number,
  seatsNeeded: number,
): HomeCandidate[] {
  const out: HomeCandidate[] = [];
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    const cap = buildingDefOf(buildingIdOfCode(row[1]!)).populationCap;
    if (cap <= 0) continue;
    const occupants = occupancyOf(world, comps, eid);
    if (occupants + seatsNeeded > cap) continue;
    out.push({ eid, occupants });
  }
  return out;
}

/**
 * Pick the next home for a new couple: among houses with room, the
 * EMPTIEST first (ties by ascending eid) — villages spread families
 * across houses instead of stacking couples into the first one.
 */
function pickHome(
  world: World,
  comps: HouseholdSystemComponents,
  playerId: number,
  seatsNeeded: number,
): number | undefined {
  const candidates = homesWithRoom(world, comps, playerId, seatsNeeded);
  if (candidates.length === 0) return undefined;
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (
      candidate.occupants < best.occupants ||
      (candidate.occupants === best.occupants && candidate.eid < best.eid)
    ) {
      best = candidate;
    }
  }
  return best.eid;
}

/**
 * One family's seeded daily birth stream — a pure function of
 * (seed, familyEid, dayIndex), fresh per roll, shared-stream-free.
 */
export function birthRollRandom(
  seed: number,
  famEid: number,
  dayIndex: number,
): Pick<ReturnType<typeof createPrng>, "nextFloat"> {
  const daySalt = (seed ^ Math.imul(dayIndex + 1, 0x9e3779b9)) >>> 0;
  return createPrng(popStreamSeed(daySalt, famEid ^ BIRTH_STREAM_DOMAIN));
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the households SimSystem. Register alongside lifecycle: both
 * run cheap early-outs outside their cadence (this one acts only on
 * day boundaries), and neither touches world.prng.
 */
export function createHouseholdsSystem(
  comps: HouseholdSystemComponents,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
  diagnostics: HouseholdDiagnostics = createHouseholdDiagnostics(),
): SimSystem {
  const normalized = normalizeLifecycleConfig(config);
  return (world: World): void => {
    if (world.tick % normalized.dayTicks !== 0) return; // day boundary only
    const dayIndex = dayIndexOf(world.tick, normalized);

    // ---- Phase 1: family formation -----------------------------------
    // Unmarried adults, ascending eid, paired consecutively against
    // houses with room for two more and a fed ledger. A Pop whose
    // family line has ENDED (its Household row was deleted after both
    // founders died) is fair game again — widows and orphans remarry,
    // which is how grandchildren happen.
    const bachelors = aliveNamedPopsAscending(world, comps).filter((eid) => {
      const identity = readIdentity(world, comps, eid);
      if (!identity) return false;
      if (!isUnmarried(world, comps, eid)) return false;
      return lifeStageOf(world, comps, eid, normalized) === LIFE_STAGE_ADULT;
    });
    for (let i = 0; i + 1 < bachelors.length; i += 2) {
      const head = bachelors[i]!;
      const partner = bachelors[i + 1]!;
      // Families never span players, and two Pops of one LIVING family
      // never marry each other.
      const playerId = ownerOfPop(world, comps, head);
      if (ownerOfPop(world, comps, partner) !== playerId) continue;
      const headFam = readIdentity(world, comps, head)!.familyId;
      const partnerFam = readIdentity(world, comps, partner)!.familyId;
      if (headFam !== FAMILY_UNASSIGNED && headFam === partnerFam) {
        continue;
      }
      const food = heldFoodOf(world, comps, playerId);
      if (food === undefined || food < FOOD_SURPLUS_FOR_HOUSEHOLD) continue;
      const home = pickHome(world, comps, playerId, 2);
      if (home === undefined) continue;
      spawnHousehold(world, comps, {
        playerId,
        homeEid: home,
        headEid: head,
        partnerEid: partner,
        // First roll lands on the NEXT day boundary (this one is spent).
        nextBirthRollTick: (dayIndex + 1) * normalized.dayTicks,
      });
      diagnostics.familiesFormed += 1;
    }

    // ---- Phase 2: seeded daily birth rolls -----------------------------
    for (const famEid of [...requireRows(world, comps.householdId).keys()].sort(
      (a, b) => a - b,
    )) {
      const household = readHousehold(world, comps, famEid);
      if (!household) continue;
      if (household.nextBirthRollTick !== world.tick) continue; // not due

      // Validate lazily: both founders dead ⇒ the family line ends.
      const headAlive =
        readIdentity(world, comps, household.headEid) !== undefined;
      const partnerAlive =
        readIdentity(world, comps, household.partnerEid) !== undefined;
      if (!headAlive && !partnerAlive) {
        requireRows(world, comps.householdId).delete(famEid);
        continue;
      }

      scheduleNextBirthRoll(
        world,
        comps,
        famEid,
        world.tick + normalized.dayTicks,
      );

      if (
        birthRollRandom(world.seed, famEid, dayIndex).nextFloat() >=
        BIRTH_ROLL_CHANCE
      ) {
        continue; // no child today
      }

      // Housing: the family's home must still stand with a free bed,
      // and there must be a passable tile beside it for the newborn.
      const homeRow = getBuildingRow(world, comps, household.homeEid);
      const cap = homeRow
        ? buildingDefOf(buildingIdOfCode(homeRow[1]!)).populationCap
        : 0;
      const rect = homeRow
        ? buildingRectOf(world, comps, household.homeEid)
        : undefined;
      if (
        !homeRow ||
        !rect ||
        occupancyOf(world, comps, household.homeEid) + 1 > cap
      ) {
        diagnostics.birthsBlocked += 1;
        continue;
      }
      const tile = findSpawnTile(
        world,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      );
      if (tile === undefined) {
        diagnostics.birthsBlocked += 1;
        continue;
      }
      // Food: the birth debits the family's player right now.
      if (
        !canDebitLedgerSlugs(world, comps, household.playerId, [
          { defId: "food", qty: BIRTH_FOOD_COST },
        ])
      ) {
        diagnostics.birthsBlocked += 1;
        continue;
      }
      debitLedgerSlugs(
        world,
        comps,
        household.playerId,
        [{ defId: "food", qty: BIRTH_FOOD_COST }],
        "a birth",
      );

      const newborn = spawnUnit(world, comps, tile.x + 0.5, tile.y + 0.5, {
        identity: true,
        body: true,
        origin: POP_ORIGIN_BIRTH,
      });
      setIdentityFamilyId(world, comps, newborn, famEid);
      countBirthInto(world, comps, famEid);
      diagnostics.birthsRolled += 1;
    }
  };
}

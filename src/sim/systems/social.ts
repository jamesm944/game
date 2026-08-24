/**
 * Leisure, social bonds & rivals — SPEC §2.4 / M3-T7 (issue #52).
 *
 * The evening half of §2.4 in one module. Schedules (M3-T6) still owns
 * all clock knowledge: it releases workers homeward at their role's
 * close and beds everyone at 22:00; between the two, Pops are IDLE with
 * empty queues — which is exactly the state this system's IAUS
 * extension scores.
 *
 * SCORING (`leisureCandidatesFor`, called from the pop brain at its 1 Hz
 * hash-staggered think while the injected leisure window is open):
 * candidates are the five §2.4 venues v1 —
 *
 *   tavern/brothel  finished venue buildings of the Pop's owner; gold
 *                   sinks paid from the OWNER stockpile on completion
 *                   (brothel costs more and buffs morale harder);
 *   shrine          the Church stub (mass arrives with the weekly
 *                   cycle); study reuses the School building;
 *   visit           friend/family — another living named Pop of the same
 *                   player, targeted at THEIR household bed tile so the
 *                   destination is stable across the evening.
 *
 * Weights come from Traits (§2.4 mapping): Hedonist pulls tavern/
 * brothel, Pious pulls the shrine, Ambitious pulls study, Sociable/
 * Gregarious pull friend visits, Family-focused pulls family visits;
 * Ascetic/Solitary repel the corresponding options. Low morale adds a
 * pull toward morale-buffing venues; existing bonds color visit choices;
 * distance falloff mirrors the job brain; crowding counts units parked
 * around a venue against its patron cap. Elders score at the brain's
 * light-duty multiplier; children never think at all.
 *
 * EXECUTION (this SimSystem): brain picks emit a plain shared-inbox
 * `leisure` command — byte-for-byte the player-order interface like
 * every other brain emission. The command plans [Move door, Leisure]
 * chains; movement parks Leisure heads; on arrival this system executes
 * the venue behavior exactly once and drops the head:
 *
 *   - gold venues debit the owner ledger (affordability re-checked at
 *     arrival — a broke arrival cancels politely);
 *   - morale buffs land on the Needs row; study also grants knowledge XP
 *     in the school system's rotating subject of the day;
 *   - visits increment the PAIR's Relationship row (components/
 *     relationship.ts) and lift both moods when the host is actually
 *     home;
 *   - married brothel visitors roll seeded DISCOVERY (jealous spouses
 *     double the odds): spouse takes a bond-BUFFERED morale shock, the
 *     marriage pair takes relationship damage, and digest-visible
 *     SocialEvents rows record the drama (mistress management stays
 *     abstracted à la RimWorld — SPEC's "no explicit content");
 *   - every completed leisure stamps a self JobCooldown through the next
 *     05:00 wake — one outing per Pop per evening, no gold-sink spam.
 *
 * RIVALS: negative events push pairs toward RIVAL_THRESHOLD. M3 keeps
 * the scope combat-shaped (issue #52): when a bonded Pop dies to a
 * living killer, every survivor bonded to the victim takes a grudge
 * penalty AGAINST THE KILLER's pair row — clamped to reach the rival
 * threshold in one stroke; crossings append SocialEvent RIVAL_FORMED
 * rows. Jealousy damage crosses the same threshold the same way (two
 * scandals make a rival spouse). The bond lookup API (strongestBondOf /
 * bondBufferFractionOf / applyBufferedMoraleShock) is what T9's combat
 * griefing reads.
 */

import {
  cancelActivities,
  dequeueCurrentActivity,
  enqueueActivity,
  LEISURE_VENUE_BROTHEL,
  LEISURE_VENUE_SHRINE,
  LEISURE_VENUE_STUDY,
  LEISURE_VENUE_TAVERN,
  LEISURE_VENUE_VISIT,
  leisureActivity,
  moveActivity,
  peekActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { buildingIdOfCode } from "../../data/definitions";
import { createPrng } from "../core/prng";
import { canDebitLedgerSlugs, debitLedgerSlugs } from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import { getBuildingRow } from "../components/buildings";
import { COMBAT_EVENT_UNIT_DEATH } from "../components/combat";
import { readHousehold } from "../components/household";
import { jobCooldownActive, stampJobCooldown } from "../components/jobCooldown";
import { needsRowOf, NEED_MAX } from "../components/needs";
import { FAMILY_UNASSIGNED, readIdentity, readTraits } from "../components/pop";
import { ownerOfUnit } from "../components/owner";
import {
  adjustRelationship,
  bondBufferFractionOf,
  RIVAL_THRESHOLD,
  relationshipPairEids,
  relationshipRowOf,
  relationshipValueOf,
} from "../components/relationship";
import {
  appendSocialEvent,
  SOCIAL_EVENT_JEALOUSY,
  SOCIAL_EVENT_RIVAL_FORMED,
  SOCIAL_EVENT_VISIT,
} from "../components/socialEvents";
import { grantKnowledge } from "./skills";
import { subjectOfDay } from "./school";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  dayIndexOf,
  LIFE_STAGE_CHILD,
  lifeStageOf,
  minuteOfDay,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "./lifecycle";
import { SLEEP_OPEN_MINUTE, WORK_CLOSE_MINUTE, wakeTickFor } from "./schedules";
import { resetSteeringBookkeeping } from "./movement";
import type { World, SimSystem } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/** Leisure opens when the base work shift closes (18:00 sim-clock). */
export const LEISURE_OPEN_MINUTE = WORK_CLOSE_MINUTE;

/** True inside the post-work evening window (closes at the night band). */
export function isLeisureTime(tick: number, config: LifecycleConfig): boolean {
  const minute = minuteOfDay(tick, config);
  return minute >= LEISURE_OPEN_MINUTE && minute < SLEEP_OPEN_MINUTE;
}

/** Arrival radius around a venue door/host tile that completes an outing. */
export const LEISURE_ARRIVAL_RADIUS_TILES = 2.5;
/** Host must be this close for a visit to count as "met". */
export const VISIT_MEET_RADIUS_TILES = 4;

/** Gold sunk per completed tavern evening. */
export const TAVERN_GOLD_COST = 2;
/** The bigger sink (SPEC §2.4). */
export const BROTHEL_GOLD_COST = 5;

/** Morale restored per completed outing, per venue kind. */
export const TAVERN_MORALE_RESTORE = 15;
export const BROTHEL_MORALE_RESTORE = 20;
export const SHRINE_MORALE_RESTORE = 12;
export const STUDY_MORALE_RESTORE = 5;
/** Knowledge XP granted by a study evening (rotating school subject). */
export const STUDY_KNOWLEDGE_XP = 15;

/** Visit effects: bond increment + mood lift for both parties. */
export const VISIT_BOND_INCREMENT = 10;
export const VISIT_MORALE_RESTORE = 8;
/** Visitor-only consolation when the host is not home. */
export const VISIT_ALONE_MORALE_RESTORE = 4;

/** Base discovery chance per brothel evening for a married visitor. */
export const JEALOUSY_DISCOVERY_CHANCE = 0.3;
/** A jealous-trait spouse watches twice as hard. */
export const JEALOUSY_SPOUSE_TRAIT_MULT = 2;
/** Spouse morale shock before bond buffering. */
export const JEALOUSY_MORALE_SHOCK = 20;
/** Relationship damage to the marriage pair on discovery. */
export const JEALOUSY_RELATIONSHIP_DAMAGE = -35;

/** Bonds at/above this strength vendetta against a bonded friend's killer. */
export const DEATH_GRUDGE_BOND_MIN = 20;
/**
 * Nominal grudge penalty applied to (survivor, killer) pairs per bonded
 * death. The applied delta is clamped DOWN to reach RIVAL_THRESHOLD when
 * the pair sat higher: killing someone's bonded friend makes you their
 * rival in one stroke, whatever goodwill existed before.
 */
export const DEATH_GRUDGE_PENALTY = -45;

/** Patron-cap approximation per venue kind (units parked nearby). */
export const VENUE_PATRON_CAPS: Readonly<Record<number, number>> = {
  [LEISURE_VENUE_TAVERN]: 6,
  [LEISURE_VENUE_BROTHEL]: 4,
  [LEISURE_VENUE_SHRINE]: 8,
  [LEISURE_VENUE_STUDY]: 8,
};
/** Radius that counts as "around the venue" for patron counting. */
export const PATRON_CROWD_RADIUS_TILES = 3;

/**
 * Distance-falloff span mirrored from the job brain (kept local so the
 * brain→social import edge stays one-way).
 */
export const LEISURE_MAX_INTEREST_RADIUS_TILES = 40;

/**
 * Trait → activity pull table (§2.4 weights). Positive pulls attract,
 * negative repel; scores sum every carried trait's contribution.
 */
export const LEISURE_TRAIT_PULLS: Readonly<
  Record<number, Readonly<Record<string, number>>>
> = {
  [LEISURE_VENUE_TAVERN]: { hedonist: 0.45, gregarious: 0.15, ascetic: -0.4 },
  [LEISURE_VENUE_BROTHEL]: { hedonist: 0.6, charmer: 0.25, ascetic: -0.4 },
  [LEISURE_VENUE_SHRINE]: { pious: 0.55 },
  [LEISURE_VENUE_STUDY]: { ambitious: 0.5, "fast-learner": 0.15 },
  [LEISURE_VENUE_VISIT]: {
    sociable: 0.5,
    gregarious: 0.25,
    "family-focused": 0.55,
    solitary: -0.45,
    ascetic: -0.15,
  },
};
/** Small baseline so even unsociable Pops may call on friends. */
export const FRIEND_BASE_PULL = 0.1;

/** Venue building ids backing each non-visit leisure kind (§2.4 venues). */
export const VENUE_BUILDING_IDS: Readonly<Record<number, string>> = {
  [LEISURE_VENUE_TAVERN]: "tavern",
  [LEISURE_VENUE_BROTHEL]: "brothel",
  [LEISURE_VENUE_SHRINE]: "church",
  [LEISURE_VENUE_STUDY]: "school",
};

/** Gold cost per venue kind (0 = free). */
export const VENUE_GOLD_COSTS: Readonly<Record<number, number>> = {
  [LEISURE_VENUE_TAVERN]: TAVERN_GOLD_COST,
  [LEISURE_VENUE_BROTHEL]: BROTHEL_GOLD_COST,
};

/** Morale restore per venue kind (visits handled separately). */
export const VENUE_MORALE_RESTORES: Readonly<Record<number, number>> = {
  [LEISURE_VENUE_TAVERN]: TAVERN_MORALE_RESTORE,
  [LEISURE_VENUE_BROTHEL]: BROTHEL_MORALE_RESTORE,
  [LEISURE_VENUE_SHRINE]: SHRINE_MORALE_RESTORE,
  [LEISURE_VENUE_STUDY]: STUDY_MORALE_RESTORE,
};

/** Domain constant separating jealousy streams from other seed uses. */
const JEALOUSY_STREAM_DOMAIN = 0x6a65616c; // "jeal"

/** Cap on enumerated visit hosts per think (nearest-scored win anyway). */
const VISIT_CANDIDATE_LIMIT = 12;

// ---- Pure helpers ---------------------------------------------------------------

function requireRows(world: World, componentId: number): Map<number, number[]> {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) throw new Error("unregistered component");
  return rows as Map<number, number[]>;
}

/** Sum of `slugs`' pulls from one venue's trait table. */
function traitPullFor(venueCode: number, slugs: readonly string[]): number {
  const table = LEISURE_TRAIT_PULLS[venueCode];
  if (!table) return 0;
  let pull = 0;
  for (const slug of slugs) pull += table[slug] ?? 0;
  return pull;
}

/** Nearest passable tile to (tx, ty) by expanding square rings. */
function nearestPassableTile(
  passability: Uint8Array,
  size: number,
  tx: number,
  ty: number,
): { x: number; y: number } | undefined {
  const clampedX = Math.min(Math.max(tx, 0), size - 1);
  const clampedY = Math.min(Math.max(ty, 0), size - 1);
  for (let radius = 0; radius <= size; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = clampedX + dx;
        const y = clampedY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (passability[y * size + x] === 1) return { x, y };
      }
    }
  }
  return undefined;
}

/**
 * Bond-buffered morale shock (the T9 seam): a Pop whose strongest bond
 * is strong shrugs off part of the shock — fraction rises linearly to
 * BOND_BUFFER_MAX at a perfect bond. Returns the applied amount.
 */
export function applyBufferedMoraleShock(
  world: World,
  comps: Pick<SimComponents, "needsId" | "relationshipId">,
  eid: number,
  shock: number,
): number {
  const row = needsRowOf(world, comps, eid);
  if (!row || shock <= 0) return 0;
  const buffer = bondBufferFractionOf(world, comps, eid);
  const applied = Math.max(0, Math.round(shock * (1 - buffer)));
  row[2] = Math.max(0, row[2]! - applied);
  return applied;
}

/** The living spouse of one Pop via its Household row, or undefined. */
export function spouseOf(
  world: World,
  comps: Pick<SimComponents, "identityId" | "householdId" | "unitTagId">,
  eid: number,
): number | undefined {
  const identity = readIdentity(world, comps, eid);
  if (!identity || identity.familyId === FAMILY_UNASSIGNED) return undefined;
  const household = readHousehold(world, comps, identity.familyId);
  if (!household) return undefined;
  const candidate =
    household.headEid === eid ? household.partnerEid : household.headEid;
  if (candidate === eid) return undefined;
  return requireRows(world, comps.unitTagId).has(candidate) &&
    requireRows(world, comps.identityId).has(candidate)
    ? candidate
    : undefined;
}

/** One finished venue building of `playerId` nearest to (x, y). */
function nearestVenueOf(
  world: World,
  comps: Pick<SimComponents, "buildingId" | "positionId">,
  defId: string,
  playerId: number,
  x: number,
  y: number,
): { eid: number; x: number; y: number } | undefined {
  let best: { eid: number; x: number; y: number } | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  const posRows = requireRows(world, comps.positionId);
  for (const [eid, row] of requireRows(world, comps.buildingId)) {
    if (row[0] !== playerId) continue;
    if (buildingIdOfCode(row[1]!) !== defId) continue;
    const pos = posRows.get(eid);
    if (!pos) continue;
    const d = (pos[0]! - x) ** 2 + (pos[1]! - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { eid, x: pos[0]!, y: pos[1]! };
    }
  }
  return best;
}

/** Units parked within PATRON_CROWD_RADIUS_TILES of a venue center. */
function patronsAround(
  world: World,
  comps: Pick<SimComponents, "positionId">,
  x: number,
  y: number,
): number {
  let count = 0;
  const rSq = PATRON_CROWD_RADIUS_TILES ** 2;
  for (const pos of requireRows(world, comps.positionId).values()) {
    const dx = pos[0]! - x;
    const dy = pos[1]! - y;
    if (dx * dx + dy * dy <= rSq) count += 1;
  }
  return count;
}

// ---- Scoring -------------------------------------------------------------------

/** One scored evening option handed back to the pop brain. */
export interface LeisureCandidate {
  readonly venueCode: number;
  /** Venue building eid or visited host eid (0 = none). */
  readonly targetEid: number;
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/**
 * Score every available evening activity for one Pop (IAUS extension).
 * Deterministic: enumeration is venue-table order then ascending host
 * eid; ties keep the earliest candidate (brain convention).
 */
export function leisureCandidatesFor(
  world: World,
  comps: SimComponents,
  eid: number,
  tick: number,
  config: LifecycleConfig,
  utilityMult = 1,
): LeisureCandidate[] {
  const traits = readTraits(world, comps, eid);
  if (!traits) return [];
  // One outing per evening: the self JobCooldown stamped at assignment
  // (and refreshed at completion) runs through the next 05:00 wake.
  if (jobCooldownActive(world, comps, eid, tick)) return [];
  if (lifeStageOf(world, comps, eid, config) === LIFE_STAGE_CHILD) {
    return [];
  }
  const identity = readIdentity(world, comps, eid);
  if (!identity) return [];
  const playerId = ownerOfUnit(world, comps, eid);
  const pos = requireRows(world, comps.positionId).get(eid);
  if (!pos) return [];

  const needsRow = needsRowOf(world, comps, eid);
  const moralePull =
    needsRow !== undefined
      ? (1 - Math.min(Math.max(needsRow[2]!, 0), NEED_MAX) / NEED_MAX) * 0.35
      : 0;

  const candidates: LeisureCandidate[] = [];
  const consider = (candidate: LeisureCandidate): void => {
    candidates.push(candidate);
  };

  // ---- Venue kinds -----------------------------------------------------
  for (const venueCode of [
    LEISURE_VENUE_TAVERN,
    LEISURE_VENUE_BROTHEL,
    LEISURE_VENUE_SHRINE,
    LEISURE_VENUE_STUDY,
  ]) {
    const venue = nearestVenueOf(
      world,
      comps,
      VENUE_BUILDING_IDS[venueCode]!,
      playerId,
      pos[0]!,
      pos[1]!,
    );
    if (!venue) continue;
    const cost = VENUE_GOLD_COSTS[venueCode] ?? 0;
    if (
      cost > 0 &&
      !canDebitLedgerSlugs(world, comps, playerId, [
        { defId: "gold", qty: cost },
      ])
    ) {
      continue; // broke tonight — the sink stays sunk elsewhere
    }
    const dx = venue.x - pos[0]!;
    const dy = venue.y - pos[1]!;
    const distancePenalty =
      Math.sqrt(dx * dx + dy * dy) / LEISURE_MAX_INTEREST_RADIUS_TILES;
    const cap = VENUE_PATRON_CAPS[venueCode] ?? 8;
    const crowdPenalty =
      (0.15 * patronsAround(world, comps, venue.x, venue.y)) / cap;
    const score =
      (0.35 +
        traitPullFor(venueCode, traits) +
        moralePull -
        distancePenalty -
        crowdPenalty) *
      utilityMult;
    consider({
      venueCode,
      targetEid: venue.eid,
      x: venue.x,
      y: venue.y,
      score,
    });
  }

  // ---- Visits ------------------------------------------------------------
  const tagRows = requireRows(world, comps.unitTagId);
  const identityRows = requireRows(world, comps.identityId);
  const householdRows = requireRows(world, comps.householdId);
  const scoredHosts: LeisureCandidate[] = [];
  for (const hostEid of [...identityRows.keys()].sort((a, b) => a - b)) {
    if (hostEid === eid) continue;
    if (!tagRows.has(hostEid)) continue;
    const hostPos = requireRows(world, comps.positionId).get(hostEid);
    if (!hostPos) continue;
    if (lifeStageOf(world, comps, hostEid, config) === LIFE_STAGE_CHILD) {
      continue;
    }
    if (ownerOfUnit(world, comps, hostEid) !== playerId) continue;
    const hostIdentity = readIdentity(world, comps, hostEid)!;
    const isFamily =
      identity.familyId !== FAMILY_UNASSIGNED &&
      hostIdentity.familyId === identity.familyId;
    // Family visits only pull when the Pop actually carries the
    // family-focused trait; friends always remain a small baseline.
    const basePull =
      traitPullFor(LEISURE_VENUE_VISIT, traits) +
      (isFamily ? 0 : FRIEND_BASE_PULL);
    if (basePull <= 0) continue; // nobody this temperament would call on
    const bond = relationshipValueOf(world, comps, eid, hostEid) ?? 0;
    const bondBonus = bond >= 0 ? (bond / 100) * 0.15 : (bond / 100) * 0.3;
    // Target the HOST'S bed slot when they have a household: stable
    // across the evening even if they step out.
    let tx = hostPos[0]!;
    let ty = hostPos[1]!;
    if (
      hostIdentity.familyId !== FAMILY_UNASSIGNED &&
      householdRows.has(hostIdentity.familyId)
    ) {
      const home = readHousehold(world, comps, hostIdentity.familyId)!;
      const homePos = requireRows(world, comps.positionId).get(home.homeEid);
      if (homePos) {
        tx = homePos[0]!;
        ty = homePos[1]!;
      }
    }
    const dx = tx - pos[0]!;
    const dy = ty - pos[1]!;
    const distancePenalty =
      Math.sqrt(dx * dx + dy * dy) / LEISURE_MAX_INTEREST_RADIUS_TILES;
    const score = (0.35 + basePull + bondBonus - distancePenalty) * utilityMult;
    scoredHosts.push({
      venueCode: LEISURE_VENUE_VISIT,
      targetEid: hostEid,
      x: tx,
      y: ty,
      score,
    });
  }
  scoredHosts.sort((a, b) => b.score - a.score || a.targetEid - b.targetEid);
  for (const host of scoredHosts.slice(0, VISIT_CANDIDATE_LIMIT)) {
    consider(host);
  }

  return candidates;
}

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface SocialDiagnostics {
  /** leisure commands accepted into Move+Leisure chains. */
  leisuresPlanned: number;
  /** Outings executed to completion (venue behavior applied). */
  leisuresCompleted: number;
  /** Completed outings that were visits. */
  visitsCompleted: number;
  /** Total gold sunk at pay venues. */
  goldSpent: number;
  /** Jealousy discoveries recorded. */
  jealousyEvents: number;
  /** Grudge penalties from bonded combat deaths. */
  grudgesApplied: number;
  /** Pairs newly crossing the rival threshold (any source). */
  rivalriesFormed: number;
  /** Arrivals that cancelled because their owner could not pay. */
  brokeArrivals: number;
}

export function createSocialDiagnostics(): SocialDiagnostics {
  return {
    leisuresPlanned: 0,
    leisuresCompleted: 0,
    visitsCompleted: 0,
    goldSpent: 0,
    jealousyEvents: 0,
    grudgesApplied: 0,
    rivalriesFormed: 0,
    brokeArrivals: 0,
  };
}

// ---- The system ---------------------------------------------------------------

/** Every component id the social pass reads or writes. */
export type SocialSystemComponents = Pick<
  SimComponents,
  | "identityId"
  | "traitsId"
  | "unitTagId"
  | "activityQueueId"
  | "moveTargetId"
  | "velocityId"
  | "positionId"
  | "needsId"
  | "skillsId"
  | "buildingId"
  | "ownerId"
  | "householdId"
  | "relationshipId"
  | "socialEventsId"
  | "combatEventsId"
  | "stockpileId"
  | "commodityStockpileId"
  | "dropoffId"
  | "jobCooldownId"
>;

export interface SocialSystemOptions {
  readonly comps: SocialSystemComponents;
  /**
   * Players whose Pops this system steers. Undefined serves everyone;
   * production wires [PLAYER_ONE] like schedules/the brain (SPEC §2.8).
   */
  readonly players?: readonly number[] | undefined;
  /** Lifecycle timescale; compressed golden fixtures pass their own. */
  readonly lifecycleConfig?: LifecycleConfig | undefined;
  readonly diagnostics?: SocialDiagnostics | undefined;
}

/**
 * Build the social SimSystem. Register after school (study grants the
 * rotating subject's XP) and BEFORE schedules so the 22:00 bedding
 * cancels any still-standing outing chain on the same tick it lands.
 */
export function createSocialSystem(options: SocialSystemOptions): SimSystem {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createSocialDiagnostics();
  const config = normalizeLifecycleConfig(
    options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG,
  );

  // Incremental CombatEvents cursor per player ledger: social events are
  // append-only, so consumed prefixes never change (deterministic).
  const processedDeathsByLedger = new Map<number, number>();

  return (world: World, commands: readonly SimCommand[]): void => {
    const posRows = requireRows(world, comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;

    const inScope = (eid: number): boolean =>
      players === undefined || players.includes(ownerOfUnit(world, comps, eid));

    /** Append an event to `aboutEid`'s owner ledger (best effort). */
    const logEvent = (
      aboutEid: number,
      kind: number,
      actorEid: number,
      targetEid: number,
      amount: number,
    ): void => {
      try {
        appendSocialEvent(world, comps, ownerOfUnit(world, comps, aboutEid), {
          tick: world.tick,
          kind,
          actorEid,
          targetEid,
          amount,
        });
      } catch {
        // Ledger-less fixtures cannot carry the drama log; bonds/morale
        // already applied above remain authoritative state.
      }
    };

    /**
     * Apply a negative delta to a pair; when the crossing dips to/below
     * the rival threshold, record the rivalry formation. Callers log
     * their own kind-specific events first; this only announces rivals.
     */
    const applySocialPenalty = (
      a: number,
      b: number,
      delta: number,
      actorEid: number,
    ): void => {
      const previous = relationshipValueOf(world, comps, a, b) ?? 0;
      const value = adjustRelationship(world, comps, a, b, delta);
      if (previous > RIVAL_THRESHOLD && value <= RIVAL_THRESHOLD) {
        diagnostics.rivalriesFormed += 1;
        logEvent(
          actorEid,
          SOCIAL_EVENT_RIVAL_FORMED,
          actorEid,
          b,
          value - previous,
        );
      }
    };

    const executeJealousyRoll = (visitor: number, dayIndex: number): void => {
      const spouse = spouseOf(world, comps, visitor);
      if (spouse === undefined) return; // unmarried: no partner to betray
      const spouseTraits = readTraits(world, comps, spouse) ?? [];
      const chance = Math.min(
        1,
        JEALOUSY_DISCOVERY_CHANCE *
          (spouseTraits.includes("jealous") ? JEALOUSY_SPOUSE_TRAIT_MULT : 1),
      );
      const roll = createPrng(
        (((world.seed ^ Math.imul(visitor, 0x85ebca6b)) >>> 0) ^
          (Math.imul(dayIndex + 1, 0x9e3779b9) ^ JEALOUSY_STREAM_DOMAIN)) >>>
          0 || 1,
      );
      if (roll.nextFloat() >= chance) return;
      applyBufferedMoraleShock(world, comps, spouse, JEALOUSY_MORALE_SHOCK);
      diagnostics.jealousyEvents += 1;
      logEvent(
        visitor,
        SOCIAL_EVENT_JEALOUSY,
        visitor,
        spouse,
        JEALOUSY_RELATIONSHIP_DAMAGE,
      );
      applySocialPenalty(
        visitor,
        spouse,
        JEALOUSY_RELATIONSHIP_DAMAGE,
        visitor,
      );
    };

    /** Execute one arrived Leisure head. Always drops the head. */
    const executeLeisureHead = (
      eid: number,
      venueCode: number,
      targetEid: number,
      queue: ReturnType<typeof readActivityQueue>,
    ): void => {
      const dayIndex = dayIndexOf(world.tick, config);
      const pos = requireRows(world, comps.positionId).get(eid)!;
      const needsRow = needsRowOf(world, comps, eid);
      const stampCooldown = (): void => {
        stampJobCooldown(world, comps, eid, wakeTickFor(world.tick, config));
      };

      if (venueCode === LEISURE_VENUE_VISIT) {
        const hostAlive =
          requireRows(world, comps.unitTagId).has(targetEid) &&
          requireRows(world, comps.identityId).has(targetEid);
        let met = false;
        if (hostAlive && inScope(targetEid)) {
          const hostPos = requireRows(world, comps.positionId).get(targetEid)!;
          const dx = hostPos[0]! - pos[0]!;
          const dy = hostPos[1]! - pos[1]!;
          met = dx * dx + dy * dy <= VISIT_MEET_RADIUS_TILES ** 2;
        }
        if (hostAlive && met) {
          adjustRelationship(
            world,
            comps,
            eid,
            targetEid,
            VISIT_BOND_INCREMENT,
          );
          if (needsRow) {
            needsRow[2] = Math.min(
              NEED_MAX,
              needsRow[2]! + VISIT_MORALE_RESTORE,
            );
          }
          const hostNeeds = needsRowOf(world, comps, targetEid);
          if (hostNeeds) {
            hostNeeds[2] = Math.min(
              NEED_MAX,
              hostNeeds[2]! + VISIT_MORALE_RESTORE,
            );
          }
          logEvent(
            eid,
            SOCIAL_EVENT_VISIT,
            eid,
            targetEid,
            VISIT_BOND_INCREMENT,
          );
        } else if (needsRow) {
          // Called on an empty house: the walk still did some good.
          needsRow[2] = Math.min(
            NEED_MAX,
            needsRow[2]! + VISIT_ALONE_MORALE_RESTORE,
          );
          logEvent(eid, SOCIAL_EVENT_VISIT, eid, targetEid, 0);
        }
        diagnostics.visitsCompleted += 1;
        diagnostics.leisuresCompleted += 1;
        dequeueCurrentActivity(queue);
        writeActivityQueue(world, comps, eid, queue);
        stampCooldown();
        return;
      }

      // ---- Paid/worship/study venues -------------------------------------
      const buildingRow = getBuildingRow(world, comps, targetEid);
      const validVenue =
        buildingRow !== undefined &&
        buildingIdOfCode(buildingRow[1]!) === VENUE_BUILDING_IDS[venueCode];
      if (!validVenue) {
        // Venue destroyed mid-walk: cancel the outing without effects.
        cancelActivities(queue);
        writeActivityQueue(world, comps, eid, queue);
        return;
      }
      const ownerId = buildingRow[0]!;
      const cost = VENUE_GOLD_COSTS[venueCode] ?? 0;
      if (cost > 0) {
        if (
          !canDebitLedgerSlugs(world, comps, ownerId, [
            { defId: "gold", qty: cost },
          ])
        ) {
          diagnostics.brokeArrivals += 1;
          cancelActivities(queue);
          writeActivityQueue(world, comps, eid, queue);
          stampCooldown();
          return;
        }
        debitLedgerSlugs(
          world,
          comps,
          ownerId,
          [{ defId: "gold", qty: cost }],
          "an evening out",
        );
        diagnostics.goldSpent += cost;
      }
      if (needsRow) {
        const restore = VENUE_MORALE_RESTORES[venueCode] ?? 0;
        needsRow[2] = Math.min(NEED_MAX, needsRow[2]! + restore);
      }
      if (venueCode === LEISURE_VENUE_STUDY) {
        grantKnowledge(
          world,
          comps,
          eid,
          subjectOfDay(dayIndex),
          STUDY_KNOWLEDGE_XP,
        );
      }
      logEvent(eid, SOCIAL_EVENT_VISIT, eid, targetEid, -cost);
      if (venueCode === LEISURE_VENUE_BROTHEL) {
        executeJealousyRoll(eid, dayIndex);
      }
      diagnostics.leisuresCompleted += 1;
      dequeueCurrentActivity(queue);
      writeActivityQueue(world, comps, eid, queue);
      stampCooldown();
    };

    // ---- 1) Commands: plan [Move door, Leisure] chains -----------------
    for (const command of commands) {
      if (command.kind !== "leisure") continue;
      const data = command.data as
        | {
            entityIds?: unknown;
            venueCode?: unknown;
            targetEid?: unknown;
            x?: unknown;
            y?: unknown;
          }
        | undefined;
      if (!data) throw new Error("leisure requires command data");
      const eid = (data.entityIds as number[])?.[0];
      const venueCode = data.venueCode as number;
      const targetEid = data.targetEid as number;
      const x = data.x as number;
      const y = data.y as number;
      if (
        typeof eid !== "number" ||
        typeof venueCode !== "number" ||
        typeof targetEid !== "number" ||
        typeof x !== "number" ||
        typeof y !== "number"
      ) {
        throw new Error(
          `malformed leisure command data: ${JSON.stringify(data)}`,
        );
      }
      if (!requireRows(world, comps.unitTagId).has(eid)) continue;
      if (!inScope(eid)) continue;
      const door = nearestPassableTile(
        passability,
        size,
        Math.floor(x),
        Math.floor(y),
      );
      if (!door) continue;
      const queue = readActivityQueue(world, comps, eid);
      cancelActivities(queue);
      enqueueActivity(queue, moveActivity([door.x + 0.5, door.y + 0.5]));
      enqueueActivity(queue, leisureActivity(venueCode, targetEid));
      writeActivityQueue(world, comps, eid, queue);
      setMoveTarget(world, comps, eid, door.x + 0.5, door.y + 0.5);
      const velRow = velRows?.get(eid);
      if (velRow) resetSteeringBookkeeping(velRow);
      diagnostics.leisuresPlanned += 1;
    }

    // ---- 2) Advance Leisure heads (ascending eid) -----------------------
    for (const eid of world.entities) {
      if (!requireRows(world, comps.unitTagId).has(eid)) continue;
      const queue = readActivityQueue(world, comps, eid);
      let head = peekActivity(queue);
      if (head === undefined) continue;

      // Approach leg first: when the walker is ALREADY inside its
      // outing's arrival radius (crowding shoved it in, or the target
      // stands on the waypoint), drop the Move leg so the outing lands
      // next pass instead of deadlocking on an occupied tile.
      if (head.kind === "move" && queue[1]?.kind === "leisure") {
        const pending = queue[1];
        const pos = posRows.get(eid);
        const targetPos = posRows.get(pending.targetEid);
        if (
          pos &&
          targetPos &&
          (pos[0]! - targetPos[0]!) ** 2 + (pos[1]! - targetPos[1]!) ** 2 <=
            LEISURE_ARRIVAL_RADIUS_TILES ** 2
        ) {
          dequeueCurrentActivity(queue);
          writeActivityQueue(world, comps, eid, queue);
          head = peekActivity(queue);
        } else {
          continue; // movement owns the approach leg this tick
        }
      }
      if (head?.kind !== "leisure") continue;

      const pos = posRows.get(eid)!;
      const targetPos = posRows.get(head.targetEid);
      if (!targetPos) {
        cancelActivities(queue);
        writeActivityQueue(world, comps, eid, queue);
        continue;
      }
      const dSq =
        (pos[0]! - targetPos[0]!) ** 2 + (pos[1]! - targetPos[1]!) ** 2;
      if (dSq > LEISURE_ARRIVAL_RADIUS_TILES ** 2) {
        const door = nearestPassableTile(
          passability,
          size,
          Math.floor(targetPos[0]!),
          Math.floor(targetPos[1]!),
        );
        if (door) {
          queue.unshift(moveActivity([door.x + 0.5, door.y + 0.5]));
          writeActivityQueue(world, comps, eid, queue);
          setMoveTarget(world, comps, eid, door.x + 0.5, door.y + 0.5);
          const velRow = velRows?.get(eid);
          if (velRow) resetSteeringBookkeeping(velRow);
        }
        continue;
      }
      executeLeisureHead(eid, head.venueCode, head.targetEid, queue);
    }

    // ---- 3) Grudge pass: bonded deaths breed rivals ---------------------
    const stockpileRows = requireRows(world, comps.stockpileId);
    for (const [ledgerEid] of stockpileRows) {
      const events = world.rowsByComponentId
        .get(comps.combatEventsId)
        ?.get(ledgerEid);
      if (!events) continue;
      const total = events[0]!;
      const processed = processedDeathsByLedger.get(ledgerEid) ?? 0;
      if (total <= processed) continue;
      for (let i = processed; i < total; i++) {
        const kind = events[2 + i * 5]!;
        if (kind !== COMBAT_EVENT_UNIT_DEATH) continue;
        const victim = events[4 + i * 5]!;
        const attacker = events[3 + i * 5]!;
        if (attacker === 0 || attacker === victim) continue;
        // The vendetta needs a living killer — named or not (military
        // units carry no Identity row; the grudge is against the pair).
        if (!requireRows(world, comps.unitTagId).has(attacker)) continue;
        for (const pairEid of relationshipPairEids(world, comps)) {
          const row = relationshipRowOf(world, comps, pairEid);
          if (!row) continue;
          const other =
            row[0] === victim ? row[1] : row[1] === victim ? row[0] : undefined;
          if (other === undefined || other === attacker) continue;
          if (row[2]! < DEATH_GRUDGE_BOND_MIN) continue;
          if (!requireRows(world, comps.unitTagId).has(other)) continue;
          if (!inScope(other)) continue;
          // The applied delta never lands short of the rival threshold —
          // a qualified vendetta crosses it in one stroke.
          const current =
            relationshipValueOf(world, comps, other, attacker) ?? 0;
          const delta = Math.min(
            DEATH_GRUDGE_PENALTY,
            RIVAL_THRESHOLD - current,
          );
          if (delta >= 0) continue; // already at/below the threshold
          diagnostics.grudgesApplied += 1;
          applySocialPenalty(other, attacker, delta, other);
        }
      }
      processedDeathsByLedger.set(ledgerEid, total);
    }
  };
}

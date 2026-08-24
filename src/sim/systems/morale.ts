/**
 * Morale system — SPEC §2.5 break points & routing / M3-T9 (issue #54).
 *
 * The combat half of the needs/morale story, in one module:
 *
 *   shock (family/companion death, taking a blow)
 *     → buffered by the Pop's strongest bond (systems/social.ts T7 API)
 *     → lands on the Needs morale meter
 *     → meter at/below the DERIVED break point ⇒ ROUTING
 *
 * ROUTERS flee their living threat and ignore every order — each tick
 * the pass re-stamps a single [Move away-from-threat] leg over whatever
 * the command surface wrote (player clicks, brain emissions), so
 * suppressed orders never stick for even one movement tick. Routers
 * keep their Combat row and stay attackable ("can be attacked down")
 * but never acquire or strike targets themselves; systems/combat.ts
 * consults isRoutingOf before retaliation/aggro acquisition.
 *
 * EXITS ("until rallied or safe"):
 * - SAFE: the threat died or fell > ROUTE_SAFE_DISTANCE_TILES away —
 *   checked every tick off digest rows only.
 * - RALLIED: on the Pop's staggered rare tick, nearby same-owner allies
 *   whose own morale sits at/above RALLY_ALLY_MORALE_MIN restore
 *   RALLY_MORALE_RESTORE each pass ("nearby high-morale Pops rally
 *   routers"); once the meter clears break point + ROUTE_EXIT_MARGIN
 *   the episode ends.
 *
 * RECOVERY toward baseline: every rare tick adds
 * MORALE_RECOVERY_PER_RARE_TICK to the meter (capped at NEED_MAX) —
 * against needs.ts's −1 decay that is a slow net heal for fed Pops,
 * while starvation's extra bleed still outruns it.
 *
 * SHOCK SOURCES (per-player CombatEvents ledgers, incremental cursors —
 * the social system's grudge-pass pattern; independent consumers):
 * - UNIT_DEATH where the victim shares the witness's household
 *   (Identity.familyId through components/household.ts) →
 *   FAMILY_DEATH_MORALE_SHOCK;
 * - UNIT_DEATH where a Relationship pair value ≥ COMPANION_BOND_MIN
 *   binds witness to victim → COMPANION_DEATH_MORALE_SHOCK;
 *   household membership wins when both match; every shock funnels
 *   through applyBufferedMoraleShock so strong bonds measurably shrink
 *   the landing (SPEC §2.4 "strong bonds buffer morale shocks");
 * - DAMAGE where the victim carries a Morale row → the small
 *   SELF_DAMAGE_MORALE_SHOCK per landed blow.
 *
 * Breaks without a live hostile threat stay mere morale damage — there
 * is nothing to flee from, so nobody routes at a corpse.
 *
 * Determinism: integer arithmetic, ascending-eid iteration everywhere
 * (world.entities is strictly ascending), all state in digest-visible
 * Needs/Morale/Relationship rows. Rowless entities (no Morale row, or
 * no Needs meter to read) no-op every path — legacy fixtures untouched.
 * Register after combat (its events feed this), after needs/social so
 * their meter writes settle first, and before schedules/the pop brain
 * so a freshly-exited router's empty queue is employable immediately.
 */

import { cancelActivities, moveActivity } from "../activities";
import { clearAssignedNode } from "../components/economy";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { clearAssignedSite } from "../components/buildings";
import {
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_UNIT_DEATH,
} from "../components/combat";
import { clearProductionJob } from "../components/production";
import {
  cumulativeActiveSeverityFromRow,
  PART_INJURY_CAPACITY,
  bodyRowOf,
} from "../components/body";
import {
  enterRouting,
  exitRouting,
  isRoutingOf,
  type MoraleComponents,
} from "../components/morale";
import { NEEDS_TICK_INTERVAL, NEED_MAX } from "../components/needs";
import { FAMILY_UNASSIGNED, readIdentity, readTraits } from "../components/pop";
import { relationshipValueOf } from "../components/relationship";
import { skillLevelOf } from "./skills";
import { applyBufferedMoraleShock } from "./social";
import { resetSteeringBookkeeping } from "./movement";
import type { SimSystem, World } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/** Meter restored per rare tick toward the baseline (needs decays 1). */
export const MORALE_RECOVERY_PER_RARE_TICK = 2;

/** Break point for a traitless, unwounded, unskilled Pop. */
export const MORALE_BREAK_BASE = 12;
/** Trait deltas on the break point (braver ⇒ holds longer). */
export const MORALE_BREAK_BRAVE_DELTA = -6;
export const MORALE_BREAK_COWARD_DELTA = 8;
export const MORALE_BREAK_OPTIMISTIC_DELTA = -3;
export const MORALE_BREAK_PESSIMISTIC_DELTA = 3;
/** Each melee level steadies nerves — veterans route last. */
export const MORALE_BREAK_PER_MELEE_LEVEL = -1;
/**
 * Open trauma as a fraction of part capacity raises the break point by
 * up to this much.
 */
export const MORALE_BREAK_PER_WOUND_FRACTION = 10;

/** Unbuffered shock when a HOUSEHOLD member dies (SPEC §2.5). */
export const FAMILY_DEATH_MORALE_SHOCK = 30;
/** Unbuffered shock when a bonded companion dies. */
export const COMPANION_DEATH_MORALE_SHOCK = 22;
/** Pair value at/above which a death counts as a companion's. */
export const COMPANION_BOND_MIN = 20;
/** Shock per landed blow ON the victim itself. */
export const SELF_DAMAGE_MORALE_SHOCK = 2;

/** Allies with morale at/above this can rally routers. */
export const RALLY_ALLY_MORALE_MIN = 70;
/** Rally radius in tiles. */
export const RALLY_RADIUS_TILES = 6;
/** Meter restored per rally pass (the router's rare tick). */
export const RALLY_MORALE_RESTORE = 6;
/** A rallied exit clears the meter above break point by this margin. */
export const ROUTE_EXIT_MARGIN = 10;
/** A threat farther than this counts as gone ("or safe", SPEC §2.5). */
export const ROUTE_SAFE_DISTANCE_TILES = 14;
/** Length of one flee leg in tiles. */
export const FLEE_STEP_TILES = 5;
/** A flee leg within this of the router counts as reached. */
export const FLEE_ARRIVED_TILES = 1;

/** Rare-tick cadence shared with the needs pass (documented alias). */
const MORALE_RARE_TICK_INTERVAL = NEEDS_TICK_INTERVAL;

// ---- Derived break point --------------------------------------------------------

/**
 * The individual break point, derived on read ("derived stats, never
 * stored", SPEC §2.5): base, nudged by nerve traits, melee veterancy
 * and open wounds. Pure over digest rows; rowless inputs give exactly
 * MORALE_BREAK_BASE.
 */
export function moraleBreakPointOf(
  world: World,
  comps: SimComponents & MoraleComponents,
  eid: number,
): number {
  let point = MORALE_BREAK_BASE;
  const traits = readTraits(world, comps, eid);
  if (traits !== undefined) {
    if (traits.includes("brave")) point += MORALE_BREAK_BRAVE_DELTA;
    if (traits.includes("coward")) point += MORALE_BREAK_COWARD_DELTA;
    if (traits.includes("optimistic")) point += MORALE_BREAK_OPTIMISTIC_DELTA;
    if (traits.includes("pessimistic")) {
      point += MORALE_BREAK_PESSIMISTIC_DELTA;
    }
  }
  const melee = skillLevelOf(world, comps, eid, "melee");
  if (melee !== undefined) point += MORALE_BREAK_PER_MELEE_LEVEL * melee;
  const body = bodyRowOf(world, comps, eid);
  if (body !== undefined) {
    const fraction =
      cumulativeActiveSeverityFromRow(body) / PART_INJURY_CAPACITY;
    point += Math.round(MORALE_BREAK_PER_WOUND_FRACTION * fraction);
  }
  return Math.max(0, Math.min(NEED_MAX, point));
}

// ---- Diagnostics ------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface MoraleDiagnostics {
  /** Routing episodes entered. */
  routedTotal: number;
  /** Buffered shock points landed on meters. */
  shockApplied: number;
  /** Rally restores applied to routers. */
  ralliesApplied: number;
  /** Episodes ended because the threat died or fell far behind. */
  safeExits: number;
  /** Episodes ended by recovery/rally clearing the exit margin. */
  ralliedExits: number;
  /** Foreign queue heads overwritten while routing (orders ignored). */
  ordersSuppressed: number;
}

export function createMoraleDiagnostics(): MoraleDiagnostics {
  return {
    routedTotal: 0,
    shockApplied: 0,
    ralliesApplied: 0,
    safeExits: 0,
    ralliedExits: 0,
    ordersSuppressed: 0,
  };
}

// ---- Pure helpers ---------------------------------------------------------------

function rareTickDue(tick: number, eid: number): boolean {
  return (tick + eid) % MORALE_RARE_TICK_INTERVAL === 0;
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

/** Unit direction from the threat back past the router. */
function fleeDirection(
  px: number,
  py: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = px - tx;
  const dy = py - ty;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 1e-9) return { x: 0, y: 1 }; // overlapped: run "north"
  return { x: dx / len, y: dy / len };
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the morale SimSystem. Register AFTER combat (consumes its event
 * logs), after needs/social so their meter writes settle first, and
 * BEFORE schedules/the pop brain so a freshly-exited router's empty
 * queue is employable the moment its panic ends.
 */
export function createMoraleSystem(
  comps: SimComponents & MoraleComponents,
  diagnostics: MoraleDiagnostics = createMoraleDiagnostics(),
): SimSystem {
  // Incremental CombatEvents cursor per player ledger — deaths AND
  // damage ride one log, consumed monotonically (social.ts pattern).
  const processedEventsByLedger = new Map<number, number>();

  return (world: World): void => {
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    const identityRows = world.rowsByComponentId.get(comps.identityId);
    const combatRows = world.rowsByComponentId.get(comps.combatId);
    const needsRows = world.rowsByComponentId.get(comps.needsId);
    const moraleRows = world.rowsByComponentId.get(comps.moraleId);
    if (!moraleRows || moraleRows.size === 0) return;

    const hasNeedsMeter = (eid: number): boolean =>
      needsRows?.has(eid) === true;

    /** Owner of a unit (explicit Owner row, else Combat row, else 0). */
    const ownerOf = (eid: number): number =>
      world.rowsByComponentId.get(comps.ownerId)?.get(eid)?.[0] ??
      combatRows?.get(eid)?.[1] ??
      0;

    /** Living hostile-combatant check for threat validation. */
    const isLivingHostile = (threatEid: number, owner: number): boolean =>
      threatEid > 0 &&
      tagRows?.has(threatEid) === true &&
      posRows?.has(threatEid) === true &&
      (combatRows?.get(threatEid)?.[1] ?? -1) !== owner;

    /**
     * Nearest living enemy combatant of `owner` within `radius` tiles
     * of (x, y) — the fallback threat when a shock's killer already
     * died. Strict < keeps ties on the lower eid.
     */
    const nearestEnemyOf = (
      x: number,
      y: number,
      owner: number,
      radius: number,
    ): number => {
      if (!combatRows) return 0;
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      const rSq = radius * radius;
      for (const [eid, row] of combatRows) {
        if (!tagRows?.has(eid)) continue;
        if (row[1] === owner) continue;
        const pos = posRows?.get(eid);
        if (!pos) continue;
        const d = (pos[0]! - x) ** 2 + (pos[1]! - y) ** 2;
        if (d <= rSq && d < bestD) {
          bestD = d;
          best = eid;
        }
      }
      return best;
    };

    /** Cancel work claims + queued activities (the stop-command shape). */
    const releaseOrdersAndJobs = (eid: number): void => {
      clearAssignedNode(world, comps, eid);
      clearAssignedSite(world, comps, eid);
      clearProductionJob(world, comps, eid);
      const queue = readActivityQueue(world, comps, eid);
      cancelActivities(queue);
      writeActivityQueue(world, comps, eid, queue);
    };

    /** Plan one [Move away-from-threat] leg and aim steering at it. */
    const planFleeLeg = (
      eid: number,
      px: number,
      py: number,
      threatPos: readonly number[],
    ): void => {
      const dir = fleeDirection(px, py, threatPos[0]!, threatPos[1]!);
      const rawX = px + dir.x * FLEE_STEP_TILES;
      const rawY = py + dir.y * FLEE_STEP_TILES;
      const tile = nearestPassableTile(
        passability,
        size,
        Math.floor(rawX),
        Math.floor(rawY),
      );
      const wx = tile
        ? tile.x + 0.5
        : Math.min(Math.max(rawX, 0.5), size - 0.5);
      const wy = tile
        ? tile.y + 0.5
        : Math.min(Math.max(rawY, 0.5), size - 0.5);
      writeActivityQueue(world, comps, eid, [moveActivity([wx, wy])]);
      world.rowsByComponentId.get(comps.moveTargetId)?.set(eid, [wx, wy]);
      const velRow = velRows?.get(eid);
      if (velRow) resetSteeringBookkeeping(velRow);
    };

    /**
     * Enter routing around `candidateThreat`, validating that something
     * living and hostile actually threatens the breaker — a shock with
     * nobody left to fear lands as plain morale damage. Drops claims,
     * engagement, plans the first flee leg.
     */
    const breakIntoRouting = (
      eid: number,
      candidateThreat: number,
      moraleRow: number[],
    ): void => {
      if (moraleRow[0] === 1) return;
      if (!hasNeedsMeter(eid)) return;
      const meter = needsRows!.get(eid)!;
      if (meter[2]! > moraleBreakPointOf(world, comps, eid)) return;
      const pos = posRows?.get(eid);
      if (!pos) return;
      const owner = ownerOf(eid);
      let threat = candidateThreat;
      if (!isLivingHostile(threat, owner)) {
        threat = nearestEnemyOf(
          pos[0]!,
          pos[1]!,
          owner,
          ROUTE_SAFE_DISTANCE_TILES,
        );
      }
      if (!isLivingHostile(threat, owner)) return;
      const threatPos = posRows!.get(threat)!;
      releaseOrdersAndJobs(eid);
      const combatRow = combatRows?.get(eid);
      if (combatRow) combatRow[3] = 0; // routers drop engagements
      enterRouting(moraleRow, threat, world.tick);
      planFleeLeg(eid, pos[0]!, pos[1]!, threatPos);
      diagnostics.routedTotal += 1;
    };

    /** End an episode: clear flags, halt the flight, count the exit. */
    const endRouting = (
      eid: number,
      moraleRow: number[],
      safe: boolean,
    ): void => {
      exitRouting(moraleRow);
      const queue = readActivityQueue(world, comps, eid);
      cancelActivities(queue);
      writeActivityQueue(world, comps, eid, queue);
      const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
      if (velRow) resetSteeringBookkeeping(velRow);
      if (safe) diagnostics.safeExits += 1;
      else diagnostics.ralliedExits += 1;
    };

    /**
     * Family/companion death shock: every living named Pop bound to the
     * victim takes ONE buffered shock (household beats companion when
     * both match), ascending eid. The victim's own rows are already
     * gone (despawn is immediate), so the household resolves through
     * the PERSISTENT Household rows' stale-by-design head/partner eids.
     */
    const applyDeathShocks = (victim: number, attacker: number): void => {
      let familyId = FAMILY_UNASSIGNED;
      const householdRows = world.rowsByComponentId.get(comps.householdId);
      if (householdRows !== undefined) {
        for (const [famEid, row] of householdRows) {
          if (row[2] === victim || row[3] === victim) {
            familyId = famEid;
            break;
          }
        }
      }
      for (const eid of world.entities) {
        if (eid === victim) continue;
        const moraleRow = moraleRows.get(eid);
        if (!moraleRow) continue;
        if (!tagRows?.has(eid) || !identityRows?.has(eid)) continue;
        if (!hasNeedsMeter(eid)) continue;
        const identity = readIdentity(world, comps, eid);
        if (!identity) continue;
        const isFamily =
          familyId !== FAMILY_UNASSIGNED && identity.familyId === familyId;
        let base = 0;
        if (isFamily) {
          base = FAMILY_DEATH_MORALE_SHOCK;
        } else {
          const bond = relationshipValueOf(world, comps, eid, victim) ?? 0;
          if (bond >= COMPANION_BOND_MIN) base = COMPANION_DEATH_MORALE_SHOCK;
        }
        if (base === 0) continue;
        const applied = applyBufferedMoraleShock(world, comps, eid, base);
        diagnostics.shockApplied += applied;
        if (applied > 0) breakIntoRouting(eid, attacker, moraleRow);
      }
    };

    // ---- 1) Consume fresh combat events: shocks, then break checks --
    const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
    const eventsByLedger = world.rowsByComponentId.get(comps.combatEventsId);
    if (stockpileRows && eventsByLedger && needsRows) {
      for (const [ledgerEid] of stockpileRows) {
        const events = eventsByLedger.get(ledgerEid);
        if (!events) continue;
        const total = events[0]!;
        const processed = processedEventsByLedger.get(ledgerEid) ?? 0;
        if (total <= processed) continue;
        for (let i = processed; i < total; i++) {
          const kind = events[2 + i * 5]!;
          const attacker = events[3 + i * 5]!;
          const victim = events[4 + i * 5]!;
          if (kind === COMBAT_EVENT_UNIT_DEATH) {
            applyDeathShocks(victim, attacker);
          } else if (kind === COMBAT_EVENT_DAMAGE) {
            const moraleRow = moraleRows.get(victim);
            if (!moraleRow || !hasNeedsMeter(victim)) continue;
            const applied = applyBufferedMoraleShock(
              world,
              comps,
              victim,
              SELF_DAMAGE_MORALE_SHOCK,
            );
            diagnostics.shockApplied += applied;
            if (applied > 0) breakIntoRouting(victim, attacker, moraleRow);
          }
        }
        processedEventsByLedger.set(ledgerEid, total);
      }
    }

    // ---- 2) Router maintenance, ascending eid ------------------------
    for (const eid of world.entities) {
      const moraleRow = moraleRows.get(eid);
      if (!moraleRow || moraleRow[0] !== 1) continue;
      if (!tagRows?.has(eid)) continue;
      const pos = posRows?.get(eid);
      if (!pos) continue;
      const threat = moraleRow[1]!;
      const owner = ownerOf(eid);
      const threatPos = posRows?.get(threat);
      if (!isLivingHostile(threat, owner) || !threatPos) {
        endRouting(eid, moraleRow, true); // threat dead: safe
        continue;
      }
      const dx = threatPos[0]! - pos[0]!;
      const dy = threatPos[1]! - pos[1]!;
      if (dx * dx + dy * dy > ROUTE_SAFE_DISTANCE_TILES ** 2) {
        endRouting(eid, moraleRow, true); // outpaced the danger
        continue;
      }
      // Order suppression + flee upkeep: anything that is not our
      // current flee Move gets replaced THIS tick. An empty queue on a
      // router is interference too — combat just shed the ordered
      // engagement, or schedules cancelled the chain; either way the
      // order did not stick.
      const queue = readActivityQueue(world, comps, eid);
      const head = queue[0];
      if (head === undefined || head.kind !== "move") {
        diagnostics.ordersSuppressed += 1;
        planFleeLeg(eid, pos[0]!, pos[1]!, threatPos);
        continue;
      }
      const tailX = head.waypoints[head.waypoints.length - 2]!;
      const tailY = head.waypoints[head.waypoints.length - 1]!;
      const arrivedSq =
        (tailX - pos[0]!) ** 2 + (tailY - pos[1]!) ** 2 <
        FLEE_ARRIVED_TILES ** 2;
      if (arrivedSq) {
        planFleeLeg(eid, pos[0]!, pos[1]!, threatPos);
      }
    }

    // ---- 3) Staggered rare-tick pass: recovery, rally, rallied exit -
    const tick = world.tick;
    for (const eid of world.entities) {
      const moraleRow = moraleRows.get(eid);
      if (!moraleRow) continue;
      if (!tagRows?.has(eid)) continue;
      if (!rareTickDue(tick, eid)) continue;
      if (!hasNeedsMeter(eid)) continue;
      const meter = needsRows!.get(eid)!;
      if (moraleRow[0] !== 1) {
        // Steady: recover toward baseline.
        if (meter[2]! < NEED_MAX) {
          meter[2] = Math.min(
            NEED_MAX,
            meter[2]! + MORALE_RECOVERY_PER_RARE_TICK,
          );
        }
        continue;
      }
      // Router: nearby high-morale same-owner allies rally them.
      const pos = posRows?.get(eid);
      if (pos && needsRows && posRows) {
        const owner = ownerOf(eid);
        const rSq = RALLY_RADIUS_TILES ** 2;
        for (const other of world.entities) {
          if (other === eid) continue;
          if (!needsRows.has(other)) continue;
          if (isRoutingOf(world, comps, other)) continue;
          if (ownerOf(other) !== owner) continue;
          const otherMeter = needsRows.get(other)!;
          if (otherMeter[2]! < RALLY_ALLY_MORALE_MIN) continue;
          const otherPos = posRows.get(other);
          if (!otherPos) continue;
          const ddx = otherPos[0]! - pos[0]!;
          const ddy = otherPos[1]! - pos[1]!;
          if (ddx * ddx + ddy * ddy > rSq) continue;
          meter[2] = Math.min(NEED_MAX, meter[2]! + RALLY_MORALE_RESTORE);
          diagnostics.ralliesApplied += 1;
        }
      }
      // Rallied/recovered exit: cleared break point plus margin.
      if (
        meter[2]! >=
        moraleBreakPointOf(world, comps, eid) + ROUTE_EXIT_MARGIN
      ) {
        endRouting(eid, moraleRow, false);
      }
    }
  };
}

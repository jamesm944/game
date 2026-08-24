/**
 * Pop needs system — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Two responsibilities, both strictly inside step():
 *
 * 1. RARE-TICK DECAY — each Pop's three meters (components/needs.ts)
 *    fall only on its hash-staggered rare tick,
 *    `(tick + eid) % NEEDS_TICK_INTERVAL === 0`, so 300 Pops cost one
 *    decay pass every ~8 ticks amortized instead of 300 every tick.
 *    Starving/exhausted Pops bleed extra morale (the interim moodlet
 *    stand-in until §2.4 venues land); everything stays integer and
 *    digest-visible.
 *
 * 2. EAT-FROM-STOCKPILE — a hungry Pop walks to the NEAREST drop-off
 *    whose filter list accepts food AND whose owner ledger actually
 *    holds a meal's worth, then debits exactly EAT_FOOD_COST food and
 *    restores its meters. The walk rides plain Move activities steered
 *    by the movement system; the meal itself is a new digest-visible
 *    `eat` activity head advanced here (attack-style: while out of
 *    range a fresh approach leg is inserted AHEAD of the head).
 *
 *    Hunger interrupts work in two bands: idle Pops eat at/below
 *    HUNGRY_FOOD_LEVEL; any Pop at/below EMERGENCY_FOOD_LEVEL drops
 *    its assignment mid-chain (rows cleared — the same visible state
 *    every other release path uses) and goes to eat. Cargo in hand is
 *    preserved; the next assignment resumes it.
 *
 * REST PENALTY (interim until T6 full sleep): a drained rest meter
 * slows work through {@link restWorkMultiplierOf}, folded into the
 * gather ticks-per-unit and construction milli-tick read paths.
 * Rowless legacy Pops multiply by exactly 1 — pre-M3 digests are
 * byte-identical by construction.
 */

import {
  cancelActivities,
  dequeueCurrentActivity,
  eatActivity,
  enqueueActivity,
  moveActivity,
  peekActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { clearAssignedNode, RESOURCE_FOOD } from "../components/economy";
import { clearAssignedSite } from "../components/buildings";
import { clearProductionJob } from "../components/production";
import {
  NEED_MAX,
  needsRareTickDue,
  type NeedsComponents,
} from "../components/needs";
import {
  canDebitLedgerSlugs,
  debitLedgerSlugs,
  dropOffAccepts,
  dropOffOwnerOf,
} from "../core/stockpile";
import type { SimSystem, World } from "../core/world";
import { resetSteeringBookkeeping } from "./movement";

// ---- Documented tuning constants ---------------------------------------------

/** Idle Pops head for a meal at/below this food level. */
export const HUNGRY_FOOD_LEVEL = 50;
/** Any Pop at/below this drops work mid-chain and eats NOW. */
export const EMERGENCY_FOOD_LEVEL = 10;
/** Food ledger units one meal debits. */
export const EAT_FOOD_COST = 6;
/** Meter restoration per eaten meal (clamped at NEED_MAX). */
export const EAT_FOOD_RESTORE = 60;
export const EAT_REST_RESTORE = 20;
export const EAT_MORALE_RESTORE = 50;

/** Per-rare-tick decay rates. One 8-minute day ≈ 58 rare ticks, so a full meter lasts ~1.7 days unattended. */
export const FOOD_DECAY_PER_RARE_TICK = 1;
export const REST_DECAY_PER_RARE_TICK = 1;
export const MORALE_DECAY_PER_RARE_TICK = 1;
/** Extra morale bled per rare tick while starving / exhausted. */
export const STARVATION_MORALE_PENALTY = 4;
export const EXHAUSTION_MORALE_PENALTY = 1;

/** Rest at/above this level costs nothing; below it work slows linearly. */
export const REST_WORK_FULL_LEVEL = 60;
/** Work multiplier floor at rest 0 (interim penalty until T6 sleep). */
export const REST_WORK_FLOOR_MULT = 0.75;

/** Distance from the depot center within which a meal may be eaten. */
export const EAT_ARRIVAL_RADIUS = 3.5;

/** Interim work-speed multiplier from one Pop's rest meter: 1 while
 * rested (rest ≥ REST_WORK_FULL_LEVEL), linear down to
 * REST_WORK_FLOOR_MULT at rest 0. Exactly 1 for rowless Pops — call
 * sites skip scaling entirely, keeping legacy arithmetic untouched.
 */
export function restWorkMultiplierOf(
  world: World,
  comps: Pick<SimComponents, "needsId"> & NeedsComponents,
  eid: number,
): number {
  const row = world.rowsByComponentId.get(comps.needsId)?.get(eid);
  if (!row) return 1;
  const rest = Math.min(Math.max(row[1]!, 0), NEED_MAX);
  if (rest >= REST_WORK_FULL_LEVEL) return 1;
  const slope = (1 - REST_WORK_FLOOR_MULT) / REST_WORK_FULL_LEVEL;
  return REST_WORK_FLOOR_MULT + slope * rest;
}

// ---- Diagnostics ------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface NeedsDiagnostics {
  /** Meals eaten (ledger debited, meters restored). */
  eatsCompleted: number;
  /** Meals aborted because the depot died or stopped accepting food. */
  spoiledMeals: number;
  /** Hungry Pop-ticks that found no payable/accepting depot nearby. */
  blockedHungryTicks: number;
  /** Work chains dropped by an emergency hunger interrupt. */
  emergencyEats: number;
  /** Decay passes that left a Pop starving (food 0). */
  starvedPopTicks: number;
}

export function createNeedsDiagnostics(): NeedsDiagnostics {
  return {
    eatsCompleted: 0,
    spoiledMeals: 0,
    blockedHungryTicks: 0,
    emergencyEats: 0,
    starvedPopTicks: 0,
  };
}

interface DepotInfo {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

function tileIsPassable(
  passability: Uint8Array,
  size: number,
  x: number,
  y: number,
): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return passability[y * size + x] === 1;
}

/** Nearest passable tile to (tx, ty) by expanding square rings, or null. */
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
        if (tileIsPassable(passability, size, x, y)) return { x, y };
      }
    }
  }
  return undefined;
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the needs SimSystem. Register AFTER gather/construction/
 * production/training so an emergency release sticks until the next
 * tick (their planners never see the emptied queues this tick), and
 * before the pop brain so freshly-fed idles are employable.
 */
export function createNeedsSystem(
  comps: SimComponents,
  diagnostics: NeedsDiagnostics = createNeedsDiagnostics(),
): SimSystem {
  return (world: World): void => {
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    const needsRows = world.rowsByComponentId.get(comps.needsId);
    if (!needsRows) throw new Error("unregistered Needs component");
    const tick = world.tick;

    /**
     * Live food-accepting depots ascending-eid, memoized per tick.
     * Payability (owner ledger holds a meal) is checked at selection
     * time per hungry Pop — acceptance masks are static per building.
     */
    let depotsMemo: DepotInfo[] | undefined;
    const foodDepots = (): DepotInfo[] => {
      if (depotsMemo) return depotsMemo;
      const out: DepotInfo[] = [];
      const dropRows = world.rowsByComponentId.get(comps.dropoffId);
      if (posRows && dropRows) {
        for (const eid of world.entities) {
          const row = dropRows.get(eid);
          if (!row) continue;
          if (!dropOffAccepts(world, comps, eid, RESOURCE_FOOD)) continue;
          const pos = posRows.get(eid);
          if (!pos) continue;
          out.push({ eid, x: pos[0]!, y: pos[1]! });
        }
      }
      depotsMemo = out;
      return out;
    };

    /**
     * Nearest payable food depot from (x, y): strict `<` distance race
     * ties break toward the lower (ascending-eid) rank. Undefined when
     * no depot pays today.
     */
    const nearestPayableDepot = (
      x: number,
      y: number,
    ): DepotInfo | undefined => {
      let best: DepotInfo | undefined;
      let bestD = Number.POSITIVE_INFINITY;
      for (const depot of foodDepots()) {
        const owner = dropOffOwnerOf(world, comps, depot.eid);
        if (owner === undefined) continue;
        if (
          !canDebitLedgerSlugs(world, comps, owner, [
            { defId: "food", qty: EAT_FOOD_COST },
          ])
        ) {
          continue;
        }
        const d = (depot.x - x) ** 2 + (depot.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = depot;
        }
      }
      return best;
    };

    /** Approach tile beside a depot: nearest passable neighbor ring. */
    const depotDoorOf = (depot: DepotInfo): { x: number; y: number } => {
      const near = nearestPassableTile(
        passability,
        size,
        Math.floor(depot.x),
        Math.floor(depot.y),
      );
      return near
        ? { x: near.x + 0.5, y: near.y + 0.5 }
        : { x: depot.x, y: depot.y };
    };

    /**
     * Queue [Move door, Eat depot] on an empty queue and aim steering
     * at the door. Caller guarantees the queue was just emptied.
     */
    const planEatChain = (eid: number, depot: DepotInfo): void => {
      const door = depotDoorOf(depot);
      const queue = readActivityQueue(world, comps, eid);
      enqueueActivity(queue, moveActivity([door.x, door.y]));
      enqueueActivity(queue, eatActivity(depot.eid));
      writeActivityQueue(world, comps, eid, queue);
      setMoveTarget(world, comps, eid, door.x, door.y);
      const velRow = velRows?.get(eid);
      if (velRow) resetSteeringBookkeeping(velRow);
    };

    /** Release every job row + queued activity (emergency interrupt). */
    const releaseAllJobs = (eid: number): void => {
      clearAssignedNode(world, comps, eid);
      clearAssignedSite(world, comps, eid);
      clearProductionJob(world, comps, eid);
      const queue = readActivityQueue(world, comps, eid);
      cancelActivities(queue);
      writeActivityQueue(world, comps, eid, queue);
    };

    /**
     * Execute one Eat head within reach of its depot: debit the meal,
     * restore the meters, drop the head. Returns false when the depot
     * vanished or stopped accepting (caller cancels the chain); returns
     * "waiting" via `undefined` when the ledger went short between
     * planning and arrival (head stays; retry next tick).
     */
    const executeEatHead = (
      dropoffEid: number,
      row: number[],
    ): boolean | undefined => {
      if (
        world.rowsByComponentId.get(comps.dropoffId)?.has(dropoffEid) !== true
      ) {
        diagnostics.spoiledMeals += 1;
        return false;
      }
      if (!dropOffAccepts(world, comps, dropoffEid, RESOURCE_FOOD)) {
        diagnostics.spoiledMeals += 1;
        return false;
      }
      const owner = dropOffOwnerOf(world, comps, dropoffEid)!;
      if (
        !canDebitLedgerSlugs(world, comps, owner, [
          { defId: "food", qty: EAT_FOOD_COST },
        ])
      ) {
        diagnostics.blockedHungryTicks += 1;
        return undefined;
      }
      debitLedgerSlugs(
        world,
        comps,
        owner,
        [{ defId: "food", qty: EAT_FOOD_COST }],
        "a Pop meal",
      );
      row[0] = Math.min(NEED_MAX, row[0]! + EAT_FOOD_RESTORE);
      row[1] = Math.min(NEED_MAX, row[1]! + EAT_REST_RESTORE);
      row[2] = Math.min(NEED_MAX, row[2]! + EAT_MORALE_RESTORE);
      diagnostics.eatsCompleted += 1;
      return true;
    };

    // ---- Per-Pop pass, ascending eid -------------------------------
    for (const eid of world.entities) {
      const row = needsRows.get(eid);
      if (!row) continue;
      if (!tagRows?.has(eid)) continue; // needs ride units only

      // -- 1) Staggered rare-tick decay (hash-offset by eid).
      if (needsRareTickDue(tick, eid)) {
        const starving = row[0]! <= 0;
        const exhausted = row[1]! <= 0;
        // M3-T6: a sleeping Pop's rest meter is FROZEN — sleep restores
        // via the schedules system's wake refill, so decay would just
        // eat the lump before it lands. The exhaustion morale bleed is
        // likewise suspended for the night.
        const asleep =
          peekActivity(readActivityQueue(world, comps, eid))?.kind === "sleep";
        row[0] = Math.max(0, row[0]! - FOOD_DECAY_PER_RARE_TICK);
        if (!asleep) {
          row[1] = Math.max(0, row[1]! - REST_DECAY_PER_RARE_TICK);
        }
        row[2] = Math.max(
          0,
          row[2]! -
            MORALE_DECAY_PER_RARE_TICK -
            (starving ? STARVATION_MORALE_PENALTY : 0) -
            (exhausted && !asleep ? EXHAUSTION_MORALE_PENALTY : 0),
        );
        if (row[0]! <= 0) diagnostics.starvedPopTicks += 1;
      }

      // -- 2) Eat behavior (every tick; cheap until someone's hungry).
      const foodLevel = row[0]!;
      if (foodLevel > HUNGRY_FOOD_LEVEL) continue;
      const queue = readActivityQueue(world, comps, eid);

      const head = peekActivity(queue);
      if (head?.kind === "eat") {
        // Approach legs first: movement owns Move heads; while the Eat
        // head sits behind one we wait. Once it reaches the front,
        // range-check against the depot (inserting a fresh leg when
        // the old one was consumed early or the crowd pushed us out).
        if (queue.length > 1) continue;
        const pos = posRows?.get(eid);
        const depotPos = posRows?.get(head.dropoffEid);
        if (!pos || !depotPos) {
          cancelActivities(queue);
          writeActivityQueue(world, comps, eid, queue);
          continue;
        }
        const dSq =
          (pos[0]! - depotPos[0]!) ** 2 + (pos[1]! - depotPos[1]!) ** 2;
        if (dSq > EAT_ARRIVAL_RADIUS ** 2) {
          // Out of reach: re-insert an approach leg ahead of the head.
          const door = depotDoorOf({
            eid: head.dropoffEid,
            x: depotPos[0]!,
            y: depotPos[1]!,
          });
          queue.unshift(moveActivity([door.x, door.y]));
          writeActivityQueue(world, comps, eid, queue);
          setMoveTarget(world, comps, eid, door.x, door.y);
          const velRow = velRows?.get(eid);
          if (velRow) resetSteeringBookkeeping(velRow);
          continue;
        }
        const result = executeEatHead(head.dropoffEid, row);
        if (result === false) {
          cancelActivities(queue);
          writeActivityQueue(world, comps, eid, queue);
          continue;
        }
        if (result === true) dequeueCurrentActivity(queue);
        writeActivityQueue(world, comps, eid, queue);
        continue;
      }

      // Not already eating: decide whether THIS tick plans a meal.
      const emergency = foodLevel <= EMERGENCY_FOOD_LEVEL;
      const employed =
        world.rowsByComponentId.get(comps.assignedNodeId)?.has(eid) === true ||
        world.rowsByComponentId.get(comps.assignedSiteId)?.has(eid) === true ||
        world.rowsByComponentId.get(comps.productionJobId)?.has(eid) === true;
      if (!emergency && (employed || queue.length > 0)) continue;

      const pos = posRows?.get(eid);
      if (!pos) continue;
      const depot = nearestPayableDepot(pos[0]!, pos[1]!);
      if (!depot) {
        diagnostics.blockedHungryTicks += 1;
        continue;
      }
      if (emergency && (employed || queue.length > 0)) {
        releaseAllJobs(eid);
        diagnostics.emergencyEats += 1;
      }
      planEatChain(eid, depot);
    }
  };
}

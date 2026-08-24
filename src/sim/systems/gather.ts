/**
 * Gather system — SPEC §2.6 economy core loop / M1-T9.
 *
 * AoE2-faithful gather chain per assigned worker:
 *
 *   Move(work slot) → Gather{ticksPerUnit} until carry fills or node
 *   depletes → Move(cheapest known drop-off) → Deliver (deposit into
 *   the owner's stockpile) → auto-repeat back to the SAME slot.
 *
 * Travel legs are plain Move activities — steered, stalled and
 * auto-repathed by the movement system; this system owns Gather and
 * Deliver heads plus all chain construction, exclusively inside step()
 * so every mutation stays a deterministic replay event.
 *
 * Work slots: each node exposes up to its declared slot count on its
 * PASSABLE adjacent tiles, enumerated clockwise from north. Claims are
 * DERIVED STATE — recomputed every tick from the AssignedNode worker
 * set alone with strict ascending-eid priority, never from positions or
 * hidden tables — so a worker walking cargo to a drop-off keeps its
 * slot, uncontended auto-repeat resumes the exact same slot, and every
 * reassignment is a pure function of digest-visible rows. Workers past
 * the capacity mill on an outer holding ring around the node
 * (formation ring 2+) and take freed slots as ascending eid allows.
 *
 * Drop-off choice: cheapest KNOWN drop-off point by exact A* path cost
 * from the worker's tile, among those whose filter mask admits the
 * carried resource (M2-T2 — the per-building `dropoffFilters` lists of
 * SPEC §2.6 resolved into DropOff rows at completion). A resource no
 * candidate accepts leaves the carrier idle at the node holding its
 * cargo, counted in diagnostics; a target that stops accepting between
 * planning and arrival refuses the deposit event and the worker reroutes
 * to the next cheapest accepting point. Costs cache per
 * (worker-tile, drop-off) pair and invalidate wholesale when the path
 * scheduler's passabilityVersion bumps. A cached cost is bit-identical
 * to a fresh one, so warm vs cold caches cannot change any decision;
 * equal costs tie-break to the lower (ascending-eid) drop-off rank.
 *
 * Deposits are deterministic events executed while advancing Deliver
 * activities inside step(), crediting the drop-off owner's stockpile
 * rows (core/stockpile.ts) — digest-visible by construction.
 *
 * M2-T7 raid destruction: a drop-off whose building died mid-flight
 * (DropOff row gone) aborts the carrier's chain with nothing credited
 * and planning reroutes to the next cheapest ACCEPTING point — or the
 * worker idles holding cargo, counted, when no candidate remains.
 */

import {
  cancelActivities,
  dequeueCurrentActivity,
  deliverActivity,
  enqueueActivity,
  gatherActivity,
  moveActivity,
  peekActivity,
  type ActivityQueue,
  type DeliverActivity,
  type GatherActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import {
  assignNode,
  clearAssignedNode,
  ensureCarryCapacity,
  ensureInventory,
  getCarryCapacity,
  getInventory,
  setInventory,
  WORK_SLOTS_PER_NODE,
} from "../components/economy";
import { clearAssignedSite } from "../components/buildings";
import {
  depositIntoStockpile,
  dropOffAccepts,
  dropOffOwnerOf,
} from "../core/stockpile";
import { findPath } from "../path/astar";
import type { PathScheduler } from "../path/scheduler";
import type { SimSystem } from "../core/world";
import { RESOURCE_SLUGS } from "../../data/schema";
import {
  awardPractice,
  GATHER_XP_PER_UNIT,
  resolveGatherInterval,
} from "./skills";
import {
  formationSlotOffset,
  isSteeringJammed,
  resetSteeringBookkeeping,
} from "./movement";
import { isChildOf } from "./lifecycle";

/** Ticks of slot work per extracted resource unit (1 s at 30 Hz). */
export const DEFAULT_GATHER_TICKS_PER_UNIT = 30;

/**
 * Output observers (M4-T2): invoked at every Deliver credit event with
 * the credited drop-off building, resource slug and unit count — the
 * companies ledger taps this to route branch shares to treasuries.
 */
export interface GatherOutputObservers {
  readonly onOutput?: import("./companies").BranchOutputObserver | undefined;
}
/** Distance from the slot center within which slot work may begin. */
const SLOT_ARRIVAL_RADIUS = 0.35;
/** Distance from the holding point within which an overflow settles. */
const HOLDING_ARRIVAL_RADIUS = 0.5;
/**
 * Distance from the DROP-OFF CENTER within which cargo deposits.
 * Delivery must never require touching the exact point: carriers
 * converging on one depot reach shoving equilibria a few tiles out
 * (mutual push-apart in shared corridors), and the movement system's
 * arrival band can never trigger inside them. The widest observed
 * excursion on the m1t9 fixture was ~3.05 tiles, so 3.5 unloads
 * through any realistic pile-up; the check only ever applies mid-
 * delivery-run, so passing traffic cannot false-positive.
 */
const DELIVER_ARRIVAL_RADIUS = 3.5;
/**
 * Jam escape hatch: a carrier pinned this close to the depot while the
 * steering FSM reports a jam (deep stall / parked contact / halted by
 * propagation) unloads where it stands instead of grinding forever a
 * couple of tiles short of the normal range.
 */
const DELIVER_JAM_RADIUS = 6;
/**
 * Radial multiplier placing per-worker approach doors around the depot
 * edge; walking targets spread arrivals instead of funnelling them.
 */
const DELIVER_DOOR_SCALE = 1.6;
/** formationSlotOffset index where the overflow holding ring starts. */
const OVERFLOW_RING_START_INDEX = 9;
/**
 * Pinned neighbor enumeration order for work slots: clockwise starting
 * north. Impassable neighbors drop out entirely — later slots keep
 * their enumeration rank instead of renumbering.
 */
const WORK_SLOT_NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

// ---- Diagnostics ------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface GatherDiagnostics {
  /** gather commands applied. */
  commandsApplied: number;
  /** Resource units extracted from nodes, indexed by resource code. */
  extractedByResource: number[];
  /** Resource units deposited into stockpiles, indexed by resource code. */
  depositedByResource: number[];
  /** Deliveries per drop-off point, indexed by ascending-eid rank. */
  deliveriesByDropOff: number[];
  /**
   * Deposit attempts refused because the TARGETED point's filter list
   * rejects the carried resource (M2-T2). Healthy choice-time filtering
   * keeps this at zero; it rises only when acceptance changed between
   * planning and arrival — the deposit never happens either way.
   */
  rejectedByFilter: number;
  /**
   * Ticks workers ended holding cargo because NO known drop-off accepts
   * their carried resource (M2-T2 idle-with-cargo fallback). One tick
   * of waiting counts once per blocked worker per tick.
   */
  blockedCarryTicks: number;
  /**
   * Deposit runs abandoned because their TARGETED drop-off entity died
   * mid-flight (M2-T7 raid destruction): nothing is credited, the chain
   * cancels and planning reroutes to the next cheapest accepting point
   * — or idles holding cargo when none remains.
   */
  destroyedDropoffReroutes: number;
}

export function createGatherDiagnostics(): GatherDiagnostics {
  return {
    commandsApplied: 0,
    // One slot per gatherable resource code (SPEC §2.6, seven slugs).
    extractedByResource: [0, 0, 0, 0, 0, 0, 0],
    depositedByResource: [0, 0, 0, 0, 0, 0, 0],
    deliveriesByDropOff: [],
    rejectedByFilter: 0,
    blockedCarryTicks: 0,
    destroyedDropoffReroutes: 0,
  };
}

// ---- Small shared views ------------------------------------------------------

interface SlotPoint {
  readonly x: number;
  readonly y: number;
}

interface DropOffInfo {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  /** Filter mask: bit k set = gatherable code k may deposit here. */
  readonly mask: number;
}

interface GroupedWorker {
  readonly eid: number;
  readonly posX: number;
  readonly posY: number;
  /** Live AssignedNode row [nodeEid, slotIndex] — claims write here. */
  readonly assignedRow: number[];
}

interface ClaimedWorker extends GroupedWorker {
  readonly nodeEid: number;
  /** Live ResourceNode row [resourceCode, remaining, workSlots]. */
  readonly nodeRow: number[];
  readonly resourceCode: number;
  /** Claimed index into `slots`; −1 marks an overflow miller. */
  readonly slotIndex: number;
  /** Overflow rank on the outer holding ring; −1 when slotted. */
  readonly overflowRank: number;
  readonly slots: readonly SlotPoint[];
  readonly holdingX: number;
  readonly holdingY: number;
}

/**
 * Version-gated path-cost cache: key = dropOffRank·tileCount +
 * fromTileIndex, value = exact A* cost (×1000) or Infinity when no
 * route exists. Cached costs are pure in passability, so invalidating
 * on passabilityVersion bumps never changes a decision — it only
 * bounds staleness.
 */
interface DropOffCostCache {
  version: number;
  readonly costs: Map<number, number>;
}

// ---- Pure geometry/parsing helpers -------------------------------------------

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

/**
 * Work-slot centers for one node tile: passable neighbors in pinned
 * clockwise-from-north order, capped at the node's declared slot count.
 */
function workSlotPositionsFor(
  passability: Uint8Array,
  size: number,
  tileX: number,
  tileY: number,
  limit: number,
): SlotPoint[] {
  const slots: SlotPoint[] = [];
  for (const [dx, dy] of WORK_SLOT_NEIGHBOR_OFFSETS) {
    if (slots.length >= limit) break;
    const x = tileX + dx;
    const y = tileY + dy;
    if (!tileIsPassable(passability, size, x, y)) continue;
    slots.push({ x: x + 0.5, y: y + 0.5 });
  }
  return slots;
}

function parseGatherData(data: Readonly<Record<string, unknown>>): {
  entityIds: number[];
  nodeId: number;
} {
  const rawIds = data.entityIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("gather requires a non-empty entityIds array");
  }
  const entityIds: number[] = [];
  for (const id of rawIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `gather entityIds entries must be positive integers, got ${String(id)}`,
      );
    }
    if (!entityIds.includes(id)) entityIds.push(id);
  }
  entityIds.sort((a, b) => a - b);
  const nodeId = data.nodeId;
  if (typeof nodeId !== "number" || !Number.isInteger(nodeId) || nodeId < 1) {
    throw new Error(
      `gather nodeId must be a positive integer, got ${String(nodeId)}`,
    );
  }
  return { entityIds, nodeId };
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the gather SimSystem. `paths` supplies the live
 * passabilityVersion that gates the drop-off cost cache; omit it only
 * in worlds without a scheduler (the cache then keys off version 0,
 * which stays correct because costs are pure in passability).
 */
export function createGatherSystem(
  comps: SimComponents,
  paths?: PathScheduler | undefined,
  diagnostics: GatherDiagnostics = createGatherDiagnostics(),
  observers: GatherOutputObservers = {},
): SimSystem {
  const costCache: DropOffCostCache = { version: -1, costs: new Map() };
  /** Per-tick memo for drop-off enumeration (ranks must stay stable). */
  let dropOffsMemo: DropOffInfo[] | undefined;

  return (world, commands) => {
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;
    const tileCount = size * size;
    dropOffsMemo = undefined; // ranks re-derive from live rows every tick

    const queueOf = (eid: number): ActivityQueue =>
      readActivityQueue(world, comps, eid);

    const velRowOf = (eid: number): number[] => {
      const row = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
      if (!row) throw new Error(`entity ${String(eid)} has no Velocity row`);
      return row;
    };

    const releaseWorker = (eid: number): void => {
      clearAssignedNode(world, comps, eid);
      const queue = queueOf(eid);
      cancelActivities(queue);
      writeActivityQueue(world, comps, eid, queue);
    };

    /**
     * Live drop-off points ascending-eid with Position and filter mask,
     * memoized once per tick so ranks stay stable across all workers'
     * decisions.
     */
    const dropOffs = (): DropOffInfo[] => {
      if (dropOffsMemo) return dropOffsMemo;
      const out: DropOffInfo[] = [];
      const posRows = world.rowsByComponentId.get(comps.positionId);
      const dropRows = world.rowsByComponentId.get(comps.dropoffId);
      if (posRows && dropRows) {
        for (const eid of world.entities) {
          const row = dropRows.get(eid);
          if (!row) continue;
          const pos = posRows.get(eid);
          if (!pos) continue;
          out.push({ eid, x: pos[0]!, y: pos[1]!, mask: row[1]! });
        }
      }
      dropOffsMemo = out;
      return out;
    };

    /**
     * Cheapest known drop-off ACCEPTING `resourceCode` by exact A* cost
     * from the worker's tile (M2-T2): candidates whose filter mask
     * rejects the cargo never enter the cost race at all. Strict `<`
     * comparison ties-break toward the lower (ascending-eid) rank.
     * Returns undefined when none exists or none is reachable — the
     * caller keeps the carrier idle holding its cargo.
     */
    const cheapestDropOff = (
      fromX: number,
      fromY: number,
      resourceCode: number,
    ): DropOffInfo | undefined => {
      const version = paths?.passabilityVersion ?? 0;
      if (version !== costCache.version) {
        costCache.costs.clear();
        costCache.version = version;
      }
      let startX = Math.floor(fromX);
      let startY = Math.floor(fromY);
      if (!tileIsPassable(passability, size, startX, startY)) {
        const near = nearestPassableTile(passability, size, startX, startY);
        if (!near) return undefined;
        startX = near.x;
        startY = near.y;
      }
      const fromTileIdx = startY * size + startX;
      const acceptBit = 1 << resourceCode;
      let best: DropOffInfo | undefined;
      let bestCost = Number.POSITIVE_INFINITY;
      const candidates = dropOffs();
      for (let rank = 0; rank < candidates.length; rank++) {
        const candidate = candidates[rank]!;
        if ((candidate.mask & acceptBit) === 0) continue; // rejects cargo
        let goalX = Math.floor(candidate.x);
        let goalY = Math.floor(candidate.y);
        if (!tileIsPassable(passability, size, goalX, goalY)) {
          const near = nearestPassableTile(passability, size, goalX, goalY);
          if (!near) continue;
          goalX = near.x;
          goalY = near.y;
        }
        const key = rank * tileCount + fromTileIdx;
        let cost = costCache.costs.get(key);
        if (cost === undefined) {
          const result = findPath({
            passability,
            width: size,
            startX,
            startY,
            goalX,
            goalY,
          });
          cost = result ? result.cost : Number.POSITIVE_INFINITY;
          costCache.costs.set(key, cost);
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = candidate;
        }
      }
      return best;
    };

    const recordDelivery = (dropoffEid: number): void => {
      const rank = dropOffs().findIndex((d) => d.eid === dropoffEid);
      while (diagnostics.deliveriesByDropOff.length <= rank) {
        diagnostics.deliveriesByDropOff.push(0);
      }
      diagnostics.deliveriesByDropOff[rank]! += 1;
    };

    /**
     * True while the drop-off entity still holds its DropOff row.
     * Destruction (M2-T7) removes the row with the entity, so a carrier
     * mid-flight can detect the loss before touching position rows.
     */
    const dropOffAlive = (eid: number): boolean =>
      world.rowsByComponentId.get(comps.dropoffId)?.has(eid) ?? false;

    /** Drop-off world position; throws when the row vanished. */
    const dropOffPositionOf = (eid: number): { x: number; y: number } => {
      const pos = posRows?.get(eid);
      if (!pos) {
        throw new Error(
          `deliver targets entity ${String(eid)}, which has no Position row`,
        );
      }
      return { x: pos[0]!, y: pos[1]! };
    };

    /**
     * This worker's personal delivery door: whichever perimeter offset
     * around the depot lies closest to its current position (ties break
     * toward the lower enumeration rank). Pure in digest-visible data,
     * so any tick can re-derive it, and approaching workers naturally
     * spread across the whole depot edge instead of circling to a
     * fixed assigned side.
     */
    const deliverDoorOf = (
      fromX: number,
      fromY: number,
      drop: { x: number; y: number },
    ): { x: number; y: number } => {
      let bestX = drop.x;
      let bestY = drop.y;
      let bestDistanceSq = Number.POSITIVE_INFINITY;
      for (const [dx, dy] of WORK_SLOT_NEIGHBOR_OFFSETS) {
        const candidateX = Math.min(
          Math.max(drop.x + dx * DELIVER_DOOR_SCALE, 0.5),
          size - 0.5,
        );
        const candidateY = Math.min(
          Math.max(drop.y + dy * DELIVER_DOOR_SCALE, 0.5),
          size - 0.5,
        );
        const ddx = fromX - candidateX;
        const ddy = fromY - candidateY;
        const distanceSq = ddx * ddx + ddy * ddy;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestX = candidateX;
          bestY = candidateY;
        }
      }
      return { x: bestX, y: bestY };
    };

    /** True when the worker stands close enough to the depot to unload. */
    const withinDeliverRange = (
      worker: ClaimedWorker,
      drop: { x: number; y: number },
    ): boolean => {
      const ddx = worker.posX - drop.x;
      const ddy = worker.posY - drop.y;
      return ddx * ddx + ddy * ddy <= DELIVER_ARRIVAL_RADIUS ** 2;
    };

    /**
     * True when a jammed carrier should unload where it stands: pinned
     * within the jam radius while the steering FSM reports the unit is
     * not making progress (deep stall, parked contact, or halted by
     * propagation). Deterministic — every input is a digest-visible row.
     */
    const jammedNearDropOff = (
      worker: ClaimedWorker,
      drop: { x: number; y: number },
    ): boolean => {
      const ddx = worker.posX - drop.x;
      const ddy = worker.posY - drop.y;
      if (ddx * ddx + ddy * ddy > DELIVER_JAM_RADIUS ** 2) return false;
      return isSteeringJammed(velRowOf(worker.eid));
    };

    /** Apply one gather order: validate, attach rows, assign, reset. */
    const applyGatherCommand = (
      data: Readonly<Record<string, unknown>>,
    ): void => {
      const parsed = parseGatherData(data);
      const nodeRow = world.rowsByComponentId
        .get(comps.resourceNodeId)
        ?.get(parsed.nodeId);
      if (!nodeRow) {
        throw new Error(
          `gather command targets entity ${String(parsed.nodeId)}, which has no ResourceNode row`,
        );
      }
      const resourceCode = nodeRow[0]!;
      const posRows = world.rowsByComponentId.get(comps.positionId);
      const velRows = world.rowsByComponentId.get(comps.velocityId);
      const tagRows = world.rowsByComponentId.get(comps.unitTagId);
      for (const eid of parsed.entityIds) {
        const posRow = posRows?.get(eid);
        const velRow = velRows?.get(eid);
        const tagRow = tagRows?.get(eid);
        if (!posRow || !velRow || !tagRow) continue; // not a live unit
        if (isChildOf(world, comps, eid)) continue; // children cannot work (M3-T5)
        const carried = getInventory(world, comps, eid);
        if (
          carried !== undefined &&
          carried.amount > 0 &&
          carried.resourceCode !== resourceCode
        ) {
          // M1 workers carry ONE resource kind at a time (SPEC §2.6);
          // silently voiding or mixing loads would break conservation.
          throw new Error(
            `gather unit ${String(eid)} carries resource ${String(carried.resourceCode)} but node ${String(parsed.nodeId)} yields ${String(resourceCode)}`,
          );
        }
        ensureCarryCapacity(world, comps, eid);
        ensureInventory(world, comps, eid, resourceCode);
        // Re-tasking replaces any prior job (AoE2 order semantics):
        // a stale AssignedSite row would let the construction system
        // keep planning site walks against the new chop chain.
        clearAssignedSite(world, comps, eid);
        assignNode(world, comps, eid, parsed.nodeId);
        // A fresh order clears any prior chain and steering bookkeeping.
        const queue = queueOf(eid);
        cancelActivities(queue);
        writeActivityQueue(world, comps, eid, queue);
        resetSteeringBookkeeping(velRow);
      }
      diagnostics.commandsApplied += 1;
    };

    /**
     * Advance one gather head by a tick: extract at most one unit when
     * the work interval elapses. The interval derives on read from the
     * worker's gathering skill + work-speed traits (M3-T2) and the
     * M3-T3 rest penalty (tired workers swing slower; rowless legacy
     * workers keep the head's encoded base rate exactly). Returns true
     * when the activity is complete (carry full or node dry).
     */
    const advanceGatherHead = (
      worker: ClaimedWorker,
      head: GatherActivity,
    ): boolean => {
      head.elapsedTicks += 1;
      ensureCarryCapacity(world, comps, worker.eid);
      ensureInventory(world, comps, worker.eid, worker.resourceCode);
      const inv = getInventory(world, comps, worker.eid)!;
      const capacity = getCarryCapacity(world, comps, worker.eid);
      const remaining = worker.nodeRow[1]!;
      // M3-T3 refactor: the work interval is RESOLVED ONCE at chain
      // construction (resolveGatherInterval folds the M3-T2 skill/
      // trait multiplier AND the M3-T3 rest penalty) and consumed
      // verbatim from the encoded head. Deriving per-tick could let
      // the live interval exceed its encoded base (mid-chain skill
      // growth aside: a lazy/rested stretch), writing an elapsedTicks
      // that fails decode validation on the next read. Encoded ==
      // effective by construction closes that class of crash.
      if (
        head.elapsedTicks >= head.ticksPerUnit &&
        remaining > 0 &&
        capacity > inv.amount
      ) {
        worker.nodeRow[1] = remaining - 1;
        setInventory(
          world,
          comps,
          worker.eid,
          inv.resourceCode,
          inv.amount + 1,
        );
        diagnostics.extractedByResource[inv.resourceCode]! += 1;
        // M3-T2: extraction is the practice event — the worker's
        // gathering skill grows by the documented per-unit award.
        awardPractice(
          world,
          comps,
          worker.eid,
          "gathering",
          GATHER_XP_PER_UNIT,
        );
        head.elapsedTicks = 0;
      }
      const amountNow = getInventory(world, comps, worker.eid)!.amount;
      return amountNow >= capacity || worker.nodeRow[1]! <= 0;
    };

    /**
     * Execute one Deliver head: deposit the carried load into the
     * drop-off owner's stockpile — a deterministic event inside step().
     * Returns false when the targeted point's filter list REJECTS the
     * carried resource (M2-T2): nothing is credited, the caller cancels
     * the chain and planning reroutes to the next cheapest accepting
     * point (or idles holding cargo when none exists).
     */
    const executeDeliverHead = (
      worker: ClaimedWorker,
      head: DeliverActivity,
    ): boolean => {
      // Destroyed mid-flight (M2-T7): the DropOff row died with the
      // building. Nothing is credited; the caller cancels the chain and
      // planning reroutes to the next cheapest accepting point.
      if (!dropOffAlive(head.dropoffEid)) {
        diagnostics.destroyedDropoffReroutes += 1;
        return false;
      }
      const owner = dropOffOwnerOf(world, comps, head.dropoffEid);
      if (owner === undefined) {
        throw new Error(
          `deliver targets entity ${String(head.dropoffEid)}, which has no DropOff row`,
        );
      }
      const inv = getInventory(world, comps, worker.eid);
      if (inv === undefined || inv.amount <= 0) return true;
      // Deposit-time filter guard (M2-T2): choice-time filtering makes
      // this a no-op in healthy runs; it fires only when acceptance
      // changed between planning and arrival. Either way a rejected
      // resource is NEVER credited — conservation holds.
      if (!dropOffAccepts(world, comps, head.dropoffEid, inv.resourceCode)) {
        diagnostics.rejectedByFilter += 1;
        return false;
      }
      depositIntoStockpile(world, comps, owner, inv.resourceCode, inv.amount);
      diagnostics.depositedByResource[inv.resourceCode]! += inv.amount;
      recordDelivery(head.dropoffEid);
      // M4-T2: branch drop-off output routing taps the same credit
      // event — one source of truth, no double counting.
      observers.onOutput?.(
        world,
        comps,
        owner,
        head.dropoffEid,
        RESOURCE_SLUGS[inv.resourceCode]!,
        inv.amount,
      );
      setInventory(world, comps, worker.eid, inv.resourceCode, 0);
      return true;
    };

    /**
     * Decide and enqueue the worker's next chain leg from an empty
     * queue: deposit runs, auto-repeat walks, slot work begins. Returns
     * true when the queue changed.
     */
    const planNextLeg = (
      worker: ClaimedWorker,
      queue: ActivityQueue,
    ): boolean => {
      ensureCarryCapacity(world, comps, worker.eid);
      ensureInventory(world, comps, worker.eid, worker.resourceCode);
      const inv = getInventory(world, comps, worker.eid)!;
      const capacity = getCarryCapacity(world, comps, worker.eid);
      const remaining = worker.nodeRow[1]!;

      // Dry node with empty hands → assignment complete; release to idle.
      if (remaining <= 0 && inv.amount <= 0) {
        releaseWorker(worker.eid);
        return true;
      }

      // Carry full or node dry → walk cargo to the cheapest drop-off
      // that ACCEPTS this resource (M2-T2), aiming at this worker's
      // personal perimeter door. No accepting candidate → idle here
      // holding the cargo; every such tick lands in diagnostics.
      if (remaining <= 0 || inv.amount >= capacity) {
        const target = cheapestDropOff(
          worker.posX,
          worker.posY,
          inv.resourceCode,
        );
        if (!target) {
          diagnostics.blockedCarryTicks += 1;
          return false; // nothing known/accepting/reachable yet; retry
        }
        const door = deliverDoorOf(worker.posX, worker.posY, target);
        enqueueActivity(queue, moveActivity([door.x, door.y]));
        enqueueActivity(queue, deliverActivity(target.eid));
        setMoveTarget(world, comps, worker.eid, door.x, door.y);
        resetSteeringBookkeeping(velRowOf(worker.eid));
        return true;
      }

      // Overflow workers mill toward their outer-ring holding point.
      if (worker.overflowRank >= 0) {
        const ddx = worker.posX - worker.holdingX;
        const ddy = worker.posY - worker.holdingY;
        if (ddx * ddx + ddy * ddy <= HOLDING_ARRIVAL_RADIUS ** 2) {
          return false; // settled where the foreman can see us
        }
        enqueueActivity(
          queue,
          moveActivity([worker.holdingX, worker.holdingY]),
        );
        setMoveTarget(
          world,
          comps,
          worker.eid,
          worker.holdingX,
          worker.holdingY,
        );
        resetSteeringBookkeeping(velRowOf(worker.eid));
        return true;
      }

      // Slotted: begin work on arrival, else walk to the slot center.
      const slot = worker.slots[worker.slotIndex]!;
      const ddx = worker.posX - slot.x;
      const ddy = worker.posY - slot.y;
      if (ddx * ddx + ddy * ddy <= SLOT_ARRIVAL_RADIUS ** 2) {
        // M3-T2/T3: the work interval resolves ONCE per chain from the
        // worker's skill, traits and rest meter (see
        // resolveGatherInterval) — the encoded head stays the single
        // source of truth while it advances.
        enqueueActivity(
          queue,
          gatherActivity(
            resolveGatherInterval(
              world,
              comps,
              worker.eid,
              DEFAULT_GATHER_TICKS_PER_UNIT,
            ),
          ),
        );
        return true;
      }
      enqueueActivity(queue, moveActivity([slot.x, slot.y]));
      setMoveTarget(world, comps, worker.eid, slot.x, slot.y);
      resetSteeringBookkeeping(velRowOf(worker.eid));
      return true;
    };

    // ---- 1) Commands consumed exactly on their target tick boundary.
    // The inbox is a SHARED stream: skip foreign kinds (movement owns
    // "groupMove"); this system dispatches only "gather".
    for (const command of commands) {
      if (command.kind !== "gather") continue;
      if (!command.data) throw new Error("gather requires command data");
      applyGatherCommand(command.data);
    }

    // ---- 2) Collect assigned workers grouped by node, ascending eid.
    const assignedRows = world.rowsByComponentId.get(comps.assignedNodeId);
    if (!assignedRows) throw new Error("unregistered AssignedNode component");
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);

    const workersByNode = new Map<number, GroupedWorker[]>();
    for (const eid of world.entities) {
      const row = assignedRows.get(eid);
      if (!row) continue;
      const posRow = posRows?.get(eid);
      const velRow = velRows?.get(eid);
      const tagRow = tagRows?.get(eid);
      if (!posRow || !velRow || !tagRow) continue; // not a live unit
      const nodeEid = row[0]!;
      const entry: GroupedWorker = {
        eid,
        posX: posRow[0]!,
        posY: posRow[1]!,
        assignedRow: row,
      };
      const list = workersByNode.get(nodeEid);
      if (list) list.push(entry);
      else workersByNode.set(nodeEid, [entry]);
    }

    // ---- 3) Claim resolution per node: ascending-eid priority over the
    // pinned slot order; overflow ranks mill on the outer holding ring.
    // Claims depend ONLY on the assigned-worker set, so travelers keep
    // their slot and uncontended repeat resumes it exactly.
    const claimed: ClaimedWorker[] = [];
    for (const [nodeEid, group] of workersByNode) {
      const nodeRow = world.rowsByComponentId
        .get(comps.resourceNodeId)
        ?.get(nodeEid);
      const nodePos = posRows?.get(nodeEid);
      if (!nodeRow || !nodePos) {
        // Node vanished underneath its workers: release them all.
        for (const worker of group) releaseWorker(worker.eid);
        continue;
      }
      const limit = Math.min(Math.max(0, nodeRow[2]!), WORK_SLOTS_PER_NODE);
      const slots = workSlotPositionsFor(
        passability,
        size,
        Math.floor(nodePos[0]!),
        Math.floor(nodePos[1]!),
        limit,
      );
      const centerX = nodePos[0]!;
      const centerY = nodePos[1]!;
      for (let i = 0; i < group.length; i++) {
        const worker = group[i]!;
        const slotted = i < slots.length;
        const slotIndex = slotted ? i : -1;
        const overflowRank = slotted ? -1 : i - slots.length;
        // The claim write is digest-visible only when it changes.
        if (worker.assignedRow[1] !== slotIndex)
          worker.assignedRow[1] = slotIndex;
        let holdingX = centerX;
        let holdingY = centerY;
        if (!slotted) {
          const offset = formationSlotOffset(
            OVERFLOW_RING_START_INDEX + overflowRank,
          );
          holdingX = Math.min(Math.max(centerX + offset.dx, 0.5), size - 0.5);
          holdingY = Math.min(Math.max(centerY + offset.dy, 0.5), size - 0.5);
        }
        claimed.push({
          ...worker,
          nodeEid,
          nodeRow,
          resourceCode: nodeRow[0]!,
          slotIndex,
          overflowRank,
          slots,
          holdingX,
          holdingY,
        });
      }
    }
    claimed.sort((a, b) => a.eid - b.eid);

    // ---- 4) Per-worker activity state machine (ascending eid).
    for (const worker of claimed) {
      const queue = queueOf(worker.eid);
      let dirty = false;
      for (;;) {
        const head = peekActivity(queue);
        if (head === undefined) {
          dirty = planNextLeg(worker, queue) || dirty;
          break;
        }
        if (head.kind === "move" || head.kind === "wait") {
          // Congested-approach delivery: when the next leg is a Deliver
          // and the worker already stands within reach of the depot,
          // unload now instead of grinding toward a point a crowd of
          // co-deliverers may physically forbid.
          const next = queue[1];
          if (head.kind === "move" && next?.kind === "deliver") {
            if (!dropOffAlive(next.dropoffEid)) {
              // Depot destroyed mid-flight (M2-T7): drop the chain,
              // planning reroutes to an accepting point next tick.
              cancelActivities(queue);
              diagnostics.destroyedDropoffReroutes += 1;
              dirty = true;
              continue;
            }
            const drop = dropOffPositionOf(next.dropoffEid);
            if (
              withinDeliverRange(worker, drop) ||
              jammedNearDropOff(worker, drop)
            ) {
              if (!executeDeliverHead(worker, next)) {
                // Target stopped accepting mid-flight: drop the chain,
                // planning reroutes to an accepting point next tick.
                cancelActivities(queue);
                dirty = true;
                continue;
              }
              cancelActivities(queue);
              dirty = true;
              continue;
            }
          }
          break; // movement owns these heads
        }
        if (head.kind === "gather") {
          dirty = true; // elapsedTicks advances every working tick
          if (advanceGatherHead(worker, head)) {
            dequeueCurrentActivity(queue); // carry full or node dry
            continue; // plan the deposit leg this same tick
          }
          break;
        }
        // kind === "deliver": deposit once within reach of the depot —
        // exact-pixel arrival would deadlock behind co-deliverers.
        if (head.kind === "deliver") {
          if (!dropOffAlive(head.dropoffEid)) {
            // Depot destroyed mid-flight (M2-T7): nothing credited;
            // cancel so reroute planning finds an accepting drop-off.
            cancelActivities(queue);
            diagnostics.destroyedDropoffReroutes += 1;
            dirty = true;
            continue; // reroute planning runs through planNextLeg
          }
          const drop = dropOffPositionOf(head.dropoffEid);
          if (
            withinDeliverRange(worker, drop) ||
            jammedNearDropOff(worker, drop)
          ) {
            if (!executeDeliverHead(worker, head)) {
              // Rejected by the filter list (M2-T2): nothing credited;
              // cancel so auto-repeat planning reroutes to an accepting
              // drop-off — or idles holding cargo when none exists.
              cancelActivities(queue);
              dirty = true;
              continue; // reroute planning runs through planNextLeg
            }
            // The chain segment ends here even if the movement system
            // never formally completed the approach leg.
            cancelActivities(queue);
            dirty = true;
            continue; // auto-repeat planning runs through planNextLeg
          }
          // Stale Deliver head without its Move pair: rebuild the walk.
          const door = deliverDoorOf(worker.posX, worker.posY, drop);
          queue.length = 0;
          enqueueActivity(queue, moveActivity([door.x, door.y]));
          enqueueActivity(queue, head);
          setMoveTarget(world, comps, worker.eid, door.x, door.y);
          resetSteeringBookkeeping(velRowOf(worker.eid));
          dirty = true;
          break;
        }
        break;
      }
      if (dirty) writeActivityQueue(world, comps, worker.eid, queue);
    }
  };
}

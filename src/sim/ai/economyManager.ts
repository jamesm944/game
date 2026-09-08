/**
 * Economy manager — SPEC §2.8 layer 2 / M2-T9 (issue #43).
 *
 * Runs inside the planner's 30-tick full pass (SPEC §2.8 cadence) and
 * keeps the AI town's metabolism saturated:
 *
 *   1. Housing — population plus the training pipeline outrunning the
 *      owned pop cap places houses on deterministic distance-sorted
 *      ring slots around the town center.
 *   2. TC saturation — the villager queue stays fed toward the
 *      strategy's `villagerTarget`, gated by PER-PLAYER pop headroom
 *      and affordability.
 *   3. Construction — every unfinished site pulls up to two idle
 *      empty-handed villagers as builders (nearest first); completion
 *      releases them and the NEXT pass rebalances them onto resources —
 *      the issue's "rebalance after building completions".
 *   4. Gathering — remaining idle villagers fill the most under-weight
 *      resource bucket for the strategy's gather weights, walking to
 *      the least-crowded known node nearest the TC. Employed workers
 *      are never preempted mid-job: churn happens only through idles.
 *
 * Farm-stub awareness: farms exist as buildings but farmer roles and
 * re-seeding are a later-ticket stub, so v1 strategies draw food from
 * forage nodes and this manager never scripts farm placements.
 *
 * Every emission is a plain command descriptor destined for the shared
 * inbox — identical in kind to player orders — debited against the
 * caller's planning-time {@link ResourceBudget} so one pass can never
 * overdraw the bank its commands will spend from at the next tick.
 */

import { buildingDefOf, unitDefOf } from "../../data/definitions";
import { WORK_SLOTS_PER_NODE } from "../components/economy";
import {
  FARM_RESEED_WOOD_COST,
  SET_AUTO_RESEED_COMMAND_KIND,
} from "../systems/gather";
import type { CommandDraft } from "./buildOrder";
import type { AiKnowledge, ResourceBudget, SpotReservation } from "./knowledge";

/** Farmers + farm re-seeding active (V15 / #105). */
export const FARM_RESEEDING_STUB = false;

/** Builders pulled onto each construction site. */
export const BUILDERS_PER_SITE = 2;

/** Queued villagers tolerated before housing demand counts as due. */
const HOUSING_PIPELINE_MARGIN = 1;
/** Population capacity granted by one finished/pending house. */
const HOUSE_POP_CAP = 5;
/**
 * Construction may pull gatherers only above this fraction of the
 * workforce — the food line never fully empties for building duty.
 */
const MIN_GATHERER_FRACTION = 0.4;
/** Ring radius searched around the TC for house slots. */
const HOUSE_SEARCH_RADIUS = 6;
/** Houses never touch the TC footprint's immediate edge (TC is 3×3). */
const HOUSE_MIN_CLEARANCE = 1;

/** Food/wood/gold resource codes (components/economy order). */
const FOOD = 0;
const WOOD = 1;
const GOLD = 2;

/** Villager tile positions for distance ordering (self-knowledge). */
type TileLookup = (eid: number) => { x: number; y: number } | undefined;

/**
 * Plan one economy pass. Mutates nothing in the sim; appends command
 * drafts in fixed domain order (auto-reseed → housing → saturation →
 * construction → gathering) so same-pass submission order stays
 * deterministic.
 */
export function planEconomyCommands(
  k: AiKnowledge,
  opts: {
    readonly villagerTarget: number;
    readonly gatherWeights: Readonly<Record<"food" | "wood" | "gold", number>>;
  },
  budget: ResourceBudget,
  reserved: SpotReservation,
  out: CommandDraft[],
): void {
  const tileOf: TileLookup = (eid) => k.ownUnitTile(eid);
  planAutoReseed(k, out);
  planHousing(k, budget, reserved, out);
  planTcSaturation(k, opts.villagerTarget, budget, out);
  planConstruction(k, tileOf, out);
  planGathering(k, opts.gatherWeights, out);
}

/**
 * AI manages auto-reseed state based on its wood buffer:
 * when wood >= 60, keeps auto-reseed ON so farming continues seamlessly;
 * when wood < 60, switches auto-reseed OFF so it doesn't overdraw critical wood.
 */
export function planAutoReseed(k: AiKnowledge, out: CommandDraft[]): void {
  const wood = k.resources()[WOOD] ?? 0;
  const current = k.autoReseedEnabled();
  const desired = wood >= FARM_RESEED_WOOD_COST;
  if (current !== desired) {
    out.push({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      data: {
        playerId: k.player,
        enabled: desired,
      },
    });
  }
}

// ---- 1) Housing -----------------------------------------------------------------

function planHousing(
  k: AiKnowledge,
  budget: ResourceBudget,
  reserved: SpotReservation,
  out: CommandDraft[],
): void {
  let queuedVillagers = 0;
  for (const eid of k.finishedBuildings("town-center")) {
    for (const unitId of k.trainQueueOf(eid)) {
      if (unitId === "villager") queuedVillagers += 1;
    }
  }
  // Prospective cap: finished buildings plus every house site already
  // queued for construction — one pass may never double-place.
  let prospectiveCap = k.populationCap();
  for (const site of k.unfinishedSites()) {
    if (site.defId === "house") prospectiveCap += HOUSE_POP_CAP;
  }
  const shortfall =
    k.population() + queuedVillagers + HOUSING_PIPELINE_MARGIN - prospectiveCap;
  if (shortfall <= 0) return;
  const housesNeeded = Math.ceil(shortfall / HOUSE_POP_CAP);
  for (let placed = countPendingHouses(out); placed < housesNeeded; placed++) {
    if (!placeOneHouse(k, budget, reserved, out)) break;
  }
}

function countPendingHouses(out: CommandDraft[]): number {
  return out.filter(
    (draft) => draft.kind === "placeBuilding" && draft.data.defId === "house",
  ).length;
}

function placeOneHouse(
  k: AiKnowledge,
  budget: ResourceBudget,
  reserved: SpotReservation,
  out: CommandDraft[],
): boolean {
  const houseDef = buildingDefOf("house");
  const costs = houseDef.costs;
  if (!budget.afford(costs)) return false;
  const tcEid = k.finishedBuildings("town-center")[0];
  const origin = tcEid !== undefined ? k.ownBuildingOrigin(tcEid) : undefined;
  if (!origin) return false;
  for (const slot of houseCandidateSlots(origin.x, origin.y)) {
    if (
      reserved.isReserved(
        slot.x,
        slot.y,
        houseDef.footprint.width,
        houseDef.footprint.height,
      )
    ) {
      continue;
    }
    if (!k.canPlace("house", slot.x, slot.y)) continue;
    budget.debit(costs);
    reserved.reserve(
      slot.x,
      slot.y,
      houseDef.footprint.width,
      houseDef.footprint.height,
    );
    out.push({
      kind: "placeBuilding",
      data: {
        defId: "house",
        tileX: slot.x,
        tileY: slot.y,
        playerId: k.player,
      },
    });
    return true;
  }
  return false;
}

/** Deterministic house slots around a TC origin: near-first, tie-stable. */
export function houseCandidateSlots(
  originX: number,
  originY: number,
): { x: number; y: number }[] {
  const slots: { x: number; y: number; d: number }[] = [];
  const margin = 3 + HOUSE_MIN_CLEARANCE; // half-TC + clearance
  for (let dy = -HOUSE_SEARCH_RADIUS; dy <= HOUSE_SEARCH_RADIUS; dy++) {
    for (let dx = -HOUSE_SEARCH_RADIUS; dx <= HOUSE_SEARCH_RADIUS; dx++) {
      const x = originX + dx;
      const y = originY + dy;
      if (x < 0 || y < 0) continue;
      if (dx >= -margin && dx <= margin && dy >= -margin && dy <= margin) {
        continue;
      }
      slots.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  slots.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return slots.map(({ x, y }) => ({ x, y }));
}

// ---- 2) Town-center saturation ---------------------------------------------------

function planTcSaturation(
  k: AiKnowledge,
  villagerTarget: number,
  budget: ResourceBudget,
  out: CommandDraft[],
): void {
  const tcEid = k.finishedBuildings("town-center")[0];
  if (tcEid === undefined) return;
  const villagers = k.villagerEids().length;
  const queued = k
    .trainQueueOf(tcEid)
    .filter((unitId) => unitId === "villager").length;
  if (villagers + queued >= villagerTarget) return;
  // The handler escrows exactly these definition costs at execution.
  const costs = unitDefOf("villager").costs;
  if (!k.canTrain(tcEid) || !budget.afford(costs)) return;
  budget.debit(costs);
  out.push({ kind: "trainVillager", data: { siteEid: tcEid } });
}

// ---- 3) Construction --------------------------------------------------------------

function planConstruction(
  k: AiKnowledge,
  tileOf: TileLookup,
  out: CommandDraft[],
): void {
  const sites = k.unfinishedSites();
  if (sites.length === 0) return;

  const busyBuilding = new Set<number>();
  for (const site of sites) {
    for (const eid of k.buildersOn(site.eid)) busyBuilding.add(eid);
  }

  /** Empty-handed villagers not already building something. */
  const idle: number[] = [];
  /** Empty-handed gatherers — pulled only above the workforce floor. */
  const gathering: number[] = [];
  let assignedGatherers = 0;
  for (const eid of k.villagerEids()) {
    if (busyBuilding.has(eid)) continue;
    const carry = k.carryOf(eid);
    if (carry !== undefined && carry.amount > 0) continue; // mid-delivery
    if (k.assignmentOf(eid)?.kind === "node") {
      assignedGatherers += 1;
      gathering.push(eid);
    } else {
      idle.push(eid);
    }
  }
  const minGatherers = Math.max(
    1,
    Math.ceil(k.villagerEids().length * MIN_GATHERER_FRACTION),
  );

  for (const site of sites) {
    let missing = BUILDERS_PER_SITE - k.buildersOn(site.eid).length;
    while (missing > 0) {
      const builder =
        idle.length > 0
          ? takeNearest(idle, site.tileX, site.tileY, tileOf)
          : gathering.length > 0 && assignedGatherers > minGatherers
            ? takeNearest(gathering, site.tileX, site.tileY, tileOf)
            : undefined;
      if (builder === undefined) break;
      if (gathering.includes(builder)) assignedGatherers -= 1;
      out.push({
        kind: "build",
        data: { entityIds: [builder], siteEid: site.eid },
      });
      missing -= 1;
    }
  }
}

function takeNearest(
  candidates: number[],
  tileX: number,
  tileY: number,
  tileOf: TileLookup,
): number {
  let bestIdx = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < candidates.length; i++) {
    const pos = tileOf(candidates[i]!);
    const d =
      pos === undefined
        ? Number.POSITIVE_INFINITY
        : (pos.x - tileX) ** 2 + (pos.y - tileY) ** 2;
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return candidates.splice(bestIdx, 1)[0]!;
}

// ---- 4) Gathering -----------------------------------------------------------------

function planGathering(
  k: AiKnowledge,
  weights: Readonly<Record<"food" | "wood" | "gold", number>>,
  out: CommandDraft[],
): void {
  /** Known live nodes bucketed by resource code. */
  const nodesByResource = new Map<number, ReturnType<typeof k.knownNodes>>([
    [FOOD, k.knownNodes(FOOD)],
    [WOOD, k.knownNodes(WOOD)],
    [GOLD, k.knownNodes(GOLD)],
  ]);
  const nodeResource = new Map<number, number>();
  for (const [resource, nodes] of nodesByResource) {
    for (const node of nodes) nodeResource.set(node.eid, resource);
  }

  const weightByResource = new Map<number, number>([
    [FOOD, weights.food],
    [WOOD, weights.wood],
    [GOLD, weights.gold],
  ]);

  // Current distribution + idle pool. Mid-delivery carriers (cargo in
  // hand) stay untouched: re-tasking them onto a different resource is
  // illegal in the gather chain and wasteful anyway.
  const workersByResource = new Map<number, number>([
    [FOOD, 0],
    [WOOD, 0],
    [GOLD, 0],
  ]);
  const idle: number[] = [];
  for (const eid of k.villagerEids()) {
    const carry = k.carryOf(eid);
    if (carry !== undefined && carry.amount > 0) continue;
    const assignment = k.assignmentOf(eid);
    if (assignment === undefined) {
      idle.push(eid);
      continue;
    }
    if (assignment.kind !== "node") continue; // builders stay put
    const resource = nodeResource.get(assignment.eid);
    if (resource !== undefined) {
      workersByResource.set(
        resource,
        (workersByResource.get(resource) ?? 0) + 1,
      );
    }
  }

  if (idle.length === 0) return;
  const totalWorkers =
    [...workersByResource.values()].reduce((a, b) => a + b, 0) + idle.length;

  // Largest deficit first; fixed code order breaks ties deterministically.
  const deficitsByResource = [...weightByResource.entries()]
    .map(([resource, weight]) => ({
      resource,
      deficit:
        Math.round(weight * totalWorkers) -
        (workersByResource.get(resource) ?? 0),
    }))
    .sort((a, b) => b.deficit - a.deficit || a.resource - b.resource);

  const anchor = anchorTileOf(k);
  for (const villager of idle) {
    const nodeId = chooseNodeFor(
      k,
      deficitsByResource,
      nodesByResource,
      anchor,
    );
    if (nodeId === undefined) break; // nothing known/uncrowded to send to
    out.push({
      kind: "gather",
      data: { entityIds: [villager], nodeId },
    });
  }
}

/**
 * Least-crowded nearest node across resources in deficit priority
 * order; crowding caps at the node work-slot count. Ties fall through
 * (workers ↑, distance ↑, eid ↑) for full determinism.
 */
function chooseNodeFor(
  k: AiKnowledge,
  deficitsByResource: readonly { resource: number }[],
  nodesByResource: Map<number, ReturnType<typeof k.knownNodes>>,
  anchor: { x: number; y: number },
): number | undefined {
  for (const { resource } of deficitsByResource) {
    let best: number | undefined;
    let bestKey: readonly [number, number, number] | undefined;
    for (const node of nodesByResource.get(resource) ?? []) {
      const workers = k.workersOnNode(node.eid);
      if (workers >= WORK_SLOTS_PER_NODE) continue;
      const d = (node.tileX - anchor.x) ** 2 + (node.tileY - anchor.y) ** 2;
      const key: readonly [number, number, number] = [workers, d, node.eid];
      if (
        bestKey === undefined ||
        key[0]! < bestKey[0]! ||
        (key[0] === bestKey[0] && key[1]! < bestKey[1]!) ||
        (key[0] === bestKey[0] &&
          key[1] === bestKey[1] &&
          key[2]! < bestKey[2]!)
      ) {
        best = node.eid;
        bestKey = key;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

function anchorTileOf(k: AiKnowledge): { x: number; y: number } {
  const tcEid = k.finishedBuildings("town-center")[0];
  const origin = tcEid !== undefined ? k.ownBuildingOrigin(tcEid) : undefined;
  return origin ?? { x: 0, y: 0 };
}

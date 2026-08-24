/**
 * Delegated-management system — SPEC §2.7 / M4-T1 (issue #56).
 *
 * The §2.7 layer above the IAUS pop brain: FOREMEN keep individual
 * workplaces saturated, MANAGERS obey player strategy sliders across a
 * whole resource domain, and DIRECT ORDERS always win.
 *
 * Command interface — delegation speaks the SAME shared-inbox language
 * as the player (the one-planning-stack-two-customers rule): every
 * foreman/manager action is a plain `produce` command flagged
 * `delegated: true`, indistinguishable downstream from a player click
 * except for that flag. Appointments ride their own kinds:
 *
 *   appointForeman { buildingEid, popId }
 *   dismissForeman { buildingEid }
 *   appointManager { popId, domain }
 *   dismissManager { popId }
 *   setStrategy    { domain, weights, playerId? }
 *
 * Override rule made state: every DIRECT (unflagged) labor command —
 * gather/build/produce/groupMove/attack/attackMove — stamps an
 * OrderLock row on its targets the tick it is seen. Delegation never
 * fills, rotates, redistributes or appoints a locked Pop. Labor locks
 * release when the ordered assignment ends (chain completion, node dry,
 * emergency-eat interrupt); transit locks release when the activity
 * queue empties. Dismissal itself is instant, no cooldown.
 *
 * Cadence mirrors the brain's 1 Hz stagger: a foreman thinks on
 * `(tick + buildingEid) % FOREMAN_THINK_INTERVAL_TICKS`, a manager
 * redistributes on `(tick + popEid) % MANAGER_REALLOCATE_INTERVAL_TICKS`.
 * Both award Management-skill XP per serving pass; levels derive
 * through the shared DF curve on read (components/management.ts).
 *
 * Rating (SPEC §2.7): Organization-type trait points + relevant craft
 * skill + Management skill grown on the job — managementRatingOf,
 * exported for the appointment UI's ranked candidate list.
 *
 * Registration order matters: register AFTER the labor systems
 * (movement/gather/construction/production) so a same-tick direct
 * order's rows exist before the lock sweep validates them, and after
 * needs so freshly-decayed rest meters drive rotations this tick.
 */

import {
  buildingDefOf,
  buildingIdOfCode,
  recipesForBuilding,
} from "../../data/definitions";
import { cancelActivities } from "../activities";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import {
  clearForemanRow,
  clearManagerRow,
  clearOrderLock,
  clearStrategyWeights,
  craftSkillOfDomain,
  domainOfBuildingDef,
  ensureManagementSkillRow,
  foremanRowOf,
  managementLevelOf,
  managerRowOf,
  orderKindIsLabor,
  ORDER_KIND_ATTACK,
  ORDER_KIND_BUILD,
  ORDER_KIND_GATHER,
  ORDER_KIND_MOVE,
  ORDER_KIND_PRODUCE,
  requireDomainCode,
  setForemanRow,
  setManagerRow,
  setStrategyWeights,
  stampOrderLock,
  strategyWeightsOf,
} from "../components/management";
import { getAssignedSite, getBuildingRow } from "../components/buildings";
import { getAssignedNode } from "../components/economy";
import { needsRowOf } from "../components/needs";
import { ownerOfUnit } from "../components/owner";
import { clearProductionJob, getProductionJob } from "../components/production";
import { popNameOf, readTraits } from "../components/pop";
import { LEGENDARY_TOTAL_XP } from "../data/skills";
import { traitXpGainMult } from "../data/traits";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_CHILD,
  LIFE_STAGE_ELDER,
  lifeStageOf,
  type LifecycleConfig,
} from "./lifecycle";
import { skillLevelOf } from "./skills";

// ---- Documented tuning constants ---------------------------------------------

/** Foreman think cadence: the brain's 1 Hz at the 30 Hz sim tick. */
export const FOREMAN_THINK_INTERVAL_TICKS = 30;
/**
 * Manager redistribution cadence — the issue's "every 30 ticks toward
 * weights", staggered per manager eid exactly like the brain.
 */
export const MANAGER_REALLOCATE_INTERVAL_TICKS = 30;
/** Rest meter at/below which a foreman rotates a worker off the line. */
export const FOREMAN_ROTATE_REST_LEVEL = 15;
/**
 * Transit-lock grace: a direct move order whose route still has not
 * delivered activities one think-interval after stamping is treated as
 * finished (unreachable goal, dissolved formation) and releases the
 * fence. Live routes apply within the ADR-0003 latency window — far
 * inside one interval on both transports.
 */
export const TRANSIT_LOCK_GRACE_TICKS = 30;
/** Management-skill XP per serving pass (foremen and managers alike). */
export const MANAGEMENT_XP_PER_PASS = 2;

/** Rating points per relevant craft-skill level. */
export const RATING_POINTS_PER_CRAFT_LEVEL = 0.4;
/** Rating points per management level (grown on the job). */
export const RATING_POINTS_PER_MANAGEMENT_LEVEL = 0.6;

/**
 * Organization-type traits (SPEC §2.7) over the loaded trait pool:
 * the coordination-flavored picks of data/traits.json, weighted by how
 * strongly each reads as organizational aptitude.
 */
export const ORGANIZATION_TRAIT_WEIGHTS: Readonly<Record<string, number>> = {
  ambitious: 2,
  industrious: 2,
  gregarious: 1,
};

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface ManagementDiagnostics {
  /** Appointments accepted (foremen + managers). */
  appointments: number;
  /** Dismissals processed (explicit or replaced). */
  dismissals: number;
  /** Empty workplace slots filled from the idle pool by delegation. */
  fills: number;
  /** Exhausted workers swapped off a line by their foreman. */
  rotations: number;
  /** Workers seated into workplaces by a manager's slider shift. */
  redistributions: number;
  /** Direct-order lock stamps applied. */
  locksStamped: number;
  /** Order locks released on completion/cancellation. */
  locksReleased: number;
}

export function createManagementDiagnostics(): ManagementDiagnostics {
  return {
    appointments: 0,
    dismissals: 0,
    fills: 0,
    rotations: 0,
    redistributions: 0,
    locksStamped: 0,
    locksReleased: 0,
  };
}

// ---- Rating & candidates ------------------------------------------------------

/** Summed Organization-trait points of one trait slug list. */
export function organizationTraitPoints(slugs: readonly string[]): number {
  let points = 0;
  for (const slug of slugs) points += ORGANIZATION_TRAIT_WEIGHTS[slug] ?? 0;
  return points;
}

/**
 * Derived management rating of one Pop FOR one domain (SPEC §2.7):
 * Organization-type trait points + relevant craft skill + Management
 * skill grown while serving. Pure in digest-visible rows.
 */
export function managementRatingOf(
  world: World,
  comps: SimComponents,
  eid: number,
  domain: number,
): number {
  requireDomainCode(domain);
  const org = organizationTraitPoints(readTraits(world, comps, eid) ?? []);
  const craft =
    skillLevelOf(world, comps, eid, craftSkillOfDomain(domain)) ?? 0;
  return (
    org +
    RATING_POINTS_PER_CRAFT_LEVEL * craft +
    RATING_POINTS_PER_MANAGEMENT_LEVEL * managementLevelOf(world, comps, eid)
  );
}

/** One appointment candidate as surfaced to the UI. */
export interface ManagementCandidate {
  readonly popEid: number;
  readonly name: string;
  readonly rating: number;
}

/**
 * Every Pop eligible to serve `playerId`'s `domain`, ranked best-first:
 * named non-child Pops of that player carrying no direct-order lock and
 * no existing manager office. Ratings descend; ties break to the lower
 * (ascending) eid so the ordering is deterministic.
 */
export function managementCandidatesOf(
  world: World,
  comps: SimComponents,
  playerId: number,
  domain: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): ManagementCandidate[] {
  requireDomainCode(domain);
  const tagRows = world.rowsByComponentId.get(comps.unitTagId);
  const identityRows = world.rowsByComponentId.get(comps.identityId);
  const lockRows = world.rowsByComponentId.get(comps.orderLockId);
  const managerRows = world.rowsByComponentId.get(comps.managerId);
  const out: ManagementCandidate[] = [];
  if (!identityRows) return out;
  for (const eid of world.entities) {
    if (!tagRows?.has(eid)) continue;
    if (!identityRows.has(eid)) continue;
    if (ownerOfUnit(world, comps, eid) !== playerId) continue;
    if (lifeStageOf(world, comps, eid, config) === LIFE_STAGE_CHILD) continue;
    if (lockRows?.has(eid)) continue;
    if (managerRows?.has(eid)) continue;
    out.push({
      popEid: eid,
      name: popNameOf(world, comps, eid) ?? `#${String(eid)}`,
      rating: managementRatingOf(world, comps, eid, domain),
    });
  }
  out.sort((a, b) =>
    b.rating === a.rating ? a.popEid - b.popEid : b.rating - a.rating,
  );
  return out;
}

/**
 * The manager Pop serving `playerId`'s `domain` (lowest ascending eid
 * wins should validation ever lapse), or undefined unstaffed.
 */
export function managerOfDomain(
  world: World,
  comps: SimComponents,
  playerId: number,
  domain: number,
): number | undefined {
  requireDomainCode(domain);
  const rows = world.rowsByComponentId.get(comps.managerId);
  if (!rows) return undefined;
  for (const eid of world.entities) {
    const row = rows.get(eid);
    if (!row || row[0] !== domain) continue;
    if (!world.rowsByComponentId.get(comps.unitTagId)?.has(eid)) continue;
    if (ownerOfUnit(world, comps, eid) !== playerId) continue;
    return eid;
  }
  return undefined;
}

// ---- Command parsing ----------------------------------------------------------

function parsePositiveInt(
  data: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function parseDomainCode(data: Readonly<Record<string, unknown>>): number {
  const value = data.domain;
  if (typeof value !== "number") throw new Error("domain code required");
  return requireDomainCode(value);
}

function parseCommandIds(data: Readonly<Record<string, unknown>>): number[] {
  const raw = data.entityIds ?? data.attackerIds ?? [];
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const id of raw) {
    if (typeof id === "number" && Number.isInteger(id) && id >= 1) {
      ids.push(id);
    }
  }
  return ids;
}

// ---- The system ---------------------------------------------------------------

export interface ManagementSystemOptions {
  readonly comps: SimComponents;
  /**
   * Players whose Pops this delegation layer serves. Undefined serves
   * everyone; the skirmish session wires [PLAYER_ONE] so the AI
   * opponent keeps its own planner stack (SPEC §2.8 layering).
   */
  readonly players?: readonly number[] | undefined;
  readonly diagnostics?: ManagementDiagnostics | undefined;
  readonly lifecycleConfig?: LifecycleConfig | undefined;
}

/** Build the delegated-management SimSystem (SPEC §2.7 / M4-T1). */
export function createManagementSystem(
  options: ManagementSystemOptions,
): SimSystem {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createManagementDiagnostics();
  const lifecycleConfig = options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG;

  /**
   * Closure-scoped world reference: valid only inside the returned
   * system call (helpers below never run outside one).
   */
  let world: World | undefined;

  const tagRows = (): Map<number, number[]> | undefined =>
    world?.rowsByComponentId.get(comps.unitTagId);

  /** True when `ownerId` belongs to a served player. */
  const servedPlayer = (ownerId: number): boolean =>
    players === undefined || players.includes(ownerId);

  // ---- Shared read views ------------------------------------------------------

  const isLiveNamedPop = (eid: number): boolean =>
    tagRows()?.has(eid) === true &&
    world?.rowsByComponentId.get(comps.identityId)?.has(eid) === true;

  const restLevelOf = (eid: number): number =>
    needsRowOf(world!, comps, eid)?.[1] ?? 100;

  const queueLengthOf = (eid: number): number =>
    world?.rowsByComponentId.get(comps.activityQueueId)?.get(eid)?.[0] ?? 0;

  const employedOf = (eid: number): boolean =>
    getAssignedNode(world!, comps, eid) !== undefined ||
    getAssignedSite(world!, comps, eid) !== undefined ||
    getProductionJob(world!, comps, eid) !== undefined;

  /** Release every labor claim of one Pop (the visible-state way). */
  const releaseAssignment = (eid: number): void => {
    world!.rowsByComponentId.get(comps.assignedNodeId)?.delete(eid);
    world!.rowsByComponentId.get(comps.assignedSiteId)?.delete(eid);
    clearProductionJob(world!, comps, eid);
    const queue = readActivityQueue(world!, comps, eid);
    cancelActivities(queue);
    writeActivityQueue(world!, comps, eid, queue);
  };

  /**
   * Live ProductionJob holders of one workplace, ascending eid. Only
   * units with Position+UnitTag rows count.
   */
  const craftersOfWorkplace = (buildingEid: number): number[] => {
    const out: number[] = [];
    const jobRows = world!.rowsByComponentId.get(comps.productionJobId)!;
    const posRows = world!.rowsByComponentId.get(comps.positionId);
    for (const eid of world!.entities) {
      const job = jobRows.get(eid);
      if (!job || job[0] !== buildingEid) continue;
      if (!posRows?.get(eid) || !tagRows()?.get(eid)) continue;
      out.push(eid);
    }
    return out.sort((a, b) => a - b);
  };

  /**
   * The unassigned idle pool of one owner: named, work-aged, unlocked,
   * queue-empty Pops holding no assignment and no office — adults
   * first (each group ascending eid), elders appended last (light
   * duty). This IS the fill source; the RANKED appointment view lives
   * in managementCandidatesOf.
   */
  const idlePoolOf = (ownerId: number): number[] => {
    const adults: number[] = [];
    const elders: number[] = [];
    const identityRows = world!.rowsByComponentId.get(comps.identityId)!;
    const nodeRows = world!.rowsByComponentId.get(comps.assignedNodeId);
    const siteRows = world!.rowsByComponentId.get(comps.assignedSiteId);
    const jobRows = world!.rowsByComponentId.get(comps.productionJobId);
    const lockRows = world!.rowsByComponentId.get(comps.orderLockId);
    const managerRows = world!.rowsByComponentId.get(comps.managerId);
    const foremanPops = new Set<number>();
    for (const [, row] of world!.rowsByComponentId.get(comps.foremanId)!) {
      foremanPops.add(row[0]!);
    }
    for (const eid of world!.entities) {
      if (!tagRows()?.has(eid) || !identityRows.has(eid)) continue;
      if (managerRows?.has(eid) || foremanPops.has(eid)) continue;
      if (lockRows?.has(eid)) continue;
      if (
        nodeRows?.get(eid) !== undefined ||
        siteRows?.get(eid) !== undefined ||
        jobRows?.get(eid) !== undefined
      ) {
        continue;
      }
      if (queueLengthOf(eid) > 0) continue;
      if (ownerOfUnit(world!, comps, eid) !== ownerId) continue;
      const stage = lifeStageOf(world!, comps, eid, lifecycleConfig);
      if (stage === LIFE_STAGE_CHILD) continue;
      if (stage === LIFE_STAGE_ELDER) elders.push(eid);
      else adults.push(eid);
    }
    return [...adults, ...elders];
  };

  /** Submit one delegated produce order for the next tick boundary. */
  const delegateToWorkplace = (popEid: number, buildingEid: number): void => {
    world!.inbox.submit({
      kind: "produce",
      targetTick: world!.tick + 1,
      data: { entityIds: [popEid], buildingEid, delegated: true },
    });
  };

  /** Management XP grows while serving (trait mult applies, cap holds). */
  const awardServiceXp = (eid: number): void => {
    const row = ensureManagementSkillRow(world!, comps, eid);
    const mult = traitXpGainMult(readTraits(world!, comps, eid) ?? []);
    const gained = Math.max(1, Math.round(MANAGEMENT_XP_PER_PASS * mult));
    row[0] = Math.min(LEGENDARY_TOTAL_XP, row[0]! + gained);
  };

  // ---- Appointment commands -----------------------------------------------------

  const requireEligibleOfficer = (popEid: number): number => {
    if (!isLiveNamedPop(popEid)) {
      throw new Error(`pop ${String(popEid)} is not a live named Pop`);
    }
    if (
      lifeStageOf(world!, comps, popEid, lifecycleConfig) === LIFE_STAGE_CHILD
    ) {
      throw new Error("children cannot hold management offices");
    }
    if (world!.rowsByComponentId.get(comps.orderLockId)?.has(popEid)) {
      throw new Error(
        `pop ${String(popEid)} is under a direct order and cannot be appointed`,
      );
    }
    const owner = ownerOfUnit(world!, comps, popEid);
    if (!servedPlayer(owner)) {
      throw new Error(
        `player ${String(owner)} is not served by this delegation layer`,
      );
    }
    return owner;
  };

  const applyAppointForeman = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const buildingEid = parsePositiveInt(data, "buildingEid");
    const popEid = parsePositiveInt(data, "popId");
    const buildingRow = getBuildingRow(world!, comps, buildingEid);
    if (!buildingRow) {
      throw new Error(
        `appointForeman targets entity ${String(buildingEid)}, which has no finished Building row`,
      );
    }
    const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
    if (def.workSlots <= 0 || recipesForBuilding(def.id).length === 0) {
      throw new Error(`building ${def.id} is not a workplace`);
    }
    const owner = requireEligibleOfficer(popEid);
    if (managerRowOf(world!, comps, popEid) !== undefined) {
      throw new Error(
        `pop ${String(popEid)} already manages a domain — dismiss them first`,
      );
    }
    if (owner !== buildingRow[0]) {
      throw new Error("appointForeman pop does not belong to the building");
    }
    // Re-appointment moves the office: any other Foreman row naming
    // this Pop dies (ascending-eid scan keeps it deterministic).
    const foremanRows = world!.rowsByComponentId.get(comps.foremanId)!;
    for (const [otherBuilding, row] of [...foremanRows].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (row[0] === popEid && otherBuilding !== buildingEid) {
        foremanRows.delete(otherBuilding);
        diagnostics.dismissals += 1;
      }
    }
    // Promotion releases any current labor assignment (they supervise
    // now); locked Pops were refused above, so nothing direct breaks.
    releaseAssignment(popEid);
    ensureManagementSkillRow(world!, comps, popEid);
    setForemanRow(world!, comps, buildingEid, popEid, tick);
    diagnostics.appointments += 1;
  };

  const applyDismissForeman = (
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const buildingEid = parsePositiveInt(data, "buildingEid");
    if (clearForemanRow(world!, comps, buildingEid)) {
      diagnostics.dismissals += 1;
    }
  };

  const applyAppointManager = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const popEid = parsePositiveInt(data, "popId");
    const domain = parseDomainCode(data);
    const owner = requireEligibleOfficer(popEid);
    const existing = managerRowOf(world!, comps, popEid);
    if (existing !== undefined && existing.domain !== domain) {
      throw new Error(
        `pop ${String(popEid)} already manages another domain — dismiss first`,
      );
    }
    // One manager per (owner, domain): the previous holder is dismissed
    // instantly (ascending-eid scan, never the incoming Pop).
    const managerRows = world!.rowsByComponentId.get(comps.managerId)!;
    for (const [otherPop, row] of [...managerRows].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (
        otherPop !== popEid &&
        row[0] === domain &&
        ownerOfUnit(world!, comps, otherPop) === owner
      ) {
        clearManagerRow(world!, comps, otherPop);
        clearStrategyWeights(world!, comps, otherPop);
        diagnostics.dismissals += 1;
      }
    }
    // Managers stop working the line; any Foreman post they held dies.
    const foremanRows = world!.rowsByComponentId.get(comps.foremanId)!;
    for (const [building, row] of [...foremanRows].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (row[0] === popEid) {
        foremanRows.delete(building);
        diagnostics.dismissals += 1;
      }
    }
    releaseAssignment(popEid);
    ensureManagementSkillRow(world!, comps, popEid);
    setManagerRow(world!, comps, popEid, domain, tick);
    if (strategyWeightsOf(world!, comps, popEid) === undefined) {
      setStrategyWeights(world!, comps, popEid, [1, 1, 1, 1, 1]);
    }
    diagnostics.appointments += 1;
  };

  const applyDismissManager = (
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const popEid = parsePositiveInt(data, "popId");
    if (clearManagerRow(world!, comps, popEid)) {
      clearStrategyWeights(world!, comps, popEid);
      diagnostics.dismissals += 1;
    }
  };

  const applySetStrategy = (data: Readonly<Record<string, unknown>>): void => {
    const domain = parseDomainCode(data);
    const raw = data.weights;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.some(
        (weight) =>
          typeof weight !== "number" || !Number.isFinite(weight) || weight < 0,
      )
    ) {
      throw new Error("setStrategy weights must be non-negative numbers");
    }
    const weights = raw as number[];
    let playerId: number | undefined =
      typeof data.playerId === "number" ? data.playerId : undefined;
    if (playerId === undefined) {
      // Owner-less form requires exactly one serving player per domain.
      const managerRows = world!.rowsByComponentId.get(comps.managerId)!;
      for (const [pop, row] of managerRows) {
        if (row[0] !== domain) continue;
        const owner = ownerOfUnit(world!, comps, pop);
        if (playerId !== undefined && playerId !== owner) {
          throw new Error(
            "setStrategy requires playerId when several players share the domain",
          );
        }
        playerId = owner;
      }
      if (playerId === undefined) {
        throw new Error(`no manager serves domain ${String(domain)}`);
      }
    }
    const manager = managerOfDomain(world!, comps, playerId, domain);
    if (manager === undefined) {
      throw new Error(
        `no manager serves domain ${String(domain)} for player ${String(playerId)}`,
      );
    }
    setStrategyWeights(world!, comps, manager, weights);
  };

  // ---- Foreman pass -----------------------------------------------------------

  /** One foreman think: rotate the exhausted, keep slots filled. */
  const runForemanThink = (buildingEid: number): void => {
    const foremanEntry = foremanRowOf(world!, comps, buildingEid);
    if (foremanEntry === undefined) return;
    const buildingRow = getBuildingRow(world!, comps, buildingEid);
    const foremanRows = world!.rowsByComponentId.get(comps.foremanId)!;
    if (!buildingRow) {
      // Workplace died: the office dies with it (rebuild orders are a
      // later ticket; nothing here can resurrect a footprint).
      foremanRows.delete(buildingEid);
      return;
    }
    const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
    if (def.workSlots <= 0 || recipesForBuilding(def.id).length === 0) return;
    const foremanPop = foremanEntry.foremanPopEid;
    if (!isLiveNamedPop(foremanPop)) {
      foremanRows.delete(buildingEid);
      return;
    }
    awardServiceXp(foremanPop);

    const lockRows = world!.rowsByComponentId.get(comps.orderLockId)!;
    let pool = idlePoolOf(buildingRow[0]!);
    let crafters = craftersOfWorkplace(buildingEid);

    // Rotation first: an exhausted SLOTTED worker swaps only once a
    // rested replacement exists, so the slot never goes dark.
    for (const crafter of crafters) {
      if (crafters.length > def.workSlots) break; // overflow, not slots
      if (restLevelOf(crafter) > FOREMAN_ROTATE_REST_LEVEL) continue;
      if (lockRows.has(crafter)) continue; // direct orders stay put
      const replacement = pool.shift();
      if (replacement === undefined) break;
      releaseAssignment(crafter);
      delegateToWorkplace(replacement, buildingEid);
      crafters = crafters.filter((eid) => eid !== crafter);
      diagnostics.rotations += 1;
    }

    // Saturation: top up every empty slot from the idle pool.
    while (crafters.length < def.workSlots) {
      const replacement = pool.shift();
      if (replacement === undefined) break;
      delegateToWorkplace(replacement, buildingEid);
      crafters = [...crafters, replacement];
      diagnostics.fills += 1;
    }
  };

  // ---- Manager pass -------------------------------------------------------------

  /**
   * Largest-remainder targets over `demand` seats: floor shares by
   * weight, leftovers to the biggest fractional parts (index order
   * breaks ties). Demand below the workplace count still spreads every
   * seat the domain owns — an unfilled kitchen with idle hands is the
   * failure §2.7 exists to prevent.
   */
  const seatTargets = (
    workerCounts: readonly number[],
    capacities: readonly number[],
    weights: readonly number[],
  ): number[] => {
    const currentWorkers = workerCounts.reduce((sum, c) => sum + c, 0);
    const totalCapacity = capacities.reduce((sum, c) => sum + c, 0);
    const demand = Math.max(currentWorkers, totalCapacity);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const targets = workerCounts.map(() => 0);
    if (totalWeight <= 0 || demand === 0) return targets;
    let remaining = demand;
    const fractional: { index: number; fraction: number }[] = [];
    for (let i = 0; i < workerCounts.length; i++) {
      const exact = (demand * (weights[i] ?? 1)) / totalWeight;
      targets[i] = Math.floor(exact);
      remaining -= targets[i]!;
      fractional.push({ index: i, fraction: exact - Math.floor(exact) });
    }
    fractional.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = 0; remaining > 0 && i < fractional.length; i++) {
      const idx = fractional[i]!.index;
      targets[idx] = targets[idx]! + 1;
      remaining -= 1;
    }
    return targets;
  };

  /** One manager think: redistribute toward the slider weights. */
  const runManagerThink = (managerPop: number): void => {
    const managerEntry = managerRowOf(world!, comps, managerPop);
    if (managerEntry === undefined) return;
    const domain = managerEntry.domain;
    const owner = ownerOfUnit(world!, comps, managerPop);
    awardServiceXp(managerPop);

    // Workplaces of this domain, ascending eid: finished production
    // buildings whose definition maps here and owns the work.
    const workplaceIds: number[] = [];
    const workplaceCapacity: number[] = [];
    const buildingRows = world!.rowsByComponentId.get(comps.buildingId)!;
    for (const eid of world!.entities) {
      const row = buildingRows.get(eid);
      if (!row || row[0] !== owner) continue;
      const def = buildingDefOf(buildingIdOfCode(row[1]!));
      if (domainOfBuildingDef(def.id) !== domain) continue;
      if (def.workSlots <= 0 || recipesForBuilding(def.id).length === 0) {
        continue;
      }
      workplaceIds.push(eid);
      workplaceCapacity.push(def.workSlots);
    }
    if (workplaceIds.length === 0) return;

    const crafters = workplaceIds.map((eid) => craftersOfWorkplace(eid));
    const stored = strategyWeightsOf(world!, comps, managerPop);
    const weights = workplaceIds.map((_, i) => stored?.[i] ?? 1);
    const targets = seatTargets(
      crafters.map((list) => list.length),
      workplaceCapacity,
      weights,
    );

    const lockRows = world!.rowsByComponentId.get(comps.orderLockId)!;

    // Donations: surplus workplaces give up UNLOCKED crafters, highest
    // eid first (newest arrivals move; seniority stays put), capped at
    // the total deficit so nothing churns without a recipient.
    let totalDeficit = 0;
    for (let i = 0; i < workplaceIds.length; i++) {
      totalDeficit += Math.max(0, targets[i]! - crafters[i]!.length);
    }
    const donations: number[] = [];
    for (
      let i = 0;
      i < workplaceIds.length && donations.length < totalDeficit;
      i++
    ) {
      let surplus = crafters[i]!.length - targets[i]!;
      if (surplus <= 0) continue;
      const donors = [...crafters[i]!].sort((a, b) => b - a);
      for (const donor of donors) {
        if (surplus <= 0 || donations.length >= totalDeficit) break;
        if (lockRows.has(donor)) continue; // override rule
        donations.push(donor);
        releaseAssignment(donor);
        surplus -= 1;
      }
    }

    // Recipients: deficit workplaces seat the donations first, then
    // fresh hires from the idle pool, up to target — never beyond.
    let pool: number[] | undefined;
    let donationIndex = 0;
    for (let i = 0; i < workplaceIds.length; i++) {
      while (crafters[i]!.length < targets[i]!) {
        const next =
          donationIndex < donations.length
            ? donations[donationIndex++]!
            : (pool ??= idlePoolOf(owner)).shift();
        if (next === undefined) break;
        delegateToWorkplace(next, workplaceIds[i]!);
        crafters[i] = [...crafters[i]!, next];
        diagnostics.redistributions += 1;
      }
    }
  };

  // ---- The system ---------------------------------------------------------------

  return (stepWorld: World, commands: readonly SimCommand[]): void => {
    world = stepWorld;
    const tick = stepWorld.tick;

    // ---- 1) Direct-order bookkeeping: stamps land before anything
    // else reads locks this tick; delegated commands never stamp.
    for (const command of commands) {
      if (command.data?.delegated === true) continue;
      let kind: number | undefined;
      switch (command.kind) {
        case "gather":
          kind = ORDER_KIND_GATHER;
          break;
        case "build":
          kind = ORDER_KIND_BUILD;
          break;
        case "produce":
          kind = ORDER_KIND_PRODUCE;
          break;
        case "groupMove":
        case "attackMove":
          kind = ORDER_KIND_MOVE;
          break;
        case "attack":
          kind = ORDER_KIND_ATTACK;
          break;
        default:
          continue;
      }
      if (!command.data) continue;
      for (const eid of parseCommandIds(command.data)) {
        if (!tagRows()?.has(eid)) continue; // live units only
        stampOrderLock(stepWorld, comps, eid, tick, kind);
        diagnostics.locksStamped += 1;
      }
    }

    // ---- 2) Appointment/dismissal/strategy commands.
    for (const command of commands) {
      if (!command.data) continue;
      switch (command.kind) {
        case "appointForeman":
          applyAppointForeman(tick, command.data);
          break;
        case "dismissForeman":
          applyDismissForeman(command.data);
          break;
        case "appointManager":
          applyAppointManager(tick, command.data);
          break;
        case "dismissManager":
          applyDismissManager(command.data);
          break;
        case "setStrategy":
          applySetStrategy(command.data);
          break;
        default:
          break;
      }
    }

    // ---- 3) Lock sweep: release orders whose activity ended or was
    // cancelled. Labor locks track assignment rows (auto-repeat chains
    // keep the standing order alive); transit locks track the queue —
    // with an activation flag, because group routes enqueue only after
    // their leader path applies (an empty queue before activation is a
    // route in flight, not a finished order).
    const lockRows = stepWorld.rowsByComponentId.get(comps.orderLockId)!;
    for (const [eid, row] of [...lockRows]) {
      if (!tagRows()?.has(eid)) {
        lockRows.delete(eid); // unit died; despawn strips the rest
        continue;
      }
      if (!orderKindIsLabor(row[1]!)) {
        const queueLength = queueLengthOf(eid);
        if (queueLength > 0) {
          row[2] = 1; // activated: the route landed
          continue;
        }
        const released =
          row[2] === 1 || tick - row[0]! >= TRANSIT_LOCK_GRACE_TICKS;
        if (released) {
          clearOrderLock(stepWorld, comps, eid);
          diagnostics.locksReleased += 1;
        }
        continue;
      }
      if (!employedOf(eid)) {
        clearOrderLock(stepWorld, comps, eid);
        diagnostics.locksReleased += 1;
      }
    }

    // ---- 4) Foremen at their staggered 1 Hz think.
    const foremanRows = stepWorld.rowsByComponentId.get(comps.foremanId)!;
    if (foremanRows.size > 0) {
      for (const [buildingEid] of [...foremanRows].sort(
        (a, b) => a[0] - b[0],
      )) {
        if ((tick + buildingEid) % FOREMAN_THINK_INTERVAL_TICKS !== 0) continue;
        runForemanThink(buildingEid);
      }
    }

    // ---- 5) Managers redistribute at their staggered cadence.
    const managerRows = stepWorld.rowsByComponentId.get(comps.managerId)!;
    if (managerRows.size > 0) {
      for (const [popEid] of [...managerRows].sort((a, b) => a[0] - b[0])) {
        if ((tick + popEid) % MANAGER_REALLOCATE_INTERVAL_TICKS !== 0) continue;
        runManagerThink(popEid);
      }
    }
  };
}

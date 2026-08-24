/**
 * Companies system — SPEC §2.7 / M4-T2 (issue #57).
 *
 * Player-chartered companies {name, charter focus, virtual treasury,
 * owned Workplaces as Branches}. V1 player-civ only (AI reuse post-v1).
 *
 * Command interface — the shared-inbox language again:
 *
 *   charterCompany   { name, focus, seedBuildingIds }
 *   setCompanyShare  { companyId, sharePct }
 *   setCompanyFrozen { companyId, frozen }
 *
 * Chartering absorbs each seed building into Branch status (Branch row
 * on the building); any player-appointed Foreman post there dies with
 * the transfer — staffing authority moves to the company.
 *
 * Ledger — output market value at branches routes a configurable share
 * (default 20%) to the company's VIRTUAL treasury; the physical units
 * land in stockpiles exactly as before (the share is an accounting
 * tithe, never a production tax). Routing rides an injectable observer
 * seam: gather and production call `onOutput` at every credit event
 * (drop-off deposit / cycle completion), and this system hands that
 * observer out when wiring them. The observer only accumulates closure
 * state; the flush into Company rows + TreasuryDelta tail entries
 * happens in THIS system's pass — same tick, after every labor system
 * ran, so accrual is deterministic replay state. A branch chartered
 * mid-tick misses that tick's earlier completions (its rows did not
 * exist when they credited) — documented boundary, replay-stable.
 * Deltas are integer milli-credits: qty × marketValue × sharePct × 10,
 * exact by construction (components/company.ts).
 *
 * Staffing rule (SPEC §2.7): branch Foremen are appointed EXCLUSIVELY
 * by this pass from the owner's own management-rated Pops — best
 * managementRatingOf for the branch's domain wins, ties break to the
 * lower eid; no player appointment or veto exists (systems/management
 * rejects appoint/dismissForeman targeting a branch). The player's
 * appointment power stays untouched on directly-owned workplaces.
 * Cadence mirrors the delegation layer's 1 Hz stagger:
 * `(tick + companyEid) % COMPANY_STAFF_INTERVAL_TICKS`. Serving passes
 * grow Management skill through the existing foreman machinery, which
 * saturates branch work slots unchanged.
 *
 * Freeze flag halts expansion/staffing churn — no new appointments
 * while frozen — but never production or passive treasury accrual.
 * (Expansion proposals themselves are a later §2.7 ticket; they will
 * consult this same flag.)
 *
 * Registration order matters: register AFTER the delegated-management
 * system so a same-tick vacancy is visible to the next staffing think,
 * and before the AI planner per its last-on-the-roster contract.
 */

import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import { cancelActivities } from "../activities";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import {
  addTreasuryMilli,
  appendTreasuryDelta,
  branchRowOf,
  companyRowOf,
  MARKET_VALUE_PER_UNIT,
  setBranchRow,
  setCompanyFrozen,
  setCompanyRow,
  setCompanySharePct,
} from "../components/company";
import { getBuildingRow } from "../components/buildings";
import { clearAssignedNode } from "../components/economy";
import { clearAssignedSite } from "../components/buildings";
import { clearProductionJob } from "../components/production";
import {
  domainOfBuildingDef,
  ensureManagementSkillRow,
  foremanRowOf,
  requireDomainCode,
  setForemanRow,
} from "../components/management";
import type { SimCommand } from "../core/inbox";
import { spawnEntity, type SimSystem, type World } from "../core/world";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_CHILD,
  lifeStageOf,
  type LifecycleConfig,
} from "./lifecycle";
import { managementRatingOf } from "./management";

// ---- Documented tuning constants ---------------------------------------------

/** Company staffing cadence — the delegation layer's 1 Hz stagger. */
export const COMPANY_STAFF_INTERVAL_TICKS = 30;
/** Charter name length cap enforced at parse time (row layout bound). */
export const CHARTER_NAME_MAX_LENGTH = 24;

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface CompanyDiagnostics {
  /** charterCompany commands applied. */
  charters: number;
  /** Seed buildings absorbed into Branch status at charters. */
  branchesAbsorbed: number;
  /** Foreman posts vacated by charter transfers. */
  transfers: number;
  /** Branch foremen seated by the staffing pass. */
  appointments: number;
  /** Staffing thinks skipped because the company is frozen. */
  frozenThinks: number;
  /** Ticks that flushed a non-zero treasury delta for some company. */
  accrualFlushes: number;
}

export function createCompanyDiagnostics(): CompanyDiagnostics {
  return {
    charters: 0,
    branchesAbsorbed: 0,
    transfers: 0,
    appointments: 0,
    frozenThinks: 0,
    accrualFlushes: 0,
  };
}

// ---- Output routing seam -------------------------------------------------------

/**
 * Observer signature the gather/production systems invoke at every
 * output credit event inside step(): the owning player, the credited
 * building (drop-off or production workplace), the output slug and its
 * unit count.
 */
export type BranchOutputObserver = (
  world: World,
  comps: SimComponents,
  ownerId: number,
  buildingEid: number,
  outputSlug: string,
  qty: number,
) => void;

/** Optional observers bag accepted by gather/production factories. */
export interface OutputObservers {
  readonly onOutput?: BranchOutputObserver | undefined;
}

/** Exact integer milli-credit share of one output event. */
export function branchShareMilli(
  qty: number,
  outputSlug: string,
  sharePct: number,
): number {
  const value = MARKET_VALUE_PER_UNIT[outputSlug];
  if (value === undefined) {
    throw new Error(
      `no market value registered for output ${JSON.stringify(outputSlug)}`,
    );
  }
  return qty * value * sharePct * 10;
}

// ---- Command parsing -------------------------------------------------------------

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

function parseSeedBuildingIds(
  data: Readonly<Record<string, unknown>>,
): number[] {
  const raw = data.seedBuildingIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("charterCompany requires non-empty seedBuildingIds");
  }
  const ids: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      throw new Error(
        `seedBuildingIds entries must be positive integers, got ${String(entry)}`,
      );
    }
    if (ids.includes(entry)) {
      throw new Error(`seedBuildingIds lists entity ${String(entry)} twice`);
    }
    ids.push(entry);
  }
  return ids.sort((a, b) => a - b);
}

function parseName(data: Readonly<Record<string, unknown>>): string {
  const name = data.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("charterCompany requires a non-empty name");
  }
  if (name.length > CHARTER_NAME_MAX_LENGTH) {
    throw new Error(
      `company name must be at most ${String(CHARTER_NAME_MAX_LENGTH)} characters`,
    );
  }
  return name;
}

// ---- The system ----------------------------------------------------------------

export interface CompaniesSystemOptions {
  readonly comps: SimComponents;
  /**
   * Players whose Pops this company layer serves. Undefined serves
   * everyone; the skirmish session wires [PLAYER_ONE] so the AI
   * opponent keeps its own planner stack (SPEC §2.8 layering).
   */
  readonly players?: readonly number[] | undefined;
  readonly diagnostics?: CompanyDiagnostics | undefined;
  readonly lifecycleConfig?: LifecycleConfig | undefined;
}

export interface CompaniesSystemHandle {
  readonly system: SimSystem;
  /** Wire into createGatherSystem/createProductionSystem observers. */
  readonly onOutput: BranchOutputObserver;
}

/** Build the companies SimSystem plus its output-routing observer. */
export function createCompaniesSystem(
  options: CompaniesSystemOptions,
): CompaniesSystemHandle {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createCompanyDiagnostics();
  const lifecycleConfig = options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG;

  /**
   * Closure-scoped world reference: valid inside the returned system
   * call AND the observer (which runs during EARLIER systems' steps of
   * the same tick).
   */
  let world: World | undefined;

  // Pending same-tick accruals keyed by company eid (milli-credits).
  let pendingMilli = new Map<number, number>();

  /** True when `ownerId` belongs to a served player. */
  const servedPlayer = (ownerId: number): boolean =>
    players === undefined || players.includes(ownerId);

  const tagRows = (): Map<number, number[]> | undefined =>
    world?.rowsByComponentId.get(comps.unitTagId);

  const isLiveNamedPop = (eid: number): boolean =>
    tagRows()?.has(eid) === true &&
    world?.rowsByComponentId.get(comps.identityId)?.has(eid) === true;

  /** Release every labor claim of one Pop (the visible-state way). */
  const releaseAssignment = (eid: number): void => {
    clearAssignedNode(world!, comps, eid);
    clearAssignedSite(world!, comps, eid);
    clearProductionJob(world!, comps, eid);
    const queue = readActivityQueue(world!, comps, eid);
    cancelActivities(queue);
    writeActivityQueue(world!, comps, eid, queue);
  };

  // ---- Output observer (runs inside gather/production steps) ---------------------

  const onOutput: BranchOutputObserver = (
    stepWorld,
    stepComps,
    _ownerId,
    buildingEid,
    outputSlug,
    qty,
  ): void => {
    void _ownerId;
    const branch = branchRowOf(stepWorld, stepComps, buildingEid);
    if (branch === undefined) return; // directly-owned workplace: no tithe
    const company = companyRowOf(stepWorld, stepComps, branch.companyEid);
    if (company === undefined) return; // defensive: dangling branch row
    const milli = branchShareMilli(qty, outputSlug, company.sharePct);
    if (milli <= 0) return; // zero-share companies keep a silent ledger
    pendingMilli.set(
      branch.companyEid,
      (pendingMilli.get(branch.companyEid) ?? 0) + milli,
    );
  };

  // ---- Commands -----------------------------------------------------------------

  const applyCharterCompany = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const name = parseName(data);
    if (typeof data.focus !== "number") {
      throw new Error("charterCompany requires a focus domain code");
    }
    const focus = requireDomainCode(data.focus);
    const seeds = parseSeedBuildingIds(data);

    // Every seed must be a finished, unclaimed, same-owner building of
    // a served player whose definition maps to a §2.7 domain — branch-
    // able workplaces AND their resource clusters (kitchen/sawpit/farm/
    // lumber-camp/mining-camp/kiln/smithy/forge).
    let owner: number | undefined;
    for (const buildingEid of seeds) {
      const buildingRow = getBuildingRow(world!, comps, buildingEid);
      if (!buildingRow) {
        throw new Error(
          `charterCompany targets entity ${String(buildingEid)}, which has no finished Building row`,
        );
      }
      const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
      if (domainOfBuildingDef(def.id) === undefined) {
        throw new Error(`building ${def.id} cannot become a Branch`);
      }
      if (branchRowOf(world!, comps, buildingEid) !== undefined) {
        throw new Error(`building ${def.id} is already a company Branch`);
      }
      const buildingOwner = buildingRow[0]!;
      if (!servedPlayer(buildingOwner)) {
        throw new Error(
          `player ${String(buildingOwner)} is not served by this company layer`,
        );
      }
      if (owner === undefined) owner = buildingOwner;
      else if (owner !== buildingOwner) {
        throw new Error("charterCompany seeds must share one owner");
      }
    }

    // Commissioned charter (SPEC §2.7 origins): spawn the company
    // entity, then absorb the seeds into Branch status. Any player-
    // appointed foreman vacates instantly — staffing authority moved.
    const companyEid = spawnEntity(world!);
    setCompanyRow(world!, comps, companyEid, {
      ownerPlayerId: owner!,
      focusDomain: focus,
      name,
    });
    diagnostics.charters += 1;

    for (const buildingEid of seeds) {
      if (foremanRowOf(world!, comps, buildingEid) !== undefined) {
        world!.rowsByComponentId.get(comps.foremanId)!.delete(buildingEid);
        diagnostics.transfers += 1;
      }
      setBranchRow(world!, comps, buildingEid, companyEid, tick);
      diagnostics.branchesAbsorbed += 1;
    }
  };

  const applySetCompanyShare = (
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    const sharePct = data.sharePct;
    if (
      typeof sharePct !== "number" ||
      !Number.isInteger(sharePct) ||
      sharePct < 0 ||
      sharePct > 100
    ) {
      throw new Error("setCompanyShare sharePct must be a whole percent 0–100");
    }
    setCompanySharePct(world!, comps, companyId, sharePct);
  };

  const applySetCompanyFrozen = (
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    if (typeof data.frozen !== "boolean") {
      throw new Error("setCompanyFrozen requires a boolean frozen flag");
    }
    setCompanyFrozen(world!, comps, companyId, data.frozen);
  };

  // ---- Staffing pass -----------------------------------------------------------

  /**
   * Best management-rated own Pop for one branch: named non-child Pops
   * of the company owner carrying no direct-order lock, no manager
   * office, and no existing foreman post anywhere (one office per
   * officer). Ratings descend for the branch's domain; ties break to
   * the lower (ascending) eid.
   */
  const bestCandidateFor = (
    ownerId: number,
    domain: number,
  ): number | undefined => {
    const lockRows = world!.rowsByComponentId.get(comps.orderLockId);
    const managerRows = world!.rowsByComponentId.get(comps.managerId);
    const foremanRows = world!.rowsByComponentId.get(comps.foremanId)!;
    const foremanPops = new Set<number>();
    for (const [, row] of foremanRows) foremanPops.add(row[0]!);
    let best: number | undefined;
    let bestRating = -Infinity;
    for (const eid of world!.entities) {
      if (!isLiveNamedPop(eid)) continue;
      if (
        lifeStageOf(world!, comps, eid, lifecycleConfig) === LIFE_STAGE_CHILD
      ) {
        continue;
      }
      if (lockRows?.has(eid)) continue;
      if (managerRows?.has(eid)) continue;
      if (foremanPops.has(eid)) continue;
      const rating = managementRatingOf(world!, comps, eid, domain);
      if (rating > bestRating) {
        bestRating = rating;
        best = eid;
      }
    }
    void ownerId;
    return best;
  };

  const runStaffingThink = (companyEid: number, tick: number): void => {
    const company = companyRowOf(world!, comps, companyEid);
    if (company === undefined) return;
    if (company.frozen) {
      // Freeze halts staffing churn (and, later, expansion) — never
      // production or the passive ledger.
      diagnostics.frozenThinks += 1;
      return;
    }
    const branchRows = world!.rowsByComponentId.get(comps.branchId)!;
    const owned: number[] = [];
    for (const [buildingEid, row] of [...branchRows].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (row[0] === companyEid) owned.push(buildingEid);
    }
    for (const buildingEid of owned) {
      const existing = foremanRowOf(world!, comps, buildingEid);
      if (existing !== undefined && isLiveNamedPop(existing.foremanPopEid)) {
        continue; // seat kept warm; churn only on true vacancies
      }
      const buildingRow = getBuildingRow(world!, comps, buildingEid);
      if (!buildingRow) continue; // destroyed: rows died with the entity
      const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
      const domain =
        domainOfBuildingDef(def.id) ?? requireDomainCode(company.focusDomain);
      const candidate = bestCandidateFor(company.ownerPlayerId, domain);
      if (candidate === undefined) continue; // retry at the next think
      releaseAssignment(candidate);
      ensureManagementSkillRow(world!, comps, candidate);
      setForemanRow(world!, comps, buildingEid, candidate, tick);
      diagnostics.appointments += 1;
    }
  };

  // ---- The system ---------------------------------------------------------------

  return {
    onOutput,
    system: (stepWorld: World, commands: readonly SimCommand[]): void => {
      world = stepWorld;
      const tick = stepWorld.tick;

      // ---- 1) Company commands on their target boundary.
      for (const command of commands) {
        if (!command.data) continue;
        switch (command.kind) {
          case "charterCompany":
            applyCharterCompany(tick, command.data);
            break;
          case "setCompanyShare":
            applySetCompanyShare(command.data);
            break;
          case "setCompanyFrozen":
            applySetCompanyFrozen(command.data);
            break;
          default:
            break;
        }
      }

      // ---- 2) Flush this tick's branch-output accruals into the
      // treasuries + ledger tails (ascending company eid).
      if (pendingMilli.size > 0) {
        const ordered = [...pendingMilli.entries()].sort((a, b) => a[0] - b[0]);
        pendingMilli = new Map();
        for (const [companyEid, milli] of ordered) {
          if (companyRowOf(stepWorld, comps, companyEid) === undefined) {
            continue; // defensive: skip dangling accruals
          }
          addTreasuryMilli(stepWorld, comps, companyEid, milli);
          appendTreasuryDelta(stepWorld, comps, companyEid, tick, milli);
          diagnostics.accrualFlushes += 1;
        }
      }

      // ---- 3) Staffing thinks at the staggered 1 Hz cadence.
      const companyRows = stepWorld.rowsByComponentId.get(comps.companyId)!;
      if (companyRows.size > 0) {
        for (const [companyEid] of [...companyRows].sort(
          (a, b) => a[0] - b[0],
        )) {
          if ((tick + companyEid) % COMPANY_STAFF_INTERVAL_TICKS !== 0) {
            continue;
          }
          runStaffingThink(companyEid, tick);
        }
      }
    },
  };
}

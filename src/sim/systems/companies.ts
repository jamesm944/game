/**
 * Companies system — SPEC §2.7 / M4-T2 (issue #57) + M4-T3 (issue #58).
 *
 * Player-chartered companies {name, charter focus, virtual treasury,
 * owned Workplaces as Branches}. V1 player-civ only (AI reuse post-v1).
 *
 * Command interface — the shared-inbox language again:
 *
 *   charterCompany     { name, focus, seedBuildingIds }
 *   setCompanyShare    { companyId, sharePct }
 *   setCompanyFrozen   { companyId, frozen }
 *   setApprovalMode    { companyId, mode }     // M4-T3: 0 ask / 1 auto
 *   approveExpansion   { companyId }           // M4-T3 ask verdict
 *   rejectExpansion    { companyId }           // M4-T3 ask verdict
 *   seizeBranch        { companyId, branchId } // M4-T3 oversight action
 *   dissolveCompany    { companyId }           // M4-T3 oversight action
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
 * Freeze flag halts expansion/staffing churn — no new appointments or
 * proposals while frozen — but never production or passive treasury
 * accrual.
 *
 * Expansion pass (M4-T3, SPEC §2.7): every 30-tick think (same stagger
 * as staffing) a healthy company checks its holds — treasury ≥
 * EXPANSION_TREASURY_THRESHOLD_MILLI, an UNCLAIMED resource node in
 * reach of its nearest branch (no finished building already sitting on
 * it), labor slack ≥ EXPANSION_LABOR_SLACK_MIN idle unlocked Pops, a
 * placement-valid footprint near the node per the SHARED validity
 * function, not frozen, nothing pending — then proposes one new Branch:
 * the §2.6 building of its charter focus, PAID FROM THE TREASURY at the
 * definition's exact market-value equivalent (Σ qty × value × 1000
 * milli), sited by the AI's own distance-sorted scorer (siteCandidates)
 * around the chosen node. AUTO_APPROVE executes immediately — ground
 * blocks, a real construction site spawns, Branch status attaches at
 * site birth so staffing/output wake up exactly when the camp finishes.
 * ALWAYS_ASK (the default) stamps a PendingExpansion row for the player;
 * approveExpansion/rejectExpansion resolve it. Every execution, verdict
 * and oversight act appends to the company's public ExpansionLog.
 *
 * Organic origins (M4-T3, SPEC §2.7): once per simulated day the scan
 * looks for a sector where ≥ ORGANIC_MIN_PROFITABLE_WORKPLACES
 * DIRECTLY-owned workplaces of one domain turned output within PROFIT_
 * LOOKBACK_TICKS AND a sufficiently management-rated own Pop exists —
 * that Pop founds a company on the spot, absorbing them as seed
 * Branches (transfer semantics identical to a commissioned charter).
 * The founding logs a FOUNDED entry and stamps CompanyOrigin, opening
 * an ORGANIC_DISSOLVE_GRACE_TICKS free-dissolve window; past it,
 * dissolveCompany charges the owner ORGANIC_DISSOLVE_FEE_GOLD gold
 * severance (commissioned charters always dissolve free). One founding
 * per scan; a per-player cooldown keeps serial founders from chaining.
 * Profitability + cooldown ride closure state fed by the same output
 * observer — never digest rows (persistence is the save ticket's).
 *
 * Registration order matters: register AFTER the delegated-management
 * system so a same-tick vacancy is visible to the next staffing think,
 * and before the AI planner per its last-on-the-roster contract.
 */

import {
  buildingCodeOf,
  buildingDefOf,
  buildingIdOfCode,
} from "../../data/definitions";
import { siteCandidates } from "../ai/buildOrder";
import { cancelActivities } from "../activities";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import {
  addTreasuryMilli,
  appendExpansionLog,
  appendTreasuryDelta,
  APPROVAL_ALWAYS_ASK,
  APPROVAL_AUTO_APPROVE,
  approvalModeOf,
  branchRowOf,
  clearBranchRow,
  companyOriginOf,
  companyRowOf,
  EXPANSION_LOG_APPROVED,
  EXPANSION_LOG_EXECUTED,
  EXPANSION_LOG_FOUNDED,
  EXPANSION_LOG_REJECTED,
  EXPANSION_LOG_SEIZED,
  MARKET_VALUE_PER_UNIT,
  pendingExpansionOf,
  setApprovalMode as setApprovalModeRow,
  setBranchRow,
  setCompanyFrozen,
  setCompanyOrigin,
  setCompanyRow,
  setCompanySharePct,
  setPendingExpansion,
  spendTreasuryMilli,
} from "../components/company";
import { creditBranchOutput } from "../components/branchOutput";
import {
  buildingRectOf,
  getBuildingRow,
  siteRectOf,
  spawnBuildingSite,
} from "../components/buildings";
import type { FootprintRect } from "../components/buildings";

/** Rect of a branch whether still a site or already finished. */
const branchRectOf = (
  world: World,
  comps: SimComponents,
  eid: number,
): FootprintRect | undefined =>
  siteRectOf(world, comps, eid) ?? buildingRectOf(world, comps, eid);
import { clearAssignedNode } from "../components/economy";
import { clearAssignedSite } from "../components/buildings";
import { clearProductionJob } from "../components/production";
import {
  domainOfBuildingDef,
  clearForemanRow,
  ensureManagementSkillRow,
  foremanRowOf,
  requireDomainCode,
  setForemanRow,
} from "../components/management";
import { ownerOfUnit } from "../components/owner";
import { popNameOf } from "../components/pop";
import type { SimCommand } from "../core/inbox";
import {
  despawnEntity,
  spawnEntity,
  type SimSystem,
  type World,
} from "../core/world";
import { payCosts } from "./costs";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_CHILD,
  lifeStageOf,
  type LifecycleConfig,
} from "./lifecycle";
import { managementRatingOf } from "./management";
import { blockFootprintTiles, validatePlacement } from "./placement";

// ---- Documented tuning constants ---------------------------------------------

/** Company staffing cadence — the delegation layer's 1 Hz stagger. */
export const COMPANY_STAFF_INTERVAL_TICKS = 30;
/** Charter name length cap enforced at parse time (row layout bound). */
export const CHARTER_NAME_MAX_LENGTH = 24;

/**
 * Expansion holds (SPEC §2.7 / M4-T3). The treasury floor deliberately
 * sits ABOVE anything a §2.7 golden fixture accrues passively, so only
 * a company explicitly fed output expands; reach and claim radius keep
 * proposals inside operational territory; labor slack demands at least
 * one idle unlocked own Pop (the builder its site will need).
 */
export const EXPANSION_TREASURY_THRESHOLD_MILLI = 25_000;
export const EXPANSION_REACH_TILES = 18;
export const EXPANSION_CLAIM_RADIUS_TILES = 5;
export const EXPANSION_LABOR_SLACK_MIN = 1;
/** Site-search window around the chosen node (AI scorer parameters). */
export const EXPANSION_SITE_MIN_CLEARANCE = 0;
export const EXPANSION_SITE_MAX_RADIUS = 4;

/**
 * Charter focus → expansion building (SPEC §2.7: the new Branch serves
 * the company's sector). Resource domains expand into camps, food into
 * kitchen capacity, crafted into forge capacity.
 */
export const EXPANSION_DEF_BY_DOMAIN: Readonly<Record<number, string>> = {
  0: "kitchen",
  1: "lumber-camp",
  2: "mining-camp",
  3: "mining-camp",
  4: "forge",
};

/**
 * Organic founding thresholds (SPEC §2.7 origins): three profitable
 * directly-owned workplaces of one sector, a founder whose management
 * rating clears ORGANIC_FOUNDER_RATING_MIN, a free-dissolve grace
 * window after which dissolution costs gold severance, and a per-player
 * cooldown between spontaneous foundings.
 */
export const ORGANIC_MIN_PROFITABLE_WORKPLACES = 3;
export const PROFIT_LOOKBACK_TICKS = 900;
export const ORGANIC_FOUNDER_RATING_MIN = 1.5;
export const ORGANIC_DISSOLVE_GRACE_TICKS = 1800;
export const ORGANIC_DISSOLVE_FEE_GOLD = 50;
export const ORGANIC_FOUNDING_COOLDOWN_TICKS = 3600;

/**
 * Workplace definition each charter-focus domain expands into, priced
 * at market value for treasury payment.
 */
export function expansionDefForDomain(domain: number): string {
  requireDomainCode(domain);
  return EXPANSION_DEF_BY_DOMAIN[domain]!;
}

/** Exact treasury milli-credit price of one expansion definition. */
export function expansionCostMilli(defId: string): number {
  const def = buildingDefOf(defId);
  let milli = 0;
  for (const [slug, qty] of Object.entries(def.costs)) {
    const value = MARKET_VALUE_PER_UNIT[slug];
    if (value === undefined) {
      throw new Error(
        `no market value registered for cost ${JSON.stringify(slug)}`,
      );
    }
    milli += qty * value * 1000;
  }
  return milli;
}

/** Deterministic organic-company name from the founder's given name. */
export function organicCompanyName(founderName: string): string {
  const suffix = " & Co.";
  const head = founderName.slice(0, CHARTER_NAME_MAX_LENGTH - suffix.length);
  return `${head}${suffix}`;
}

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
  /** Expansion proposals formed (auto-executed ones included). */
  proposalsFormed: number;
  /** Proposals auto-approved at formation (approval mode auto). */
  autoExpansions: number;
  /** Pending proposals the player approved. */
  approvedExpansions: number;
  /** Pending proposals the player rejected. */
  rejectedProposals: number;
  /** Pending proposals lapsed (site/treasury no longer valid). */
  lapsedProposals: number;
  /** seizeBranch commands applied. */
  seizures: number;
  /** Organic foundings performed by the daily scan. */
  organicFoundations: number;
  /** dissolveCompany commands applied. */
  dissolutions: number;
}

export function createCompanyDiagnostics(): CompanyDiagnostics {
  return {
    charters: 0,
    branchesAbsorbed: 0,
    transfers: 0,
    appointments: 0,
    frozenThinks: 0,
    accrualFlushes: 0,
    proposalsFormed: 0,
    autoExpansions: 0,
    approvedExpansions: 0,
    rejectedProposals: 0,
    lapsedProposals: 0,
    seizures: 0,
    organicFoundations: 0,
    dissolutions: 0,
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
  /**
   * Per-player income multiplier applied at the credit event (M4-T6,
   * SPEC §2.8): the disclosed hard-difficulty AI cheat. Undefined → ×1.
   */
  readonly incomeMultiplierOf?:
    ((playerId: number) => number | undefined) | undefined;
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
  /**
   * Injectable persistent ledger state (SPEC §2.12 save/restore): the
   * output-profitability map and per-player organic-founding cooldowns
   * live outside the digest by design, so the save ticket owns their
   * serialization. Fresh maps when omitted (new match).
   */
  readonly persistentState?: CompaniesPersistentState | undefined;
}

/**
 * Closure state that outlives any single tick yet stays deliberately
 * out of the component rows (never digest-hashed): profitability stamps
 * feeding the organic-founding scan and the per-player founding
 * cooldowns. The session owns one instance and hands it back for
 * `.ageof` serialization.
 */
export interface CompaniesPersistentState {
  /** Building eid → tick of its last credited output event. */
  readonly lastOutputTickByBuilding: Map<number, number>;
  /** Player id → tick of its last organic founding (scan cooldown). */
  readonly lastOrganicFoundingTick: Map<number, number>;
}

export function createCompaniesPersistentState(): CompaniesPersistentState {
  return {
    lastOutputTickByBuilding: new Map(),
    lastOrganicFoundingTick: new Map(),
  };
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
  const persistent =
    options.persistentState ?? createCompaniesPersistentState();

  /**
   * Closure-scoped world reference: valid inside the returned system
   * call AND the observer (which runs during EARLIER systems' steps of
   * the same tick).
   */
  let world: World | undefined;

  // Pending same-tick accruals keyed by company eid (milli-credits).
  // Always empty between steps: the observer accumulates during the
  // gather/production passes and this system flushes it in the SAME
  // tick — nothing to serialize (SPEC §2.12 saves at step boundaries).
  let pendingMilli = new Map<number, number>();

  const lastOutputTickByBuilding = persistent.lastOutputTickByBuilding;
  const lastOrganicFoundingTick = persistent.lastOrganicFoundingTick;

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
    // Profitability stamp (M4-T3): every credited workplace counts,
    // branch or direct — the organic scan reads exactly this map.
    lastOutputTickByBuilding.set(buildingEid, stepWorld.tick);
    const branch = branchRowOf(stepWorld, stepComps, buildingEid);
    if (branch === undefined) return; // directly-owned workplace: no tithe
    const company = companyRowOf(stepWorld, stepComps, branch.companyEid);
    if (company === undefined) return; // defensive: dangling branch row
    // §2.11 Economic generator (M4-T5): the FULL market value of every
    // branch credit event feeds the owner's cumulative ledger — the
    // metric the victory evaluator derives its sustained rate from.
    // Integer-exact: qty × value × 1000 milli, mirroring the tithe math
    // below (the share is an accounting split of this same value).
    const value = MARKET_VALUE_PER_UNIT[outputSlug];
    if (value === undefined) {
      throw new Error(
        `no market value registered for output ${JSON.stringify(outputSlug)}`,
      );
    }
    creditBranchOutput(
      stepWorld,
      stepComps,
      company.ownerPlayerId,
      qty * value * 1000,
    );
    const milli = branchShareMilli(qty, outputSlug, company.sharePct);
    if (milli <= 0) return; // zero-share companies keep a silent ledger
    pendingMilli.set(
      branch.companyEid,
      (pendingMilli.get(branch.companyEid) ?? 0) + milli,
    );
  };

  // ---- Commands -----------------------------------------------------------------

  /**
   * Absorb finished workplaces into Branch status (shared by
   * commissioned charters AND organic foundings): any player-appointed
   * foreman vacates instantly — staffing authority moved — and the
   * Branch row stamps the join tick.
   */
  const absorbBranches = (
    buildingEids: readonly number[],
    companyEid: number,
    tick: number,
  ): void => {
    for (const buildingEid of buildingEids) {
      if (foremanRowOf(world!, comps, buildingEid) !== undefined) {
        clearForemanRow(world!, comps, buildingEid);
        diagnostics.transfers += 1;
      }
      setBranchRow(world!, comps, buildingEid, companyEid, tick);
      diagnostics.branchesAbsorbed += 1;
    }
  };

  /** Company row + served-owner gate shared by every company command. */
  const requireServedCompany = (companyId: number) => {
    const company = companyRowOf(world!, comps, companyId);
    if (company === undefined) {
      throw new Error(`entity ${String(companyId)} has no Company row`);
    }
    if (!servedPlayer(company.ownerPlayerId)) {
      throw new Error(
        `player ${String(company.ownerPlayerId)} is not served by this company layer`,
      );
    }
    return company;
  };

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
    // entity, then absorb the seeds into Branch status.
    const companyEid = spawnEntity(world!);
    setCompanyRow(world!, comps, companyEid, {
      ownerPlayerId: owner!,
      focusDomain: focus,
      name,
    });
    diagnostics.charters += 1;
    absorbBranches(seeds, companyEid, tick);
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

  // ---- M4-T3 oversight commands -------------------------------------------------

  const applySetApprovalMode = (
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    requireServedCompany(companyId);
    const mode = data.mode;
    if (
      typeof mode !== "number" ||
      !Number.isInteger(mode) ||
      (mode !== APPROVAL_ALWAYS_ASK && mode !== APPROVAL_AUTO_APPROVE)
    ) {
      throw new Error(
        "setApprovalMode mode must be 0 (always-ask) or 1 (auto-approve)",
      );
    }
    setApprovalModeRow(world!, comps, companyId, mode);
  };

  /** Ground-break shared by auto execution and player approval. */
  const executeExpansion = (
    companyEid: number,
    defId: string,
    tileX: number,
    tileY: number,
    rect: FootprintRect,
    tick: number,
    logKind: number,
  ): void => {
    spendTreasuryMilli(world!, comps, companyEid, expansionCostMilli(defId));
    const siteEid = spawnBuildingSite(world!, comps, defId, tileX, tileY, {
      playerId: companyRowOf(world!, comps, companyEid)!.ownerPlayerId,
    });
    // Branch status attaches at SITE birth: staffing/output both key
    // off the finished-Building row, so they wake exactly when the camp
    // completes — while oversight (seize/dissolve) works from day one.
    setBranchRow(world!, comps, siteEid, companyEid, tick);
    blockFootprintTiles(world!, rect);
    appendExpansionLog(world!, comps, companyEid, tick, logKind, tileX, tileY);
    if (logKind === EXPANSION_LOG_EXECUTED) diagnostics.autoExpansions += 1;
  };

  const applyApproveExpansion = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    requireServedCompany(companyId);
    const pending = pendingExpansionOf(world!, comps, companyId);
    if (pending === undefined) {
      throw new Error(`company ${String(companyId)} has no pending expansion`);
    }
    const owner = companyRowOf(world!, comps, companyId)!.ownerPlayerId;
    const check = validatePlacement(
      world!,
      comps,
      pending.defId,
      pending.tileX,
      pending.tileY,
      owner,
    );
    if (
      !check.ok ||
      !check.rect ||
      companyRowOf(world!, comps, companyId)!.treasuryMilli <
        expansionCostMilli(pending.defId)
    ) {
      // Lapsed while waiting: the world moved on under the proposal.
      // Clear quietly — a stale verdict must never kill the tick.
      setPendingExpansion(world!, comps, companyId, undefined);
      diagnostics.lapsedProposals += 1;
      return;
    }
    setPendingExpansion(world!, comps, companyId, undefined);
    executeExpansion(
      companyId,
      pending.defId,
      pending.tileX,
      pending.tileY,
      check.rect,
      tick,
      EXPANSION_LOG_APPROVED,
    );
    diagnostics.approvedExpansions += 1;
  };

  const applyRejectExpansion = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    requireServedCompany(companyId);
    if (pendingExpansionOf(world!, comps, companyId) === undefined) {
      throw new Error(`company ${String(companyId)} has no pending expansion`);
    }
    setPendingExpansion(world!, comps, companyId, undefined);
    appendExpansionLog(
      world!,
      comps,
      companyId,
      tick,
      EXPANSION_LOG_REJECTED,
      0,
      0,
    );
    diagnostics.rejectedProposals += 1;
  };

  const applySeizeBranch = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    const branchId = parsePositiveInt(data, "branchId");
    requireServedCompany(companyId);
    const branch = branchRowOf(world!, comps, branchId);
    if (branch === undefined || branch.companyEid !== companyId) {
      throw new Error(
        `entity ${String(branchId)} is not a Branch of company ${String(companyId)}`,
      );
    }
    // Staffing authority reverts to the player: the branch foreman post
    // dies with the seizure (the Pop returns to the labor pool).
    clearForemanRow(world!, comps, branchId);
    clearBranchRow(world!, comps, branchId);
    appendExpansionLog(
      world!,
      comps,
      companyId,
      tick,
      EXPANSION_LOG_SEIZED,
      branchId,
      0,
    );
    diagnostics.seizures += 1;
  };

  const applyDissolveCompany = (
    tick: number,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const companyId = parsePositiveInt(data, "companyId");
    requireServedCompany(companyId);
    const origin = companyOriginOf(world!, comps, companyId);
    if (
      origin !== undefined &&
      tick > origin.foundedTick + ORGANIC_DISSOLVE_GRACE_TICKS
    ) {
      // Organic company past its grace window: gold severance from the
      // OWNER'S stockpile (atomic — throws loudly when short).
      payCosts(
        world!,
        comps,
        companyRowOf(world!, comps, companyId)!.ownerPlayerId,
        { gold: ORGANIC_DISSOLVE_FEE_GOLD },
        `dissolving organic company ${String(companyId)} past its grace window`,
      );
    }
    // Pops/workplaces revert to direct ownership: Branch rows clear,
    // branch foremen posts die with them (their Pops return to the
    // labor pool), and despawning the company entity sweeps Company,
    // TreasuryDelta, ExpansionLog, PendingExpansion, ApprovalMode and
    // CompanyOrigin rows in one deterministic stroke.
    for (const [buildingEid, row] of [
      ...world!.rowsByComponentId.get(comps.branchId)!,
    ].sort((a, b) => a[0] - b[0])) {
      if (row[0] !== companyId) continue;
      clearForemanRow(world!, comps, buildingEid);
      clearBranchRow(world!, comps, buildingEid);
    }
    despawnEntity(world!, companyId);
    diagnostics.dissolutions += 1;
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

  // ---- Expansion pass (M4-T3) ---------------------------------------------------

  /** Live idle unlocked own Pops — the labor slack an expansion needs. */
  const idleLaborCount = (ownerId: number): number => {
    const lockRows = world!.rowsByComponentId.get(comps.orderLockId);
    const managerRows = world!.rowsByComponentId.get(comps.managerId);
    const jobRows = world!.rowsByComponentId.get(comps.productionJobId);
    const nodeRows = world!.rowsByComponentId.get(comps.assignedNodeId);
    const siteRows = world!.rowsByComponentId.get(comps.assignedSiteId);
    const foremanRows = world!.rowsByComponentId.get(comps.foremanId)!;
    const foremanPops = new Set<number>();
    for (const [, row] of foremanRows) foremanPops.add(row[0]!);
    let count = 0;
    for (const eid of world!.entities) {
      if (!isLiveNamedPop(eid)) continue;
      if (ownerOfUnit(world!, comps, eid) !== ownerId) continue;
      if (
        lifeStageOf(world!, comps, eid, lifecycleConfig) === LIFE_STAGE_CHILD
      ) {
        continue;
      }
      if (lockRows?.has(eid)) continue;
      if (managerRows?.has(eid)) continue;
      if (jobRows?.has(eid)) continue;
      if (nodeRows?.has(eid)) continue;
      if (siteRows?.has(eid)) continue;
      if (foremanPops.has(eid)) continue;
      count += 1;
    }
    return count;
  };

  /**
   * The company's branches (ascending building eid), finished or not.
   */
  const ownedBranchesOf = (companyEid: number): number[] => {
    const owned: number[] = [];
    for (const [buildingEid, row] of [
      ...world!.rowsByComponentId.get(comps.branchId)!,
    ].sort((a, b) => a[0] - b[0])) {
      if (row[0] === companyEid) owned.push(buildingEid);
    }
    return owned;
  };

  /**
   * Best unclaimed resource node in reach of the company's nearest
   * branch: live amount > 0, no finished building within the claim
   * radius, distance to nearest own branch ≤ reach. Ranking is
   * deterministic: most remaining amount, then nearest, then lowest
   * eid.
   */
  const bestUnclaimedNode = (
    branchIds: readonly number[],
  ): { eid: number; tileX: number; tileY: number } | undefined => {
    const posRows = world!.rowsByComponentId.get(comps.positionId)!;
    const nodeRows = world!.rowsByComponentId.get(comps.resourceNodeId)!;
    let best:
      | {
          eid: number;
          tileX: number;
          tileY: number;
          amount: number;
          distSq: number;
        }
      | undefined;
    const reachSq = EXPANSION_REACH_TILES ** 2;
    const claimSq = EXPANSION_CLAIM_RADIUS_TILES ** 2;
    for (const [eid, nodeRow] of nodeRows.entries()) {
      const amount = nodeRow[1] ?? 0;
      if (amount <= 0) continue; // dry node
      const pos = posRows.get(eid);
      if (!pos) continue;
      const nx = Math.floor(pos[0]!);
      const ny = Math.floor(pos[1]!);
      // Distance to the NEAREST own branch (finished or site).
      let nearestSq = Infinity;
      for (const branchEid of branchIds) {
        const rect = branchRectOf(world!, comps, branchEid);
        if (!rect) continue; // destroyed: rows died with the entity
        const bx = rect.x + rect.width / 2;
        const by = rect.y + rect.height / 2;
        const d2 = (bx - (nx + 0.5)) ** 2 + (by - (ny + 0.5)) ** 2;
        if (d2 < nearestSq) nearestSq = d2;
      }
      if (nearestSq > reachSq) continue;
      // Unclaimed = no building OR site already sitting on the node
      // (a rival foundation claims territory just like a finished camp).
      let claimed = false;
      for (const otherEid of world!.entities) {
        const otherRect =
          siteRectOf(world!, comps, otherEid) ??
          buildingRectOf(world!, comps, otherEid);
        if (!otherRect) continue;
        const ox = otherRect.x + otherRect.width / 2;
        const oy = otherRect.y + otherRect.height / 2;
        if ((ox - (nx + 0.5)) ** 2 + (oy - (ny + 0.5)) ** 2 <= claimSq) {
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
      const candidate = {
        eid,
        tileX: nx,
        tileY: ny,
        amount,
        distSq: nearestSq,
      };
      if (
        best === undefined ||
        candidate.amount > best.amount ||
        (candidate.amount === best.amount &&
          (candidate.distSq < best.distSq ||
            (candidate.distSq === best.distSq && candidate.eid < best.eid)))
      ) {
        best = candidate;
      }
    }
    return best === undefined
      ? undefined
      : { eid: best.eid, tileX: best.tileX, tileY: best.tileY };
  };

  /**
   * Site the expansion with the AI's own scorer: distance-sorted
   * candidates around the chosen node, first footprint passing the
   * SHARED placement validity function wins.
   */
  const siteExpansionNearNode = (
    defId: string,
    ownerId: number,
    nodeTileX: number,
    nodeTileY: number,
  ): { tileX: number; tileY: number; rect: FootprintRect } | undefined => {
    for (const slot of siteCandidates(
      nodeTileX,
      nodeTileY,
      EXPANSION_SITE_MIN_CLEARANCE,
      EXPANSION_SITE_MAX_RADIUS,
    )) {
      const check = validatePlacement(
        world!,
        comps,
        defId,
        slot.x,
        slot.y,
        ownerId,
      );
      if (check.ok && check.rect) {
        return { tileX: slot.x, tileY: slot.y, rect: check.rect };
      }
    }
    return undefined;
  };

  const runExpansionThink = (companyEid: number, tick: number): void => {
    const company = companyRowOf(world!, comps, companyEid);
    if (company === undefined) return;
    if (company.frozen) return; // freeze halts proposals, never accrual
    if (pendingExpansionOf(world!, comps, companyEid) !== undefined) return;
    const defId = expansionDefForDomain(company.focusDomain);
    const cost = expansionCostMilli(defId);
    if (
      company.treasuryMilli < EXPANSION_TREASURY_THRESHOLD_MILLI ||
      company.treasuryMilli < cost
    ) {
      return;
    }
    if (idleLaborCount(company.ownerPlayerId) < EXPANSION_LABOR_SLACK_MIN) {
      return;
    }
    const node = bestUnclaimedNode(ownedBranchesOf(companyEid));
    if (node === undefined) return;
    const spot = siteExpansionNearNode(
      defId,
      company.ownerPlayerId,
      node.tileX,
      node.tileY,
    );
    if (spot === undefined) return; // no valid ground this think
    if (approvalModeOf(world!, comps, companyEid) === APPROVAL_AUTO_APPROVE) {
      executeExpansion(
        companyEid,
        defId,
        spot.tileX,
        spot.tileY,
        spot.rect,
        tick,
        EXPANSION_LOG_EXECUTED,
      );
      return;
    }
    setPendingExpansion(world!, comps, companyEid, {
      defCode: buildingCodeOf(defId),
      tileX: spot.tileX,
      tileY: spot.tileY,
      proposedTick: tick,
    });
    diagnostics.proposalsFormed += 1;
  };

  // ---- Organic founding scan (M4-T3, daily) -------------------------------------

  /**
   * Directly-owned workplaces that turned output within PROFIT_LOOKBACK_
   * TICKS, keyed by domain then owner. Branches never count — organic
   * origins absorb DIRECT property only.
   */
  const profitableDirectWorkplacesByDomain = (
    tick: number,
  ): Map<number, Map<number, number[]>> => {
    const byDomain = new Map<number, Map<number, number[]>>();
    for (const [eid, buildingRow] of world!.rowsByComponentId
      .get(comps.buildingId)!
      .entries()) {
      const owner = buildingRow[0]!;
      if (!servedPlayer(owner)) continue;
      const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
      const domain = domainOfBuildingDef(def.id);
      if (domain === undefined) continue;
      if (branchRowOf(world!, comps, eid) !== undefined) continue;
      const lastTick = lastOutputTickByBuilding.get(eid);
      if (lastTick === undefined || tick - lastTick > PROFIT_LOOKBACK_TICKS) {
        continue;
      }
      let byOwner = byDomain.get(domain);
      if (!byOwner) {
        byOwner = new Map();
        byDomain.set(domain, byOwner);
      }
      const list = byOwner.get(owner);
      if (list) list.push(eid);
      else byOwner.set(owner, [eid]);
    }
    return byDomain;
  };

  /**
   * Best-rated eligible founder for one domain: named non-child own Pop
   * carrying no direct-order lock and no manager office, whose
   * managementRatingOf clears ORGANIC_FOUNDER_RATING_MIN. Ratings
   * descend; ties break to the lower eid. (Foremen MAY found — their
   * post dies with the absorb and the new company re-seats them.)
   */
  const bestOrganicFounder = (
    ownerId: number,
    domain: number,
  ): number | undefined => {
    const lockRows = world!.rowsByComponentId.get(comps.orderLockId);
    const managerRows = world!.rowsByComponentId.get(comps.managerId);
    let best: number | undefined;
    let bestRating = ORGANIC_FOUNDER_RATING_MIN;
    for (const eid of world!.entities) {
      if (!isLiveNamedPop(eid)) continue;
      if (ownerOfUnit(world!, comps, eid) !== ownerId) continue;
      if (
        lifeStageOf(world!, comps, eid, lifecycleConfig) === LIFE_STAGE_CHILD
      ) {
        continue;
      }
      if (lockRows?.has(eid)) continue;
      if (managerRows?.has(eid)) continue;
      const rating = managementRatingOf(world!, comps, eid, domain);
      if (rating >= bestRating) {
        bestRating = rating;
        best = eid;
      }
    }
    return best;
  };

  const runOrganicScan = (tick: number): void => {
    // Deterministic order: domain ascending, then owner ascending, then
    // workplace eids ascending inside the absorb list. At most ONE
    // spontaneous founding per scan, and a per-player cooldown keeps
    // serial founders from chaining day after day.
    const byDomain = profitableDirectWorkplacesByDomain(tick);
    const domains = [...byDomain.keys()].sort((a, b) => a - b);
    for (const domain of domains) {
      const byOwner = byDomain.get(domain)!;
      const owners = [...byOwner.keys()].sort((a, b) => a - b);
      for (const ownerId of owners) {
        const workplaces = byOwner.get(ownerId)!.sort((a, b) => a - b);
        if (workplaces.length < ORGANIC_MIN_PROFITABLE_WORKPLACES) continue;
        const cooldown = lastOrganicFoundingTick.get(ownerId);
        if (
          cooldown !== undefined &&
          tick - cooldown < ORGANIC_FOUNDING_COOLDOWN_TICKS
        ) {
          continue;
        }
        const founder = bestOrganicFounder(ownerId, domain);
        if (founder === undefined) continue;
        const name = organicCompanyName(
          popNameOf(world!, comps, founder) ?? "#",
        );
        const companyEid = spawnEntity(world!);
        setCompanyRow(world!, comps, companyEid, {
          ownerPlayerId: ownerId,
          focusDomain: domain,
          name,
        });
        setCompanyOrigin(world!, comps, companyEid, founder, tick);
        absorbBranches(workplaces, companyEid, tick);
        appendExpansionLog(
          world!,
          comps,
          companyEid,
          tick,
          EXPANSION_LOG_FOUNDED,
          workplaces.length,
          founder,
        );
        lastOrganicFoundingTick.set(ownerId, tick);
        diagnostics.organicFoundations += 1;
        return; // one spontaneous founding per scan
      }
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
          case "setApprovalMode":
            applySetApprovalMode(command.data);
            break;
          case "approveExpansion":
            applyApproveExpansion(tick, command.data);
            break;
          case "rejectExpansion":
            applyRejectExpansion(tick, command.data);
            break;
          case "seizeBranch":
            applySeizeBranch(tick, command.data);
            break;
          case "dissolveCompany":
            applyDissolveCompany(tick, command.data);
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

      // ---- 3) Staffing + expansion thinks at the staggered 1 Hz cadence.
      const companyRows = stepWorld.rowsByComponentId.get(comps.companyId)!;
      if (companyRows.size > 0) {
        for (const [companyEid] of [...companyRows].sort(
          (a, b) => a[0] - b[0],
        )) {
          if ((tick + companyEid) % COMPANY_STAFF_INTERVAL_TICKS !== 0) {
            continue;
          }
          runStaffingThink(companyEid, tick);
          runExpansionThink(companyEid, tick);
        }
      }

      // ---- 4) Organic founding scan once per simulated day.
      if (tick > 0 && tick % lifecycleConfig.dayTicks === 0) {
        runOrganicScan(tick);
      }
    },
  };
}

/**
 * Age advancement system — SPEC §2.11 / M2-T4.
 *
 * Per-player currentAge lives in the AgeState row (rank 1=dark …
 * 4=imperial); advancement follows the AoE2 shape: every advance is
 * researched AT THE TOWN CENTER (any finished production building —
 * M1 content has exactly the TC) via
 * `{kind:"researchAge", data:{techId?, siteEid?, playerId?}}`:
 *
 *   - costs (tech.costs) are ESCROWED at enqueue and researchTime
 *     counts down every tick from the command tick inclusive, so an
 *     advance enqueued at tick T completes exactly at T + researchTime;
 *   - completion promotes the player's AgeState rank and appends a
 *     digest-visible AgeAdvanced event row — the audio bus's age-up
 *     jingle hook (SPEC §2.10) reads that log instead of re-deriving;
 *   - AoE2 prerequisite buildings: Castle/Imperial additionally demand
 *     finished prior-age buildings standing (see
 *     AGE_BUILDING_PREREQS). Feudal needs only the TC.
 *
 * Gate enforcement (SPEC §3 ageGate): a definition is usable iff its
 * gate rank ≤ the owner's current rank. The shared verdict lives in
 * `isDefAgeUnlocked`; place/train/research handlers consult it and
 * record polite GateRejected rows instead of throwing when gated
 * content slips through (laggy clicks, AI probes) — replays see every
 * refusal. Worlds without any AgeState row predate the system and stay
 * fully unlocked, exactly like pre-M2-T3 commodity ledgers.
 */

import {
  AGE_DARK_RANK,
  appendAgeAdvancedEvent,
  appendGateRejection,
  clearAgeResearchRow,
  GATE_HANDLER_RESEARCH,
  getAgeResearchRow,
  ageRankOf,
  setAgeResearchRow,
  setPlayerAgeRank,
  type AgeComponents,
} from "../components/age";
import { getBuildingRow } from "../components/buildings";
import {
  markTechResearched,
  researchedTechCodesOf,
} from "../components/combat";
import type { SimComponents } from "../components";
import {
  buildingDefOf,
  buildingIdOfCode,
  techCodeOf,
  techDefOf,
  techIdOfCode,
} from "../../data/definitions";
import { AGE_RANK, type AgeName } from "../../data/schema";
import { PLAYER_ONE } from "../core/stockpile";
import { effectiveCosts, payCosts } from "./costs";
import { applyUnitUpgrade } from "./upgrades";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kind owned by this system. */
export const RESEARCH_AGE_KIND = "researchAge";
export const RESEARCH_TECH_KIND = "researchTech";

/**
 * Finished-building minimums per TARGET age rank (AoE2 shape: advancing
 * demands prior-age buildings standing). Feudal needs only the TC; the
 * castle/imperial sets name the military-support content available in
 * M2 — castle-age buildings arrive with later tickets and join here.
 */
export interface AgeBuildingPrereq {
  readonly minCount: number;
  readonly defIds: readonly string[];
}

/** Prerequisite table keyed by TARGET age rank (2=feudal … 4=imperial). */
export const AGE_BUILDING_PREREQS: Readonly<
  Partial<Record<number, AgeBuildingPrereq>>
> = {
  2: { minCount: 0, defIds: [] },
  3: {
    minCount: 2,
    defIds: ["archery-range", "barracks", "blacksmith", "stable"],
  },
  4: {
    minCount: 2,
    defIds: ["archery-range", "blacksmith", "stable", "watch-tower"],
  },
};

/** The age tech granting each successive rank (dark → feudal → …). */
const NEXT_AGE_TECH: Readonly<Record<number, string>> = {
  1: "feudal-age",
  2: "castle-age",
  3: "imperial-age",
};

/** Tech id advancing FROM `rank`, or undefined at the ladder top. */
export function nextAgeTechIdOf(rank: number): string | undefined {
  return NEXT_AGE_TECH[rank];
}

/**
 * True when `playerId` may enqueue its next advance right now: a rung
 * remains, no research is in flight on any of their production
 * buildings, and the AoE2 prerequisite buildings stand. Cost
 * affordability is deliberately NOT part of this verdict — callers
 * gate that separately via the tech's definition costs.
 */
export function canStartAgeAdvance(
  world: World,
  comps: SimComponents,
  playerId: number,
): boolean {
  const rank = currentAgeRankOf(world, comps, playerId);
  if (NEXT_AGE_TECH[rank] === undefined) return false;
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    if (!buildingDefOf(buildingIdOfCode(row[1]!)).trainQueue) continue;
    if (getAgeResearchRow(world, comps, eid)) return false;
  }
  const prereq = AGE_BUILDING_PREREQS[rank + 1];
  if (
    prereq &&
    countFinishedPrereqs(world, comps, playerId, prereq) < prereq.minCount
  ) {
    return false;
  }
  return true;
}

export interface AgeDiagnostics {
  /** researchAge commands applied (escrow paid, row opened). */
  commandsApplied: number;
  /** Advances completed (rank promoted + event appended). */
  advancesCompleted: number;
  /** Polite gate/prereq refusals across ALL handlers (rows appended). */
  gateRejections: number;
}

export function createAgeDiagnostics(): AgeDiagnostics {
  return { commandsApplied: 0, advancesCompleted: 0, gateRejections: 0 };
}

// ---- Shared gate verdict ------------------------------------------------------------

/**
 * True when `gate` is at or below the player's current rank. A player
 * with NO AgeState row predates the age system: everything unlocks
 * (lenient default, mirroring the pre-M2-T3 commodity ledger stance).
 */
export function isDefAgeUnlocked(
  world: World,
  comps: Pick<AgeComponents, "ageStateId">,
  playerId: number,
  gate: AgeName,
): boolean {
  const rank = ageRankOf(world, comps, playerId);
  return rank === undefined || AGE_RANK[gate] <= rank;
}

/** Human-readable age label per rank (HUD badge, toasts). */
const AGE_LABELS: Readonly<Record<number, string>> = {
  1: "Dark Age",
  2: "Feudal Age",
  3: "Castle Age",
  4: "Imperial Age",
};

/** Label for one rank; ranks outside the ladder render as their number. */
export function ageLabelOf(rank: number | undefined): string {
  if (rank === undefined) return AGE_LABELS[AGE_DARK_RANK]!;
  return AGE_LABELS[rank] ?? `Age ${String(rank)}`;
}

/** Current rank for gameplay reads; absent state counts as dark age. */
export function currentAgeRankOf(
  world: World,
  comps: Pick<AgeComponents, "ageStateId">,
  playerId: number,
): number {
  return ageRankOf(world, comps, playerId) ?? AGE_DARK_RANK;
}

// ---- Command application ---------------------------------------------------------

function parseResearchData(data: Readonly<Record<string, unknown>>): {
  techId: string | undefined;
  siteEid: number | undefined;
  playerId: number;
} {
  let techId: string | undefined;
  if (data.techId !== undefined) {
    if (typeof data.techId !== "string" || data.techId.length === 0) {
      throw new Error("researchAge techId must be a non-empty string");
    }
    techId = data.techId;
  }
  let siteEid: number | undefined;
  if (data.siteEid !== undefined) {
    if (
      typeof data.siteEid !== "number" ||
      !Number.isInteger(data.siteEid) ||
      data.siteEid < 1
    ) {
      throw new Error(
        `researchAge siteEid must be a positive integer, got ${String(data.siteEid)}`,
      );
    }
    siteEid = data.siteEid;
  }
  const rawPlayer = data.playerId ?? PLAYER_ONE;
  if (
    typeof rawPlayer !== "number" ||
    !Number.isInteger(rawPlayer) ||
    rawPlayer < 0
  ) {
    throw new Error("researchAge playerId must be a non-negative integer");
  }
  return { techId, siteEid, playerId: rawPlayer };
}

interface ResearchBuilding {
  readonly eid: number;
  readonly playerId: number;
}

function productionBuildingsOf(
  world: World,
  comps: SimComponents,
  playerId: number,
): ResearchBuilding[] {
  const out: ResearchBuilding[] = [];
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    if (!buildingDefOf(buildingIdOfCode(row[1]!)).trainQueue) continue;
    out.push({ eid, playerId });
  }
  // Ascending eid: the lowest-eid production building wins by default.
  return out;
}

function countFinishedPrereqs(
  world: World,
  comps: SimComponents,
  playerId: number,
  prereq: AgeBuildingPrereq,
): number {
  const wanted = new Set(prereq.defIds);
  let count = 0;
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    if (wanted.has(buildingIdOfCode(row[1]!))) count += 1;
  }
  return count;
}

function applyResearchCommand(
  world: World,
  comps: SimComponents,
  diagnostics: AgeDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseResearchData(data);
  const rank = currentAgeRankOf(world, comps, parsed.playerId);
  const techId =
    parsed.techId ??
    (() => {
      const next = NEXT_AGE_TECH[rank];
      if (!next) {
        throw new Error(
          `researchAge has no advance beyond rank ${String(rank)}`,
        );
      }
      return next;
    })();
  const tech = techDefOf(techId);
  if (tech.ageAdvance === undefined) {
    throw new Error(`researchAge targets age advances only: ${tech.id}`);
  }

  // Polite gate: the tech's own ageGate must equal the CURRENT rank —
  // you advance from exactly one age to the next, never skipping or
  // re-researching. Refusals ride the digest-visible rejection log.
  if (AGE_RANK[tech.ageGate] !== rank) {
    appendGateRejection(world, comps, parsed.playerId, {
      tick: world.tick,
      handler: GATE_HANDLER_RESEARCH,
      defCode: techCodeOf(tech.id),
    });
    diagnostics.gateRejections += 1;
    return;
  }

  // AoE2 prerequisite buildings (finished, owned).
  const prereq = AGE_BUILDING_PREREQS[tech.ageAdvance];
  if (
    prereq &&
    countFinishedPrereqs(world, comps, parsed.playerId, prereq) <
      prereq.minCount
  ) {
    appendGateRejection(world, comps, parsed.playerId, {
      tick: world.tick,
      handler: GATE_HANDLER_RESEARCH,
      defCode: techCodeOf(tech.id),
    });
    diagnostics.gateRejections += 1;
    return;
  }

  const buildings = productionBuildingsOf(world, comps, parsed.playerId);
  const target =
    parsed.siteEid !== undefined
      ? buildings.find((b) => b.eid === parsed.siteEid)
      : buildings[0];
  if (!target) {
    throw new Error(
      parsed.siteEid !== undefined
        ? `researchAge targets entity ${String(parsed.siteEid)}, which is not a finished production building`
        : "researchAge requires a finished production building (none exists)",
    );
  }
  if (getAgeResearchRow(world, comps, target.eid)) {
    throw new Error(
      `${buildingIdOfCode(getBuildingRow(world, comps, target.eid)![1]!)} is already researching`,
    );
  }

  // Escrow at enqueue (AoE2-faithful); throws loudly when broke.
  const costs = effectiveCosts(world, parsed.playerId, tech);
  payCosts(world, comps, parsed.playerId, costs, `researching ${tech.id}`);
  setAgeResearchRow(
    world,
    comps,
    target.eid,
    parsed.playerId,
    techCodeOf(tech.id),
    tech.researchTime,
  );
  diagnostics.commandsApplied += 1;
}

function parseResearchTechData(data: Readonly<Record<string, unknown>>): {
  techId: string;
  siteEid: number;
  playerId: number;
} {
  if (typeof data.techId !== "string" || data.techId.length === 0) {
    throw new Error("researchTech techId must be a non-empty string");
  }
  if (
    typeof data.siteEid !== "number" ||
    !Number.isInteger(data.siteEid) ||
    data.siteEid < 1
  ) {
    throw new Error(
      `researchTech siteEid must be a positive integer, got ${String(data.siteEid)}`,
    );
  }
  const rawPlayer = data.playerId ?? PLAYER_ONE;
  if (
    typeof rawPlayer !== "number" ||
    !Number.isInteger(rawPlayer) ||
    rawPlayer < 0
  ) {
    throw new Error("researchTech playerId must be a non-negative integer");
  }
  return { techId: data.techId, siteEid: data.siteEid, playerId: rawPlayer };
}

function applyResearchTechCommand(
  world: World,
  comps: SimComponents,
  diagnostics: AgeDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseResearchTechData(data);
  const tech = techDefOf(parsed.techId);
  const playerId = parsed.playerId;

  // Validate building host
  const buildingRow = getBuildingRow(world, comps, parsed.siteEid);
  if (!buildingRow) {
    throw new Error(
      `researchTech targets entity ${String(parsed.siteEid)}, which is not a finished building`,
    );
  }
  if (buildingRow[0] !== playerId) {
    throw new Error(
      `player ${String(playerId)} does not own building ${String(parsed.siteEid)}`,
    );
  }
  const buildingDef = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
  if (tech.buildingId !== undefined && tech.buildingId !== buildingDef.id) {
    throw new Error(
      `tech ${tech.id} must be researched at ${tech.buildingId}, not ${buildingDef.id}`,
    );
  }

  // Check if already researched
  const researched =
    comps.researchedTechsId !== undefined
      ? researchedTechCodesOf(world, comps, playerId)
      : [];
  if (researched.includes(techCodeOf(tech.id))) {
    throw new Error(
      `tech ${tech.id} is already researched by player ${String(playerId)}`,
    );
  }

  // Polite age gate check
  if (!isDefAgeUnlocked(world, comps, playerId, tech.ageGate)) {
    appendGateRejection(world, comps, playerId, {
      tick: world.tick,
      handler: GATE_HANDLER_RESEARCH,
      defCode: techCodeOf(tech.id),
    });
    diagnostics.gateRejections += 1;
    return;
  }

  // Polite prerequisite check
  for (const prereqId of tech.techPrereqs) {
    if (!researched.includes(techCodeOf(prereqId))) {
      appendGateRejection(world, comps, playerId, {
        tick: world.tick,
        handler: GATE_HANDLER_RESEARCH,
        defCode: techCodeOf(tech.id),
      });
      diagnostics.gateRejections += 1;
      return;
    }
  }

  // Check building already researching
  if (getAgeResearchRow(world, comps, parsed.siteEid)) {
    throw new Error(`${buildingDef.id} is already researching`);
  }

  // Escrow costs
  const costs = effectiveCosts(world, playerId, tech);
  payCosts(world, comps, playerId, costs, `researching ${tech.id}`);
  setAgeResearchRow(
    world,
    comps,
    parsed.siteEid,
    playerId,
    techCodeOf(tech.id),
    tech.researchTime,
  );
  diagnostics.commandsApplied += 1;
}

// ---- The system -----------------------------------------------------------------

/**
 * Build the age SimSystem. Register alongside training/production; the
 * countdown never pauses (AoE2 research ignores housing), so the only
 * stall is a demolished host building — frozen remainingTicks stay
 * digest-visible until damage/destruction arrives in M2-T7.
 */
export function createAgeSystem(
  comps: SimComponents,
  diagnostics: AgeDiagnostics = createAgeDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    // ---- 1) Commands consumed exactly on their target tick boundary.
    for (const command of commands) {
      if (command.kind === RESEARCH_AGE_KIND) {
        if (!command.data) throw new Error("researchAge requires command data");
        applyResearchCommand(world, comps, diagnostics, command.data);
      } else if (command.kind === RESEARCH_TECH_KIND) {
        if (!command.data)
          throw new Error("researchTech requires command data");
        applyResearchTechCommand(world, comps, diagnostics, command.data);
      }
    }

    // ---- 2) Advance research rows ascending eid inside step(). The
    // enqueue tick already counts as the first research tick (mirroring
    // training), so completion lands exactly on enqueue + researchTime.
    const researchRows = world.rowsByComponentId.get(comps.ageResearchId);
    if (!researchRows) throw new Error("unregistered AgeResearch component");

    for (const eid of [...researchRows.keys()].sort((a, b) => a - b)) {
      const row = researchRows.get(eid);
      if (!row) continue;
      if (!getBuildingRow(world, comps, eid)) continue; // host lost: freeze

      row[2] = row[2]! - 1;
      if (row[2]! > 0) continue;

      const playerId = row[0]!;
      const tech = techDefOf(techIdOfCode(row[1]!));
      clearAgeResearchRow(world, comps, eid);
      if (tech.ageAdvance !== undefined) {
        setPlayerAgeRank(world, comps, playerId, tech.ageAdvance!);
        appendAgeAdvancedEvent(world, comps, playerId, {
          tick: world.tick,
          ageRank: tech.ageAdvance!,
        });
      } else {
        if (comps.researchedTechsId !== undefined) {
          markTechResearched(world, comps, playerId, row[1]!);
        }
        if (tech.unitUpgrade !== undefined) {
          applyUnitUpgrade(
            world,
            comps,
            playerId,
            tech.unitUpgrade.fromUnitId,
            tech.unitUpgrade.toUnitId,
          );
        }
      }
      diagnostics.advancesCompleted += 1;
    }
  };
}

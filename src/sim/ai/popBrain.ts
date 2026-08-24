/**
 * IAUS pop job brain — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Infinite-Axis-Utility-System-style job selection for IDLE Pops at the
 * 1 Hz think interval (docs/research/pop-sim-sources.md — Dave Mark's
 * IAUS, the Guild-Wars-2-scale existence proof): every named Pop
 * re-evaluates its job exactly once per THINK_INTERVAL_TICKS,
 * hash-staggered by eid — `(tick + eid) % THINK_INTERVAL_TICKS === 0`
 * (the RimWorld ticker pattern) — so a 300-Pop town runs ~10 scorer
 * passes per tick and amortized cost stays far under the <1 ms budget
 * gate (tests/perf/popbrain-budget.test.ts).
 *
 * Candidates are the three M1–M3 labor surfaces, enumerated fresh each
 * think from digest-visible rows (no hidden tables):
 *   gather nodes      → `gather` command onto a live ResourceNode
 *   build sites       → `build` command onto an unfinished BuildingSite
 *   production slots  → `produce` command onto a recipe building
 * Every emission is a plain shared-inbox command — byte-for-byte the
 * player-order interface — so downstream systems cannot tell them apart.
 *
 * Scoring (utility, higher wins; strict `>` keeps the earliest candidate
 * on ties, and ascending-eid enumeration makes that deterministic):
 *   base 0.5 + relevant skill level ×0.05 (capped ±0.5) + work-speed
 *   trait pull ×0.5 + food-node hunger pull (needs feed considerations)
 *   − linear distance falloff over MAX_INTEREST_RADIUS_TILES − crowding
 *   penalty against the target's slot capacity.
 *
 * ANTI-THRASH (#48 "cooldown map", DFHack setJobCooldown prior art):
 * two layers. (1) Commitment — assigned Pops are not idle, so the brain
 * never reconsiders them until their chain ends; player orders replace
 * assignments outright and always win because ordered Pops are simply
 * invisible here. (2) Per-target cooldowns — taking a job stamps a
 * JobCooldown row ON THE TARGET (components/jobCooldown.ts), refusing
 * further brain assignments there for a kind-scaled window; targets on
 * cooldown are skipped before scoring ever runs.
 *
 * LIFECYCLE GATES (M3-T5): children NEVER score candidates (SPEC §2.3:
 * childhood cannot work/fight — player orders hitting a child actor are
 * dropped by the labor/combat handlers instead); elders score at
 * ELDER_UTILITY_MULT (light duties — they still pitch in when a job is
 * clearly best but idle far more readily than adults). Both gates read
 * the derived life stage (systems/lifecycle.ts) under the brain's
 * LifecycleConfig — compressed fixture clocks compress the gates too.
 *
 * LEISURE EXTENSION (M3-T7, SPEC §2.4): schedules still owns all clock
 * knowledge; this brain consumes it through an injected `leisureWindow`
 * predicate (systems/social isLeisureTime). While the window is open
 * every idle named Pop's think switches from work candidates to the
 * evening venue set (tavern/brothel/shrine/study/visit) scored by
 * social.leisureCandidatesFor with trait-weighted pulls — same utility
 * shape, same strict-`>` earliest-wins tiebreak. Winners submit a plain
 * `leisure` command and stamp a SELF JobCooldown through the next 05:00
 * wake, so one evening never books a Pop twice.
 */

import {
  buildingDefOf,
  buildingIdOfCode,
  recipesForBuilding,
} from "../../data/definitions";
import {
  RESOURCE_FOOD,
  WORK_SLOTS_PER_NODE,
  getInventory,
} from "../components/economy";
import { getAssignedNode, type SimComponents } from "../components";
import { getAssignedSite } from "../components/buildings";
import { getProductionJob } from "../components/production";
import { jobCooldownActive, stampJobCooldown } from "../components/jobCooldown";
import { needsRowOf } from "../components/needs";
import { ownerOfUnit } from "../components/owner";
import { canDebitLedgerSlugs } from "../core/stockpile";
import type { World, SimSystem } from "../core/world";
import { leisureCandidatesFor, type LeisureCandidate } from "../systems/social";
import { wakeTickFor } from "../systems/schedules";
import { skillLevelOf, workTraitMultOf } from "../systems/skills";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  LIFE_STAGE_CHILD,
  LIFE_STAGE_ELDER,
  lifeStageOf,
  type LifecycleConfig,
} from "../systems/lifecycle";

// ---- Documented tuning constants ---------------------------------------------

/** Think cadence: 1 Hz at the 30 Hz sim tick, staggered per entity. */
export const THINK_INTERVAL_TICKS = 30;

/** Cooldown windows per candidate kind (DFHack-style anti-thrash). */
export const NODE_COOLDOWN_TICKS = 150;
export const SITE_COOLDOWN_TICKS = 90;
export const PRODUCTION_COOLDOWN_TICKS = 150;

/** Distance falloff span in tiles; candidates beyond it score poorly. */
export const MAX_INTEREST_RADIUS_TILES = 40;

/**
 * Elder light-duty utility multiplier (M3-T5): past work age a Pop
 * still pitches in when a job clearly wins, but half-weighted scores
 * mean idleness beats marginal work far more often.
 */
export const ELDER_UTILITY_MULT = 0.5;

/** Builders one site absorbs before crowding bottoms out (M2 economy). */
const BUILDERS_PER_SITE = 2;

/** True when this Pop's staggered think window is due (pure function). */
export function brainThinkDue(
  tick: number,
  eid: number,
  interval: number = THINK_INTERVAL_TICKS,
): boolean {
  return (tick + eid) % interval === 0;
}

// ---- Diagnostics ------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface PopBrainDiagnostics {
  /** Think passes executed (staggered across Pops). */
  thinks: number;
  /** Thinks that found the Pop idle and scored candidates. */
  idleThinks: number;
  /** Idle thinks whose best candidate lost to nothing (stay idle). */
  nothingViable: number;
  /** Candidates skipped while their target sat on cooldown. */
  cooldownSkips: number;
  /** Idle thinks refused outright because the Pop is a child (M3-T5). */
  childSkips: number;
  /** Assignments emitted, by command kind. */
  gathers: number;
  builds: number;
  produces: number;
  /** Evening outings booked through the leisure extension (M3-T7). */
  leisures: number;
}

export function createPopBrainDiagnostics(): PopBrainDiagnostics {
  return {
    thinks: 0,
    idleThinks: 0,
    nothingViable: 0,
    cooldownSkips: 0,
    childSkips: 0,
    gathers: 0,
    builds: 0,
    produces: 0,
    leisures: 0,
  };
}

export interface PopBrainOptions {
  readonly comps: SimComponents;
  /**
   * Players whose Pops this brain serves. Undefined serves everyone;
   * the skirmish session wires [PLAYER_ONE] so the AI opponent keeps
   * its own planner stack (SPEC §2.8 layering).
   */
  readonly players?: readonly number[] | undefined;
  readonly diagnostics?: PopBrainDiagnostics | undefined;
  /**
   * Lifecycle timescale for the child/elder gates (M3-T5). Production
   * runs the canonical §2.4 clock; compressed fixtures pass their own.
   */
  readonly lifecycleConfig?: LifecycleConfig | undefined;
  /**
   * M3-T7: schedules' clock knowledge injected as a predicate — true
   * inside the post-work evening window (systems/social isLeisureTime).
   * While open, idle thinks score LEISURE candidates instead of work.
   * Undefined keeps the pre-M3-T7 all-hours work brain (legacy rosters).
   */
  readonly leisureWindow?: ((tick: number) => boolean) | undefined;
}

interface NodeCandidate {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  readonly resourceCode: number;
  readonly slots: number;
}
interface SiteCandidate {
  readonly eid: number;
  readonly ownerId: number;
  readonly x: number;
  readonly y: number;
}
interface ProductionCandidate {
  readonly eid: number;
  readonly ownerId: number;
  readonly x: number;
  readonly y: number;
  readonly slots: number;
}

interface BestPick {
  readonly score: number;
  readonly commandKind: "gather" | "build" | "produce";
  readonly targetEid: number;
  readonly data: Record<string, unknown>;
  readonly cooldownTicks: number;
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the IAUS pop-brain SimSystem. Register after the labor systems
 * and needs: it only reads assignment state and submits commands for
 * the NEXT tick boundary, so ordering within one tick is not load-
 * bearing — but running behind needs lets freshly-fed idles be read
 * with this tick's meters already settled.
 */
export function createPopBrainSystem(options: PopBrainOptions): SimSystem {
  const comps = options.comps;
  const players = options.players;
  const diagnostics = options.diagnostics ?? createPopBrainDiagnostics();
  const lifecycleConfig = options.lifecycleConfig ?? DEFAULT_LIFECYCLE_CONFIG;
  const leisureWindow = options.leisureWindow;

  return (world: World): void => {
    const tick = world.tick;
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    const identityRows = world.rowsByComponentId.get(comps.identityId);

    // ---- Per-tick candidate tables, built lazily on the first thinker
    // of this tick (quiet worlds never build them at all).
    let nodesMemo: NodeCandidate[] | undefined;
    let workersByNodeMemo: Map<number, number> | undefined;
    let sitesMemo: SiteCandidate[] | undefined;
    let buildersBySiteMemo: Map<number, number> | undefined;
    let productionMemo: ProductionCandidate[] | undefined;
    let craftersByBuildingMemo: Map<number, number> | undefined;

    const nodes = (): NodeCandidate[] => {
      if (nodesMemo) return nodesMemo;
      const out: NodeCandidate[] = [];
      const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
      if (posRows && nodeRows) {
        for (const eid of world.entities) {
          const row = nodeRows.get(eid);
          if (!row || row[1]! <= 0) continue; // depleted nodes vanish
          const pos = posRows.get(eid);
          if (!pos) continue;
          out.push({
            eid,
            x: pos[0]!,
            y: pos[1]!,
            resourceCode: row[0]!,
            slots: Math.max(1, Math.min(row[2]!, WORK_SLOTS_PER_NODE)),
          });
        }
      }
      nodesMemo = out;
      return out;
    };

    const workersByNode = (): Map<number, number> => {
      if (workersByNodeMemo) return workersByNodeMemo;
      const counts = new Map<number, number>();
      const assigned = world.rowsByComponentId.get(comps.assignedNodeId);
      if (assigned) {
        for (const row of assigned.values()) {
          const nodeEid = row[0]!;
          counts.set(nodeEid, (counts.get(nodeEid) ?? 0) + 1);
        }
      }
      workersByNodeMemo = counts;
      return counts;
    };

    const sites = (): SiteCandidate[] => {
      if (sitesMemo) return sitesMemo;
      const out: SiteCandidate[] = [];
      const siteRows = world.rowsByComponentId.get(comps.buildingSiteId);
      if (posRows && siteRows) {
        for (const eid of world.entities) {
          const row = siteRows.get(eid);
          if (!row) continue;
          const pos = posRows.get(eid);
          if (!pos) continue;
          out.push({ eid, ownerId: row[0]!, x: pos[0]!, y: pos[1]! });
        }
      }
      sitesMemo = out;
      return out;
    };

    const buildersBySite = (): Map<number, number> => {
      if (buildersBySiteMemo) return buildersBySiteMemo;
      const counts = new Map<number, number>();
      const assigned = world.rowsByComponentId.get(comps.assignedSiteId);
      if (assigned) {
        for (const value of assigned.values()) {
          const siteEid = value[0]!;
          counts.set(siteEid, (counts.get(siteEid) ?? 0) + 1);
        }
      }
      buildersBySiteMemo = counts;
      return counts;
    };

    const productionBuildings = (): ProductionCandidate[] => {
      if (productionMemo) return productionMemo;
      const out: ProductionCandidate[] = [];
      const buildingRows = world.rowsByComponentId.get(comps.buildingId);
      if (posRows && buildingRows) {
        for (const eid of world.entities) {
          const row = buildingRows.get(eid);
          if (!row) continue;
          const def = buildingDefOf(buildingIdOfCode(row[1]!));
          if (def.workSlots <= 0 || recipesForBuilding(def.id).length === 0) {
            continue;
          }
          const pos = posRows.get(eid);
          if (!pos) continue;
          out.push({
            eid,
            ownerId: row[0]!,
            x: pos[0]!,
            y: pos[1]!,
            slots: Math.max(1, def.workSlots),
          });
        }
      }
      productionMemo = out;
      return out;
    };

    const craftersByBuilding = (): Map<number, number> => {
      if (craftersByBuildingMemo) return craftersByBuildingMemo;
      const counts = new Map<number, number>();
      const jobs = world.rowsByComponentId.get(comps.productionJobId);
      if (jobs) {
        for (const row of jobs.values()) {
          const buildingEid = row[0]!;
          counts.set(buildingEid, (counts.get(buildingEid) ?? 0) + 1);
        }
      }
      craftersByBuildingMemo = counts;
      return counts;
    };

    /**
     * Utility shared shape across kinds — base, trait pull, distance
     * falloff, crowding — plus the caller's kind-specific bonuses.
     * Plain deterministic float math (IEEE-754 f64 digests hash these
     * decisions' INPUTS as rows; scores themselves stay ephemeral).
     */
    const utilityFor = (
      popEid: number,
      popX: number,
      popY: number,
      targetX: number,
      targetY: number,
      workers: number,
      capacity: number,
      bonus: number,
      mult: number = 1,
    ): number => {
      const dx = targetX - popX;
      const dy = targetY - popY;
      const distancePenalty =
        Math.sqrt(dx * dx + dy * dy) / MAX_INTEREST_RADIUS_TILES;
      const crowdingPenalty = 0.15 * (workers / capacity);
      const traitPull = (workTraitMultOf(world, comps, popEid) - 1) * 0.5;
      return (
        (0.5 + bonus + traitPull - distancePenalty - crowdingPenalty) * mult
      );
    };

    /** Skill-level bonus term, capped like its siblings. */
    const skillBonus = (popEid: number, slug: string): number =>
      Math.min(0.5, 0.05 * (skillLevelOf(world, comps, popEid, slug) ?? 0));

    const isOnCooldown = (targetEid: number): boolean => {
      if (jobCooldownActive(world, comps, targetEid, tick)) {
        diagnostics.cooldownSkips += 1;
        return true;
      }
      return false;
    };

    /** Score every candidate kind; keep the single best pick. */
    const bestPickFor = (
      popEid: number,
      popOwnerId: number,
      popX: number,
      popY: number,
      utilityMult: number,
    ): BestPick | undefined => {
      let best: BestPick | undefined;

      const consider = (pick: BestPick): void => {
        if (best === undefined || pick.score > best.score) best = pick;
      };

      const inventory = getInventory(world, comps, popEid);
      const carrying = inventory !== undefined && inventory.amount > 0;
      const needsRow = needsRowOf(world, comps, popEid);
      const hunger =
        needsRow !== undefined
          ? 1 - Math.min(Math.max(needsRow[0]!, 0), 100) / 100
          : 0;

      for (const node of nodes()) {
        if (isOnCooldown(node.eid)) continue;
        if (carrying && inventory!.resourceCode !== node.resourceCode) {
          continue; // one cargo kind at a time (AoE2 rule)
        }
        const workers = workersByNode().get(node.eid) ?? 0;
        if (workers >= node.slots) continue;
        const foodPull = node.resourceCode === RESOURCE_FOOD ? hunger * 0.6 : 0;
        const score = utilityFor(
          popEid,
          popX,
          popY,
          node.x,
          node.y,
          workers,
          node.slots,
          foodPull + skillBonus(popEid, "gathering"),
          utilityMult,
        );
        consider({
          score,
          commandKind: "gather",
          targetEid: node.eid,
          data: { entityIds: [popEid], nodeId: node.eid },
          cooldownTicks: NODE_COOLDOWN_TICKS,
        });
      }

      for (const site of sites()) {
        if (site.ownerId !== popOwnerId) continue;
        if (isOnCooldown(site.eid)) continue;
        const builders = buildersBySite().get(site.eid) ?? 0;
        if (builders >= BUILDERS_PER_SITE) continue;
        const score = utilityFor(
          popEid,
          popX,
          popY,
          site.x,
          site.y,
          builders,
          BUILDERS_PER_SITE,
          skillBonus(popEid, "construction"),
          utilityMult,
        );
        consider({
          score,
          commandKind: "build",
          targetEid: site.eid,
          data: { entityIds: [popEid], siteEid: site.eid },
          cooldownTicks: SITE_COOLDOWN_TICKS,
        });
      }

      for (const building of productionBuildings()) {
        if (building.ownerId !== popOwnerId) continue;
        if (isOnCooldown(building.eid)) continue;
        const crafters = craftersByBuilding().get(building.eid) ?? 0;
        if (crafters >= building.slots) continue;
        const buildingRow = world.rowsByComponentId
          .get(comps.buildingId)
          ?.get(building.eid);
        if (!buildingRow) continue;
        const recipe = recipesForBuilding(
          buildingDefOf(buildingIdOfCode(buildingRow[1]!)).id,
        )[0];
        if (!recipe) continue;
        if (
          !canDebitLedgerSlugs(world, comps, building.ownerId, recipe.inputs)
        ) {
          // Unaffordable lines stall politely inside the production
          // system anyway; don't burn a cooldown discovering it twice.
          continue;
        }
        const score = utilityFor(
          popEid,
          popX,
          popY,
          building.x,
          building.y,
          crafters,
          building.slots,
          0,
          utilityMult,
        );
        consider({
          score,
          commandKind: "produce",
          targetEid: building.eid,
          data: { entityIds: [popEid], buildingEid: building.eid },
          cooldownTicks: PRODUCTION_COOLDOWN_TICKS,
        });
      }

      return best;
    };

    // ---- Thinker pass, ascending eid --------------------------------
    for (const eid of world.entities) {
      if (!tagRows?.has(eid)) continue; // units only
      if (!identityRows?.has(eid)) continue; // named Pops only (never military)
      if (!brainThinkDue(tick, eid)) continue;
      diagnostics.thinks += 1;

      if (
        players !== undefined &&
        !players.includes(ownerOfUnit(world, comps, eid))
      ) {
        continue;
      }

      // Commitment layer: any live assignment or queued activity means
      // somebody (player order included) owns this Pop — hands off.
      const employed =
        getAssignedNode(world, comps, eid) !== undefined ||
        getAssignedSite(world, comps, eid) !== undefined ||
        getProductionJob(world, comps, eid) !== undefined;
      const queueLength =
        world.rowsByComponentId.get(comps.activityQueueId)?.get(eid)?.[0] ?? 0;
      if (employed || queueLength > 0) continue;

      const pos = posRows?.get(eid);
      if (!pos) continue;
      // M3-T5 lifecycle gate: children never self-assign (they attend
      // school when one stands); elders work at half-weight (light
      // duties). Stage derives from digest-visible Identity rows.
      const stage = lifeStageOf(world, comps, eid, lifecycleConfig);
      if (stage === LIFE_STAGE_CHILD) {
        diagnostics.childSkips += 1;
        continue;
      }
      const utilityMult = stage === LIFE_STAGE_ELDER ? ELDER_UTILITY_MULT : 1;
      diagnostics.idleThinks += 1;

      // M3-T7 leisure extension: while the evening window is open the
      // think switches to venue scoring — work candidates stay closed
      // (schedules released this Pop; §2.4 evenings are not for labor).
      if (leisureWindow !== undefined && leisureWindow(tick)) {
        const candidates = leisureCandidatesFor(
          world,
          comps,
          eid,
          tick,
          lifecycleConfig,
          utilityMult,
        );
        let best: LeisureCandidate | undefined;
        for (const candidate of candidates) {
          if (best === undefined || candidate.score > best.score) {
            best = candidate;
          }
        }
        if (best === undefined) {
          diagnostics.nothingViable += 1;
          continue;
        }
        stampJobCooldown(world, comps, eid, wakeTickFor(tick, lifecycleConfig));
        world.inbox.submit({
          kind: "leisure",
          targetTick: tick + 1,
          data: {
            entityIds: [eid],
            venueCode: best.venueCode,
            targetEid: best.targetEid,
            x: best.x,
            y: best.y,
          },
        });
        diagnostics.leisures += 1;
        continue;
      }

      const best = bestPickFor(
        eid,
        ownerOfUnit(world, comps, eid),
        pos[0]!,
        pos[1]!,
        utilityMult,
      );
      if (best === undefined) {
        diagnostics.nothingViable += 1;
        continue;
      }
      stampJobCooldown(world, comps, best.targetEid, tick + best.cooldownTicks);
      world.inbox.submit({
        kind: best.commandKind,
        targetTick: tick + 1,
        data: best.data,
      });
      if (best.commandKind === "gather") diagnostics.gathers += 1;
      else if (best.commandKind === "build") diagnostics.builds += 1;
      else diagnostics.produces += 1;
    }
  };
}

/**
 * AI knowledge seam — SPEC §2.8 "fog honesty, structural" / M2-T9.
 *
 * The build-order and economy layers NEVER see the World. They receive
 * an {@link AiKnowledge}: a read-only query surface whose enemy half is
 * literally the fog system's {@link KnowledgeView} for the AI's own fog
 * planes (wallhacks are impossible — no API exists to ask), and whose
 * self half reads only rows the AI player owns (a player always knows
 * its own stockpile, queues and ladder rung).
 *
 * The type-level guarantee the issue asks for lives here: AI modules
 * take `AiKnowledge`, which exposes zero mutating methods and zero raw
 * row access, so "the AI never mutates sim state directly" is enforced
 * by construction rather than by review. Commands leave the AI as plain
 * descriptors (see planner.ts) and enter the shared inbox exactly like
 * player clicks.
 */

import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import type { CostLedger } from "../systems/costs";
import { canAffordCosts } from "../systems/costs";
import { canEnqueueTraining } from "../systems/training";
import {
  canStartAgeAdvance as canStartAgeAdvanceSystem,
  currentAgeRankOf,
  nextAgeTechIdOf,
} from "../systems/age";
import { AGE_DARK_RANK, ageRankOf } from "../components/age";
import { getAssignedNode, getInventory } from "../components/economy";
import {
  getAssignedSite,
  populationCapOf,
  populationOf,
  readTrainQueue,
} from "../components/buildings";
import { stockpileAmountsOf } from "../core/stockpile";
import {
  validatePlacement,
  type PlacementRejection,
} from "../systems/placement";
import type { KnowledgeView } from "../systems/fog";
import { RESOURCE_SLUGS } from "../../data/schema";
import {
  carriedRelicOf as carriedRelicOfComp,
  relicsOf,
  RELIC_GROUND,
} from "../components/relic";
import { buildingDefsForVictoryPath } from "../../data/victoryRoles";
import type { SimComponents } from "../components";
import type { World } from "../core/world";

/** The M2 skirmish AI sits at player slot 1 (human is PLAYER_ONE = 0). */
export const AI_PLAYER = 1;

/** One gatherable node the AI legitimately knows about. */
export interface KnownNode {
  readonly eid: number;
  /** Gatherable resource code (see components/economy). */
  readonly resourceCode: number;
  readonly tileX: number;
  readonly tileY: number;
  /** Units still extractable — dry nodes never surface here. */
  readonly remaining: number;
}

/** Where one of the AI's workers currently is, job-wise. */
export type WorkerAssignment =
  | { readonly kind: "node"; readonly eid: number }
  | { readonly kind: "site"; readonly eid: number };

export interface AiKnowledge {
  /** The AI player slot all queries are filtered to. */
  readonly player: number;
  /** Fog-curated view over the AI's explored/visible planes ONLY. */
  readonly view: KnowledgeView;
  tick(): number;
  // ---- Self state (own rows only) ---------------------------------------
  /** Held amounts indexed by resource code. */
  resources(): readonly number[];
  ageRank(): number;
  /** Tech advancing from the current rung, or undefined at the top. */
  nextAgeTechId(): string | undefined;
  /** No rung left, research already running, or prereqs missing. */
  canStartAgeAdvance(): boolean;
  finishedBuildings(defId?: string | undefined): number[];
  /**
   * Footprint-origin tile of one OWN finished building (undefined when
   * the eid is not one). Placement offsets key off this.
   */
  ownBuildingOrigin(eid: number): { x: number; y: number } | undefined;
  unfinishedSites(): readonly {
    eid: number;
    defId: string;
    tileX: number;
    tileY: number;
  }[];
  buildersOn(siteEid: number): number[];
  /** Queued unitIds (entry 0 in progress) on one OWN production building. */
  trainQueueOf(buildingEid: number): readonly string[];
  /** Unit definitions one OWN production building may train. */
  trainableUnitIds(buildingEid: number): readonly string[];
  population(): number;
  populationCap(): number;
  // ---- Own units ----------------------------------------------------------
  villagerEids(): readonly number[];
  armyUnits(): readonly {
    eid: number;
    defId: string;
    tileX: number;
    tileY: number;
  }[];
  assignmentOf(eid: number): WorkerAssignment | undefined;
  carryOf(eid: number): { resourceCode: number; amount: number } | undefined;
  /** Known tile of one OWN unit (undefined when not ours/alive). */
  ownUnitTile(eid: number): { x: number; y: number } | undefined;
  /**
   * OWN finished buildings sitting below their definition's max hp
   * (M4-T6 defense probe — a player always knows its own damage).
   */
  damagedOwnBuildings(): readonly {
    eid: number;
    defId: string;
    tileX: number;
    tileY: number;
  }[];
  // ---- World knowledge (fog-gated) -----------------------------------------
  /** Explored-or-visible nodes with remaining>0, optionally per resource. */
  knownNodes(resourceCode?: number | undefined): readonly KnownNode[];
  workersOnNode(nodeEid: number): number;
  /** Enemy entities currently inside AI vision (never ghosts/hidden). */
  visibleEnemies(): readonly {
    eid: number;
    defId: string;
    tileX: number;
    tileY: number;
  }[];
  /**
   * Enemy villagers currently inside AI vision (M4-T6 raid-density
   * probe). Villagers are untargetable, so they never appear in
   * {@link visibleEnemies} — but their positions are exactly what
   * "raid where the workers are" scoring needs.
   */
  visibleEnemyVillagers(): readonly {
    eid: number;
    tileX: number;
    tileY: number;
  }[];
  // ---- Relic queries (fog-honest: ground relics are visible world fixtures) --
  /**
   * All grounded relics currently on the map — position-only, no fog
   * gate (relics are neutral map fixtures visible to everyone, like nodes).
   */
  knownGroundRelics(): readonly { eid: number; tileX: number; tileY: number }[];
  /** Own finished Monastery-role buildings. */
  ownMonasteries(): readonly { eid: number; tileX: number; tileY: number }[];
  /** The relic eid currently being carried by one of our monks, or undefined. */
  carriedRelicOf(unitEid: number): number | undefined;
  // ---- Command pre-flight mirrors (keep handlers throw-free) ---------------
  canAfford(costs: CostLedger): boolean;
  canPlace(defId: string, tileX: number, tileY: number): boolean;
  placementBlockReason(
    defId: string,
    tileX: number,
    tileY: number,
  ): PlacementRejection | undefined;
  canTrain(buildingEid: number, unitId?: string | undefined): boolean;
}

export interface AiKnowledgeDeps {
  readonly world: World;
  readonly comps: SimComponents;
  /** The real fog handle (knowledgeFor supplies the plane-gated view). */
  readonly view: KnowledgeView;
  readonly player?: number | undefined;
}

/**
 * Bind the read-only query surface to a world. The captured world/comps
 * stay private to these closures — callers hold `AiKnowledge`, which
 * cannot reach them.
 */
export function createAiKnowledge(deps: AiKnowledgeDeps): AiKnowledge {
  const { world, comps } = deps;
  const player = deps.player ?? AI_PLAYER;
  const view = deps.view;

  // ---- Per-tick memo ----------------------------------------------------------
  // Planning passes issue the same queries many times (villager roster,
  // node tables). The planner runs at tick end after all systems, so
  // everything observed is stable within one tick — cache against the
  // tick and drop it the moment the world moves on. Pure reads only.
  let memoTick = -1;
  let memoKnown:
    | readonly {
        eid: number;
        defId: string;
        tileX: number;
        tileY: number;
        owner: number;
      }[]
    | undefined;
  let memoVillagers: readonly number[] | undefined;
  const memoNodes = new Map<number, readonly KnownNode[]>();

  const refreshMemo = (): void => {
    if (memoTick === world.tick) return;
    memoTick = world.tick;
    memoKnown = undefined;
    memoVillagers = undefined;
    memoNodes.clear();
  };

  const ownBuildings = (): { eid: number; defId: string }[] => {
    const out: { eid: number; defId: string }[] = [];
    for (const [eid, row] of world.rowsByComponentId.get(comps.buildingId) ??
      new Map()) {
      if (row[0] !== player) continue;
      out.push({ eid, defId: buildingIdOfCode(row[1]!) });
    }
    return out;
  };

  const ownVillagers = (): readonly number[] => {
    refreshMemo();
    if (memoVillagers !== undefined) return memoVillagers;
    const out: number[] = [];
    for (const entity of knownEntities()) {
      if (entity.owner === player && entity.defId === "villager") {
        out.push(entity.eid);
      }
    }
    memoVillagers = out.sort((a, b) => a - b);
    return memoVillagers;
  };

  const knownEntities = () => {
    refreshMemo();
    if (memoKnown === undefined) memoKnown = view.knownEntities();
    return memoKnown;
  };

  return {
    player,
    view,
    tick: () => world.tick,

    resources: () => stockpileAmountsOf(world, comps, player),

    ageRank: () => ageRankOf(world, comps, player) ?? AGE_DARK_RANK,

    nextAgeTechId: () =>
      nextAgeTechIdOf(currentAgeRankOf(world, comps, player)),

    canStartAgeAdvance: () => canStartAgeAdvanceSystem(world, comps, player),

    finishedBuildings(defId) {
      const all = ownBuildings();
      return all
        .filter((b) => defId === undefined || b.defId === defId)
        .map((b) => b.eid)
        .sort((a, b) => a - b);
    },

    ownBuildingOrigin(eid) {
      const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
      if (!row || row[0] !== player) return undefined;
      const def = buildingDefOf(buildingIdOfCode(row[1]!));
      const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      if (!pos) return undefined;
      return {
        x: Math.floor(pos[0]! - def.footprint.width / 2),
        y: Math.floor(pos[1]! - def.footprint.height / 2),
      };
    },

    unfinishedSites() {
      const out: {
        eid: number;
        defId: string;
        tileX: number;
        tileY: number;
      }[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(
        comps.buildingSiteId,
      ) ?? new Map()) {
        if (row[0] !== player) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        out.push({
          eid,
          defId: buildingIdOfCode(row[1]!),
          tileX: Math.floor(pos?.[0] ?? 0),
          tileY: Math.floor(pos?.[1] ?? 0),
        });
      }
      return out.sort((a, b) => a.eid - b.eid);
    },

    buildersOn(siteEid) {
      const out: number[] = [];
      for (const eid of ownVillagers()) {
        const site = getAssignedSite(world, comps, eid);
        if (site === siteEid) out.push(eid);
      }
      return out;
    },

    trainQueueOf(buildingEid) {
      return readTrainQueue(world, comps, buildingEid).map((entry) =>
        unitIdOfCode(entry.unitCode),
      );
    },

    trainableUnitIds(buildingEid) {
      const row = world.rowsByComponentId
        .get(comps.buildingId)
        ?.get(buildingEid);
      if (!row || row[0] !== player) return [];
      return (
        buildingDefOf(buildingIdOfCode(row[1]!)).trainQueue?.trainable.map(
          (entry) => entry.unitId,
        ) ?? []
      );
    },

    population: () => populationOf(world, comps, player),
    populationCap: () => populationCapOf(world, comps, player),

    villagerEids: ownVillagers,

    armyUnits() {
      const out: {
        eid: number;
        defId: string;
        tileX: number;
        tileY: number;
      }[] = [];
      for (const entity of knownEntities()) {
        if (entity.owner !== player) continue;
        // Buildings ride the same knownEntities stream; army units are
        // exactly the own non-villager unit definitions.
        if (!isUnitDef(entity.defId) || entity.defId === "villager") continue;
        out.push(entity);
      }
      return out.sort((a, b) => a.eid - b.eid);
    },

    assignmentOf(eid) {
      const node = getAssignedNode(world, comps, eid);
      if (node) return { kind: "node", eid: node.nodeEid };
      const site = getAssignedSite(world, comps, eid);
      if (site !== undefined) return { kind: "site", eid: site };
      return undefined;
    },

    carryOf(eid) {
      return getInventory(world, comps, eid);
    },

    ownUnitTile(eid) {
      const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      if (!pos) return undefined;
      return { x: Math.floor(pos[0]!), y: Math.floor(pos[1]!) };
    },

    damagedOwnBuildings() {
      const out: {
        eid: number;
        defId: string;
        tileX: number;
        tileY: number;
      }[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(comps.buildingId) ??
        new Map()) {
        if (row[0] !== player) continue;
        const def = buildingDefOf(buildingIdOfCode(row[1]!));
        if (row[4]! >= def.hp) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        out.push({
          eid,
          defId: def.id,
          tileX: Math.floor(pos[0]!),
          tileY: Math.floor(pos[1]!),
        });
      }
      return out.sort((a, b) => a.eid - b.eid);
    },

    knownNodes(resourceCode) {
      refreshMemo();
      const cached = memoNodes.get(resourceCode ?? -1);
      if (cached !== undefined) return cached;
      const out: KnownNode[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(
        comps.resourceNodeId,
      ) ?? new Map()) {
        const remaining = row[1]!;
        if (remaining <= 0) continue;
        const code = row[0]!;
        if (resourceCode !== undefined && code !== resourceCode) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        const tileX = Math.floor(pos[0]!);
        const tileY = Math.floor(pos[1]!);
        // Fog honesty: a node outside the AI's explored planes does not
        // exist for planning purposes — same gate placement uses.
        if (!view.isExplored(tileX, tileY) && !view.isVisible(tileX, tileY)) {
          continue;
        }
        out.push({ eid, resourceCode: code, tileX, tileY, remaining });
      }
      const sorted = out.sort((a, b) => a.eid - b.eid);
      memoNodes.set(resourceCode ?? -1, sorted);
      return sorted;
    },

    workersOnNode(nodeEid) {
      let count = 0;
      for (const eid of ownVillagers()) {
        const assignment = getAssignedNode(world, comps, eid);
        if (assignment && assignment.nodeEid === nodeEid) count += 1;
      }
      return count;
    },

    visibleEnemies() {
      const out: {
        eid: number;
        defId: string;
        tileX: number;
        tileY: number;
      }[] = [];
      for (const entity of knownEntities()) {
        if (entity.owner === player) continue;
        // Targetable entities only: villagers carry no Combat row and
        // are untargetable per the M2-T5 contract, so an attack draft
        // naming one would be rejected loudly at application. Military
        // units AND structures stay legitimate strike targets.
        if (entity.defId === "villager") continue;
        out.push(entity);
      }
      return out;
    },

    visibleEnemyVillagers() {
      const out: { eid: number; tileX: number; tileY: number }[] = [];
      for (const entity of knownEntities()) {
        if (entity.owner === player) continue;
        if (entity.defId !== "villager") continue;
        out.push({
          eid: entity.eid,
          tileX: entity.tileX,
          tileY: entity.tileY,
        });
      }
      return out;
    },

    knownGroundRelics() {
      // Relics are neutral map fixtures — no fog gate needed.
      const out: { eid: number; tileX: number; tileY: number }[] = [];
      if (!comps.relicId) return out;
      for (const { eid, row } of relicsOf(world, comps as Parameters<typeof relicsOf>[1])) {
        if (row.state !== RELIC_GROUND) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        out.push({ eid, tileX: Math.floor(pos[0]!), tileY: Math.floor(pos[1]!) });
      }
      return out;
    },

    ownMonasteries() {
      const monasteryDefIds = buildingDefsForVictoryPath("relic")
        .filter((def) => def.victory?.holdTicks !== undefined)
        .map((def) => def.id);
      const out: { eid: number; tileX: number; tileY: number }[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(comps.buildingId) ?? new Map()) {
        if (row[0] !== player) continue;
        const defId = buildingIdOfCode(row[1]!);
        if (!monasteryDefIds.includes(defId)) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        out.push({ eid, tileX: Math.floor(pos[0]!), tileY: Math.floor(pos[1]!) });
      }
      return out.sort((a, b) => a.eid - b.eid);
    },

    carriedRelicOf(unitEid) {
      if (!comps.relicId) return undefined;
      return carriedRelicOfComp(world, comps as Parameters<typeof carriedRelicOfComp>[1], unitEid);
    },

    canAfford: (costs) => canAffordCosts(world, comps, player, costs),

    canPlace: (defId, tileX, tileY) =>
      validatePlacement(world, comps, defId, tileX, tileY, player).ok,

    placementBlockReason: (defId, tileX, tileY) =>
      validatePlacement(world, comps, defId, tileX, tileY, player).reason,

    canTrain: (buildingEid, unitId) =>
      canEnqueueTraining(world, comps, buildingEid, player, unitId),
  };
}

function isUnitDef(defId: string): boolean {
  try {
    unitDefOf(defId);
    return true;
  } catch {
    return false;
  }
}

// ---- Planning-time resource budget ---------------------------------------------

export interface ResourceBudget {
  /** Held amounts minus every debit committed this planning pass. */
  readonly available: () => readonly number[];
  afford: (costs: CostLedger) => boolean;
  debit: (costs: CostLedger) => void;
}

/**
 * A projection of the stockpile used WITHIN one planning pass so several
 * emitters (build order + economy manager) drawing the same bank at the
 * same execution tick can never collectively overdraft it — the sim's
 * atomic payCosts would otherwise throw on the second command. Pure
 * planning state: nothing here touches component rows.
 */
export function createResourceBudget(knowledge: AiKnowledge): ResourceBudget {
  const credit = [...knowledge.resources()];
  const codeOfSlug = (slug: string): number => {
    const index = RESOURCE_SLUGS.indexOf(
      slug as (typeof RESOURCE_SLUGS)[number],
    );
    if (index < 0)
      throw new Error(`unknown resource slug: ${JSON.stringify(slug)}`);
    return index;
  };
  return {
    available: () => credit,
    afford(costs) {
      for (const [slug, amount] of Object.entries(costs)) {
        if (amount <= 0) continue;
        if (credit[codeOfSlug(slug)]! < amount) return false;
      }
      return true;
    },
    debit(costs) {
      for (const [slug, amount] of Object.entries(costs)) {
        if (amount <= 0) continue;
        credit[codeOfSlug(slug)]! -= amount;
      }
    },
  };
}

export interface SpotReservation {
  isReserved: (
    tileX: number,
    tileY: number,
    width: number,
    height: number,
  ) => boolean;
  reserve: (
    tileX: number,
    tileY: number,
    width: number,
    height: number,
  ) => void;
}

/**
 * Footprints claimed by drafts already emitted THIS pass. Placement
 * sites only materialize at the next tick boundary, so two same-pass
 * emissions would otherwise validate against the same free ground and
 * the loser would throw "occupied" on execution. Claims are recorded
 * per TILE over each candidate's whole footprint and are
 * definition-independent — a house draft must block a barracks draft
 * that overlaps it, not merely another house at the same origin.
 */
export function createSpotReservation(): SpotReservation {
  const reserved = new Set<string>();
  const key = (x: number, y: number): string => `${String(x)}:${String(y)}`;
  return {
    isReserved: (tileX, tileY, width, height) => {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          if (reserved.has(key(tileX + dx, tileY + dy))) return true;
        }
      }
      return false;
    },
    reserve: (tileX, tileY, width, height) => {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          void reserved.add(key(tileX + dx, tileY + dy));
        }
      }
    },
  };
}

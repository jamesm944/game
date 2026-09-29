/**
 * Building component definitions — SPEC §2.6/§3 / M1-T10.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - AssignedSite (1): [siteEid] — mirrors AssignedNode; one builder's
 *   live construction assignment.
 * - Building (5): [ownerPlayerId, defCode, originTileX, originTileY,
 *   hp] — attached to FINISHED buildings only. The Position row holds
 *   the footprint center, so origin + definition recover every covered
 *   tile exactly (centers sit on .0/.5 coordinates by construction).
 *   defCode is the stable numeric code from data/definitions.ts — rows
 *   never carry slugs. hp starts at the site's carried damage state and
 *   is decremented by the combat system (M2-T7); at 0 the structure is
 *   destroyed into a rubble-state entity.
 * - BuildingSite (4): [ownerPlayerId, defCode, progressMilliTicks,
 *   hp] — construction-in-progress living on the SAME entity id that
 *   later carries the finished Building row (references survive
 *   completion). Progress is fixed-point thousandths of one builder-
 *   work tick so multi-builder accumulation stays exact integer math
 *   (platform float-drift proof, SPEC §9). Sites are attackable from
 *   day one (M2-T7): they start at full definition hp; completion
 *   carries whatever damage state the foundation holds forward.
 * - TrainQueue (variable): [entryCount, unitCode₀, remainingTicks₀,
 *   unitCode₁, remainingTicks₁, …]. Entry 0 is the unit in progress;
 *   the rest wait FIFO. Remaining ticks freeze while the population
 *   cap blocks production (AoE2 housed behavior).
 * - Rubble (4): [originTileX, originTileY, widthTiles, heightTiles] —
 *   destruction residue (M2-T7) on its OWN entity spawned where a
 *   building/site died, after every functional row has been torn down.
 *   Pure render/economy marker state today; M4 rebuild orders will read
 *   it to offer footprints-for-repair.
 *
 * A construction site BLOCKS its footprint tiles from placement day
 * one (AoE2-faithful): passability mutation + version bump live in
 * systems/placement.ts, NOT here, and completion performs no further
 * bump because passability does not change when a site finishes.
 */

import {
  buildingCodeOf,
  buildingDefOf,
  buildingIdOfCode,
} from "../../data/definitions";
import { RESOURCE_SLUGS } from "../../data/schema";
import { RESOURCE_FOOD } from "./economy";
import { acceptedResourceMask } from "../core/stockpile";
import { ownerOfUnit, type OwnerComponents } from "./owner";
import { getCivBonuses } from "../core/civilization";
import { spawnEntity, type ComponentRows, type World } from "../core/world";

export const ASSIGNED_SITE = "AssignedSite" as const;
export const BUILDING = "Building" as const;
export const BUILDING_SITE = "BuildingSite" as const;
export const RUBBLE = "Rubble" as const;
export const TRAIN_QUEUE = "TrainQueue" as const;

/** Row arity per building component — pinned for digest stability. */
export const BUILDING_COMPONENT_ARITIES: readonly [string, number][] = [
  [ASSIGNED_SITE, 1],
  [BUILDING, 5],
  [BUILDING_SITE, 4],
  [RUBBLE, 4],
  [TRAIN_QUEUE, -1], // variable-length production queue
];

/** Component ids the building systems read/write. */
export interface BuildingComponents {
  readonly assignedSiteId: number;
  readonly buildingId: number;
  readonly buildingSiteId: number;
  readonly rubbleId: number;
  readonly trainQueueId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows)
    throw new Error(`unregistered component id: ${String(componentId)}`);
  return rows;
}

function requireRow(
  world: World,
  componentId: number,
  eid: number,
  label: string,
): number[] {
  const values = requireRows(world, componentId).get(eid);
  if (!values) throw new Error(`entity ${String(eid)} has no ${label} row`);
  return values;
}

// ---- Footprint geometry -------------------------------------------------------

export interface FootprintRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function footprintOfDefCode(defCode: number): FootprintRect {
  const def = buildingDefOf(buildingIdOfCode(defCode));
  return {
    x: 0,
    y: 0,
    width: def.footprint.width,
    height: def.footprint.height,
  };
}

/** Every tile covered by an origin-anchored footprint, row-major. */
export function footprintTiles(
  originX: number,
  originY: number,
  width: number,
  height: number,
): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      tiles.push({ x: originX + dx, y: originY + dy });
    }
  }
  return tiles;
}

export function rectsOverlap(a: FootprintRect, b: FootprintRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

// ---- Sites & finished buildings ----------------------------------------------

export interface SpawnBuildingSiteOptions {
  /** Owning player; M1 has exactly one (PLAYER_ONE). */
  readonly playerId?: number | undefined;
}

/**
 * Effective maximum HP of a building taking into account civilization bonuses
 * (e.g. Byzantines +25% building HP).
 */
export function buildingMaxHp(
  world: World,
  playerId: number,
  defId: string,
): number {
  const def = buildingDefOf(defId);
  let hp = def.hp;
  if (world.civilizations) {
    const bonuses = getCivBonuses(world, playerId);
    for (const b of bonuses) {
      if (
        b.stat === "hp" &&
        (b.target === "class:building" || b.target === `building:${defId}`)
      ) {
        if (b.op === "mult") hp = Math.round(hp * b.value);
        else if (b.op === "add") hp += b.value;
      }
    }
  }
  return hp;
}

/**
 * Spawn one construction-site entity centered on its footprint. The
 * caller (systems/placement.ts) owns validity, cost escrow, passability
 * and version bumps — this helper is pure state creation.
 */
export function spawnBuildingSite(
  world: World,
  comps: BuildingComponents & { positionId: number },
  defId: string,
  tileX: number,
  tileY: number,
  options: SpawnBuildingSiteOptions = {},
): number {
  if (!Number.isInteger(tileX) || !Number.isInteger(tileY)) {
    throw new Error(
      `building site origin must be integer tiles, got (${String(tileX)}, ${String(tileY)})`,
    );
  }
  const playerId = options.playerId ?? 0;
  const def = buildingDefOf(defId);
  const eid = spawnEntity(world);
  const maxHp = buildingMaxHp(world, playerId, defId);
  requireRows(world, comps.positionId).set(eid, [
    tileX + def.footprint.width / 2,
    tileY + def.footprint.height / 2,
  ]);
  requireRows(world, comps.buildingSiteId).set(eid, [
    playerId,
    buildingCodeOf(defId),
    0, // progressMilliTicks
    maxHp, // hp — sites are attackable from placement day one (M2-T7)
  ]);
  // Fog dirty mark (SPEC §2.9): sites already radiate their definition
  // sight radius (AoE2 foundations reveal their surroundings).
  world.visibility.markDirty("spawned", eid);
  return eid;
}

/** Live BuildingSite row for `eid`, or undefined when not a site. */
export function getBuildingSiteRow(
  world: World,
  comps: Pick<BuildingComponents, "buildingSiteId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.buildingSiteId)?.get(eid);
}

/** Live finished-Building row for `eid`, or undefined when unfinished. */
export function getBuildingRow(
  world: World,
  comps: Pick<BuildingComponents, "buildingId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.buildingId)?.get(eid);
}

export interface CompletedBuildingInfo {
  readonly eid: number;
  readonly playerId: number;
  readonly defId: string;
}

/**
 * Swap one completed construction site into its finished building ON
 * THE SAME entity id: the BuildingSite row becomes a Building row, and
 * drop-off acceptance activates whenever the definition declares any
 * drop-off filters (the gather system enumerates DropOff rows live, so
 * gatherers reroute automatically from the next tick). No passability
 * or version change happens here — sites already block their tiles.
 * The foundation's damage state carries into the finished building
 * (AoE2-faithful: raiding a construction site leaves it weakened).
 */
export function completeBuilding(
  world: World,
  comps: BuildingComponents & {
    dropoffId: number;
    positionId: number;
    resourceNodeId?: number | undefined;
  },
  siteEid: number,
): CompletedBuildingInfo {
  const site = requireRow(world, comps.buildingSiteId, siteEid, BUILDING_SITE);
  const playerId = site[0]!;
  const defCode = site[1]!;
  const carriedHp = Math.max(1, Math.floor(site[3] ?? Infinity));
  const def = buildingDefOf(buildingIdOfCode(defCode));

  requireRows(world, comps.buildingSiteId).delete(siteEid);
  const pos = requireRow(world, comps.positionId, siteEid, "Position");
  const originX = pos[0]! - def.footprint.width / 2;
  const originY = pos[1]! - def.footprint.height / 2;
  const maxHp = buildingMaxHp(world, playerId, def.id);
  requireRows(world, comps.buildingId).set(siteEid, [
    playerId,
    defCode,
    originX,
    originY,
    Math.min(carriedHp, maxHp),
  ]);
  if (def.dropoffFilters.length > 0) {
    // M2-T2: the definition's filter list resolves into the DropOff row
    // mask at completion — the gather system filters candidates by the
    // ROW (never by re-reading definitions), so acceptance is digest-
    // visible state that reroutes gatherers from the next tick.
    const codes = def.dropoffFilters.map((slug) => {
      const code = RESOURCE_SLUGS.indexOf(
        slug as (typeof RESOURCE_SLUGS)[number],
      );
      if (code < 0) {
        throw new Error(
          `building ${def.id}: unknown dropoffFilters slug ${JSON.stringify(slug)}`,
        );
      }
      return code;
    });
    requireRows(world, comps.dropoffId).set(siteEid, [
      playerId,
      acceptedResourceMask(codes),
    ]);
  }
  if (def.id === "farm" && comps.resourceNodeId !== undefined) {
    requireRows(world, comps.resourceNodeId).set(siteEid, [
      RESOURCE_FOOD,
      175,
      def.workSlots ?? 1,
    ]);
  }
  return { eid: siteEid, playerId, defId: def.id };
}

/** Finished-building origin rect for `eid`, or undefined. */
export function buildingRectOf(
  world: World,
  comps: Pick<BuildingComponents, "buildingId"> & { positionId: number },
  eid: number,
): FootprintRect | undefined {
  const row = getBuildingRow(world, comps, eid);
  if (!row) return undefined;
  const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
  if (!pos) return undefined;
  const fp = footprintOfDefCode(row[1]!);
  return {
    x: pos[0]! - fp.width / 2,
    y: pos[1]! - fp.height / 2,
    width: fp.width,
    height: fp.height,
  };
}

/** Construction-site origin rect for `eid`, or undefined. */
export function siteRectOf(
  world: World,
  comps: Pick<BuildingComponents, "buildingSiteId"> & { positionId: number },
  eid: number,
): FootprintRect | undefined {
  const row = getBuildingSiteRow(world, comps, eid);
  if (!row) return undefined;
  const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
  if (!pos) return undefined;
  const fp = footprintOfDefCode(row[1]!);
  return {
    x: pos[0]! - fp.width / 2,
    y: pos[1]! - fp.height / 2,
    width: fp.width,
    height: fp.height,
  };
}

// ---- Rubble (M2-T7 destruction residue) ---------------------------------------

/**
 * Spawn one rubble-state entity over a destroyed structure's footprint.
 * The residue lives on its OWN entity id (the dead building's id never
 * returns), carrying only Position (footprint center, so render/UI
 * overlays place it like any entity) plus the origin-anchored Rubble
 * rect. Pure state creation — the caller owns tile freeing and the
 * passabilityVersion bump.
 */
export function spawnRubble(
  world: World,
  comps: BuildingComponents & { positionId: number },
  defCode: number,
  originX: number,
  originY: number,
): number {
  const fp = footprintOfDefCode(defCode);
  const eid = spawnEntity(world);
  requireRows(world, comps.positionId).set(eid, [
    originX + fp.width / 2,
    originY + fp.height / 2,
  ]);
  requireRows(world, comps.rubbleId).set(eid, [
    originX,
    originY,
    fp.width,
    fp.height,
  ]);
  return eid;
}

/** Live Rubble row for `eid`, or undefined when not rubble. */
export function getRubbleRow(
  world: World,
  comps: Pick<BuildingComponents, "rubbleId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.rubbleId)?.get(eid);
}

// ---- Assignment ---------------------------------------------------------------

/** Assign one builder to a construction site (replacing any prior). */
export function assignSite(
  world: World,
  comps: Pick<BuildingComponents, "assignedSiteId">,
  workerEid: number,
  siteEid: number,
): void {
  if (!Number.isInteger(siteEid) || siteEid < 1) {
    throw new Error(
      `construction site entity id must be a positive integer, got ${String(siteEid)}`,
    );
  }
  requireRows(world, comps.assignedSiteId).set(workerEid, [siteEid]);
}

export function getAssignedSite(
  world: World,
  comps: Pick<BuildingComponents, "assignedSiteId">,
  workerEid: number,
): number | undefined {
  return world.rowsByComponentId.get(comps.assignedSiteId)?.get(workerEid)?.[0];
}

/** Release the builder's assignment (row disappears from digests). */
export function clearAssignedSite(
  world: World,
  comps: Pick<BuildingComponents, "assignedSiteId">,
  workerEid: number,
): boolean {
  return (
    world.rowsByComponentId.get(comps.assignedSiteId)?.delete(workerEid) ??
    false
  );
}

// ---- Production queue ----------------------------------------------------------

export interface TrainQueueEntry {
  readonly unitCode: number;
  /** Mutable decoded copy — systems tick it down inside step(). */
  remainingTicks: number;
}

/** Decoded copy of one building's training queue (entry 0 = active). */
export function readTrainQueue(
  world: World,
  comps: Pick<BuildingComponents, "trainQueueId">,
  eid: number,
): TrainQueueEntry[] {
  const row = world.rowsByComponentId.get(comps.trainQueueId)?.get(eid);
  if (!row) return [];
  const entries: TrainQueueEntry[] = [];
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    entries.push({
      unitCode: row[1 + i * 2]!,
      remainingTicks: row[2 + i * 2]!,
    });
  }
  return entries;
}

export function writeTrainQueue(
  world: World,
  comps: Pick<BuildingComponents, "trainQueueId">,
  eid: number,
  entries: readonly TrainQueueEntry[],
): void {
  const row: number[] = [entries.length];
  for (const entry of entries) {
    row.push(entry.unitCode, entry.remainingTicks);
  }
  requireRows(world, comps.trainQueueId).set(eid, row);
}

// ---- Population -----------------------------------------------------------------

/**
 * Live population: every entity carrying a UnitTag row. With an
 * `ownerId` (M2-T9) only that player's units count — rowless legacy
 * villagers read as player zero via components/owner.ts; without one
 * the M1 global count is returned unchanged.
 */
export function populationOf(
  world: World,
  comps: { unitTagId: number } & Partial<Pick<OwnerComponents, "ownerId">>,
  ownerId?: number | undefined,
): number {
  const rows = world.rowsByComponentId.get(comps.unitTagId);
  let count = 0;
  if (rows) {
    for (const [eid] of rows) {
      if (
        ownerId !== undefined &&
        comps.ownerId !== undefined &&
        ownerOfUnit(world, comps as OwnerComponents, eid) !== ownerId
      ) {
        continue;
      }
      count += 1;
    }
  }
  if ("garrisonId" in comps && typeof (comps as { garrisonId?: number }).garrisonId === "number") {
    const garrisonRows = world.rowsByComponentId.get((comps as { garrisonId: number }).garrisonId);
    if (garrisonRows) {
      for (const [, gRow] of garrisonRows) {
        const gCount = gRow[0] ?? 0;
        for (let i = 0; i < gCount; i++) {
          const gOwner = gRow[1 + i * 5 + 1]!;
          if (ownerId === undefined || gOwner === ownerId) {
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

/**
 * Current population-cap ceiling: the sum of `populationCap` over
 * FINISHED buildings (sites grant nothing until they complete). With
 * `ownerId` (M2-T9) only that player's buildings count — the shared
 * M1 global sum is returned when no owner is named.
 */
export function populationCapOf(
  world: World,
  comps: Pick<BuildingComponents, "buildingId">,
  ownerId?: number | undefined,
): number {
  const rows = world.rowsByComponentId.get(comps.buildingId);
  let cap = 0;
  if (rows) {
    for (const row of rows.values()) {
      if (ownerId !== undefined && row[0] !== ownerId) continue;
      cap += buildingDefOf(buildingIdOfCode(row[1]!)).populationCap;
    }
  }
  if (ownerId !== undefined && world.civilizations) {
    const bonuses = getCivBonuses(world, ownerId);
    for (const b of bonuses) {
      if (b.stat === "populationCap") {
        if (b.op === "add") cap += b.value;
        else if (b.op === "mult") cap = Math.round(cap * b.value);
      }
    }
  }
  return cap;
}

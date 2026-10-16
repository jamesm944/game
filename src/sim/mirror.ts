/**
 * Render-mirror snapshot producer — SPEC §2.1 seam / ADR-0001.
 *
 * The renderer never reaches into component rows; instead this PURE
 * module copies everything it needs into plain typed arrays AFTER each
 * step(). `render/` imports only this file (plus types), so the seam
 * stays one-directional: render reads, sim knows nothing of render.
 *
 * Frame layout is SoA, indexed by ascending-eid rank i (NOT by eid —
 * eids travel alongside for id-keyed overlays):
 *   positions[2i], positions[2i + 1]  → x,y float tile coordinates
 *   headings[i]                       → facing radians (Velocity row [0])
 *   hpFractions[i]                    → hp / maxHp clamped to [0,1]
 *                                       (M2-T6 health-bar overlay feed;
 *                                       units without a Combat row
 *                                       report a full bar)
 */

import type { SimComponents } from "./components";
import type { FaithComponents } from "./components/faith";
import { combatDefOf } from "./components/combat";
import { getBuildingRow, getBuildingSiteRow } from "./components/buildings";
import {
  RESOURCE_WOOD,
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_CLAY,
} from "./components/economy";
import type { OwnerComponents } from "./components/owner";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitCodeOf,
} from "../data/definitions";
import { WORK_MILLI_SCALE } from "./systems/construction";
import { currentAgeRankOf } from "./systems/age";
import { relicsOf, RELIC_GROUND } from "./components/relic";
import type { World } from "./core/world";

export const ACTIVITY_IDLE = 0;
export const ACTIVITY_WALK = 1;
export const ACTIVITY_CHOP = 2;
export const ACTIVITY_FARM = 3;
export const ACTIVITY_MINE = 4;
export const ACTIVITY_BUILD = 5;
export const ACTIVITY_CARRY_WOOD = 6;
export const ACTIVITY_CARRY_FOOD = 7;
export const ACTIVITY_CARRY_ORE = 8;
export const ACTIVITY_ATTACK = 9;
export const ACTIVITY_DEATH = 10;

/** One post-step frame of unit state, ready for the double buffer. */
export interface SimSnapshotFrame {
  /** World tick this frame was captured after. */
  readonly tick: number;
  /** Live units copied; arrays are valid up to this count. */
  readonly count: number;
  /** Ascending eids; index i ↔ positions[2i] / headings[i]. */
  readonly eids: Int32Array;
  /** Packed x,y pairs, capacity ≥ 2·count. */
  readonly positions: Float32Array;
  /** Facing radians, capacity ≥ count. */
  readonly headings: Float32Array;
  /** Health 0..1 per rank, capacity ≥ count (M2-T6 overlays). */
  readonly hpFractions: Float32Array;
  /** Unit def code (0 = villager, or combatDef code). */
  readonly defCodes?: Uint8Array | undefined;
  /** Activity code (idle, walk, chop, farm, mine, build, carry-wood, carry-food, carry-ore, attack, death). */
  readonly activityCodes?: Uint8Array | undefined;
  /** Owner player id (0 = human, 1 = AI). */
  readonly ownerIds?: Uint8Array | undefined;
  /** Active monk conversions in progress this frame (V14 Issue #101). */
  readonly conversions?: readonly ActiveConversion[] | undefined;
}

export interface ActiveConversion {
  readonly monkEid: number;
  readonly monkX: number;
  readonly monkY: number;
  readonly targetEid: number;
  readonly targetX: number;
  readonly targetY: number;
  /** 0..1 fraction of castTicks elapsed */
  readonly progress: number;
  /** Faith value of the monk (0..100) */
  readonly faith: number;
}

export interface CaptureSnapshotOptions {
  /**
   * Preallocated frame to reuse across captures (zero steady-state
   * allocation). Grown transparently when the live population rises;
   * omit for a fresh allocation each call.
   */
  readonly reusable?: SimSnapshotFrame | undefined;
}

function growF32(array: Float32Array, needed: number): Float32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 64);
  while (capacity < needed) capacity *= 2;
  const grown = new Float32Array(capacity);
  grown.set(array);
  return grown;
}

function growI32(array: Int32Array, needed: number): Int32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 64);
  while (capacity < needed) capacity *= 2;
  const grown = new Int32Array(capacity);
  grown.set(array);
  return grown;
}

function growU8(array: Uint8Array, needed: number): Uint8Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 64);
  while (capacity < needed) capacity *= 2;
  const grown = new Uint8Array(capacity);
  grown.set(array);
  return grown;
}

const VILLAGER_DEF_CODE = unitCodeOf("villager");

const ACT_KIND_MOVE = 1;
const ACT_KIND_GATHER = 3;
const ACT_KIND_DELIVER = 4;
const ACT_KIND_ATTACK = 5;
const ACT_KIND_ATTACK_MOVE = 6;

function unitActivityOf(
  eid: number,
  isDead: boolean,
  actRows: Map<number, readonly number[]> | undefined,
  invRows: Map<number, readonly number[]> | undefined,
  assignedNodeRows: Map<number, readonly number[]> | undefined,
  resourceNodeRows: Map<number, readonly number[]> | undefined,
  assignedSiteRows: Map<number, readonly number[]> | undefined,
): number {
  if (isDead) return ACTIVITY_DEATH;

  const actRow = actRows?.get(eid);
  const headCount = actRow ? actRow[0]! : 0;
  const headKind = headCount > 0 ? actRow![1]! : 0;

  const invRow = invRows?.get(eid);
  const carriedAmount = invRow ? invRow[1]! : 0;
  const resourceCode = invRow ? invRow[0]! : 0;

  const nodeEid = assignedNodeRows?.get(eid)?.[0];

  if (headKind === ACT_KIND_GATHER) {
    const resCode =
      nodeEid !== undefined ? (resourceNodeRows?.get(nodeEid)?.[0] ?? -1) : -1;
    if (resCode === RESOURCE_WOOD) return ACTIVITY_CHOP;
    if (resCode === RESOURCE_FOOD) return ACTIVITY_FARM;
    if (resCode >= RESOURCE_GOLD && resCode <= RESOURCE_CLAY)
      return ACTIVITY_MINE;
    return ACTIVITY_CHOP;
  }

  if (
    headKind === ACT_KIND_DELIVER ||
    headKind === ACT_KIND_MOVE ||
    headKind === ACT_KIND_ATTACK_MOVE
  ) {
    if (carriedAmount > 0) {
      if (resourceCode === RESOURCE_WOOD) return ACTIVITY_CARRY_WOOD;
      if (resourceCode === RESOURCE_FOOD) return ACTIVITY_CARRY_FOOD;
      return ACTIVITY_CARRY_ORE;
    }
    return ACTIVITY_WALK;
  }

  if (headKind === ACT_KIND_ATTACK) {
    return ACTIVITY_ATTACK;
  }

  if (assignedSiteRows?.has(eid)) {
    return ACTIVITY_BUILD;
  }

  if (nodeEid !== undefined) {
    const resCode = resourceNodeRows?.get(nodeEid)?.[0] ?? -1;
    if (resCode === RESOURCE_WOOD) return ACTIVITY_CHOP;
    if (resCode === RESOURCE_FOOD) return ACTIVITY_FARM;
    if (resCode >= RESOURCE_GOLD && resCode <= RESOURCE_CLAY)
      return ACTIVITY_MINE;
  }

  return ACTIVITY_IDLE;
}

/**
 * Copy every live unit's position/heading/health out of the world.
 * Pure: reads component rows only, writes only into the returned frame,
 * and touches neither DOM nor three.js. Call once per rendered frame
 * AFTER all step()s, before sampling interpolation. Takes SimComponents
 * because the M2-T6 overlay feed reads Combat rows; callers without a
 * combat registry simply get full-health bars everywhere.
 */
export function captureSimSnapshot(
  world: World,
  comps: SimComponents,
  options: CaptureSnapshotOptions = {},
): SimSnapshotFrame {
  // Live units ⊆ entities, so sizing to entityCount up front means no
  // growth can trigger inside the capture loop.
  const positionRows = world.rowsByComponentId.get(comps.positionId);
  const velocityRows = world.rowsByComponentId.get(comps.velocityId);
  const ownerRows = (comps as OwnerComponents).ownerId
    ? world.rowsByComponentId.get((comps as OwnerComponents).ownerId)
    : undefined;
  const actQueueRows = comps.activityQueueId
    ? world.rowsByComponentId.get(comps.activityQueueId)
    : undefined;
  const invRows = comps.inventoryId
    ? world.rowsByComponentId.get(comps.inventoryId)
    : undefined;
  const assignedNodeRows = comps.assignedNodeId
    ? world.rowsByComponentId.get(comps.assignedNodeId)
    : undefined;
  const resourceNodeRows = comps.resourceNodeId
    ? world.rowsByComponentId.get(comps.resourceNodeId)
    : undefined;
  const assignedSiteRows = comps.assignedSiteId
    ? world.rowsByComponentId.get(comps.assignedSiteId)
    : undefined;

  const combatRows = comps.combatId
    ? world.rowsByComponentId.get(comps.combatId)
    : undefined;
  const hasCombat = !!combatRows && combatRows.size > 0;
  const hasOwner = !!ownerRows && ownerRows.size > 0;
  const hasActivityComps = !!(
    (actQueueRows && actQueueRows.size > 0) ||
    (invRows && invRows.size > 0) ||
    (assignedNodeRows && assignedNodeRows.size > 0) ||
    (resourceNodeRows && resourceNodeRows.size > 0) ||
    (assignedSiteRows && assignedSiteRows.size > 0)
  );

  const entityCount = world.entities.length;
  const needed = Math.max(entityCount, 1);
  const reusable = options.reusable;
  let eids = reusable ? growI32(reusable.eids, needed) : new Int32Array(needed);
  let positions = reusable
    ? growF32(reusable.positions, entityCount * 2)
    : new Float32Array(entityCount * 2);
  let headings = reusable
    ? growF32(reusable.headings, needed)
    : new Float32Array(needed);
  let hpFractions = reusable
    ? growF32(reusable.hpFractions, needed)
    : new Float32Array(needed);
  let defCodes = reusable?.defCodes
    ? growU8(reusable.defCodes, needed)
    : new Uint8Array(needed);
  let activityCodes =
    hasActivityComps || reusable?.activityCodes
      ? reusable?.activityCodes
        ? growU8(reusable.activityCodes, needed)
        : new Uint8Array(needed)
      : undefined;
  let ownerIds =
    hasOwner || reusable?.ownerIds
      ? reusable?.ownerIds
        ? growU8(reusable.ownerIds, needed)
        : new Uint8Array(needed)
      : undefined;

  // maxHp per def code, memoized per capture (codes are dense u8s).
  const maxHpByDefCode = hasCombat ? new Map<number, number>() : null;

  let count = 0;
  const entities = world.entities;

  if (!hasCombat && !defCodes && !activityCodes && !ownerIds) {
    let pIdx = 0;
    for (let i = 0; i < entityCount; i++) {
      const eid = entities[i]!;
      const posRow = positionRows?.get(eid);
      if (!posRow) continue;
      const velRow = velocityRows?.get(eid);
      if (!velRow) continue;
      eids[count] = eid;
      positions[pIdx++] = posRow[0]!;
      positions[pIdx++] = posRow[1]!;
      headings[count] = velRow[0]!;
      count++;
    }
    hpFractions.fill(1, 0, count);
  } else {
    // world.entities ascends by construction (spawn order); a linear walk
    // keeps the mirror's index order stable frame-to-frame.
    for (let i = 0; i < entityCount; i++) {
      const eid = entities[i]!;
      const posRow = positionRows?.get(eid);
      if (!posRow) continue;
      const velRow = velocityRows?.get(eid);
      if (!velRow) continue; // not a movable unit
      eids[count] = eid;
      positions[count * 2] = posRow[0]!;
      positions[count * 2 + 1] = posRow[1]!;
      headings[count] = velRow[0]!; // Velocity row layout: headingRad first

      let fraction = 1;
      let defCode = VILLAGER_DEF_CODE;
      if (hasCombat) {
        const combatRow = combatRows!.get(eid);
        if (combatRow) {
          defCode = combatRow[0]!;
          let maxHp = maxHpByDefCode!.get(defCode);
          if (maxHp === undefined) {
            maxHp = combatDefOf(world, comps, eid)!.hp;
            maxHpByDefCode!.set(defCode, maxHp);
          }
          fraction = Math.min(1, Math.max(0, combatRow[2]! / maxHp));
        }
      }
      hpFractions[count] = fraction;
      if (defCodes) defCodes[count] = defCode;
      if (activityCodes) {
        activityCodes[count] = hasActivityComps
          ? unitActivityOf(
              eid,
              fraction <= 0,
              actQueueRows,
              invRows,
              assignedNodeRows,
              resourceNodeRows,
              assignedSiteRows,
            )
          : ACTIVITY_IDLE;
      }
      if (ownerIds) {
        ownerIds[count] = hasOwner ? (ownerRows!.get(eid)?.[0] ?? 0) : 0;
      }
      count++;
    }
  }

  const conversions =
    (comps as Partial<FaithComponents>).faithId !== undefined
      ? captureActiveConversions(world, comps)
      : undefined;

  return {
    tick: world.tick,
    count,
    eids,
    positions,
    headings,
    hpFractions,
    defCodes,
    activityCodes,
    ownerIds,
    conversions,
  };
}

/**
 * Capture all active monk conversions this frame.
 */
export function captureActiveConversions(
  world: World,
  comps: SimComponents,
): readonly ActiveConversion[] {
  const faithId = (comps as Partial<FaithComponents>).faithId;
  if (!faithId || !world.rowsByComponentId.has(faithId)) {
    return [];
  }
  const faithRows = world.rowsByComponentId.get(faithId);
  if (!faithRows || faithRows.size === 0) return [];

  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!posRows) return [];

  const combatRows = comps.combatId
    ? world.rowsByComponentId.get(comps.combatId)
    : undefined;
  const result: ActiveConversion[] = [];

  for (const [monkEid, fRow] of faithRows) {
    const targetEid = fRow[1]!;
    const progressTicks = fRow[2]!;
    if (targetEid === 0 || progressTicks <= 0) continue;

    const monkPos = posRows.get(monkEid);
    const targetPos = posRows.get(targetEid);
    if (!monkPos || !targetPos) continue;

    let castTicks = 25;
    if (combatRows) {
      const cDef = combatDefOf(world, comps, monkEid);
      if (cDef?.castTicks) castTicks = cDef.castTicks;
    }

    result.push({
      monkEid,
      monkX: monkPos[0]!,
      monkY: monkPos[1]!,
      targetEid,
      targetX: targetPos[0]!,
      targetY: targetPos[1]!,
      progress: Math.min(1, progressTicks / castTicks),
      faith: fRow[0]!,
    });
  }

  return result;
}

/**
 * One post-step frame of building state (M1-T10): construction sites
 * AND finished buildings, ascending eid. Pure — same seam discipline
 * as captureSimSnapshot; render reads this, never component rows.
 */
export interface BuildingSnapshotFrame {
  /** Live buildings/sites copied; arrays valid up to this count. */
  readonly count: number;
  readonly eids: Int32Array;
  /** Footprint origin tiles packed x,y per index. */
  readonly origins: Float32Array;
  /** Footprint width,height in tiles packed per index. */
  readonly sizes: Float32Array;
  /** 0 = construction site, 1 = finished building. */
  readonly states: Uint8Array;
  /** Build progress clamped to [0,1]; finished buildings report 1. */
  readonly progress: Float32Array;
  /** Numeric building definition code. */
  readonly defCodes: Uint8Array;
  /** Owner player ID. */
  readonly ownerIds: Uint8Array;
  /** Owner age rank (1=Dark, 2=Feudal, 3=Castle, 4=Imperial). */
  readonly ageRanks: Uint8Array;
}

export interface CaptureBuildingOptions {
  readonly reusable?: BuildingSnapshotFrame | undefined;
}

export function captureBuildingSnapshot(
  world: World,
  comps: SimComponents,
  options: CaptureBuildingOptions = {},
): BuildingSnapshotFrame {
  const entityCount = world.entities.length;
  const grow = (array: Float32Array, stride: number): Float32Array => {
    const needed = entityCount * stride;
    if (array.length >= Math.max(needed, 1)) return array;
    let capacity = Math.max(array.length, 64 * stride);
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(array);
    return grown;
  };
  let eids = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.eids ?? new Int32Array(0);
    if (array.length >= needed) return array;
    let capacity = Math.max(array.length, 64);
    while (capacity < needed) capacity *= 2;
    const grown = new Int32Array(capacity);
    grown.set(array);
    return grown;
  })();
  let origins = grow(options.reusable?.origins ?? new Float32Array(0), 2);
  let sizes = grow(options.reusable?.sizes ?? new Float32Array(0), 2);
  let states = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.states ?? new Uint8Array(0);
    if (array.length >= needed) return array;
    return new Uint8Array(Math.max(needed, 64));
  })();
  let progress = grow(options.reusable?.progress ?? new Float32Array(0), 1);
  let defCodes = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.defCodes ?? new Uint8Array(0);
    if (array.length >= needed) return array;
    return new Uint8Array(Math.max(needed, 64));
  })();
  let ownerIds = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.ownerIds ?? new Uint8Array(0);
    if (array.length >= needed) return array;
    return new Uint8Array(Math.max(needed, 64));
  })();
  let ageRanks = (() => {
    const needed = Math.max(entityCount, 1);
    let array = options.reusable?.ageRanks ?? new Uint8Array(0);
    if (array.length >= needed) return array;
    return new Uint8Array(Math.max(needed, 64));
  })();

  let count = 0;
  for (let i = 0; i < entityCount; i++) {
    const eid = world.entities[i]!;
    const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!posRow) continue;
    const site = getBuildingSiteRow(world, comps, eid);
    const built = getBuildingRow(world, comps, eid);
    if (!site && !built) continue;
    const row = (site ?? built)!;
    const owner = row[0]!;
    const defCode = row[1]!;
    const def = buildingDefOf(buildingIdOfCode(defCode));
    const centerX = posRow[0]!;
    const centerY = posRow[1]!;
    const w = def.footprint.width;
    const h = def.footprint.height;

    eids[count] = eid;
    origins[count * 2] = centerX - w / 2;
    origins[count * 2 + 1] = centerY - h / 2;
    sizes[count * 2] = w;
    sizes[count * 2 + 1] = h;
    defCodes[count] = defCode;
    ownerIds[count] = owner;
    ageRanks[count] = comps.ageStateId
      ? currentAgeRankOf(world, comps, owner)
      : 1;

    if (built) {
      states[count] = 1;
      progress[count] = 1;
    } else {
      states[count] = 0;
      const total = def.buildTime * WORK_MILLI_SCALE;
      progress[count] = Math.min(1, Math.max(0, site![2]! / total));
    }
    count++;
  }

  return {
    count,
    eids: eids.subarray(0, Math.max(count, 1)),
    origins,
    sizes,
    states: states.subarray(0, Math.max(count, 1)),
    progress,
    defCodes: defCodes.subarray(0, Math.max(count, 1)),
    ownerIds: ownerIds.subarray(0, Math.max(count, 1)),
    ageRanks: ageRanks.subarray(0, Math.max(count, 1)),
  };
}

/**
 * One post-step frame of relic state (issue #76 / SPEC §2.11).
 * Pure SoA mirror snapshot for 3D relic rendering and minimap projection.
 */
export interface RelicSnapshotFrame {
  /** Count of relics tracked; arrays valid up to this count. */
  readonly count: number;
  /** Relic entity IDs. */
  readonly eids: Int32Array;
  /** Positions packed x, y per index. */
  readonly positions: Float32Array;
  /** 0 = ground, 1 = carried, 2 = stored. */
  readonly states: Uint8Array;
  /** Holder entity ID (monk if carried, monastery if stored, 0 if ground). */
  readonly holderEids: Int32Array;
}

export interface CaptureRelicOptions {
  readonly reusable?: RelicSnapshotFrame | undefined;
}

export function captureRelicSnapshot(
  world: World,
  comps: Pick<SimComponents, "positionId"> & { readonly relicId?: number },
  options: CaptureRelicOptions = {},
): RelicSnapshotFrame {
  if (!comps.relicId || !world.rowsByComponentId.has(comps.relicId)) {
    return {
      count: 0,
      eids: new Int32Array(0),
      positions: new Float32Array(0),
      states: new Uint8Array(0),
      holderEids: new Int32Array(0),
    };
  }

  const allRelics = relicsOf(world, { relicId: comps.relicId });
  const count = allRelics.length;

  let eids = options.reusable?.eids ?? new Int32Array(0);
  if (eids.length < count) {
    eids = new Int32Array(Math.max(count, 16));
  }
  let positions = options.reusable?.positions ?? new Float32Array(0);
  if (positions.length < count * 2) {
    positions = new Float32Array(Math.max(count * 2, 32));
  }
  let states = options.reusable?.states ?? new Uint8Array(0);
  if (states.length < count) {
    states = new Uint8Array(Math.max(count, 16));
  }
  let holderEids = options.reusable?.holderEids ?? new Int32Array(0);
  if (holderEids.length < count) {
    holderEids = new Int32Array(Math.max(count, 16));
  }

  const posRows = world.rowsByComponentId.get(comps.positionId);

  for (let i = 0; i < count; i++) {
    const { eid, row } = allRelics[i]!;
    eids[i] = eid;
    states[i] = row.state;
    holderEids[i] = row.holderEid;

    const targetEid = row.state === RELIC_GROUND ? eid : row.holderEid;
    let pos = posRows?.get(targetEid);
    if (!pos && targetEid !== eid) {
      pos = posRows?.get(eid);
    }
    positions[i * 2] = pos ? pos[0]! : 0;
    positions[i * 2 + 1] = pos ? pos[1]! : 0;
  }

  return {
    count,
    eids: eids.subarray(0, Math.max(count, 1)),
    positions,
    states: states.subarray(0, Math.max(count, 1)),
    holderEids: holderEids.subarray(0, Math.max(count, 1)),
  };
}

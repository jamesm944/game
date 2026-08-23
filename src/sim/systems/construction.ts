/**
 * Construction system — SPEC §2.3 Build activity / M1-T10.
 *
 * Consumes `{kind:"build", data:{entityIds, siteEid}}` orders (villagers
 * → construction site) and advances every live site each tick:
 *
 *   - assigned builders walk to the footprint approach band, then stand
 *     Parked hammering; travel legs stay plain Move activities steered
 *     by the movement system (same split as the gather chain)
 *   - builders IN RANGE add fixed-point progress: the k-th contributing
 *     builder (ascending eid) adds round(1000 · 0.7^k) milli-ticks per
 *     tick — extra helpers help, with strictly diminishing per-builder
 *     returns (AoE2-style)
 *   - progress ≥ buildTime·1000 swaps the BuildingSite row into its
 *     finished Building row ON THE SAME ENTITY ID and activates any
 *     drop-off filters (components/buildings.completeBuilding); every
 *     assigned builder is released to idle
 *
 * No passability or passabilityVersion change happens at completion:
 * sites blocked their tiles from placement day one.
 *
 * Integer-only accumulation keeps multi-builder sums bit-exact across
 * platforms (SPEC §9 float-drift risk).
 */

import {
  cancelActivities,
  enqueueActivity,
  moveActivity,
  peekActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { clearAssignedNode } from "../components/economy";
import {
  assignSite,
  clearAssignedSite,
  completeBuilding,
  getAssignedSite,
  getBuildingSiteRow,
  type FootprintRect,
} from "../components/buildings";
import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import {
  COMMODITY_TOOLS,
  commodityAmountOfOrZero,
  withdrawCommodityFromStockpile,
} from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";
import { resetSteeringBookkeeping } from "./movement";

/** Command kind owned by this system. */
export const BUILD_KIND = "build";

/** Fixed-point scale: progress rows count thousandths of a work tick. */
export const WORK_MILLI_SCALE = 1000;

/**
 * Each additional builder on one site contributes this fraction of the
 * previous builder's rate: 1st = 100%, 2nd = 70%, 3rd = 49%, …
 */
export const EXTRA_BUILDER_EFFICIENCY = 0.7;

/** Fixed-point per-tick contribution for the builder at rank `rank`. */
export function builderWorkMilliPerTick(rank: number): number {
  if (!Number.isInteger(rank) || rank < 0) {
    throw new Error(
      `builder rank must be a non-negative integer, got ${String(rank)}`,
    );
  }
  let weight = 1;
  for (let i = 0; i < rank; i++) weight *= EXTRA_BUILDER_EFFICIENCY;
  return Math.round(WORK_MILLI_SCALE * weight);
}

/** Distance from a site's FOOTPRINT EDGE within which builders contribute. */
export const BUILD_WORK_RANGE_TILES = 3.25;

// ---- Tool bonus (M2-T3) ---------------------------------------------------------
//
// SPEC §2.6: tools are "consumed by construction + work-speed bonuses".
// While the building owner holds at least one tool, every contributing
// builder's fixed-point output scales by TOOLS_BOOST (×5/4 exact
// integer math), and each boosted site drains one tool every
// TOOLS_CONSUME_PERIOD_TICKS — a deterministic world-tick boundary, so
// replays and digests see identical deductions. Sites iterate ascending
// eid, so same-tick multi-site consumption order is pinned too.

/** Boost multiplier numerator/denominator: exactly ×5/4. */
export const TOOLS_BOOST_NUMERATOR = 5;
export const TOOLS_BOOST_DENOMINATOR = 4;
/** One tool consumed per boosted site every this many ticks. */
export const TOOLS_CONSUME_PERIOD_TICKS = 90;

/** Squared distance from (x,y) to the nearest point of `rect` (0 inside). */
export function rectDistanceSq(
  x: number,
  y: number,
  rect: FootprintRect,
): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return dx * dx + dy * dy;
}

export interface ConstructionDiagnostics {
  /** build commands applied. */
  commandsApplied: number;
  /** Sites completed since sim start. */
  completions: number;
  /** Tools drained by boosted sites since sim start (M2-T3). */
  toolsConsumed: number;
  /** Site-ticks that ran under the tool speed bonus (M2-T3). */
  boostedSiteTicks: number;
}

export function createConstructionDiagnostics(): ConstructionDiagnostics {
  return {
    commandsApplied: 0,
    completions: 0,
    toolsConsumed: 0,
    boostedSiteTicks: 0,
  };
}

function parseBuildData(data: Readonly<Record<string, unknown>>): {
  entityIds: number[];
  siteEid: number;
} {
  const rawIds = data.entityIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("build requires a non-empty entityIds array");
  }
  const entityIds: number[] = [];
  for (const id of rawIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `build entityIds entries must be positive integers, got ${String(id)}`,
      );
    }
    if (!entityIds.includes(id)) entityIds.push(id);
  }
  entityIds.sort((a, b) => a - b);
  const siteEid = data.siteEid;
  if (
    typeof siteEid !== "number" ||
    !Number.isInteger(siteEid) ||
    siteEid < 1
  ) {
    throw new Error(
      `build siteEid must be a positive integer, got ${String(siteEid)}`,
    );
  }
  return { entityIds, siteEid };
}

/**
 * Nearest point on the rectangle expanded by `margin` tiles: clamping
 * the worker's position onto the expanded rect deterministically yields
 * the closest boundary point. The clamped tile may since have been
 * blocked by a NEIGHBORING building's footprint — in that case the
 * point slides to the nearest still-passable tile (expanding square
 * rings, clockwise from north-west) so the approach goal stays
 * reachable and the planner can never livelock against movement.
 *
 * Shared with the production system (M2-T3): workshop crafters walk to
 * the exact same kind of perimeter door.
 */
export function approachPoint(
  world: World,
  rect: FootprintRect,
  margin: number,
  fromX: number,
  fromY: number,
): { x: number; y: number } {
  const minX = rect.x - margin;
  const minY = rect.y - margin;
  const maxX = rect.x + rect.width + margin;
  const maxY = rect.y + rect.height + margin;
  const cx = Math.min(Math.max(fromX, minX), maxX);
  const cy = Math.min(Math.max(fromY, minY), maxY);
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  const startTx = Math.floor(cx);
  const startTy = Math.floor(cy);
  if (passableAt(passability, size, startTx, startTy)) {
    return { x: cx, y: cy };
  }
  for (let ring = 1; ring <= size; ring++) {
    const loX = Math.max(0, startTx - ring);
    const loY = Math.max(0, startTy - ring);
    const hiX = Math.min(size - 1, startTx + ring);
    const hiY = Math.min(size - 1, startTy + ring);
    for (let x = loX; x <= hiX; x++) {
      if (passableAt(passability, size, x, loY))
        return { x: x + 0.5, y: loY + 0.5 };
    }
    for (let y = loY + 1; y <= hiY; y++) {
      if (passableAt(passability, size, hiX, y))
        return { x: hiX + 0.5, y: y + 0.5 };
    }
    for (let x = hiX - 1; x >= loX; x--) {
      if (passableAt(passability, size, x, hiY))
        return { x: x + 0.5, y: hiY + 0.5 };
    }
    for (let y = hiY - 1; y > loY; y--) {
      if (passableAt(passability, size, loX, y))
        return { x: loX + 0.5, y: y + 0.5 };
    }
  }
  return { x: cx, y: cy }; // fully blocked map: unreachable everywhere
}

function passableAt(
  passability: Uint8Array,
  size: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return passability[y * size + x] === 1;
}

interface BuilderRef {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  readonly velRow: number[] | undefined;
}

interface SiteWorkGroup {
  readonly siteEid: number;
  /** Live BuildingSite row [playerId, defCode, progressMilliTicks]. */
  readonly row: number[];
  readonly center: { x: number; y: number };
  readonly rect: FootprintRect;
  /** Ascending eid by construction (walked world.entities). */
  readonly builders: BuilderRef[];
} /**
 * Build the construction SimSystem. Register AFTER placement so build
 * orders can only ever target sites that already exist.
 */
export function createConstructionSystem(
  comps: SimComponents,
  diagnostics: ConstructionDiagnostics = createConstructionDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    // ---- 1) Commands consumed exactly on their target tick boundary;
    // shared inbox stream → dispatch only our kind.
    for (const command of commands) {
      if (command.kind !== BUILD_KIND) continue;
      if (!command.data) throw new Error("build requires command data");
      const parsed = parseBuildData(command.data);
      if (!getBuildingSiteRow(world, comps, parsed.siteEid)) {
        throw new Error(
          `build command targets entity ${String(parsed.siteEid)}, which has no BuildingSite row`,
        );
      }
      const posRows = world.rowsByComponentId.get(comps.positionId);
      const velRows = world.rowsByComponentId.get(comps.velocityId);
      const tagRows = world.rowsByComponentId.get(comps.unitTagId);
      for (const eid of parsed.entityIds) {
        const posRow = posRows?.get(eid);
        const velRow = velRows?.get(eid);
        const tagRow = tagRows?.get(eid);
        if (!posRow || !velRow || !tagRow) continue; // not a live unit
        // Re-tasking replaces any prior job (AoE2 order semantics):
        // without this, a gatherer keeps its AssignedNode row and the
        // gather system re-plans chop legs against the site walk.
        clearAssignedNode(world, comps, eid);
        const queue = readActivityQueue(world, comps, eid);
        cancelActivities(queue);
        writeActivityQueue(world, comps, eid, queue);
        assignSite(world, comps, eid, parsed.siteEid);
        resetSteeringBookkeeping(velRow);
      }
      diagnostics.commandsApplied += 1;
    }

    // ---- 2) Group assigned builders per live site, ascending eid.
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    const groupsBySite = new Map<number, SiteWorkGroup>();

    for (const eid of world.entities) {
      const siteEid = getAssignedSite(world, comps, eid);
      if (siteEid === undefined) continue;
      const posRow = posRows?.get(eid);
      const tagRow = tagRows?.get(eid);
      if (!posRow || !tagRow) continue;
      const siteRow = getBuildingSiteRow(world, comps, siteEid);
      const sitePos = posRows?.get(siteEid);
      if (!siteRow || !sitePos) {
        // Site completed under our feet last tick: release quietly.
        clearAssignedSite(world, comps, eid);
        continue;
      }
      let group = groupsBySite.get(siteEid);
      if (!group) {
        const def = buildingDefOf(buildingIdOfCode(siteRow[1]!));
        const width = def.footprint.width;
        const height = def.footprint.height;
        // The row-store arrays are mutable; the component getter only
        // widens them read-only for external callers.
        group = {
          siteEid,
          row: siteRow as number[],
          center: { x: sitePos[0]!, y: sitePos[1]! },
          rect: {
            x: sitePos[0]! - width / 2,
            y: sitePos[1]! - height / 2,
            width,
            height,
          },
          builders: [],
        };
        groupsBySite.set(siteEid, group);
      }
      group.builders.push({
        eid,
        x: posRow[0]!,
        y: posRow[1]!,
        velRow: velRows?.get(eid),
      });
    }

    // ---- 3) Advance each site (ascending eid).
    const rangeSq = BUILD_WORK_RANGE_TILES * BUILD_WORK_RANGE_TILES;
    const siteEids = [...groupsBySite.keys()].sort((a, b) => a - b);

    for (const siteEid of siteEids) {
      const group = groupsBySite.get(siteEid)!;
      const totalNeeded =
        buildingDefOf(buildingIdOfCode(group.row[1]!)).buildTime *
        WORK_MILLI_SCALE;

      // 3a) In-range builders add diminishing fixed-point progress;
      // the contributing rank counts ONLY in-range builders so walking
      // stragglers never consume a better helper's weight tier. Range
      // measures from the FOOTPRINT EDGE: adjacency is the working
      // contract, and center-based distance strands builders whose
      // approach door (blocked-terrain corrected) lands past the
      // center-radius while hugging a corner of the site.
      let milliThisTick = 0;
      let contributingRank = 0;
      for (const builder of group.builders) {
        if (rectDistanceSq(builder.x, builder.y, group.rect) <= rangeSq) {
          milliThisTick += builderWorkMilliPerTick(contributingRank);
          contributingRank += 1;
        }
      }

      // M2-T3 tool bonus: holding any tools speeds this site's work and
      // drains them on the deterministic period boundary. A player
      // without a commodity ledger simply counts as tool-less.
      if (
        milliThisTick > 0 &&
        commodityAmountOfOrZero(world, comps, group.row[0]!, COMMODITY_TOOLS) >
          0
      ) {
        milliThisTick = Math.floor(
          (milliThisTick * TOOLS_BOOST_NUMERATOR) / TOOLS_BOOST_DENOMINATOR,
        );
        diagnostics.boostedSiteTicks += 1;
        if (world.tick % TOOLS_CONSUME_PERIOD_TICKS === 0) {
          withdrawCommodityFromStockpile(
            world,
            comps,
            group.row[0]!,
            COMMODITY_TOOLS,
            1,
          );
          diagnostics.toolsConsumed += 1;
        }
      }

      if (milliThisTick > 0) {
        group.row[2] = Math.min(totalNeeded, group.row[2]! + milliThisTick);
      }

      // 3b) Planning pass (ascending eid): fill idle, out-of-range
      // queues with a walk to their nearest approach point.
      for (const builder of group.builders) {
        const inRange =
          rectDistanceSq(builder.x, builder.y, group.rect) <= rangeSq;
        if (!inRange) {
          const queue = readActivityQueue(world, comps, builder.eid);
          if (peekActivity(queue) === undefined) {
            const door = approachPoint(
              world,
              group.rect,
              0.75,
              builder.x,
              builder.y,
            );
            enqueueActivity(queue, moveActivity([door.x, door.y]));
            writeActivityQueue(world, comps, builder.eid, queue);
            setMoveTarget(world, comps, builder.eid, door.x, door.y);
            if (builder.velRow) resetSteeringBookkeeping(builder.velRow);
          }
        }
      }

      // 3c) Completion check AFTER this tick's progress lands.
      if (group.row[2]! >= totalNeeded) {
        completeBuilding(world, comps, siteEid);
        diagnostics.completions += 1;
        for (const builder of group.builders) {
          clearAssignedSite(world, comps, builder.eid);
          const queue = readActivityQueue(world, comps, builder.eid);
          cancelActivities(queue); // stop mid-flight approaches dead
          writeActivityQueue(world, comps, builder.eid, queue);
        }
      }
    }
  };
}

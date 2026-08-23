/**
 * Fog-of-war visibility seam — SPEC §2.9 / M1-T11 stub + M2-T8 planes.
 *
 * Consumers ask questions through {@link VisibilityProvider}; producers
 * are notified of entity changes through the markDirty hooks and drain
 * them with flushDirty() after movement, before the tick-boundary
 * commit (world.step). M2 ships the real plane set behind the SAME
 * interface — consumers never changed, only the implementation handed
 * to world creation did.
 *
 * M2-T8 architecture (SPEC §2.9):
 *  - One sim-level {@link FogState} singleton per world: per-player
 *    `explored`/`visible` Uint8Array(size²) planes plus a
 *    `contributorCount` Uint16Array — world-sized state, deliberately
 *    NOT components, so digests/save sections are untouched by fog.
 *  - Dirty-entity incremental stamping: sight circles un-stamp/stamp
 *    through precomputed circle-offset LUTs (radius 0–16, Euclidean ≤ r,
 *    edge-clamped, no wrap). `explored` is OR-ed in during stamps and
 *    never decremented. Full recompute happens ONLY on map gen and
 *    save/load ({@link FogVisibilityHandle.recomputeAll}).
 *  - Sight radii come from Entity definitions via the row resolver;
 *    plain UnitTag-only units use the villager baseline (5).
 *  - {@link KnowledgeView} exposes curated knowledge to AI/queries:
 *    enemies standing on non-visible tiles are structurally absent —
 *    the interface has no API to ask about them (SPEC §2.8).
 *  - Memory ghosts: enemy buildings leaving visibility stay recorded
 *    `{entityId → lastKnownTile, defId}` until re-sighted or observed
 *    destroyed; invisible to combat/sim, exposed via KnowledgeView.
 *
 * Coordinates are integer tile coordinates (SPEC §2.1 grid); tiles off
 * the [0,size) grid answer false for both queries.
 *
 * Purity: like everything under sim/, implementations may not read the
 * clock or Math.random — fog state is deterministic simulation state.
 */

import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
  unitIdOfCode,
} from "../../data/definitions";
import type { SimComponents } from "../components";
import { ownerOfUnit } from "../components/owner";
import type { World } from "../core/world";

/** Why an entity was flagged for the next dirty flush (SPEC §2.9). */
export type FogDirtyReason = "spawned" | "moved" | "removed";

/**
 * The one visibility seam (§2.9 planes + §2.8 KnowledgeView share this
 * surface). Consumers ask questions; producers are notified of entity
 * changes through the markDirty hooks and drain them with flushDirty()
 * after movement, before the tick-boundary commit.
 */
export interface VisibilityProvider {
  /** Stable label for telemetry/diagnostics (e.g. "all-visible"). */
  readonly id: string;
  /** True when `player` currently sees tile (tileX, tileY). */
  isVisible(tileX: number, tileY: number, player: number): boolean;
  /** True when `player` has ever seen tile (tileX, tileY). */
  isExplored(tileX: number, tileY: number, player: number): boolean;
  /** Queue a spawned/moved/removed entity for the next flush. */
  markDirty(reason: FogDirtyReason, eid: number): void;
  /**
   * Apply all queued dirty stamps/un-stamps. Called by the sim once per
   * tick after movement; implementations MUST tolerate being called
   * with nothing queued.
   */
  flushDirty(): void;
}

/**
 * The M1 stub: every on-grid tile explored + visible for every player;
 * dirty hooks accept anything and discard it. Kept as the default for
 * legacy fixtures and fog-blind tests; production hands the real
 * {@link createFogVisibility} planes to world creation instead.
 */
export function createAllVisibleProvider(size: number): VisibilityProvider {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `fog grid size must be a positive integer, got ${String(size)}`,
    );
  }
  const onGrid = (tileX: number, tileY: number): boolean =>
    Number.isInteger(tileX) &&
    Number.isInteger(tileY) &&
    tileX >= 0 &&
    tileY >= 0 &&
    tileX < size &&
    tileY < size;
  return {
    id: "all-visible",
    isVisible: (tileX, tileY) => onGrid(tileX, tileY),
    isExplored: (tileX, tileY) => onGrid(tileX, tileY),
    markDirty: () => {},
    flushDirty: () => {},
  };
}

// ---- M2-T8: real planes -------------------------------------------------------

/** Circle-offset LUTs are precomputed for radii 0..16 (SPEC §2.9). */
export const FOG_LUT_MAX_RADIUS = 16;

/**
 * Sight radius assumed for units that carry no definition reference
 * (plain UnitTag rows spawn without a def code today). This is the
 * villager baseline from SPEC §2.9's sight-radius table.
 */
export const DEFAULT_UNIT_SIGHT_RADIUS = 5;
/** defId reported alongside the default sight radius. */
export const DEFAULT_UNIT_DEF_ID = "villager";

export interface FogPlayerPlanes {
  /** Ever-seen flag per tile — OR-ed in by stamps, never decremented. */
  readonly explored: Uint8Array;
  /** Currently-seen flag per tile — derived from contributor counts. */
  readonly visible: Uint8Array;
  /** How many live sight circles cover each tile (drives `visible`). */
  readonly contributorCount: Uint16Array;
}

export interface FogState {
  /** Grid edge length in tiles. */
  readonly size: number;
  /** Player count (M2 skirmish = 2). */
  readonly playerCount: number;
  /** Planes indexed by player id. */
  readonly planes: readonly FogPlayerPlanes[];
}

/**
 * Allocate the world-sized fog singleton. Binary planes only — all
 * smoothing is render-side (SPEC §2.9).
 */
export function createFogState(size: number, playerCount = 2): FogState {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `fog grid size must be a positive integer, got ${String(size)}`,
    );
  }
  if (!Number.isInteger(playerCount) || playerCount <= 0) {
    throw new Error(
      `fog player count must be a positive integer, got ${String(playerCount)}`,
    );
  }
  const tiles = size * size;
  return {
    size,
    playerCount,
    planes: Array.from({ length: playerCount }, () => ({
      explored: new Uint8Array(tiles),
      visible: new Uint8Array(tiles),
      contributorCount: new Uint16Array(tiles),
    })),
  };
}

/**
 * Precomputed Euclidean circle-offset LUTs: offsets[r] packs (dx, dy)
 * pairs row-major for every tile with dx²+dy² ≤ r². Built once per
 * process for radii 0..FOG_LUT_MAX_RADIUS and memoized.
 */
const CIRCLE_OFFSET_LUTS: (Int32Array | undefined)[] = [];

export function circleOffsets(radius: number): Int32Array {
  if (!Number.isInteger(radius) || radius < 0 || radius > FOG_LUT_MAX_RADIUS) {
    throw new Error(
      `sight radius must be an integer in [0, ${String(FOG_LUT_MAX_RADIUS)}], got ${String(radius)}`,
    );
  }
  const cached = CIRCLE_OFFSET_LUTS[radius];
  if (cached) return cached;
  const pairs: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        pairs.push(dx, dy);
      }
    }
  }
  const lut = Int32Array.from(pairs);
  CIRCLE_OFFSET_LUTS[radius] = lut;
  return lut;
}

function clampTile(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value;
}

/**
 * Stamp one sight circle: visible/contributor increments plus explored
 * OR-in. Edge-clamped at the grid border, never wrapping.
 */
export function stampSightCircle(
  state: FogState,
  player: number,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const plane = state.planes[player];
  if (!plane) throw new Error(`unknown fog player: ${String(player)}`);
  const size = state.size;
  const cx = clampTile(centerX, size);
  const cy = clampTile(centerY, size);
  const offsets = circleOffsets(radius);
  for (let i = 0; i < offsets.length; i += 2) {
    const x = cx + offsets[i]!;
    const y = cy + offsets[i + 1]!;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const index = y * size + x;
    plane.visible[index] = 1;
    const count = plane.contributorCount[index]!;
    if (count < 0xffff) plane.contributorCount[index] = count + 1;
    plane.explored[index] = 1;
  }
}

/**
 * Remove one previously stamped sight circle: decrement contributors;
 * a tile drops out of `visible` exactly when its count reaches zero.
 */
export function unstampSightCircle(
  state: FogState,
  player: number,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const plane = state.planes[player];
  if (!plane) throw new Error(`unknown fog player: ${String(player)}`);
  const size = state.size;
  const cx = clampTile(centerX, size);
  const cy = clampTile(centerY, size);
  const offsets = circleOffsets(radius);
  for (let i = 0; i < offsets.length; i += 2) {
    const x = cx + offsets[i]!;
    const y = cy + offsets[i + 1]!;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const index = y * size + x;
    const count = plane.contributorCount[index]!;
    if (count === 0) continue; // defensive: never decrement below zero
    plane.contributorCount[index] = count - 1;
    if (count === 1) plane.visible[index] = 0;
  }
}

/** Count of currently-visible tiles for one player (diagnostics/tests). */
export function visibleTileCount(state: FogState, player: number): number {
  let total = 0;
  for (const flag of state.planes[player]!.visible) total += flag;
  return total;
}

/** Count of ever-explored tiles for one player (diagnostics/tests). */
export function exploredTileCount(state: FogState, player: number): number {
  let total = 0;
  for (const flag of state.planes[player]!.explored) total += flag;
  return total;
}

// ---- Entity records & row resolver --------------------------------------------

/** What the fog knows about one sight-contributing entity, snapshot. */
export interface FogEntityRecord {
  /** Owning entity id. */
  readonly eid: number;
  /** Sight-circle center tile (floor of the entity position). */
  readonly tileX: number;
  readonly tileY: number;
  /** Definition sight radius (villager baseline for tag-only units). */
  readonly sightRadius: number;
  /** Owning player id. */
  readonly owner: number;
  /** Stable definition slug (KnowledgeView payloads carry it). */
  readonly defId: string;
  /** Units re-stamp while moving; buildings ghost when unseen. */
  readonly kind: "unit" | "building";
  /** Footprint origin + extent (1×1 for units). */
  readonly originX: number;
  readonly originY: number;
  readonly footWidth: number;
  readonly footHeight: number;
}

/** Reads the live fog-relevant row bundle for one eid (or undefined). */
export type FogEntityResolver = (eid: number) => FogEntityRecord | undefined;

/** Live-entity access handed to the fog handle at bind time. */
export interface FogEntitySource {
  readonly resolve: FogEntityResolver;
  /** Live entity ids ascending (world.entities at call time). */
  readonly eidsAscending: () => readonly number[];
}

/**
 * Row-reading resolver over a bound world + components. Resolution
 * order: finished Building → BuildingSite → Combat (unit code + owner)
 * → bare UnitTag (player-one villager baseline). Entities with none of
 * those rows (resource nodes, rubble, ledgers) contribute no sight.
 */
export function createRowEntityResolver(
  world: World,
  comps: SimComponents,
): FogEntityResolver {
  return (eid: number): FogEntityRecord | undefined => {
    const rows = world.rowsByComponentId;
    const pos = rows.get(comps.positionId)?.get(eid);
    if (!pos) return undefined;
    const size = world.layers.size;
    const buildingRow =
      rows.get(comps.buildingId)?.get(eid) ??
      rows.get(comps.buildingSiteId)?.get(eid);
    if (buildingRow) {
      const defId = buildingIdOfCode(buildingRow[1]!);
      const def = buildingDefOf(defId);
      return {
        eid,
        tileX: clampTile(Math.floor(pos[0]!), size),
        tileY: clampTile(Math.floor(pos[1]!), size),
        sightRadius: Math.round(def.sightRadius),
        owner: buildingRow[0]!,
        defId,
        kind: "building",
        originX: Math.floor(pos[0]! - def.footprint.width / 2),
        originY: Math.floor(pos[1]! - def.footprint.height / 2),
        footWidth: def.footprint.width,
        footHeight: def.footprint.height,
      };
    }
    const combatRow = rows.get(comps.combatId)?.get(eid);
    if (combatRow) {
      const defId = unitIdOfCode(combatRow[0]!);
      const def = unitDefOf(defId);
      return {
        eid,
        tileX: clampTile(Math.floor(pos[0]!), size),
        tileY: clampTile(Math.floor(pos[1]!), size),
        sightRadius: Math.round(def.sightRadius),
        owner: combatRow[1]!,
        defId,
        kind: "unit",
        originX: Math.floor(pos[0]!),
        originY: Math.floor(pos[1]!),
        footWidth: 1,
        footHeight: 1,
      };
    }
    if (rows.get(comps.unitTagId)?.get(eid)) {
      return {
        eid,
        tileX: clampTile(Math.floor(pos[0]!), size),
        tileY: clampTile(Math.floor(pos[1]!), size),
        sightRadius: DEFAULT_UNIT_SIGHT_RADIUS,
        // M2-T9: rowless legacy villagers read as player zero (see
        // components/owner.ts); AI-owned villagers carry explicit rows.
        owner: ownerOfUnit(world, comps, eid),
        defId: DEFAULT_UNIT_DEF_ID,
        kind: "unit",
        originX: Math.floor(pos[0]!),
        originY: Math.floor(pos[1]!),
        footWidth: 1,
        footHeight: 1,
      };
    }
    return undefined;
  };
}

// ---- KnowledgeView (SPEC §2.8) -------------------------------------------------

/** One entity an AI/viewer legitimately knows about, right now. */
export interface KnownEntitySnapshot {
  readonly eid: number;
  readonly defId: string;
  /** Current known tile (units: center tile; buildings: origin tile). */
  readonly tileX: number;
  readonly tileY: number;
  /**
   * Owning player (M2-T9): lets the AI split its own roster from
   * visible enemies without any raw-row access. Enemies on non-visible
   * tiles never reach this snapshot regardless.
   */
  readonly owner: number;
}

/** Memory record for an enemy building no longer under observation. */
export interface GhostBuildingRecord {
  readonly eid: number;
  readonly defId: string;
  /** Last observed footprint-origin tile. */
  readonly tileX: number;
  readonly tileY: number;
}

/**
 * The AI/query knowledge surface (SPEC §2.8 "fog honesty, structural").
 * Built from fog planes + fog bookkeeping ONLY — it carries no World or
 * component-row reference, so there is literally no API through which
 * to ask about entities standing outside the viewer's vision.
 */
export interface KnowledgeView {
  readonly viewer: number;
  isVisible(tileX: number, tileY: number): boolean;
  isExplored(tileX: number, tileY: number): boolean;
  /**
   * Own entities (always) plus enemy entities whose current tile is
   * visible, ascending eid. Enemies on non-visible tiles never appear.
   */
  knownEntities(): readonly KnownEntitySnapshot[];
  /** Last-known record for an enemy building (live-sighted or ghost). */
  lastKnown(enemyEid: number): GhostBuildingRecord | undefined;
}

// ---- The real provider handle ---------------------------------------------------

/**
 * Everything the sim/renderer/AI touch, created BEFORE the world so the
 * provider can be handed to createWorld, then bound to component rows
 * once they exist. `revision` bumps on every flush/recompute — the
 * renderer's fog-dirty signal.
 */
export interface FogVisibilityHandle {
  /** Hand this to createWorld({ visibility }). */
  readonly provider: VisibilityProvider;
  readonly state: FogState;
  /** Monotonic counter bumped whenever the planes change. */
  revision: number;
  /** Bind row access (after defineSimComponents). Required to flush. */
  bindSource(source: FogEntitySource): void;
  /**
   * Zero the planes, drop all stamps/knowledge and stamp every live
   * entity — map-gen and save/load path ONLY (SPEC §2.9).
   */
  recomputeAll(): void;
  isVisible(tileX: number, tileY: number, player: number): boolean;
  isExplored(tileX: number, tileY: number, player: number): boolean;
  /** Curated knowledge surface for one viewer (AI/replay/observer). */
  knowledgeFor(viewer: number): KnowledgeView;
}

/**
 * Build the real M2 fog: per-player planes + contributor counts behind
 * the unchanged VisibilityProvider seam, dirty-entity incremental
 * stamping via LUT circles, and memory ghosts for enemy buildings.
 */
export function createFogVisibility(
  size: number,
  playerCount = 2,
): FogVisibilityHandle {
  const state = createFogState(size, playerCount);
  let source: FogEntitySource | undefined;
  let revision = 0;
  /** eid → last-stamped record (drives un-stamp on move/removal). */
  const stamped = new Map<number, FogEntityRecord>();
  /** Queued dirty eids in arrival order; deduped at flush. */
  const dirtyQueue: number[] = [];
  /** viewer → eid → last-known enemy-building record (ghosts). */
  const knownBuildings: Map<
    number,
    Map<number, GhostBuildingRecord>
  > = new Map();
  for (let player = 0; player < playerCount; player++) {
    knownBuildings.set(player, new Map());
  }

  const assertPlayer = (player: number): void => {
    if (!Number.isInteger(player) || player < 0 || player >= playerCount) {
      throw new Error(`unknown fog player: ${String(player)}`);
    }
  };

  const onGrid = (tileX: number, tileY: number): boolean =>
    Number.isInteger(tileX) &&
    Number.isInteger(tileY) &&
    tileX >= 0 &&
    tileY >= 0 &&
    tileX < size &&
    tileY < size;

  const isVisible = (tileX: number, tileY: number, player: number): boolean => {
    assertPlayer(player);
    if (!onGrid(tileX, tileY)) return false;
    return state.planes[player]!.visible[tileY * size + tileX] === 1;
  };

  const isExplored = (
    tileX: number,
    tileY: number,
    player: number,
  ): boolean => {
    assertPlayer(player);
    if (!onGrid(tileX, tileY)) return false;
    return state.planes[player]!.explored[tileY * size + tileX] === 1;
  };

  /** A sight circle lands ONLY on its owner's planes (SPEC §2.9). */
  const stampRecord = (record: FogEntityRecord): void => {
    stampSightCircle(
      state,
      record.owner,
      record.tileX,
      record.tileY,
      record.sightRadius,
    );
    stamped.set(record.eid, record);
  };

  const unstampRecord = (record: FogEntityRecord): void => {
    unstampSightCircle(
      state,
      record.owner,
      record.tileX,
      record.tileY,
      record.sightRadius,
    );
  };

  /** True when any footprint tile of `record` is visible to `viewer`. */
  const footprintVisibleTo = (
    viewer: number,
    record: FogEntityRecord,
  ): boolean => {
    for (let dy = 0; dy < record.footHeight; dy++) {
      for (let dx = 0; dx < record.footWidth; dx++) {
        if (isVisible(record.originX + dx, record.originY + dy, viewer)) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Ghost pass, run after every flush: refresh knowledge entries for
   * enemy buildings currently under observation; stale entries persist
   * as memory ghosts until re-sighted or the entity dies.
   */
  const updateKnowledgePass = (): void => {
    if (!source) return;
    for (const [eid, record] of stamped) {
      if (record.kind !== "building") continue;
      for (let viewer = 0; viewer < playerCount; viewer++) {
        if (record.owner === viewer) continue;
        if (footprintVisibleTo(viewer, record)) {
          knownBuildings.get(viewer)!.set(eid, {
            eid,
            defId: record.defId,
            tileX: record.originX,
            tileY: record.originY,
          });
        }
        // Not visible now: leave any existing entry untouched (ghost).
      }
    }
  };

  const flushDirty = (): void => {
    if (dirtyQueue.length === 0) return;
    if (!source) {
      throw new Error(
        "fog visibility flushed before bindSource — bind rows right after defineSimComponents",
      );
    }
    const seen = new Set<number>();
    for (const eid of dirtyQueue) {
      if (seen.has(eid)) continue;
      seen.add(eid);
      const previous = stamped.get(eid);
      const current = source.resolve(eid);
      if (
        previous !== undefined &&
        current !== undefined &&
        sameStamp(previous, current)
      ) {
        continue; // same tile/radius/owner: nothing observable changed
      }
      if (previous) {
        unstampRecord(previous);
        stamped.delete(eid);
      }
      if (current) {
        stampRecord(current);
      } else {
        // Observed destruction: memory ghosts die with their building.
        for (const map of knownBuildings.values()) map.delete(eid);
      }
    }
    dirtyQueue.length = 0;
    updateKnowledgePass();
    revision += 1;
  };

  /** Position+radius+owner equality — a same-tile restamp is a no-op. */
  function sameStamp(a: FogEntityRecord, b: FogEntityRecord): boolean {
    return (
      a.tileX === b.tileX &&
      a.tileY === b.tileY &&
      a.sightRadius === b.sightRadius &&
      a.owner === b.owner
    );
  }

  const provider: VisibilityProvider = {
    id: "fog-planes",
    isVisible,
    isExplored,
    markDirty(reason, eid) {
      void reason;
      if (!Number.isInteger(eid) || eid < 1) {
        throw new Error(
          `fog markDirty requires a positive entity id, got ${String(eid)}`,
        );
      }
      dirtyQueue.push(eid);
    },
    flushDirty,
  };

  return {
    provider,
    state,
    get revision(): number {
      return revision;
    },
    bindSource(bound: FogEntitySource): void {
      source = bound;
    },
    recomputeAll() {
      for (const plane of state.planes) {
        plane.explored.fill(0);
        plane.visible.fill(0);
        plane.contributorCount.fill(0);
      }
      stamped.clear();
      dirtyQueue.length = 0;
      for (const map of knownBuildings.values()) map.clear();
      if (source) {
        for (const eid of source.eidsAscending()) {
          const record = source.resolve(eid);
          if (record) stampRecord(record);
        }
        updateKnowledgePass();
      }
      revision += 1;
    },
    isVisible,
    isExplored,
    knowledgeFor(viewer: number): KnowledgeView {
      assertPlayer(viewer);
      const known = knownBuildings.get(viewer)!;
      return {
        viewer,
        isVisible: (tileX, tileY) => isVisible(tileX, tileY, viewer),
        isExplored: (tileX, tileY) => isExplored(tileX, tileY, viewer),
        knownEntities(): KnownEntitySnapshot[] {
          const out: KnownEntitySnapshot[] = [];
          for (const [eid, record] of stamped) {
            const own = record.owner === viewer;
            if (!own && !isVisible(record.tileX, record.tileY, viewer)) {
              continue; // wallhack-proof: no query exists past this gate
            }
            out.push({
              eid,
              defId: record.defId,
              tileX: own ? record.tileX : record.originX,
              tileY: own ? record.tileY : record.originY,
              owner: record.owner,
            });
          }
          out.sort((a, b) => a.eid - b.eid);
          return out;
        },
        lastKnown(enemyEid: number): GhostBuildingRecord | undefined {
          const entry = known.get(enemyEid);
          return entry ? { ...entry } : undefined;
        },
      };
    },
  };
}

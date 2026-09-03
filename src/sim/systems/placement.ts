/**
 * Building placement system — SPEC §2.6/§2.13 / M1-T10.
 *
 * Consumes `{kind:"placeBuilding", data:{defId, tileX, tileY}}`
 * commands at their absolute target tick and, when the footprint is
 * valid, performs the whole AoE2-faithful placement event:
 *
 *   1. validate footprint — in-bounds, every tile passable (not
 *      water), no overlapping building/site, no resource node
 *      (explored-stub always true in M1)
 *   2. pay the FULL definition cost up front from the owner's
 *      stockpile row (escrow model: money leaves the bank at
 *      placement, never at completion)
 *   3. create the construction-site entity (components/buildings.ts)
 *   4. block the footprint tiles IMMEDIATELY and bump the path
 *      scheduler's passabilityVersion — AoE2 blocks at placement, so
 *      mid-path villagers repath the same tick the site appears
 *      (ADR-0003 invalidation). Completion later changes NO passability
 *      and therefore performs no further bump.
 *
 * Invalid commands THROW loudly (matching gather-command discipline):
 * the build menu gates what the player can issue, so a rejection here
 * means a caller bypassed the shared validity function below.
 */

import {
  footprintTiles,
  rectsOverlap,
  siteRectOf,
  buildingRectOf,
  spawnBuildingSite,
  completeBuilding,
  type FootprintRect,
} from "../components/buildings";
import type { SimComponents } from "../components";
import { getResourceNodeRow } from "../components/economy";
import { appendGateRejection, GATE_HANDLER_PLACE } from "../components/age";
import { buildingCodeOf, buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import { canAffordCosts, payCosts } from "./costs";
import { isDefAgeUnlocked } from "./age";
import { IMPASSABLE, PASSABLE, isWaterTerrain } from "../world/layers";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kind owned by this system. */
export const PLACE_BUILDING_KIND = "placeBuilding";

/** Why a placement was rejected — surfaced verbatim by the ghost UI. */
export type PlacementRejection =
  | "unknown-def"
  | "out-of-bounds"
  | "water"
  | "blocked-tile"
  | "occupied"
  | "unexplored"
  | "age-gated";

export interface PlacementCheck {
  readonly ok: boolean;
  readonly reason?: PlacementRejection;
  readonly rect?: FootprintRect;
}

export interface PlacementDiagnostics {
  /** placeBuilding commands applied. */
  commandsApplied: number;
  /** Polite age-gate refusals (digest-visible GateRejected rows). */
  gateRejections: number;
}

export function createPlacementDiagnostics(): PlacementDiagnostics {
  return { commandsApplied: 0, gateRejections: 0 };
}

/** Options tuning the shared validity verdict for special callers. */
export interface ValidatePlacementOptions {
  /**
   * Scenario editors and test fixtures stamp finished buildings of ANY
   * age (bootstrap privilege); gameplay commands never set this.
   */
  readonly ignoreAgeGate?: boolean | undefined;
  /**
   * Scenario editors and test fixtures also stage content OUTSIDE the
   * placing player's explored area (M2-T8); gameplay commands never
   * set this — §2.9 keeps the explored gate for them.
   */
  readonly ignoreFog?: boolean | undefined;
}

function parsePlaceData(data: Readonly<Record<string, unknown>>): {
  defId: string;
  tileX: number;
  tileY: number;
  playerId: number;
} {
  const defId = data.defId;
  if (typeof defId !== "string" || defId.length === 0) {
    throw new Error("placeBuilding requires a non-empty defId string");
  }
  const tileX = data.tileX;
  const tileY = data.tileY;
  if (
    typeof tileX !== "number" ||
    !Number.isInteger(tileX) ||
    typeof tileY !== "number" ||
    !Number.isInteger(tileY)
  ) {
    throw new Error("placeBuilding requires integer tileX/tileY coordinates");
  }
  const rawPlayer = data.playerId ?? 0;
  if (
    typeof rawPlayer !== "number" ||
    !Number.isInteger(rawPlayer) ||
    rawPlayer < 0
  ) {
    throw new Error("placeBuilding playerId must be a non-negative integer");
  }
  return { defId, tileX, tileY, playerId: rawPlayer };
}

/** True when any resource node sits on one of the candidate tiles. */
function nodeOnAnyTile(
  world: World,
  comps: SimComponents,
  tiles: readonly { x: number; y: number }[],
): boolean {
  const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!nodeRows || !posRows) return false;
  for (const [eid] of nodeRows) {
    if ((getResourceNodeRow(world, comps, eid)?.[1] ?? 0) <= 0) continue;
    const pos = posRows.get(eid);
    if (!pos) continue;
    const nx = Math.floor(pos[0]!);
    const ny = Math.floor(pos[1]!);
    if (tiles.some((tile) => tile.x === nx && tile.y === ny)) return true;
  }
  return false;
}

/** True when any existing site/building overlaps the candidate rect. */
function buildingOverlap(
  world: World,
  comps: SimComponents,
  rect: FootprintRect,
): boolean {
  for (const eid of world.entities) {
    const other =
      siteRectOf(world, comps, eid) ?? buildingRectOf(world, comps, eid);
    if (other && rectsOverlap(rect, other)) return true;
  }
  return false;
}

/**
 * Shared placement-validity function — ONE source of truth consumed by
 * the command handler AND the green/red ghost overlay, so the UI can
 * never offer what the sim would reject. Pure: reads rows/layers only.
 *
 * Age gate (SPEC §3): a definition whose ageGate outranks the owner's
 * current age reports "age-gated" before any geometry — AoE2 greys the
 * whole building, not just some sites.
 */
export function validatePlacement(
  world: World,
  comps: SimComponents,
  defId: string,
  tileX: number,
  tileY: number,
  playerId: number = 0,
  options: ValidatePlacementOptions = {},
): PlacementCheck {
  let def;
  try {
    def = buildingDefOf(defId);
  } catch {
    return { ok: false, reason: "unknown-def" };
  }
  if (
    !options.ignoreAgeGate &&
    !isDefAgeUnlocked(world, comps, playerId, def.ageGate)
  ) {
    return { ok: false, reason: "age-gated" };
  }
  const rect: FootprintRect = {
    x: tileX,
    y: tileY,
    width: def.footprint.width,
    height: def.footprint.height,
  };
  // 1) Pure geometry first.
  const size = world.layers.size;
  for (const tile of footprintTiles(tileX, tileY, rect.width, rect.height)) {
    if (tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size) {
      return { ok: false, reason: "out-of-bounds", rect };
    }
  }
  // 2) Occupancy next (buildings/sites/nodes): overlapping an existing
  // footprint always also hits its blocked tiles, and "occupied" is the
  // more actionable verdict for the ghost UI.
  if (
    nodeOnAnyTile(
      world,
      comps,
      footprintTiles(tileX, tileY, rect.width, rect.height),
    ) ||
    buildingOverlap(world, comps, rect)
  ) {
    return { ok: false, reason: "occupied", rect };
  }
  // 3) Passability last: remaining blockers are terrain.
  const terrain = world.layers.terrainType;
  const passability = world.layers.derivedPassability;
  for (const tile of footprintTiles(tileX, tileY, rect.width, rect.height)) {
    const index = tile.y * size + tile.x;
    if (passability[index] !== 1) {
      return {
        ok: false,
        reason: isWaterTerrain(terrain[index]!) ? "water" : "blocked-tile",
        rect,
      };
    }
  }
  // 4) Fog gate (SPEC §2.9): placement requires EXPLORED tiles. The
  // rule consults only the provider seam, so the M1 all-visible stub
  // trivially passed it everywhere on-grid and M2's real planes flip
  // behavior without touching this call-site.
  if (!options.ignoreFog) {
    for (const tile of footprintTiles(tileX, tileY, rect.width, rect.height)) {
      if (!world.visibility.isExplored(tile.x, tile.y, playerId)) {
        return { ok: false, reason: "unexplored", rect };
      }
    }
  }
  return { ok: true, rect };
}

/** True when the owner's stockpile can cover the full definition cost. */
export function canAfford(
  world: World,
  comps: Pick<SimComponents, "stockpileId">,
  playerId: number,
  defId: string,
): boolean {
  const def = buildingDefOf(defId);
  return canAffordCosts(world, comps, playerId, def.costs);
}

/**
 * Atomically debit the full definition cost from the owner's stockpile
 * row — the escrow model: resources leave the bank at PLACEMENT, never
 * at completion (AoE2-faithful; SPEC §2.6 core loop).
 */
function payCostUpFront(
  world: World,
  comps: Pick<SimComponents, "stockpileId">,
  playerId: number,
  defId: string,
): void {
  const def = buildingDefOf(defId);
  payCosts(world, comps, playerId, def.costs, `placement of ${def.id}`);
}

/**
 * Block one rect's footprint tiles and bump the path scheduler's
 * passabilityVersion — the AoE2 "blocks at placement" rule every site
 * birth shares (player commands below AND the §2.7 company-expansion
 * execution in systems/companies.ts). Mid-path villagers repath the
 * same tick the footprint appears (ADR-0003 invalidation).
 */
/**
 * Traces a contiguous 8-way grid line of 1x1 wall tiles from (startX, startY)
 * to (endX, endY) using Bresenham's line algorithm.
 */
export interface TileCoord {
  readonly x: number;
  readonly y: number;
}

export function traceWallRun(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): TileCoord[] {
  const points: TileCoord[] = [];
  const dx = Math.abs(endX - startX);
  const dy = Math.abs(endY - startY);
  const sx = startX < endX ? 1 : -1;
  const sy = startY < endY ? 1 : -1;
  let err = dx - dy;

  let currX = startX;
  let currY = startY;

  while (true) {
    points.push({ x: currX, y: currY });
    if (currX === endX && currY === endY) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      currX += sx;
    }
    if (e2 < dx) {
      err += dx;
      currY += sy;
    }
  }
  return points;
}

/**
 * Return the passability grid for a specific player:
 * - By default, all walls, buildings, water, and enemy gates are IMPASSABLE (0).
 * - For gates owned by `playerId`, those tiles are set to PASSABLE (1),
 *   allowing the owner's units to walk through their own gates.
 */
export function passabilityForPlayer(
  world: World,
  comps: { buildingId: number; buildingSiteId?: number | undefined; positionId?: number | undefined },
  playerId: number,
): Uint8Array {
  const size = world.layers.size;
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  const siteRows = comps.buildingSiteId !== undefined
    ? world.rowsByComponentId.get(comps.buildingSiteId)
    : undefined;

  const friendlyGateTiles: Array<{ x: number; y: number }> = [];

  if (buildingRows) {
    for (const [, row] of buildingRows) {
      const owner = row[0]!;
      if (owner !== playerId) continue;
      const defCode = row[1]!;
      const def = buildingDefOf(buildingIdOfCode(defCode));
      if (!def.isGate) continue;
      const originX = row[2]!;
      const originY = row[3]!;
      for (let dy = 0; dy < def.footprint.height; dy++) {
        for (let dx = 0; dx < def.footprint.width; dx++) {
          friendlyGateTiles.push({ x: originX + dx, y: originY + dy });
        }
      }
    }
  }

  if (siteRows) {
    for (const [eid, row] of siteRows) {
      const owner = row[0]!;
      if (owner !== playerId) continue;
      const defCode = row[1]!;
      const def = buildingDefOf(buildingIdOfCode(defCode));
      if (!def.isGate) continue;
      const posRow = comps.positionId !== undefined
        ? world.rowsByComponentId.get(comps.positionId)?.get(eid)
        : undefined;
      if (!posRow) continue;
      const originX = Math.round(posRow[0]! - def.footprint.width / 2);
      const originY = Math.round(posRow[1]! - def.footprint.height / 2);
      for (let dy = 0; dy < def.footprint.height; dy++) {
        for (let dx = 0; dx < def.footprint.width; dx++) {
          friendlyGateTiles.push({ x: originX + dx, y: originY + dy });
        }
      }
    }
  }

  if (friendlyGateTiles.length === 0) {
    return world.layers.derivedPassability;
  }

  const pass = world.layers.derivedPassability.slice();
  for (const t of friendlyGateTiles) {
    if (t.x >= 0 && t.x < size && t.y >= 0 && t.y < size) {
      pass[t.y * size + t.x] = PASSABLE;
    }
  }
  return pass;
}

export function blockFootprintTiles(world: World, rect: FootprintRect): void {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  for (const tile of footprintTiles(rect.x, rect.y, rect.width, rect.height)) {
    passability[tile.y * size + tile.x] = IMPASSABLE;
  }
  const scheduler = world.pathScheduler;
  scheduler?.setPassabilityVersion(scheduler.passabilityVersion + 1);
}

function applyPlaceCommand(
  world: World,
  comps: SimComponents,
  diagnostics: PlacementDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parsePlaceData(data);
  // Polite age-gate refusal BEFORE the loud verdicts: gated content can
  // legitimately reach the sim (laggy clicks, AI probes), so it records
  // a digest-visible GateRejected row and returns — resources untouched,
  // no site, world keeps stepping.
  try {
    if (
      !isDefAgeUnlocked(
        world,
        comps,
        parsed.playerId,
        buildingDefOf(parsed.defId).ageGate,
      )
    ) {
      appendGateRejection(world, comps, parsed.playerId, {
        tick: world.tick,
        handler: GATE_HANDLER_PLACE,
        defCode: buildingCodeOf(parsed.defId),
      });
      diagnostics.gateRejections += 1;
      return;
    }
  } catch {
    // Unknown def: validatePlacement below renders the loud verdict.
  }
  const check = validatePlacement(
    world,
    comps,
    parsed.defId,
    parsed.tileX,
    parsed.tileY,
    parsed.playerId,
  );
  if (!check.ok) {
    throw new Error(
      `placeBuilding rejected (${check.reason ?? "invalid"}): ${parsed.defId} @ (${String(parsed.tileX)}, ${String(parsed.tileY)})`,
    );
  }
  payCostUpFront(world, comps, parsed.playerId, parsed.defId);
  spawnBuildingSite(world, comps, parsed.defId, parsed.tileX, parsed.tileY, {
    playerId: parsed.playerId,
  });
  // Block the footprint immediately and invalidate in-flight paths
  // (SPEC §2.2 invalidation rule). Units standing underneath are pushed
  // clear by steering; nobody is trapped because every perimeter tile
  // was checked reachable-adjacent by validity above.
  blockFootprintTiles(world, check.rect!);
  diagnostics.commandsApplied += 1;
}

/**
 * Bootstrap-only helper: validate, block passability (+version bump),
 * spawn AND immediately complete one building WITHOUT paying costs or
 * advancing construction. Scenario editors and test fixtures use this
 * to stand up a live town-center/house in one call; gameplay commands
 * must go through placeBuilding commands instead. Bootstrap stamps
 * ignore the age gate (editors may stage any content).
 */
export function stampFinishedBuilding(
  world: World,
  comps: SimComponents,
  defId: string,
  tileX: number,
  tileY: number,
  options: { readonly playerId?: number | undefined } = {},
): number {
  const parsed = parsePlaceData({ defId, tileX, tileY });
  const check = validatePlacement(
    world,
    comps,
    defId,
    parsed.tileX,
    parsed.tileY,
    options.playerId ?? 0,
    { ignoreAgeGate: true, ignoreFog: true },
  );
  if (!check.ok || !check.rect) {
    throw new Error(
      `stampFinishedBuilding rejected (${check.reason ?? "invalid"}): ${defId} @ (${String(tileX)}, ${String(tileY)})`,
    );
  }
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  for (const tile of footprintTiles(
    check.rect.x,
    check.rect.y,
    check.rect.width,
    check.rect.height,
  )) {
    passability[tile.y * size + tile.x] = IMPASSABLE;
  }
  const scheduler = world.pathScheduler;
  scheduler?.setPassabilityVersion(scheduler.passabilityVersion + 1);
  const eid = spawnBuildingSite(
    world,
    comps,
    defId,
    parsed.tileX,
    parsed.tileY,
    options,
  );
  completeBuilding(world, comps, eid);
  return eid;
}

/**
 * Build the placement SimSystem. Registered AFTER gather/movement so a
 * same-tick repath sees the new passability on its next LOS raycast.
 */
export function createPlacementSystem(
  comps: SimComponents,
  diagnostics: PlacementDiagnostics = createPlacementDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    for (const command of commands) {
      if (command.kind !== PLACE_BUILDING_KIND) continue;
      if (!command.data) throw new Error("placeBuilding requires command data");
      applyPlaceCommand(world, comps, diagnostics, command.data);
    }
  };
}

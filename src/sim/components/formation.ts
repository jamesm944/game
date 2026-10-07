/**
 * Tactical Unit Formations — Q4 (Issue #125 / Epic #122).
 *
 * Supported formations:
 * 1. AoE2 Classic Quartet:
 *    - Line (default rank-and-file abreast)
 *    - Box (perimeter box with vulnerable units centered)
 *    - Staggered (dispersed 2-tile spacing to mitigate AoE/siege splash)
 *    - Flank (split into twin wings to envelop)
 * 2. Mount & Blade Bannerlord Tactical:
 *    - Shield Wall (tight infantry rank, -20% speed, +2 pierce armor)
 *    - Square (solid 4-sided outward defense)
 *    - Circle (radial ring defense)
 *    - Wedge (triangular cavalry spearhead for piercing enemy ranks)
 *
 * Component:
 * - FORMATION: arity 2 [formationCode, harmonizedSpeed]
 * - Registers alphabetically between Foreman and Garrison.
 */

import type { World } from "../core/world";
import { detCos, detSin } from "../core/trig";

export const FORMATION = "Formation" as const;
export const FORMATION_ARITY = 2;

export interface FormationComponents {
  readonly formationId: number;
}

export type FormationType =
  | "line"
  | "box"
  | "staggered"
  | "flank"
  | "shieldWall"
  | "square"
  | "circle"
  | "wedge";

export const FORMATION_CODE_LINE = 0;
export const FORMATION_CODE_BOX = 1;
export const FORMATION_CODE_STAGGERED = 2;
export const FORMATION_CODE_FLANK = 3;
export const FORMATION_CODE_SHIELD_WALL = 4;
export const FORMATION_CODE_SQUARE = 5;
export const FORMATION_CODE_CIRCLE = 6;
export const FORMATION_CODE_WEDGE = 7;

export function formationToCode(formation: FormationType): number {
  switch (formation) {
    case "line":
      return FORMATION_CODE_LINE;
    case "box":
      return FORMATION_CODE_BOX;
    case "staggered":
      return FORMATION_CODE_STAGGERED;
    case "flank":
      return FORMATION_CODE_FLANK;
    case "shieldWall":
      return FORMATION_CODE_SHIELD_WALL;
    case "square":
      return FORMATION_CODE_SQUARE;
    case "circle":
      return FORMATION_CODE_CIRCLE;
    case "wedge":
      return FORMATION_CODE_WEDGE;
  }
}

export function codeToFormation(code: number): FormationType {
  switch (code) {
    case FORMATION_CODE_BOX:
      return "box";
    case FORMATION_CODE_STAGGERED:
      return "staggered";
    case FORMATION_CODE_FLANK:
      return "flank";
    case FORMATION_CODE_SHIELD_WALL:
      return "shieldWall";
    case FORMATION_CODE_SQUARE:
      return "square";
    case FORMATION_CODE_CIRCLE:
      return "circle";
    case FORMATION_CODE_WEDGE:
      return "wedge";
    case FORMATION_CODE_LINE:
    default:
      return "line";
  }
}

export function parseFormation(value: unknown): FormationType {
  if (
    value === "line" ||
    value === "box" ||
    value === "staggered" ||
    value === "flank" ||
    value === "shieldWall" ||
    value === "square" ||
    value === "circle" ||
    value === "wedge"
  ) {
    return value;
  }
  return "line";
}

export interface FormationComponents {
  readonly formationId: number;
}

export function getFormation(
  world: World,
  comps: { readonly formationId?: number },
  eid: number,
): FormationType {
  if (comps.formationId === undefined) return "line";
  const row = world.rowsByComponentId.get(comps.formationId)?.get(eid);
  if (!row) return "line";
  return codeToFormation(row[0] ?? FORMATION_CODE_LINE);
}

export function setFormation(
  world: World,
  comps: { readonly formationId?: number },
  eid: number,
  formation: FormationType,
): void {
  if (comps.formationId === undefined) return;
  let rows = world.rowsByComponentId.get(comps.formationId);
  if (!rows) {
    rows = new Map<number, number[]>();
    world.rowsByComponentId.set(comps.formationId, rows);
  }
  const existing = rows.get(eid);
  const currentSpeed = existing ? (existing[1] ?? 0) : 0;
  rows.set(eid, [formationToCode(formation), currentSpeed]);
}

export function getHarmonizedSpeed(
  world: World,
  comps: { readonly formationId?: number },
  eid: number,
): number {
  if (comps.formationId === undefined) return 0;
  const row = world.rowsByComponentId.get(comps.formationId)?.get(eid);
  if (!row) return 0;
  return row[1] ?? 0;
}

export function setHarmonizedSpeed(
  world: World,
  comps: { readonly formationId?: number },
  eid: number,
  speed: number,
): void {
  if (comps.formationId === undefined) return;
  let rows = world.rowsByComponentId.get(comps.formationId);
  if (!rows) {
    rows = new Map<number, number[]>();
    world.rowsByComponentId.set(comps.formationId, rows);
  }
  const existing = rows.get(eid);
  const currentFormation = existing
    ? (existing[0] ?? FORMATION_CODE_LINE)
    : FORMATION_CODE_LINE;
  rows.set(eid, [currentFormation, Math.max(0, speed)]);
}

export function clearHarmonizedSpeed(
  world: World,
  comps: { readonly formationId?: number },
  eid: number,
): void {
  if (comps.formationId === undefined) return;
  const row = world.rowsByComponentId.get(comps.formationId)?.get(eid);
  if (row) {
    row[1] = 0;
  }
}

/**
 * Calculates local (forward, lateral) offset for slot `index` in a squad of `totalCount`,
 * then rotates it by `heading` (radians) into world (dx, dy).
 */
export function calculateFormationOffset(
  formation: FormationType,
  index: number,
  totalCount: number,
  heading = 0,
): { dx: number; dy: number } {
  if (totalCount <= 1) return { dx: 0, dy: 0 };

  let forward = 0;
  let lateral = 0;

  switch (formation) {
    case "line": {
      const unitsPerRank = Math.min(
        10,
        Math.max(4, Math.ceil(Math.sqrt(totalCount * 2))),
      );
      const rank = Math.floor(index / unitsPerRank);
      const col = index % unitsPerRank;
      const countInRank = Math.min(
        unitsPerRank,
        totalCount - rank * unitsPerRank,
      );
      lateral = (col - (countInRank - 1) / 2) * 1.0;
      forward = -rank * 1.0;
      break;
    }

    case "box": {
      if (totalCount <= 4) {
        const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
        const a = angles[index % 4]!;
        forward = detCos(a) * 1.2;
        lateral = detSin(a) * 1.2;
      } else {
        const side = Math.ceil(totalCount / 4);
        const perimeterIndex = index % (side * 4);
        const wall = Math.floor(perimeterIndex / side);
        const pos = (perimeterIndex % side) - (side - 1) / 2;
        const halfSide = (side * 0.9) / 2;
        if (wall === 0) {
          forward = halfSide;
          lateral = pos * 0.9;
        } else if (wall === 1) {
          forward = -pos * 0.9;
          lateral = halfSide;
        } else if (wall === 2) {
          forward = -halfSide;
          lateral = -pos * 0.9;
        } else {
          forward = pos * 0.9;
          lateral = -halfSide;
        }
      }
      break;
    }

    case "staggered": {
      const cols = Math.ceil(Math.sqrt(totalCount * 1.5));
      const rank = Math.floor(index / cols);
      const col = index % cols;
      const stagger = (rank % 2) * 1.0;
      lateral = (col - (cols - 1) / 2) * 2.0 + stagger;
      forward = -rank * 2.0;
      break;
    }

    case "flank": {
      const half = Math.ceil(totalCount / 2);
      const isRight = index >= half;
      const rankIdx = isRight ? index - half : index;
      const wingLateralCenter = isRight ? 3.5 : -3.5;
      const col = rankIdx % 2;
      const rank = Math.floor(rankIdx / 2);
      lateral = wingLateralCenter + (col - 0.5) * 1.0;
      forward = -rank * 1.0;
      break;
    }

    case "shieldWall": {
      const unitsPerRank = Math.min(8, Math.max(4, Math.ceil(totalCount / 2)));
      const rank = Math.floor(index / unitsPerRank);
      const col = index % unitsPerRank;
      const countInRank = Math.min(
        unitsPerRank,
        totalCount - rank * unitsPerRank,
      );
      lateral = (col - (countInRank - 1) / 2) * 0.65;
      forward = -rank * 0.7;
      break;
    }

    case "square": {
      const side = Math.ceil(Math.sqrt(totalCount));
      const rank = Math.floor(index / side);
      const col = index % side;
      lateral = (col - (side - 1) / 2) * 0.95;
      forward = -(rank - (side - 1) / 2) * 0.95;
      break;
    }

    case "circle": {
      const radius = Math.max(1.2, totalCount * 0.22);
      const angle = (index / totalCount) * 2 * Math.PI;
      lateral = detSin(angle) * radius;
      forward = detCos(angle) * radius;
      break;
    }

    case "wedge": {
      if (index === 0) {
        lateral = 0;
        forward = 0;
      } else {
        const row = Math.ceil(Math.sqrt(index));
        const firstInRow = (row - 1) * (row - 1) + 1;
        const posInRow = index - firstInRow;
        const sideOffset =
          (posInRow % 2 === 0 ? 1 : -1) * Math.ceil((posInRow + 1) / 2);
        lateral = sideOffset * 0.9;
        forward = -row * 1.0;
      }
      break;
    }
  }

  const cosH = detCos(heading);
  const sinH = detSin(heading);
  return {
    dx: forward * cosH - lateral * sinH,
    dy: forward * sinH + lateral * cosH,
  };
}

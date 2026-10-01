/**
 * Unit stance component — V13 (Issue #88, #95).
 *
 * Controls a combatant's autonomous behavior and pursuit range:
 * - aggressive: Auto-attacks any enemy in sight radius, pursues without distance limit.
 * - defensive: Auto-attacks enemies in sight radius, pursues up to 4 tiles before breaking off.
 * - stand-ground: Attacks enemies within reach/range, never moves to pursue.
 * - no-attack: Passive; never auto-acquires or retaliates unless explicitly ordered.
 *
 * Stored as a unit component with arity 1 [stanceCode].
 * Registered alphabetically between "SocialEvents" and "Stockpile".
 */

import type { World } from "../core/world";

export const STANCE = "Stance" as const;
export const STANCE_ARITY = 1;

export type UnitStance =
  "aggressive" | "defensive" | "stand-ground" | "no-attack";

export const STANCE_CODE_AGGRESSIVE = 0;
export const STANCE_CODE_DEFENSIVE = 1;
export const STANCE_CODE_STAND_GROUND = 2;
export const STANCE_CODE_NO_ATTACK = 3;

export function stanceToCode(stance: UnitStance): number {
  switch (stance) {
    case "aggressive":
      return STANCE_CODE_AGGRESSIVE;
    case "defensive":
      return STANCE_CODE_DEFENSIVE;
    case "stand-ground":
      return STANCE_CODE_STAND_GROUND;
    case "no-attack":
      return STANCE_CODE_NO_ATTACK;
  }
}

export function codeToStance(code: number): UnitStance {
  switch (code) {
    case STANCE_CODE_DEFENSIVE:
      return "defensive";
    case STANCE_CODE_STAND_GROUND:
      return "stand-ground";
    case STANCE_CODE_NO_ATTACK:
      return "no-attack";
    case STANCE_CODE_AGGRESSIVE:
    default:
      return "aggressive";
  }
}

export function parseStance(value: unknown): UnitStance {
  if (
    value === "aggressive" ||
    value === "defensive" ||
    value === "stand-ground" ||
    value === "no-attack"
  ) {
    return value;
  }
  throw new Error(`invalid unit stance: ${String(value)}`);
}

export interface StanceComponents {
  readonly stanceId: number;
}

export function attachStance(
  world: World,
  comps: StanceComponents,
  eid: number,
  stance: UnitStance = "aggressive",
): void {
  world.rowsByComponentId.get(comps.stanceId)?.set(eid, [stanceToCode(stance)]);
}

export function getStance(
  world: World,
  comps: StanceComponents,
  eid: number,
): UnitStance {
  const row = world.rowsByComponentId.get(comps.stanceId)?.get(eid);
  if (!row || row.length === 0) return "aggressive";
  return codeToStance(row[0]!);
}

export function setStance(
  world: World,
  comps: StanceComponents,
  eid: number,
  stance: UnitStance,
): void {
  const rows = world.rowsByComponentId.get(comps.stanceId);
  if (!rows) return;
  const row = rows.get(eid);
  if (row) {
    row[0] = stanceToCode(stance);
  } else {
    rows.set(eid, [stanceToCode(stance)]);
  }
}

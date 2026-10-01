/**
 * Garrison component — V13 (Issue #88, #96).
 *
 * Stores units garrisoned inside defensive structures (Watch Towers, Castles,
 * and Town Centers).
 *
 * Each garrisoned unit stores:
 * - unitCode: number (canonical code for the unit definition)
 * - owner: number (player id)
 * - hp: number (current health, can be healed over time)
 * - maxHp: number (maximum health from definition)
 * - stanceCode: number (unit stance code)
 *
 * Row format: [count, unitCode0, owner0, hp0, maxHp0, stanceCode0, ...]
 * Stride = 5.
 * Arity = -1 (variable length).
 */

import type { World } from "../core/world";

export const GARRISON = "Garrison" as const;
export const GARRISON_ARITY = -1;
export const GARRISON_UNIT_STRIDE = 5;

export interface GarrisonedUnit {
  readonly unitCode: number;
  readonly owner: number;
  hp: number;
  readonly maxHp: number;
  readonly stanceCode: number;
}

export interface GarrisonComponents {
  readonly garrisonId: number;
}

export function readGarrison(
  world: World,
  comps: GarrisonComponents,
  buildingEid: number,
): GarrisonedUnit[] {
  const row = world.rowsByComponentId.get(comps.garrisonId)?.get(buildingEid);
  if (!row || row.length === 0) return [];
  const count = row[0]!;
  const units: GarrisonedUnit[] = [];
  for (let i = 0; i < count; i++) {
    const base = 1 + i * GARRISON_UNIT_STRIDE;
    units.push({
      unitCode: row[base]!,
      owner: row[base + 1]!,
      hp: row[base + 2]!,
      maxHp: row[base + 3]!,
      stanceCode: row[base + 4]!,
    });
  }
  return units;
}

export function writeGarrison(
  world: World,
  comps: GarrisonComponents,
  buildingEid: number,
  units: readonly GarrisonedUnit[],
): void {
  const row: number[] = [units.length];
  for (const unit of units) {
    row.push(unit.unitCode, unit.owner, unit.hp, unit.maxHp, unit.stanceCode);
  }
  const rows = world.rowsByComponentId.get(comps.garrisonId);
  if (!rows) throw new Error("unregistered Garrison component");
  rows.set(buildingEid, row);
}

export function addGarrisonedUnit(
  world: World,
  comps: GarrisonComponents,
  buildingEid: number,
  unit: GarrisonedUnit,
): void {
  const current = readGarrison(world, comps, buildingEid);
  current.push(unit);
  writeGarrison(world, comps, buildingEid, current);
}

export function clearGarrison(
  world: World,
  comps: GarrisonComponents,
  buildingEid: number,
): GarrisonedUnit[] {
  const current = readGarrison(world, comps, buildingEid);
  world.rowsByComponentId.get(comps.garrisonId)?.delete(buildingEid);
  return current;
}

export function getGarrisonCount(
  world: World,
  comps: GarrisonComponents,
  buildingEid: number,
): number {
  const row = world.rowsByComponentId.get(comps.garrisonId)?.get(buildingEid);
  if (!row || row.length === 0) return 0;
  return row[0]!;
}

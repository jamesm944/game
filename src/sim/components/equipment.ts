/**
 * Equipment component definitions — SPEC §2.5 / M2-T6.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/building/combat sets; registration is one strictly
 * alphabetical sequence (components/index.ts defineSimComponents),
 * pinning digest/save iteration order forever (world.ts).
 *
 * Canonical row layout (arity is part of the digest contract):
 * - Equipment (2): [weaponsEquipped, armorEquipped] — one row per
 *   equipped military entity, attached ONLY by the equip command
 *   handler (systems/equipment.ts). SPEC §2.5 "equipment = commodities":
 *   each count is one Forge Weapons/Armor commodity consumed from the
 *   owner's CommodityStockpile onto this unit. The row never stores
 *   stat numbers — sim/combat/stats.ts folds the counts into derived
 *   attack/armor on every read ("derived stats, never stored").
 */

import type { ComponentRows, World } from "../core/world";

export const EQUIPMENT = "Equipment" as const;

/** Row arity per equipment component — pinned for digest stability. */
export const EQUIPMENT_COMPONENT_ARITIES: readonly [string, number][] = [
  [EQUIPMENT, 2],
];

/** Component ids the equipment systems read/write. */
export interface EquipmentComponents {
  readonly equipmentId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Row access ---------------------------------------------------------------

/**
 * Attach a zeroed Equipment row to `eid`. Idempotent: an existing row
 * keeps its counts (re-equip accumulates, it never resets).
 */
export function ensureEquipmentRow(
  world: World,
  comps: Pick<EquipmentComponents, "equipmentId">,
  eid: number,
): number[] {
  const rows = requireRows(world, comps.equipmentId);
  let row = rows.get(eid);
  if (!row) {
    row = [0, 0];
    rows.set(eid, row);
  }
  return row;
}

/** Live Equipment row for `eid`, or undefined when unequipped. */
export function getEquipmentRow(
  world: World,
  comps: Pick<EquipmentComponents, "equipmentId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.equipmentId)?.get(eid);
}

export interface EquipmentCounts {
  readonly weapons: number;
  readonly armor: number;
}

/** Decoded equipped-item counts for `eid`; zeroed when unequipped. */
export function equipmentCountsOf(
  world: World,
  comps: Pick<EquipmentComponents, "equipmentId">,
  eid: number,
): EquipmentCounts {
  const row = getEquipmentRow(world, comps, eid);
  return { weapons: row?.[0] ?? 0, armor: row?.[1] ?? 0 };
}

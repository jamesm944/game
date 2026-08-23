/**
 * Equipment system — SPEC §2.5 / M2-T6.
 *
 * Consumes the `{kind:"equip"}` command: Forge Weapons/Armor
 * commodities leave the owner's CommodityStockpile and attach onto the
 * targeted military entities as Equipment rows ([weaponsEquipped,
 * armorEquipped]). SPEC §2.5 "equipment = commodities": the commodity
 * IS the item; there is no separate inventory of gear.
 *
 * Command discipline (mirrors training/placement):
 *   - targets without a Combat row are rejected loudly — equipment is a
 *     military concept, and a silent no-op would corrupt replays;
 *   - definitions without the matching `equipmentSlots` entry (e.g.
 *     villagers) are rejected loudly too;
 *   - the whole order is atomic across its unit list: affordability is
 *     checked ONCE for the full quantity before any debit lands, so a
 *     short ledger leaves every row untouched (same conservation shape
 *     as costs.payCosts);
 *   - re-equipping accumulates counts — stats.ts folds them into
 *     derived attack/armor on every read, never into stored numbers.
 *
 * Determinism: command-consumed only on tick boundaries, ascending-eid
 * iteration, integer counters, zero randomness.
 */

import type { SimComponents } from "../components";
import { ensureEquipmentRow, getEquipmentRow } from "../components/equipment";
import { getCombatRow, combatDefOf } from "../components/combat";
import { PLAYER_ONE, debitLedgerSlugs } from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kind owned by this system. */
export const EQUIP_COMMAND_KIND = "equip";

/** Equip slot slugs — mirror the definition's `equipmentSlots` entries. */
export const EQUIP_SLOT_WEAPON = "weapon";
export const EQUIP_SLOT_ARMOR = "armor";

export interface EquipmentDiagnostics {
  /** equip commands applied. */
  commandsApplied: number;
  /** Individual items transferred onto units. */
  itemsEquipped: number;
}

export function createEquipmentDiagnostics(): EquipmentDiagnostics {
  return { commandsApplied: 0, itemsEquipped: 0 };
}

interface EquipData {
  readonly unitIds: readonly number[];
  readonly item: "weapon" | "armor";
  readonly playerId: number;
}

function parseEquipData(data: Readonly<Record<string, unknown>>): EquipData {
  const rawIds = data.unitIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("equip requires a non-empty unitIds array");
  }
  const unitIds: number[] = [];
  for (const id of rawIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `equip unitIds entries must be positive integers, got ${String(id)}`,
      );
    }
    if (!unitIds.includes(id)) unitIds.push(id);
  }
  if (data.item !== EQUIP_SLOT_WEAPON && data.item !== EQUIP_SLOT_ARMOR) {
    throw new Error(
      `equip item must be ${JSON.stringify(EQUIP_SLOT_WEAPON)} or ${JSON.stringify(EQUIP_SLOT_ARMOR)}, got ${JSON.stringify(data.item)}`,
    );
  }
  const rawPlayer = data.playerId ?? PLAYER_ONE;
  if (
    typeof rawPlayer !== "number" ||
    !Number.isInteger(rawPlayer) ||
    rawPlayer < 0
  ) {
    throw new Error("equip playerId must be a non-negative integer");
  }
  // Ascending canonical order: replays/logs observe one payload shape.
  unitIds.sort((a, b) => a - b);
  return { unitIds, item: data.item, playerId: rawPlayer };
}

/**
 * The commodity slug one equip slot consumes: the Forge outputs of
 * SPEC §2.6's depth-1 table.
 */
function commoditySlugForSlot(item: "weapon" | "armor"): string {
  return item === EQUIP_SLOT_WEAPON ? "weapons" : "armor";
}

function applyEquipCommand(
  world: World,
  comps: SimComponents,
  diagnostics: EquipmentDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseEquipData(data);

  // Validate EVERY target first: one bad eid rejects the whole order
  // before a single commodity moves.
  for (const eid of parsed.unitIds) {
    const combatRow = getCombatRow(world, comps, eid);
    if (!combatRow) {
      throw new Error(
        `equip targets entity ${String(eid)}, which has no Combat row`,
      );
    }
    const def = combatDefOf(world, comps, eid);
    if (!def || !def.equipmentSlots.includes(parsed.item)) {
      throw new Error(
        `unit ${def?.id ?? String(eid)} has no ${parsed.item} equipment slot`,
      );
    }
  }

  // Atomic multi-unit debit before any row moves (conservation
  // discipline shared with costs.payCosts): a short ledger throws and
  // leaves every stockpile and Equipment row untouched.
  debitLedgerSlugs(
    world,
    comps,
    parsed.playerId,
    [
      {
        defId: commoditySlugForSlot(parsed.item),
        qty: parsed.unitIds.length,
      },
    ],
    `equipping ${String(parsed.unitIds.length)}× ${commoditySlugForSlot(parsed.item)}`,
  );

  for (const eid of parsed.unitIds) {
    const row = ensureEquipmentRow(world, comps, eid);
    if (parsed.item === EQUIP_SLOT_WEAPON) row[0]! += 1;
    else row[1]! += 1;
    diagnostics.itemsEquipped += 1;
  }
  diagnostics.commandsApplied += 1;
}

/**
 * Build the equipment SimSystem. Register anywhere after combat spawns
 * exist — it only consumes commands and writes Equipment rows, so tick
 * order against other systems is immaterial.
 */
export function createEquipmentSystem(
  comps: SimComponents,
  diagnostics: EquipmentDiagnostics = createEquipmentDiagnostics(),
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    for (const command of commands) {
      if (command.kind !== EQUIP_COMMAND_KIND) continue;
      if (!command.data) throw new Error("equip requires command data");
      applyEquipCommand(world, comps, diagnostics, command.data);
    }
  };
}

/** Equipped-item counts for one entity, lenient for unequipped units. */
export function equippedCountsOf(
  world: World,
  comps: Pick<SimComponents, "equipmentId">,
  eid: number,
): { weapons: number; armor: number } {
  const row = getEquipmentRow(world, comps, eid);
  return { weapons: row?.[0] ?? 0, armor: row?.[1] ?? 0 };
}

/**
 * Derived-on-read combat stats — SPEC §2.5 / M2-T5.
 *
 * "Derived stats, never stored": attack, per-class armor, speed, range
 * and reload compute FRESH on every read from
 *
 *   base definition stats + equipped commodity counts (M2-T6)
 *   + researched tech effects
 *   + traits (M3: contributes zero today),
 *
 * never from any duplicate stat row. The Combat component stores only
 * identity/ownership/hp/engagement state — everything numeric about how
 * hard a unit hits or how far it reaches is re-derived here, so a tech
 * completion or an equip order re-prices an entire army with no
 * migration pass.
 *
 * Equipment (SPEC §2.5 "equipment = commodities"): each Forge Weapons /
 * Armor commodity consumed onto a unit contributes a flat documented
 * delta — WEAPON_ATTACK_BONUS attack per weapon, ARMOR_EQUIP_BONUS per
 * armor piece folded into every armor class the unit is tagged with
 * (same single-pool model the melee/pierce techs use). Equipment applies
 * FIRST (base → equipment → techs in ascending tech-code order), so
 * multiplier techs scale the equipped loadout too. The rock-paper-
 * scissors shape lives in definitions and is untouched by either layer.
 *
 * Tech effect application follows the OpenRA-style descriptor grammar of
 * data/schema.ts: effects whose selector matches the unit apply in
 * ascending tech-code order (codes are assigned by ascending slug, so
 * this order is platform-stable), each tech's listed effect order
 * preserved. Only combat stats are consumed here — work-rate/economy
 * descriptors are ignored by this module.
 *
 * Determinism: pure integer/small-float arithmetic over validated
 * definition content — IEEE-754 basic ops only, no transcendentals, no
 * clock or randomness anywhere.
 */

import { TECH_DEF_CODES, techDefOf } from "../../data/definitions";
import type { EquipmentCounts } from "../components/equipment";
import {
  DEFAULT_RELOAD_TICKS,
  MELEE_RANGE,
  ARMOR_CLASSES,
  type ArmorClass,
  type TechEffect,
  type UnitDefinition,
} from "../../data/schema";

/** Everything that modifies a definition's base numbers right now. */
export interface StatContext {
  /**
   * Completed tech codes of the unit's owner (ResearchedTechs row,
   * decoded). Omit for raw baseline stats.
   */
  readonly researchedTechCodes?: ReadonlySet<number> | undefined;
  /**
   * Equipped Forge commodity counts (Equipment row, decoded). Omit for
   * a default-fisted unit.
   */
  readonly equipment?: EquipmentCounts | undefined;
}

/**
 * Attack added per equipped Weapons commodity (M2-T6, SPEC §2.5).
 * Documented tuning constant — rebalancing is a one-line change.
 */
export const WEAPON_ATTACK_BONUS = 2;
/** Armor folded into every owned class per equipped Armor piece. */
export const ARMOR_EQUIP_BONUS = 1;

/** One fully-derived combat stat block, fresh every call. */
export interface DerivedStats {
  readonly attack: number;
  /** Armor value keyed by canonical armor-class slug (0 where untouched). */
  readonly armorByClass: Readonly<Record<ArmorClass, number>>;
  readonly speed: number;
  readonly range: number;
  readonly reloadTicks: number;
}

function emptyArmorByClass(): Record<ArmorClass, number> {
  const table = {} as Record<ArmorClass, number>;
  for (const armorClass of ARMOR_CLASSES) table[armorClass] = 0;
  return table;
}

/** True when the effect's selector targets this unit at all. */
function selectorMatches(selector: string, def: UnitDefinition): boolean {
  if (selector.startsWith("class:")) {
    return def.armorClasses.includes(selector.slice("class:".length));
  }
  if (selector.startsWith("unit:")) {
    return selector.slice("unit:".length) === def.id;
  }
  // Freeform selectors (activity:, economy …) never touch combat stats.
  return false;
}

const ARMOR_STATS = new Set(["melee-armor", "pierce-armor", "armor"]);

interface StatAccumulator {
  attack: number;
  armorByClass: Record<ArmorClass, number>;
  speed: number;
  range: number;
  reloadTicks: number;
}

/** Apply one matched effect to the mutable stat accumulator. */
function applyEffect(stats: StatAccumulator, effect: TechEffect): void {
  const scale = (base: number): number =>
    effect.op === "add" ? base + effect.value : base * effect.value;
  if (effect.stat === "attack") {
    stats.attack = scale(stats.attack);
  } else if (ARMOR_STATS.has(effect.stat)) {
    // Both armor flavors fold into ONE per-class pool: the simplified
    // counter model subtracts the defender's single best matching armor
    // value (strikeDamage below), so melee/pierce bonuses stack there.
    if (!effect.target.startsWith("class:")) return;
    const armorClass = effect.target.slice("class:".length) as ArmorClass;
    const held = stats.armorByClass[armorClass];
    if (held !== undefined) stats.armorByClass[armorClass] = scale(held);
  } else if (effect.stat === "speed") {
    stats.speed = Math.max(scale(stats.speed), Number.EPSILON);
  } else if (effect.stat === "range") {
    stats.range = Math.max(scale(stats.range), MELEE_RANGE / 2);
  } else if (effect.stat === "reload-ticks" || effect.stat === "reload") {
    stats.reloadTicks = Math.max(1, Math.round(scale(stats.reloadTicks)));
  }
  // Unknown stats (work-rate, economy …) are not combat concerns.
}

/**
 * Fold equipped commodity counts into the accumulator (base → equipment
 * step of the derivation). Weapons add flat attack; armor raises every
 * armor class the definition tags the unit with.
 */
function applyEquipment(
  stats: StatAccumulator,
  def: UnitDefinition,
  equipment: EquipmentCounts,
): void {
  if (equipment.weapons > 0) {
    stats.attack += equipment.weapons * WEAPON_ATTACK_BONUS;
  }
  if (equipment.armor > 0) {
    for (const tag of def.armorClasses) {
      const armorClass = tag as ArmorClass;
      const held = stats.armorByClass[armorClass];
      if (held !== undefined) {
        stats.armorByClass[armorClass] =
          held + equipment.armor * ARMOR_EQUIP_BONUS;
      }
    }
  }
}

/**
 * Derive one unit's combat stats from its definition, its equipped
 * commodity counts and the owning player's completed techs. Traits
 * contribute their documented zero until M3 lands its modifiers.
 */
export function deriveUnitStats(
  def: UnitDefinition,
  ctx: StatContext = {},
): DerivedStats {
  const stats: StatAccumulator = {
    attack: def.attack,
    armorByClass: emptyArmorByClass(),
    speed: def.speed,
    range: def.range ?? MELEE_RANGE,
    reloadTicks: def.reloadTicks ?? DEFAULT_RELOAD_TICKS,
  };
  if (ctx.equipment !== undefined) {
    applyEquipment(stats, def, ctx.equipment);
  }
  if (ctx.researchedTechCodes !== undefined) {
    for (const code of [...ctx.researchedTechCodes].sort((a, b) => a - b)) {
      const id = techIdOfCodeOrNull(code);
      if (id === null) continue;
      for (const effect of techDefOf(id).effects) {
        if (!selectorMatches(effect.target, def)) continue;
        applyEffect(stats, effect);
      }
    }
  }
  return stats;
}

/** Inverse of TECH_DEF_CODES without throwing on unknown codes. */
function techIdOfCodeOrNull(code: number): string | null {
  for (const [id, candidate] of TECH_DEF_CODES) {
    if (candidate === code) return id;
  }
  return null;
}

/**
 * Total bonus multiplier `attacker` deals against a defender carrying
 * `defenderClasses`: the PRODUCT of every bonus whose class matches
 * (multiple class matches stack multiplicatively in our model).
 */
export function bonusMultiplierOf(
  attacker: UnitDefinition,
  defenderClasses: readonly string[],
): number {
  let mult = 1;
  for (const bonus of attacker.attackBonuses) {
    if (defenderClasses.includes(bonus.armorClass)) mult *= bonus.mult;
  }
  return mult;
}

/**
 * The defender's single best armor value against an incoming strike:
 * the MAX over the defender's armor-class tags (a unit tagged archer
 * AND infantry defends with whichever armor is higher).
 */
export function effectiveArmorOf(
  defenderStats: DerivedStats,
  defenderClasses: readonly string[],
): number {
  let armor = 0;
  for (const tag of defenderClasses) {
    const value = defenderStats.armorByClass[tag as ArmorClass];
    if (value !== undefined && value > armor) armor = value;
  }
  return armor;
}

/**
 * SPEC §2.5 counter mechanism: damage = max(1, attack × bonusMultiplier
 * − targetBaseArmor), floored to an integer for exact digest rows. The
 * max(1, …) clamp keeps every strike meaningful (AoE2-faithful minimum
 * chip damage).
 */
export function strikeDamage(
  attackerDef: UnitDefinition,
  attackerStats: DerivedStats,
  defenderDef: UnitDefinition,
  defenderStats: DerivedStats,
): number {
  const mult = bonusMultiplierOf(attackerDef, defenderDef.armorClasses);
  const armor = effectiveArmorOf(defenderStats, defenderDef.armorClasses);
  return Math.max(1, Math.floor(attackerStats.attack * mult - armor));
}

/**
 * Every building defends with exactly ONE canonical armor-class tag
 * (SPEC §2.5 counter table) and no equipment/tech armor of its own in
 * M2 — so its effective armor is this documented constant until techs
 * (or a future definition field) contribute.
 */
export const BUILDING_ARMOR_CLASSES: readonly string[] = ["building"];
export const BUILDING_BASE_ARMOR = 0;

/**
 * The same counter formula as `strikeDamage`, resolved against a
 * BUILDING defender: attack-bonus multipliers keyed to the `building`
 * class apply (the siege→building column of the §2.5 table), armor is
 * BUILDING_BASE_ARMOR, and the max(1, …) floor holds — every ram hit
 * chips, even a militia's sword.
 */
export function strikeDamageOnBuilding(
  attackerDef: UnitDefinition,
  attackerStats: DerivedStats,
): number {
  const mult = bonusMultiplierOf(attackerDef, BUILDING_ARMOR_CLASSES);
  return Math.max(
    1,
    Math.floor(attackerStats.attack * mult - BUILDING_BASE_ARMOR),
  );
}

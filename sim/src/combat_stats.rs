//! Derived-on-read combat stats (SPEC §2.5 / M2-T5): Rust port of
//! `src/sim/combat/stats.ts` + `src/sim/combat/elevation.ts`.
//! Attack/armor/speed/range/reload/hp compute fresh from base
//! definition → equipment → own skill levels → researched tech effects
//! (ascending tech code, listed order) → wound impairment → formation.
//! Civ bonuses read `world.civilizations` in TS; civ-less here.
use crate::defs::{Defs, TechEffect, UnitDef};
use crate::mapgen::Layers;
use crate::pop::js_round;
use std::collections::BTreeMap;

pub const MELEE_RANGE: f64 = 0.5;
pub const DEFAULT_RELOAD_TICKS: f64 = 60.0;
pub const WEAPON_ATTACK_BONUS: f64 = 2.0;
pub const ARMOR_EQUIP_BONUS: f64 = 1.0;
pub const ATTACK_PCT_PER_LEVEL: f64 = 4.0;
pub const BUILDING_BASE_ARMOR: f64 = 0.0;

pub const ARMOR_CLASSES: [&str; 10] = [
    "infantry", "cavalry", "archer", "siege", "building", "ship", "monastery", "camel", "civilian",
    "monk",
];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EquipmentCounts {
    pub weapons: f64,
    pub armor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormationKind {
    Line,
    Box,
    Staggered,
    Flank,
    ShieldWall,
    Square,
    Circle,
    Wedge,
}

impl FormationKind {
    pub fn from_code(code: f64) -> FormationKind {
        match code as i64 {
            1 => FormationKind::Box,
            2 => FormationKind::Staggered,
            3 => FormationKind::Flank,
            4 => FormationKind::ShieldWall,
            5 => FormationKind::Square,
            6 => FormationKind::Circle,
            7 => FormationKind::Wedge,
            _ => FormationKind::Line,
        }
    }
}

#[derive(Clone, Debug)]
pub struct StatContext<'a> {
    pub researched_tech_codes: Option<&'a [i64]>,
    pub equipment: Option<EquipmentCounts>,
    /// (melee_level, ranged_level); None = rowless.
    pub skill_levels: Option<(i64, i64)>,
    pub impairment: Option<(f64, f64)>, // (attackMult, speedMult)
    pub formation: Option<FormationKind>,
}

impl Default for StatContext<'_> {
    fn default() -> Self {
        StatContext { researched_tech_codes: None, equipment: None, skill_levels: None, impairment: None, formation: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DerivedStats {
    pub attack: f64,
    pub armor_by_class: BTreeMap<String, f64>,
    pub speed: f64,
    pub range: f64,
    pub reload_ticks: f64,
    pub hp: f64,
}

pub fn selector_matches(selector: &str, def: &UnitDef) -> bool {
    if let Some(class) = selector.strip_prefix("class:") {
        return def.armor_classes.iter().any(|c| c == class);
    }
    if let Some(unit) = selector.strip_prefix("unit:") {
        return unit == def.id;
    }
    false
}

pub fn attack_multiplier_for(level: i64) -> f64 {
    (100.0 + ATTACK_PCT_PER_LEVEL * level as f64) / 100.0
}

fn apply_effect(stats: &mut DerivedStats, effect: &TechEffect) {
    let scale = |base: f64| if effect.op == "add" { base + effect.value } else { base * effect.value };
    match effect.stat.as_str() {
        "attack" => stats.attack = scale(stats.attack),
        "melee-armor" | "pierce-armor" | "armor" => {
            let Some(class) = effect.target.strip_prefix("class:") else { return };
            if let Some(held) = stats.armor_by_class.get(class).copied() {
                stats.armor_by_class.insert(class.to_string(), scale(held));
            }
        }
        "speed" => stats.speed = scale(stats.speed).max(f64::EPSILON),
        "range" => stats.range = scale(stats.range).max(MELEE_RANGE / 2.0),
        "reload-ticks" | "reload" | "reloadTicks" => {
            stats.reload_ticks = js_round(scale(stats.reload_ticks)).max(1.0)
        }
        "hp" => stats.hp = js_round(scale(stats.hp)).max(1.0),
        _ => {}
    }
}

pub fn derive_unit_stats(defs: &Defs, def: &UnitDef, ctx: &StatContext) -> DerivedStats {
    let mut armor_by_class: BTreeMap<String, f64> =
        ARMOR_CLASSES.iter().map(|c| (c.to_string(), 0.0)).collect();
    let mut stats = DerivedStats {
        attack: def.attack,
        armor_by_class: std::mem::take(&mut armor_by_class),
        speed: def.speed,
        range: def.range,
        reload_ticks: def.reload_ticks.map(|v| v as f64).unwrap_or(DEFAULT_RELOAD_TICKS),
        hp: def.hp as f64,
    };
    // Civ bonuses fold first in TS; no civ registry in Rust yet.
    if let Some(eq) = ctx.equipment {
        if eq.weapons > 0.0 {
            stats.attack += eq.weapons * WEAPON_ATTACK_BONUS;
        }
        if eq.armor > 0.0 {
            for tag in &def.armor_classes {
                if let Some(held) = stats.armor_by_class.get(tag).copied() {
                    stats.armor_by_class.insert(tag.clone(), held + eq.armor * ARMOR_EQUIP_BONUS);
                }
            }
        }
    }
    if let Some((melee, ranged)) = ctx.skill_levels {
        let level = if def.range > MELEE_RANGE { ranged } else { melee };
        if level > 0 {
            stats.attack *= attack_multiplier_for(level);
        }
    }
    if let Some(codes) = ctx.researched_tech_codes {
        let mut sorted: Vec<i64> = codes.to_vec();
        sorted.sort();
        for code in sorted {
            let Some(tech_id) = defs.tech_id_of_code_or_null(code as u32).map(|s| s.to_string()) else {
                continue; // unknown codes skip (TS techIdOfCodeOrNull)
            };
            for effect in &defs.tech(&tech_id).effects.clone() {
                if selector_matches(&effect.target, def) {
                    apply_effect(&mut stats, effect);
                }
            }
        }
    }
    if let Some((attack_mult, speed_mult)) = ctx.impairment {
        if attack_mult != 1.0 {
            stats.attack *= attack_mult;
        }
        if speed_mult != 1.0 {
            stats.speed = (stats.speed * speed_mult).max(f64::EPSILON);
        }
    }
    if ctx.formation == Some(FormationKind::ShieldWall) {
        stats.speed = (stats.speed * 0.8).max(f64::EPSILON);
        for tag in &def.armor_classes {
            if let Some(held) = stats.armor_by_class.get(tag).copied() {
                stats.armor_by_class.insert(tag.clone(), held + 2.0);
            }
        }
    }
    stats
}

pub fn bonus_multiplier_of(attacker: &UnitDef, defender_classes: &[String]) -> f64 {
    let mut mult = 1.0;
    for bonus in &attacker.attack_bonuses {
        if defender_classes.iter().any(|c| c == &bonus.armor_class) {
            mult *= bonus.mult;
        }
    }
    mult
}

pub fn effective_armor_of(stats: &DerivedStats, defender_classes: &[String]) -> f64 {
    let mut armor = 0.0;
    for tag in defender_classes {
        if let Some(value) = stats.armor_by_class.get(tag) {
            if *value > armor {
                armor = *value;
            }
        }
    }
    armor
}

pub fn strike_damage(attacker_def: &UnitDef, attacker_stats: &DerivedStats, defender_def: &UnitDef, defender_stats: &DerivedStats) -> f64 {
    let mult = bonus_multiplier_of(attacker_def, &defender_def.armor_classes);
    let mut armor = effective_armor_of(defender_stats, &defender_def.armor_classes);
    if attacker_def.range > MELEE_RANGE {
        let pierce = defender_stats.armor_by_class.get("pierce").copied().unwrap_or(0.0);
        if pierce > armor {
            armor = pierce;
        }
    }
    (attacker_stats.attack * mult - armor).floor().max(1.0)
}

pub fn strike_damage_on_building(attacker_def: &UnitDef, attacker_stats: &DerivedStats) -> f64 {
    let mult = bonus_multiplier_of(attacker_def, &["building".to_string()]);
    (attacker_stats.attack * mult - BUILDING_BASE_ARMOR).floor().max(1.0)
}

// ---- elevation (combat/elevation.ts) ----

pub fn elevation_at(layers: &Layers, x: f64, y: f64) -> i64 {
    let (tx, ty) = (x.floor() as i64, y.floor() as i64);
    if tx < 0 || ty < 0 || tx >= layers.size as i64 || ty >= layers.size as i64 {
        return 0;
    }
    layers.elevation[ty as usize * layers.size + tx as usize] as i64
}

pub fn apply_elevation_damage(base: f64, attacker_elev: i64, target_elev: i64) -> f64 {
    let mult = if attacker_elev > target_elev {
        1.25
    } else if attacker_elev < target_elev {
        0.75
    } else {
        return base;
    };
    js_round(base * mult).max(1.0)
}

pub fn elevation_range_bonus(attacker_elev: i64, target_elev: i64) -> f64 {
    if attacker_elev - target_elev >= 1 {
        1.0
    } else {
        0.0
    }
}

pub fn elevation_sight_bonus(unit_elev: i64, reference_elev: i64) -> f64 {
    if unit_elev - reference_elev >= 2 {
        1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_formula_matches_schema() {
        let defs = Defs::load_repo_defaults().unwrap();
        let archer = defs.unit("archer");
        let knight = defs.unit("knight");
        let a = derive_unit_stats(&defs, archer, &StatContext::default());
        let k = derive_unit_stats(&defs, knight, &StatContext::default());
        // archer attack 4 ×1.5 vs cavalry − 0 armor = 6
        assert_eq!(strike_damage(archer, &a, knight, &k), 6.0);
        assert_eq!(a.range, 4.0);
        assert_eq!(a.reload_ticks, 60.0);
        let villager = defs.unit("villager");
        let v = derive_unit_stats(&defs, villager, &StatContext::default());
        assert_eq!(v.range, 0.5, "melee default range");
        assert!(strike_damage_on_building(archer, &a) >= 1.0);
    }
}

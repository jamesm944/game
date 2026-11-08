//! Combat system (SPEC §2.5 / M2-T5..T7): Rust port of
//! `src/sim/systems/combat.ts`. Owns attack/attackMove/stop/patrol/
//! guard/setStance/garrison/ungarrison/pack/unpack/convert orders,
//! engagement advance (approach legs, reload cadence, derived-stat
//! strikes, AoE splash, elevation), monk conversion, defensive
//! structure fire, retaliation/aggro acquisition, unit death cleanup
//! and the building-destruction pipeline. Register AFTER movement
//! (and gather): strikes observe this tick's final positions.
//!
//! `group_routes` mirrors TS's optional PathScheduler argument:
//! schedulerless worlds keep the direct attackMove march; with it,
//! attackMove rides movement's leader-A* formation pipeline.
//! Diplomacy is owner-inequality (no matrix configured in Rust yet);
//! naval approach passability panics loudly until navigability lands;
//! fog dirty-marks are no-ops (E4d).
use crate::activities::{cancel_activities, dequeue_current, move_activity, peek, Activity, ActivityQueue};
use crate::buildings::{
    age_rank_of, assigned_site, building_row, building_site_row, clear_assigned_site, spawn_rubble,
    AgeComps, BuildingComps,
};
use crate::combat::{
    append_combat_event, apply_strike_injuries, attach_stance, clear_conversion, clear_garrison,
    combat_row, drop_carried_relics, drop_stored_relics, equipment_counts, get_conversion_progress,
    get_faith, get_formation, get_stance, is_naval_unit, is_routing, read_garrison, set_conversion,
    set_faith, set_stance, spawn_combat_unit, write_garrison, CombatAuxComps, CombatComps,
    CombatEvent, EntitySpatialHash, SpawnCombatOptions, UnitStance, COMBAT_EVENT_DAMAGE,
    COMBAT_EVENT_DEATH, COMBAT_EVENT_SHOT, COMBAT_EVENT_UNIT_DEATH,
};
use crate::combat_stats::{
    apply_elevation_damage, derive_unit_stats, effective_armor_of, elevation_at,
    elevation_range_bonus, elevation_sight_bonus, strike_damage, strike_damage_on_building,
    DerivedStats, StatContext, DEFAULT_RELOAD_TICKS, MELEE_RANGE,
};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::{Defs, UnitDef};
use crate::economy::{clear_assigned_node, EconomyComps};
use crate::mapgen::Layers;
use crate::movement::{
    issue_group_route_ex, read_queue, reset_steering_bookkeeping, write_queue, Continuation,
    GroupRouteOrder, MovementComps, FormationKind as MoveFormationKind,
};
use crate::path::PathScheduler;
use crate::pop::{self, PopComps, TraitsData};
use crate::production::{clear_production_job, production_job, ProductionComps};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

pub const ATTACK_KIND: &str = "attack";
pub const ATTACK_MOVE_KIND: &str = "attackMove";
pub const STOP_KIND: &str = "stop";
pub const PATROL_KIND: &str = "patrol";
pub const GUARD_KIND: &str = "guard";
pub const SET_STANCE_KIND: &str = "setStance";
pub const GARRISON_KIND: &str = "garrison";
pub const UNGARRISON_KIND: &str = "ungarrison";
pub const PACK_KIND: &str = "pack";
pub const UNPACK_KIND: &str = "unpack";
pub const CONVERT_KIND: &str = "convert";

const APPROACH_REFRESH_DISTANCE: f64 = 0.75;
const RANGE_STAND_FACTOR: f64 = 0.9;
const APPROACH_STANDPOINT_SEARCH_RING: i64 = 3;
const COMBAT_XP_PER_HIT: f64 = 10.0;
const COMBAT_XP_PER_KILL: f64 = 50.0;

pub fn building_target_radius(defs: &Defs, def_code: f64) -> f64 {
    let fp = &defs.building(defs.building_id_of_code(def_code as u32)).footprint;
    let (hw, hh) = (fp.width as f64 / 2.0, fp.height as f64 / 2.0);
    (hw * hw + hh * hh).sqrt()
}

/// TS sightRadius fallback chain uses definition values directly.
fn sight_of(def: &UnitDef) -> f64 {
    def.sight_radius
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CombatDiagnostics {
    pub attack_commands: u64,
    pub attack_move_commands: u64,
    pub stop_commands: u64,
    pub patrol_commands: u64,
    pub guard_commands: u64,
    pub set_stance_commands: u64,
    pub garrison_commands: u64,
    pub ungarrison_commands: u64,
    pub pack_commands: u64,
    pub unpack_commands: u64,
    pub convert_commands: u64,
    pub strikes: u64,
    pub kills: u64,
    pub buildings_destroyed: u64,
    pub workers_retasked: u64,
    pub retaliations: u64,
    pub aggro_acquisitions: u64,
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}

fn parse_entity_ids(data: &serde_json::Value, key: &str, label: &str) -> Vec<Eid> {
    let raw = data.get(key).and_then(|v| v.as_array());
    let raw = raw.filter(|a| !a.is_empty()).unwrap_or_else(|| panic!("{label} requires a non-empty id array"));
    let mut ids: Vec<Eid> = Vec::new();
    for entry in raw {
        let id = entry
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .unwrap_or_else(|| panic!("{label} entries must be positive integers, got {entry}"));
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.sort();
    ids
}

fn require_positive_int(data: &serde_json::Value, key: &str, label: &str) -> Eid {
    data.get(key)
        .and_then(|v| v.as_f64())
        .filter(|v| v.fract() == 0.0 && *v >= 1.0)
        .map(|v| v as Eid)
        .unwrap_or_else(|| panic!("{label} must be a positive integer"))
}

fn require_finite(data: &serde_json::Value, key: &str, label: &str) -> f64 {
    data.get(key)
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| panic!("{label} must be a finite number"))
}

pub struct CombatSystem {
    defs: Arc<Defs>,
    traits: Arc<TraitsData>,
    pop: PopComps,
    bcomps: BuildingComps,
    age: AgeComps,
    ccomps: CombatComps,
    aux: CombatAuxComps,
    pcomps: ProductionComps,
    pub group_routes: bool,
    pub diagnostics: CombatDiagnostics,
}

impl CombatSystem {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        defs: Arc<Defs>,
        traits: Arc<TraitsData>,
        pop: PopComps,
        bcomps: BuildingComps,
        age: AgeComps,
        ccomps: CombatComps,
        aux: CombatAuxComps,
        pcomps: ProductionComps,
        group_routes: bool,
    ) -> CombatSystem {
        CombatSystem {
            defs,
            traits,
            pop,
            bcomps,
            age,
            ccomps,
            aux,
            pcomps,
            group_routes,
            diagnostics: CombatDiagnostics::default(),
        }
    }

    fn reset_steering(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid) {
        if let Some(vel) = world.rows_by_component.get_mut(comps.velocity).and_then(|r| r.get_mut(&eid)) {
            reset_steering_bookkeeping(vel);
        }
    }

    fn set_move_target(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid, x: f64, y: f64) {
        if world.rows_by_component[comps.move_target].contains_key(&eid) {
            world.set_values(comps.move_target, eid, &[x, y]).expect("registered component");
        }
    }

    fn combat_set(&self, world: &mut CoreWorld, eid: Eid, index: usize, value: f64) {
        if let Some(r) = world.rows_by_component.get_mut(self.ccomps.combat).and_then(|rows| rows.get_mut(&eid)) {
            r[index] = value;
        }
    }

    // ---- command application ----

    fn apply_attack(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let attacker_ids = parse_entity_ids(data, "attackerIds", "attack");
        let target_id = require_positive_int(data, "targetId", "attack targetId");
        let is_structure = building_row(world, &self.bcomps, target_id).is_some()
            || building_site_row(world, &self.bcomps, target_id).is_some();
        if combat_row(world, &self.ccomps, target_id).is_none() && !is_structure {
            panic!("attack targets entity {target_id}, which has no Combat or Building row");
        }
        for eid in attacker_ids {
            assert!(eid != target_id, "attack attacker {eid} cannot target itself");
            if combat_row(world, &self.ccomps, eid).is_none() {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            queue.push(Activity::Attack { target_eid: target_id as f64 });
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, target_id as f64);
            self.reset_steering(world, comps, eid);
        }
        self.diagnostics.attack_commands += 1;
    }

    fn apply_attack_move(
        &mut self,
        world: &mut CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        layers: &Layers,
        paths: &mut PathScheduler<Continuation>,
        data: &serde_json::Value,
    ) {
        let ids = parse_entity_ids(data, "ids", "attackMove");
        let x = require_finite(data, "x", "attackMove x");
        let y = require_finite(data, "y", "attackMove y");
        let size = layers.size;
        if self.group_routes {
            let econ_c = *econ;
            let bcomps = self.bcomps;
            let ccomps = self.ccomps;
            let mut hook = |world: &mut CoreWorld, eid: Eid| {
                clear_assigned_node(world, &econ_c, eid);
                clear_assigned_site(world, &bcomps, eid);
                if let Some(r) = world.rows_by_component.get_mut(ccomps.combat).and_then(|rows| rows.get_mut(&eid)) {
                    r[3] = 0.0;
                }
            };
            let order = GroupRouteOrder {
                entity_ids: ids,
                x,
                y,
                queue: data.get("queue").and_then(|v| v.as_bool()) == Some(true),
                formation: data
                    .get("formation")
                    .and_then(|v| v.as_str())
                    .map(|s| MoveFormationKind::parse(Some(s))),
            };
            let passability = layers.passability.clone();
            issue_group_route_ex(world, comps, size, &passability, paths, &order, true, Some(&mut hook));
            self.diagnostics.attack_move_commands += 1;
            return;
        }
        let x = x.clamp(0.5, size as f64 - 0.5);
        let y = y.clamp(0.5, size as f64 - 0.5);
        for eid in ids {
            if combat_row(world, &self.ccomps, eid).is_none() {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            queue.push(Activity::AttackMove { waypoints: vec![x, y], cursor: 0 });
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, 0.0);
            self.set_move_target(world, comps, eid, x, y);
            self.reset_steering(world, comps, eid);
        }
        self.diagnostics.attack_move_commands += 1;
    }

    fn apply_stop(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        for eid in parse_entity_ids(data, "entityIds", "stop") {
            if !world.rows_by_component[comps.activity_queue].contains_key(&eid) {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, 0.0);
            clear_conversion(world, &self.ccomps, eid);
            if let Some(vel) = world.rows_by_component.get_mut(comps.velocity).and_then(|r| r.get_mut(&eid)) {
                vel[1] = 0.0;
                reset_steering_bookkeeping(vel);
            }
        }
        self.diagnostics.stop_commands += 1;
    }

    fn command_ids_or_all(&self, world: &CoreWorld, comps: &MovementComps, data: &serde_json::Value, keys: &[&str], label: &str, exclude: Option<Eid>) -> Vec<Eid> {
        for key in keys {
            if data.get(key).is_some() {
                return parse_entity_ids(data, key, label);
            }
        }
        world
            .entities
            .iter()
            .copied()
            .filter(|&eid| Some(eid) != exclude && world.rows_by_component[comps.activity_queue].contains_key(&eid))
            .collect()
    }

    fn apply_patrol(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let raw = data.get("waypoints").and_then(|v| v.as_array());
        let raw = raw.filter(|a| a.len() >= 2).expect("patrol requires at least 2 waypoints");
        let mut flat: Vec<f64> = Vec::new();
        for wp in raw {
            if let Some(n) = wp.as_f64() {
                flat.push(n);
            } else if let Some(obj) = wp.as_object() {
                let (Some(wx), Some(wy)) = (
                    obj.get("x").and_then(|v| v.as_f64()).filter(|v| v.is_finite()),
                    obj.get("y").and_then(|v| v.as_f64()).filter(|v| v.is_finite()),
                ) else {
                    panic!("patrol waypoint coordinates must be finite numbers");
                };
                flat.push(wx);
                flat.push(wy);
            }
        }
        assert!(flat.len() >= 4 && flat.len() % 2 == 0, "patrol requires an even number of coordinates >= 4");
        let ids = self.command_ids_or_all(world, comps, data, &["ids", "entityIds", "attackerIds"], "patrol", None);
        for eid in ids {
            if !world.rows_by_component[comps.activity_queue].contains_key(&eid) {
                continue;
            }
            let mut queue = read_queue(world, comps, eid);
            if data.get("queue").and_then(|v| v.as_bool()) == Some(true) && !queue.is_empty() {
                queue.push(Activity::Patrol { waypoints: flat.clone(), cursor: 0, direction: 1 });
                write_queue(world, comps, eid, &queue);
            } else {
                clear_assigned_node(world, econ, eid);
                clear_assigned_site(world, &self.bcomps, eid);
                cancel_activities(&mut queue);
                queue.push(Activity::Patrol { waypoints: flat.clone(), cursor: 0, direction: 1 });
                write_queue(world, comps, eid, &queue);
                self.combat_set(world, eid, 3, 0.0);
                self.set_move_target(world, comps, eid, flat[0], flat[1]);
                self.reset_steering(world, comps, eid);
            }
        }
        self.diagnostics.patrol_commands += 1;
    }

    fn apply_guard(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let target_id = if data.get("targetId").is_some() {
            require_positive_int(data, "targetId", "guard targetId")
        } else {
            require_positive_int(data, "targetEid", "guard targetId")
        };
        let ids = self.command_ids_or_all(world, comps, data, &["ids", "entityIds", "guardIds"], "guard", Some(target_id));
        for eid in ids {
            if eid == target_id || !world.rows_by_component[comps.activity_queue].contains_key(&eid) {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            queue.push(Activity::Guard { target_eid: target_id as f64 });
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, 0.0);
            self.reset_steering(world, comps, eid);
        }
        self.diagnostics.guard_commands += 1;
    }

    fn apply_set_stance(&mut self, world: &mut CoreWorld, data: &serde_json::Value) {
        let stance = UnitStance::parse(data.get("stance").unwrap_or(&serde_json::Value::Null));
        let ids: Vec<Eid> = if data.get("ids").is_some() || data.get("entityIds").is_some() {
            let key = if data.get("ids").is_some() { "ids" } else { "entityIds" };
            parse_entity_ids(data, key, "setStance")
        } else {
            world
                .entities
                .iter()
                .copied()
                .filter(|&eid| combat_row(world, &self.ccomps, eid).is_some())
                .collect()
        };
        for eid in ids {
            set_stance(world, &self.aux, eid, stance);
        }
        self.diagnostics.set_stance_commands += 1;
    }

    fn apply_garrison(&mut self, world: &mut CoreWorld, comps: &MovementComps, data: &serde_json::Value) {
        let raw = data
            .get("targetBuildingId")
            .or_else(|| data.get("buildingEid"))
            .or_else(|| data.get("targetId"))
            .and_then(|v| v.as_f64());
        let Some(building) = raw.filter(|v| *v >= 1.0) else { return };
        let Some(ids) = data.get("ids").or_else(|| data.get("entityIds")).and_then(|v| v.as_array()).cloned() else { return };
        for entry in ids {
            let Some(eid) = entry.as_f64().filter(|v| *v > 0.0).map(|v| v as Eid) else { continue };
            write_queue(world, comps, eid, &[Activity::Garrison { target_building_id: building }]);
            self.combat_set(world, eid, 3, 0.0);
        }
        self.diagnostics.garrison_commands += 1;
    }

    fn apply_ungarrison(&mut self, world: &mut CoreWorld, comps: &MovementComps, layers: &Layers, data: &serde_json::Value) {
        let raw = data
            .get("buildingEid")
            .or_else(|| data.get("targetBuildingId"))
            .or_else(|| data.get("targetId"))
            .and_then(|v| v.as_f64());
        let Some(building_eid) = raw.filter(|v| *v >= 1.0).map(|v| v as Eid) else { return };
        let units = clear_garrison(world, &self.bcomps, building_eid);
        if units.is_empty() {
            return;
        }
        let b_row = building_row(world, &self.bcomps, building_eid).cloned();
        let b_pos = row(world, comps.position, building_eid).cloned();
        let (mut exit_x, mut exit_y) = (b_pos.as_ref().map(|p| p[0]).unwrap_or(10.5), b_pos.as_ref().map(|p| p[1]).unwrap_or(10.5));
        if let Some(pt) = data.get("exitPoint").and_then(|v| v.as_object()) {
            if let (Some(px), Some(py)) = (pt.get("x").and_then(|v| v.as_f64()), pt.get("y").and_then(|v| v.as_f64())) {
                exit_x = px;
                exit_y = py;
            }
        } else if let Some(b) = &b_row {
            let def = self.defs.building(self.defs.building_id_of_code(b[1] as u32));
            exit_x = b[2] + def.footprint.width as f64 / 2.0;
            exit_y = b[3] + def.footprint.height as f64 + 0.5;
        } else {
            let size = layers.size as i64;
            let (sx, sy) = ((exit_x).floor() as i64, (exit_y).floor() as i64);
            let mut found: Option<(f64, f64)> = None;
            'rings: for r in 1..=3i64 {
                for ddy in -r..=r {
                    for ddx in -r..=r {
                        if ddx.abs().max(ddy.abs()) != r {
                            continue;
                        }
                        let (tx, ty) = (sx + ddx, sy + ddy);
                        if tx >= 0 && tx < size && ty >= 0 && ty < size
                            && layers.passability[ty as usize * layers.size + tx as usize] != 0
                        {
                            found = Some((tx as f64 + 0.5, ty as f64 + 0.5));
                            break 'rings;
                        }
                    }
                }
            }
            let Some((fx, fy)) = found else {
                write_garrison(world, &self.bcomps, building_eid, &units);
                return;
            };
            exit_x = fx;
            exit_y = fy;
        }
        for u in &units {
            let def_id = self.defs.unit_id_of_code(u.unit_code as u32).to_string();
            let new_eid = spawn_combat_unit(
                world,
                comps,
                &self.ccomps,
                &self.pop,
                &self.traits,
                &self.defs,
                &def_id,
                exit_x,
                exit_y,
                u.owner,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
            self.combat_set(world, new_eid, 2, u.hp);
            attach_stance(world, &self.aux, new_eid, UnitStance::from_code(u.stance_code));
        }
        self.diagnostics.ungarrison_commands += 1;
    }

    fn apply_pack(&mut self, world: &mut CoreWorld, comps: &MovementComps, data: &serde_json::Value, want_state: &str) {
        let Some(ids) = data.get("ids").or_else(|| data.get("entityIds")).and_then(|v| v.as_array()).cloned() else { return };
        for entry in ids {
            let Some(eid) = entry.as_f64().filter(|v| *v >= 1.0).map(|v| v as Eid) else { continue };
            let Some(cr) = combat_row(world, &self.ccomps, eid).cloned() else { continue };
            let def = self.defs.unit(self.defs.unit_id_of_code(cr[0] as u32)).clone();
            if def.siege_state.as_deref() != Some(want_state) {
                continue;
            }
            let Some(morph) = def.morph_target_id.clone() else { continue };
            let pack_ticks = def.pack_time_ticks.unwrap_or(90) as f64;
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            queue.push(Activity::Pack { remaining_ticks: pack_ticks, target_unit_id: morph });
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, 0.0);
            self.reset_steering(world, comps, eid);
        }
        if want_state == "unpacked" {
            self.diagnostics.pack_commands += 1;
        } else {
            self.diagnostics.unpack_commands += 1;
        }
    }

    fn apply_convert(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let target = data
            .get("targetId")
            .or_else(|| data.get("targetEid"))
            .and_then(|v| v.as_f64())
            .filter(|v| *v >= 1.0)
            .map(|v| v as Eid)
            .expect("convert requires a positive numeric targetId");
        assert!(
            combat_row(world, &self.ccomps, target).is_some(),
            "convert targets entity {target}, which has no Combat row"
        );
        let mut monk_ids: Vec<Eid> = Vec::new();
        let raw = data
            .get("monkEid")
            .or_else(|| data.get("ids"))
            .or_else(|| data.get("attackerIds"))
            .or_else(|| data.get("entityIds"));
        match raw {
            Some(v) if v.as_f64().is_some() => monk_ids.push(v.as_f64().unwrap() as Eid),
            Some(v) if v.as_array().is_some() => {
                for entry in v.as_array().unwrap() {
                    if let Some(n) = entry.as_f64().filter(|n| *n >= 1.0) {
                        monk_ids.push(n as Eid);
                    }
                }
            }
            _ => {}
        }
        if monk_ids.is_empty() {
            for &eid in &world.entities.clone() {
                let Some(cr) = combat_row(world, &self.ccomps, eid) else { continue };
                let def_id = self.defs.unit_id_of_code(cr[0] as u32);
                let def = self.defs.unit(def_id);
                if def_id == "monk" || def.armor_classes.iter().any(|c| c == "monk") {
                    monk_ids.push(eid);
                }
            }
        }
        assert!(!monk_ids.is_empty(), "convert command requires at least one monk entity");
        for eid in monk_ids {
            assert!(eid != target, "convert monk {eid} cannot target itself");
            if combat_row(world, &self.ccomps, eid).is_none() {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            queue.push(Activity::Convert { target_eid: target as f64 });
            write_queue(world, comps, eid, &queue);
            self.combat_set(world, eid, 3, target as f64);
            self.reset_steering(world, comps, eid);
            clear_conversion(world, &self.ccomps, eid);
        }
        self.diagnostics.convert_commands += 1;
    }

    pub fn run(
        &mut self,
        world: &mut CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        layers: &mut Layers,
        paths: &mut PathScheduler<Continuation>,
        commands: &[Command],
    ) {
        // 1) Commands on their target-tick boundary.
        for command in commands {
            match command.kind.as_str() {
                ATTACK_KIND => {
                    let data = command.data.as_ref().expect("attack requires command data");
                    self.apply_attack(world, comps, econ, data);
                }
                ATTACK_MOVE_KIND => {
                    let data = command.data.as_ref().expect("attackMove requires command data");
                    self.apply_attack_move(world, comps, econ, layers, paths, data);
                }
                STOP_KIND => {
                    let data = command.data.as_ref().expect("stop requires command data");
                    self.apply_stop(world, comps, econ, data);
                }
                PATROL_KIND => {
                    let data = command.data.as_ref().expect("patrol requires command data");
                    self.apply_patrol(world, comps, econ, data);
                }
                GUARD_KIND => {
                    let data = command.data.as_ref().expect("guard requires command data");
                    self.apply_guard(world, comps, econ, data);
                }
                SET_STANCE_KIND => {
                    let data = command.data.as_ref().expect("setStance requires command data");
                    self.apply_set_stance(world, data);
                }
                GARRISON_KIND => {
                    if let Some(data) = &command.data {
                        self.apply_garrison(world, comps, data);
                    }
                }
                UNGARRISON_KIND => {
                    if let Some(data) = &command.data {
                        self.apply_ungarrison(world, comps, layers, data);
                    }
                }
                PACK_KIND => {
                    if let Some(data) = &command.data {
                        self.apply_pack(world, comps, data, "unpacked");
                    }
                }
                UNPACK_KIND => {
                    if let Some(data) = &command.data {
                        self.apply_pack(world, comps, data, "packed");
                    }
                }
                CONVERT_KIND => {
                    let data = command.data.as_ref().expect("convert requires command data");
                    self.apply_convert(world, comps, econ, data);
                }
                _ => {}
            }
        }

        let mut pass = Pass::collect(self, world, comps, econ, layers, paths);
        pass.run();
    }
}

struct Combatant {
    eid: Eid,
    owner: f64,
    def: UnitDef,
    x: f64,
    y: f64,
    radius: f64,
    elev: i64,
    queue: ActivityQueue,
    dirty: bool,
}

#[derive(Clone, Copy)]
struct Structure {
    #[allow(dead_code)]
    eid: Eid,
    kind_site: bool,
    owner: f64,
    def_code: f64,
    hp_index: usize,
}

struct Pass<'a> {
    sys: &'a mut CombatSystem,
    world: &'a mut CoreWorld,
    comps: &'a MovementComps,
    econ: EconomyComps,
    layers: &'a mut Layers,
    paths: &'a mut PathScheduler<Continuation>,
    combatants: Vec<Combatant>,
    by_eid: HashMap<Eid, usize>,
    positions: HashMap<Eid, (f64, f64, f64)>,
    alive: HashSet<Eid>,
    structures: BTreeMap<Eid, Structure>,
    structure_order: Vec<Eid>,
    damage_this_tick: HashMap<Eid, Eid>,
    hash_by_owner: BTreeMap<i64, EntitySpatialHash>,
    max_elevation: i64,
    tech_codes_by_owner: HashMap<i64, Vec<i64>>,
    empty: bool,
}

impl<'a> Pass<'a> {
    fn collect(
        sys: &'a mut CombatSystem,
        world: &'a mut CoreWorld,
        comps: &'a MovementComps,
        econ: &EconomyComps,
        layers: &'a mut Layers,
        paths: &'a mut PathScheduler<Continuation>,
    ) -> Pass<'a> {
        let mut combatants: Vec<Combatant> = Vec::new();
        let mut positions: HashMap<Eid, (f64, f64, f64)> = HashMap::new();
        let mut alive: HashSet<Eid> = HashSet::new();
        for &eid in &world.entities {
            let Some(cr) = combat_row(world, &sys.ccomps, eid).cloned() else { continue };
            let (Some(pos), true, Some(tag)) = (
                row(world, comps.position, eid),
                row(world, comps.velocity, eid).is_some(),
                row(world, comps.unit_tag, eid),
            ) else {
                continue;
            };
            let (px, py, radius) = (pos[0], pos[1], tag[2]);
            let def = sys.defs.unit(sys.defs.unit_id_of_code(cr[0] as u32)).clone();
            combatants.push(Combatant {
                eid,
                owner: cr[1],
                def,
                x: px,
                y: py,
                radius,
                elev: elevation_at(layers, px, py),
                queue: read_queue(world, comps, eid),
                dirty: false,
            });
            positions.insert(eid, (px, py, radius));
            alive.insert(eid);
        }
        let by_eid: HashMap<Eid, usize> = combatants.iter().enumerate().map(|(i, c)| (c.eid, i)).collect();
        let max_elevation = combatants.iter().map(|c| c.elev).max().unwrap_or(0);

        let mut structures: BTreeMap<Eid, Structure> = BTreeMap::new();
        let mut structure_order: Vec<Eid> = Vec::new();
        for (&eid, site) in world.rows_by_component[sys.bcomps.building_site].iter() {
            let Some(pos) = row(world, comps.position, eid) else { continue };
            let (px, py) = (pos[0], pos[1]);
            positions.insert(eid, (px, py, building_target_radius(&sys.defs, site[1])));
            alive.insert(eid);
            structures.insert(eid, Structure { eid, kind_site: true, owner: site[0], def_code: site[1], hp_index: 3 });
            structure_order.push(eid);
        }
        for (&eid, b) in world.rows_by_component[sys.bcomps.building].iter() {
            let Some(pos) = row(world, comps.position, eid) else { continue };
            let (px, py) = (pos[0], pos[1]);
            positions.insert(eid, (px, py, building_target_radius(&sys.defs, b[1])));
            alive.insert(eid);
            structures.insert(eid, Structure { eid, kind_site: false, owner: b[0], def_code: b[1], hp_index: 4 });
            structure_order.push(eid);
        }

        let mut hash_by_owner: BTreeMap<i64, EntitySpatialHash> = BTreeMap::new();
        for c in &combatants {
            hash_by_owner.entry(c.owner as i64).or_default().insert(c.eid, c.x, c.y);
        }

        let empty = combatants.is_empty() && structures.is_empty();
        Pass {
            sys,
            world,
            comps,
            econ: *econ,
            layers,
            paths,
            combatants,
            by_eid,
            positions,
            alive,
            structures,
            structure_order,
            damage_this_tick: HashMap::new(),
            hash_by_owner,
            max_elevation,
            tech_codes_by_owner: HashMap::new(),
            empty,
        }
    }

    fn crow(&self, eid: Eid) -> Option<[f64; 5]> {
        combat_row(self.world, &self.sys.ccomps, eid).map(|r| [r[0], r[1], r[2], r[3], r[4]])
    }
    fn crow_set(&mut self, eid: Eid, index: usize, value: f64) {
        if let Some(r) = self.world.rows_by_component.get_mut(self.sys.ccomps.combat).and_then(|rows| rows.get_mut(&eid)) {
            r[index] = value;
        }
    }
    fn idx(&self, eid: Eid) -> usize {
        self.by_eid[&eid]
    }

    fn tech_codes(&mut self, owner: f64) -> Vec<i64> {
        if let Some(codes) = self.tech_codes_by_owner.get(&(owner as i64)) {
            return codes.clone();
        }
        let codes = crate::buildings::researched_tech_codes(self.world, &self.sys.age, &self.econ, owner);
        self.tech_codes_by_owner.insert(owner as i64, codes.clone());
        codes
    }

    fn stats_of(&mut self, idx: usize) -> DerivedStats {
        let (owner, eid) = (self.combatants[idx].owner, self.combatants[idx].eid);
        let codes = self.tech_codes(owner);
        let def = self.combatants[idx].def.clone();
        let eq_row = row(self.world, self.sys.aux.equipment, eid).cloned();
        let has_equip = eq_row.as_ref().map(|r| r[0] > 0.0 || r[1] > 0.0).unwrap_or(false);
        let has_skills = pop::has_skills_row(self.world, &self.sys.pop, eid);
        let has_injuries = row(self.world, self.sys.pop.body, eid).map(|r| r[0] != 0.0).unwrap_or(false);
        // TS fast path (formation deliberately not consulted there).
        if codes.is_empty() && !has_equip && !has_skills && !has_injuries {
            return derive_unit_stats(&self.sys.defs, &def, &StatContext::default());
        }
        let equipment = equipment_counts(self.world, &self.sys.aux, eid);
        let skills = if has_skills {
            Some((
                pop::skill_level(self.world, &self.sys.pop, eid, "melee").unwrap_or(0),
                pop::skill_level(self.world, &self.sys.pop, eid, "ranged").unwrap_or(0),
            ))
        } else {
            None
        };
        let impairment = pop::injury_impairment(self.world, &self.sys.pop, eid);
        let formation = Some(get_formation(self.world, &self.sys.aux, eid));
        derive_unit_stats(
            &self.sys.defs,
            &def,
            &StatContext {
                researched_tech_codes: Some(&codes),
                equipment: Some(equipment),
                skill_levels: skills,
                impairment: Some((impairment.attack_mult, impairment.speed_mult)),
                formation,
            },
        )
    }

    fn nearest_enemy(&self, idx: usize, radius: f64) -> Option<usize> {
        let me = &self.combatants[idx];
        let min_range = me.def.min_range;
        let mut best: Option<usize> = None;
        let mut best_dist_sq = f64::INFINITY;
        for (owner, hash) in &self.hash_by_owner {
            if *owner == me.owner as i64 {
                continue;
            }
            let Some((hit_eid, hit_dist)) = hash.nearest(me.x, me.y, radius, min_range.unwrap_or(0.0)) else { continue };
            let better = hit_dist < best_dist_sq
                || (hit_dist == best_dist_sq && best.map(|b| hit_eid < self.combatants[b].eid).unwrap_or(false));
            if better {
                if let Some(&candidate) = self.by_eid.get(&hit_eid) {
                    if self.alive.contains(&hit_eid) {
                        best_dist_sq = hit_dist;
                        best = Some(candidate);
                    }
                }
            }
        }
        best
    }

    fn engagement_intact(&self, idx: usize) -> bool {
        let c = &self.combatants[idx];
        let target = self.crow(c.eid).map(|r| r[3]).unwrap_or(0.0);
        let Some(head) = c.queue.first() else { return false };
        match head {
            Activity::Attack { target_eid } | Activity::Convert { target_eid } => *target_eid == target,
            Activity::Move { .. } | Activity::AttackMove { .. } | Activity::Patrol { .. } => match c.queue.get(1) {
                Some(Activity::Attack { target_eid }) | Some(Activity::Convert { target_eid }) => *target_eid == target,
                _ => false,
            },
            _ => false,
        }
    }

    fn restore_march_target(&mut self, idx: usize) {
        let c = &self.combatants[idx];
        let eid = c.eid;
        match c.queue.first() {
            Some(Activity::Move { waypoints, .. }) | Some(Activity::AttackMove { waypoints, .. }) => {
                let n = waypoints.len();
                let (tx, ty) = (waypoints[n - 2], waypoints[n - 1]);
                self.sys.set_move_target(self.world, self.comps, eid, tx, ty);
            }
            Some(Activity::Patrol { waypoints, cursor, .. }) => {
                let (tx, ty) = (waypoints[*cursor], waypoints[cursor + 1]);
                self.sys.set_move_target(self.world, self.comps, eid, tx, ty);
            }
            Some(Activity::Guard { target_eid }) => {
                if let Some(&(tx, ty, _)) = self.positions.get(&(*target_eid as Eid)) {
                    self.sys.set_move_target(self.world, self.comps, eid, tx, ty);
                }
            }
            _ => {}
        }
    }

    fn drop_engagement(&mut self, idx: usize) {
        let eid = self.combatants[idx].eid;
        {
            let queue = &mut self.combatants[idx].queue;
            match peek(queue).cloned() {
                Some(Activity::Move { .. }) => {
                    if matches!(queue.get(1), Some(Activity::Attack { .. }) | Some(Activity::Convert { .. })) {
                        dequeue_current(queue);
                        dequeue_current(queue);
                    }
                }
                Some(Activity::Attack { .. }) | Some(Activity::Convert { .. }) => {
                    dequeue_current(queue);
                    if matches!(peek(queue), Some(Activity::Move { .. })) {
                        dequeue_current(queue);
                    }
                }
                _ => {}
            }
        }
        self.crow_set(eid, 3, 0.0);
        clear_conversion(self.world, &self.sys.ccomps, eid);
        self.restore_march_target(idx);
        self.combatants[idx].dirty = true;
    }

    fn engage(&mut self, idx: usize, target: Eid) {
        let eid = self.combatants[idx].eid;
        self.crow_set(eid, 3, target as f64);
        {
            let queue = &mut self.combatants[idx].queue;
            match queue.first_mut() {
                Some(Activity::Attack { target_eid }) => *target_eid = target as f64,
                _ => queue.insert(0, Activity::Attack { target_eid: target as f64 }),
            }
        }
        self.sys.reset_steering(self.world, self.comps, eid);
        self.combatants[idx].dirty = true;
    }

    fn reach_of(&self, idx: usize, target_radius: f64, range: f64) -> f64 {
        range + self.combatants[idx].radius + target_radius
    }

    fn stand_point(&self, idx: usize, target: (f64, f64), reach: f64) -> (f64, f64) {
        let me = &self.combatants[idx];
        let (dx, dy) = (me.x - target.0, me.y - target.1);
        let dist = (dx * dx + dy * dy).sqrt();
        if dist <= 1e-9 {
            return target;
        }
        let scale = (reach * RANGE_STAND_FACTOR).min(dist) / dist;
        (target.0 + dx * scale, target.1 + dy * scale)
    }

    fn passable_approach_point(&self, point: (f64, f64)) -> (f64, f64) {
        let size = self.layers.size as i64;
        let passability = &self.layers.passability;
        let tile_passable = |tx: i64, ty: i64| {
            tx >= 0 && ty >= 0 && tx < size && ty < size && passability[ty as usize * self.layers.size + tx as usize] == 1
        };
        let (base_x, base_y) = (point.0.floor() as i64, point.1.floor() as i64);
        if tile_passable(base_x, base_y) {
            return point;
        }
        let mut best: Option<(f64, f64)> = None;
        let mut best_d = f64::INFINITY;
        for ring in 1..=APPROACH_STANDPOINT_SEARCH_RING {
            if best.is_some() {
                break;
            }
            for dy in -ring..=ring {
                for dx in -ring..=ring {
                    if dx.abs().max(dy.abs()) != ring {
                        continue;
                    }
                    let (tx, ty) = (base_x + dx, base_y + dy);
                    if !tile_passable(tx, ty) {
                        continue;
                    }
                    let (cx, cy) = (tx as f64 + 0.5, ty as f64 + 0.5);
                    let d = (cx - point.0) * (cx - point.0) + (cy - point.1) * (cy - point.1);
                    if d < best_d {
                        best_d = d;
                        best = Some((cx, cy));
                    }
                }
            }
        }
        best.unwrap_or(point)
    }

    fn purge_references_to_dead(&mut self, dead: Eid) {
        for idx in 0..self.combatants.len() {
            let eid = self.combatants[idx].eid;
            if !self.alive.contains(&eid) {
                continue;
            }
            if self.crow(eid).map(|r| r[3]) == Some(dead as f64) {
                self.crow_set(eid, 3, 0.0);
            }
            let mut removed = false;
            let mut i = self.combatants[idx].queue.len() as i64 - 1;
            while i >= 0 {
                let activity = self.combatants[idx].queue[i as usize].clone();
                let targets_dead = match &activity {
                    Activity::Attack { target_eid } | Activity::Convert { target_eid } => *target_eid == dead as f64,
                    _ => false,
                };
                if !targets_dead {
                    i -= 1;
                    continue;
                }
                self.combatants[idx].queue.remove(i as usize);
                clear_conversion(self.world, &self.sys.ccomps, eid);
                if i >= 1 && matches!(self.combatants[idx].queue.get((i - 1) as usize), Some(Activity::Move { .. })) {
                    self.combatants[idx].queue.remove((i - 1) as usize);
                    i -= 1;
                }
                removed = true;
                i -= 1;
            }
            if removed {
                self.restore_march_target(idx);
                self.combatants[idx].dirty = true;
            }
        }
    }

    fn kill(&mut self, victim_eid: Eid, killer_eid: Eid, blow: f64) {
        let victim_idx = self.idx(victim_eid);
        let victim_owner = self.combatants[victim_idx].owner;
        let event = CombatEvent {
            tick: self.world.tick,
            kind: COMBAT_EVENT_UNIT_DEATH,
            attacker_eid: killer_eid,
            victim_eid,
            amount: blow,
        };
        append_combat_event(self.world, &self.sys.ccomps.clone(), &self.econ, victim_owner, event);
        if let Some(&killer_idx) = self.by_eid.get(&killer_eid) {
            let slug = if self.combatants[killer_idx].def.range > MELEE_RANGE { "ranged" } else { "melee" };
            pop::award_practice(self.world, &self.sys.pop, &self.sys.traits.clone(), killer_eid, slug, COMBAT_XP_PER_KILL);
        }
        self.purge_references_to_dead(victim_eid);
        drop_carried_relics(self.world, &self.sys.aux.clone(), self.comps, victim_eid);
        clear_garrison(self.world, &self.sys.bcomps.clone(), victim_eid);
        self.world.despawn(victim_eid);
        self.alive.remove(&victim_eid);
        self.sys.diagnostics.kills += 1;
    }

    fn destroy_structure(&mut self, victim_eid: Eid, killer_eid: Eid, blow: f64) {
        let structure = self.structures[&victim_eid];
        let event = CombatEvent {
            tick: self.world.tick,
            kind: COMBAT_EVENT_DEATH,
            attacker_eid: killer_eid,
            victim_eid,
            amount: blow,
        };
        append_combat_event(self.world, &self.sys.ccomps.clone(), &self.econ, structure.owner, event);

        let entities: Vec<Eid> = self.world.entities.clone();
        for worker in entities {
            let assigned_here = assigned_site(self.world, &self.sys.bcomps, worker) == Some(victim_eid)
                || production_job(self.world, &self.sys.pcomps, worker).map(|j| j.0) == Some(victim_eid);
            if !assigned_here {
                continue;
            }
            clear_assigned_site(self.world, &self.sys.bcomps, worker);
            clear_production_job(self.world, &self.sys.pcomps, worker);
            let mut queue = read_queue(self.world, self.comps, worker);
            cancel_activities(&mut queue);
            write_queue(self.world, self.comps, worker, &queue);
            self.sys.reset_steering(self.world, self.comps, worker);
            self.sys.diagnostics.workers_retasked += 1;
        }

        let def = self.sys.defs.building(self.sys.defs.building_id_of_code(structure.def_code as u32)).clone();
        let (origin_x, origin_y) = if !structure.kind_site {
            let r = building_row(self.world, &self.sys.bcomps, victim_eid).expect("building row");
            (r[2], r[3])
        } else {
            let pos = row(self.world, self.comps.position, victim_eid).expect("site position");
            (pos[0] - def.footprint.width as f64 / 2.0, pos[1] - def.footprint.height as f64 / 2.0)
        };
        let size = self.layers.size;
        for dy in 0..def.footprint.height {
            for dx in 0..def.footprint.width {
                self.layers.passability[(origin_y as i64 + dy) as usize * size + (origin_x as i64 + dx) as usize] = 1;
            }
        }
        let next = self.paths.passability_version() + 1;
        self.paths.set_passability_version(next).expect("monotonic version");

        spawn_rubble(self.world, self.comps, &self.sys.bcomps.clone(), &self.sys.defs.clone(), structure.def_code, origin_x, origin_y);
        self.purge_references_to_dead(victim_eid);
        drop_stored_relics(self.world, &self.sys.aux.clone(), self.comps, victim_eid);

        let trapped = clear_garrison(self.world, &self.sys.bcomps.clone(), victim_eid);
        for u in &trapped {
            let def_id = self.sys.defs.unit_id_of_code(u.unit_code as u32).to_string();
            let new_eid = spawn_combat_unit(
                self.world,
                self.comps,
                &self.sys.ccomps.clone(),
                &self.sys.pop,
                &self.sys.traits.clone(),
                &self.sys.defs.clone(),
                &def_id,
                origin_x + 0.5,
                origin_y + 0.5,
                u.owner,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
            self.crow_set(new_eid, 2, (u.hp * 0.5).floor().max(1.0));
            attach_stance(self.world, &self.sys.aux.clone(), new_eid, UnitStance::from_code(u.stance_code));
        }

        self.world.despawn(victim_eid);
        self.alive.remove(&victim_eid);
        self.structures.remove(&victim_eid);
        self.sys.diagnostics.buildings_destroyed += 1;
    }

    fn child_cannot_fight(&self, idx: usize) -> bool {
        let eid = self.combatants[idx].eid;
        row(self.world, self.sys.pop.identity, eid).is_some() && pop::is_child(self.world, &self.sys.pop, eid)
    }

    fn strike(&mut self, attacker_idx: usize, target_eid: Eid) {
        if self.child_cannot_fight(attacker_idx) {
            return;
        }
        let Some(target_pos) = self.positions.get(&target_eid).copied() else { return };
        if self.crow(target_eid).is_none() {
            return;
        }
        let Some(&target_idx) = self.by_eid.get(&target_eid) else { return };
        let attacker_eid = self.combatants[attacker_idx].eid;
        let attacker_owner = self.combatants[attacker_idx].owner;
        let attacker_stats = self.stats_of(attacker_idx);
        let defender_stats = self.stats_of(target_idx);
        let attacker_def = self.combatants[attacker_idx].def.clone();
        let target_def = self.combatants[target_idx].def.clone();
        let base_damage = strike_damage(&attacker_def, &attacker_stats, &target_def, &defender_stats);
        let mut damage = base_damage;
        if self.max_elevation > 0 && self.combatants[attacker_idx].elev != self.combatants[target_idx].elev {
            damage = apply_elevation_damage(base_damage, self.combatants[attacker_idx].elev, self.combatants[target_idx].elev);
        }
        {
            let r = self.world.rows_by_component.get_mut(self.sys.ccomps.combat).unwrap().get_mut(&target_eid).unwrap();
            r[2] = (r[2] - damage).max(0.0);
        }
        self.sys.diagnostics.strikes += 1;
        let tick = self.world.tick;
        if attacker_stats.range > MELEE_RANGE {
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                attacker_owner,
                CombatEvent { tick, kind: COMBAT_EVENT_SHOT, attacker_eid, victim_eid: target_eid, amount: damage },
            );
        }
        let target_owner = self.combatants[target_idx].owner;
        append_combat_event(
            self.world,
            &self.sys.ccomps.clone(),
            &self.econ,
            target_owner,
            CombatEvent { tick, kind: COMBAT_EVENT_DAMAGE, attacker_eid, victim_eid: target_eid, amount: damage },
        );
        let wounds = apply_strike_injuries(self.world, &self.sys.pop, target_eid, damage);
        let slug = if attacker_stats.range > MELEE_RANGE { "ranged" } else { "melee" };
        pop::award_practice(self.world, &self.sys.pop, &self.sys.traits.clone(), attacker_eid, slug, COMBAT_XP_PER_HIT);
        self.damage_this_tick.entry(target_eid).or_insert(attacker_eid);
        let hp = self.crow(target_eid).map(|r| r[2]).unwrap_or(0.0);
        if hp <= 0.0 || wounds.fatal {
            self.kill(target_eid, attacker_eid, damage);
        }
        self.apply_aoe_blast(attacker_idx, &attacker_stats, target_pos.0, target_pos.1, target_eid);
    }

    fn strike_structure(&mut self, attacker_idx: usize, target_eid: Eid) {
        if self.child_cannot_fight(attacker_idx) {
            return;
        }
        let Some(structure) = self.structures.get(&target_eid).copied() else { return };
        let Some(target_pos) = self.positions.get(&target_eid).copied() else { return };
        let attacker_eid = self.combatants[attacker_idx].eid;
        let attacker_owner = self.combatants[attacker_idx].owner;
        let attacker_stats = self.stats_of(attacker_idx);
        let attacker_def = self.combatants[attacker_idx].def.clone();
        let base_damage = strike_damage_on_building(&attacker_def, &attacker_stats);
        let mut damage = base_damage;
        if self.max_elevation > 0 {
            let target_elev = elevation_at(self.layers, target_pos.0, target_pos.1);
            if self.combatants[attacker_idx].elev != target_elev {
                damage = apply_elevation_damage(base_damage, self.combatants[attacker_idx].elev, target_elev);
            }
        }
        let component = if structure.kind_site { self.sys.bcomps.building_site } else { self.sys.bcomps.building };
        let new_hp = {
            let r = self.world.rows_by_component.get_mut(component).unwrap().get_mut(&target_eid).unwrap();
            r[structure.hp_index] = (r[structure.hp_index] - damage).max(0.0);
            r[structure.hp_index]
        };
        self.sys.diagnostics.strikes += 1;
        let tick = self.world.tick;
        if attacker_stats.range > MELEE_RANGE {
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                attacker_owner,
                CombatEvent { tick, kind: COMBAT_EVENT_SHOT, attacker_eid, victim_eid: target_eid, amount: damage },
            );
        }
        append_combat_event(
            self.world,
            &self.sys.ccomps.clone(),
            &self.econ,
            structure.owner,
            CombatEvent { tick, kind: COMBAT_EVENT_DAMAGE, attacker_eid, victim_eid: target_eid, amount: damage },
        );
        if new_hp <= 0.0 {
            self.destroy_structure(target_eid, attacker_eid, damage);
        }
        self.apply_aoe_blast(attacker_idx, &attacker_stats, target_pos.0, target_pos.1, target_eid);
    }

    fn apply_aoe_blast(&mut self, attacker_idx: usize, attacker_stats: &DerivedStats, blast_x: f64, blast_y: f64, target_eid: Eid) {
        let Some(aoe_radius) = self.combatants[attacker_idx].def.aoe_radius.filter(|r| *r > 0.0) else { return };
        let attacker_eid = self.combatants[attacker_idx].eid;
        let attacker_owner = self.combatants[attacker_idx].owner;
        let attacker_def = self.combatants[attacker_idx].def.clone();
        for other_idx in 0..self.combatants.len() {
            let other_eid = self.combatants[other_idx].eid;
            if other_eid == target_eid || !self.alive.contains(&other_eid) {
                continue;
            }
            let (odx, ody) = (self.combatants[other_idx].x - blast_x, self.combatants[other_idx].y - blast_y);
            let max_dist = aoe_radius + self.combatants[other_idx].radius;
            if odx * odx + ody * ody > max_dist * max_dist {
                continue;
            }
            if self.crow(other_eid).is_none() {
                continue;
            }
            let other_stats = self.stats_of(other_idx);
            let other_def = self.combatants[other_idx].def.clone();
            let splash = strike_damage(&attacker_def, attacker_stats, &other_def, &other_stats);
            {
                let r = self.world.rows_by_component.get_mut(self.sys.ccomps.combat).unwrap().get_mut(&other_eid).unwrap();
                r[2] = (r[2] - splash).max(0.0);
            }
            let other_owner = self.combatants[other_idx].owner;
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                other_owner,
                CombatEvent {
                    tick: self.world.tick,
                    kind: COMBAT_EVENT_DAMAGE,
                    attacker_eid,
                    victim_eid: other_eid,
                    amount: splash,
                },
            );
            let wounds = apply_strike_injuries(self.world, &self.sys.pop, other_eid, splash);
            if attacker_owner != other_owner && !self.damage_this_tick.contains_key(&other_eid) {
                self.damage_this_tick.insert(other_eid, attacker_eid);
            }
            let hp = self.crow(other_eid).map(|r| r[2]).unwrap_or(0.0);
            if hp <= 0.0 || wounds.fatal {
                self.kill(other_eid, attacker_eid, splash);
            }
        }
        let structure_eids: Vec<Eid> = self.structure_order.clone();
        for struct_eid in structure_eids {
            if struct_eid == target_eid || !self.alive.contains(&struct_eid) {
                continue;
            }
            let Some(structure) = self.structures.get(&struct_eid).copied() else { continue };
            let Some(s_pos) = self.positions.get(&struct_eid).copied() else { continue };
            let (sdx, sdy) = (s_pos.0 - blast_x, s_pos.1 - blast_y);
            let max_dist = aoe_radius + s_pos.2;
            if sdx * sdx + sdy * sdy > max_dist * max_dist {
                continue;
            }
            let damage = strike_damage_on_building(&attacker_def, attacker_stats);
            let component = if structure.kind_site { self.sys.bcomps.building_site } else { self.sys.bcomps.building };
            let new_hp = {
                let r = self.world.rows_by_component.get_mut(component).unwrap().get_mut(&struct_eid).unwrap();
                r[structure.hp_index] = (r[structure.hp_index] - damage).max(0.0);
                r[structure.hp_index]
            };
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                structure.owner,
                CombatEvent {
                    tick: self.world.tick,
                    kind: COMBAT_EVENT_DAMAGE,
                    attacker_eid,
                    victim_eid: struct_eid,
                    amount: damage,
                },
            );
            if new_hp <= 0.0 {
                self.destroy_structure(struct_eid, attacker_eid, damage);
            }
        }
    }

    fn approach_leg(&mut self, idx: usize, target_pos: (f64, f64, f64), reach: f64, second_kind_convert: bool) {
        let eid = self.combatants[idx].eid;
        if is_naval_unit(self.world, &self.sys.ccomps, &self.sys.defs, eid) {
            panic!("combat: naval approach passability lands with the navigability port (eid {eid})");
        }
        let stand = self.stand_point(idx, (target_pos.0, target_pos.1), reach);
        let stand = self.passable_approach_point(stand);
        let head_kind = self.combatants[idx].queue.first().map(|a| a.kind_name());
        match head_kind {
            None | Some("attack") | Some("convert") => {
                self.combatants[idx]
                    .queue
                    .insert(0, move_activity(&[stand.0, stand.1]).expect("move activity"));
                self.sys.set_move_target(self.world, self.comps, eid, stand.0, stand.1);
                self.sys.reset_steering(self.world, self.comps, eid);
                self.combatants[idx].dirty = true;
            }
            Some("move") | Some("attackMove") | Some("patrol") => {
                let second_ok = match self.combatants[idx].queue.get(1) {
                    Some(Activity::Convert { .. }) => second_kind_convert,
                    Some(Activity::Attack { .. }) => !second_kind_convert,
                    _ => false,
                };
                if !second_ok {
                    return;
                }
                let queue = &mut self.combatants[idx].queue;
                let head = &mut queue[0];
                let Some((waypoints, cursor)) = head.waypoints_mut() else { return };
                let n = waypoints.len();
                let (tail_x, tail_y) = (waypoints[n - 2], waypoints[n - 1]);
                let (drift_x, drift_y) = (tail_x - stand.0, tail_y - stand.1);
                if drift_x * drift_x + drift_y * drift_y > APPROACH_REFRESH_DISTANCE * APPROACH_REFRESH_DISTANCE {
                    *waypoints = vec![stand.0, stand.1];
                    *cursor = 0;
                    self.sys.set_move_target(self.world, self.comps, eid, stand.0, stand.1);
                    self.combatants[idx].dirty = true;
                }
            }
            _ => {}
        }
    }

    fn run(&mut self) {
        if self.empty {
            return;
        }

        // 2a) Faith regeneration for idle monks.
        {
            let faith_eids: Vec<Eid> = self.world.rows_by_component[self.sys.ccomps.faith].keys().copied().collect();
            for eid in faith_eids {
                if !self.alive.contains(&eid) {
                    continue;
                }
                let (max_faith, regen) = match self.by_eid.get(&eid) {
                    Some(&i) => (
                        self.combatants[i].def.max_faith.unwrap_or(100.0),
                        self.combatants[i].def.faith_regen_per_tick.unwrap_or(1.0),
                    ),
                    None => (100.0, 1.0),
                };
                if let Some(r) = self.world.rows_by_component.get_mut(self.sys.ccomps.faith).and_then(|rows| rows.get_mut(&eid)) {
                    if r[1] == 0.0 && r[0] < max_faith {
                        r[0] = (r[0] + regen).min(max_faith);
                    }
                }
            }
        }

        // 5) Engagement validation.
        for idx in 0..self.combatants.len() {
            let eid = self.combatants[idx].eid;
            if !self.alive.contains(&eid) {
                continue;
            }
            let target = self.crow(eid).map(|r| r[3]).unwrap_or(0.0);
            if target == 0.0 {
                continue;
            }
            if !self.engagement_intact(idx) {
                self.drop_engagement(idx);
            } else if !self.alive.contains(&(target as Eid)) {
                self.drop_engagement(idx);
            } else if is_routing(self.world, &self.sys.ccomps, eid) {
                self.drop_engagement(idx);
            }
        }

        // Pack/unpack advance.
        for idx in 0..self.combatants.len() {
            if self.combatants[idx].def.siege_state.is_none() {
                continue;
            }
            let eid = self.combatants[idx].eid;
            if !self.alive.contains(&eid) {
                continue;
            }
            let mut done: Option<String> = None;
            {
                let c = &mut self.combatants[idx];
                if let Some(Activity::Pack { remaining_ticks, target_unit_id }) = c.queue.first_mut() {
                    *remaining_ticks -= 1.0;
                    c.dirty = true;
                    if *remaining_ticks <= 0.0 {
                        done = Some(target_unit_id.clone());
                    }
                }
            }
            if done.is_some() || matches!(peek(&self.combatants[idx].queue), Some(Activity::Pack { .. })) {
                if self.crow(eid).map(|r| r[3]) != Some(0.0) {
                    self.crow_set(eid, 3, 0.0);
                }
            }
            if let Some(new_def_id) = done {
                dequeue_current(&mut self.combatants[idx].queue);
                self.crow_set(eid, 0, self.sys.defs.unit_code(&new_def_id) as f64);
                let new_def = self.sys.defs.unit(&new_def_id).clone();
                self.combatants[idx].def = new_def.clone();
                if let Some(tag) = self.world.rows_by_component.get_mut(self.comps.unit_tag).and_then(|r| r.get_mut(&eid)) {
                    tag[0] = new_def.speed;
                }
            }
        }

        // 6) Advance engagements ascending eid.
        for idx in 0..self.combatants.len() {
            let eid = self.combatants[idx].eid;
            if !self.alive.contains(&eid) {
                continue;
            }
            let target_eid = self.crow(eid).map(|r| r[3]).unwrap_or(0.0) as Eid;
            if target_eid == 0 {
                continue;
            }
            let Some(target_body) = self.positions.get(&target_eid).copied() else { continue };
            let is_convert = {
                let q = &self.combatants[idx].queue;
                match q.first() {
                    Some(Activity::Convert { .. }) => true,
                    Some(Activity::Move { .. }) | Some(Activity::AttackMove { .. }) | Some(Activity::Patrol { .. }) => {
                        matches!(q.get(1), Some(Activity::Convert { .. }))
                    }
                    _ => false,
                }
            };
            if is_convert {
                self.advance_convert(idx, target_eid, target_body);
                continue;
            }

            let codes = self.tech_codes(self.combatants[idx].owner);
            let has_techs = !codes.is_empty();
            let effective_range = if has_techs {
                self.stats_of(idx).range
            } else {
                self.combatants[idx].def.range
            };
            let target_elev = self.by_eid.get(&target_eid).map(|&i| self.combatants[i].elev).unwrap_or(self.combatants[idx].elev);
            let range_bonus = if self.max_elevation > 0 && effective_range > MELEE_RANGE {
                elevation_range_bonus(self.combatants[idx].elev, target_elev)
            } else {
                0.0
            };
            let reach = self.reach_of(idx, target_body.2, effective_range + range_bonus);
            {
                let cd = self.crow(eid).map(|r| r[4]).unwrap_or(0.0);
                self.crow_set(eid, 4, (cd - 1.0).max(0.0));
            }
            let (dx, dy) = (target_body.0 - self.combatants[idx].x, target_body.1 - self.combatants[idx].y);
            let dist_sq = dx * dx + dy * dy;
            if dist_sq <= reach * reach {
                if let Some(min_range) = self.combatants[idx].def.min_range {
                    if dist_sq < min_range * min_range {
                        continue;
                    }
                }
                if self.crow(eid).map(|r| r[4]).unwrap_or(0.0) <= 0.0 {
                    if self.structures.contains_key(&target_eid) {
                        self.strike_structure(idx, target_eid);
                    } else {
                        self.strike(idx, target_eid);
                    }
                    let reload = if has_techs {
                        self.stats_of(idx).reload_ticks
                    } else {
                        self.combatants[idx].def.reload_ticks.map(|v| v as f64).unwrap_or(DEFAULT_RELOAD_TICKS)
                    };
                    self.crow_set(eid, 4, reload);
                }
                continue;
            }
            if self.combatants[idx].def.speed == 0.0 {
                continue;
            }
            let stance = get_stance(self.world, &self.sys.aux, eid);
            if stance == UnitStance::StandGround {
                self.drop_engagement(idx);
                continue;
            }
            if stance == UnitStance::Defensive && dist_sq > 16.0 {
                self.drop_engagement(idx);
                continue;
            }
            self.approach_leg(idx, target_body, reach, false);
        }

        // 6b) Defensive structure strikes.
        self.defensive_structure_fire();

        // 6c) Conversion interruption for monks damaged this tick.
        if !self.damage_this_tick.is_empty() {
            let damaged: Vec<Eid> = self.damage_this_tick.keys().copied().collect();
            for eid in damaged {
                if !self.world.rows_by_component[self.sys.ccomps.faith].contains_key(&eid) {
                    continue;
                }
                let Some(&idx) = self.by_eid.get(&eid) else { continue };
                if !self.alive.contains(&eid) {
                    continue;
                }
                let q = &self.combatants[idx].queue;
                let is_convert = match q.first() {
                    Some(Activity::Convert { .. }) => true,
                    Some(Activity::Move { .. }) | Some(Activity::AttackMove { .. }) | Some(Activity::Patrol { .. }) => {
                        matches!(q.get(1), Some(Activity::Convert { .. }))
                    }
                    _ => false,
                };
                if is_convert {
                    self.drop_engagement(idx);
                }
            }
        }

        // 7) Acquisition: retaliation, then guard/attackMove/patrol aggro.
        for idx in 0..self.combatants.len() {
            let eid = self.combatants[idx].eid;
            if !self.alive.contains(&eid) {
                continue;
            }
            if self.crow(eid).map(|r| r[3]).unwrap_or(0.0) != 0.0 {
                continue;
            }
            if is_routing(self.world, &self.sys.ccomps, eid) {
                continue;
            }
            if self.combatants[idx].def.attack <= 0.0 {
                continue;
            }
            if self.combatants[idx].def.siege_state.is_some()
                && matches!(peek(&self.combatants[idx].queue), Some(Activity::Pack { .. }))
            {
                continue;
            }
            let stance = get_stance(self.world, &self.sys.aux, eid);
            if stance == UnitStance::NoAttack {
                continue;
            }
            if let Some(&attacker_eid) = self.damage_this_tick.get(&eid) {
                if self.alive.contains(&attacker_eid) {
                    let apos = self.positions[&attacker_eid];
                    let (ddx, ddy) = (apos.0 - self.combatants[idx].x, apos.1 - self.combatants[idx].y);
                    let dist_sq = ddx * ddx + ddy * ddy;
                    let min_range = self.combatants[idx].def.min_range.unwrap_or(0.0);
                    let max_retaliate = if stance == UnitStance::StandGround {
                        self.combatants[idx].def.range + self.combatants[idx].radius + apos.2
                    } else {
                        sight_of(&self.combatants[idx].def)
                    };
                    if dist_sq <= max_retaliate * max_retaliate && (min_range == 0.0 || dist_sq >= min_range * min_range) {
                        self.engage(idx, attacker_eid);
                        self.sys.diagnostics.retaliations += 1;
                        continue;
                    }
                }
            }
            let head = peek(&self.combatants[idx].queue).cloned();
            if matches!(head, Some(Activity::Pack { .. })) {
                continue;
            }
            match head {
                Some(Activity::Guard { target_eid }) => {
                    let guarded = target_eid as Eid;
                    if let Some(&guarded_attacker) = self.damage_this_tick.get(&guarded) {
                        if self.alive.contains(&guarded_attacker) {
                            self.engage(idx, guarded_attacker);
                            self.sys.diagnostics.aggro_acquisitions += 1;
                            continue;
                        }
                    }
                    let base_sight = sight_of(&self.combatants[idx].def);
                    let effective_sight = if self.max_elevation > 0 {
                        base_sight + elevation_sight_bonus(self.combatants[idx].elev, 0)
                    } else {
                        base_sight
                    };
                    if let Some(enemy) = self.nearest_enemy(idx, effective_sight) {
                        let enemy_eid = self.combatants[enemy].eid;
                        self.engage(idx, enemy_eid);
                        self.sys.diagnostics.aggro_acquisitions += 1;
                    }
                }
                Some(Activity::AttackMove { .. }) | Some(Activity::Patrol { .. }) => {
                    let max_range = if stance == UnitStance::StandGround {
                        self.combatants[idx].def.range
                    } else {
                        sight_of(&self.combatants[idx].def)
                    };
                    if let Some(enemy) = self.nearest_enemy(idx, max_range) {
                        let enemy_eid = self.combatants[enemy].eid;
                        self.engage(idx, enemy_eid);
                        self.sys.diagnostics.aggro_acquisitions += 1;
                    }
                }
                _ => {}
            }
        }

        // 8) Flush queue writes.
        for idx in 0..self.combatants.len() {
            let eid = self.combatants[idx].eid;
            if self.combatants[idx].dirty && self.alive.contains(&eid) {
                let queue = self.combatants[idx].queue.clone();
                write_queue(self.world, self.comps, eid, &queue);
            }
        }
    }

    fn advance_convert(&mut self, idx: usize, target_eid: Eid, target_body: (f64, f64, f64)) {
        let eid = self.combatants[idx].eid;
        if self.structures.contains_key(&target_eid) || !self.alive.contains(&target_eid) {
            self.drop_engagement(idx);
            return;
        }
        let convert_range = self.combatants[idx]
            .def
            .convert_range
            .unwrap_or(if self.combatants[idx].def.sight_radius != 0.0 { self.combatants[idx].def.sight_radius } else { 8.0 });
        let sight = if self.combatants[idx].def.sight_radius != 0.0 { self.combatants[idx].def.sight_radius } else { 8.0 };
        let reach = self.reach_of(idx, target_body.2, convert_range);
        let sight_reach = self.reach_of(idx, target_body.2, sight);
        let (dx, dy) = (target_body.0 - self.combatants[idx].x, target_body.1 - self.combatants[idx].y);
        let dist_sq = dx * dx + dy * dy;
        if dist_sq > sight_reach * sight_reach {
            self.drop_engagement(idx);
            return;
        }
        if dist_sq > reach * reach {
            if get_conversion_progress(self.world, &self.sys.ccomps, eid) > 0.0 {
                clear_conversion(self.world, &self.sys.ccomps, eid);
            }
            if self.combatants[idx].def.speed == 0.0 {
                return;
            }
            self.approach_leg(idx, target_body, reach, true);
            return;
        }
        if matches!(peek(&self.combatants[idx].queue), Some(Activity::Move { .. })) {
            dequeue_current(&mut self.combatants[idx].queue);
            self.combatants[idx].dirty = true;
        }
        let faith = if self.world.rows_by_component[self.sys.ccomps.faith].contains_key(&eid) {
            get_faith(self.world, &self.sys.ccomps, eid)
        } else {
            100.0
        };
        let max_faith = self.combatants[idx].def.max_faith.unwrap_or(100.0);
        if faith < max_faith {
            clear_conversion(self.world, &self.sys.ccomps, eid);
            return;
        }
        if self.damage_this_tick.contains_key(&eid) {
            self.drop_engagement(idx);
            return;
        }
        let current = if self.world.rows_by_component[self.sys.ccomps.faith].contains_key(&eid) {
            get_conversion_progress(self.world, &self.sys.ccomps, eid)
        } else {
            0.0
        };
        let next = current + 1.0;
        let cast_ticks = self.combatants[idx].def.cast_ticks.unwrap_or(25) as f64;
        set_conversion(self.world, &self.sys.ccomps, eid, target_eid, next);
        if next >= cast_ticks {
            let Some(&target_idx) = self.by_eid.get(&target_eid) else { return };
            let new_owner = self.combatants[idx].owner;
            self.crow_set(target_eid, 1, new_owner);
            if new_owner == 0.0 {
                self.world.rows_by_component.get_mut(self.sys.pop.owner).map(|r| r.remove(&target_eid));
            } else {
                self.world.set_values(self.sys.pop.owner, target_eid, &[new_owner]).expect("registered component");
            }
            cancel_activities(&mut self.combatants[target_idx].queue);
            self.crow_set(target_eid, 3, 0.0);
            self.combatants[target_idx].dirty = true;
            for ally in 0..self.combatants.len() {
                if self.combatants[ally].owner == new_owner
                    && self.crow(self.combatants[ally].eid).map(|r| r[3]) == Some(target_eid as f64)
                {
                    self.drop_engagement(ally);
                }
            }
            set_faith(self.world, &self.sys.ccomps, eid, 0.0);
            clear_conversion(self.world, &self.sys.ccomps, eid);
            self.drop_engagement(idx);
        }
    }

    fn defensive_structure_fire(&mut self) {
        let order: Vec<Eid> = self.structure_order.clone();
        for building_eid in order {
            let Some(structure) = self.structures.get(&building_eid).copied() else { continue };
            if structure.kind_site {
                continue;
            }
            let def_id = self.sys.defs.building_id_of_code(structure.def_code as u32).to_string();
            let b_def = self.sys.defs.building(&def_id).clone();
            if b_def.attack.is_none() && b_def.garrison_capacity.is_none() {
                continue;
            }
            let mut garrison_units = read_garrison(self.world, &self.sys.bcomps, building_eid);
            let heal_rate = b_def.garrison_heal_rate.unwrap_or(0.05);
            if heal_rate > 0.0 && !garrison_units.is_empty() {
                let mut healed = false;
                for gu in garrison_units.iter_mut() {
                    if gu.hp < gu.max_hp {
                        gu.hp = (gu.hp + heal_rate).min(gu.max_hp);
                        healed = true;
                    }
                }
                if healed {
                    write_garrison(self.world, &self.sys.bcomps.clone(), building_eid, &garrison_units);
                }
            }
            let mut garrison_bonus = 0.0;
            if !garrison_units.is_empty() {
                if let Some(bonus) = &b_def.garrison_attack_bonus {
                    for gu in &garrison_units {
                        garrison_bonus += match bonus {
                            crate::defs::GarrisonAttackBonus::Flat(v) => *v,
                            crate::defs::GarrisonAttackBonus::PerUnit(map) => {
                                let uid = self.sys.defs.unit_id_of_code(gu.unit_code as u32);
                                map.get(uid).or_else(|| map.get("default")).copied().unwrap_or(1.0)
                            }
                        };
                    }
                }
            }
            let mut attack = b_def.attack.unwrap_or(0.0) + garrison_bonus;
            let range = b_def.range.unwrap_or(if def_id == "town-center" { 6.0 } else { 8.0 });
            if attack <= 0.0 || range <= 0.0 {
                continue;
            }
            let reload = b_def.reload_ticks.unwrap_or(60);
            if (self.world.tick as i64 + building_eid) % reload != 0 {
                continue;
            }
            let Some(tower_pos) = self.positions.get(&building_eid).copied() else { continue };
            if def_id == "watch-tower" {
                let rank = age_rank_of(self.world, &self.sys.age, structure.owner).unwrap_or(2.0);
                if rank == 3.0 {
                    attack += 2.0;
                } else if rank >= 4.0 {
                    attack += 3.0;
                }
            }
            let tower_elev = elevation_at(self.layers, tower_pos.0, tower_pos.1);
            let mut best_dist_sq = (range + 1.0) * (range + 1.0);
            let mut target_eid: Option<Eid> = None;
            for idx in 0..self.combatants.len() {
                let c = &self.combatants[idx];
                if !self.alive.contains(&c.eid) || c.owner == structure.owner {
                    continue;
                }
                let (dx, dy) = (c.x - tower_pos.0, c.y - tower_pos.1);
                let dist_sq = dx * dx + dy * dy;
                let effective = range + if self.max_elevation > 0 { elevation_range_bonus(tower_elev, c.elev) } else { 0.0 };
                if dist_sq <= effective * effective && dist_sq <= best_dist_sq {
                    best_dist_sq = dist_sq;
                    target_eid = Some(c.eid);
                }
            }
            let Some(target_eid) = target_eid else { continue };
            let Some(&target_idx) = self.by_eid.get(&target_eid) else { continue };
            if self.crow(target_eid).is_none() {
                continue;
            }
            let defender_stats = self.stats_of(target_idx);
            let target_def = self.combatants[target_idx].def.clone();
            let mut armor = effective_armor_of(&defender_stats, &target_def.armor_classes);
            let pierce = defender_stats.armor_by_class.get("pierce").copied().unwrap_or(0.0);
            if pierce > armor {
                armor = pierce;
            }
            let base_dmg = (attack - armor).floor().max(1.0);
            let damage = if self.max_elevation > 0 {
                apply_elevation_damage(base_dmg, tower_elev, self.combatants[target_idx].elev)
            } else {
                base_dmg
            };
            {
                let r = self.world.rows_by_component.get_mut(self.sys.ccomps.combat).unwrap().get_mut(&target_eid).unwrap();
                r[2] = (r[2] - damage).max(0.0);
            }
            self.sys.diagnostics.strikes += 1;
            let tick = self.world.tick;
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                structure.owner,
                CombatEvent { tick, kind: COMBAT_EVENT_SHOT, attacker_eid: building_eid, victim_eid: target_eid, amount: damage },
            );
            let target_owner = self.combatants[target_idx].owner;
            append_combat_event(
                self.world,
                &self.sys.ccomps.clone(),
                &self.econ,
                target_owner,
                CombatEvent { tick, kind: COMBAT_EVENT_DAMAGE, attacker_eid: building_eid, victim_eid: target_eid, amount: damage },
            );
            let wounds = apply_strike_injuries(self.world, &self.sys.pop, target_eid, damage);
            let hp = self.crow(target_eid).map(|r| r[2]).unwrap_or(0.0);
            if hp <= 0.0 || wounds.fatal {
                self.kill(target_eid, building_eid, damage);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::{read_combat_events, spawn_combat_unit};
    use crate::economy::{
        assigned_node, create_drop_off, create_player_stockpile, inventory, resource_node_row,
        spawn_resource_node, PLAYER_ONE,
    };
    use crate::gather::EconomySim;
    use crate::mapgen::{Layers, TERRAIN_GRASS};
    use crate::path::Transport;
    use crate::pop::TraitsData;
    use serde::Deserialize;
    use std::sync::OnceLock;

    fn defs() -> Arc<Defs> {
        static DEFS: OnceLock<Arc<Defs>> = OnceLock::new();
        DEFS.get_or_init(|| Arc::new(Defs::load_repo_defaults().expect("load defs"))).clone()
    }
    fn traits() -> Arc<TraitsData> {
        static TRAITS: OnceLock<Arc<TraitsData>> = OnceLock::new();
        TRAITS.get_or_init(|| Arc::new(TraitsData::load_repo_defaults().expect("load traits"))).clone()
    }

    fn snapshot_digests(name: &str) -> Vec<(u64, String)> {
        let dir = format!("{}/../tests/golden/{name}/__snapshots__", env!("CARGO_MANIFEST_DIR"));
        let mut text = String::new();
        for entry in std::fs::read_dir(&dir).expect("snapshot dir") {
            let p = entry.expect("entry").path();
            if p.extension().map(|e| e == "snap").unwrap_or(false) {
                text.push_str(&std::fs::read_to_string(p).expect("read snap"));
            }
        }
        let mut out = Vec::new();
        let mut rest = text.as_str();
        while let Some(i) = rest.find("fnv1a64:") {
            let digest = rest[i..i + 24].to_string();
            let after = &rest[i..];
            let tick_at = after.find("\"tick\":").expect("tick after digest");
            let num: String = after[tick_at + 7..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
            out.push((num.parse::<u64>().expect("tick"), digest));
            rest = &rest[i + 24..];
        }
        assert!(!out.is_empty());
        out
    }

    #[derive(Deserialize)]
    struct FixtureSpawn {
        eid: i64,
        x: f64,
        y: f64,
    }
    #[derive(Deserialize)]
    struct FixtureCommand {
        kind: String,
        #[serde(rename = "targetTick")]
        target_tick: u64,
        data: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Fixture {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        spawns: Vec<FixtureSpawn>,
        commands: Vec<FixtureCommand>,
    }

    fn open_field(size: usize) -> Layers {
        Layers {
            size,
            terrain: vec![TERRAIN_GRASS; size * size],
            elevation: vec![0; size * size],
            passability: vec![1; size * size],
        }
    }

    fn run_digests(sim: &mut EconomySim, ticks: u64, every: u64) -> Vec<(u64, String)> {
        let mut digests = Vec::new();
        while sim.movement.world.tick < ticks {
            let before = sim.movement.world.tick;
            sim.step();
            if sim.movement.world.tick == before {
                continue;
            }
            let t = sim.movement.world.tick;
            if t % every == 0 || t == ticks {
                digests.push((t, sim.digest()));
            }
        }
        digests
    }

    fn spawn_militia(sim: &mut EconomySim, def_id: &str, x: f64, y: f64, owner: f64) -> Eid {
        let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
        let ccomps = CombatComps::from_world(world);
        let pop = PopComps::from_world(world);
        spawn_combat_unit(
            world,
            comps,
            &ccomps,
            &pop,
            &traits(),
            &defs(),
            def_id,
            x,
            y,
            owner,
            &SpawnCombatOptions { body: false, identity: false, morale: false },
        )
    }

    #[test]
    fn m2t5a_duel_matches_ts_snapshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t5a/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = open_field(fixture.size);
        let econ = sim.econ;
        let mut owner = PLAYER_ONE;
        for spawn in &fixture.spawns {
            let eid = spawn_militia(&mut sim, "militia", spawn.x, spawn.y, owner);
            assert_eq!(eid as i64, spawn.eid, "spawn order");
            if eid == 2 {
                owner = 1.0;
            }
        }
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, None).unwrap();
        create_player_stockpile(&mut sim.movement.world, &econ, 1.0, None).unwrap();
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let digests = run_digests(&mut sim, fixture.ticks, fixture.milestone_every);
        assert_eq!(digests, snapshot_digests("m2t5a"));

        let diag = &sim.combat.diagnostics;
        assert_eq!((diag.aggro_acquisitions, diag.retaliations, diag.attack_move_commands), (2, 2, 2));
        assert_eq!((diag.strikes, diag.kills), (38, 2));
        let world = &sim.movement.world;
        let ccomps = CombatComps::from_world(world);
        let hp: Vec<(i64, f64)> = fixture
            .spawns
            .iter()
            .filter_map(|s| combat_row(world, &ccomps, s.eid as Eid).map(|r| (s.eid, r[2])))
            .collect();
        assert_eq!(hp, vec![(1, 4.0), (2, 4.0)]);
        let tally = |player: f64| {
            let events = read_combat_events(world, &ccomps, &econ, player);
            let damage = events.iter().filter(|e| e.kind == COMBAT_EVENT_DAMAGE).count();
            let deaths = events.iter().filter(|e| e.kind == COMBAT_EVENT_UNIT_DEATH).count();
            (damage, deaths)
        };
        assert_eq!(tally(PLAYER_ONE), (18, 0));
        assert_eq!(tally(1.0), (20, 2));
    }

    #[derive(Deserialize)]
    struct Fixture5b {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        spawns: Vec<FixtureSpawn>,
        node: serde_json::Value,
        #[serde(rename = "dropOff")]
        drop_off: serde_json::Value,
        raider: serde_json::Value,
        commands: Vec<FixtureCommand>,
    }

    #[test]
    fn m2t5b_raid_cleanup_matches_ts_snapshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t5b/case.json");
        let fixture: Fixture5b = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = open_field(fixture.size);
        let econ = sim.econ;
        for spawn in &fixture.spawns {
            let eid = spawn_militia(&mut sim, "villager", spawn.x, spawn.y, PLAYER_ONE);
            assert_eq!(eid as i64, spawn.eid, "spawn order");
        }
        let node = spawn_resource_node(
            &mut sim.movement.world,
            &econ,
            fixture.node["tileX"].as_i64().unwrap(),
            fixture.node["tileY"].as_i64().unwrap(),
            1,
            fixture.node["amount"].as_i64().unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(node, 4);
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, None).unwrap();
        create_drop_off(
            &mut sim.movement.world,
            &econ,
            fixture.drop_off["x"].as_f64().unwrap(),
            fixture.drop_off["y"].as_f64().unwrap(),
            PLAYER_ONE,
            None,
        )
        .unwrap();
        create_player_stockpile(&mut sim.movement.world, &econ, 1.0, None).unwrap();
        let raider = spawn_militia(
            &mut sim,
            "militia",
            fixture.raider["x"].as_f64().unwrap(),
            fixture.raider["y"].as_f64().unwrap(),
            1.0,
        );
        assert_eq!(raider, 8);
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let digests = run_digests(&mut sim, fixture.ticks, fixture.milestone_every);
        assert_eq!(digests, snapshot_digests("m2t5b"));

        let diag = &sim.combat.diagnostics;
        assert_eq!((diag.attack_commands, diag.kills, diag.strikes, diag.retaliations), (1, 1, 13, 1));
        let world = &sim.movement.world;
        assert!(!world.entities.contains(&2), "victim despawned");
        for rows in &world.rows_by_component {
            assert!(!rows.contains_key(&2), "victim rows wiped");
        }
        // Player one took 6 retaliation blows (damage events on p1 log).
        let ccomps = CombatComps::from_world(world);
        let p1_damage = read_combat_events(world, &ccomps, &econ, 1.0)
            .iter()
            .filter(|e| e.kind == COMBAT_EVENT_DAMAGE)
            .count();
        assert_eq!(p1_damage, 6);
        // Survivors hold exclusive slots on node 4; ledger closes.
        let mut claims: Vec<(Eid, Eid, f64)> = Vec::new();
        for &eid in &world.entities {
            if let Some((node_eid, slot)) = assigned_node(world, &econ, eid) {
                claims.push((eid, node_eid, slot));
            }
        }
        assert!(claims.iter().all(|c| c.1 == 4));
        assert_eq!(claims.len(), 2);
        let gdiag = &sim.gather.diagnostics;
        let mut carried = 0.0;
        for spawn in &fixture.spawns {
            if let Some((code, amount)) = inventory(world, &econ, spawn.eid as Eid) {
                if code == 1.0 {
                    carried += amount;
                }
            }
        }
        assert_eq!(gdiag.extracted_by_resource[1], gdiag.deposited_by_resource[1] + carried);
        assert!(gdiag.deposited_by_resource[1] > 0.0);
        let remaining = resource_node_row(world, &econ, 4).expect("node row")[1];
        assert_eq!(remaining, 400.0 - gdiag.extracted_by_resource[1]);
    }
}

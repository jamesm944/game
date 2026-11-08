//! Training system (SPEC §2.6/§2.13 / M1-T10, military M2-T6): Rust
//! port of `src/sim/systems/training.ts` + `src/sim/core/rally.ts`.
//! Costs escrow at enqueue; heads count down only while the owner's
//! population < cap; a finished head spawns on the first free
//! perimeter tile (clockwise rings, depth 3) and rally-dispatches.
//!
//! Later-epic guards: non-villager spawns ride TS spawnCombatUnit
//! (combat port pending — panics loudly), naval spawn tiles need the
//! navigability port. Civ restrictions read `world.civilizations` in
//! TS; civ-less worlds allow everything, as here.
use crate::buildings::{
    append_gate_rejection, building_row, is_def_age_unlocked, is_unit_tier_unlocked, pay_costs,
    population, population_cap, read_train_queue, resolve_upgraded_unit_id, write_train_queue,
    AgeComps, BuildingComps, TrainQueueEntry, GATE_HANDLER_TRAIN,
};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::economy::{ensure_carry_capacity, EconomyComps, PLAYER_ONE};
use crate::mapgen::Layers;
use crate::movement::{spawn_unit_with_speed, MovementComps};
use crate::pop::{self, PopComps, TraitsData};
use std::collections::HashMap;
use std::sync::Arc;

pub const TRAIN_VILLAGER_KIND: &str = "trainVillager";
pub const TRAIN_UNIT_KIND: &str = "trainUnit";
pub const SET_RALLY_POINT_KIND: &str = "setRallyPoint";
pub const SET_MULTI_RALLY_POINT_KIND: &str = "setMultiRallyPoint";
pub const CLEAR_RALLY_POINT_KIND: &str = "clearRallyPoint";
pub const SPAWN_RING_DEPTH: i64 = 3;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrainingDiagnostics {
    pub commands_applied: u64,
    pub units_trained: u64,
    pub gate_rejections: u64,
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}

fn default_trainable_unit_id(defs: &Defs, building_def_id: &str) -> String {
    let queue = defs.building(building_def_id).train_queue.as_ref().expect("train queue config");
    if queue.trainable.iter().any(|e| e.unit_id == "villager") {
        "villager".to_string()
    } else {
        queue.trainable[0].unit_id.clone()
    }
}

struct ParsedTrain {
    site_eid: Option<Eid>,
    unit_id: Option<String>,
}

fn parse_train_data(data: &serde_json::Value) -> ParsedTrain {
    let site_eid = match data.get("siteEid") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(
            v.as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 1.0)
                .map(|n| n as Eid)
                .unwrap_or_else(|| panic!("training siteEid must be a positive integer, got {v}")),
        ),
    };
    let unit_id = match data.get("unitId") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(
            v.as_str()
                .filter(|s| !s.is_empty())
                .expect("trainUnit unitId must be a non-empty string")
                .to_string(),
        ),
    };
    ParsedTrain { site_eid, unit_id }
}

struct ProductionBuilding {
    eid: Eid,
    player_id: f64,
    def_id: String,
}

fn production_buildings(world: &CoreWorld, bcomps: &BuildingComps, defs: &Defs) -> Vec<ProductionBuilding> {
    let mut out = Vec::new();
    for &eid in &world.entities {
        let Some(r) = building_row(world, bcomps, eid) else { continue };
        let def_id = defs.building_id_of_code(r[1] as u32).to_string();
        if defs.building(&def_id).train_queue.is_none() {
            continue;
        }
        out.push(ProductionBuilding { eid, player_id: r[0], def_id });
    }
    out
}

fn tile_spawnable(passability: &[u8], size: usize, x: i64, y: i64) -> bool {
    if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
        return false;
    }
    passability[y as usize * size + x as usize] == 1
}

/// First free perimeter tile around a footprint (clockwise rings).
pub fn find_spawn_tile(layers: &Layers, origin_x: i64, origin_y: i64, width: i64, height: i64) -> Option<(i64, i64)> {
    let size = layers.size;
    let passability = &layers.passability;
    for ring in 1..=SPAWN_RING_DEPTH {
        let min_x = origin_x - ring;
        let min_y = origin_y - ring;
        let max_x = origin_x + width - 1 + ring;
        let max_y = origin_y + height - 1 + ring;
        for x in min_x..=max_x {
            if tile_spawnable(passability, size, x, min_y) {
                return Some((x, min_y));
            }
        }
        for y in (min_y + 1)..=max_y {
            if tile_spawnable(passability, size, max_x, y) {
                return Some((max_x, y));
            }
        }
        for x in (min_x..max_x).rev() {
            if tile_spawnable(passability, size, x, max_y) {
                return Some((x, max_y));
            }
        }
        for y in (min_y + 1..max_y).rev() {
            if tile_spawnable(passability, size, min_x, y) {
                return Some((min_x, y));
            }
        }
    }
    None
}

/// UI predicate twin of the enqueue path (TS canEnqueueTraining).
#[allow(clippy::too_many_arguments)]
pub fn can_enqueue_training(
    world: &CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    age: &AgeComps,
    econ: &EconomyComps,
    defs: &Defs,
    building_eid: Eid,
    player_id: f64,
    unit_id: Option<&str>,
) -> bool {
    let Some(r) = building_row(world, bcomps, building_eid) else { return false };
    if r[0] != player_id {
        return false;
    }
    let def_id = defs.building_id_of_code(r[1] as u32).to_string();
    let Some(queue) = &defs.building(&def_id).train_queue else { return false };
    let raw = unit_id.map(|s| s.to_string()).unwrap_or_else(|| default_trainable_unit_id(defs, &def_id));
    let resolved = resolve_upgraded_unit_id(world, age, econ, defs, player_id, &raw);
    if !queue.trainable.iter().any(|e| e.unit_id == resolved) {
        return false;
    }
    if !is_unit_tier_unlocked(world, age, econ, defs, player_id, &resolved) {
        return false;
    }
    let unit_def = defs.unit(&resolved);
    if !is_def_age_unlocked(world, age, player_id, &unit_def.age_gate) {
        return false;
    }
    let queued = read_train_queue(world, bcomps, building_eid).len() as i64;
    if queued >= queue.capacity {
        return false;
    }
    population(world, comps, bcomps, Some(player_id)) + queued < population_cap(world, bcomps, defs, Some(player_id))
}

pub struct TrainingSystem {
    defs: Arc<Defs>,
    traits: Arc<TraitsData>,
    pop: PopComps,
    bcomps: BuildingComps,
    age: AgeComps,
    pub diagnostics: TrainingDiagnostics,
}

impl TrainingSystem {
    pub fn new(defs: Arc<Defs>, traits: Arc<TraitsData>, pop: PopComps, bcomps: BuildingComps, age: AgeComps) -> TrainingSystem {
        TrainingSystem { defs, traits, pop, bcomps, age, diagnostics: TrainingDiagnostics::default() }
    }

    fn apply_train_command(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, kind: &str, data: &serde_json::Value) {
        let parsed = parse_train_data(data);
        let buildings = production_buildings(world, &self.bcomps, &self.defs);
        let target = match parsed.site_eid {
            Some(site) => buildings.iter().find(|b| b.eid == site),
            None => buildings.iter().find(|b| b.player_id == PLAYER_ONE),
        };
        let Some(target) = target else {
            panic!(
                "{}",
                match parsed.site_eid {
                    Some(site) => format!("{kind} targets entity {site}, which is not a finished production building"),
                    None => format!("{kind} requires a finished production building (none exists)"),
                }
            );
        };
        let (target_eid, target_player, target_def_id) = (target.eid, target.player_id, target.def_id.clone());
        let queue = self.defs.building(&target_def_id).train_queue.clone().expect("train queue config");
        let raw_unit_id = parsed.unit_id.unwrap_or_else(|| default_trainable_unit_id(&self.defs, &target_def_id));
        let unit_id = resolve_upgraded_unit_id(world, &self.age, econ, &self.defs, target_player, &raw_unit_id);
        if !queue.trainable.iter().any(|e| e.unit_id == unit_id) {
            panic!("{target_def_id} does not train {unit_id}");
        }
        if !is_unit_tier_unlocked(world, &self.age, econ, &self.defs, target_player, &unit_id) {
            panic!("player {target_player} cannot train {unit_id}: upgrade unresearched");
        }
        // Civ restriction: civ-less worlds allow all (TS sandbox rule).
        let unit_def = self.defs.unit(&unit_id).clone();
        if !is_def_age_unlocked(world, &self.age, target_player, &unit_def.age_gate) {
            append_gate_rejection(
                world,
                &self.age,
                econ,
                target_player,
                world.tick,
                GATE_HANDLER_TRAIN,
                self.defs.unit_code(&unit_id) as f64,
            );
            self.diagnostics.gate_rejections += 1;
            return;
        }
        pay_costs(world, econ, target_player, &unit_def.costs, &format!("training a {unit_id}"))
            .unwrap_or_else(|e| panic!("{e}"));
        let mut entries = read_train_queue(world, &self.bcomps, target_eid);
        if entries.len() as i64 >= queue.capacity {
            panic!("training queue full at {target_def_id}: capacity {}", queue.capacity);
        }
        let pop_now = population(world, comps, &self.bcomps, Some(target_player));
        let cap_now = population_cap(world, &self.bcomps, &self.defs, Some(target_player));
        if pop_now + entries.len() as i64 >= cap_now {
            panic!("training blocked: population {pop_now}/{cap_now} at cap");
        }
        entries.push(TrainQueueEntry {
            unit_code: self.defs.unit_code(&unit_id) as f64,
            remaining_ticks: unit_def.train_time as f64,
        });
        write_train_queue(world, &self.bcomps, target_eid, &entries);
        self.diagnostics.commands_applied += 1;
    }

    fn rally_target_of(data: &serde_json::Value) -> (f64, f64, Option<Eid>) {
        let x = data.get("x").and_then(|v| v.as_f64()).filter(|v| v.is_finite());
        let y = data.get("y").and_then(|v| v.as_f64()).filter(|v| v.is_finite());
        let (Some(x), Some(y)) = (x, y) else {
            panic!("rally coordinates must be finite numbers");
        };
        let target = data
            .get("targetEntityId")
            .and_then(|v| v.as_f64())
            .filter(|v| v.fract() == 0.0 && *v > 0.0)
            .map(|v| v as Eid);
        (x, y, target)
    }

    fn apply_set_rally(&self, world: &mut CoreWorld, data: &serde_json::Value) {
        let b_eid = data
            .get("buildingEid")
            .and_then(|v| v.as_f64())
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .expect("setRallyPoint buildingEid must be a positive integer");
        let target = Self::rally_target_of(data);
        let Some(r) = building_row(world, &self.bcomps, b_eid) else {
            panic!("setRallyPoint targets entity {b_eid}, which is not a finished building");
        };
        let def_id = self.defs.building_id_of_code(r[1] as u32);
        if self.defs.building(def_id).train_queue.is_none() {
            panic!("building {def_id} does not have a production queue");
        }
        world.rally_points.insert(b_eid, target);
    }

    fn apply_set_multi_rally(&self, world: &mut CoreWorld, data: &serde_json::Value) {
        let b_eids = data.get("buildingEids").and_then(|v| v.as_array());
        let b_eids = b_eids.filter(|a| !a.is_empty()).expect("setMultiRallyPoint buildingEids must be a non-empty array");
        let target = Self::rally_target_of(data);
        for raw in b_eids {
            let Some(b_eid) = raw.as_f64().filter(|v| v.fract() == 0.0 && *v >= 1.0).map(|v| v as Eid) else {
                continue;
            };
            let Some(r) = building_row(world, &self.bcomps, b_eid) else { continue };
            let def_id = self.defs.building_id_of_code(r[1] as u32);
            if self.defs.building(def_id).train_queue.is_none() {
                continue;
            }
            world.rally_points.insert(b_eid, target);
        }
    }

    /// TS spawnTrainedUnit: villagers are named Pops (identity, body);
    /// other definitions spawn as combatants (combat port pending).
    fn spawn_trained_unit(&self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, unit_id: &str, x: f64, y: f64, player_id: f64) -> Eid {
        let unit_def = self.defs.unit(unit_id);
        if unit_id == "villager" {
            let eid = spawn_unit_with_speed(world, comps, x, y, unit_def.speed);
            pop::attach_owner(world, &self.pop, eid, player_id);
            pop::attach_pop_identity(world, &self.pop, &self.traits, eid, false);
            pop::attach_pop_skills(world, &self.pop, eid);
            pop::attach_pop_needs(world, &self.pop, eid);
            pop::attach_lessons(world, &self.pop, eid);
            pop::attach_body(world, &self.pop, eid);
            return eid;
        }
        let _ = econ;
        panic!("training: combat unit spawn for {unit_id} lands with the combat port");
    }

    /// TS dispatchSpawnedUnitToRally: smart gather/build/groupMove
    /// command submitted for the next tick boundary.
    fn dispatch_to_rally(&self, world: &mut CoreWorld, econ: &EconomyComps, spawned: Eid, building: Eid, unit_id: &str) {
        let Some(&(rx, ry, target_entity)) = world.rally_points.get(&building) else { return };
        if let Some(target) = target_entity {
            if let Some(node) = row(world, econ.resource_node, target) {
                if node[1] > 0.0 && (unit_id == "villager" || unit_id == "fishing-boat") {
                    world
                        .inbox
                        .submit(Command {
                            kind: "gather".to_string(),
                            target_tick: world.tick + 1,
                            data: Some(serde_json::json!({"entityIds": [spawned], "nodeId": target})),
                        })
                        .expect("rally gather submit");
                    return;
                }
            }
            if row(world, self.bcomps.building_site, target).is_some() && unit_id == "villager" {
                world
                    .inbox
                    .submit(Command {
                        kind: "build".to_string(),
                        target_tick: world.tick + 1,
                        data: Some(serde_json::json!({"entityIds": [spawned], "siteEid": target})),
                    })
                    .expect("rally build submit");
                return;
            }
        }
        world
            .inbox
            .submit(Command {
                kind: "groupMove".to_string(),
                target_tick: world.tick + 1,
                data: Some(serde_json::json!({"entityIds": [spawned], "x": rx, "y": ry})),
            })
            .expect("rally move submit");
    }

    pub fn run(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, layers: &Layers, commands: &[Command]) {
        for command in commands {
            match command.kind.as_str() {
                TRAIN_VILLAGER_KIND | TRAIN_UNIT_KIND => {
                    let data = command.data.as_ref().unwrap_or_else(|| panic!("{} requires command data", command.kind));
                    self.apply_train_command(world, comps, econ, &command.kind.clone(), data);
                }
                SET_RALLY_POINT_KIND => {
                    let data = command.data.as_ref().expect("setRallyPoint requires command data");
                    self.apply_set_rally(world, data);
                }
                SET_MULTI_RALLY_POINT_KIND => {
                    let data = command.data.as_ref().expect("setMultiRallyPoint requires command data");
                    self.apply_set_multi_rally(world, data);
                }
                CLEAR_RALLY_POINT_KIND => {
                    let data = command.data.as_ref().expect("clearRallyPoint requires command data");
                    if let Some(b_eid) = data.get("buildingEid").and_then(|v| v.as_f64()).filter(|v| v.fract() == 0.0 && *v >= 1.0) {
                        world.rally_points.remove(&(b_eid as Eid));
                    }
                }
                _ => {}
            }
        }

        // Advance queues ascending eid; per-owner tallies memoized.
        let mut pop_by_owner: HashMap<i64, i64> = HashMap::new();
        let mut cap_by_owner: HashMap<i64, i64> = HashMap::new();
        let queue_eids: Vec<Eid> = world.rows_by_component[self.bcomps.train_queue].keys().copied().collect();
        for eid in queue_eids {
            let Some(building) = building_row(world, &self.bcomps, eid).cloned() else { continue };
            let mut entries = read_train_queue(world, &self.bcomps, eid);
            if entries.is_empty() {
                continue;
            }
            let owner = building[0];
            let pop_now = *pop_by_owner
                .entry(owner as i64)
                .or_insert_with(|| population(world, comps, &self.bcomps, Some(owner)));
            let cap_now = *cap_by_owner
                .entry(owner as i64)
                .or_insert_with(|| population_cap(world, &self.bcomps, &self.defs, Some(owner)));
            if pop_now < cap_now && entries[0].remaining_ticks > 0.0 {
                entries[0].remaining_ticks -= 1.0;
                write_train_queue(world, &self.bcomps, eid, &entries);
            }
            if entries[0].remaining_ticks <= 0.0 {
                let Some(pos) = row(world, comps.position, eid).cloned() else { continue };
                let def = self.defs.building(self.defs.building_id_of_code(building[1] as u32));
                let origin_x = (pos[0] - def.footprint.width as f64 / 2.0) as i64;
                let origin_y = (pos[1] - def.footprint.height as f64 / 2.0) as i64;
                let unit_id = self.defs.unit_id_of_code(entries[0].unit_code as u32).to_string();
                let unit_def = self.defs.unit(&unit_id).clone();
                let is_naval = unit_def.armor_classes.iter().any(|c| c == "ship");
                if is_naval {
                    panic!("training: naval spawn tile lands with the navigability port ({unit_id})");
                }
                let Some(tile) = find_spawn_tile(layers, origin_x, origin_y, def.footprint.width, def.footprint.height) else {
                    continue; // boxed in: retry next tick
                };
                let spawned = self.spawn_trained_unit(world, comps, econ, &unit_id, tile.0 as f64 + 0.5, tile.1 as f64 + 0.5, owner);
                *pop_by_owner.get_mut(&(owner as i64)).unwrap() += 1;
                self.diagnostics.units_trained += 1;
                if unit_id != "villager" && unit_def.carry_capacity > 0 {
                    ensure_carry_capacity(world, econ, spawned, unit_def.carry_capacity as f64).expect("carry capacity");
                }
                entries.remove(0);
                write_train_queue(world, &self.bcomps, eid, &entries);
                self.dispatch_to_rally(world, econ, spawned, eid, &unit_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{building_site_row, population, population_cap, AgeComps};
    use crate::economy::{create_drop_off, create_player_stockpile, spawn_resource_node, stockpile_amounts, PLAYER_ONE};
    use crate::gather::EconomySim;
    use crate::path::Transport;
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

    #[derive(Deserialize)]
    struct FixtureSpawn {
        eid: i64,
        x: f64,
        y: f64,
    }
    #[derive(Deserialize)]
    struct FixtureNode {
        #[serde(rename = "tileX")]
        tile_x: i64,
        #[serde(rename = "tileY")]
        tile_y: i64,
        resource: String,
        amount: i64,
    }
    #[derive(Deserialize)]
    struct FixturePoint {
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
    struct FixtureStockpile {
        food: f64,
        wood: f64,
        gold: f64,
        stone: f64,
    }
    #[derive(Deserialize)]
    struct Fixture {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        stockpile: FixtureStockpile,
        spawns: Vec<FixtureSpawn>,
        nodes: Vec<FixtureNode>,
        #[serde(rename = "dropOffs")]
        drop_offs: Vec<FixturePoint>,
        commands: Vec<FixtureCommand>,
    }

    fn expected_digests() -> Vec<(u64, String)> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t10/__snapshots__");
        let mut text = String::new();
        for entry in std::fs::read_dir(dir).expect("snapshot dir") {
            let path = entry.expect("entry").path();
            if path.extension().map(|e| e == "snap").unwrap_or(false) {
                text.push_str(&std::fs::read_to_string(path).expect("read snap"));
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
        assert!(!out.is_empty(), "snapshot digests parsed");
        out
    }

    #[test]
    fn m1t10_matches_ts_snapshot_and_closes_ledger() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t10/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        let econ = sim.econ;
        for spawn in &fixture.spawns {
            assert_eq!(sim.spawn_unit(spawn.x, spawn.y) as i64, spawn.eid, "spawn order");
        }
        let world = &mut sim.movement.world;
        create_player_stockpile(
            world,
            &econ,
            PLAYER_ONE,
            Some(&[fixture.stockpile.food, fixture.stockpile.wood, fixture.stockpile.gold, fixture.stockpile.stone, 0.0, 0.0, 0.0]),
        )
        .unwrap();
        for point in &fixture.drop_offs {
            create_drop_off(world, &econ, point.x, point.y, PLAYER_ONE, None).unwrap();
        }
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(&node.resource).expect("slug");
            spawn_resource_node(world, &econ, node.tile_x, node.tile_y, code, node.amount, None).unwrap();
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let mut digests = Vec::new();
        while sim.movement.world.tick < fixture.ticks {
            let before = sim.movement.world.tick;
            sim.step();
            if sim.movement.world.tick == before {
                continue;
            }
            let t = sim.movement.world.tick;
            if t % fixture.milestone_every == 0 || t == fixture.ticks {
                digests.push((t, sim.digest()));
            }
        }
        assert_eq!(digests, expected_digests());

        let world = &sim.movement.world;
        let comps = sim.movement.comps;
        let bcomps = BuildingComps::from_world(world);
        let _ = AgeComps::from_world(world);
        // All live villagers stand on passable tiles (derived plane).
        let (passability, size) = (&sim.movement.layers.passability, sim.movement.layers.size);
        let mut finished = 0;
        let mut pending = 0;
        for &eid in &world.entities {
            if building_row(world, &bcomps, eid).is_some() {
                finished += 1;
            }
            if building_site_row(world, &bcomps, eid).is_some() {
                pending += 1;
            }
            let (Some(pos), true) = (world.rows_by_component[comps.position].get(&eid), world.rows_by_component[comps.unit_tag].contains_key(&eid)) else {
                continue;
            };
            let (tx, ty) = (pos[0].floor() as usize, pos[1].floor() as usize);
            assert_eq!(passability[ty * size + tx], 1, "eid {eid} on passable tile");
        }
        assert_eq!((finished, pending), (4, 0));
        assert_eq!(population(world, &comps, &bcomps, None), 11);
        assert_eq!(population_cap(world, &bcomps, &defs(), None), 15);
        assert_eq!(stockpile_amounts(world, &econ, PLAYER_ONE), vec![400.0, 165.0, 100.0, 0.0, 0.0, 0.0, 0.0]);
        // TC queue: exactly the fourth villager remains, 79 ticks out.
        let tc = world
            .entities
            .iter()
            .copied()
            .find(|&eid| building_row(world, &bcomps, eid).is_some())
            .expect("a finished building");
        let queue = read_train_queue(world, &bcomps, tc);
        assert_eq!(queue, vec![TrainQueueEntry { unit_code: 8.0, remaining_ticks: 79.0 }]);
        assert_eq!(sim.placement.diagnostics.commands_applied, 4);
        assert_eq!(sim.construction.diagnostics.completions, 4);
        assert_eq!(sim.training.diagnostics.units_trained, 3);
    }

    #[test]
    fn m1t10_second_run_identical() {
        // The snapshot test already pins absolute digests; this pins
        // run-to-run determinism of the full stack in-process.
        let first = run_final_digest();
        let second = run_final_digest();
        assert_eq!(first, second);
    }

    fn run_final_digest() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t10/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        let econ = sim.econ;
        for spawn in &fixture.spawns {
            sim.spawn_unit(spawn.x, spawn.y);
        }
        let world = &mut sim.movement.world;
        create_player_stockpile(
            world,
            &econ,
            PLAYER_ONE,
            Some(&[fixture.stockpile.food, fixture.stockpile.wood, fixture.stockpile.gold, fixture.stockpile.stone, 0.0, 0.0, 0.0]),
        )
        .unwrap();
        for point in &fixture.drop_offs {
            create_drop_off(world, &econ, point.x, point.y, PLAYER_ONE, None).unwrap();
        }
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(&node.resource).expect("slug");
            spawn_resource_node(world, &econ, node.tile_x, node.tile_y, code, node.amount, None).unwrap();
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        while sim.movement.world.tick < fixture.ticks {
            sim.step();
        }
        sim.digest()
    }
}

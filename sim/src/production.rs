//! Production components + system (SPEC §2.6 depth-1 chains /
//! M2-T3): Rust port of `src/sim/components/production.ts` and
//! `src/sim/systems/production.ts`. Crafters claim ≤ workSlots slots
//! (derived per tick, ascending-eid priority), walk to the footprint
//! approach band; cycle starts consume the full input list atomically
//! from the owner's two ledgers, count down only while staffed, and
//! credit outputs (plus MealConsumed events for meals) on the
//! completion tick with an immediate restart attempt. Recipe age
//! gates consult the owner's AgeState row (rowless = unlocked).
use crate::activities::{cancel_activities, move_activity, peek};
use crate::buildings::{building_row, clear_assigned_site, AgeComps, BuildingComps};
use crate::construction::{approach_point, rect_distance_sq};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::{Defs, RecipeDef, COMMODITY_SLUGS, RESOURCE_SLUGS};
use crate::economy::{
    can_debit_ledger_slugs, clear_assigned_node, debit_ledger_slugs, deposit, deposit_commodity,
    resource_code_of_slug, commodity_code_of_slug, EconomyComps, LedgerEntry,
};
use crate::buildings::is_def_age_unlocked;
use crate::buildings::FootprintRect;
use crate::mapgen::Layers;
use crate::movement::{read_queue, reset_steering_bookkeeping, write_queue, MovementComps};
use crate::pop::{self, PopComps};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const PRODUCE_KIND: &str = "produce";
pub const PRODUCTION_WORK_RANGE_TILES: f64 = 2.5;
const APPROACH_MARGIN_TILES: f64 = 0.75;

#[derive(Clone, Copy)]
pub struct ProductionComps {
    pub meal_consumed: usize,
    pub production_cycle: usize,
    pub production_job: usize,
}

impl ProductionComps {
    pub fn from_world(world: &CoreWorld) -> ProductionComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        ProductionComps {
            meal_consumed: id("MealConsumed"),
            production_cycle: id("ProductionCycle"),
            production_job: id("ProductionJob"),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProductionDiagnostics {
    pub commands_applied: u64,
    pub cycles_started: u64,
    pub cycles_completed: u64,
    pub produced_by_resource: [f64; 7],
    pub produced_by_commodity: [f64; 6],
    pub consumed_by_resource: [f64; 7],
    pub consumed_by_commodity: [f64; 6],
    pub stalled_missing_worker_ticks: u64,
    pub stalled_missing_input_ticks: u64,
    pub gate_blocked_ticks: u64,
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}
fn rows_mut(world: &mut CoreWorld, component: usize) -> &mut BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get_mut(component).expect("registered component")
}
fn set_row(world: &mut CoreWorld, component: usize, eid: Eid, values: &[f64]) {
    world.set_values(component, eid, values).expect("registered component");
}

pub fn production_cycle_row<'a>(world: &'a CoreWorld, pcomps: &ProductionComps, eid: Eid) -> Option<&'a Vec<f64>> {
    row(world, pcomps.production_cycle, eid)
}

pub fn set_production_cycle(world: &mut CoreWorld, pcomps: &ProductionComps, eid: Eid, player_id: f64, recipe_code: f64, remaining: f64) {
    set_row(world, pcomps.production_cycle, eid, &[player_id, recipe_code, remaining]);
}

pub fn assign_production_job(world: &mut CoreWorld, pcomps: &ProductionComps, worker: Eid, building: Eid) {
    assert!(building >= 1, "production building entity id must be a positive integer, got {building}");
    set_row(world, pcomps.production_job, worker, &[building as f64, -1.0]);
}

pub fn production_job(world: &CoreWorld, pcomps: &ProductionComps, worker: Eid) -> Option<(Eid, f64)> {
    row(world, pcomps.production_job, worker).map(|r| (r[0] as Eid, r[1]))
}

pub fn clear_production_job(world: &mut CoreWorld, pcomps: &ProductionComps, worker: Eid) -> bool {
    rows_mut(world, pcomps.production_job).remove(&worker).is_some()
}

pub fn append_meal_consumed(world: &mut CoreWorld, pcomps: &ProductionComps, eid: Eid, tick: u64, qty: f64) {
    let r = rows_mut(world, pcomps.meal_consumed).entry(eid).or_insert_with(|| vec![0.0]);
    r.push(tick as f64);
    r.push(qty);
    r[0] += 1.0;
}

fn ledger_entries(recipe: &RecipeDef) -> Vec<LedgerEntry> {
    recipe.inputs.iter().map(|io| LedgerEntry { def_id: io.def_id.clone(), qty: io.qty as f64 }).collect()
}

struct ParsedProduce {
    entity_ids: Vec<Eid>,
    building_eid: Eid,
    recipe_id: Option<String>,
}

fn parse_produce_data(data: &serde_json::Value) -> ParsedProduce {
    let raw_ids = data.get("entityIds").and_then(|v| v.as_array());
    let raw_ids = raw_ids.filter(|a| !a.is_empty()).expect("produce requires a non-empty entityIds array");
    let mut entity_ids: Vec<Eid> = Vec::new();
    for id in raw_ids {
        let id = id
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .unwrap_or_else(|| panic!("produce entityIds entries must be positive integers, got {id}"));
        if !entity_ids.contains(&id) {
            entity_ids.push(id);
        }
    }
    entity_ids.sort();
    let building_eid = data
        .get("buildingEid")
        .and_then(|v| v.as_f64())
        .filter(|v| v.fract() == 0.0 && *v >= 1.0)
        .map(|v| v as Eid)
        .unwrap_or_else(|| panic!("produce buildingEid must be a positive integer"));
    let recipe_id = match data.get("recipeId") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(v.as_str().filter(|s| !s.is_empty()).expect("produce recipeId must be a non-empty string").to_string()),
    };
    ParsedProduce { entity_ids, building_eid, recipe_id }
}

struct Crafter {
    eid: Eid,
    x: f64,
    y: f64,
    has_vel: bool,
}

pub struct ProductionSystem {
    defs: Arc<Defs>,
    pop: PopComps,
    bcomps: BuildingComps,
    age: AgeComps,
    pcomps: ProductionComps,
    pub diagnostics: ProductionDiagnostics,
}

impl ProductionSystem {
    pub fn new(defs: Arc<Defs>, pop: PopComps, bcomps: BuildingComps, age: AgeComps, pcomps: ProductionComps) -> ProductionSystem {
        ProductionSystem { defs, pop, bcomps, age, pcomps, diagnostics: ProductionDiagnostics::default() }
    }

    fn reset_steering(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid) {
        if let Some(vel) = world.rows_by_component.get_mut(comps.velocity).and_then(|r| r.get_mut(&eid)) {
            reset_steering_bookkeeping(vel);
        }
    }

    fn set_move_target(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid, x: f64, y: f64) {
        assert!(row(world, comps.move_target, eid).is_some(), "entity {eid} has no MoveTarget row");
        world.set_values(comps.move_target, eid, &[x, y]).expect("registered component");
    }

    fn apply_produce(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let parsed = parse_produce_data(data);
        let building = building_row(world, &self.bcomps, parsed.building_eid).cloned().unwrap_or_else(|| {
            panic!("produce targets entity {}, which has no finished Building row", parsed.building_eid)
        });
        let def_id = self.defs.building_id_of_code(building[1] as u32).to_string();
        let options = self.defs.recipes_for_building(&def_id);
        if options.is_empty() {
            panic!("building {def_id} has no recipes to produce");
        }
        let selected = match &parsed.recipe_id {
            Some(want) => options.iter().find(|r| &r.id == want).unwrap_or_else(|| {
                panic!(
                    "building {def_id} has no recipe {want:?} (known: {})",
                    options.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", ")
                )
            }),
            None => options[0],
        };
        let code = self.defs.recipe_code(&selected.id) as f64;
        let existing = production_cycle_row(world, &self.pcomps, parsed.building_eid).cloned();
        if let Some(existing) = &existing {
            if existing[2] > 0.0 && existing[1] != code {
                panic!("produce cannot switch {def_id} to {} mid-cycle ({} ticks remaining)", selected.id, existing[2]);
            }
        }
        if existing.as_ref().map(|e| e[1]) != Some(code) {
            set_production_cycle(
                world,
                &self.pcomps,
                parsed.building_eid,
                building[0],
                code,
                existing.as_ref().map(|e| e[2]).unwrap_or(0.0),
            );
        }
        for eid in parsed.entity_ids {
            let live = row(world, comps.position, eid).is_some()
                && row(world, comps.velocity, eid).is_some()
                && row(world, comps.unit_tag, eid).is_some();
            if !live {
                continue;
            }
            if pop::is_child(world, &self.pop, eid) {
                continue;
            }
            clear_assigned_node(world, econ, eid);
            clear_assigned_site(world, &self.bcomps, eid);
            let mut queue = read_queue(world, comps, eid);
            cancel_activities(&mut queue);
            write_queue(world, comps, eid, &queue);
            assign_production_job(world, &self.pcomps, eid, parsed.building_eid);
            self.reset_steering(world, comps, eid);
        }
        self.diagnostics.commands_applied += 1;
    }

    fn start_cycle(&mut self, world: &mut CoreWorld, econ: &EconomyComps, eid: Eid, owner: f64, recipe: &RecipeDef) {
        debit_ledger_slugs(world, econ, owner, &ledger_entries(recipe), &format!("{} production", recipe.id))
            .unwrap_or_else(|e| panic!("{e}"));
        for input in &recipe.inputs {
            if let Some(code) = resource_code_of_slug(&input.def_id) {
                self.diagnostics.consumed_by_resource[code as usize] += input.qty as f64;
            } else {
                let code = commodity_code_of_slug(&input.def_id).expect("commodity slug");
                self.diagnostics.consumed_by_commodity[code as usize] += input.qty as f64;
            }
        }
        let r = rows_mut(world, self.pcomps.production_cycle).get_mut(&eid).expect("cycle row");
        r[2] = recipe.ticks as f64;
        self.diagnostics.cycles_started += 1;
    }

    fn complete_cycle(&mut self, world: &mut CoreWorld, econ: &EconomyComps, eid: Eid, owner: f64, recipe: &RecipeDef) {
        let (def_id, qty) = (&recipe.output.def_id, recipe.output.qty as f64);
        if let Some(code) = resource_code_of_slug(def_id) {
            deposit(world, econ, owner, code, qty).expect("deposit output");
            self.diagnostics.produced_by_resource[code as usize] += qty;
        } else {
            let code = commodity_code_of_slug(def_id).expect("commodity slug");
            deposit_commodity(world, econ, owner, code, qty).expect("deposit commodity");
            self.diagnostics.produced_by_commodity[code as usize] += qty;
            if def_id == "meals" {
                append_meal_consumed(world, &self.pcomps, eid, world.tick, qty);
            }
        }
        self.diagnostics.cycles_completed += 1;
    }

    pub fn run(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, layers: &Layers, commands: &[Command]) {
        // 1) Commands.
        for command in commands {
            if command.kind != PRODUCE_KIND {
                continue;
            }
            let data = command.data.as_ref().expect("produce requires command data");
            self.apply_produce(world, comps, econ, data);
        }

        // 2) Staffing claims per building, ascending eid.
        let mut crafters_by_building: BTreeMap<Eid, Vec<Crafter>> = BTreeMap::new();
        for &eid in &world.entities {
            let Some(job) = row(world, self.pcomps.production_job, eid) else { continue };
            let building_eid = job[0] as Eid;
            let (Some(pos), true) = (row(world, comps.position, eid), row(world, comps.unit_tag, eid).is_some()) else {
                continue;
            };
            crafters_by_building.entry(building_eid).or_default().push(Crafter {
                eid,
                x: pos[0],
                y: pos[1],
                has_vel: row(world, comps.velocity, eid).is_some(),
            });
        }

        let range_sq = PRODUCTION_WORK_RANGE_TILES * PRODUCTION_WORK_RANGE_TILES;
        let mut staffed_by_building: BTreeMap<Eid, bool> = BTreeMap::new();
        let building_eids: Vec<Eid> = crafters_by_building.keys().copied().collect();
        for building_eid in building_eids {
            let group = &crafters_by_building[&building_eid];
            let building = building_row(world, &self.bcomps, building_eid).cloned();
            let building_pos = row(world, comps.position, building_eid).cloned();
            let (Some(building), Some(building_pos)) = (building, building_pos) else {
                for crafter in group {
                    clear_production_job(world, &self.pcomps, crafter.eid);
                }
                continue;
            };
            let def = self.defs.building(self.defs.building_id_of_code(building[1] as u32));
            let rect = FootprintRect {
                x: building_pos[0] - def.footprint.width as f64 / 2.0,
                y: building_pos[1] - def.footprint.height as f64 / 2.0,
                width: def.footprint.width as f64,
                height: def.footprint.height as f64,
            };
            let mut staffed = false;
            for (i, crafter) in group.iter().enumerate() {
                let slot_index: f64 = if (i as i64) < def.work_slots.max(0) { i as f64 } else { -1.0 };
                {
                    let job = rows_mut(world, self.pcomps.production_job).get_mut(&crafter.eid).expect("job row");
                    if job[1] != slot_index {
                        job[1] = slot_index;
                    }
                }
                let in_range = rect_distance_sq(crafter.x, crafter.y, &rect) <= range_sq;
                if slot_index >= 0.0 && in_range {
                    staffed = true;
                }
                let mut queue = read_queue(world, comps, crafter.eid);
                if peek(&queue).is_some() {
                    continue;
                }
                if in_range {
                    continue;
                }
                let door = approach_point(layers, &rect, APPROACH_MARGIN_TILES, crafter.x, crafter.y);
                queue.push(move_activity(&[door.0, door.1]).expect("move activity"));
                write_queue(world, comps, crafter.eid, &queue);
                self.set_move_target(world, comps, crafter.eid, door.0, door.1);
                if crafter.has_vel {
                    self.reset_steering(world, comps, crafter.eid);
                }
            }
            staffed_by_building.insert(building_eid, staffed);
        }

        // 3) Cycle advancement ascending eid.
        let cycle_eids: Vec<Eid> = world.rows_by_component[self.pcomps.production_cycle].keys().copied().collect();
        for eid in cycle_eids {
            let Some(cycle) = production_cycle_row(world, &self.pcomps, eid).cloned() else { continue };
            let (owner, recipe_code, remaining) = (cycle[0], cycle[1], cycle[2]);
            let recipe = self.defs.recipe(self.defs.recipe_id_of_code(recipe_code as u32)).clone();
            let staffed = staffed_by_building.get(&eid).copied().unwrap_or(false);
            let unlocked = is_def_age_unlocked(world, &self.age, owner, &recipe.age_gate);
            let entries = ledger_entries(&recipe);

            if remaining == 0.0 {
                if !unlocked {
                    self.diagnostics.gate_blocked_ticks += 1;
                    continue;
                }
                if !staffed {
                    self.diagnostics.stalled_missing_worker_ticks += 1;
                    continue;
                }
                if !can_debit_ledger_slugs(world, econ, owner, &entries) {
                    self.diagnostics.stalled_missing_input_ticks += 1;
                    continue;
                }
                self.start_cycle(world, econ, eid, owner, &recipe);
                continue;
            }

            if !staffed {
                self.diagnostics.stalled_missing_worker_ticks += 1;
                continue;
            }
            let new_remaining = {
                let r = rows_mut(world, self.pcomps.production_cycle).get_mut(&eid).expect("cycle row");
                r[2] -= 1.0;
                r[2]
            };
            if new_remaining == 0.0 {
                self.complete_cycle(world, econ, eid, owner, &recipe);
            }
            if new_remaining == 0.0 && unlocked {
                if can_debit_ledger_slugs(world, econ, owner, &entries) {
                    self.start_cycle(world, econ, eid, owner, &recipe);
                } else {
                    self.diagnostics.stalled_missing_input_ticks += 1;
                }
            }
        }
        let _ = (RESOURCE_SLUGS, COMMODITY_SLUGS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::economy::{
        commodity_amounts, create_commodity_stockpile, create_player_stockpile, stockpile_amounts,
        PLAYER_ONE,
    };
    use crate::gather::EconomySim;
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

    #[derive(Deserialize)]
    struct FixtureSpawn {
        eid: i64,
        x: f64,
        y: f64,
    }
    #[derive(Deserialize)]
    struct FixtureBuilding {
        eid: i64,
        #[serde(rename = "defId")]
        def_id: String,
        #[serde(rename = "tileX")]
        tile_x: i64,
        #[serde(rename = "tileY")]
        tile_y: i64,
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
        stockpile: std::collections::BTreeMap<String, f64>,
        spawns: Vec<FixtureSpawn>,
        buildings: Vec<FixtureBuilding>,
        commands: Vec<FixtureCommand>,
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

    #[test]
    fn m2t3_production_chains_match_ts_snapshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t3/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        let econ = sim.econ;
        for spawn in &fixture.spawns {
            assert_eq!(sim.spawn_unit(spawn.x, spawn.y) as i64, spawn.eid, "spawn order");
        }
        let amounts: Vec<f64> = ["food", "wood", "gold", "stone", "iron", "coal", "clay"]
            .iter()
            .map(|slug| fixture.stockpile[*slug])
            .collect();
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, Some(&amounts)).unwrap();
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE).unwrap();
        {
            let bcomps = BuildingComps::from_world(&sim.movement.world);
            let age = AgeComps::from_world(&sim.movement.world);
            let defs = defs();
            for building in &fixture.buildings {
                let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
                let eid = crate::placement::stamp_finished_building(
                    world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                    &building.def_id, building.tile_x, building.tile_y, PLAYER_ONE,
                );
                assert_eq!(eid as i64, building.eid, "building order");
            }
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
        assert_eq!(digests, snapshot_digests("m2t3"));

        let diag = &sim.production.diagnostics;
        assert_eq!(diag.stalled_missing_input_ticks, 0);
        assert_eq!(diag.stalled_missing_worker_ticks, 0);
        assert_eq!(diag.gate_blocked_ticks, 0);
        assert_eq!(diag.produced_by_commodity, [5.0, 3.0, 3.0, 2.0, 0.0, 5.0]);
        assert_eq!(diag.cycles_started, 23);
        assert_eq!(diag.cycles_completed, 18);
        assert_eq!(diag.consumed_by_resource, [18.0, 19.0, 0.0, 0.0, 10.0, 4.0, 8.0]);
        let world = &sim.movement.world;
        let ledger = stockpile_amounts(world, &econ, PLAYER_ONE);
        for code in 0..7 {
            assert_eq!(ledger[code], amounts[code] - diag.consumed_by_resource[code], "resource ledger {code}");
        }
        assert_eq!(commodity_amounts(world, &econ, PLAYER_ONE), diag.produced_by_commodity.to_vec());
        let pcomps = ProductionComps::from_world(world);
        let slots: Vec<(i64, i64)> = fixture
            .spawns
            .iter()
            .map(|s| (s.eid, production_job(world, &pcomps, s.eid as Eid).map(|j| j.1 as i64).unwrap_or(-999)))
            .collect();
        assert_eq!(slots, vec![(1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, -1)]);
    }
}

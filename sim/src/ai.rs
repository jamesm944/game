//! Scripted AI (SPEC §2.8 / M2-T9, M4-T6): Rust port of `src/sim/ai/`
//! (knowledge seam, difficulty presets, build-order layer, economy
//! manager, military manager, trade/naval managers, planner). The
//! planner is an ordinary system registered LAST; it never mutates
//! rows — emissions enter the shared inbox as plain commands, and the
//! enemy half of every decision reads only the AI's own fog planes
//! (fog honesty by construction). Diplomacy is owner-inequality (no
//! matrix configured yet, matching every fixture).
use crate::age::{can_start_age_advance, next_age_tech_id};
use crate::buildings::{
    active_trainable_units_for, age_rank_of, age_research_row, assigned_site, building_row,
    building_tech_options, can_afford_costs, current_age_rank, population, population_cap,
    read_train_queue, researched_tech_codes, resolve_upgraded_unit_id, AgeComps, BuildingComps,
    PanelTechOption, AGE_DARK_RANK,
};
use crate::combat_stats::bonus_multiplier_of;
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::{Costs, Defs};
use crate::economy::{
    assigned_node, inventory, stockpile_amounts, EconomyComps, WORK_SLOTS_PER_NODE,
};
use crate::fog::FogHandle;
use crate::gather::FARM_RESEED_WOOD_COST;
use crate::mapgen::Layers;
use crate::movement::MovementComps;
use crate::path::PathScheduler;
use crate::pop::{self, PopComps, TraitsData};
use crate::placement::validate_placement;
use crate::training::can_enqueue_training;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const AI_PLAYER: f64 = 1.0;
pub const PLANNER_CADENCE_TICKS: u64 = 30;

#[derive(Clone, Debug, PartialEq)]
pub struct CommandDraft {
    pub kind: String,
    pub data: serde_json::Value,
}

fn draft(kind: &str, data: serde_json::Value) -> CommandDraft {
    CommandDraft { kind: kind.to_string(), data }
}

// ---- AI start bootstrap (ai/bootstrap.ts) ----

pub struct AiStartHandle {
    pub player: f64,
    pub tc_eid: Eid,
    pub ledger_eid: Eid,
    pub villager_eids: Vec<Eid>,
}

/// Seat an AI opponent: ledgers + age state + town center + named
/// Pop villagers with explicit Owner rows, wound + morale models.
#[allow(clippy::too_many_arguments)]
pub fn setup_ai_opponent(
    world: &mut CoreWorld,
    comps: &MovementComps,
    econ: &EconomyComps,
    bcomps: &BuildingComps,
    age: &AgeComps,
    pop: &PopComps,
    morale_component: usize,
    traits: &TraitsData,
    defs: &Defs,
    layers: &mut Layers,
    paths: &mut PathScheduler<crate::movement::Continuation>,
    player: f64,
    tc_origin: (i64, i64),
    villager_spawns: &[(f64, f64)],
    starting_resources: Option<&[f64]>,
) -> AiStartHandle {
    assert!(player >= 1.0 && player.fract() == 0.0, "AI opponent needs a non-human player slot ≥ 1");
    // TS DEFAULT_STARTING_RESOURCES (ai/bootstrap.ts).
    const DEFAULT_STARTING_RESOURCES: [f64; 7] = [200.0, 600.0, 100.0, 0.0, 0.0, 0.0, 0.0];
    let ledger_eid = crate::economy::create_player_stockpile(
        world, econ, player, Some(starting_resources.unwrap_or(&DEFAULT_STARTING_RESOURCES)),
    ).expect("stockpile");
    crate::economy::create_commodity_stockpile(world, econ, player).expect("commodity stockpile");
    crate::buildings::create_player_age_state(world, age, econ, player);
    let tc_eid = crate::placement::stamp_finished_building(
        world, comps, bcomps, econ, age, defs, layers, paths, "town-center", tc_origin.0, tc_origin.1, player,
    );
    let mut villager_eids = Vec::new();
    for (x, y) in villager_spawns {
        let eid = crate::movement::spawn_unit_with_speed(world, comps, *x, *y, 1.0);
        pop::attach_owner(world, pop, eid, player);
        pop::attach_pop_identity(world, pop, traits, eid, false);
        pop::attach_pop_skills(world, pop, eid);
        pop::attach_pop_needs(world, pop, eid);
        pop::attach_lessons(world, pop, eid);
        pop::attach_body(world, pop, eid);
        pop::attach_morale(world, morale_component, eid);
        villager_eids.push(eid);
    }
    AiStartHandle { player, tc_eid, ledger_eid, villager_eids }
}

// ---- difficulty (ai/difficulty.ts) ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AiDifficulty {
    Easy,
    Normal,
    Hard,
    Extreme,
}

impl AiDifficulty {
    pub fn decision_interval_ticks(&self) -> u64 {
        match self {
            AiDifficulty::Easy => 90,
            AiDifficulty::Normal => 30,
            AiDifficulty::Hard => 15,
            AiDifficulty::Extreme => 10,
        }
    }
    pub fn reaction_delay_ticks(&self) -> u64 {
        match self {
            AiDifficulty::Easy => 60,
            AiDifficulty::Normal => 20,
            AiDifficulty::Hard | AiDifficulty::Extreme => 0,
        }
    }
    pub fn income_multiplier(&self) -> f64 {
        match self {
            AiDifficulty::Easy | AiDifficulty::Normal => 1.0,
            AiDifficulty::Hard => 1.25,
            AiDifficulty::Extreme => 1.4,
        }
    }
}

// ---- knowledge seam (ai/knowledge.ts) ----

#[derive(Clone, Debug, PartialEq)]
pub struct KnownNode {
    pub eid: Eid,
    pub resource_code: i64,
    pub tile_x: i64,
    pub tile_y: i64,
    pub remaining: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KnownUnit {
    pub eid: Eid,
    pub def_id: String,
    pub tile_x: i64,
    pub tile_y: i64,
    pub owner: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerAssignment {
    Node(Eid),
    Site(Eid),
}

#[derive(Default)]
struct Memo {
    tick: i64,
    known: Option<Vec<KnownUnit>>,
    villagers: Option<Vec<Eid>>,
    nodes: HashMap<i64, Vec<KnownNode>>,
}

pub struct AiKnowledge<'a> {
    pub player: f64,
    world: &'a CoreWorld,
    defs: &'a Defs,
    fog: &'a FogHandle,
    layers: &'a Layers,
    comps: MovementComps,
    econ: EconomyComps,
    bcomps: BuildingComps,
    age: AgeComps,
    relic: usize,
    auto_reseed: bool,
    memo: RefCell<Memo>,
}

impl<'a> AiKnowledge<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &'a CoreWorld,
        defs: &'a Defs,
        fog: &'a FogHandle,
        layers: &'a Layers,
        player: f64,
        comps: MovementComps,
        econ: EconomyComps,
        bcomps: BuildingComps,
        age: AgeComps,
        relic: usize,
        auto_reseed: bool,
    ) -> AiKnowledge<'a> {
        AiKnowledge {
            player,
            world,
            defs,
            fog,
            layers,
            comps,
            econ,
            bcomps,
            age,
            relic,
            auto_reseed,
            memo: RefCell::new(Memo { tick: -1, known: None, villagers: None, nodes: HashMap::new() }),
        }
    }

    fn refresh_memo(&self) {
        let mut memo = self.memo.borrow_mut();
        if memo.tick != self.world.tick as i64 {
            memo.tick = self.world.tick as i64;
            memo.known = None;
            memo.villagers = None;
            memo.nodes.clear();
        }
    }

    pub fn tick(&self) -> u64 {
        self.world.tick
    }
    pub fn is_explored(&self, x: i64, y: i64) -> bool {
        self.fog.is_explored(x, y, self.player as usize)
    }
    pub fn is_visible(&self, x: i64, y: i64) -> bool {
        self.fog.is_visible(x, y, self.player as usize)
    }
    pub fn is_hostile(&self, target: f64) -> bool {
        target != self.player
    }
    pub fn is_allied(&self, target: f64) -> bool {
        target == self.player
    }
    pub fn allied_player_ids(&self) -> Vec<f64> {
        Vec::new()
    }
    pub fn auto_reseed_enabled(&self) -> bool {
        self.auto_reseed
    }
    pub fn resources(&self) -> Vec<f64> {
        stockpile_amounts(self.world, &self.econ, self.player)
    }
    pub fn age_rank(&self) -> f64 {
        age_rank_of(self.world, &self.age, self.player).unwrap_or(AGE_DARK_RANK)
    }
    pub fn next_age_tech_id(&self) -> Option<&'static str> {
        next_age_tech_id(current_age_rank(self.world, &self.age, self.player) as i64)
    }
    pub fn can_start_age_advance(&self) -> bool {
        can_start_age_advance(self.world, &self.bcomps, &self.age, self.defs, self.player)
    }

    fn own_buildings(&self) -> Vec<(Eid, String)> {
        self.world.rows_by_component[self.bcomps.building]
            .iter()
            .filter(|(_, r)| r[0] == self.player)
            .map(|(eid, r)| (*eid, self.defs.building_id_of_code(r[1] as u32).to_string()))
            .collect()
    }

    pub fn finished_buildings(&self, def_id: Option<&str>) -> Vec<Eid> {
        let mut out: Vec<Eid> = self
            .own_buildings()
            .into_iter()
            .filter(|(_, d)| def_id.map(|want| d == want).unwrap_or(true))
            .map(|(eid, _)| eid)
            .collect();
        out.sort();
        out
    }

    pub fn own_building_origin(&self, eid: Eid) -> Option<(i64, i64)> {
        let r = building_row(self.world, &self.bcomps, eid)?;
        if r[0] != self.player {
            return None;
        }
        let def = self.defs.building(self.defs.building_id_of_code(r[1] as u32));
        let pos = self.world.rows_by_component[self.comps.position].get(&eid)?;
        Some((
            (pos[0] - def.footprint.width as f64 / 2.0).floor() as i64,
            (pos[1] - def.footprint.height as f64 / 2.0).floor() as i64,
        ))
    }

    pub fn unfinished_sites(&self) -> Vec<(Eid, String, i64, i64)> {
        let mut out: Vec<(Eid, String, i64, i64)> = Vec::new();
        for (eid, r) in self.world.rows_by_component[self.bcomps.building_site].iter() {
            if r[0] != self.player {
                continue;
            }
            let pos = self.world.rows_by_component[self.comps.position].get(eid);
            out.push((
                *eid,
                self.defs.building_id_of_code(r[1] as u32).to_string(),
                pos.map(|p| p[0].floor() as i64).unwrap_or(0),
                pos.map(|p| p[1].floor() as i64).unwrap_or(0),
            ));
        }
        out.sort_by_key(|s| s.0);
        out
    }

    pub fn builders_on(&self, site_eid: Eid) -> Vec<Eid> {
        self.villager_eids()
            .into_iter()
            .filter(|&eid| assigned_site(self.world, &self.bcomps, eid) == Some(site_eid))
            .collect()
    }

    pub fn train_queue_of(&self, building_eid: Eid) -> Vec<String> {
        read_train_queue(self.world, &self.bcomps, building_eid)
            .iter()
            .map(|e| self.defs.unit_id_of_code(e.unit_code as u32).to_string())
            .collect()
    }

    pub fn trainable_unit_ids(&self, building_eid: Eid) -> Vec<String> {
        let Some(r) = building_row(self.world, &self.bcomps, building_eid) else { return Vec::new() };
        if r[0] != self.player {
            return Vec::new();
        }
        let def_id = self.defs.building_id_of_code(r[1] as u32);
        if self.defs.building(def_id).train_queue.is_none() {
            return Vec::new();
        }
        active_trainable_units_for(self.world, &self.age, &self.econ, self.defs, self.player, def_id)
    }

    pub fn is_tech_researched(&self, tech_id: &str) -> bool {
        researched_tech_codes(self.world, &self.age, &self.econ, self.player)
            .contains(&(self.defs.tech_code(tech_id) as i64))
    }

    pub fn researched_tech_ids(&self) -> Vec<String> {
        researched_tech_codes(self.world, &self.age, &self.econ, self.player)
            .iter()
            .map(|c| self.defs.tech_id_of_code(*c as u32).to_string())
            .collect()
    }

    pub fn is_building_researching(&self, building_eid: Eid) -> bool {
        age_research_row(self.world, &self.age, building_eid).is_some()
    }

    pub fn available_techs_for_building(&self, building_eid: Eid) -> Vec<PanelTechOption> {
        let Some(r) = building_row(self.world, &self.bcomps, building_eid) else { return Vec::new() };
        if r[0] != self.player {
            return Vec::new();
        }
        let def_id = self.defs.building_id_of_code(r[1] as u32).to_string();
        building_tech_options(self.world, &self.age, &self.econ, self.defs, self.player, building_eid, &def_id)
    }

    pub fn can_research_tech(&self, building_eid: Eid, tech_id: &str, ignore_costs: bool) -> bool {
        let Some(opt) = self.available_techs_for_building(building_eid).into_iter().find(|o| o.tech_id == tech_id)
        else {
            return false;
        };
        if ignore_costs {
            opt.can_research || opt.reason_disabled.as_deref() == Some("Insufficient resources")
        } else {
            opt.can_research
        }
    }

    pub fn researchable_tech_ids(&self, building_eid: Eid) -> Vec<String> {
        self.available_techs_for_building(building_eid)
            .into_iter()
            .filter(|o| o.can_research || o.reason_disabled.as_deref() == Some("Insufficient resources"))
            .map(|o| o.tech_id)
            .collect()
    }

    pub fn resolve_upgraded(&self, unit_id: &str) -> String {
        resolve_upgraded_unit_id(self.world, &self.age, &self.econ, self.defs, self.player, unit_id)
    }

    pub fn population(&self) -> i64 {
        population(self.world, &self.comps, &self.bcomps, Some(self.player))
    }
    pub fn population_cap(&self) -> i64 {
        population_cap(self.world, &self.bcomps, self.defs, Some(self.player))
    }

    fn known_entities(&self) -> Vec<KnownUnit> {
        self.refresh_memo();
        if let Some(k) = &self.memo.borrow().known {
            return k.clone();
        }
        let known: Vec<KnownUnit> = self
            .fog
            .known_entities(self.player as usize)
            .into_iter()
            .map(|e| KnownUnit { eid: e.eid, def_id: e.def_id, tile_x: e.tile_x, tile_y: e.tile_y, owner: e.owner })
            .collect();
        self.memo.borrow_mut().known = Some(known.clone());
        known
    }

    pub fn villager_eids(&self) -> Vec<Eid> {
        self.refresh_memo();
        if let Some(v) = &self.memo.borrow().villagers {
            return v.clone();
        }
        let mut out: Vec<Eid> = self
            .known_entities()
            .into_iter()
            .filter(|e| e.owner == self.player && e.def_id == "villager")
            .map(|e| e.eid)
            .collect();
        out.sort();
        self.memo.borrow_mut().villagers = Some(out.clone());
        out
    }

    pub fn army_units(&self) -> Vec<KnownUnit> {
        let mut out: Vec<KnownUnit> = self
            .known_entities()
            .into_iter()
            .filter(|e| e.owner == self.player && self.defs.units.contains_key(&e.def_id) && e.def_id != "villager")
            .collect();
        out.sort_by_key(|e| e.eid);
        out
    }

    pub fn assignment_of(&self, eid: Eid) -> Option<WorkerAssignment> {
        if let Some((node, _)) = assigned_node(self.world, &self.econ, eid) {
            return Some(WorkerAssignment::Node(node));
        }
        assigned_site(self.world, &self.bcomps, eid).map(WorkerAssignment::Site)
    }

    pub fn carry_of(&self, eid: Eid) -> Option<(f64, f64)> {
        inventory(self.world, &self.econ, eid)
    }

    pub fn own_unit_tile(&self, eid: Eid) -> Option<(i64, i64)> {
        self.world.rows_by_component[self.comps.position]
            .get(&eid)
            .map(|p| (p[0].floor() as i64, p[1].floor() as i64))
    }

    fn damaged_buildings(&self, allied_only: bool) -> Vec<(Eid, String, i64, i64, f64)> {
        let mut out = Vec::new();
        for (eid, r) in self.world.rows_by_component[self.bcomps.building].iter() {
            let owner = r[0];
            if allied_only {
                if owner == self.player {
                    continue;
                }
            } else if owner != self.player {
                continue;
            }
            let def_id = self.defs.building_id_of_code(r[1] as u32).to_string();
            if r[4] >= self.defs.building(&def_id).hp as f64 {
                continue;
            }
            let Some(pos) = self.world.rows_by_component[self.comps.position].get(eid) else { continue };
            out.push((*eid, def_id, pos[0].floor() as i64, pos[1].floor() as i64, owner));
        }
        out.sort_by_key(|b| b.0);
        out
    }

    pub fn damaged_own_buildings(&self) -> Vec<(Eid, String, i64, i64)> {
        self.damaged_buildings(false).into_iter().map(|(e, d, x, y, _)| (e, d, x, y)).collect()
    }
    pub fn damaged_allied_buildings(&self) -> Vec<(Eid, String, i64, i64, f64)> {
        Vec::new() // no diplomacy matrix yet — TS: allies empty without one
    }

    pub fn known_nodes(&self, resource_code: Option<i64>) -> Vec<KnownNode> {
        self.refresh_memo();
        let key = resource_code.unwrap_or(-1);
        if let Some(cached) = self.memo.borrow().nodes.get(&key) {
            return cached.clone();
        }
        let mut out: Vec<KnownNode> = Vec::new();
        for (eid, r) in self.world.rows_by_component[self.econ.resource_node].iter() {
            if r[1] <= 0.0 {
                continue;
            }
            let code = r[0] as i64;
            if resource_code.map(|want| want != code).unwrap_or(false) {
                continue;
            }
            let Some(pos) = self.world.rows_by_component[self.comps.position].get(eid) else { continue };
            let (tx, ty) = (pos[0].floor() as i64, pos[1].floor() as i64);
            if !self.is_explored(tx, ty) && !self.is_visible(tx, ty) {
                continue;
            }
            out.push(KnownNode { eid: *eid, resource_code: code, tile_x: tx, tile_y: ty, remaining: r[1] });
        }
        out.sort_by_key(|n| n.eid);
        self.memo.borrow_mut().nodes.insert(key, out.clone());
        out
    }

    pub fn workers_on_node(&self, node_eid: Eid) -> usize {
        self.villager_eids()
            .iter()
            .filter(|&&eid| assigned_node(self.world, &self.econ, eid).map(|(n, _)| n) == Some(node_eid))
            .count()
    }

    pub fn visible_enemies(&self) -> Vec<KnownUnit> {
        self.known_entities()
            .into_iter()
            .filter(|e| self.is_hostile(e.owner) && e.def_id != "villager")
            .collect()
    }

    pub fn visible_enemy_villagers(&self) -> Vec<KnownUnit> {
        self.known_entities()
            .into_iter()
            .filter(|e| self.is_hostile(e.owner) && e.def_id == "villager")
            .collect()
    }

    fn relics(&self) -> Vec<(Eid, f64, f64)> {
        self.world.rows_by_component[self.relic]
            .iter()
            .map(|(eid, r)| (*eid, r[0], r[1]))
            .collect()
    }

    pub fn relics_held_by(&self, target_player: f64) -> i64 {
        let monastery_ids: HashSet<&str> = self
            .defs
            .buildings
            .values()
            .filter(|d| d.victory.as_ref().map(|v| v.path == "relic").unwrap_or(false))
            .map(|d| d.id.as_str())
            .collect();
        if monastery_ids.is_empty() {
            return 0;
        }
        let mut held = 0;
        for (_, state, holder) in self.relics() {
            if state != 2.0 {
                continue;
            }
            if let Some(hr) = building_row(self.world, &self.bcomps, holder as Eid) {
                if hr[0] == target_player && monastery_ids.contains(self.defs.building_id_of_code(hr[1] as u32)) {
                    held += 1;
                }
            }
        }
        held
    }

    pub fn wonder_count_of(&self, target_player: f64) -> i64 {
        let ids: HashSet<&str> = self
            .defs
            .buildings
            .values()
            .filter(|d| d.victory.as_ref().map(|v| v.path == "wonder").unwrap_or(false))
            .map(|d| d.id.as_str())
            .collect();
        if ids.is_empty() {
            return 0;
        }
        self.world.rows_by_component[self.bcomps.building]
            .values()
            .filter(|r| r[0] == target_player && ids.contains(self.defs.building_id_of_code(r[1] as u32)))
            .count() as i64
    }

    pub fn known_ground_relics(&self) -> Vec<(Eid, i64, i64)> {
        let mut out = Vec::new();
        for (eid, state, _) in self.relics() {
            if state != 0.0 {
                continue;
            }
            let Some(pos) = self.world.rows_by_component[self.comps.position].get(&eid) else { continue };
            out.push((eid, pos[0].floor() as i64, pos[1].floor() as i64));
        }
        out
    }

    pub fn own_monasteries(&self) -> Vec<(Eid, i64, i64)> {
        let ids: HashSet<&str> = self
            .defs
            .buildings
            .values()
            .filter(|d| {
                d.victory.as_ref().map(|v| v.path == "relic" && v.hold_ticks.is_some()).unwrap_or(false)
            })
            .map(|d| d.id.as_str())
            .collect();
        let mut out = Vec::new();
        for (eid, r) in self.world.rows_by_component[self.bcomps.building].iter() {
            if r[0] != self.player || !ids.contains(self.defs.building_id_of_code(r[1] as u32)) {
                continue;
            }
            let Some(pos) = self.world.rows_by_component[self.comps.position].get(eid) else { continue };
            out.push((*eid, pos[0].floor() as i64, pos[1].floor() as i64));
        }
        out.sort_by_key(|m| m.0);
        out
    }

    pub fn carried_relic_of(&self, unit_eid: Eid) -> Option<Eid> {
        self.relics()
            .into_iter()
            .find(|(_, state, holder)| *state == 1.0 && *holder == unit_eid as f64)
            .map(|(eid, _, _)| eid)
    }

    pub fn known_target_markets(&self) -> Vec<(Eid, i64, i64)> {
        let mut out: Vec<(Eid, i64, i64)> = self
            .known_entities()
            .into_iter()
            .filter(|e| {
                e.owner != self.player
                    && e.def_id == "market"
                    && !self.world.rows_by_component[self.bcomps.building_site].contains_key(&e.eid)
            })
            .map(|e| (e.eid, e.tile_x, e.tile_y))
            .collect();
        out.sort_by_key(|m| m.0);
        out
    }

    pub fn trade_carts(&self) -> Vec<KnownUnit> {
        let mut out: Vec<KnownUnit> = self
            .known_entities()
            .into_iter()
            .filter(|e| e.owner == self.player && e.def_id == "trade-cart")
            .collect();
        out.sort_by_key(|e| e.eid);
        out
    }

    pub fn is_trade_cart_active(&self, _cart_eid: Eid) -> bool {
        false // no market system ported yet (no active routes exist)
    }

    pub fn can_afford(&self, costs: &Costs) -> bool {
        can_afford_costs(self.world, &self.econ, self.player, costs)
    }

    pub fn can_place(&self, def_id: &str, tile_x: i64, tile_y: i64) -> bool {
        self.placement_block_reason(def_id, tile_x, tile_y).is_none()
    }

    pub fn placement_block_reason(&self, def_id: &str, tile_x: i64, tile_y: i64) -> Option<&'static str> {
        validate_placement(
            self.world,
            &self.comps,
            &self.bcomps,
            &self.econ,
            &self.age,
            self.defs,
            self.layers,
            def_id,
            tile_x,
            tile_y,
            self.player,
            false,
            Some(self.fog),
        )
        .err()
    }

    pub fn can_train(&self, building_eid: Eid, unit_id: Option<&str>) -> bool {
        can_enqueue_training(
            self.world, &self.comps, &self.bcomps, &self.age, &self.econ, self.defs,
            building_eid, self.player, unit_id,
        )
    }
}

// ---- planning budget + spot reservation ----

pub struct ResourceBudget {
    credit: Vec<f64>,
}

impl ResourceBudget {
    pub fn new(k: &AiKnowledge) -> ResourceBudget {
        ResourceBudget { credit: k.resources() }
    }
    pub fn afford(&self, costs: &Costs) -> bool {
        for (slug, amount) in costs {
            if *amount <= 0 {
                continue;
            }
            let code = crate::economy::resource_code_of_slug(slug)
                .unwrap_or_else(|| panic!("unknown resource slug: {slug:?}"));
            if self.credit[code as usize] < *amount as f64 {
                return false;
            }
        }
        true
    }
    pub fn debit(&mut self, costs: &Costs) {
        for (slug, amount) in costs {
            if *amount <= 0 {
                continue;
            }
            let code = crate::economy::resource_code_of_slug(slug)
                .unwrap_or_else(|| panic!("unknown resource slug: {slug:?}"));
            self.credit[code as usize] -= *amount as f64;
        }
    }
}

#[derive(Default)]
pub struct SpotReservation {
    reserved: HashSet<(i64, i64)>,
}

impl SpotReservation {
    pub fn new() -> SpotReservation {
        SpotReservation { reserved: HashSet::new() }
    }
    pub fn is_reserved(&self, tile_x: i64, tile_y: i64, width: i64, height: i64) -> bool {
        for dy in 0..height {
            for dx in 0..width {
                if self.reserved.contains(&(tile_x + dx, tile_y + dy)) {
                    return true;
                }
            }
        }
        false
    }
    pub fn reserve(&mut self, tile_x: i64, tile_y: i64, width: i64, height: i64) {
        for dy in 0..height {
            for dx in 0..width {
                self.reserved.insert((tile_x + dx, tile_y + dy));
            }
        }
    }
}

// ---- build-order layer (ai/buildOrder.ts) ----

#[derive(Clone, Debug, PartialEq)]
pub enum Completion {
    BuildingUp { def_id: &'static str, count: usize },
    AgeReached { rank: i64 },
    ArmySize { unit_id: &'static str, count: f64 },
    TechResearched { tech_id: &'static str },
}

#[derive(Clone, Debug, PartialEq)]
pub enum StepAction {
    PlaceBuilding { def_id: &'static str, min_clearance: i64, max_radius: i64 },
    ResearchAge,
    TrainArmy { unit_id: &'static str },
    Attack,
    ResearchTech { tech_id: &'static str, building_def_id: Option<&'static str> },
}

#[derive(Clone, Debug, Default)]
pub struct StepGate {
    pub min_resources: Vec<(&'static str, i64)>,
    pub buildings_up: &'static [(&'static str, usize)],
    pub min_age_rank: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct BuildStep {
    pub id: &'static str,
    pub requires: &'static [&'static str],
    pub action: StepAction,
    pub complete: Completion,
    pub gate: StepGate,
}

#[derive(Clone, Debug)]
pub struct Strategy {
    pub id: &'static str,
    pub villager_target: usize,
    pub gather_weights: (f64, f64, f64), // food, wood, gold
    pub attack_army_threshold: usize,
    pub steps: Vec<BuildStep>,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BuildOrderMemory {
    pub attacked_tick: Option<u64>,
}

const MILITARY_CLEARANCE: i64 = 4;
const MILITARY_RADIUS: i64 = 9;

fn place_step(id: &'static str, def_id: &'static str, requires: &'static [&'static str], min_wood: i64, min_age: i64) -> BuildStep {
    BuildStep {
        id,
        requires,
        action: StepAction::PlaceBuilding { def_id, min_clearance: MILITARY_CLEARANCE, max_radius: MILITARY_RADIUS },
        complete: Completion::BuildingUp { def_id, count: 1 },
        gate: StepGate { min_resources: vec![("wood", min_wood)], buildings_up: &[], min_age_rank: Some(min_age) },
    }
}

fn feudal_step() -> BuildStep {
    BuildStep {
        id: "feudal-up",
        requires: &[],
        action: StepAction::ResearchAge,
        complete: Completion::AgeReached { rank: 2 },
        gate: StepGate { min_resources: vec![("food", 500)], buildings_up: &[], min_age_rank: Some(1) },
    }
}

pub fn attack_step(unit_id: &'static str, requires: &'static [&'static str]) -> BuildStep {
    BuildStep {
        id: "attack",
        requires,
        action: StepAction::Attack,
        complete: Completion::ArmySize { unit_id, count: f64::INFINITY },
        gate: StepGate::default(),
    }
}

pub fn strategy_by_id(id: &str) -> Strategy {
    match id {
        "fast-castle-knights" => Strategy {
            id: "fast-castle-knights",
            villager_target: 12,
            gather_weights: (0.45, 0.3, 0.25),
            attack_army_threshold: 2,
            steps: vec![
                feudal_step(),
                place_step("dark-barracks", "barracks", &[], 175, 1),
                place_step("stable", "stable", &[], 175, 2),
                BuildStep {
                    id: "castle-up",
                    requires: &["feudal-up", "dark-barracks", "stable"],
                    action: StepAction::ResearchAge,
                    complete: Completion::AgeReached { rank: 3 },
                    gate: StepGate { min_resources: vec![("food", 800), ("gold", 200)], buildings_up: &[], min_age_rank: Some(2) },
                },
                BuildStep {
                    id: "train-knights",
                    requires: &["castle-up"],
                    action: StepAction::TrainArmy { unit_id: "knight" },
                    complete: Completion::ArmySize { unit_id: "knight", count: 4.0 },
                    gate: StepGate { min_resources: vec![], buildings_up: &[], min_age_rank: Some(3) },
                },
                attack_step("knight", &["train-knights"]),
            ],
        },
        "scouts-rush" => Strategy {
            id: "scouts-rush",
            villager_target: 10,
            gather_weights: (0.55, 0.35, 0.1),
            attack_army_threshold: 3,
            steps: vec![
                feudal_step(),
                place_step("dark-barracks", "barracks", &[], 175, 1),
                place_step("stable", "stable", &[], 175, 2),
                BuildStep {
                    id: "bloodlines",
                    requires: &["stable"],
                    action: StepAction::ResearchTech { tech_id: "bloodlines", building_def_id: Some("stable") },
                    complete: Completion::TechResearched { tech_id: "bloodlines" },
                    gate: StepGate { min_resources: vec![("food", 150), ("gold", 100)], buildings_up: &[], min_age_rank: Some(2) },
                },
                BuildStep {
                    id: "train-scouts",
                    requires: &["feudal-up", "stable"],
                    action: StepAction::TrainArmy { unit_id: "scout-cavalry" },
                    complete: Completion::ArmySize { unit_id: "scout-cavalry", count: 6.0 },
                    gate: StepGate { min_resources: vec![], buildings_up: &[], min_age_rank: Some(2) },
                },
                attack_step("scout-cavalry", &["train-scouts"]),
            ],
        },
        "archers-push" => Strategy {
            id: "archers-push",
            villager_target: 11,
            gather_weights: (0.35, 0.4, 0.25),
            attack_army_threshold: 4,
            steps: vec![
                feudal_step(),
                place_step("dark-barracks", "barracks", &[], 175, 1),
                place_step("archery-range", "archery-range", &[], 175, 2),
                place_step("blacksmith", "blacksmith", &["feudal-up"], 150, 2),
                BuildStep {
                    id: "fletching",
                    requires: &["blacksmith"],
                    action: StepAction::ResearchTech { tech_id: "fletching", building_def_id: Some("blacksmith") },
                    complete: Completion::TechResearched { tech_id: "fletching" },
                    gate: StepGate { min_resources: vec![("food", 100), ("gold", 50)], buildings_up: &[], min_age_rank: Some(2) },
                },
                BuildStep {
                    id: "train-archers",
                    requires: &["feudal-up", "archery-range"],
                    action: StepAction::TrainArmy { unit_id: "archer" },
                    complete: Completion::ArmySize { unit_id: "archer", count: 6.0 },
                    gate: StepGate { min_resources: vec![], buildings_up: &[], min_age_rank: Some(2) },
                },
                attack_step("archer", &["train-archers"]),
            ],
        },
        "naval-raider" => Strategy {
            id: "naval-raider",
            villager_target: 9,
            gather_weights: (0.3, 0.5, 0.2),
            attack_army_threshold: 3,
            steps: vec![
                feudal_step(),
                BuildStep {
                    id: "dock",
                    requires: &["feudal-up"],
                    action: StepAction::PlaceBuilding { def_id: "dock", min_clearance: 0, max_radius: 24 },
                    complete: Completion::BuildingUp { def_id: "dock", count: 1 },
                    gate: StepGate { min_resources: vec![("wood", 150)], buildings_up: &[], min_age_rank: Some(2) },
                },
                BuildStep {
                    id: "train-fishing-boats",
                    requires: &["dock"],
                    action: StepAction::TrainArmy { unit_id: "fishing-boat" },
                    complete: Completion::ArmySize { unit_id: "fishing-boat", count: 3.0 },
                    gate: StepGate { min_resources: vec![], buildings_up: &[], min_age_rank: Some(2) },
                },
                BuildStep {
                    id: "train-galleys",
                    requires: &["dock"],
                    action: StepAction::TrainArmy { unit_id: "galley" },
                    complete: Completion::ArmySize { unit_id: "galley", count: 3.0 },
                    gate: StepGate { min_resources: vec![], buildings_up: &[], min_age_rank: Some(2) },
                },
                attack_step("galley", &["train-galleys"]),
            ],
        },
        other => panic!("unknown strategy id: {other:?}"),
    }
}

pub fn site_candidates(origin_x: i64, origin_y: i64, min_clearance: i64, max_radius: i64) -> Vec<(i64, i64)> {
    let mut slots: Vec<(i64, i64, i64)> = Vec::new();
    for dy in -max_radius..=max_radius {
        for dx in -max_radius..=max_radius {
            if dx.abs() <= min_clearance && dy.abs() <= min_clearance {
                continue;
            }
            slots.push((origin_x + dx, origin_y + dy, dx * dx + dy * dy));
        }
    }
    slots.sort_by(|a, b| a.2.cmp(&b.2).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0)));
    slots.into_iter().map(|(x, y, _)| (x, y)).collect()
}

fn completion_met(k: &AiKnowledge, condition: &Completion) -> bool {
    match condition {
        Completion::BuildingUp { def_id, count } => k.finished_buildings(Some(def_id)).len() >= *count,
        Completion::AgeReached { rank } => k.age_rank() >= *rank as f64,
        Completion::ArmySize { unit_id, count } => {
            k.army_units().iter().filter(|u| u.def_id == *unit_id).count() as f64 >= *count
        }
        Completion::TechResearched { tech_id } => k.is_tech_researched(tech_id),
    }
}

fn gate_open(k: &AiKnowledge, budget: &ResourceBudget, gate: &StepGate) -> bool {
    if let Some(min_age) = gate.min_age_rank {
        if k.age_rank() < min_age as f64 {
            return false;
        }
    }
    if !gate.min_resources.is_empty() {
        let costs: Costs = gate.min_resources.iter().map(|(s, v)| (s.to_string(), *v)).collect();
        if !budget.afford(&costs) {
            return false;
        }
    }
    for (def_id, count) in gate.buildings_up {
        if k.finished_buildings(Some(def_id)).len() < *count {
            return false;
        }
    }
    true
}

fn emit_for_step(
    k: &AiKnowledge,
    defs: &Defs,
    budget: &mut ResourceBudget,
    reserved: &mut SpotReservation,
    step: &BuildStep,
) -> Option<CommandDraft> {
    match &step.action {
        StepAction::PlaceBuilding { def_id, min_clearance, max_radius } => {
            let def = defs.building(def_id);
            if !budget.afford(&def.costs) {
                return None;
            }
            if k.unfinished_sites().iter().any(|s| s.1 == *def_id) {
                return None;
            }
            let tc = k.finished_buildings(Some("town-center")).first().copied()?;
            let origin = k.own_building_origin(tc)?;
            for slot in site_candidates(origin.0, origin.1, *min_clearance, *max_radius) {
                if reserved.is_reserved(slot.0, slot.1, def.footprint.width, def.footprint.height) {
                    continue;
                }
                if !k.can_place(def_id, slot.0, slot.1) {
                    continue;
                }
                budget.debit(&def.costs);
                reserved.reserve(slot.0, slot.1, def.footprint.width, def.footprint.height);
                return Some(draft(
                    "placeBuilding",
                    serde_json::json!({"defId": def_id, "tileX": slot.0, "tileY": slot.1, "playerId": k.player}),
                ));
            }
            None
        }
        StepAction::ResearchAge => {
            let tech_id = k.next_age_tech_id()?;
            if !k.can_start_age_advance() {
                return None;
            }
            let costs = defs.tech(tech_id).costs.clone();
            if !budget.afford(&costs) {
                return None;
            }
            budget.debit(&costs);
            Some(draft("researchAge", serde_json::json!({"playerId": k.player})))
        }
        StepAction::ResearchTech { tech_id, building_def_id } => {
            let tech = defs.tech(tech_id).clone();
            if k.is_tech_researched(tech_id) || !budget.afford(&tech.costs) {
                return None;
            }
            let host = building_def_id.or(tech.building_id.as_deref());
            let candidates = match host {
                Some(h) => k.finished_buildings(Some(h)),
                None => k.finished_buildings(None),
            };
            for eid in candidates {
                if k.can_research_tech(eid, tech_id, false) {
                    budget.debit(&tech.costs);
                    return Some(draft(
                        "researchTech",
                        serde_json::json!({"siteEid": eid, "playerId": k.player, "techId": tech_id}),
                    ));
                }
            }
            None
        }
        StepAction::TrainArmy { unit_id } => {
            let effective = k.resolve_upgraded(unit_id);
            let def = defs.unit(&effective).clone();
            let target = match &step.complete {
                Completion::ArmySize { count, .. } => *count,
                _ => 0.0,
            };
            let mut current = k
                .army_units()
                .iter()
                .filter(|u| u.def_id == *unit_id || u.def_id == effective)
                .count() as f64;
            for eid in k.finished_buildings(None) {
                for queued in k.train_queue_of(eid) {
                    if queued == *unit_id || queued == effective {
                        current += 1.0;
                    }
                }
            }
            if current >= target || !budget.afford(&def.costs) {
                return None;
            }
            for eid in k.finished_buildings(None) {
                if !k.trainable_unit_ids(eid).contains(&effective) {
                    continue;
                }
                if !k.can_train(eid, Some(&effective)) {
                    continue;
                }
                budget.debit(&def.costs);
                return Some(draft("trainUnit", serde_json::json!({"siteEid": eid, "unitId": effective})));
            }
            None
        }
        StepAction::Attack => None,
    }
}

pub fn plan_build_order(
    k: &AiKnowledge,
    defs: &Defs,
    strategy: &Strategy,
    budget: &mut ResourceBudget,
    reserved: &mut SpotReservation,
) -> Option<CommandDraft> {
    let done: HashSet<&str> = strategy
        .steps
        .iter()
        .filter(|s| completion_met(k, &s.complete))
        .map(|s| s.id)
        .collect();
    for step in &strategy.steps {
        if done.contains(step.id) {
            continue;
        }
        if !step.requires.iter().all(|r| done.contains(r)) {
            continue;
        }
        if !gate_open(k, budget, &step.gate) {
            continue;
        }
        if let Some(d) = emit_for_step(k, defs, budget, reserved, step) {
            return Some(d);
        }
    }
    None
}

// ---- economy manager (ai/economyManager.ts) ----

const BUILDERS_PER_SITE: usize = 2;
const HOUSING_PIPELINE_MARGIN: i64 = 1;
const HOUSE_POP_CAP: i64 = 5;
const MIN_GATHERER_FRACTION: f64 = 0.4;
const HOUSE_SEARCH_RADIUS: i64 = 6;
const HOUSE_MIN_CLEARANCE: i64 = 1;

pub fn plan_economy(
    k: &AiKnowledge,
    defs: &Defs,
    villager_target: usize,
    weights: (f64, f64, f64),
    budget: &mut ResourceBudget,
    reserved: &mut SpotReservation,
    out: &mut Vec<CommandDraft>,
) {
    plan_auto_reseed(k, out);
    plan_housing(k, defs, budget, reserved, out);
    plan_tc_saturation(k, defs, villager_target, budget, out);
    plan_construction(k, out);
    plan_gathering(k, weights, out);
}

fn plan_auto_reseed(k: &AiKnowledge, out: &mut Vec<CommandDraft>) {
    let wood = k.resources().get(1).copied().unwrap_or(0.0);
    let desired = wood >= FARM_RESEED_WOOD_COST;
    if k.auto_reseed_enabled() != desired {
        out.push(draft(
            crate::gather::SET_AUTO_RESEED_COMMAND_KIND,
            serde_json::json!({"playerId": k.player, "enabled": desired}),
        ));
    }
}

fn plan_housing(
    k: &AiKnowledge,
    defs: &Defs,
    budget: &mut ResourceBudget,
    reserved: &mut SpotReservation,
    out: &mut Vec<CommandDraft>,
) {
    let mut queued = 0i64;
    for eid in k.finished_buildings(Some("town-center")) {
        queued += k.train_queue_of(eid).iter().filter(|u| *u == "villager").count() as i64;
    }
    let mut prospective_cap = k.population_cap();
    for site in k.unfinished_sites() {
        if site.1 == "house" {
            prospective_cap += HOUSE_POP_CAP;
        }
    }
    let shortfall = k.population() + queued + HOUSING_PIPELINE_MARGIN - prospective_cap;
    if shortfall <= 0 {
        return;
    }
    let houses_needed = (shortfall as f64 / HOUSE_POP_CAP as f64).ceil() as i64;
    let mut placed = out
        .iter()
        .filter(|d| d.kind == "placeBuilding" && d.data.get("defId").and_then(|v| v.as_str()) == Some("house"))
        .count() as i64;
    while placed < houses_needed {
        if !place_one_house(k, defs, budget, reserved, out) {
            break;
        }
        placed += 1;
    }
}

pub fn house_candidate_slots(origin_x: i64, origin_y: i64) -> Vec<(i64, i64)> {
    let margin = 3 + HOUSE_MIN_CLEARANCE;
    let mut slots: Vec<(i64, i64, i64)> = Vec::new();
    for dy in -HOUSE_SEARCH_RADIUS..=HOUSE_SEARCH_RADIUS {
        for dx in -HOUSE_SEARCH_RADIUS..=HOUSE_SEARCH_RADIUS {
            let (x, y) = (origin_x + dx, origin_y + dy);
            if x < 0 || y < 0 {
                continue;
            }
            if (-margin..=margin).contains(&dx) && (-margin..=margin).contains(&dy) {
                continue;
            }
            slots.push((x, y, dx * dx + dy * dy));
        }
    }
    slots.sort_by(|a, b| a.2.cmp(&b.2).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0)));
    slots.into_iter().map(|(x, y, _)| (x, y)).collect()
}

fn place_one_house(
    k: &AiKnowledge,
    defs: &Defs,
    budget: &mut ResourceBudget,
    reserved: &mut SpotReservation,
    out: &mut Vec<CommandDraft>,
) -> bool {
    let def = defs.building("house");
    if !budget.afford(&def.costs) {
        return false;
    }
    let Some(tc) = k.finished_buildings(Some("town-center")).first().copied() else { return false };
    let Some(origin) = k.own_building_origin(tc) else { return false };
    for slot in house_candidate_slots(origin.0, origin.1) {
        if reserved.is_reserved(slot.0, slot.1, def.footprint.width, def.footprint.height) {
            continue;
        }
        if !k.can_place("house", slot.0, slot.1) {
            continue;
        }
        budget.debit(&def.costs);
        reserved.reserve(slot.0, slot.1, def.footprint.width, def.footprint.height);
        out.push(draft(
            "placeBuilding",
            serde_json::json!({"defId": "house", "tileX": slot.0, "tileY": slot.1, "playerId": k.player}),
        ));
        return true;
    }
    false
}

fn plan_tc_saturation(k: &AiKnowledge, defs: &Defs, villager_target: usize, budget: &mut ResourceBudget, out: &mut Vec<CommandDraft>) {
    let Some(tc) = k.finished_buildings(Some("town-center")).first().copied() else { return };
    let villagers = k.villager_eids().len();
    let queued = k.train_queue_of(tc).iter().filter(|u| *u == "villager").count();
    if villagers + queued >= villager_target {
        return;
    }
    let costs = defs.unit("villager").costs.clone();
    if !k.can_train(tc, None) || !budget.afford(&costs) {
        return;
    }
    budget.debit(&costs);
    out.push(draft("trainVillager", serde_json::json!({"siteEid": tc})));
}

fn take_nearest(k: &AiKnowledge, candidates: &mut Vec<Eid>, tile_x: i64, tile_y: i64) -> Eid {
    let mut best_idx = 0usize;
    let mut best_d = f64::INFINITY;
    for (i, &eid) in candidates.iter().enumerate() {
        let d = match k.own_unit_tile(eid) {
            Some(pos) => ((pos.0 - tile_x).pow(2) + (pos.1 - tile_y).pow(2)) as f64,
            None => f64::INFINITY,
        };
        if d < best_d {
            best_d = d;
            best_idx = i;
        }
    }
    candidates.remove(best_idx)
}

fn plan_construction(k: &AiKnowledge, out: &mut Vec<CommandDraft>) {
    let sites = k.unfinished_sites();
    if sites.is_empty() {
        return;
    }
    let mut busy: HashSet<Eid> = HashSet::new();
    for site in &sites {
        for eid in k.builders_on(site.0) {
            busy.insert(eid);
        }
    }
    let (mut idle, mut gathering) = (Vec::new(), Vec::new());
    let mut assigned_gatherers = 0usize;
    for eid in k.villager_eids() {
        if busy.contains(&eid) {
            continue;
        }
        if k.carry_of(eid).map(|c| c.1 > 0.0).unwrap_or(false) {
            continue;
        }
        if matches!(k.assignment_of(eid), Some(WorkerAssignment::Node(_))) {
            assigned_gatherers += 1;
            gathering.push(eid);
        } else {
            idle.push(eid);
        }
    }
    let min_gatherers = ((k.villager_eids().len() as f64 * MIN_GATHERER_FRACTION).ceil() as usize).max(1);
    for site in &sites {
        let mut missing = BUILDERS_PER_SITE as i64 - k.builders_on(site.0).len() as i64;
        while missing > 0 {
            let builder = if !idle.is_empty() {
                Some(take_nearest(k, &mut idle, site.2, site.3))
            } else if !gathering.is_empty() && assigned_gatherers > min_gatherers {
                Some(take_nearest(k, &mut gathering, site.2, site.3))
            } else {
                None
            };
            let Some(builder) = builder else { break };
            if !gathering.contains(&builder) {
                // TS checks membership after splice; a builder drawn from
                // the gatherer pool always decrements the counter (the
                // membership check post-splice is always false in JS —
                // wait: TS splices inside takeNearest, so includes() is
                // false and the counter is NOT decremented. Mirror that.
            }
            out.push(draft("build", serde_json::json!({"entityIds": [builder], "siteEid": site.0})));
            missing -= 1;
        }
    }
}

fn plan_gathering(k: &AiKnowledge, weights: (f64, f64, f64), out: &mut Vec<CommandDraft>) {
    let nodes_by_resource: Vec<(i64, Vec<KnownNode>)> =
        vec![(0, k.known_nodes(Some(0))), (1, k.known_nodes(Some(1))), (2, k.known_nodes(Some(2)))];
    let mut node_resource: HashMap<Eid, i64> = HashMap::new();
    for (resource, nodes) in &nodes_by_resource {
        for node in nodes {
            node_resource.insert(node.eid, *resource);
        }
    }
    let weight_by: [(i64, f64); 3] = [(0, weights.0), (1, weights.1), (2, weights.2)];
    let mut workers_by: [i64; 3] = [0, 0, 0];
    let mut idle: Vec<Eid> = Vec::new();
    for eid in k.villager_eids() {
        if k.carry_of(eid).map(|c| c.1 > 0.0).unwrap_or(false) {
            continue;
        }
        match k.assignment_of(eid) {
            None => idle.push(eid),
            Some(WorkerAssignment::Site(_)) => {}
            Some(WorkerAssignment::Node(node_eid)) => {
                if let Some(resource) = node_resource.get(&node_eid) {
                    workers_by[*resource as usize] += 1;
                }
            }
        }
    }
    if idle.is_empty() {
        return;
    }
    let total = workers_by.iter().sum::<i64>() + idle.len() as i64;
    let mut deficits: Vec<(i64, i64)> = weight_by
        .iter()
        .map(|(resource, weight)| (*resource, crate::pop::js_round(weight * total as f64) as i64 - workers_by[*resource as usize]))
        .collect();
    deficits.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let anchor = anchor_tile(k);
    for villager in idle {
        let mut chosen: Option<Eid> = None;
        'outer: for (resource, _) in &deficits {
            let mut best: Option<(Eid, (usize, i64, Eid))> = None;
            for node in nodes_by_resource.iter().find(|(r, _)| r == resource).map(|(_, n)| n).unwrap() {
                let workers = k.workers_on_node(node.eid);
                if workers as f64 >= WORK_SLOTS_PER_NODE {
                    continue;
                }
                let d = (node.tile_x - anchor.0).pow(2) + (node.tile_y - anchor.1).pow(2);
                let key = (workers, d, node.eid);
                if best.map(|(_, bk)| key < bk).unwrap_or(true) {
                    best = Some((node.eid, key));
                }
            }
            if let Some((eid, _)) = best {
                chosen = Some(eid);
                break 'outer;
            }
        }
        let Some(node_id) = chosen else { break };
        out.push(draft("gather", serde_json::json!({"entityIds": [villager], "nodeId": node_id})));
    }
}

fn anchor_tile(k: &AiKnowledge) -> (i64, i64) {
    match k.finished_buildings(Some("town-center")).first().and_then(|&tc| k.own_building_origin(tc)) {
        Some(origin) => origin,
        None => (0, 0),
    }
}

// ---- military manager (ai/militaryManager.ts) ----

pub const RAID_DENSITY_RADIUS_TILES: i64 = 6;
pub const RAID_DENSITY_WEIGHT: i64 = 1_000_000;
pub const DEFENSE_THREAT_RADIUS_TILES: i64 = 9;
pub const DEFENSE_RALLY_COOLDOWN_TICKS: u64 = 30;
pub const COUNTER_TRAIN_CAP: u64 = 8;
pub const TRIBUTE_COOLDOWN_TICKS: u64 = 60;

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct MilitaryMemory {
    pub threat_since: BTreeMap<Eid, u64>,
    pub last_rally_tick: Option<u64>,
    pub counters_trained: u64,
    pub last_tribute_tick: Option<u64>,
}

fn dist_sq_tile(a: (i64, i64), b: (i64, i64)) -> i64 {
    (a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1)
}

fn anchor_tile_center(k: &AiKnowledge) -> (i64, i64) {
    match k.finished_buildings(Some("town-center")).first().and_then(|&tc| k.own_building_origin(tc)) {
        Some((x, y)) => (x + 1, y + 1),
        None => (0, 0),
    }
}

fn visible_enemy_units(k: &AiKnowledge, defs: &Defs) -> Vec<KnownUnit> {
    k.visible_enemies()
        .into_iter()
        .filter(|e| !defs.buildings.contains_key(&e.def_id))
        .collect()
}

pub fn plan_defense_rally(
    k: &AiKnowledge,
    defs: &Defs,
    memory: &mut MilitaryMemory,
    reaction_delay_ticks: u64,
) -> Option<CommandDraft> {
    let army = k.army_units();
    if army.is_empty() {
        memory.threat_since.clear();
        return None;
    }
    let enemies = visible_enemy_units(k, defs);
    if enemies.is_empty() {
        memory.threat_since.clear();
        return None;
    }
    let now = k.tick();
    let radius_sq = DEFENSE_THREAT_RADIUS_TILES * DEFENSE_THREAT_RADIUS_TILES;
    let cooling = memory.last_rally_tick.map(|t| now - t < DEFENSE_RALLY_COOLDOWN_TICKS).unwrap_or(false);
    let mut next_clocks: BTreeMap<Eid, u64> = BTreeMap::new();
    let mut rally: Option<CommandDraft> = None;
    for (b_eid, _, bx, by) in k.damaged_own_buildings() {
        let mut nearest: Option<(Eid, i64)> = None;
        for enemy in &enemies {
            let d = dist_sq_tile((enemy.tile_x, enemy.tile_y), (bx, by));
            if d > radius_sq {
                continue;
            }
            let better = match nearest {
                None => true,
                Some((best_eid, best_d)) => d < best_d || (d == best_d && enemy.eid < best_eid),
            };
            if better {
                nearest = Some((enemy.eid, d));
            }
        }
        let Some((target, _)) = nearest else { continue };
        let first = memory.threat_since.get(&b_eid).copied().unwrap_or(now);
        next_clocks.insert(b_eid, first);
        if cooling {
            continue;
        }
        if now - first < reaction_delay_ticks {
            continue;
        }
        if rally.is_none() {
            rally = Some(draft(
                "attack",
                serde_json::json!({
                    "attackerIds": army.iter().map(|u| u.eid).collect::<Vec<_>>(),
                    "targetId": target,
                    "purpose": "defense",
                }),
            ));
        }
    }
    // Allied priority-2 pass elided: no diplomacy matrix → no allies.
    memory.threat_since = next_clocks;
    if rally.is_some() {
        memory.last_rally_tick = Some(now);
    }
    rally
}

pub fn score_offensive_target(k: &AiKnowledge) -> Option<(Eid, usize)> {
    let enemies = k.visible_enemies();
    if enemies.is_empty() {
        return None;
    }
    let villagers = k.visible_enemy_villagers();
    let anchor = anchor_tile_center(k);
    let radius_sq = RAID_DENSITY_RADIUS_TILES * RAID_DENSITY_RADIUS_TILES;
    let mut best: Option<(Eid, usize)> = None;
    let mut best_score = i64::MIN;
    for enemy in &enemies {
        let nearby = villagers
            .iter()
            .filter(|v| dist_sq_tile((v.tile_x, v.tile_y), (enemy.tile_x, enemy.tile_y)) <= radius_sq)
            .count();
        let score = nearby as i64 * RAID_DENSITY_WEIGHT - dist_sq_tile((enemy.tile_x, enemy.tile_y), anchor);
        let better = score > best_score
            || (score == best_score && best.map(|(b, _)| enemy.eid < b).unwrap_or(false));
        if better {
            best_score = score;
            best = Some((enemy.eid, nearby));
        }
    }
    best
}

pub fn plan_offensive(
    k: &AiKnowledge,
    threshold: usize,
    memory: &mut BuildOrderMemory,
) -> Option<CommandDraft> {
    if memory.attacked_tick.is_some() {
        return None;
    }
    let army = k.army_units();
    if army.len() < threshold.max(1) {
        return None;
    }
    let (target_id, nearby) = score_offensive_target(k)?;
    memory.attacked_tick = Some(k.tick());
    Some(draft(
        "attack",
        serde_json::json!({
            "attackerIds": army.iter().map(|u| u.eid).collect::<Vec<_>>(),
            "targetId": target_id,
            "purpose": if nearby > 0 { "raid" } else { "strike" },
        }),
    ))
}

fn scouted_composition(k: &AiKnowledge, defs: &Defs) -> Vec<(String, usize)> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for enemy in visible_enemy_units(k, defs) {
        if !defs.units.contains_key(&enemy.def_id) {
            continue;
        }
        *counts.entry(enemy.def_id).or_default() += 1;
    }
    counts.into_iter().collect()
}

pub fn plan_counter_training(
    k: &AiKnowledge,
    defs: &Defs,
    budget: &mut ResourceBudget,
    memory: &mut MilitaryMemory,
    out: &mut Vec<CommandDraft>,
) {
    if memory.counters_trained >= COUNTER_TRAIN_CAP {
        return;
    }
    let enemies = scouted_composition(k, defs);
    if enemies.is_empty() {
        return;
    }
    let mut candidates: BTreeMap<String, ()> = BTreeMap::new();
    for eid in k.finished_buildings(None) {
        for unit_id in k.trainable_unit_ids(eid) {
            if candidates.contains_key(&unit_id) {
                continue;
            }
            if defs.unit(&unit_id).attack <= 0.0 {
                continue;
            }
            candidates.insert(unit_id, ());
        }
    }
    let visible_buildings = k.visible_enemies().iter().filter(|e| defs.buildings.contains_key(&e.def_id)).count();
    let mut best_id: Option<String> = None;
    let mut best_score = 0.0f64;
    for unit_id in candidates.keys() {
        let def = defs.unit(unit_id);
        let mut score = 0.0;
        for (enemy_id, count) in &enemies {
            let enemy_def = defs.unit(enemy_id);
            score += *count as f64
                * (bonus_multiplier_of(def, &enemy_def.armor_classes)
                    - bonus_multiplier_of(enemy_def, &def.armor_classes));
        }
        if visible_buildings > 0 {
            let b = bonus_multiplier_of(def, &["building".to_string()]);
            if b > 1.0 {
                score += visible_buildings as f64 * b.floor();
            }
        }
        let better = score > best_score
            || (score == best_score && best_id.as_ref().map(|b| score > 0.0 && unit_id.as_str() < b.as_str()).unwrap_or(false));
        if better {
            best_id = Some(unit_id.clone());
            best_score = score;
        }
    }
    let Some(best_id) = best_id else { return };
    let def = defs.unit(&best_id).clone();
    if !budget.afford(&def.costs) {
        return;
    }
    for eid in k.finished_buildings(None) {
        if !k.trainable_unit_ids(eid).contains(&best_id) || !k.can_train(eid, Some(&best_id)) {
            continue;
        }
        budget.debit(&def.costs);
        memory.counters_trained += 1;
        out.push(draft(
            "trainUnit",
            serde_json::json!({"siteEid": eid, "unitId": best_id, "purpose": "counter"}),
        ));
        return;
    }
}

pub fn is_high_value_conversion_target(defs: &Defs, def_id: &str) -> bool {
    for needle in ["knight", "cavalier", "paladin", "ram", "mangonel", "onager", "scorpion", "trebuchet", "elephant"] {
        if def_id.contains(needle) {
            return true;
        }
    }
    if let Some(def) = defs.units.get(def_id) {
        if def.armor_classes.iter().any(|c| c == "cavalry" || c == "siege") {
            return true;
        }
    }
    false
}

pub fn plan_monk_conversions(k: &AiKnowledge, defs: &Defs, out: &mut Vec<CommandDraft>) {
    let monks: Vec<KnownUnit> = k.army_units().into_iter().filter(|u| u.def_id == "monk").collect();
    if monks.is_empty() {
        return;
    }
    let enemies = k.visible_enemies();
    if enemies.is_empty() {
        return;
    }
    let high: Vec<&KnownUnit> = enemies.iter().filter(|e| is_high_value_conversion_target(defs, &e.def_id)).collect();
    let candidates: Vec<&KnownUnit> = if high.is_empty() { enemies.iter().collect() } else { high };
    for monk in &monks {
        let mut best: Option<&KnownUnit> = None;
        let mut best_d = 144i64;
        for enemy in &candidates {
            let d = dist_sq_tile((enemy.tile_x, enemy.tile_y), (monk.tile_x, monk.tile_y));
            if d < best_d {
                best_d = d;
                best = Some(enemy);
            }
        }
        if let Some(target) = best {
            out.push(draft(
                "convert",
                serde_json::json!({"targetId": target.eid, "monkEid": monk.eid}),
            ));
        }
    }
}

pub fn plan_monk_conversion_single(k: &AiKnowledge, defs: &Defs) -> Option<CommandDraft> {
    let mut out = Vec::new();
    plan_monk_conversions(k, defs, &mut out);
    out.into_iter().next()
}

pub fn plan_relic_collection(k: &AiKnowledge, out: &mut Vec<CommandDraft>) {
    let monks: Vec<KnownUnit> = k.army_units().into_iter().filter(|u| u.def_id == "monk").collect();
    if monks.is_empty() {
        return;
    }
    let idle: Vec<&KnownUnit> = monks.iter().filter(|u| k.carried_relic_of(u.eid).is_none()).collect();
    if idle.is_empty() {
        return;
    }
    let grounded = k.known_ground_relics();
    if grounded.is_empty() {
        return;
    }
    let mut pairs: Vec<(Eid, Eid, i64)> = Vec::new();
    for monk in &idle {
        for relic in &grounded {
            pairs.push((monk.eid, relic.0, dist_sq_tile((monk.tile_x, monk.tile_y), (relic.1, relic.2))));
        }
    }
    pairs.sort_by(|a, b| a.2.cmp(&b.2).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    let (mut claimed_relics, mut claimed_monks) = (HashSet::new(), HashSet::new());
    for (monk_eid, relic_eid, _) in pairs {
        if claimed_relics.contains(&relic_eid) || claimed_monks.contains(&monk_eid) {
            continue;
        }
        claimed_relics.insert(relic_eid);
        claimed_monks.insert(monk_eid);
        out.push(draft("collectRelic", serde_json::json!({"unitEid": monk_eid, "relicEid": relic_eid})));
    }
}

pub fn plan_relic_deposit(k: &AiKnowledge, out: &mut Vec<CommandDraft>) {
    let monks: Vec<KnownUnit> = k.army_units().into_iter().filter(|u| u.def_id == "monk").collect();
    let carriers: Vec<&KnownUnit> = monks.iter().filter(|u| k.carried_relic_of(u.eid).is_some()).collect();
    if carriers.is_empty() {
        return;
    }
    let monasteries = k.own_monasteries();
    if monasteries.is_empty() {
        return;
    }
    for monk in carriers {
        let mut best = monasteries[0];
        let mut best_d = dist_sq_tile((monk.tile_x, monk.tile_y), (best.1, best.2));
        for m in &monasteries[1..] {
            let d = dist_sq_tile((monk.tile_x, monk.tile_y), (m.1, m.2));
            if d < best_d || (d == best_d && m.0 < best.0) {
                best_d = d;
                best = *m;
            }
        }
        out.push(draft("depositRelic", serde_json::json!({"unitEid": monk.eid, "monasteryEid": best.0})));
    }
}

pub fn plan_relic_deposit_single(k: &AiKnowledge) -> Option<CommandDraft> {
    let mut out = Vec::new();
    plan_relic_deposit(k, &mut out);
    out.into_iter().next()
}

pub fn plan_relic_collection_single(k: &AiKnowledge) -> Option<CommandDraft> {
    let mut out = Vec::new();
    plan_relic_collection(k, &mut out);
    out.into_iter().next()
}

pub fn plan_tribute_transfer(_k: &AiKnowledge, _memory: &mut MilitaryMemory, _tick: u64) -> Option<CommandDraft> {
    None // no allies without a diplomacy matrix
}

pub fn plan_military_tech_research(
    k: &AiKnowledge,
    defs: &Defs,
    budget: &mut ResourceBudget,
    drafts: &mut Vec<CommandDraft>,
) {
    let mut busy: HashSet<Eid> = drafts
        .iter()
        .filter(|d| d.kind == "researchTech")
        .filter_map(|d| d.data.get("siteEid").and_then(|v| v.as_i64()))
        .collect();
    let army = k.army_units();
    let count = |ids: &[&str]| army.iter().filter(|u| ids.contains(&u.def_id.as_str())).count();
    let archers = count(&["archer", "crossbowman", "arbalest", "skirmisher"]);
    let infantry = count(&["militia", "man-at-arms", "longswordsman", "two-handed-swordsman"]);
    let cavalry = count(&["scout-cavalry", "light-cavalry", "knight", "cavalier", "paladin"]);
    let has = |def_id: &str| !k.finished_buildings(Some(def_id)).is_empty();
    let mut candidates: Vec<&str> = Vec::new();
    if has("archery-range") {
        if army.iter().any(|u| u.def_id == "archer") {
            candidates.push("crossbowman-upgrade");
        }
        if army.iter().any(|u| u.def_id == "crossbowman") {
            candidates.push("arbalest-upgrade");
        }
    }
    if has("barracks") {
        if army.iter().any(|u| u.def_id == "militia") {
            candidates.push("man-at-arms-upgrade");
        }
        if army.iter().any(|u| u.def_id == "man-at-arms") {
            candidates.push("longswordsman-upgrade");
        }
        if army.iter().any(|u| u.def_id == "longswordsman") {
            candidates.push("two-handed-swordsman-upgrade");
        }
    }
    if has("stable") {
        if army.iter().any(|u| u.def_id == "scout-cavalry") {
            candidates.push("light-cavalry-upgrade");
        }
        if army.iter().any(|u| u.def_id == "knight") {
            candidates.push("cavalier-upgrade");
        }
        if army.iter().any(|u| u.def_id == "cavalier") {
            candidates.push("paladin-upgrade");
        }
    }
    if has("blacksmith") {
        if archers >= infantry && archers >= cavalry && archers > 0 {
            candidates.extend(["fletching", "bodkin-arrow", "padded-archer-armor", "leather-archer-armor", "bracer", "ring-archer-armor", "forging", "iron-casting"]);
        } else if cavalry >= infantry && cavalry > 0 {
            candidates.extend(["scale-barding", "forging", "chain-barding", "iron-casting", "plate-barding", "blast-furnace", "fletching"]);
        } else if infantry > 0 {
            candidates.extend(["forging", "scale-mail", "iron-casting", "chain-mail", "blast-furnace", "plate-mail", "fletching"]);
        } else {
            candidates.extend([
                "fletching", "forging", "scale-mail", "scale-barding", "padded-archer-armor", "bodkin-arrow",
                "iron-casting", "chain-mail", "chain-barding", "leather-archer-armor", "bracer", "blast-furnace",
                "plate-mail", "plate-barding", "ring-archer-armor",
            ]);
        }
    }
    for tech_id in candidates {
        if k.is_tech_researched(tech_id) {
            continue;
        }
        let Some(tech) = defs.techs.get(tech_id) else { continue };
        let Some(host) = tech.building_id.clone() else { continue };
        if !budget.afford(&tech.costs) {
            continue;
        }
        for eid in k.finished_buildings(Some(&host)) {
            if busy.contains(&eid) || !k.can_research_tech(eid, tech_id, false) {
                continue;
            }
            budget.debit(&tech.costs);
            busy.insert(eid);
            drafts.push(draft(
                "researchTech",
                serde_json::json!({"siteEid": eid, "playerId": k.player, "techId": tech_id}),
            ));
            break;
        }
    }
}

// ---- trade + naval managers ----

pub const MAX_AI_TRADE_CARTS: usize = 2;

pub fn plan_trade_routes(k: &AiKnowledge, defs: &Defs, out: &mut Vec<CommandDraft>, budget: &mut ResourceBudget) {
    let own_markets = k.finished_buildings(Some("market"));
    if own_markets.is_empty() {
        return;
    }
    let targets = k.known_target_markets();
    if targets.is_empty() {
        return;
    }
    let carts = k.trade_carts();
    for cart in &carts {
        if k.is_trade_cart_active(cart.eid) {
            continue;
        }
        let mut best = targets[0];
        let mut best_d = dist_sq_tile((cart.tile_x, cart.tile_y), (best.1, best.2));
        for tm in &targets[1..] {
            let d = dist_sq_tile((cart.tile_x, cart.tile_y), (tm.1, tm.2));
            if d < best_d || (d == best_d && tm.0 < best.0) {
                best_d = d;
                best = *tm;
            }
        }
        out.push(draft("assignTradeRoute", serde_json::json!({"cartId": cart.eid, "targetMarketId": best.0})));
    }
    if carts.len() < MAX_AI_TRADE_CARTS && k.population() < k.population_cap() {
        let cart_def = defs.unit("trade-cart").clone();
        if budget.afford(&cart_def.costs) {
            for market in own_markets {
                if !k.can_train(market, Some("trade-cart")) {
                    continue;
                }
                budget.debit(&cart_def.costs);
                out.push(draft(
                    "trainUnit",
                    serde_json::json!({"siteEid": market, "unitId": "trade-cart", "purpose": "trade"}),
                ));
                break;
            }
        }
    }
}

pub const FISHING_BOAT_TARGET: usize = 3;
pub const WARSHIP_TARGET: usize = 4;

fn count_naval(k: &AiKnowledge, unit_id: &str) -> usize {
    let mut n = k.army_units().iter().filter(|u| u.def_id == unit_id).count();
    for eid in k.finished_buildings(None) {
        n += k.train_queue_of(eid).iter().filter(|id| *id == unit_id).count();
    }
    n
}

fn try_train_from(k: &AiKnowledge, defs: &Defs, budget: &mut ResourceBudget, unit_id: &str) -> Option<CommandDraft> {
    let def = defs.unit(unit_id).clone();
    if !budget.afford(&def.costs) {
        return None;
    }
    for eid in k.finished_buildings(Some("dock")) {
        if !k.trainable_unit_ids(eid).iter().any(|u| u == unit_id) || !k.can_train(eid, Some(unit_id)) {
            continue;
        }
        budget.debit(&def.costs);
        return Some(draft("trainUnit", serde_json::json!({"siteEid": eid, "unitId": unit_id})));
    }
    None
}

pub fn plan_naval_fleet(k: &AiKnowledge, defs: &Defs, budget: &mut ResourceBudget, drafts: &mut Vec<CommandDraft>) {
    if k.finished_buildings(Some("dock")).is_empty() {
        return;
    }
    if count_naval(k, "fishing-boat") < FISHING_BOAT_TARGET {
        if let Some(d) = try_train_from(k, defs, budget, "fishing-boat") {
            drafts.push(d);
            return;
        }
    }
    let has_naval_enemy = k.visible_enemies().iter().any(|e| {
        e.def_id == "dock"
            || defs
                .units
                .get(&e.def_id)
                .map(|d| d.armor_classes.iter().any(|c| c == "ship"))
                .unwrap_or(false)
    });
    if has_naval_enemy {
        let warships = ["galley", "war-galley", "galleon", "fire-ship", "cannon-galleon"]
            .iter()
            .map(|id| count_naval(k, id))
            .sum::<usize>();
        if warships < WARSHIP_TARGET {
            let warship_id = if k.age_rank() >= 4.0 {
                "galleon"
            } else if k.age_rank() >= 3.0 {
                "war-galley"
            } else {
                "galley"
            };
            if let Some(d) = try_train_from(k, defs, budget, warship_id) {
                drafts.push(d);
                return;
            }
        }
    }
    for unit in k.army_units() {
        if unit.def_id == "fishing-boat" && k.assignment_of(unit.eid).is_none() {
            let food_nodes: Vec<KnownNode> = k.known_nodes(Some(0)).into_iter().filter(|n| n.remaining > 0.0).collect();
            if !food_nodes.is_empty() {
                let mut best = food_nodes[0].clone();
                let mut best_dist = f64::INFINITY;
                for node in &food_nodes {
                    let dist =
                        ((node.tile_x - unit.tile_x) as f64).hypot((node.tile_y - unit.tile_y) as f64);
                    if dist < best_dist {
                        best_dist = dist;
                        best = node.clone();
                    }
                }
                drafts.push(draft("gather", serde_json::json!({"entityIds": [unit.eid], "nodeId": best.eid})));
                return;
            }
        }
    }
}

// ---- planner orchestrator (ai/planner.ts) ----

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PlannerTelemetry {
    pub think_calls: u64,
    pub incremental_calls: u64,
    pub total_think_ms: f64,
    pub issued_by_kind: BTreeMap<String, u64>,
    pub first_tick_by_kind: BTreeMap<String, u64>,
    pub attack_drafts: Vec<(u64, i64, usize, bool, String)>,
    pub gather_drafts_known: u64,
    pub gather_drafts: u64,
    pub counter_trains: u64,
    pub defense_rallies: u64,
}

pub struct AiPlannerSystem {
    pub knowledge_player: f64,
    pub fog: FogHandle,
    pub strategy: Strategy,
    pub difficulty: AiDifficulty,
    pub reaction_latency: Option<u64>,
    pub phase_offset: u64,
    pub memory: BuildOrderMemory,
    pub military_memory: MilitaryMemory,
    pub telemetry: PlannerTelemetry,
}

impl AiPlannerSystem {
    pub fn new(strategy: Strategy, fog: FogHandle) -> AiPlannerSystem {
        AiPlannerSystem {
            knowledge_player: AI_PLAYER,
            fog,
            strategy,
            difficulty: AiDifficulty::Normal,
            reaction_latency: None,
            phase_offset: 0,
            memory: BuildOrderMemory::default(),
            military_memory: MilitaryMemory::default(),
            telemetry: PlannerTelemetry::default(),
        }
    }

    fn full_pass_interval(&self) -> u64 {
        match self.reaction_latency {
            Some(latency) => PLANNER_CADENCE_TICKS * latency,
            None => self.difficulty.decision_interval_ticks(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn run(
        &mut self,
        world: &mut CoreWorld,
        defs: &Defs,
        layers: &Layers,
        comps: &MovementComps,
        econ: &EconomyComps,
        bcomps: &BuildingComps,
        age: &AgeComps,
        relic_component: usize,
        auto_reseed: bool,
    ) {
        // The runner syncs fog (flush) before this call, as TS does.
        let pop = PopComps::from_world(world);
        let k = AiKnowledge::new(
            world,
            defs,
            &self.fog,
            layers,
            self.knowledge_player,
            *comps,
            *econ,
            *bcomps,
            *age,
            relic_component,
            auto_reseed,
        );
        let tick = world.tick;
        let interval = self.full_pass_interval();
        let is_full = (tick as i64 - self.phase_offset as i64).rem_euclid(interval as i64) == 0;
        let mut drafts: Vec<CommandDraft> = Vec::new();
        if is_full {
            self.telemetry.think_calls += 1;
            let mut budget = ResourceBudget::new(&k);
            let mut reserved = SpotReservation::new();
            plan_economy(&k, defs, self.strategy.villager_target, self.strategy.gather_weights, &mut budget, &mut reserved, &mut drafts);
            if let Some(d) = plan_build_order(&k, defs, &self.strategy.clone(), &mut budget, &mut reserved) {
                drafts.push(d);
            }
            plan_counter_training(&k, defs, &mut budget, &mut self.military_memory, &mut drafts);
            plan_military_tech_research(&k, defs, &mut budget, &mut drafts);
            plan_relic_deposit(&k, &mut drafts);
            plan_relic_collection(&k, &mut drafts);
            plan_monk_conversions(&k, defs, &mut drafts);
            plan_trade_routes(&k, defs, &mut drafts, &mut budget);
            plan_naval_fleet(&k, defs, &mut budget, &mut drafts);
            if let Some(d) = plan_tribute_transfer(&k, &mut self.military_memory, tick) {
                drafts.push(d);
            }
        } else {
            self.telemetry.incremental_calls += 1;
            let draft = plan_defense_rally(&k, defs, &mut self.military_memory, self.difficulty.reaction_delay_ticks())
                .or_else(|| {
                    if k.army_units().iter().any(|u| u.def_id == "monk") {
                        plan_relic_deposit_single(&k)
                            .or_else(|| plan_relic_collection_single(&k))
                            .or_else(|| plan_monk_conversion_single(&k, defs))
                    } else {
                        None
                    }
                })
                .or_else(|| plan_offensive(&k, self.strategy.attack_army_threshold, &mut self.memory));
            if let Some(d) = draft {
                drafts.push(d);
            }
        }
        // Telemetry inputs that read knowledge are precomputed here so
        // submission can take the world mutably after `k` drops.
        let prepared: Vec<(CommandDraft, bool, bool)> = drafts
            .into_iter()
            .map(|d| {
                let gather_known = d.kind == "gather"
                    && d.data
                        .get("nodeId")
                        .and_then(|v| v.as_i64())
                        .map(|node_id| k.known_nodes(None).iter().any(|n| n.eid == node_id))
                        .unwrap_or(false);
                let attack_visible = d.kind == "attack"
                    && d.data
                        .get("targetId")
                        .and_then(|v| v.as_i64())
                        .map(|t| k.visible_enemies().iter().any(|e| e.eid == t))
                        .unwrap_or(false);
                (d, gather_known, attack_visible)
            })
            .collect();
        drop(k);
        for (draft, gather_known, attack_visible) in prepared {
            self.submit(world, draft, gather_known, attack_visible);
        }
        let _ = pop;
    }

    fn submit(&mut self, world: &mut CoreWorld, draft: CommandDraft, gather_known: bool, attack_visible: bool) {
        world
            .inbox
            .submit(Command { kind: draft.kind.clone(), target_tick: world.tick + 1, data: Some(draft.data.clone()) })
            .expect("ai submit");
        *self.telemetry.issued_by_kind.entry(draft.kind.clone()).or_default() += 1;
        self.telemetry.first_tick_by_kind.entry(draft.kind.clone()).or_insert(world.tick);
        if draft.kind == "gather" {
            self.telemetry.gather_drafts += 1;
            if gather_known {
                self.telemetry.gather_drafts_known += 1;
            }
        }
        if draft.kind == "attack" {
            let target_id = draft.data.get("targetId").and_then(|v| v.as_i64());
            let attackers = draft.data.get("attackerIds").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            let purpose = draft.data.get("purpose").and_then(|v| v.as_str()).unwrap_or("strike").to_string();
            self.telemetry.attack_drafts.push((world.tick, target_id.unwrap_or(-1), attackers, attack_visible, purpose.clone()));
            if purpose == "defense" || purpose == "defense-assist" {
                self.telemetry.defense_rallies += 1;
            }
        }
        if draft.kind == "trainUnit" && draft.data.get("purpose").and_then(|v| v.as_str()) == Some("counter") {
            self.telemetry.counter_trains += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{create_player_age_state, current_age_rank, population_cap, read_age_advanced, read_gate_rejections, AgeComps, BuildingComps};
    use crate::combat::{spawn_combat_unit, CombatComps, SpawnCombatOptions};
    use crate::economy::{
        create_commodity_stockpile, create_player_stockpile, spawn_resource_node, stockpile_amounts,
        PLAYER_ONE,
    };
    use crate::fog::FogHandle;
    use crate::gather::EconomySim;
    use crate::mapgen::{Layers, TERRAIN_GRASS};
    use crate::path::Transport;
    use serde::Deserialize;
    use std::sync::{Arc, OnceLock};

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
    struct Side {
        #[serde(rename = "tcOrigin")]
        tc_origin: (i64, i64),
        villagers: Vec<(f64, f64)>,
        stockpile: std::collections::BTreeMap<String, f64>,
        strategy: Option<String>,
    }
    #[derive(Deserialize)]
    struct Node {
        #[serde(rename = "tileX")]
        tile_x: i64,
        #[serde(rename = "tileY")]
        tile_y: i64,
        resource: String,
        amount: i64,
    }
    #[derive(Deserialize)]
    struct Fixture {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        #[serde(rename = "playerZero")]
        player_zero: Side,
        ai: Side,
        nodes: Vec<Node>,
    }

    fn amounts(stock: &std::collections::BTreeMap<String, f64>) -> Vec<f64> {
        ["food", "wood", "gold", "stone", "iron", "coal", "clay"].iter().map(|s| stock[*s]).collect()
    }

    fn run_main() -> (EconomySim, Vec<(u64, String)>) {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t9/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = Layers {
            size: fixture.size,
            terrain: vec![TERRAIN_GRASS; fixture.size * fixture.size],
            elevation: vec![0; fixture.size * fixture.size],
            passability: vec![1; fixture.size * fixture.size],
        };
        sim.combat.group_routes = true;
        let econ = sim.econ;
        for (x, y) in &fixture.player_zero.villagers {
            sim.spawn_unit(*x, *y);
        }
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, Some(&amounts(&fixture.player_zero.stockpile))).unwrap();
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE).unwrap();
        let age = AgeComps::from_world(&sim.movement.world);
        create_player_age_state(&mut sim.movement.world, &age, &econ, PLAYER_ONE);
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        {
            let defs = defs();
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            crate::placement::stamp_finished_building(
                world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                "town-center", fixture.player_zero.tc_origin.0, fixture.player_zero.tc_origin.1, PLAYER_ONE,
            );
        }
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let pop = PopComps::from_world(world);
            let morale = CombatComps::from_world(world).morale;
            setup_ai_opponent(
                world, comps, &econ, &bcomps, &age, &pop, morale, &traits(), &defs(), layers, paths,
                AI_PLAYER, fixture.ai.tc_origin, &fixture.ai.villagers, Some(&amounts(&fixture.ai.stockpile)),
            );
        }
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(&node.resource).unwrap();
            spawn_resource_node(&mut sim.movement.world, &econ, node.tile_x, node.tile_y, code, node.amount, None).unwrap();
        }
        let strategy = strategy_by_id(fixture.ai.strategy.as_deref().unwrap_or("fast-castle-knights"));
        sim.ai = Some(AiPlannerSystem::new(strategy, FogHandle::new(fixture.size, 2)));
        {
            // Map-gen fog bootstrap for the AI's own provider.
            let defs = defs();
            let fcomps = crate::fog::FogComps::new(&sim.movement.comps, &bcomps, &CombatComps::from_world(&sim.movement.world));
            let pop = PopComps::from_world(&sim.movement.world);
            sim.ai.as_mut().unwrap().fog.recompute_all(&sim.movement.world, &fcomps, &pop, &defs);
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
        (sim, digests)
    }

    #[test]
    fn m2t9_fast_castle_knights_matches_ts() {
        let (sim, digests) = run_main();
        assert_eq!(digests, snapshot_digests("m2t9"));
        let world = &sim.movement.world;
        let econ = sim.econ;
        let age = AgeComps::from_world(world);
        let bcomps = BuildingComps::from_world(world);
        let defs = defs();
        assert_eq!(current_age_rank(world, &age, AI_PLAYER), 3.0);
        assert_eq!(current_age_rank(world, &age, PLAYER_ONE), 1.0);
        assert_eq!(read_age_advanced(world, &age, &econ, AI_PLAYER), vec![(3930.0, 2.0), (9960.0, 3.0)]);
        let count_def = |def_id: &str| {
            world.rows_by_component[bcomps.building]
                .values()
                .filter(|r| r[0] == AI_PLAYER && defs.building_id_of_code(r[1] as u32) == def_id)
                .count()
        };
        assert_eq!((count_def("barracks"), count_def("stable"), count_def("house")), (1, 1, 2));
        let ccomps = CombatComps::from_world(world);
        let knights = world.rows_by_component[ccomps.combat]
            .values()
            .filter(|r| r[1] == AI_PLAYER && defs.unit_id_of_code(r[0] as u32) == "knight")
            .count();
        assert_eq!(knights, 4);
        assert_eq!(population_cap(world, &bcomps, &defs, Some(AI_PLAYER)), 15);
        assert!(read_gate_rejections(world, &age, &econ, AI_PLAYER).is_empty());
        assert!(stockpile_amounts(world, &econ, AI_PLAYER).iter().all(|v| *v >= 0.0));
        let t = &sim.ai.as_ref().unwrap().telemetry;
        assert_eq!(t.issued_by_kind.get("placeBuilding"), Some(&4));
        assert_eq!(t.issued_by_kind.get("trainVillager"), Some(&7));
        assert_eq!(t.issued_by_kind.get("trainUnit"), Some(&4));
        assert_eq!(t.issued_by_kind.get("researchAge"), Some(&2));
        assert_eq!(t.first_tick_by_kind.get("researchAge"), Some(&30));
        assert_eq!(t.first_tick_by_kind.get("trainUnit"), Some(&9960));
        assert_eq!(t.think_calls, 466);
        assert!(t.attack_drafts.is_empty(), "no vision, no attack");
        assert_eq!(t.gather_drafts, t.gather_drafts_known);
        assert!(t.gather_drafts > 0);
    }

    #[test]
    fn m2t9_mini_attack_trigger_visible_only() {
        let size = 24usize;
        let mut sim = EconomySim::new(77, size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = Layers {
            size,
            terrain: vec![TERRAIN_GRASS; size * size],
            elevation: vec![0; size * size],
            passability: vec![1; size * size],
        };
        sim.combat.group_routes = true;
        let econ = sim.econ;
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        let age = AgeComps::from_world(&sim.movement.world);
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let pop = PopComps::from_world(world);
            let morale = CombatComps::from_world(world).morale;
            setup_ai_opponent(world, comps, &econ, &bcomps, &age, &pop, morale, &traits(), &defs(), layers, paths, AI_PLAYER, (3, 3), &[], None);
        }
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, None).unwrap();
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE).unwrap();
        let house_eid = {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let defs = defs();
            let h = crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &defs, layers, paths, "house", 10, 6, PLAYER_ONE);
            crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &defs, layers, paths, "town-center", 20, 20, PLAYER_ONE);
            h
        };
        let mut knight_ids = Vec::new();
        for (x, y) in [(7.5, 6.5), (7.5, 7.5)] {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            knight_ids.push(spawn_combat_unit(
                world, comps, &ccomps, &pop, &traits(), &defs(), "knight", x, y, AI_PLAYER,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            ));
        }
        let strategy = Strategy {
            id: "attack-only-mini",
            villager_target: 0,
            gather_weights: (1.0, 0.0, 0.0),
            attack_army_threshold: 2,
            steps: vec![attack_step("knight", &[])],
        };
        sim.ai = Some(AiPlannerSystem::new(strategy, FogHandle::new(size, 2)));
        {
            let defs = defs();
            let fcomps = crate::fog::FogComps::new(&sim.movement.comps, &bcomps, &CombatComps::from_world(&sim.movement.world));
            let pop = PopComps::from_world(&sim.movement.world);
            sim.ai.as_mut().unwrap().fog.recompute_all(&sim.movement.world, &fcomps, &pop, &defs);
        }
        let start_tiles: Vec<(f64, f64)> = knight_ids
            .iter()
            .map(|eid| {
                let p = &sim.movement.world.rows_by_component[sim.movement.comps.position][eid];
                (p[0], p[1])
            })
            .collect();
        for _ in 0..240 {
            sim.step();
        }
        let ai = sim.ai.as_ref().unwrap();
        assert_eq!(ai.telemetry.attack_drafts.len(), 1);
        let draft = &ai.telemetry.attack_drafts[0];
        assert!(draft.3, "target visible to AI at draft time");
        assert_eq!(draft.2, 2, "both knights attack");
        assert_eq!(draft.1, house_eid as i64);
        assert!(draft.0 <= PLANNER_CADENCE_TICKS);
        let comps = sim.movement.comps;
        for (i, eid) in knight_ids.iter().enumerate() {
            let p = &sim.movement.world.rows_by_component[comps.position][eid];
            assert!(p[0].floor() > 7.0, "knight marched east: {p:?}");
            let _ = start_tiles[i];
        }
        assert!(sim.combat.diagnostics.strikes > 0);
    }
}

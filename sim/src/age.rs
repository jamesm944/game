//! Age advancement + tech research system (SPEC §2.11 / M2-T4):
//! Rust port of `src/sim/systems/age.ts` + `applyUnitUpgrade` from
//! `systems/upgrades.ts`. researchAge escrows at enqueue on a
//! production building, counts down from the command tick inclusive,
//! promotes AgeState and appends AgeAdvanced on completion;
//! researchTech marks ResearchedTechs and transforms upgraded unit
//! lines in the field, in train queues and in garrisons. Polite
//! gate/prereq refusals ride GateRejected rows; structural errors
//! throw loudly. Civ cost folds are civ-less (definition costs).
use crate::buildings::{
    age_research_row, append_age_advanced, append_gate_rejection, building_row,
    clear_age_research_row, current_age_rank, is_def_age_unlocked, mark_tech_researched,
    pay_costs, read_train_queue, researched_tech_codes, set_age_research_row, set_player_age_rank,
    write_train_queue, AgeComps, BuildingComps, GATE_HANDLER_RESEARCH,
};
use crate::combat::CombatComps;
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::{age_rank, Defs};
use crate::economy::{EconomyComps, PLAYER_ONE};
use crate::movement::MovementComps;
use std::sync::Arc;

pub const RESEARCH_AGE_KIND: &str = "researchAge";
pub const RESEARCH_TECH_KIND: &str = "researchTech";

/// Finished-building minimums per TARGET rank (AoE2 shape).
fn age_building_prereq(target_rank: i64) -> Option<(i64, &'static [&'static str])> {
    match target_rank {
        2 => Some((0, &[])),
        3 => Some((2, &["archery-range", "barracks", "blacksmith", "stable"])),
        4 => Some((2, &["archery-range", "blacksmith", "stable", "watch-tower"])),
        _ => None,
    }
}

fn next_age_tech_id(rank: i64) -> Option<&'static str> {
    match rank {
        1 => Some("feudal-age"),
        2 => Some("castle-age"),
        3 => Some("imperial-age"),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgeDiagnostics {
    pub commands_applied: u64,
    pub advances_completed: u64,
    pub gate_rejections: u64,
}

/// True when the player may enqueue its next advance right now
/// (affordability deliberately excluded — TS canStartAgeAdvance).
pub fn can_start_age_advance(world: &CoreWorld, bcomps: &BuildingComps, age: &AgeComps, defs: &Defs, player_id: f64) -> bool {
    let rank = current_age_rank(world, age, player_id) as i64;
    if next_age_tech_id(rank).is_none() {
        return false;
    }
    for &eid in &world.entities {
        let Some(r) = building_row(world, bcomps, eid) else { continue };
        if r[0] != player_id {
            continue;
        }
        if defs.building(defs.building_id_of_code(r[1] as u32)).train_queue.is_none() {
            continue;
        }
        if age_research_row(world, age, eid).is_some() {
            return false;
        }
    }
    if let Some((min_count, def_ids)) = age_building_prereq(rank + 1) {
        if count_finished_prereqs(world, bcomps, defs, player_id, def_ids) < min_count {
            return false;
        }
    }
    true
}

fn count_finished_prereqs(world: &CoreWorld, bcomps: &BuildingComps, defs: &Defs, player_id: f64, def_ids: &[&str]) -> i64 {
    let mut count = 0;
    for &eid in &world.entities {
        let Some(r) = building_row(world, bcomps, eid) else { continue };
        if r[0] != player_id {
            continue;
        }
        if def_ids.contains(&defs.building_id_of_code(r[1] as u32)) {
            count += 1;
        }
    }
    count
}

fn production_buildings(world: &CoreWorld, bcomps: &BuildingComps, defs: &Defs, player_id: f64) -> Vec<Eid> {
    let mut out = Vec::new();
    for &eid in &world.entities {
        let Some(r) = building_row(world, bcomps, eid) else { continue };
        if r[0] != player_id {
            continue;
        }
        if defs.building(defs.building_id_of_code(r[1] as u32)).train_queue.is_none() {
            continue;
        }
        out.push(eid);
    }
    out
}

fn player_of(data: &serde_json::Value) -> f64 {
    let p = data.get("playerId").and_then(|v| v.as_f64()).unwrap_or(PLAYER_ONE);
    assert!(p >= 0.0 && p.fract() == 0.0, "research playerId must be a non-negative integer");
    p
}

pub struct AgeSystem {
    defs: Arc<Defs>,
    bcomps: BuildingComps,
    ccomps: CombatComps,
    age: AgeComps,
    pub diagnostics: AgeDiagnostics,
}

impl AgeSystem {
    pub fn new(defs: Arc<Defs>, bcomps: BuildingComps, ccomps: CombatComps, age: AgeComps) -> AgeSystem {
        AgeSystem { defs, bcomps, ccomps, age, diagnostics: AgeDiagnostics::default() }
    }

    fn reject(&mut self, world: &mut CoreWorld, econ: &EconomyComps, player_id: f64, tech_id: &str) {
        append_gate_rejection(
            world,
            &self.age,
            econ,
            player_id,
            world.tick,
            GATE_HANDLER_RESEARCH,
            self.defs.tech_code(tech_id) as f64,
        );
        self.diagnostics.gate_rejections += 1;
    }

    fn apply_research_age(&mut self, world: &mut CoreWorld, econ: &EconomyComps, data: &serde_json::Value) {
        let player_id = player_of(data);
        let tech_id = match data.get("techId") {
            Some(v) => v.as_str().filter(|s| !s.is_empty()).expect("researchAge techId must be a non-empty string").to_string(),
            None => {
                let rank = current_age_rank(world, &self.age, player_id) as i64;
                next_age_tech_id(rank)
                    .unwrap_or_else(|| panic!("researchAge has no advance beyond rank {rank}"))
                    .to_string()
            }
        };
        let site_eid = match data.get("siteEid") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(
                v.as_f64()
                    .filter(|n| n.fract() == 0.0 && *n >= 1.0)
                    .map(|n| n as Eid)
                    .unwrap_or_else(|| panic!("researchAge siteEid must be a positive integer, got {v}")),
            ),
        };
        let tech = self.defs.tech(&tech_id).clone();
        let advance = tech.age_advance.unwrap_or_else(|| panic!("researchAge targets age advances only: {}", tech.id));
        let rank = current_age_rank(world, &self.age, player_id);
        if age_rank(&tech.age_gate) as f64 != rank {
            self.reject(world, econ, player_id, &tech.id);
            return;
        }
        if let Some((min_count, def_ids)) = age_building_prereq(advance) {
            if count_finished_prereqs(world, &self.bcomps, &self.defs, player_id, def_ids) < min_count {
                self.reject(world, econ, player_id, &tech.id);
                return;
            }
        }
        let buildings = production_buildings(world, &self.bcomps, &self.defs, player_id);
        let target = match site_eid {
            Some(site) => buildings.iter().copied().find(|&e| e == site),
            None => buildings.first().copied(),
        };
        let Some(target) = target else {
            panic!(
                "{}",
                match site_eid {
                    Some(site) => format!("researchAge targets entity {site}, which is not a finished production building"),
                    None => "researchAge requires a finished production building (none exists)".to_string(),
                }
            );
        };
        if age_research_row(world, &self.age, target).is_some() {
            let def_id = self.defs.building_id_of_code(building_row(world, &self.bcomps, target).unwrap()[1] as u32);
            panic!("{def_id} is already researching");
        }
        pay_costs(world, econ, player_id, &tech.costs, &format!("researching {}", tech.id))
            .unwrap_or_else(|e| panic!("{e}"));
        set_age_research_row(world, &self.age, target, player_id, self.defs.tech_code(&tech.id) as f64, tech.research_time as f64);
        self.diagnostics.commands_applied += 1;
    }

    fn apply_research_tech(&mut self, world: &mut CoreWorld, econ: &EconomyComps, data: &serde_json::Value) {
        let player_id = player_of(data);
        let tech_id = data
            .get("techId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .expect("researchTech techId must be a non-empty string")
            .to_string();
        let site_eid = data
            .get("siteEid")
            .and_then(|v| v.as_f64())
            .filter(|n| n.fract() == 0.0 && *n >= 1.0)
            .map(|n| n as Eid)
            .unwrap_or_else(|| panic!("researchTech siteEid must be a positive integer"));
        let tech = self.defs.tech(&tech_id).clone();
        let building = building_row(world, &self.bcomps, site_eid).cloned().unwrap_or_else(|| {
            panic!("researchTech targets entity {site_eid}, which is not a finished building")
        });
        if building[0] != player_id {
            panic!("player {player_id} does not own building {site_eid}");
        }
        let building_def_id = self.defs.building_id_of_code(building[1] as u32).to_string();
        if let Some(host) = &tech.building_id {
            if host != &building_def_id {
                panic!("tech {} must be researched at {host}, not {building_def_id}", tech.id);
            }
        }
        let researched = researched_tech_codes(world, &self.age, econ, player_id);
        if researched.contains(&(self.defs.tech_code(&tech.id) as i64)) {
            panic!("tech {} is already researched by player {player_id}", tech.id);
        }
        if !is_def_age_unlocked(world, &self.age, player_id, &tech.age_gate) {
            self.reject(world, econ, player_id, &tech.id);
            return;
        }
        for prereq in &tech.tech_prereqs {
            if !researched.contains(&(self.defs.tech_code(prereq) as i64)) {
                self.reject(world, econ, player_id, &tech.id);
                return;
            }
        }
        if age_research_row(world, &self.age, site_eid).is_some() {
            panic!("{building_def_id} is already researching");
        }
        pay_costs(world, econ, player_id, &tech.costs, &format!("researching {}", tech.id))
            .unwrap_or_else(|e| panic!("{e}"));
        set_age_research_row(world, &self.age, site_eid, player_id, self.defs.tech_code(&tech.id) as f64, tech.research_time as f64);
        self.diagnostics.commands_applied += 1;
    }

    /// TS applyUnitUpgrade: transform field units, queued entries and
    /// garrisoned units of one line, hp bonus clamped at the new cap.
    fn apply_unit_upgrade(&self, world: &mut CoreWorld, comps: &MovementComps, player_id: f64, from_id: &str, to_id: &str) {
        let from_code = self.defs.unit_code(from_id) as f64;
        let to_code = self.defs.unit_code(to_id) as f64;
        let from_def = self.defs.unit(from_id).clone();
        let to_def = self.defs.unit(to_id).clone();
        let hp_bonus = (to_def.hp - from_def.hp).max(0) as f64;
        // 1. Field units.
        let combat_eids: Vec<Eid> = world.rows_by_component[self.ccomps.combat].keys().copied().collect();
        for eid in combat_eids {
            let matches = {
                let r = &world.rows_by_component[self.ccomps.combat][&eid];
                r[1] == player_id && r[0] == from_code
            };
            if !matches {
                continue;
            }
            {
                let r = world.rows_by_component.get_mut(self.ccomps.combat).unwrap().get_mut(&eid).unwrap();
                r[0] = to_code;
                r[2] = (r[2] + hp_bonus).min(to_def.hp as f64);
            }
            if let Some(tag) = world.rows_by_component.get_mut(comps.unit_tag).and_then(|rows| rows.get_mut(&eid)) {
                tag[0] = to_def.speed;
            }
        }
        // 2. Train queues of this player's buildings.
        let building_eids: Vec<Eid> = world.rows_by_component[self.bcomps.building].keys().copied().collect();
        for eid in building_eids {
            if building_row(world, &self.bcomps, eid).map(|r| r[0]) != Some(player_id) {
                continue;
            }
            let mut queue = read_train_queue(world, &self.bcomps, eid);
            let mut modified = false;
            for entry in queue.iter_mut() {
                if entry.unit_code == from_code {
                    entry.unit_code = to_code;
                    modified = true;
                }
            }
            if modified {
                write_train_queue(world, &self.bcomps, eid, &queue);
            }
        }
        // 3. Garrisons: [count, (unitCode, owner, hp, maxHp, stance)×n].
        for rows in world.rows_by_component.get_mut(self.bcomps.garrison).into_iter() {
            for r in rows.values_mut() {
                let count = r[0] as usize;
                for i in 0..count {
                    let base = 1 + i * 5;
                    if r[base + 1] == player_id && r[base] == from_code {
                        r[base] = to_code;
                        r[base + 2] = (r[base + 2] + hp_bonus).min(to_def.hp as f64);
                        r[base + 3] = to_def.hp as f64;
                    }
                }
            }
        }
    }

    pub fn run(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, commands: &[Command]) {
        for command in commands {
            match command.kind.as_str() {
                RESEARCH_AGE_KIND => {
                    let data = command.data.as_ref().expect("researchAge requires command data");
                    self.apply_research_age(world, econ, data);
                }
                RESEARCH_TECH_KIND => {
                    let data = command.data.as_ref().expect("researchTech requires command data");
                    self.apply_research_tech(world, econ, data);
                }
                _ => {}
            }
        }
        // Countdown ascending eid; enqueue tick counts as first tick.
        let research_eids: Vec<Eid> = world.rows_by_component[self.age.age_research].keys().copied().collect();
        for eid in research_eids {
            if building_row(world, &self.bcomps, eid).is_none() {
                continue; // host lost: freeze
            }
            let (player_id, tech_code, new_remaining) = {
                let r = world.rows_by_component.get_mut(self.age.age_research).unwrap().get_mut(&eid).expect("research row");
                r[2] -= 1.0;
                (r[0], r[1], r[2])
            };
            if new_remaining > 0.0 {
                continue;
            }
            let tech = self.defs.tech(self.defs.tech_id_of_code(tech_code as u32)).clone();
            clear_age_research_row(world, &self.age, eid);
            if let Some(advance) = tech.age_advance {
                set_player_age_rank(world, &self.age, econ, player_id, advance as f64);
                append_age_advanced(world, &self.age, econ, player_id, world.tick, advance as f64);
            } else {
                mark_tech_researched(world, &self.age, econ, player_id, tech_code);
                if let Some(upgrade) = &tech.unit_upgrade {
                    self.apply_unit_upgrade(world, comps, player_id, &upgrade.from_unit_id.clone(), &upgrade.to_unit_id.clone());
                }
            }
            self.diagnostics.advances_completed += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{
        building_row, building_site_row, create_player_age_state, current_age_rank, population,
        population_cap, read_age_advanced, read_gate_rejections, BuildingComps, GATE_HANDLER_PLACE,
        GATE_HANDLER_TRAIN,
    };
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
        #[serde(rename = "ageState", default)]
        age_state: bool,
        stockpile: std::collections::BTreeMap<String, f64>,
        spawns: Vec<FixtureSpawn>,
        buildings: Vec<FixtureBuilding>,
        commands: Vec<FixtureCommand>,
    }

    #[test]
    fn m2t4_age_ladder_matches_ts_snapshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t4/case.json");
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
        let age = AgeComps::from_world(&sim.movement.world);
        if fixture.age_state {
            create_player_age_state(&mut sim.movement.world, &age, &econ, PLAYER_ONE);
        }
        {
            let bcomps = BuildingComps::from_world(&sim.movement.world);
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
        // Expected digests from the TS snapshot.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t4/__snapshots__");
        let mut text = String::new();
        for entry in std::fs::read_dir(dir).expect("snapshot dir") {
            let p = entry.expect("entry").path();
            if p.extension().map(|e| e == "snap").unwrap_or(false) {
                text.push_str(&std::fs::read_to_string(p).expect("read snap"));
            }
        }
        let mut expected = Vec::new();
        let mut rest = text.as_str();
        while let Some(i) = rest.find("fnv1a64:") {
            let digest = rest[i..i + 24].to_string();
            let after = &rest[i..];
            let tick_at = after.find("\"tick\":").expect("tick after digest");
            let num: String = after[tick_at + 7..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
            expected.push((num.parse::<u64>().expect("tick"), digest));
            rest = &rest[i + 24..];
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
        assert_eq!(digests, expected);

        let world = &sim.movement.world;
        let comps = sim.movement.comps;
        let bcomps = BuildingComps::from_world(world);
        let defs = defs();
        assert_eq!(
            read_gate_rejections(world, &age, &econ, PLAYER_ONE),
            vec![
                (1.0, GATE_HANDLER_PLACE, defs.building_code("blacksmith") as f64),
                (2.0, GATE_HANDLER_TRAIN, defs.unit_code("scout-cavalry") as f64),
            ]
        );
        assert_eq!(
            read_age_advanced(world, &age, &econ, PLAYER_ONE),
            vec![(3902.0, 2.0), (9599.0, 3.0), (14799.0, 4.0)]
        );
        assert_eq!(current_age_rank(world, &age, PLAYER_ONE), 4.0);
        assert_eq!(stockpile_amounts(world, &econ, PLAYER_ONE), vec![1620.0, 1700.0, 500.0, 200.0, 0.0, 0.0, 0.0]);
        assert_eq!(commodity_amounts(world, &econ, PLAYER_ONE), vec![0.0; 6]);
        assert_eq!(population(world, &comps, &bcomps, None), 7);
        assert_eq!(population_cap(world, &bcomps, &defs, None), 10);
        let (mut finished, mut pending) = (0, 0);
        for &eid in &world.entities {
            if building_row(world, &bcomps, eid).is_some() {
                finished += 1;
            }
            if building_site_row(world, &bcomps, eid).is_some() {
                pending += 1;
            }
        }
        assert_eq!((finished, pending), (5, 0));
        assert_eq!(sim.age.diagnostics.advances_completed, 3);
    }
}

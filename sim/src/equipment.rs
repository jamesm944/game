//! Equipment system (SPEC §2.5 / M2-T6): Rust port of
//! `src/sim/systems/equipment.ts`. Forge Weapons/Armor commodities
//! leave the owner's commodity ledger and attach onto targeted
//! combatants as Equipment rows ([weapons, armor]); combat stats fold
//! the counts into derived attack/armor on every read. Whole orders
//! validate then debit atomically.
use crate::combat::{combat_row, CombatAuxComps, CombatComps};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::economy::{debit_ledger_slugs, EconomyComps, LedgerEntry, PLAYER_ONE};
use std::sync::Arc;

pub const EQUIP_KIND: &str = "equip";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EquipmentDiagnostics {
    pub commands_applied: u64,
    pub items_equipped: u64,
}

pub struct EquipmentSystem {
    defs: Arc<Defs>,
    ccomps: CombatComps,
    aux: CombatAuxComps,
    pub diagnostics: EquipmentDiagnostics,
}

impl EquipmentSystem {
    pub fn new(defs: Arc<Defs>, ccomps: CombatComps, aux: CombatAuxComps) -> EquipmentSystem {
        EquipmentSystem { defs, ccomps, aux, diagnostics: EquipmentDiagnostics::default() }
    }

    pub fn run(&mut self, world: &mut CoreWorld, econ: &EconomyComps, commands: &[Command]) {
        for command in commands {
            if command.kind != EQUIP_KIND {
                continue;
            }
            let data = command.data.as_ref().expect("equip requires command data");
            self.apply_equip(world, econ, data);
        }
    }

    fn apply_equip(&mut self, world: &mut CoreWorld, econ: &EconomyComps, data: &serde_json::Value) {
        let raw_ids = data.get("unitIds").and_then(|v| v.as_array());
        let raw_ids = raw_ids.filter(|a| !a.is_empty()).expect("equip requires a non-empty unitIds array");
        let mut unit_ids: Vec<Eid> = Vec::new();
        for entry in raw_ids {
            let id = entry
                .as_f64()
                .filter(|v| v.fract() == 0.0 && *v >= 1.0)
                .map(|v| v as Eid)
                .unwrap_or_else(|| panic!("equip unitIds entries must be positive integers, got {entry}"));
            if !unit_ids.contains(&id) {
                unit_ids.push(id);
            }
        }
        unit_ids.sort();
        let item = data.get("item").and_then(|v| v.as_str()).unwrap_or("");
        assert!(item == "weapon" || item == "armor", "equip item must be \"weapon\" or \"armor\", got {item:?}");
        let player_id = data.get("playerId").and_then(|v| v.as_f64()).unwrap_or(PLAYER_ONE);
        assert!(player_id >= 0.0 && player_id.fract() == 0.0, "equip playerId must be a non-negative integer");

        for &eid in &unit_ids {
            let Some(cr) = combat_row(world, &self.ccomps, eid) else {
                panic!("equip targets entity {eid}, which has no Combat row");
            };
            let def = self.defs.unit(self.defs.unit_id_of_code(cr[0] as u32));
            assert!(
                def.equipment_slots.iter().any(|s| s == item),
                "unit {} has no {item} equipment slot",
                def.id
            );
        }
        let slug = if item == "weapon" { "weapons" } else { "armor" };
        debit_ledger_slugs(
            world,
            econ,
            player_id,
            &[LedgerEntry { def_id: slug.to_string(), qty: unit_ids.len() as f64 }],
            &format!("equipping {}x {slug}", unit_ids.len()),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        for &eid in &unit_ids {
            let rows = world.rows_by_component.get_mut(self.aux.equipment).expect("registered component");
            let r = rows.entry(eid).or_insert_with(|| vec![0.0, 0.0]);
            if item == "weapon" {
                r[0] += 1.0;
            } else {
                r[1] += 1.0;
            }
            self.diagnostics.items_equipped += 1;
        }
        self.diagnostics.commands_applied += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{set_player_age_rank, AgeComps, BuildingComps};
    use crate::combat::{combat_row, spawn_combat_unit, CombatComps, SpawnCombatOptions};
    use crate::economy::{
        commodity_amounts, create_commodity_stockpile, create_player_stockpile, deposit_commodity,
        stockpile_amounts,
    };
    use crate::gather::EconomySim;
    use crate::mapgen::{Layers, TERRAIN_GRASS};
    use crate::path::Transport;
    use crate::pop::{PopComps, TraitsData};
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
    struct Spawn {
        eid: i64,
        #[serde(rename = "defId")]
        def_id: String,
        #[serde(rename = "playerId")]
        player_id: f64,
        x: f64,
        y: f64,
    }
    #[derive(Deserialize)]
    struct Stock {
        // m2t6 fixtures pin ledger eids; m2t7 leaves them sequential.
        #[serde(default)]
        eid: Option<i64>,
        #[serde(rename = "playerId")]
        player_id: f64,
        resources: Vec<f64>,
        #[serde(default)]
        commodities: Option<std::collections::BTreeMap<String, i64>>,
        #[serde(rename = "ageRank", default)]
        age_rank: Option<f64>,
    }
    #[derive(Deserialize)]
    struct Building {
        eid: i64,
        #[serde(rename = "defId")]
        def_id: String,
        #[serde(rename = "tileX")]
        tile_x: i64,
        #[serde(rename = "tileY")]
        tile_y: i64,
        #[serde(rename = "playerId")]
        player_id: f64,
    }
    #[derive(Deserialize)]
    struct Cmd {
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
        spawns: Vec<Spawn>,
        stockpiles: Vec<Stock>,
        buildings: Vec<Building>,
        commands: Vec<Cmd>,
    }

    #[test]
    fn m2t6_equipment_training_formation_march_matches_ts() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t6/case.json");
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
        for spawn in &fixture.spawns {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            let eid = spawn_combat_unit(
                world,
                comps,
                &ccomps,
                &pop,
                &traits(),
                &defs(),
                &spawn.def_id,
                spawn.x,
                spawn.y,
                spawn.player_id,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
            assert_eq!(eid as i64, spawn.eid, "spawn order");
        }
        let age = AgeComps::from_world(&sim.movement.world);
        for stock in &fixture.stockpiles {
            let eid = create_player_stockpile(&mut sim.movement.world, &econ, stock.player_id, Some(&stock.resources)).unwrap();
            if let Some(expected) = stock.eid {
                assert_eq!(eid as i64, expected, "ledger order");
            }
            if let Some(commodities) = &stock.commodities {
                create_commodity_stockpile(&mut sim.movement.world, &econ, stock.player_id).unwrap();
                for (slug, qty) in commodities {
                    let code = if slug == "weapons" { 3 } else { 4 };
                    for _ in 0..*qty {
                        deposit_commodity(&mut sim.movement.world, &econ, stock.player_id, code, 1.0).unwrap();
                    }
                }
            }
            if let Some(rank) = stock.age_rank {
                set_player_age_rank(&mut sim.movement.world, &age, &econ, stock.player_id, rank);
            }
        }
        {
            let bcomps = BuildingComps::from_world(&sim.movement.world);
            let defs = defs();
            for building in &fixture.buildings {
                let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
                let eid = crate::placement::stamp_finished_building(
                    world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                    &building.def_id, building.tile_x, building.tile_y, building.player_id,
                );
                assert_eq!(eid as i64, building.eid, "building order");
            }
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        // Snapshot digests.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t6/__snapshots__");
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

        assert_eq!((sim.equipment.diagnostics.commands_applied, sim.equipment.diagnostics.items_equipped), (2, 2));
        let world = &sim.movement.world;
        let aux = CombatAuxComps::from_world(world);
        let eq = &world.rows_by_component[aux.equipment][&1];
        assert_eq!(eq, &vec![1.0, 1.0]);
        let commodities = commodity_amounts(world, &econ, 0.0);
        assert_eq!(commodities[3], 1.0, "weapons left");
        assert_eq!(commodities[4], 0.0, "armor left");
        let resources = stockpile_amounts(world, &econ, 0.0);
        assert_eq!((resources[1], resources[2]), (175.0, 155.0));
        assert_eq!(sim.training.diagnostics.units_trained, 1);
        let ccomps = CombatComps::from_world(world);
        let archer = combat_row(world, &ccomps, 7).expect("trained archer row");
        assert_eq!(defs().unit_id_of_code(archer[0] as u32), "archer");
        let diag = &sim.combat.diagnostics;
        assert_eq!((diag.attack_move_commands, diag.kills, diag.retaliations), (1, 1, 1));
        assert!((1..=2).contains(&diag.aggro_acquisitions));
        assert!(!world.entities.contains(&2), "scout died");
        // March resumed to the destination (tolerance mirrors TS).
        let comps = sim.movement.comps;
        let militia = &world.rows_by_component[comps.position][&1];
        assert!((militia[0] - 20.5).abs() < 0.75 && (militia[1] - 11.5).abs() < 0.75, "militia arrived: {militia:?}");
    }

    #[derive(Deserialize)]
    struct Fixture7 {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        raider: serde_json::Value,
        villagers: Vec<serde_json::Value>,
        nodes: Vec<serde_json::Value>,
        buildings: Vec<Building7>,
        stockpiles: Vec<Stock>,
        commands: Vec<Cmd>,
    }
    #[derive(Deserialize)]
    struct Building7 {
        eid: i64,
        #[serde(rename = "defId")]
        def_id: String,
        #[serde(rename = "tileX")]
        tile_x: i64,
        #[serde(rename = "tileY")]
        tile_y: i64,
        #[serde(rename = "playerId")]
        player_id: f64,
        hp: Option<f64>,
    }

    #[test]
    fn m2t7_raid_destruction_matches_ts() {
        use crate::buildings::building_row;
        use crate::economy::{inventory, resource_node_row, spawn_resource_node};
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t7/case.json");
        let fixture: Fixture7 = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = Layers {
            size: fixture.size,
            terrain: vec![TERRAIN_GRASS; fixture.size * fixture.size],
            elevation: vec![0; fixture.size * fixture.size],
            passability: vec![1; fixture.size * fixture.size],
        };
        sim.combat.group_routes = true;
        let econ = sim.econ;
        {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            let eid = spawn_combat_unit(
                world, comps, &ccomps, &pop, &traits(), &defs(), "militia",
                fixture.raider["x"].as_f64().unwrap(), fixture.raider["y"].as_f64().unwrap(), 0.0,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
            assert_eq!(eid, 1);
        }
        for v in &fixture.villagers {
            let eid = sim.spawn_unit(v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap());
            assert_eq!(eid as i64, v["eid"].as_i64().unwrap());
        }
        for stock in &fixture.stockpiles {
            create_player_stockpile(&mut sim.movement.world, &econ, stock.player_id, Some(&stock.resources)).unwrap();
            if let Some(commodities) = &stock.commodities {
                create_commodity_stockpile(&mut sim.movement.world, &econ, stock.player_id).unwrap();
                for (slug, qty) in commodities {
                    let code = if slug == "weapons" { 3 } else { 4 };
                    for _ in 0..*qty {
                        deposit_commodity(&mut sim.movement.world, &econ, stock.player_id, code, 1.0).unwrap();
                    }
                }
            }
        }
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(node["resource"].as_str().unwrap()).unwrap();
            let eid = spawn_resource_node(
                &mut sim.movement.world,
                &econ,
                node["tileX"].as_i64().unwrap(),
                node["tileY"].as_i64().unwrap(),
                code,
                node["amount"].as_i64().unwrap(),
                None,
            )
            .unwrap();
            assert_eq!(eid as i64, node["eid"].as_i64().unwrap());
        }
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        {
            let age = AgeComps::from_world(&sim.movement.world);
            let defs = defs();
            for building in &fixture.buildings {
                let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
                let eid = crate::placement::stamp_finished_building(
                    world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                    &building.def_id, building.tile_x, building.tile_y, building.player_id,
                );
                assert_eq!(eid as i64, building.eid);
                if let Some(hp) = building.hp {
                    world.rows_by_component.get_mut(bcomps.building).unwrap().get_mut(&eid).unwrap()[4] = hp;
                }
            }
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let setup_version = sim.movement.paths.passability_version();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t7/__snapshots__");
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

        let diag = &sim.combat.diagnostics;
        assert_eq!((diag.attack_commands, diag.buildings_destroyed, diag.kills), (1, 1, 0));
        let world = &sim.movement.world;
        assert!(building_row(world, &bcomps, 8).is_none(), "camp destroyed");
        let rubble = &world.rows_by_component[bcomps.rubble][&11];
        assert_eq!(rubble, &vec![24.0, 18.0, 2.0, 2.0]);
        let size = sim.movement.layers.size;
        for dy in 0..2 {
            for dx in 0..2 {
                assert_eq!(sim.movement.layers.passability[(18 + dy) * size + (24 + dx)], 1, "camp tiles passable");
            }
        }
        assert_eq!(sim.movement.paths.passability_version(), setup_version + 1);
        assert_eq!(sim.gather.diagnostics.destroyed_dropoff_reroutes, 2);
        assert_eq!(sim.gather.diagnostics.blocked_carry_ticks, 0);
        let g = &sim.gather.diagnostics;
        let mut carried = 0.0;
        for v in &fixture.villagers {
            if let Some((code, amount)) = inventory(world, &econ, v["eid"].as_i64().unwrap() as crate::core::Eid) {
                if code == 1.0 {
                    carried += amount;
                }
            }
        }
        assert_eq!(g.extracted_by_resource[1], g.deposited_by_resource[1] + carried);
        let remaining = resource_node_row(world, &econ, 7).expect("node")[1];
        assert_eq!(4000.0 - remaining, g.extracted_by_resource[1]);
        assert!(g.deposited_by_resource[1] >= 30.0);
    }
}

//! Building components + definition-cost payment + age-gate helpers:
//! Rust port of `src/sim/components/buildings.ts`,
//! `src/sim/systems/costs.ts`, and the age read paths of
//! `src/sim/components/age.ts` / `systems/age.ts`.
//!
//! Row layouts are digest contract:
//! - AssignedSite (1): [siteEid]
//! - Building (5): [owner, defCode, originTileX, originTileY, hp]
//! - BuildingSite (4): [owner, defCode, progressMilliTicks, hp]
//! - TrainQueue (variable): [count, unitCode, remainingTicks, …]
//! - Rubble (4): [originTileX, originTileY, widthTiles, heightTiles]
//! - AgeState (2): [owner, ageRank]; GateRejected (count-led triples)
//!
//! Civ bonuses (buildingMaxHp, effectiveCosts, populationCap) read
//! `world.civilizations` in TS; no Rust world carries a civ registry
//! yet, so every fold takes the civ-less value — identical to TS
//! worlds without civilizations configured.
use crate::core::{Eid, World as CoreWorld};
use crate::defs::{age_rank, Costs, Defs};
use crate::economy::{accepted_resource_mask, resource_code_of_slug, EconomyComps};
use crate::movement::MovementComps;
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
pub struct BuildingComps {
    pub assigned_site: usize,
    pub building: usize,
    pub building_site: usize,
    pub rubble: usize,
    pub train_queue: usize,
    pub garrison: usize,
}

#[derive(Clone, Copy)]
pub struct AgeComps {
    pub age_state: usize,
    pub gate_rejected: usize,
    pub researched_techs: usize,
}

fn id_of(world: &CoreWorld, name: &str) -> usize {
    world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"))
}

impl BuildingComps {
    pub fn from_world(world: &CoreWorld) -> BuildingComps {
        BuildingComps {
            assigned_site: id_of(world, "AssignedSite"),
            building: id_of(world, "Building"),
            building_site: id_of(world, "BuildingSite"),
            rubble: id_of(world, "Rubble"),
            train_queue: id_of(world, "TrainQueue"),
            garrison: id_of(world, "Garrison"),
        }
    }
}

impl AgeComps {
    pub fn from_world(world: &CoreWorld) -> AgeComps {
        AgeComps {
            age_state: id_of(world, "AgeState"),
            gate_rejected: id_of(world, "GateRejected"),
            researched_techs: id_of(world, "ResearchedTechs"),
        }
    }
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}
fn rows(world: &CoreWorld, component: usize) -> &BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get(component).expect("registered component")
}
fn rows_mut(world: &mut CoreWorld, component: usize) -> &mut BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get_mut(component).expect("registered component")
}
fn set_row(world: &mut CoreWorld, component: usize, eid: Eid, values: &[f64]) {
    world.set_values(component, eid, values).expect("registered component");
}

// ---- footprint geometry ------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FootprintRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn footprint_tiles(origin_x: i64, origin_y: i64, width: i64, height: i64) -> Vec<(i64, i64)> {
    let mut tiles = Vec::new();
    for dy in 0..height {
        for dx in 0..width {
            tiles.push((origin_x + dx, origin_y + dy));
        }
    }
    tiles
}

pub fn rects_overlap(a: &FootprintRect, b: &FootprintRect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn rect_of(world: &CoreWorld, comps: &MovementComps, defs: &Defs, def_code: f64, eid: Eid) -> Option<FootprintRect> {
    let pos = row(world, comps.position, eid)?;
    let def = defs.building(defs.building_id_of_code(def_code as u32));
    Some(FootprintRect {
        x: pos[0] - def.footprint.width as f64 / 2.0,
        y: pos[1] - def.footprint.height as f64 / 2.0,
        width: def.footprint.width as f64,
        height: def.footprint.height as f64,
    })
}

pub fn building_rect(world: &CoreWorld, comps: &MovementComps, bcomps: &BuildingComps, defs: &Defs, eid: Eid) -> Option<FootprintRect> {
    let r = row(world, bcomps.building, eid)?;
    rect_of(world, comps, defs, r[1], eid)
}

pub fn site_rect(world: &CoreWorld, comps: &MovementComps, bcomps: &BuildingComps, defs: &Defs, eid: Eid) -> Option<FootprintRect> {
    let r = row(world, bcomps.building_site, eid)?;
    rect_of(world, comps, defs, r[1], eid)
}

// ---- sites & finished buildings ------------------------------------------------------

pub fn building_row<'a>(world: &'a CoreWorld, bcomps: &BuildingComps, eid: Eid) -> Option<&'a Vec<f64>> {
    row(world, bcomps.building, eid)
}
pub fn building_site_row<'a>(world: &'a CoreWorld, bcomps: &BuildingComps, eid: Eid) -> Option<&'a Vec<f64>> {
    row(world, bcomps.building_site, eid)
}

/// Spawn one construction-site entity centered on its footprint.
pub fn spawn_building_site(
    world: &mut CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    defs: &Defs,
    def_id: &str,
    tile_x: i64,
    tile_y: i64,
    player_id: f64,
) -> Eid {
    let def = defs.building(def_id);
    let eid = world.spawn();
    set_row(
        world,
        comps.position,
        eid,
        &[tile_x as f64 + def.footprint.width as f64 / 2.0, tile_y as f64 + def.footprint.height as f64 / 2.0],
    );
    set_row(
        world,
        bcomps.building_site,
        eid,
        &[player_id, defs.building_code(def_id) as f64, 0.0, def.hp as f64],
    );
    eid
}

pub struct CompletedBuilding {
    pub eid: Eid,
    pub player_id: f64,
    pub def_id: String,
}

/// Swap a site into its finished building on the same entity id;
/// drop-off filters activate, farms become food nodes. No passability
/// change (sites blocked their tiles at placement).
pub fn complete_building(
    world: &mut CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    econ: &EconomyComps,
    defs: &Defs,
    site_eid: Eid,
) -> CompletedBuilding {
    let site = row(world, bcomps.building_site, site_eid)
        .cloned()
        .unwrap_or_else(|| panic!("entity {site_eid} has no BuildingSite row"));
    let (player_id, def_code) = (site[0], site[1]);
    let carried_hp = (site[3].floor()).max(1.0);
    let def_id = defs.building_id_of_code(def_code as u32).to_string();
    let def = defs.building(&def_id);
    rows_mut(world, bcomps.building_site).remove(&site_eid);
    let pos = row(world, comps.position, site_eid)
        .cloned()
        .unwrap_or_else(|| panic!("entity {site_eid} has no Position row"));
    let origin_x = pos[0] - def.footprint.width as f64 / 2.0;
    let origin_y = pos[1] - def.footprint.height as f64 / 2.0;
    let hp = carried_hp.min(def.hp as f64);
    set_row(world, bcomps.building, site_eid, &[player_id, def_code, origin_x, origin_y, hp]);
    if !def.dropoff_filters.is_empty() {
        let codes: Vec<i64> = def
            .dropoff_filters
            .iter()
            .map(|slug| {
                resource_code_of_slug(slug)
                    .unwrap_or_else(|| panic!("building {def_id}: unknown dropoffFilters slug {slug:?}"))
            })
            .collect();
        let mask = accepted_resource_mask(&codes).expect("dropoff mask");
        set_row(world, econ.drop_off, site_eid, &[player_id, mask]);
    }
    if def_id == "farm" {
        set_row(world, econ.resource_node, site_eid, &[0.0, 175.0, def.work_slots as f64]);
    }
    CompletedBuilding { eid: site_eid, player_id, def_id }
}

/// Spawn rubble over a destroyed structure's footprint.
pub fn spawn_rubble(
    world: &mut CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    defs: &Defs,
    def_code: f64,
    origin_x: f64,
    origin_y: f64,
) -> Eid {
    let def = defs.building(defs.building_id_of_code(def_code as u32));
    let (w, h) = (def.footprint.width as f64, def.footprint.height as f64);
    let eid = world.spawn();
    set_row(world, comps.position, eid, &[origin_x + w / 2.0, origin_y + h / 2.0]);
    set_row(world, bcomps.rubble, eid, &[origin_x, origin_y, w, h]);
    eid
}

// ---- assignment -------------------------------------------------------------------------

pub fn assign_site(world: &mut CoreWorld, bcomps: &BuildingComps, worker: Eid, site: Eid) {
    assert!(site >= 1, "construction site entity id must be a positive integer, got {site}");
    set_row(world, bcomps.assigned_site, worker, &[site as f64]);
}
pub fn assigned_site(world: &CoreWorld, bcomps: &BuildingComps, worker: Eid) -> Option<Eid> {
    row(world, bcomps.assigned_site, worker).map(|r| r[0] as Eid)
}
pub fn clear_assigned_site(world: &mut CoreWorld, bcomps: &BuildingComps, worker: Eid) -> bool {
    rows_mut(world, bcomps.assigned_site).remove(&worker).is_some()
}

// ---- train queue --------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrainQueueEntry {
    pub unit_code: f64,
    pub remaining_ticks: f64,
}

pub fn read_train_queue(world: &CoreWorld, bcomps: &BuildingComps, eid: Eid) -> Vec<TrainQueueEntry> {
    let Some(r) = row(world, bcomps.train_queue, eid) else { return Vec::new() };
    let count = r[0] as usize;
    (0..count)
        .map(|i| TrainQueueEntry { unit_code: r[1 + i * 2], remaining_ticks: r[2 + i * 2] })
        .collect()
}

pub fn write_train_queue(world: &mut CoreWorld, bcomps: &BuildingComps, eid: Eid, entries: &[TrainQueueEntry]) {
    let mut r = vec![entries.len() as f64];
    for e in entries {
        r.push(e.unit_code);
        r.push(e.remaining_ticks);
    }
    set_row(world, bcomps.train_queue, eid, &r);
}

// ---- population ------------------------------------------------------------------------------

fn owner_of(world: &CoreWorld, owner_component: usize, eid: Eid) -> f64 {
    row(world, owner_component, eid).map(|r| r[0]).unwrap_or(0.0)
}

/// Live population: UnitTag rows (+ garrisoned units), optionally
/// filtered to one owner (rowless units read as player zero).
pub fn population(world: &CoreWorld, comps: &MovementComps, bcomps: &BuildingComps, owner_filter: Option<f64>) -> i64 {
    let mut count = 0i64;
    for &eid in rows(world, comps.unit_tag).keys() {
        if let Some(owner) = owner_filter {
            if owner_of(world, comps.owner, eid) != owner {
                continue;
            }
        }
        count += 1;
    }
    for g_row in rows(world, bcomps.garrison).values() {
        let g_count = g_row[0] as usize;
        for i in 0..g_count {
            let g_owner = g_row[1 + i * 5 + 1];
            if owner_filter.is_none() || owner_filter == Some(g_owner) {
                count += 1;
            }
        }
    }
    count
}

/// Σ populationCap over finished buildings, optionally per owner.
pub fn population_cap(world: &CoreWorld, bcomps: &BuildingComps, defs: &Defs, owner_filter: Option<f64>) -> i64 {
    let mut cap = 0i64;
    for r in rows(world, bcomps.building).values() {
        if let Some(owner) = owner_filter {
            if r[0] != owner {
                continue;
            }
        }
        cap += defs.building(defs.building_id_of_code(r[1] as u32)).population_cap;
    }
    cap
}

// ---- costs (systems/costs.ts) ------------------------------------------------------------------

fn stockpile_row_eid(world: &CoreWorld, econ: &EconomyComps, player_id: f64) -> Option<Eid> {
    rows(world, econ.stockpile).iter().find(|(_, r)| r[0] == player_id).map(|(e, _)| *e)
}

pub fn can_afford_costs(world: &CoreWorld, econ: &EconomyComps, player_id: f64, costs: &Costs) -> bool {
    let Some(eid) = stockpile_row_eid(world, econ, player_id) else { return false };
    let r = &rows(world, econ.stockpile)[&eid];
    for (slug, amount) in costs {
        if *amount <= 0 {
            continue;
        }
        let code = resource_code_of_slug(slug).unwrap_or_else(|| panic!("unknown cost resource slug: {slug:?}"));
        if r[code as usize + 1] < *amount as f64 {
            return false;
        }
    }
    true
}

/// Atomic escrow debit; Err leaves the ledger untouched.
pub fn pay_costs(world: &mut CoreWorld, econ: &EconomyComps, player_id: f64, costs: &Costs, what: &str) -> Result<(), String> {
    let eid = stockpile_row_eid(world, econ, player_id)
        .ok_or_else(|| format!("player {player_id} has no stockpile entity"))?;
    let mut debits: Vec<(usize, f64)> = Vec::new();
    {
        let r = &rows(world, econ.stockpile)[&eid];
        for (slug, amount) in costs {
            if *amount <= 0 {
                continue;
            }
            let code = resource_code_of_slug(slug).ok_or_else(|| format!("unknown cost resource slug: {slug:?}"))?;
            let held = r[code as usize + 1];
            if held < *amount as f64 {
                return Err(format!("cannot afford {what}: needs {amount} {slug}, stockpile holds {held}"));
            }
            debits.push((code as usize, *amount as f64));
        }
    }
    let r = rows_mut(world, econ.stockpile).get_mut(&eid).expect("stockpile row");
    for (code, amount) in debits {
        r[code + 1] -= amount;
    }
    Ok(())
}

// ---- age gate (components/age.ts + systems/age.ts) ----------------------------------------------

pub const GATE_HANDLER_PLACE: f64 = 0.0;
pub const GATE_HANDLER_TRAIN: f64 = 1.0;
pub const GATE_HANDLER_RESEARCH: f64 = 2.0;

pub fn age_rank_of(world: &CoreWorld, age: &AgeComps, player_id: f64) -> Option<f64> {
    rows(world, age.age_state).values().find(|r| r[0] == player_id).map(|r| r[1])
}

/// Rowless players (no AgeState row) pass every gate — TS semantics.
pub fn is_def_age_unlocked(world: &CoreWorld, age: &AgeComps, player_id: f64, gate: &str) -> bool {
    match age_rank_of(world, age, player_id) {
        None => true,
        Some(rank) => age_rank(gate) as f64 <= rank,
    }
}

pub fn append_gate_rejection(
    world: &mut CoreWorld,
    age: &AgeComps,
    econ: &EconomyComps,
    player_id: f64,
    tick: u64,
    handler: f64,
    def_code: f64,
) {
    let eid = stockpile_row_eid(world, econ, player_id)
        .unwrap_or_else(|| panic!("player {player_id} has no stockpile entity"));
    let rows = rows_mut(world, age.gate_rejected);
    let r = rows.entry(eid).or_insert_with(|| vec![0.0]);
    r.push(tick as f64);
    r.push(handler);
    r.push(def_code);
    r[0] += 1.0;
}

/// Researched tech codes for one player, ascending (count-led row on
/// the player's stockpile/ledger entity).
pub fn researched_tech_codes(world: &CoreWorld, age: &AgeComps, econ: &EconomyComps, player_id: f64) -> Vec<i64> {
    let Some(eid) = stockpile_row_eid(world, econ, player_id) else { return Vec::new() };
    let Some(r) = row(world, age.researched_techs, eid) else { return Vec::new() };
    let mut codes: Vec<i64> = r[1..].iter().map(|v| *v as i64).collect();
    codes.sort();
    codes
}

/// Unit-upgrade chains implied by researched techs: from → to.
pub fn player_upgrade_chains(world: &CoreWorld, age: &AgeComps, econ: &EconomyComps, defs: &Defs, player_id: f64) -> BTreeMap<String, String> {
    let mut chains = BTreeMap::new();
    for code in researched_tech_codes(world, age, econ, player_id) {
        let tech_id = defs.tech_id_of_code(code as u32).to_string();
        if let Some(upgrade) = &defs.tech(&tech_id).unit_upgrade {
            chains.insert(upgrade.from_unit_id.clone(), upgrade.to_unit_id.clone());
        }
    }
    chains
}

pub fn resolve_upgraded_unit_id(world: &CoreWorld, age: &AgeComps, econ: &EconomyComps, defs: &Defs, player_id: f64, unit_id: &str) -> String {
    let chains = player_upgrade_chains(world, age, econ, defs, player_id);
    let mut current = unit_id.to_string();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(next) = chains.get(&current) {
        if !visited.insert(current.clone()) {
            break;
        }
        current = next.clone();
    }
    current
}

pub fn is_unit_tier_unlocked(world: &CoreWorld, age: &AgeComps, econ: &EconomyComps, defs: &Defs, player_id: f64, unit_id: &str) -> bool {
    let required = defs.techs.values().find(|t| t.unit_upgrade.as_ref().map(|u| u.to_unit_id == unit_id).unwrap_or(false));
    match required {
        None => true,
        Some(tech) => researched_tech_codes(world, age, econ, player_id).contains(&(defs.tech_code(&tech.id) as i64)),
    }
}

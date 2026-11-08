//! Fog of war (SPEC §2.9 / M2-T8): Rust port of
//! `src/sim/systems/fog.ts`. Per-player explored/visible planes +
//! contributor counts as world-sized side state (never in digests),
//! dirty-entity incremental stamping through circle LUTs, unit-step
//! band moves, memory ghosts for enemy buildings, and the
//! KnowledgeView surface (SPEC §2.8: enemies off-screen are
//! structurally unqueryable). Full recompute only on map-gen/load.
use crate::buildings::BuildingComps;
use crate::combat::{combat_row, CombatComps};
use crate::core::{Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::movement::MovementComps;
use crate::pop::{js_round, owner_of_unit, PopComps};
use std::collections::{BTreeMap, HashSet};

pub const FOG_LUT_MAX_RADIUS: i64 = 16;
pub const DEFAULT_UNIT_SIGHT_RADIUS: i64 = 5;
pub const DEFAULT_UNIT_DEF_ID: &str = "villager";

#[derive(Clone)]
pub struct FogPlayerPlanes {
    pub explored: Vec<u8>,
    pub visible: Vec<u8>,
    pub contributor_count: Vec<u16>,
}

#[derive(Clone)]
pub struct FogState {
    pub size: usize,
    pub player_count: usize,
    pub planes: Vec<FogPlayerPlanes>,
}

impl FogState {
    pub fn new(size: usize, player_count: usize) -> FogState {
        assert!(size > 0, "fog grid size must be a positive integer");
        assert!(player_count > 0, "fog player count must be a positive integer");
        let tiles = size * size;
        FogState {
            size,
            player_count,
            planes: (0..player_count)
                .map(|_| FogPlayerPlanes {
                    explored: vec![0; tiles],
                    visible: vec![0; tiles],
                    contributor_count: vec![0; tiles],
                })
                .collect(),
        }
    }
}

pub fn circle_offsets(radius: i64) -> Vec<(i32, i32)> {
    assert!(
        (0..=FOG_LUT_MAX_RADIUS).contains(&radius),
        "sight radius must be an integer in [0, {FOG_LUT_MAX_RADIUS}], got {radius}"
    );
    let mut pairs = Vec::new();
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx * dx + dy * dy <= radius * radius {
                pairs.push((dx as i32, dy as i32));
            }
        }
    }
    pairs
}

fn circle_band_offsets(radius: i64, sx: i64, sy: i64) -> (Vec<(i32, i32)>, Vec<(i32, i32)>) {
    let offsets = circle_offsets(radius);
    let r2 = radius * radius;
    let (mut remove, mut add) = (Vec::new(), Vec::new());
    for (dx, dy) in offsets {
        let (dx, dy) = (dx as i64, dy as i64);
        let (rx, ry) = (dx - sx, dy - sy);
        if rx * rx + ry * ry > r2 {
            remove.push((dx as i32, dy as i32));
        }
        let (ax, ay) = (dx + sx, dy + sy);
        if ax * ax + ay * ay > r2 {
            add.push((dx as i32, dy as i32));
        }
    }
    (remove, add)
}

fn clamp_tile(value: i64, size: usize) -> i64 {
    value.clamp(0, size as i64 - 1)
}

pub fn stamp_sight_circle(state: &mut FogState, player: usize, center_x: i64, center_y: i64, radius: i64) {
    let size = state.size;
    let (cx, cy) = (clamp_tile(center_x, size), clamp_tile(center_y, size));
    let plane = &mut state.planes[player];
    for (dx, dy) in circle_offsets(radius) {
        let (x, y) = (cx + dx as i64, cy + dy as i64);
        if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
            continue;
        }
        let index = y as usize * size + x as usize;
        plane.visible[index] = 1;
        if plane.contributor_count[index] < 0xffff {
            plane.contributor_count[index] += 1;
        }
        plane.explored[index] = 1;
    }
}

pub fn unstamp_sight_circle(state: &mut FogState, player: usize, center_x: i64, center_y: i64, radius: i64) {
    let size = state.size;
    let (cx, cy) = (clamp_tile(center_x, size), clamp_tile(center_y, size));
    let plane = &mut state.planes[player];
    for (dx, dy) in circle_offsets(radius) {
        let (x, y) = (cx + dx as i64, cy + dy as i64);
        if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
            continue;
        }
        let index = y as usize * size + x as usize;
        let count = plane.contributor_count[index];
        if count == 0 {
            continue;
        }
        plane.contributor_count[index] = count - 1;
        if count == 1 {
            plane.visible[index] = 0;
        }
    }
}

pub fn visible_tile_count(state: &FogState, player: usize) -> usize {
    state.planes[player].visible.iter().map(|v| *v as usize).sum()
}
pub fn explored_tile_count(state: &FogState, player: usize) -> usize {
    state.planes[player].explored.iter().map(|v| *v as usize).sum()
}

#[derive(Clone, Debug, PartialEq)]
pub struct FogEntityRecord {
    pub eid: Eid,
    pub tile_x: i64,
    pub tile_y: i64,
    pub sight_radius: i64,
    pub owner: f64,
    pub def_id: String,
    pub is_building: bool,
    pub origin_x: i64,
    pub origin_y: i64,
    pub foot_width: i64,
    pub foot_height: i64,
}

#[derive(Clone, Copy)]
pub struct FogComps {
    pub position: usize,
    pub unit_tag: usize,
    pub building: usize,
    pub building_site: usize,
    pub combat: usize,
}

impl FogComps {
    pub fn new(comps: &MovementComps, bcomps: &BuildingComps, ccomps: &CombatComps) -> FogComps {
        FogComps {
            position: comps.position,
            unit_tag: comps.unit_tag,
            building: bcomps.building,
            building_site: bcomps.building_site,
            combat: ccomps.combat,
        }
    }
}

fn resolve(world: &CoreWorld, comps: &FogComps, pop: &PopComps, defs: &Defs, size: usize, eid: Eid) -> Option<FogEntityRecord> {
    let pos = world.rows_by_component[comps.position].get(&eid)?;
    let (px, py) = (pos[0], pos[1]);
    let building = world
        .rows_by_component[comps.building]
        .get(&eid)
        .or_else(|| world.rows_by_component[comps.building_site].get(&eid));
    if let Some(b) = building {
        let def_id = defs.building_id_of_code(b[1] as u32).to_string();
        let def = defs.building(&def_id);
        return Some(FogEntityRecord {
            eid,
            tile_x: clamp_tile(px.floor() as i64, size),
            tile_y: clamp_tile(py.floor() as i64, size),
            sight_radius: js_round(def.sight_radius) as i64,
            owner: b[0],
            def_id,
            is_building: true,
            origin_x: (px - def.footprint.width as f64 / 2.0).floor() as i64,
            origin_y: (py - def.footprint.height as f64 / 2.0).floor() as i64,
            foot_width: def.footprint.width,
            foot_height: def.footprint.height,
        });
    }
    if let Some(cr) = world.rows_by_component[comps.combat].get(&eid) {
        let def_id = defs.unit_id_of_code(cr[0] as u32).to_string();
        let def = defs.unit(&def_id);
        return Some(FogEntityRecord {
            eid,
            tile_x: clamp_tile(px.floor() as i64, size),
            tile_y: clamp_tile(py.floor() as i64, size),
            sight_radius: js_round(def.sight_radius) as i64,
            owner: cr[1],
            def_id,
            is_building: false,
            origin_x: px.floor() as i64,
            origin_y: py.floor() as i64,
            foot_width: 1,
            foot_height: 1,
        });
    }
    if world.rows_by_component[comps.unit_tag].contains_key(&eid) {
        return Some(FogEntityRecord {
            eid,
            tile_x: clamp_tile(px.floor() as i64, size),
            tile_y: clamp_tile(py.floor() as i64, size),
            sight_radius: DEFAULT_UNIT_SIGHT_RADIUS,
            owner: owner_of_unit(world, pop, eid),
            def_id: DEFAULT_UNIT_DEF_ID.to_string(),
            is_building: false,
            origin_x: px.floor() as i64,
            origin_y: py.floor() as i64,
            foot_width: 1,
            foot_height: 1,
        });
    }
    let _ = combat_row;
    None
}

#[derive(Clone, Debug, PartialEq)]
pub struct KnownEntity {
    pub eid: Eid,
    pub def_id: String,
    pub tile_x: i64,
    pub tile_y: i64,
    pub owner: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GhostRecord {
    pub eid: Eid,
    pub def_id: String,
    pub tile_x: i64,
    pub tile_y: i64,
}

pub struct FogHandle {
    pub state: FogState,
    pub revision: u64,
    stamped: BTreeMap<Eid, FogEntityRecord>,
    dirty_queue: Vec<Eid>,
    known_buildings: Vec<BTreeMap<Eid, GhostRecord>>,
}

impl FogHandle {
    pub fn new(size: usize, player_count: usize) -> FogHandle {
        FogHandle {
            state: FogState::new(size, player_count),
            revision: 0,
            stamped: BTreeMap::new(),
            dirty_queue: Vec::new(),
            known_buildings: (0..player_count).map(|_| BTreeMap::new()).collect(),
        }
    }

    fn on_grid(&self, x: i64, y: i64) -> bool {
        x >= 0 && y >= 0 && x < self.state.size as i64 && y < self.state.size as i64
    }

    pub fn is_visible(&self, x: i64, y: i64, player: usize) -> bool {
        assert!(player < self.state.player_count, "unknown fog player: {player}");
        self.on_grid(x, y) && self.state.planes[player].visible[y as usize * self.state.size + x as usize] == 1
    }

    pub fn is_explored(&self, x: i64, y: i64, player: usize) -> bool {
        assert!(player < self.state.player_count, "unknown fog player: {player}");
        self.on_grid(x, y) && self.state.planes[player].explored[y as usize * self.state.size + x as usize] == 1
    }

    pub fn mark_dirty(&mut self, eid: Eid) {
        assert!(eid >= 1, "fog markDirty requires a positive entity id, got {eid}");
        self.dirty_queue.push(eid);
    }

    fn footprint_visible_to(&self, viewer: usize, record: &FogEntityRecord) -> bool {
        for dy in 0..record.foot_height {
            for dx in 0..record.foot_width {
                if self.is_visible(record.origin_x + dx, record.origin_y + dy, viewer) {
                    return true;
                }
            }
        }
        false
    }

    fn update_knowledge_pass(&mut self) {
        let records: Vec<FogEntityRecord> = self.stamped.values().cloned().collect();
        for record in &records {
            if !record.is_building {
                continue;
            }
            for viewer in 0..self.state.player_count {
                if record.owner == viewer as f64 {
                    continue;
                }
                if self.footprint_visible_to(viewer, record) {
                    self.known_buildings[viewer].insert(
                        record.eid,
                        GhostRecord { eid: record.eid, def_id: record.def_id.clone(), tile_x: record.origin_x, tile_y: record.origin_y },
                    );
                }
            }
        }
    }

    fn move_stamp(&mut self, previous: &FogEntityRecord, current: FogEntityRecord) {
        let size = self.state.size;
        let (ocx, ocy) = (clamp_tile(previous.tile_x, size), clamp_tile(previous.tile_y, size));
        let (ncx, ncy) = (clamp_tile(current.tile_x, size), clamp_tile(current.tile_y, size));
        let (sx, sy) = (ncx - ocx, ncy - ocy);
        let owner = current.owner as usize;
        if (-1..=1).contains(&sx) && (-1..=1).contains(&sy) && (sx != 0 || sy != 0) {
            let (remove, add) = circle_band_offsets(current.sight_radius, sx, sy);
            let plane = &mut self.state.planes[owner];
            for (dx, dy) in remove {
                let (x, y) = (ocx + dx as i64, ocy + dy as i64);
                if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
                    continue;
                }
                let index = y as usize * size + x as usize;
                let count = plane.contributor_count[index];
                if count == 0 {
                    continue;
                }
                plane.contributor_count[index] = count - 1;
                if count == 1 {
                    plane.visible[index] = 0;
                }
            }
            for (dx, dy) in add {
                let (x, y) = (ncx + dx as i64, ncy + dy as i64);
                if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
                    continue;
                }
                let index = y as usize * size + x as usize;
                plane.visible[index] = 1;
                if plane.contributor_count[index] < 0xffff {
                    plane.contributor_count[index] += 1;
                }
                plane.explored[index] = 1;
            }
            self.stamped.insert(current.eid, current);
            return;
        }
        if ocx != ncx || ocy != ncy {
            let radius = current.sight_radius;
            let r2 = radius * radius;
            let offsets = circle_offsets(radius);
            let plane = &mut self.state.planes[owner];
            for (dx, dy) in &offsets {
                let (x, y) = (ocx + *dx as i64, ocy + *dy as i64);
                if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
                    continue;
                }
                let (dxn, dyn_) = (x - ncx, y - ncy);
                if dxn * dxn + dyn_ * dyn_ <= r2 {
                    continue;
                }
                let index = y as usize * size + x as usize;
                let count = plane.contributor_count[index];
                if count == 0 {
                    continue;
                }
                plane.contributor_count[index] = count - 1;
                if count == 1 {
                    plane.visible[index] = 0;
                }
            }
            for (dx, dy) in &offsets {
                let (x, y) = (ncx + *dx as i64, ncy + *dy as i64);
                if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
                    continue;
                }
                let (dxo, dyo) = (x - ocx, y - ocy);
                if dxo * dxo + dyo * dyo <= r2 {
                    continue;
                }
                let index = y as usize * size + x as usize;
                plane.visible[index] = 1;
                if plane.contributor_count[index] < 0xffff {
                    plane.contributor_count[index] += 1;
                }
                plane.explored[index] = 1;
            }
        }
        self.stamped.insert(current.eid, current);
    }

    pub fn flush_dirty(&mut self, world: &CoreWorld, comps: &FogComps, pop: &PopComps, defs: &Defs) {
        if self.dirty_queue.is_empty() {
            return;
        }
        let size = self.state.size;
        let mut seen: HashSet<Eid> = HashSet::new();
        let queue: Vec<Eid> = std::mem::take(&mut self.dirty_queue);
        for eid in queue {
            if !seen.insert(eid) {
                continue;
            }
            let previous = self.stamped.get(&eid).cloned();
            let current = resolve(world, comps, pop, defs, size, eid);
            if let (Some(p), Some(c)) = (&previous, &current) {
                if p.tile_x == c.tile_x && p.tile_y == c.tile_y && p.sight_radius == c.sight_radius && p.owner == c.owner {
                    continue;
                }
            }
            if let (Some(p), Some(c)) = (&previous, &current) {
                if p.owner == c.owner && p.sight_radius == c.sight_radius {
                    self.move_stamp(p, c.clone());
                    continue;
                }
            }
            if let Some(p) = &previous {
                unstamp_sight_circle(&mut self.state, p.owner as usize, p.tile_x, p.tile_y, p.sight_radius);
                self.stamped.remove(&eid);
            }
            if let Some(c) = current {
                stamp_sight_circle(&mut self.state, c.owner as usize, c.tile_x, c.tile_y, c.sight_radius);
                self.stamped.insert(c.eid, c);
            } else {
                for map in &mut self.known_buildings {
                    map.remove(&eid);
                }
            }
        }
        self.update_knowledge_pass();
        self.revision += 1;
    }

    pub fn recompute_all(&mut self, world: &CoreWorld, comps: &FogComps, pop: &PopComps, defs: &Defs) {
        for plane in &mut self.state.planes {
            plane.explored.fill(0);
            plane.visible.fill(0);
            plane.contributor_count.fill(0);
        }
        self.stamped.clear();
        self.dirty_queue.clear();
        for map in &mut self.known_buildings {
            map.clear();
        }
        let size = self.state.size;
        for &eid in &world.entities {
            if let Some(record) = resolve(world, comps, pop, defs, size, eid) {
                stamp_sight_circle(&mut self.state, record.owner as usize, record.tile_x, record.tile_y, record.sight_radius);
                self.stamped.insert(record.eid, record);
            }
        }
        self.update_knowledge_pass();
        self.revision += 1;
    }

    pub fn known_entities(&self, viewer: usize) -> Vec<KnownEntity> {
        assert!(viewer < self.state.player_count, "unknown fog player: {viewer}");
        let mut out = Vec::new();
        for record in self.stamped.values() {
            let own = record.owner == viewer as f64;
            if !own && !self.is_visible(record.tile_x, record.tile_y, viewer) {
                continue;
            }
            out.push(KnownEntity {
                eid: record.eid,
                def_id: record.def_id.clone(),
                tile_x: if own { record.tile_x } else { record.origin_x },
                tile_y: if own { record.tile_y } else { record.origin_y },
                owner: record.owner,
            });
        }
        out.sort_by_key(|e| e.eid);
        out
    }

    pub fn last_known(&self, viewer: usize, enemy_eid: Eid) -> Option<GhostRecord> {
        self.known_buildings[viewer].get(&enemy_eid).cloned()
    }

    pub fn known_ghost_records(&self, viewer: usize) -> Vec<GhostRecord> {
        self.known_buildings[viewer].values().cloned().collect()
    }

    pub fn replace_ghost_records(&mut self, per_viewer: &[Vec<GhostRecord>]) {
        assert_eq!(
            per_viewer.len(),
            self.state.player_count,
            "ghost record replacement expects {} viewer lists",
            self.state.player_count
        );
        for (viewer, records) in per_viewer.iter().enumerate() {
            self.known_buildings[viewer].clear();
            for record in records {
                self.known_buildings[viewer].insert(record.eid, record.clone());
            }
        }
    }
}

// ---- save/restore seam ----

#[derive(Clone)]
pub struct FogSnapshot {
    pub size: usize,
    pub player_count: usize,
    pub planes: Vec<FogPlayerPlanes>,
    pub ghosts: Vec<Vec<GhostRecord>>,
}

pub fn capture_fog_snapshot(handle: &FogHandle) -> FogSnapshot {
    FogSnapshot {
        size: handle.state.size,
        player_count: handle.state.player_count,
        planes: handle.state.planes.clone(),
        ghosts: (0..handle.state.player_count).map(|v| handle.known_ghost_records(v)).collect(),
    }
}

/// ui/minimap tri-state projection, mirrored for tests.
pub fn minimap_shade(is_explored: bool, is_visible: bool) -> u8 {
    if !is_explored {
        0
    } else if is_visible {
        2
    } else {
        1
    }
}

pub fn apply_fog_snapshot(handle: &mut FogHandle, snapshot: &FogSnapshot) {
    assert!(
        snapshot.size == handle.state.size
            && snapshot.player_count == handle.state.player_count
            && snapshot.planes.len() == handle.state.planes.len()
            && snapshot.ghosts.len() == handle.state.planes.len(),
        "fog snapshot geometry mismatch"
    );
    let tiles = handle.state.size * handle.state.size;
    for (player, saved) in snapshot.planes.iter().enumerate() {
        assert!(
            saved.explored.len() == tiles && saved.visible.len() == tiles && saved.contributor_count.len() == tiles,
            "fog plane {player} length mismatch: expected {tiles} tiles"
        );
        handle.state.planes[player] = saved.clone();
    }
    handle.replace_ghost_records(&snapshot.ghosts);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{building_site_row, AgeComps, BuildingComps};
    use crate::combat::{spawn_combat_unit, CombatComps, SpawnCombatOptions};
    use crate::core::Command;
    use crate::economy::{create_player_stockpile, PLAYER_ONE};
    use crate::gather::EconomySim;
    use crate::mapgen::{Layers, TERRAIN_GRASS};
    use crate::path::Transport;
    use crate::placement::validate_placement;
    use crate::pop::TraitsData;
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

    #[derive(Deserialize)]
    struct Unit {
        eid: i64,
        x: f64,
        y: f64,
    }
    #[derive(Deserialize)]
    struct Stock {
        #[serde(rename = "playerId")]
        player_id: f64,
        resources: Vec<f64>,
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
        scout: Unit,
        villagers: Vec<Unit>,
        stockpiles: Vec<Stock>,
        buildings: Vec<Building>,
        commands: Vec<Cmd>,
    }

    struct Sample {
        tick: u64,
        explored: usize,
        visible: usize,
        shades: [usize; 3],
        barracks_shade: u8,
        corner_shade: u8,
        barracks_known: bool,
        house_known: bool,
    }

    struct Run {
        digests: Vec<(u64, String)>,
        samples: Vec<Sample>,
        far_reason: &'static str,
        near_ok: bool,
        placed_site: bool,
        known_eids: Vec<i64>,
        last_barracks: Option<GhostRecord>,
        last_house: Option<GhostRecord>,
        barracks_visible: bool,
        house_visible: bool,
    }

    fn run_scenario(use_fog: bool) -> Run {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t8/case.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
        let mut sim = EconomySim::new(fixture.seed, fixture.size, Transport::synchronous(), defs(), traits()).unwrap();
        sim.movement.layers = Layers {
            size: fixture.size,
            terrain: vec![TERRAIN_GRASS; fixture.size * fixture.size],
            elevation: vec![0; fixture.size * fixture.size],
            passability: vec![1; fixture.size * fixture.size],
        };
        if use_fog {
            sim.fog = Some(FogHandle::new(fixture.size, 2));
        }
        let econ = sim.econ;
        {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            let eid = spawn_combat_unit(
                world, comps, &ccomps, &pop, &traits(), &defs(), "scout-cavalry",
                fixture.scout.x, fixture.scout.y, PLAYER_ONE,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
            assert_eq!(eid as i64, fixture.scout.eid);
        }
        for v in &fixture.villagers {
            assert_eq!(sim.spawn_unit(v.x, v.y) as i64, v.eid);
        }
        for stock in &fixture.stockpiles {
            create_player_stockpile(&mut sim.movement.world, &econ, stock.player_id, Some(&stock.resources)).unwrap();
        }
        {
            let bcomps = BuildingComps::from_world(&sim.movement.world);
            let age = AgeComps::from_world(&sim.movement.world);
            let defs = defs();
            for building in &fixture.buildings {
                let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
                let eid = crate::placement::stamp_finished_building(
                    world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                    &building.def_id, building.tile_x, building.tile_y, building.player_id,
                );
                assert_eq!(eid as i64, building.eid);
            }
        }
        if use_fog {
            sim.fog_recompute_all();
        }
        let (far_reason, near_ok) = {
            let bcomps = BuildingComps::from_world(&sim.movement.world);
            let age = AgeComps::from_world(&sim.movement.world);
            let defs = defs();
            let far = validate_placement(
                &sim.movement.world, &sim.movement.comps, &bcomps, &econ, &age, &defs,
                &sim.movement.layers, "house", 40, 40, PLAYER_ONE, false, sim.fog.as_ref(),
            );
            let near = validate_placement(
                &sim.movement.world, &sim.movement.comps, &bcomps, &econ, &age, &defs,
                &sim.movement.layers, "house", 9, 25, PLAYER_ONE, false, sim.fog.as_ref(),
            );
            (far.err().unwrap_or("ok"), near.is_ok())
        };
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let mut digests = Vec::new();
        let mut samples = Vec::new();
        while sim.movement.world.tick < fixture.ticks {
            let before = sim.movement.world.tick;
            sim.step();
            if sim.movement.world.tick == before {
                continue;
            }
            let t = sim.movement.world.tick;
            if t % fixture.milestone_every == 0 || t == fixture.ticks {
                digests.push((t, sim.digest()));
                if let Some(fog) = &sim.fog {
                    let mut shades = [0usize; 3];
                    let size = fog.state.size;
                    for ty in 0..size as i64 {
                        for tx in 0..size as i64 {
                            shades[minimap_shade(fog.is_explored(tx, ty, 0), fog.is_visible(tx, ty, 0)) as usize] += 1;
                        }
                    }
                    samples.push(Sample {
                        tick: t,
                        explored: explored_tile_count(&fog.state, 0),
                        visible: visible_tile_count(&fog.state, 0),
                        shades,
                        barracks_shade: minimap_shade(fog.is_explored(24, 29, 0), fog.is_visible(24, 29, 0)),
                        corner_shade: minimap_shade(fog.is_explored(0, 0, 0), fog.is_visible(0, 0, 0)),
                        barracks_known: fog.last_known(0, 6).is_some(),
                        house_known: fog.last_known(0, 7).is_some(),
                    });
                }
            }
        }
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        let (known_eids, last_barracks, last_house, barracks_visible, house_visible) = match &sim.fog {
            Some(fog) => (
                fog.known_entities(0).iter().map(|e| e.eid).collect::<Vec<_>>(),
                fog.last_known(0, 6),
                fog.last_known(0, 7),
                fog.is_visible(24, 29, 0),
                fog.is_visible(28, 29, 0),
            ),
            None => (Vec::new(), None, None, true, true),
        };
        Run {
            digests,
            samples,
            far_reason,
            near_ok,
            placed_site: building_site_row(&sim.movement.world, &bcomps, 8).is_some(),
            known_eids,
            last_barracks,
            last_house,
            barracks_visible,
            house_visible,
        }
    }

    #[test]
    fn m2t8_fog_planes_ghosts_and_stub_parity() {
        let fogged = run_scenario(true);
        // Snapshot digests.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t8/__snapshots__");
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
        assert_eq!(fogged.digests, expected);

        // Plane progression.
        for i in 1..fogged.samples.len() {
            assert!(fogged.samples[i].explored >= fogged.samples[i - 1].explored, "explored monotonic");
            assert!(fogged.samples[i].visible <= fogged.samples[i].explored);
        }
        let first = &fogged.samples[0];
        assert!(first.explored > 0);
        assert!(first.shades[0] > 3000, "mostly black early: {}", first.shades[0]);
        let early = fogged.samples.iter().find(|s| s.tick <= 60).unwrap();
        assert_eq!(early.barracks_shade, 0);
        assert!(!early.barracks_known);
        let sighted_at = fogged.samples.iter().position(|s| s.barracks_known).expect("barracks sighted");
        assert!(sighted_at > 0);
        assert_eq!(fogged.samples[sighted_at].barracks_shade, 2, "bright on first sighting");
        assert!(!fogged.samples[sighted_at - 1].barracks_known);
        let house_at = fogged.samples.iter().position(|s| s.house_known).expect("house sighted");
        assert!(house_at > sighted_at);
        let last = fogged.samples.last().unwrap();
        assert_eq!(last.barracks_shade, 1, "dim ghost at end");
        assert!(last.shades[1] > first.shades[1]);
        assert_eq!(last.corner_shade, 0, "far corner still black");

        // KnowledgeView ghosts.
        assert!(!fogged.barracks_visible && !fogged.house_visible);
        assert_eq!(
            fogged.last_barracks,
            Some(GhostRecord { eid: 6, def_id: "barracks".into(), tile_x: 24, tile_y: 28 })
        );
        assert_eq!(
            fogged.last_house,
            Some(GhostRecord { eid: 7, def_id: "house".into(), tile_x: 28, tile_y: 29 })
        );
        assert!(!fogged.known_eids.contains(&6) && !fogged.known_eids.contains(&7));
        assert!(fogged.known_eids.len() >= 3, "own units + TC known");

        // Placement fog gate.
        assert_eq!(fogged.far_reason, "unexplored");
        assert!(fogged.near_ok);
        assert!(fogged.placed_site);

        // Observational neutrality: stub run byte-identical.
        let stubbed = run_scenario(false);
        assert_eq!(stubbed.digests, fogged.digests);
    }
}

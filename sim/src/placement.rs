//! Building placement system (SPEC §2.6/§2.13 / M1-T10): Rust port of
//! `src/sim/systems/placement.ts`. Validates the footprint, escrows
//! the FULL definition cost up front, spawns the construction site,
//! blocks the footprint tiles immediately and bumps the scheduler
//! passability version (AoE2 blocks at placement; farms stay
//! passable). Age-gated placements record polite digest-visible
//! GateRejected rows; other invalid commands throw loudly.
//!
//! The fog/explored gate consults the fog handle when the runner
//! carries one (crate::fog); without it, the all-visible default.
use crate::buildings::{
    append_gate_rejection, building_rect, can_afford_costs, complete_building, footprint_tiles,
    is_def_age_unlocked, pay_costs, rects_overlap, site_rect, spawn_building_site, AgeComps,
    BuildingComps, FootprintRect, GATE_HANDLER_PLACE,
};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::fog::FogHandle;
use crate::defs::Defs;
use crate::economy::EconomyComps;
use crate::mapgen::{is_water_terrain, Layers};
use crate::movement::MovementComps;
use crate::path::PathScheduler;
use std::sync::Arc;

pub const PLACE_BUILDING_KIND: &str = "placeBuilding";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlacementDiagnostics {
    pub commands_applied: u64,
    pub gate_rejections: u64,
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}

struct ParsedPlace {
    def_id: String,
    tile_x: i64,
    tile_y: i64,
    player_id: f64,
}

fn parse_place_data(data: &serde_json::Value) -> ParsedPlace {
    let def_id = data
        .get("defId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .expect("placeBuilding requires a non-empty defId string")
        .to_string();
    let tile = |key: &str| {
        data.get(key)
            .and_then(|v| v.as_f64())
            .filter(|v| v.fract() == 0.0)
            .map(|v| v as i64)
            .expect("placeBuilding requires integer tileX/tileY coordinates")
    };
    let player_id = data.get("playerId").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert!(player_id >= 0.0 && player_id.fract() == 0.0, "placeBuilding playerId must be a non-negative integer");
    ParsedPlace { def_id, tile_x: tile("tileX"), tile_y: tile("tileY"), player_id }
}

fn node_on_any_tile(world: &CoreWorld, comps: &MovementComps, econ: &EconomyComps, tiles: &[(i64, i64)]) -> bool {
    for &eid in world.rows_by_component[econ.resource_node].keys() {
        let node = &world.rows_by_component[econ.resource_node][&eid];
        if node[1] <= 0.0 {
            continue;
        }
        let Some(pos) = row(world, comps.position, eid) else { continue };
        let (nx, ny) = (pos[0].floor() as i64, pos[1].floor() as i64);
        if tiles.contains(&(nx, ny)) {
            return true;
        }
    }
    false
}

fn building_overlap(world: &CoreWorld, comps: &MovementComps, bcomps: &BuildingComps, defs: &Defs, rect: &FootprintRect) -> bool {
    for &eid in &world.entities {
        let other = site_rect(world, comps, bcomps, defs, eid).or_else(|| building_rect(world, comps, bcomps, defs, eid));
        if let Some(other) = other {
            if rects_overlap(rect, &other) {
                return true;
            }
        }
    }
    false
}

/// Shared validity verdict (command handler + ghost UI in TS).
/// Err carries the TS rejection reason string.
#[allow(clippy::too_many_arguments)]
pub fn validate_placement(
    world: &CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    econ: &EconomyComps,
    age: &AgeComps,
    defs: &Defs,
    layers: &Layers,
    def_id: &str,
    tile_x: i64,
    tile_y: i64,
    player_id: f64,
    ignore_age_gate: bool,
    fog: Option<&FogHandle>,
) -> Result<FootprintRect, &'static str> {
    let Some(def) = defs.buildings.get(def_id) else { return Err("unknown-def") };
    if !ignore_age_gate && !is_def_age_unlocked(world, age, player_id, &def.age_gate) {
        return Err("age-gated");
    }
    let (w, h) = (def.footprint.width, def.footprint.height);
    let rect = FootprintRect { x: tile_x as f64, y: tile_y as f64, width: w as f64, height: h as f64 };
    let size = layers.size as i64;
    let tiles = footprint_tiles(tile_x, tile_y, w, h);
    for &(x, y) in &tiles {
        if x < 0 || y < 0 || x >= size || y >= size {
            return Err("out-of-bounds");
        }
    }
    if node_on_any_tile(world, comps, econ, &tiles) || building_overlap(world, comps, bcomps, defs, &rect) {
        return Err("occupied");
    }
    if def_id == "dock" {
        let (mut land, mut water) = (0, 0);
        for &(x, y) in &tiles {
            if is_water_terrain(layers.terrain[y as usize * size as usize + x as usize]) {
                water += 1;
            } else {
                land += 1;
            }
        }
        if water == 0 {
            return Err("dock-needs-water");
        }
        if land == 0 {
            return Err("dock-needs-land");
        }
        let (mut exterior_water, mut exterior_land) = (false, false);
        for dy in -1..=h {
            for dx in -1..=w {
                if dx >= 0 && dx < w && dy >= 0 && dy < h {
                    continue;
                }
                let (ex, ey) = (tile_x + dx, tile_y + dy);
                if ex >= 0 && ex < size && ey >= 0 && ey < size {
                    if is_water_terrain(layers.terrain[ey as usize * size as usize + ex as usize]) {
                        exterior_water = true;
                    } else {
                        exterior_land = true;
                    }
                }
            }
        }
        if !exterior_water {
            return Err("dock-needs-water");
        }
        if !exterior_land {
            return Err("dock-needs-land");
        }
    } else {
        for &(x, y) in &tiles {
            let idx = y as usize * size as usize + x as usize;
            if layers.passability[idx] != 1 {
                return Err(if is_water_terrain(layers.terrain[idx]) { "water" } else { "blocked-tile" });
            }
        }
    }
    // Fog gate (SPEC §2.9): every footprint tile must be explored.
    if let Some(fog) = fog {
        for &(x, y) in &tiles {
            if !fog.is_explored(x, y, player_id as usize) {
                return Err("unexplored");
            }
        }
    }
    Ok(rect)
}

/// True when the owner's stockpile covers the full definition cost.
pub fn can_afford(world: &CoreWorld, econ: &EconomyComps, defs: &Defs, player_id: f64, def_id: &str) -> bool {
    can_afford_costs(world, econ, player_id, &defs.building(def_id).costs)
}

/// Block a rect's tiles + bump passabilityVersion (placement-day rule).
pub fn block_footprint_tiles<T>(layers: &mut Layers, paths: &mut PathScheduler<T>, rect: &FootprintRect) {
    let size = layers.size;
    for (x, y) in footprint_tiles(rect.x as i64, rect.y as i64, rect.width as i64, rect.height as i64) {
        layers.passability[y as usize * size + x as usize] = 0;
    }
    let next = paths.passability_version() + 1;
    paths.set_passability_version(next).expect("monotonic version");
}

pub struct PlacementSystem {
    defs: Arc<Defs>,
    bcomps: BuildingComps,
    age: AgeComps,
    pub diagnostics: PlacementDiagnostics,
}

impl PlacementSystem {
    pub fn new(defs: Arc<Defs>, bcomps: BuildingComps, age: AgeComps) -> PlacementSystem {
        PlacementSystem { defs, bcomps, age, diagnostics: PlacementDiagnostics::default() }
    }

    pub fn run<T>(
        &mut self,
        world: &mut CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        layers: &mut Layers,
        paths: &mut PathScheduler<T>,
        commands: &[Command],
        fog: Option<&FogHandle>,
    ) {
        for command in commands {
            if command.kind != PLACE_BUILDING_KIND {
                continue;
            }
            let data = command.data.as_ref().expect("placeBuilding requires command data");
            let parsed = parse_place_data(data);
            // Polite age-gate refusal before the loud verdicts.
            if let Some(def) = self.defs.buildings.get(&parsed.def_id) {
                if !is_def_age_unlocked(world, &self.age, parsed.player_id, &def.age_gate) {
                    append_gate_rejection(
                        world,
                        &self.age,
                        econ,
                        parsed.player_id,
                        world.tick,
                        GATE_HANDLER_PLACE,
                        self.defs.building_code(&parsed.def_id) as f64,
                    );
                    self.diagnostics.gate_rejections += 1;
                    continue;
                }
            }
            let rect = validate_placement(
                world, comps, &self.bcomps, econ, &self.age, &self.defs, layers,
                &parsed.def_id, parsed.tile_x, parsed.tile_y, parsed.player_id, false, fog,
            )
            .unwrap_or_else(|reason| {
                panic!("placeBuilding rejected ({reason}): {} @ ({}, {})", parsed.def_id, parsed.tile_x, parsed.tile_y)
            });
            let costs = self.defs.building(&parsed.def_id).costs.clone();
            pay_costs(world, econ, parsed.player_id, &costs, &format!("placement of {}", parsed.def_id))
                .unwrap_or_else(|e| panic!("{e}"));
            spawn_building_site(world, comps, &self.bcomps, &self.defs, &parsed.def_id, parsed.tile_x, parsed.tile_y, parsed.player_id);
            if parsed.def_id != "farm" {
                block_footprint_tiles(layers, paths, &rect);
            }
            self.diagnostics.commands_applied += 1;
        }
    }
}

/// Bootstrap helper (TS stampFinishedBuilding): validate with
/// bootstrap privilege, block, spawn and immediately complete.
#[allow(clippy::too_many_arguments)]
pub fn stamp_finished_building<T>(
    world: &mut CoreWorld,
    comps: &MovementComps,
    bcomps: &BuildingComps,
    econ: &EconomyComps,
    age: &AgeComps,
    defs: &Defs,
    layers: &mut Layers,
    paths: &mut PathScheduler<T>,
    def_id: &str,
    tile_x: i64,
    tile_y: i64,
    player_id: f64,
) -> Eid {
    let rect = validate_placement(world, comps, bcomps, econ, age, defs, layers, def_id, tile_x, tile_y, player_id, true, None)
        .unwrap_or_else(|reason| panic!("stampFinishedBuilding rejected ({reason}): {def_id} @ ({tile_x}, {tile_y})"));
    if def_id != "farm" {
        block_footprint_tiles(layers, paths, &rect);
    }
    let eid = spawn_building_site(world, comps, bcomps, defs, def_id, tile_x, tile_y, player_id);
    complete_building(world, comps, bcomps, econ, defs, eid);
    eid
}

/// TS traceWallRun: Bresenham line of 1×1 wall tiles.
pub fn trace_wall_run(start_x: i64, start_y: i64, end_x: i64, end_y: i64) -> Vec<(i64, i64)> {
    let mut points = Vec::new();
    let dx = (end_x - start_x).abs();
    let dy = (end_y - start_y).abs();
    let sx = if start_x < end_x { 1 } else { -1 };
    let sy = if start_y < end_y { 1 } else { -1 };
    let mut err = dx - dy;
    let (mut cx, mut cy) = (start_x, start_y);
    loop {
        points.push((cx, cy));
        if cx == end_x && cy == end_y {
            break;
        }
        let e2 = 2 * err;
        if e2 > -dy {
            err -= dy;
            cx += sx;
        }
        if e2 < dx {
            err += dx;
            cy += sy;
        }
    }
    points
}

//! Movement system (SPEC §2.2 / ADR-0003): Rust port of the
//! m1t4-exercised surface of `src/sim/systems/movement.ts` — groupMove
//! leader-path + formation-slot pipeline, activity steering (turn-rate
//! arcs, ease-in, sqrt braking), spatial-hash separation + push-apart,
//! and the Moving/Stalled/Parked FSM with sidestep + re-path.
//!
//! Characterized divergences in this slice (none reachable in m1t4):
//! - guard/garrison steering branches park (speed 0) instead of their
//!   TS behavior — they need building/unit definition tables (E3c/E6).
//! - Per-player gate passability is plain derived passability (no
//!   Building rows exist until E3c placement lands).
//! - Injury/formation-speed multipliers read the same rows TS does and
//!   are neutral while Body/Formation rows are absent, matching TS.
//! - Fog dirty marks are not emitted (no visibility provider in the
//!   Rust core yet, E4); they have no digest-visible effect.
//! - TS quirk preserved by construction: the await-repath set is
//!   created fresh per tick in TS, so it never holds a unit across
//!   ticks; the Rust set is likewise per-tick.
//!
//! The registry is the full 61-name canonical sequence from
//! `defineSimComponents` so digest iteration order matches TS world
//! digests as later epics populate more components.
use crate::activities::{
    cancel_activities, decode_activities, dequeue_current, encode_activities,
    get_last_queued_destination, move_activity, Activity, ActivityQueue,
};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::mapgen::{generate_map, Layers};
use crate::path::{
    has_line_of_sight, PathRequestInput, PathResponse, PathScheduler, PumpEvent, Transport,
};
use crate::trig::{angle_delta, build_sin_cos_lut, det_atan2, det_cos, det_sin, wrap_angle, SinCosLut, HALF_PI};
use std::collections::{HashMap, HashSet};

pub const TICK_DT: f64 = 1.0 / 30.0;
pub const SEPARATION_RADIUS: f64 = 1.0;
pub const SPATIAL_HASH_CELL: f64 = 2.0;
const SEPARATION_DRIFT_RATE: f64 = 1.5;
pub const STALL_SIDESTEP_TICKS: f64 = 45.0;
pub const AVOIDANCE_COMMIT_TICKS: f64 = 21.0;
const ACCEL_TILES_PER_S2: f64 = 3.0;
const BRAKE_DECEL_TILES_PER_S2: f64 = 2.0;
const WAYPOINT_REACH_RADIUS: f64 = 0.35;
const FINAL_ARRIVAL_RADIUS: f64 = 0.08;
const APPROACH_RADIUS: f64 = 0.4;
const ARRIVAL_GRACE_TICKS: f64 = 20.0;
const SIDESTEP_DISTANCE: f64 = 0.6;
const PROGRESS_EPSILON: f64 = 1e-4;
const NET_PROGRESS_SMOOTHING: f64 = 0.1;
const NET_PROGRESS_EPSILON: f64 = 0.005;
const STALL_DECAY_PER_TICK: f64 = 3.0;
const PARKED_CONTACT_MARGIN: f64 = 0.25;
const TURN_SLOW_MIN: f64 = 0.35;
pub const SLOT_LUT_SIZE: usize = 256;
pub const SLOT_RING_SPACING: f64 = 0.9;
pub const DEFAULT_UNIT_SPEED: f64 = 1.0;
pub const DEFAULT_UNIT_RADIUS: f64 = 0.25;
const TURN_RATE_MIN: f64 = 5.5;
const TURN_RATE_VARIANCE: f64 = 3.0;

// Velocity row layout (8 slots).
const V_HEADING: usize = 0;
const V_SPEED: usize = 1;
const V_STALLED_TICKS: usize = 2;
const V_PARK_CONTACT_TICKS: usize = 3;
const V_CLOSE_TICKS: usize = 4;
const V_AVOID_SIDE: usize = 5;
const V_AVOID_TICKS_LEFT: usize = 6;
const V_PROPAGATION_PARKED: usize = 7;
const T_RADIUS: usize = 2;

/// Canonical registry sequence from `defineSimComponents` (61 names).
pub const SIM_COMPONENTS: [&str; 61] = [
    "ActivityQueue", "AgeAdvanced", "AgeResearch", "AgeState", "ApprovalMode", "AssignedNode",
    "AssignedSite", "Body", "Branch", "BranchOutputLedger", "Building", "BuildingSite",
    "CarryCapacity", "Combat", "CombatEvents", "CommodityStockpile", "Company", "CompanyOrigin",
    "DropOff", "Equipment", "ExpansionLog", "Faith", "Foreman", "Formation", "Garrison",
    "GateRejected", "Household", "Identity", "Inventory", "JobCooldown", "KnowledgePoints",
    "Lessons", "ManagementSkill", "Manager", "MealConsumed", "Morale", "MoveTarget", "Needs",
    "OrderLock", "Owner", "PendingExpansion", "Position", "PrestigeLedger", "ProductionCycle",
    "ProductionJob", "Relationship", "Relic", "ResearchedTechs", "ResourceNode", "Rubble",
    "Skills", "SocialEvents", "Stance", "Stockpile", "StrategySliders", "TrainQueue", "Traits",
    "TreasuryDelta", "UnitTag", "Velocity", "VictoryCheck",
];

#[derive(Clone, Copy)]
pub struct MovementComps {
    pub activity_queue: usize,
    pub formation: usize,
    pub move_target: usize,
    pub owner: usize,
    pub position: usize,
    pub unit_tag: usize,
    pub velocity: usize,
}

pub fn define_sim_components(world: &mut CoreWorld) -> MovementComps {
    let mut ids = std::collections::HashMap::new();
    for name in SIM_COMPONENTS {
        let id = world.define_component(name).expect("canonical registry order");
        ids.insert(name, id);
    }
    MovementComps {
        activity_queue: ids["ActivityQueue"],
        formation: ids["Formation"],
        move_target: ids["MoveTarget"],
        owner: ids["Owner"],
        position: ids["Position"],
        unit_tag: ids["UnitTag"],
        velocity: ids["Velocity"],
    }
}

fn default_turn_rate(seed: u32, eid: Eid) -> f64 {
    let mut z = seed ^ (eid as u32).wrapping_mul(0x9e37_79b9);
    if z == 0 {
        z = 0x1;
    }
    z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
    z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
    let unit = ((z ^ (z >> 15)) as f64) / 4_294_967_296.0;
    TURN_RATE_MIN + unit * TURN_RATE_VARIANCE
}

/// Spawn one movable Pop with every movement component attached
/// (defaults only; identity/body/morale opt-ins land with later epics).
pub fn spawn_unit(world: &mut CoreWorld, comps: &MovementComps, x: f64, y: f64) -> Eid {
    spawn_unit_with_speed(world, comps, x, y, DEFAULT_UNIT_SPEED)
}

/// TS spawnUnit with an explicit `baseSpeed` (training passes the unit
/// definition's speed; everything else keeps the spawn defaults).
pub fn spawn_unit_with_speed(world: &mut CoreWorld, comps: &MovementComps, x: f64, y: f64, base_speed: f64) -> Eid {
    let eid = world.spawn();
    world.set_values(comps.position, eid, &[x, y]).unwrap();
    world.set_values(comps.velocity, eid, &[0.0; 8]).unwrap();
    world
        .set_values(
            comps.unit_tag,
            eid,
            &[base_speed, default_turn_rate(world.seed, eid), DEFAULT_UNIT_RADIUS],
        )
        .unwrap();
    world.set_values(comps.move_target, eid, &[x, y]).unwrap();
    world
        .set_values(comps.activity_queue, eid, &encode_activities(&[]).unwrap())
        .unwrap();
    // Fog "spawned" mark (TS spawnUnit): stamped at the next flush.
    world.fog_spawned.push(eid);
    eid
}

pub fn formation_slot_offset(lut: &SinCosLut, index: usize) -> (f64, f64) {
    if index == 0 {
        return (0.0, 0.0);
    }
    let mut ring = 1usize;
    let mut position_in_ring = index - 1;
    while position_in_ring >= 8 * ring {
        position_in_ring -= 8 * ring;
        ring += 1;
    }
    let count_in_ring = 8 * ring;
    let half_step = SLOT_LUT_SIZE / (2 * count_in_ring);
    let lut_index =
        ((position_in_ring * SLOT_LUT_SIZE) / count_in_ring + (ring % 2) * half_step) % SLOT_LUT_SIZE;
    (
        lut.cos[lut_index] * SLOT_RING_SPACING * ring as f64,
        lut.sin[lut_index] * SLOT_RING_SPACING * ring as f64,
    )
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
pub struct MovementDiagnostics {
    pub sidesteps: u64,
    pub repaths: u64,
    pub group_moves: u64,
}

pub(crate) fn reset_steering_bookkeeping(vel: &mut [f64]) {
    vel[V_STALLED_TICKS] = 0.0;
    vel[V_PARK_CONTACT_TICKS] = 0.0;
    vel[V_CLOSE_TICKS] = 0.0;
    vel[V_PROPAGATION_PARKED] = 0.0;
}

/// TS isSteeringJammed: deep stall, parked contact, or propagation-parked.
pub(crate) fn is_steering_jammed(vel: &[f64]) -> bool {
    vel[V_STALLED_TICKS] >= 30.0 || vel[V_PARK_CONTACT_TICKS] >= 15.0 || vel[V_PROPAGATION_PARKED] != 0.0
}

fn derive_path_seed(world_seed: u32, start_tile: i64, goal_tile: i64, issue_tick: u64) -> u32 {
    let mut z = world_seed
        ^ (start_tile as u32).wrapping_mul(0x85eb_ca6b)
        ^ (goal_tile as u32).wrapping_mul(0xc2b2_ae35)
        ^ (issue_tick as u32).wrapping_mul(0x27d4_eb2f);
    if z == 0 {
        z = 0x1;
    }
    z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
    z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
    z ^ (z >> 15)
}

pub(crate) fn tile_is_passable(passability: &[u8], size: usize, x: i64, y: i64) -> bool {
    if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
        return false;
    }
    passability[y as usize * size + x as usize] == 1
}

pub(crate) fn nearest_passable_tile(passability: &[u8], size: usize, tx: i64, ty: i64) -> Option<(i64, i64)> {
    let clamped_x = tx.clamp(0, size as i64 - 1);
    let clamped_y = ty.clamp(0, size as i64 - 1);
    for radius in 0..=(size as i64) {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs().max(dy.abs()) != radius {
                    continue;
                }
                let (x, y) = (clamped_x + dx, clamped_y + dy);
                if tile_is_passable(passability, size, x, y) {
                    return Some((x, y));
                }
            }
        }
    }
    None
}

// ---- row helpers -----------------------------------------------------------

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}
fn row_mut(world: &mut CoreWorld, component: usize, eid: Eid) -> Option<&mut Vec<f64>> {
    world.rows_by_component.get_mut(component).and_then(|r| r.get_mut(&eid))
}
fn set_row(world: &mut CoreWorld, component: usize, eid: Eid, values: Vec<f64>) {
    world.set_values(component, eid, &values).expect("registered component");
}
fn vel_get(world: &CoreWorld, comps: &MovementComps, eid: Eid, slot: usize) -> f64 {
    row(world, comps.velocity, eid).expect("velocity row")[slot]
}
fn vel_set(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, slot: usize, value: f64) {
    row_mut(world, comps.velocity, eid).expect("velocity row")[slot] = value;
}
pub(crate) fn read_queue(world: &CoreWorld, comps: &MovementComps, eid: Eid) -> ActivityQueue {
    match row(world, comps.activity_queue, eid) {
        Some(r) => decode_activities(r).expect("activity row decodes"),
        None => Vec::new(),
    }
}
pub(crate) fn write_queue(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, queue: &[Activity]) {
    assert!(row(world, comps.activity_queue, eid).is_some(), "entity {eid} has no ActivityQueue row");
    set_row(world, comps.activity_queue, eid, encode_activities(queue).expect("queue encodes"));
}
fn get_move_target(world: &CoreWorld, comps: &MovementComps, eid: Eid) -> Option<(f64, f64)> {
    row(world, comps.move_target, eid).map(|r| (r[0], r[1]))
}
fn get_harmonized_speed(world: &CoreWorld, comps: &MovementComps, eid: Eid) -> f64 {
    row(world, comps.formation, eid).and_then(|r| r.get(1).copied()).unwrap_or(0.0)
}
fn clear_harmonized_speed(world: &mut CoreWorld, comps: &MovementComps, eid: Eid) {
    if let Some(r) = row_mut(world, comps.formation, eid) {
        if r.len() > 1 {
            r[1] = 0.0;
        }
    }
}

// ---- formations (components/formation.ts) ------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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
    pub fn code(self) -> f64 {
        match self {
            FormationKind::Line => 0.0,
            FormationKind::Box => 1.0,
            FormationKind::Staggered => 2.0,
            FormationKind::Flank => 3.0,
            FormationKind::ShieldWall => 4.0,
            FormationKind::Square => 5.0,
            FormationKind::Circle => 6.0,
            FormationKind::Wedge => 7.0,
        }
    }
    pub fn from_code(code: f64) -> FormationKind {
        match code {
            1.0 => FormationKind::Box,
            2.0 => FormationKind::Staggered,
            3.0 => FormationKind::Flank,
            4.0 => FormationKind::ShieldWall,
            5.0 => FormationKind::Square,
            6.0 => FormationKind::Circle,
            7.0 => FormationKind::Wedge,
            _ => FormationKind::Line,
        }
    }
    pub fn parse(value: Option<&str>) -> FormationKind {
        match value {
            Some("box") => FormationKind::Box,
            Some("staggered") => FormationKind::Staggered,
            Some("flank") => FormationKind::Flank,
            Some("shieldWall") => FormationKind::ShieldWall,
            Some("square") => FormationKind::Square,
            Some("circle") => FormationKind::Circle,
            Some("wedge") => FormationKind::Wedge,
            _ => FormationKind::Line,
        }
    }
}

fn get_formation(world: &CoreWorld, comps: &MovementComps, eid: Eid) -> FormationKind {
    match row(world, comps.formation, eid) {
        Some(r) => FormationKind::from_code(r.first().copied().unwrap_or(0.0)),
        None => FormationKind::Line,
    }
}

fn set_formation(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, formation: FormationKind) {
    let current_speed = get_harmonized_speed(world, comps, eid);
    set_row(world, comps.formation, eid, vec![formation.code(), current_speed]);
}

fn set_harmonized_speed(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, speed: f64) {
    let current_formation = row(world, comps.formation, eid)
        .and_then(|r| r.first().copied())
        .unwrap_or(0.0);
    set_row(world, comps.formation, eid, vec![current_formation, speed.max(0.0)]);
}

pub fn calculate_formation_offset(formation: FormationKind, index: usize, total_count: usize, heading: f64) -> (f64, f64) {
    if total_count <= 1 {
        return (0.0, 0.0);
    }
    let forward: f64;
    let lateral: f64;
    let idx = index as f64;
    let total = total_count as f64;
    match formation {
        FormationKind::Line => {
            let units_per_rank = (total * 2.0).sqrt().ceil().clamp(4.0, 10.0);
            let rank = (idx / units_per_rank).floor();
            let col = idx % units_per_rank;
            let count_in_rank = units_per_rank.min(total - rank * units_per_rank);
            lateral = (col - (count_in_rank - 1.0) / 2.0) * 1.0;
            forward = -rank * 1.0;
        }
        FormationKind::Box => {
            if total_count <= 4 {
                let angles = [0.0, std::f64::consts::PI / 2.0, std::f64::consts::PI, 3.0 * std::f64::consts::PI / 2.0];
                let a = angles[index % 4];
                forward = det_cos(a) * 1.2;
                lateral = det_sin(a) * 1.2;
            } else {
                let side = (total / 4.0).ceil();
                let perimeter_index = idx % (side * 4.0);
                let wall = (perimeter_index / side).floor();
                let pos = (perimeter_index % side) - (side - 1.0) / 2.0;
                let half_side = (side * 0.9) / 2.0;
                if wall == 0.0 {
                    forward = half_side;
                    lateral = pos * 0.9;
                } else if wall == 1.0 {
                    forward = -pos * 0.9;
                    lateral = half_side;
                } else if wall == 2.0 {
                    forward = -half_side;
                    lateral = -pos * 0.9;
                } else {
                    forward = pos * 0.9;
                    lateral = -half_side;
                }
            }
        }
        FormationKind::Staggered => {
            let cols = (total * 1.5).sqrt().ceil();
            let rank = (idx / cols).floor();
            let col = idx % cols;
            let stagger = (rank % 2.0) * 1.0;
            lateral = (col - (cols - 1.0) / 2.0) * 2.0 + stagger;
            forward = -rank * 2.0;
        }
        FormationKind::Flank => {
            let half = (total / 2.0).ceil();
            let is_right = idx >= half;
            let rank_idx = if is_right { idx - half } else { idx };
            let wing_center = if is_right { 3.5 } else { -3.5 };
            let col = rank_idx % 2.0;
            let rank = (rank_idx / 2.0).floor();
            lateral = wing_center + (col - 0.5) * 1.0;
            forward = -rank * 1.0;
        }
        FormationKind::ShieldWall => {
            let units_per_rank = (total / 2.0).ceil().clamp(4.0, 8.0);
            let rank = (idx / units_per_rank).floor();
            let col = idx % units_per_rank;
            let count_in_rank = units_per_rank.min(total - rank * units_per_rank);
            lateral = (col - (count_in_rank - 1.0) / 2.0) * 0.65;
            forward = -rank * 0.7;
        }
        FormationKind::Square => {
            let side = total.sqrt().ceil();
            let rank = (idx / side).floor();
            let col = idx % side;
            lateral = (col - (side - 1.0) / 2.0) * 0.95;
            forward = -(rank - (side - 1.0) / 2.0) * 0.95;
        }
        FormationKind::Circle => {
            let radius = (total * 0.22).max(1.2);
            let angle = (idx / total) * 2.0 * std::f64::consts::PI;
            lateral = det_sin(angle) * radius;
            forward = det_cos(angle) * radius;
        }
        FormationKind::Wedge => {
            if index == 0 {
                lateral = 0.0;
                forward = 0.0;
            } else {
                let row = idx.sqrt().ceil();
                let first_in_row = (row - 1.0) * (row - 1.0) + 1.0;
                let pos_in_row = idx - first_in_row;
                let side_offset =
                    (if (pos_in_row as i64) % 2 == 0 { 1.0 } else { -1.0 }) * ((pos_in_row + 1.0) / 2.0).ceil();
                lateral = side_offset * 0.9;
                forward = -row * 1.0;
            }
        }
    }
    let cos_h = det_cos(heading);
    let sin_h = det_sin(heading);
    (forward * cos_h - lateral * sin_h, forward * sin_h + lateral * cos_h)
}

// ---- group route pipeline ----------------------------------------------------

#[derive(Clone)]
struct MemberSnap {
    eid: Eid,
    start_x: f64,
    start_y: f64,
}

pub enum Continuation {
    GroupRoute(Box<GroupRouteCont>),
    Repath { eid: Eid, dest: (f64, f64) },
    /// TS onDiscard for repaths only removed the eid from the issuing
    /// tick's (already discarded) await set — unobservable; kept for
    /// structural fidelity.
    DiscardRepath,
}

pub struct GroupRouteCont {
    members: Vec<MemberSnap>,
    ordered: Vec<usize>, // indices into members, leader first
    dest_x: f64,
    dest_y: f64,
    goal: (i64, i64),
    passability: Vec<u8>,
    queue: bool,
    formation: Option<FormationKind>,
    /// TS hooks.buildHead: plain Move heads for groupMove, AttackMove
    /// heads for combat's formation attack-move (M2-T6).
    head_attack_move: bool,
}

pub struct GroupRouteOrder {
    pub entity_ids: Vec<Eid>,
    pub x: f64,
    pub y: f64,
    pub queue: bool,
    pub formation: Option<FormationKind>,
}

fn parse_group_move_data(data: &serde_json::Value) -> GroupRouteOrder {
    let raw_ids = data.get("entityIds").and_then(|v| v.as_array());
    let raw_ids = raw_ids.filter(|a| !a.is_empty()).expect("groupMove requires a non-empty entityIds array");
    let mut entity_ids: Vec<Eid> = Vec::new();
    for id in raw_ids {
        let id = id
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .unwrap_or_else(|| panic!("groupMove entityIds entries must be positive integers, got {id}"));
        if !entity_ids.contains(&id) {
            entity_ids.push(id);
        }
    }
    entity_ids.sort();
    let x = data.get("x").and_then(|v| v.as_f64()).filter(|v| v.is_finite());
    let y = data.get("y").and_then(|v| v.as_f64()).filter(|v| v.is_finite());
    let (Some(x), Some(y)) = (x, y) else {
        panic!("groupMove requires finite numeric x/y destination")
    };
    GroupRouteOrder {
        entity_ids,
        x,
        y,
        queue: data.get("queue").and_then(|v| v.as_bool()) == Some(true),
        formation: data
            .get("formation")
            .and_then(|v| v.as_str())
            .map(|s| FormationKind::parse(Some(s))),
    }
}

fn issue_group_route(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    passability: &[u8],
    paths: &mut PathScheduler<Continuation>,
    order: &GroupRouteOrder,
) {
    issue_group_route_ex(world, comps, size, passability, paths, order, false, None);
}

/// Shared leader-path + formation-slot pipeline (TS issueGroupRoute).
/// `on_issue` fires per member at issue time when the order is not
/// queued and the route resolved; `head_attack_move` selects the
/// applied head activity kind.
#[allow(clippy::too_many_arguments)]
pub(crate) fn issue_group_route_ex(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    passability: &[u8],
    paths: &mut PathScheduler<Continuation>,
    order: &GroupRouteOrder,
    head_attack_move: bool,
    mut on_issue: Option<&mut dyn FnMut(&mut CoreWorld, Eid)>,
) {
    let (x, y) = (order.x, order.y);
    let mut members: Vec<MemberSnap> = Vec::new();
    for &eid in &order.entity_ids {
        let (Some(pos), Some(_vel), Some(_queue)) = (
            row(world, comps.position, eid),
            row(world, comps.velocity, eid),
            row(world, comps.activity_queue, eid),
        ) else {
            continue;
        };
        let (px, py) = (pos[0], pos[1]);
        let (mut start_x, mut start_y) = (px, py);
        if order.queue {
            let q = read_queue(world, comps, eid);
            let dest = get_last_queued_destination(&q, start_x, start_y);
            start_x = dest.0;
            start_y = dest.1;
        }
        members.push(MemberSnap { eid, start_x, start_y });
        let _ = (px, py);
    }
    if members.is_empty() {
        return;
    }
    let mut centroid_x = 0.0;
    let mut centroid_y = 0.0;
    for m in &members {
        centroid_x += m.start_x;
        centroid_y += m.start_y;
    }
    centroid_x /= members.len() as f64;
    centroid_y /= members.len() as f64;
    let mut leader_index = 0usize;
    let mut leader_distance_sq = f64::INFINITY;
    for (i, m) in members.iter().enumerate() {
        let dx = m.start_x - centroid_x;
        let dy = m.start_y - centroid_y;
        let d2 = dx * dx + dy * dy;
        if d2 < leader_distance_sq {
            leader_distance_sq = d2;
            leader_index = i;
        }
    }
    let leader = members[leader_index].clone();
    let start_tile_x = (leader.start_x.floor() as i64).clamp(0, size as i64 - 1);
    let start_tile_y = (leader.start_y.floor() as i64).clamp(0, size as i64 - 1);
    if !tile_is_passable(passability, size, start_tile_x, start_tile_y) {
        return;
    }
    let Some(goal) = nearest_passable_tile(passability, size, x.floor() as i64, y.floor() as i64) else {
        return;
    };
    if !order.queue {
        if let Some(hook) = on_issue.as_deref_mut() {
            let member_eids: Vec<Eid> = members.iter().map(|m| m.eid).collect();
            for eid in member_eids {
                hook(world, eid);
            }
        }
    }
    let mut ordered: Vec<usize> = vec![leader_index];
    for i in 0..members.len() {
        if i != leader_index {
            ordered.push(i);
        }
    }
    let leader_formation_row = row(world, comps.formation, leader.eid).is_some();
    let active_formation = order
        .formation
        .or(if leader_formation_row { Some(get_formation(world, comps, leader.eid)) } else { None });
    if let (Some(kind), true) = (active_formation, members.len() > 1) {
        let mut min_speed = f64::INFINITY;
        for m in &members {
            let raw_base = row(world, comps.unit_tag, m.eid).map(|t| t[0]).unwrap_or(2.5);
            let sw_mult = if kind == FormationKind::ShieldWall { 0.8 } else { 1.0 };
            let spd = raw_base * sw_mult; // injury impairment: no Body rows ⇒ neutral 1.0
            if spd < min_speed {
                min_speed = spd;
            }
        }
        if min_speed > 0.0 && min_speed.is_finite() {
            for m in &members {
                set_harmonized_speed(world, comps, m.eid, min_speed);
            }
        }
    }
    let cont = GroupRouteCont {
        members,
        ordered,
        dest_x: x,
        dest_y: y,
        goal,
        passability: passability.to_vec(),
        queue: order.queue,
        formation: active_formation,
        head_attack_move,
    };
    paths.request_path(
        &PathRequestInput { start_x: start_tile_x, start_y: start_tile_y, goal_x: goal.0, goal_y: goal.1 },
        world.tick,
        derive_path_seed(world.seed, start_tile_y * size as i64 + start_tile_x, goal.1 * size as i64 + goal.0, world.tick),
        passability,
        Continuation::GroupRoute(Box::new(cont)),
        None,
    );
}

fn apply_group_route(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    lut: &SinCosLut,
    diagnostics: &mut MovementDiagnostics,
    cont: &GroupRouteCont,
    response: &PathResponse,
) {
    if !response.ok {
        return;
    }
    diagnostics.group_moves += 1;
    let mut shared_waypoints: Vec<f64> = Vec::new();
    let mut k = 0;
    while k < response.waypoints.len() {
        shared_waypoints.push(response.waypoints[k] as f64 + 0.5);
        shared_waypoints.push(response.waypoints[k + 1] as f64 + 0.5);
        k += 2;
    }
    let leader = &cont.members[cont.ordered[0]];
    let travel_angle = det_atan2(cont.goal.1 as f64 - leader.start_y, cont.goal.0 as f64 - leader.start_x);
    for (slot_index, &member_index) in cont.ordered.iter().enumerate() {
        let member = &cont.members[member_index];
        let (odx, ody) = match cont.formation {
            Some(kind) => calculate_formation_offset(kind, slot_index, cont.ordered.len(), travel_angle),
            None => formation_slot_offset(lut, slot_index),
        };
        let final_x = cont.dest_x + odx;
        let final_y = cont.dest_y + ody;
        if row(world, comps.velocity, member.eid).is_none() {
            continue;
        }
        let los = slot_index > 0
            && has_line_of_sight(
                &cont.passability,
                size,
                member.start_x.floor() as i64,
                member.start_y.floor() as i64,
                final_x.floor() as i64,
                final_y.floor() as i64,
            )
            .unwrap_or(false);
        let waypoints: Vec<f64> = if los {
            vec![final_x, final_y]
        } else {
            let mut wp: Vec<f64> = shared_waypoints[..shared_waypoints.len() - 2].to_vec();
            wp.push(final_x);
            wp.push(final_y);
            wp
        };
        let head = if cont.head_attack_move {
            Activity::AttackMove { waypoints: waypoints.clone(), cursor: 0 }
        } else {
            move_activity(&waypoints).expect("move waypoints")
        };
        let existing = read_queue(world, comps, member.eid);
        if cont.queue && !existing.is_empty() {
            let mut q = existing;
            q.push(head);
            write_queue(world, comps, member.eid, &q);
        } else {
            let vel = row_mut(world, comps.velocity, member.eid).expect("vel row");
            reset_steering_bookkeeping(vel);
            write_queue(world, comps, member.eid, &[head]);
            set_row(world, comps.move_target, member.eid, vec![final_x, final_y]);
        }
    }
}

fn apply_repath(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, dest: (f64, f64), response: &PathResponse) {
    let Some(dest_now) = get_move_target(world, comps, eid) else { return };
    if dest_now.0 != dest.0 || dest_now.1 != dest.1 {
        return;
    }
    let mut queue = read_queue(world, comps, eid);
    match queue.first_mut() {
        Some(Activity::Move { .. }) | Some(Activity::AttackMove { .. }) => {}
        _ => return,
    }
    if !response.ok {
        cancel_activities(&mut queue);
        write_queue(world, comps, eid, &queue);
        return;
    }
    let mut waypoints: Vec<f64> = Vec::new();
    let mut k = 2;
    while k < response.waypoints.len() {
        waypoints.push(response.waypoints[k] as f64 + 0.5);
        waypoints.push(response.waypoints[k + 1] as f64 + 0.5);
        k += 2;
    }
    if waypoints.len() < 2 {
        waypoints.push(dest.0);
        waypoints.push(dest.1);
    } else {
        let n = waypoints.len();
        waypoints[n - 2] = dest.0;
        waypoints[n - 1] = dest.1;
    }
    if let Some((wp, cursor)) = queue.first_mut().and_then(|h| h.waypoints_mut()) {
        *wp = waypoints;
        *cursor = 0;
    }
    write_queue(world, comps, eid, &queue);
    vel_set(world, comps, eid, V_CLOSE_TICKS, 0.0);
}

// ---- steering ----------------------------------------------------------------

struct UnitState {
    eid: Eid,
    x: f64,
    y: f64,
    heading: f64,
    speed: f64,
    radius: f64,
    tick_start_x: f64,
    tick_start_y: f64,
    desired_dir_x: f64,
    desired_dir_y: f64,
    in_approach_zone: bool,
    ema_net_x: f64,
    ema_net_y: f64,
    progressed: bool,
    contact_with_parked: bool,
    acc_sep_x: f64,
    acc_sep_y: f64,
    queue: ActivityQueue,
    queue_dirty: bool,
    despawned: bool,
}

fn is_movement_head(queue: &[Activity]) -> bool {
    matches!(queue.first(), Some(a) if a.is_movement_head())
}

fn is_steerable(world: &CoreWorld, comps: &MovementComps, unit: &UnitState) -> bool {
    is_movement_head(&unit.queue) && vel_get(world, comps, unit.eid, V_PROPAGATION_PARKED) == 0.0
}

fn try_move(world: &mut CoreWorld, comps: &MovementComps, unit: &mut UnitState, nx: f64, ny: f64, passability: &[u8], size: usize) {
    let tx = nx.floor() as i64;
    let ty = ny.floor() as i64;
    let set_pos = |world: &mut CoreWorld, unit: &mut UnitState, x: Option<f64>, y: Option<f64>| {
        if let Some(x) = x {
            unit.x = x;
        }
        if let Some(y) = y {
            unit.y = y;
        }
        let pos = row_mut(world, comps.position, unit.eid).expect("position row");
        pos[0] = unit.x;
        pos[1] = unit.y;
    };
    if tile_is_passable(passability, size, tx, ty) {
        set_pos(world, unit, Some(nx), Some(ny));
        return;
    }
    if tile_is_passable(passability, size, tx, unit.y.floor() as i64) {
        set_pos(world, unit, Some(nx), None);
        return;
    }
    if tile_is_passable(passability, size, unit.x.floor() as i64, ty) {
        set_pos(world, unit, None, Some(ny));
    }
}

#[allow(clippy::too_many_arguments)]
fn request_repath(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    passability: &[u8],
    paths: &mut PathScheduler<Continuation>,
    diagnostics: &mut MovementDiagnostics,
    await_repath: &mut HashSet<Eid>,
    eid: Eid,
    unit_x: f64,
    unit_y: f64,
    head_is_movement: bool,
) {
    diagnostics.repaths += 1;
    let dest = get_move_target(world, comps, eid);
    let Some(dest) = dest else { return };
    if !head_is_movement {
        return;
    }
    let start_x = unit_x.floor() as i64;
    let start_y = unit_y.floor() as i64;
    let goal_x = dest.0.floor() as i64;
    let goal_y = dest.1.floor() as i64;
    await_repath.insert(eid);
    paths.request_path(
        &PathRequestInput { start_x, start_y, goal_x, goal_y },
        world.tick,
        derive_path_seed(world.seed, start_y * size as i64 + start_x, goal_y * size as i64 + goal_x, world.tick),
        passability,
        Continuation::Repath { eid, dest },
        Some(Continuation::DiscardRepath),
    );
}

#[allow(clippy::too_many_arguments)]
fn sidestep_and_repath(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    passability: &[u8],
    paths: &mut PathScheduler<Continuation>,
    diagnostics: &mut MovementDiagnostics,
    await_repath: &mut HashSet<Eid>,
    units: &mut [UnitState],
    unit_index: usize,
) {
    diagnostics.sidesteps += 1;
    let (eid, ux, uy, heading, radius) = {
        let u = &units[unit_index];
        (u.eid, u.x, u.y, u.heading, u.radius)
    };
    let mut preferred_side = vel_get(world, comps, eid, V_AVOID_SIDE);
    if preferred_side == 0.0 {
        preferred_side = if world.prng.next_float() < 0.5 { -1.0 } else { 1.0 };
    }
    let perp_x = -det_sin(heading) * SIDESTEP_DISTANCE;
    let perp_y = det_cos(heading) * SIDESTEP_DISTANCE;
    for side in [preferred_side, -preferred_side] {
        let nx = ux + perp_x * side;
        let ny = uy + perp_y * side;
        if !tile_is_passable(passability, size, nx.floor() as i64, ny.floor() as i64) {
            continue;
        }
        let mut occupied = false;
        for (j, other) in units.iter().enumerate() {
            if j == unit_index {
                continue;
            }
            let ddx = other.x - nx;
            let ddy = other.y - ny;
            let clear = other.radius + radius + PARKED_CONTACT_MARGIN;
            if ddx * ddx + ddy * ddy < clear * clear {
                occupied = true;
                break;
            }
        }
        if occupied {
            continue;
        }
        units[unit_index].x = nx;
        units[unit_index].y = ny;
        let pos = row_mut(world, comps.position, eid).expect("position row");
        pos[0] = nx;
        pos[1] = ny;
        vel_set(world, comps, eid, V_AVOID_SIDE, side);
        vel_set(world, comps, eid, V_AVOID_TICKS_LEFT, AVOIDANCE_COMMIT_TICKS);
        break;
    }
    let (nx, ny, head) = {
        let u = &units[unit_index];
        (u.x, u.y, is_movement_head(&u.queue))
    };
    request_repath(world, comps, size, passability, paths, diagnostics, await_repath, eid, nx, ny, head);
}

// ---- the system ----------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn movement_system(
    world: &mut CoreWorld,
    comps: &MovementComps,
    size: usize,
    passability: &[u8],
    paths: &mut PathScheduler<Continuation>,
    diagnostics: &mut MovementDiagnostics,
    commands: &[Command],
) {
    let dt = TICK_DT;

    // 1) Commands on their target boundary.
    for command in commands {
        if command.kind == "groupMove" {
            let data = command.data.clone().expect("groupMove requires command data");
            let order = parse_group_move_data(&data);
            issue_group_route(world, comps, size, passability, paths, &order);
        } else if command.kind == "setFormation" {
            let data = command.data.clone().expect("setFormation requires command data");
            let formation = FormationKind::parse(data.get("formation").and_then(|v| v.as_str()));
            let raw = data.get("entityIds").or_else(|| data.get("ids")).and_then(|v| v.as_array());
            if let Some(ids) = raw {
                for id in ids {
                    if let Some(eid) = id.as_i64().filter(|v| *v > 0) {
                        set_formation(world, comps, eid, formation);
                    }
                }
            }
        }
    }

    // Collect live units ascending with decoded queues.
    let mut units: Vec<UnitState> = Vec::new();
    for &eid in &world.entities.clone() {
        let (Some(pos), Some(vel), Some(tag)) = (
            row(world, comps.position, eid),
            row(world, comps.velocity, eid),
            row(world, comps.unit_tag, eid),
        ) else {
            continue;
        };
        let (px, py, heading, speed, radius) = (pos[0], pos[1], vel[V_HEADING], vel[V_SPEED], tag[T_RADIUS]);
        units.push(UnitState {
            eid,
            x: px,
            y: py,
            heading,
            speed,
            radius,
            tick_start_x: 0.0,
            tick_start_y: 0.0,
            desired_dir_x: 0.0,
            desired_dir_y: 0.0,
            in_approach_zone: false,
            ema_net_x: 0.0,
            ema_net_y: 0.0,
            progressed: false,
            contact_with_parked: false,
            acc_sep_x: 0.0,
            acc_sep_y: 0.0,
            queue: read_queue(world, comps, eid),
            queue_dirty: false,
            despawned: false,
        });
    }

    // 2) Spatial hash (2-tile cells).
    let mut cells: HashMap<i64, Vec<Eid>> = HashMap::new();
    for unit in &units {
        let cx = ((unit.x / SPATIAL_HASH_CELL).floor() as i64).max(0);
        let cy = ((unit.y / SPATIAL_HASH_CELL).floor() as i64).max(0);
        cells.entry(cx * 4096 + cy).or_default().push(unit.eid);
    }
    let mut index_by_eid: HashMap<Eid, usize> = HashMap::new();
    for (i, unit) in units.iter().enumerate() {
        index_by_eid.insert(unit.eid, i);
    }
    let gather_neighbors = |cells: &HashMap<i64, Vec<Eid>>, unit: &UnitState| -> Vec<Eid> {
        let mut out = Vec::new();
        let base_cx = ((unit.x / SPATIAL_HASH_CELL).floor() as i64).max(0);
        let base_cy = ((unit.y / SPATIAL_HASH_CELL).floor() as i64).max(0);
        for dcx in -1..=1i64 {
            for dcy in -1..=1i64 {
                let (cx, cy) = (base_cx + dcx, base_cy + dcy);
                if cx < 0 || cy < 0 {
                    continue;
                }
                if let Some(bucket) = cells.get(&(cx * 4096 + cy)) {
                    out.extend_from_slice(bucket);
                }
            }
        }
        out
    };

    let mut await_repath: HashSet<Eid> = HashSet::new();

    // 3) Steering + integration, ascending eid.
    for idx in 0..units.len() {
        units[idx].heading = vel_get(world, comps, units[idx].eid, V_HEADING);
        units[idx].speed = vel_get(world, comps, units[idx].eid, V_SPEED);
        let head_kind = units[idx].queue.first().map(|a| a.kind_name());
        let parked = matches!(
            head_kind,
            None | Some("wait") | Some("gather") | Some("deliver") | Some("attack") | Some("eat")
                | Some("sleep") | Some("leisure") | Some("pack") | Some("convert")
                | Some("guard") | Some("garrison") // divergence: parked (E6), unexercised in m1t4
        );
        if parked {
            let mut dequeued = false;
            if let Some(Activity::Wait { ticks }) = units[idx].queue.first_mut() {
                *ticks -= 1.0;
                dequeued = *ticks <= 0.0;
                units[idx].queue_dirty = true;
            }
            if dequeued {
                dequeue_current(&mut units[idx].queue);
            }
            units[idx].speed = 0.0;
            continue;
        }
        let eid = units[idx].eid;
        if vel_get(world, comps, eid, V_PROPAGATION_PARKED) != 0.0 {
            units[idx].speed = 0.0;
            continue;
        }
        if await_repath.contains(&eid) {
            units[idx].speed = 0.0;
            vel_set(world, comps, eid, V_SPEED, 0.0);
            continue;
        }

        // Movement head below. baseSpeed with formation harmonization.
        let formation_row = row(world, comps.formation, eid).is_some();
        let active_formation = if formation_row { Some(get_formation(world, comps, eid)) } else { None };
        let shield_mult = if active_formation == Some(FormationKind::ShieldWall) { 0.8 } else { 1.0 };
        let tag = row(world, comps.unit_tag, eid).expect("tag row").clone();
        let mut base_speed = tag[0] * shield_mult; // injury impairment neutral (no Body rows)
        let harmonized = get_harmonized_speed(world, comps, eid);
        if harmonized > 0.0 && harmonized < base_speed {
            base_speed = harmonized;
        }
        let turn_rate = tag[1];

        // Consume reached intermediate waypoints.
        {
            let unit = &mut units[idx];
            loop {
                enum Step {
                    Advance,
                    ReversePatrol,
                    Done,
                }
                let step = {
                    let head = unit.queue.first().expect("movement head");
                    let (waypoints, cursor, direction) = match head {
                        Activity::Move { waypoints, cursor } | Activity::AttackMove { waypoints, cursor } => {
                            (waypoints.as_slice(), *cursor, 1i32)
                        }
                        Activity::Patrol { waypoints, cursor, direction } => (waypoints.as_slice(), *cursor, *direction),
                        _ => break,
                    };
                    let ndx = waypoints[cursor] - unit.x;
                    let ndy = waypoints[cursor + 1] - unit.y;
                    let ndist = (ndx * ndx + ndy * ndy).sqrt();
                    if direction == 1 {
                        if cursor + 2 < waypoints.len() && ndist <= WAYPOINT_REACH_RADIUS {
                            Step::Advance
                        } else {
                            Step::Done
                        }
                    } else if cursor > 0 && ndist <= WAYPOINT_REACH_RADIUS {
                        Step::ReversePatrol
                    } else {
                        Step::Done
                    }
                };
                match step {
                    Step::Advance => {
                        if let Some((_, cursor)) = unit.queue.first_mut().and_then(|h| h.waypoints_mut()) {
                            *cursor += 2;
                        }
                        unit.queue_dirty = true;
                    }
                    Step::ReversePatrol => {
                        if let Some((_, cursor)) = unit.queue.first_mut().and_then(|h| h.waypoints_mut()) {
                            *cursor -= 2;
                        }
                        unit.queue_dirty = true;
                    }
                    Step::Done => break,
                }
            }
        }

        units[idx].tick_start_x = units[idx].x;
        units[idx].tick_start_y = units[idx].y;

        let (waypoints_snapshot, cursor_now, is_patrol, patrol_direction) = {
            let unit = &units[idx];
            match unit.queue.first() {
                Some(Activity::Move { waypoints, cursor }) | Some(Activity::AttackMove { waypoints, cursor }) => {
                    (waypoints.clone(), *cursor, false, 1i32)
                }
                Some(Activity::Patrol { waypoints, cursor, direction }) => (waypoints.clone(), *cursor, true, *direction),
                _ => unreachable!("movement head checked"),
            }
        };
        let target_x = waypoints_snapshot[cursor_now];
        let target_y = waypoints_snapshot[cursor_now + 1];
        let dx = target_x - units[idx].x;
        let dy = target_y - units[idx].y;
        let dist = (dx * dx + dy * dy).sqrt();
        let is_final_leg = if is_patrol { false } else { cursor_now + 2 >= waypoints_snapshot.len() };
        units[idx].in_approach_zone = is_final_leg && dist <= APPROACH_RADIUS;
        if dist > 1e-12 {
            units[idx].desired_dir_x = dx / dist;
            units[idx].desired_dir_y = dy / dist;
        }

        if is_patrol {
            let is_end = (patrol_direction == 1 && cursor_now + 2 >= waypoints_snapshot.len())
                || (patrol_direction == -1 && cursor_now == 0);
            if is_end && dist <= WAYPOINT_REACH_RADIUS {
                let unit = &mut units[idx];
                if let Some(Activity::Patrol { cursor, direction, .. }) = unit.queue.first_mut() {
                    if *direction == 1 {
                        *direction = -1;
                        *cursor = waypoints_snapshot.len().saturating_sub(4);
                    } else {
                        *direction = 1;
                        *cursor = (waypoints_snapshot.len() - 2).min(2);
                    }
                }
                unit.queue_dirty = true;
                let (nx, ny) = {
                    let unit = &units[idx];
                    match unit.queue.first() {
                        Some(Activity::Patrol { waypoints, cursor, .. }) => (waypoints[*cursor], waypoints[*cursor + 1]),
                        _ => unreachable!(),
                    }
                };
                set_row(world, comps.move_target, eid, vec![nx, ny]);
                continue;
            }
        } else if is_final_leg && dist <= FINAL_ARRIVAL_RADIUS {
            dequeue_current(&mut units[idx].queue);
            units[idx].queue_dirty = true;
            let next_is_movement = matches!(
                units[idx].queue.first(),
                Some(Activity::Move { .. }) | Some(Activity::AttackMove { .. }) | Some(Activity::Patrol { .. })
            );
            if next_is_movement {
                let wps = units[idx].queue.first().and_then(|a| a.waypoints()).unwrap().to_vec();
                let (nx, ny) = (wps[wps.len() - 2], wps[wps.len() - 1]);
                set_row(world, comps.move_target, eid, vec![nx, ny]);
                let vel = row_mut(world, comps.velocity, eid).expect("vel row");
                reset_steering_bookkeeping(vel);
            } else {
                units[idx].speed = 0.0;
                vel_set(world, comps, eid, V_SPEED, 0.0);
                clear_harmonized_speed(world, comps, eid);
            }
            continue;
        }

        // Segment validity raycast against live passability.
        let seg_blocked = !has_line_of_sight(
            passability,
            size,
            units[idx].x.floor() as i64,
            units[idx].y.floor() as i64,
            target_x.floor() as i64,
            target_y.floor() as i64,
        )
        .unwrap_or(true);
        if seg_blocked {
            let (ux, uy, head) = (units[idx].x, units[idx].y, is_movement_head(&units[idx].queue));
            request_repath(world, comps, size, passability, paths, diagnostics, &mut await_repath, eid, ux, uy, head);
            continue;
        }

        if is_final_leg && dist <= APPROACH_RADIUS {
            let close = vel_get(world, comps, eid, V_CLOSE_TICKS) + 1.0;
            vel_set(world, comps, eid, V_CLOSE_TICKS, close);
            if close >= ARRIVAL_GRACE_TICKS {
                dequeue_current(&mut units[idx].queue);
                units[idx].queue_dirty = true;
                let next_is_movement = matches!(
                    units[idx].queue.first(),
                    Some(Activity::Move { .. }) | Some(Activity::AttackMove { .. }) | Some(Activity::Patrol { .. })
                );
                if next_is_movement {
                    let wps = units[idx].queue.first().and_then(|a| a.waypoints()).unwrap().to_vec();
                    let (nx, ny) = (wps[wps.len() - 2], wps[wps.len() - 1]);
                    set_row(world, comps.move_target, eid, vec![nx, ny]);
                    let vel = row_mut(world, comps.velocity, eid).expect("vel row");
                    reset_steering_bookkeeping(vel);
                } else {
                    units[idx].speed = 0.0;
                    vel_set(world, comps, eid, V_CLOSE_TICKS, 0.0);
                    vel_set(world, comps, eid, V_SPEED, 0.0);
                }
                continue;
            }
        } else {
            vel_set(world, comps, eid, V_CLOSE_TICKS, 0.0);
        }

        // Heading + speed.
        let desired_heading = det_atan2(dy, dx);
        let delta = angle_delta(units[idx].heading, desired_heading);
        let max_turn = turn_rate * dt;
        let turn_step = delta.clamp(-max_turn, max_turn);
        units[idx].heading = wrap_angle(units[idx].heading + turn_step);
        let align = det_cos(delta.abs().min(HALF_PI));
        let cruise = base_speed * (TURN_SLOW_MIN + (1.0 - TURN_SLOW_MIN) * align);
        let mut remaining = dist;
        let mut i = cursor_now + 2;
        while i < waypoints_snapshot.len() {
            let seg_dx = waypoints_snapshot[i] - waypoints_snapshot[i - 2];
            let seg_dy = waypoints_snapshot[i + 1] - waypoints_snapshot[i - 1];
            remaining += (seg_dx * seg_dx + seg_dy * seg_dy).sqrt();
            i += 2;
        }
        let brake_speed = (2.0 * BRAKE_DECEL_TILES_PER_S2 * remaining.max(0.0)).sqrt();
        let target_speed = cruise.min(brake_speed);
        if target_speed > units[idx].speed {
            units[idx].speed = target_speed.min(units[idx].speed + ACCEL_TILES_PER_S2 * dt);
        } else {
            units[idx].speed = target_speed.max(units[idx].speed - BRAKE_DECEL_TILES_PER_S2 * dt);
        }
        if dist > 0.0 && units[idx].speed > 0.0 {
            let dir_x = dx / dist;
            let dir_y = dy / dist;
            let step_length = (units[idx].speed * dt).min(dist);
            let (nx, ny) = (units[idx].x + dir_x * step_length, units[idx].y + dir_y * step_length);
            try_move(world, comps, &mut units[idx], nx, ny, passability, size);
        }
        let (h, s) = (units[idx].heading, units[idx].speed);
        vel_set(world, comps, eid, V_HEADING, h);
        vel_set(world, comps, eid, V_SPEED, s);
    }

    // 4) Pairwise steering layer.
    for i in 0..units.len() {
        if units[i].despawned {
            continue;
        }
        let neighbors = gather_neighbors(&cells, &units[i]);
        for other_eid in neighbors {
            let j = index_by_eid[&other_eid];
            if j <= i || units[j].despawned {
                continue;
            }
            let (ax, ay, ar) = (units[i].x, units[i].y, units[i].radius);
            let (bx, by, br) = (units[j].x, units[j].y, units[j].radius);
            let mut dx = bx - ax;
            let mut dy = by - ay;
            let mut d2 = dx * dx + dy * dy;
            let pair_radius = SEPARATION_RADIUS.max(ar + br + PARKED_CONTACT_MARGIN);
            if d2 > pair_radius * pair_radius {
                continue;
            }
            if d2 < 1e-12 {
                let flip = if units[i].eid < units[j].eid { -1.0 } else { 1.0 };
                dx = flip;
                dy = 0.0;
                d2 = 1.0;
            }
            let distance = d2.sqrt();
            let ux = dx / distance;
            let uy = dy / distance;
            let proximity = 1.0 - distance / pair_radius;
            let steer_a = is_steerable(world, comps, &units[i]);
            let steer_b = is_steerable(world, comps, &units[j]);
            if steer_a {
                units[i].acc_sep_x -= ux * proximity;
                units[i].acc_sep_y -= uy * proximity;
            }
            if steer_b {
                units[j].acc_sep_x += ux * proximity;
                units[j].acc_sep_y += uy * proximity;
            }
            let touch_distance = ar + br + PARKED_CONTACT_MARGIN;
            if distance <= touch_distance {
                if steer_a && !steer_b {
                    units[i].contact_with_parked = true;
                }
                if steer_b && !steer_a {
                    units[j].contact_with_parked = true;
                }
            }
            let min_distance = ar + br;
            let overlap = min_distance - distance;
            if overlap > 0.0 {
                let half = overlap / 2.0;
                if steer_a && steer_b {
                    let (nx, ny) = (ax - ux * half, ay - uy * half);
                    try_move(world, comps, &mut units[i], nx, ny, passability, size);
                    let (nx, ny) = (bx + ux * half, by + uy * half);
                    try_move(world, comps, &mut units[j], nx, ny, passability, size);
                    let (ae, ah) = (units[i].eid, units[i].heading);
                    commit_avoidance_side(world, comps, ae, ah, -ux, -uy);
                    let (be, bh) = (units[j].eid, units[j].heading);
                    commit_avoidance_side(world, comps, be, bh, ux, uy);
                } else if steer_a {
                    let (nx, ny) = (ax - ux * overlap, ay - uy * overlap);
                    try_move(world, comps, &mut units[i], nx, ny, passability, size);
                    let (ae, ah) = (units[i].eid, units[i].heading);
                    commit_avoidance_side(world, comps, ae, ah, -ux, -uy);
                } else if steer_b {
                    let (nx, ny) = (bx + ux * overlap, by + uy * overlap);
                    try_move(world, comps, &mut units[j], nx, ny, passability, size);
                    let (be, bh) = (units[j].eid, units[j].heading);
                    commit_avoidance_side(world, comps, be, bh, ux, uy);
                }
            }
        }
    }

    // Apply accumulated separation drift.
    for idx in 0..units.len() {
        let mag_sq = units[idx].acc_sep_x * units[idx].acc_sep_x + units[idx].acc_sep_y * units[idx].acc_sep_y;
        if mag_sq < 1e-12 {
            continue;
        }
        let magnitude = mag_sq.sqrt();
        let strength = magnitude.min(SEPARATION_RADIUS) * SEPARATION_DRIFT_RATE * dt;
        let scale = strength / magnitude;
        let (nx, ny) = (
            units[idx].x + units[idx].acc_sep_x * scale,
            units[idx].y + units[idx].acc_sep_y * scale,
        );
        try_move(world, comps, &mut units[idx], nx, ny, passability, size);
    }

    // 5) FSM resolution.
    for idx in 0..units.len() {
        if units[idx].despawned {
            continue;
        }
        let eid = units[idx].eid;
        let ticks_left = vel_get(world, comps, eid, V_AVOID_TICKS_LEFT);
        if ticks_left > 0.0 {
            vel_set(world, comps, eid, V_AVOID_TICKS_LEFT, ticks_left - 1.0);
        }
        let has_move_head = is_movement_head(&units[idx].queue);
        let net_dx = units[idx].x - units[idx].tick_start_x;
        let net_dy = units[idx].y - units[idx].tick_start_y;
        units[idx].ema_net_x += (net_dx - units[idx].ema_net_x) * NET_PROGRESS_SMOOTHING;
        units[idx].ema_net_y += (net_dy - units[idx].ema_net_y) * NET_PROGRESS_SMOOTHING;
        let ema_projection =
            units[idx].ema_net_x * units[idx].desired_dir_x + units[idx].ema_net_y * units[idx].desired_dir_y;
        let commanded_step = (units[idx].speed * dt).max(PROGRESS_EPSILON);
        units[idx].progressed = !has_move_head
            || units[idx].in_approach_zone
            || ema_projection > NET_PROGRESS_EPSILON.max(0.5 * commanded_step);

        if !has_move_head {
            vel_set(world, comps, eid, V_STALLED_TICKS, 0.0);
            vel_set(world, comps, eid, V_PARK_CONTACT_TICKS, 0.0);
            vel_set(world, comps, eid, V_CLOSE_TICKS, 0.0);
            vel_set(world, comps, eid, V_PROPAGATION_PARKED, 0.0);
        } else if await_repath.contains(&eid) {
            // counters frozen
        } else if vel_get(world, comps, eid, V_PROPAGATION_PARKED) != 0.0 {
            if !units[idx].contact_with_parked {
                vel_set(world, comps, eid, V_PROPAGATION_PARKED, 0.0);
                vel_set(world, comps, eid, V_STALLED_TICKS, 0.0);
                vel_set(world, comps, eid, V_PARK_CONTACT_TICKS, 0.0);
            }
        } else {
            if units[idx].progressed {
                let stalled = vel_get(world, comps, eid, V_STALLED_TICKS);
                vel_set(world, comps, eid, V_STALLED_TICKS, (stalled - STALL_DECAY_PER_TICK).max(0.0));
            } else {
                let stalled = vel_get(world, comps, eid, V_STALLED_TICKS);
                vel_set(world, comps, eid, V_STALLED_TICKS, stalled + 1.0);
            }
            let park_contact = vel_get(world, comps, eid, V_PARK_CONTACT_TICKS);
            if !units[idx].progressed && units[idx].contact_with_parked {
                vel_set(world, comps, eid, V_PARK_CONTACT_TICKS, park_contact + 1.0);
            } else {
                vel_set(world, comps, eid, V_PARK_CONTACT_TICKS, (park_contact - 2.0).max(0.0));
            }
            let stalled_now = vel_get(world, comps, eid, V_STALLED_TICKS);
            let park_now = vel_get(world, comps, eid, V_PARK_CONTACT_TICKS);
            if park_now >= AVOIDANCE_COMMIT_TICKS {
                vel_set(world, comps, eid, V_PROPAGATION_PARKED, 1.0);
                vel_set(world, comps, eid, V_SPEED, 0.0);
                vel_set(world, comps, eid, V_STALLED_TICKS, 0.0);
                vel_set(world, comps, eid, V_PARK_CONTACT_TICKS, 0.0);
            } else if stalled_now > STALL_SIDESTEP_TICKS {
                sidestep_and_repath(world, comps, size, passability, paths, diagnostics, &mut await_repath, &mut units, idx);
                vel_set(world, comps, eid, V_STALLED_TICKS, 0.0);
                vel_set(world, comps, eid, V_CLOSE_TICKS, 0.0);
            }
        }
        if units[idx].queue_dirty {
            let q = units[idx].queue.clone();
            write_queue(world, comps, eid, &q);
        }
    }
    // Fog dirty marks intentionally not emitted (see module header).
}

fn commit_avoidance_side(world: &mut CoreWorld, comps: &MovementComps, eid: Eid, heading: f64, away_x: f64, away_y: f64) {
    if vel_get(world, comps, eid, V_AVOID_TICKS_LEFT) > 0.0 {
        return;
    }
    let hx = det_cos(heading);
    let hy = det_sin(heading);
    let cross = hx * away_y - hy * away_x;
    let side = if cross > 1e-9 {
        1.0
    } else if cross < -1e-9 {
        -1.0
    } else if world.prng.next_float() < 0.5 {
        -1.0
    } else {
        1.0
    };
    vel_set(world, comps, eid, V_AVOID_SIDE, side);
    vel_set(world, comps, eid, V_AVOID_TICKS_LEFT, AVOIDANCE_COMMIT_TICKS);
}

// ---- scenario runner (mirrors TS world.step() plumbing) ------------------------

pub struct MovementSim {
    pub world: CoreWorld,
    pub layers: Layers,
    pub comps: MovementComps,
    pub paths: PathScheduler<Continuation>,
    pub diagnostics: MovementDiagnostics,
    /// Commands drained on the most recent advanced tick, retained so
    /// sibling systems (gather, construction, …) dispatch from the
    /// same boundary list exactly as TS registerSystem delivery does.
    pub last_commands: Vec<Command>,
    lut: SinCosLut,
}

impl MovementSim {
    pub fn new(seed: u32, size: usize, transport: Transport) -> Result<Self, String> {
        let layers = generate_map(seed, size)?;
        let mut world = CoreWorld::new(seed);
        let comps = define_sim_components(&mut world);
        Ok(MovementSim {
            world,
            layers,
            comps,
            paths: PathScheduler::new(transport),
            diagnostics: MovementDiagnostics::default(),
            last_commands: Vec::new(),
            lut: build_sin_cos_lut(SLOT_LUT_SIZE),
        })
    }

    pub fn spawn_unit(&mut self, x: f64, y: f64) -> Eid {
        spawn_unit(&mut self.world, &self.comps, x, y)
    }

    pub fn submit(&mut self, command: Command) -> Result<(), String> {
        self.world.inbox.submit(command)
    }

    /// Worker-frame advance (harness order: advance, submit, step).
    pub fn advance_transport(&mut self) {
        let delivered = match self.paths.transport_mut() {
            Transport::Mock(worker) => worker.advance_frame(),
            Transport::Sync(_) => Vec::new(),
        };
        for response in delivered {
            self.paths.receive(response);
        }
    }

    /// One world step (holding the tick while the scheduler blocks).
    /// Returns true iff the tick advanced.
    pub fn step(&mut self) -> bool {
        let planned = self.world.tick + 1;
        let outcome = self.paths.pump(planned);
        for event in outcome.events {
            match event {
                PumpEvent::Apply(Continuation::GroupRoute(cont), response) => {
                    apply_group_route(
                        &mut self.world,
                        &self.comps,
                        self.layers.size,
                        &self.lut,
                        &mut self.diagnostics,
                        &cont,
                        &response,
                    );
                }
                PumpEvent::Apply(Continuation::Repath { eid, dest }, response) => {
                    apply_repath(&mut self.world, &self.comps, eid, dest, &response);
                }
                PumpEvent::Apply(Continuation::DiscardRepath, _) | PumpEvent::Discard(_) => {}
            }
        }
        if outcome.blocked {
            return false;
        }
        self.world.tick = planned;
        let commands = self.world.inbox.drain_due(planned);
        let passability = self.layers.passability.clone();
        movement_system(
            &mut self.world,
            &self.comps,
            self.layers.size,
            &passability,
            &mut self.paths,
            &mut self.diagnostics,
            &commands,
        );
        self.last_commands = commands;
        true
    }

    /// One rendered frame: advance transport, then step.
    pub fn frame(&mut self) -> bool {
        self.advance_transport();
        self.step()
    }

    pub fn digest(&self) -> String {
        self.world.compute_digest()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::MockWorker;

    const EXPECTED_DIGESTS: [(u64, &str); 10] = [
        (30, "fnv1a64:02790f5b0788d01b"),
        (60, "fnv1a64:3d38386b21775fc0"),
        (90, "fnv1a64:cb8e4c4f1ccea7d8"),
        (120, "fnv1a64:54017f59d1bb8acb"),
        (150, "fnv1a64:d7784b25cb3192be"),
        (180, "fnv1a64:3b96a65459ca8cea"),
        (210, "fnv1a64:4be77a51577fb470"),
        (240, "fnv1a64:86e59503e5b44846"),
        (270, "fnv1a64:b8785424aa773427"),
        (300, "fnv1a64:b8674c3f251b11b2"),
    ];

    struct RunOut {
        digests: Vec<(u64, String)>,
        positions: Vec<(Eid, f64, f64)>,
        diagnostics: MovementDiagnostics,
        blocked_ticks: u64,
        passability: Vec<u8>,
        size: usize,
        lut: SinCosLut,
    }

    #[derive(serde::Deserialize)]
    struct FixtureSpawn {
        eid: i64,
        x: f64,
        y: f64,
    }
    #[derive(serde::Deserialize)]
    struct FixtureGroup {
        #[serde(rename = "entityIds")]
        entity_ids: Vec<i64>,
        x: f64,
        y: f64,
    }
    #[derive(serde::Deserialize)]
    struct FixtureCommand {
        kind: String,
        #[serde(rename = "targetTick")]
        target_tick: u64,
        data: serde_json::Value,
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        spawns: Vec<FixtureSpawn>,
        commands: Vec<FixtureCommand>,
        groups: Vec<FixtureGroup>,
    }

    fn load_fixture() -> Fixture {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t4/case.json");
        let text = std::fs::read_to_string(path).expect("read m1t4 case.json");
        serde_json::from_str(&text).expect("parse m1t4 case")
    }

    fn run_scenario(worker_backed: bool) -> RunOut {
        let fixture = load_fixture();
        let transport = if worker_backed {
            Transport::Mock(MockWorker::new(|id| (id - 1) % 3))
        } else {
            Transport::synchronous()
        };
        let mut sim = MovementSim::new(fixture.seed, fixture.size, transport).unwrap();
        let size = sim.layers.size;
        for spawn in &fixture.spawns {
            let eid = sim.spawn_unit(spawn.x, spawn.y);
            assert_eq!(eid, spawn.eid, "fixture spawn order");
        }
        for command in &fixture.commands {
            sim.submit(Command {
                kind: command.kind.clone(),
                target_tick: command.target_tick,
                data: Some(command.data.clone()),
            })
            .unwrap();
        }
        let mut digests = Vec::new();
        let mut iterations = 0u64;
        while sim.world.tick < fixture.ticks {
            let before = sim.world.tick;
            sim.advance_transport();
            sim.step();
            iterations += 1;
            assert!(iterations <= fixture.ticks * 20, "scenario failed to reach final tick");
            if sim.world.tick == before {
                continue;
            }
            let t = sim.world.tick;
            if t % fixture.milestone_every == 0 || t == fixture.ticks {
                digests.push((t, sim.digest()));
            }
        }
        let positions = sim
            .world
            .entities
            .iter()
            .map(|&eid| {
                let p = row(&sim.world, sim.comps.position, eid).expect("pos");
                (eid, p[0], p[1])
            })
            .collect();
        RunOut {
            digests,
            positions,
            diagnostics: sim.diagnostics,
            blocked_ticks: sim.paths.blocked_ticks(),
            passability: sim.layers.passability.clone(),
            size,
            lut: sim.lut,
        }
    }

    #[test]
    fn m1t4_sync_matches_ts_snapshot() {
        let out = run_scenario(false);
        let got: Vec<(u64, &str)> = out.digests.iter().map(|(t, d)| (*t, d.as_str())).collect();
        assert_eq!(got, EXPECTED_DIGESTS.to_vec());
        assert_eq!(out.diagnostics.group_moves, 2);
        assert_eq!(out.blocked_ticks, 0, "synchronous transport never holds the tick");
    }

    #[test]
    fn m1t4_worker_mock_byte_identical() {
        let sync = run_scenario(false);
        let worker = run_scenario(true);
        assert_eq!(worker.digests, sync.digests);
        assert_eq!(worker.positions.len(), sync.positions.len());
        for ((e1, x1, y1), (e2, x2, y2)) in sync.positions.iter().zip(&worker.positions) {
            assert_eq!(e1, e2);
            assert_eq!((x1.to_bits(), y1.to_bits()), (x2.to_bits(), y2.to_bits()), "eid {e1} position bits");
        }
        assert_eq!(worker.diagnostics, sync.diagnostics);
        assert!(worker.blocked_ticks > 0, "the mock worker must actually hold some ticks");
        // Cross-mode identical final digest must also equal the snapshot.
        assert_eq!(worker.digests.last().unwrap().1, EXPECTED_DIGESTS[9].1);
    }

    #[test]
    fn m1t4_arrivals_on_expected_slots() {
        let fixture = load_fixture();
        let out = run_scenario(false);
        assert_eq!(out.diagnostics.group_moves as usize, fixture.groups.len());
        let size_i = out.size as i64;
        // expectedSlotPoints mirror: per group (in order), leader nearest
        // centroid keeps slot 0, rest fill ascending; later groups overwrite.
        let spawn_by_id: std::collections::HashMap<i64, (f64, f64)> =
            fixture.spawns.iter().map(|s| (s.eid, (s.x, s.y))).collect();
        let mut expected: std::collections::HashMap<i64, (f64, f64)> = std::collections::HashMap::new();
        for group in &fixture.groups {
            let members: Vec<i64> = group.entity_ids.iter().copied().filter(|e| spawn_by_id.contains_key(e)).collect();
            let mut cx = 0.0;
            let mut cy = 0.0;
            for eid in &members {
                let s = spawn_by_id[eid];
                cx += s.0;
                cy += s.1;
            }
            cx /= members.len() as f64;
            cy /= members.len() as f64;
            let mut leader = members[0];
            let mut best = f64::INFINITY;
            for eid in &members {
                let s = spawn_by_id[eid];
                let d2 = (s.0 - cx) * (s.0 - cx) + (s.1 - cy) * (s.1 - cy);
                if d2 < best {
                    best = d2;
                    leader = *eid;
                }
            }
            let mut ordered = vec![leader];
            for eid in &members {
                if *eid != leader {
                    ordered.push(*eid);
                }
            }
            for (slot, eid) in ordered.iter().enumerate() {
                let (odx, ody) = formation_slot_offset(&out.lut, slot);
                expected.insert(*eid, (group.x + odx, group.y + ody));
            }
        }
        let pos_of = |eid: i64| {
            let p = out.positions.iter().find(|(e, _, _)| *e == eid).expect("position");
            (p.1, p.2)
        };
        for i in 0..out.positions.len() {
            for j in (i + 1)..out.positions.len() {
                let (_, ax, ay) = out.positions[i];
                let (_, bx, by) = out.positions[j];
                let d = ((ax - bx) * (ax - bx) + (ay - by) * (ay - by)).sqrt();
                assert!(d >= 0.45, "pairwise final distance {d} below 0.45");
            }
        }
        for (eid, x, y) in &out.positions {
            let (fx, fy) = expected[eid];
            let d = ((x - fx) * (x - fx) + (y - fy) * (y - fy)).sqrt();
            assert!(d <= 1.5, "unit {eid} arrived {d} from its slot");
            let tile = (y.floor() as i64 * size_i + x.floor() as i64) as usize;
            assert_eq!(out.passability[tile], 1, "unit {eid} on passable tile");
        }
        for group in &fixture.groups {
            let mut cx = 0.0;
            let mut cy = 0.0;
            for eid in &group.entity_ids {
                let p = pos_of(*eid);
                cx += p.0;
                cy += p.1;
            }
            cx /= group.entity_ids.len() as f64;
            cy /= group.entity_ids.len() as f64;
            let d = ((cx - group.x) * (cx - group.x) + (cy - group.y) * (cy - group.y)).sqrt();
            assert!(d <= 0.6, "group centroid {d} from destination");
        }
    }
}

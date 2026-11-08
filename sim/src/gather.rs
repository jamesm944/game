//! Gather system (SPEC §2.6 economy core loop / M1-T9): Rust port of
//! `src/sim/systems/gather.ts`. Move(slot) → Gather until carry fills
//! or node depletes → Move(cheapest accepting drop-off door) → Deliver
//! (deposit into the owner's stockpile) → auto-repeat. Slot claims are
//! derived every tick from the AssignedNode set with ascending-eid
//! priority; overflow workers mill on formation ring 2+.
//!
//! Pop rows (skills/traits/needs/body/identity) fold in through
//! `crate::pop` exactly as TS. Inputs that only later epics produce —
//! Combat rows (naval check) and water terrain nodes — still panic
//! loudly instead of silently diverging, until their ports land.
use crate::activities::{cancel_activities, dequeue_current, move_activity, peek, Activity, ActivityQueue};
use crate::core::{Command, Eid, Sfc32, World as CoreWorld};
use crate::defs::Defs;
use crate::economy::{
    assign_node, carry_capacity, clear_assigned_node, deposit, drop_off_accepts, drop_off_owner,
    ensure_carry_capacity, ensure_inventory, inventory, set_inventory, EconomyComps,
    DEFAULT_CARRY_CAPACITY, WORK_SLOTS_PER_NODE,
};
use crate::mapgen::{is_water_terrain, Layers};
use crate::movement::{
    formation_slot_offset, is_steering_jammed, nearest_passable_tile, read_queue,
    reset_steering_bookkeeping, tile_is_passable, write_queue, MovementComps, MovementSim,
    SLOT_LUT_SIZE,
};
use crate::path::find_path;
use crate::pop::{self, PopComps, TraitsData, GATHER_XP_PER_UNIT};
use crate::trig::{build_sin_cos_lut, SinCosLut};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

pub const DEFAULT_GATHER_TICKS_PER_UNIT: f64 = 30.0;
pub const SET_AUTO_RESEED_COMMAND_KIND: &str = "setAutoReseed";
pub const BASE_FARM_FOOD: f64 = 175.0;
pub const FARM_RESEED_WOOD_COST: f64 = 60.0;
const RESOURCE_WOOD: i64 = 1;

const SLOT_ARRIVAL_RADIUS: f64 = 0.35;
const HOLDING_ARRIVAL_RADIUS: f64 = 0.5;
const DELIVER_ARRIVAL_RADIUS: f64 = 3.5;
const DELIVER_JAM_RADIUS: f64 = 6.0;
const DELIVER_DOOR_SCALE: f64 = 1.6;
const OVERFLOW_RING_START_INDEX: usize = 9;
const WORK_SLOT_NEIGHBOR_OFFSETS: [(i64, i64); 8] =
    [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];

#[derive(Clone, Debug, PartialEq)]
pub struct FarmDepletedEvent {
    pub tick: u64,
    pub player_id: f64,
    pub farm_eid: Eid,
    pub reason: &'static str,
    pub farm_x: Option<f64>,
    pub farm_y: Option<f64>,
}

/// Test/telemetry counters — deliberately NOT part of the digest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GatherDiagnostics {
    pub commands_applied: u64,
    pub extracted_by_resource: [f64; 7],
    pub deposited_by_resource: [f64; 7],
    pub deliveries_by_drop_off: Vec<f64>,
    pub rejected_by_filter: u64,
    pub blocked_carry_ticks: u64,
    pub destroyed_dropoff_reroutes: u64,
    pub farm_reseeds: u64,
}

#[derive(Clone, Copy)]
pub struct GatherComps {
    pub building: usize,
    pub assigned_site: usize,
    pub identity: usize,
    pub skills: usize,
    pub traits: usize,
    pub needs: usize,
    pub body: usize,
    pub combat: usize,
}

impl GatherComps {
    pub fn from_world(world: &CoreWorld) -> GatherComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        GatherComps {
            building: id("Building"),
            assigned_site: id("AssignedSite"),
            identity: id("Identity"),
            skills: id("Skills"),
            traits: id("Traits"),
            needs: id("Needs"),
            body: id("Body"),
            combat: id("Combat"),
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

fn work_slot_positions(passability: &[u8], size: usize, tile_x: i64, tile_y: i64, limit: usize) -> Vec<(f64, f64)> {
    let mut slots = Vec::new();
    for (dx, dy) in WORK_SLOT_NEIGHBOR_OFFSETS {
        if slots.len() >= limit {
            break;
        }
        let (x, y) = (tile_x + dx, tile_y + dy);
        if !tile_is_passable(passability, size, x, y) {
            continue;
        }
        slots.push((x as f64 + 0.5, y as f64 + 0.5));
    }
    slots
}

struct ParsedGather {
    entity_ids: Vec<Eid>,
    node_id: Eid,
    queue: bool,
}

fn parse_gather_data(data: &serde_json::Value) -> ParsedGather {
    let raw_ids = data.get("entityIds").and_then(|v| v.as_array());
    let raw_ids = raw_ids.filter(|a| !a.is_empty()).expect("gather requires a non-empty entityIds array");
    let mut entity_ids: Vec<Eid> = Vec::new();
    for id in raw_ids {
        let id = id
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .unwrap_or_else(|| panic!("gather entityIds entries must be positive integers, got {id}"));
        if !entity_ids.contains(&id) {
            entity_ids.push(id);
        }
    }
    entity_ids.sort();
    let node_id = data
        .get("nodeId")
        .and_then(|v| v.as_f64())
        .filter(|v| v.fract() == 0.0 && *v >= 1.0)
        .map(|v| v as Eid)
        .unwrap_or_else(|| panic!("gather nodeId must be a positive integer"));
    ParsedGather {
        entity_ids,
        node_id,
        queue: data.get("queue").and_then(|v| v.as_bool()) == Some(true),
    }
}

#[derive(Clone)]
struct DropOffInfo {
    eid: Eid,
    x: f64,
    y: f64,
    mask: f64,
}

struct ClaimedWorker {
    eid: Eid,
    pos_x: f64,
    pos_y: f64,
    node_eid: Eid,
    resource_code: i64,
    slot_index: i64,
    overflow_rank: i64,
    slots: Vec<(f64, f64)>,
    holding_x: f64,
    holding_y: f64,
}

pub struct GatherSystem {
    defs: Arc<Defs>,
    traits: Arc<TraitsData>,
    pop: PopComps,
    ccomps: crate::combat::CombatComps,
    gcomps: GatherComps,
    pub diagnostics: GatherDiagnostics,
    cost_cache_version: i64,
    cost_cache: HashMap<i64, f64>,
    auto_reseed: HashMap<i64, bool>,
    farm_events: Vec<FarmDepletedEvent>,
    lut: SinCosLut,
    cost_rng: Sfc32,
}

impl GatherSystem {
    pub fn new(
        defs: Arc<Defs>,
        traits: Arc<TraitsData>,
        pop: PopComps,
        ccomps: crate::combat::CombatComps,
        gcomps: GatherComps,
    ) -> GatherSystem {
        GatherSystem {
            defs,
            traits,
            pop,
            ccomps,
            gcomps,
            diagnostics: GatherDiagnostics::default(),
            cost_cache_version: -1,
            cost_cache: HashMap::new(),
            auto_reseed: HashMap::new(),
            farm_events: Vec::new(),
            lut: build_sin_cos_lut(SLOT_LUT_SIZE),
            cost_rng: Sfc32::new_seeded(0),
        }
    }

    pub fn farm_depleted_events(&self) -> &[FarmDepletedEvent] {
        &self.farm_events
    }

    fn is_auto_reseed_enabled(&self, player_id: f64) -> bool {
        self.auto_reseed.get(&(player_id as i64)).copied().unwrap_or(true)
    }

    fn record_farm_depleted(&mut self, event: FarmDepletedEvent) {
        if !self.farm_events.iter().any(|e| e.farm_eid == event.farm_eid) {
            self.farm_events.push(event);
        }
    }

    // ---- pop-row inputs (crate::pop) + later-epic naval guard ----

    fn is_child(&self, world: &CoreWorld, eid: Eid) -> bool {
        pop::is_child(world, &self.pop, eid)
    }

    fn is_naval(&self, world: &CoreWorld, eid: Eid) -> bool {
        let naval = crate::combat::is_naval_unit(world, &self.ccomps, &self.defs, eid);
        if naval {
            panic!("gather: naval worker routing lands with the navigability port (eid {eid})");
        }
        false
    }

    fn resolve_gather_interval(&self, world: &CoreWorld, eid: Eid, base: f64) -> f64 {
        pop::resolve_gather_interval(world, &self.pop, &self.traits, eid, base)
    }

    fn award_practice(&self, world: &mut CoreWorld, eid: Eid) {
        pop::award_practice(world, &self.pop, &self.traits, eid, "gathering", GATHER_XP_PER_UNIT);
    }

    // ---- stockpile wood helpers (farm reseed) ----

    fn stockpile_wood(&self, world: &CoreWorld, econ: &EconomyComps, player_id: f64) -> f64 {
        for r in rows(world, econ.stockpile).values() {
            if r[0] == player_id {
                return r[(RESOURCE_WOOD + 1) as usize];
            }
        }
        0.0
    }

    fn debit_stockpile_wood(&self, world: &mut CoreWorld, econ: &EconomyComps, player_id: f64, amount: f64) -> bool {
        for r in rows_mut(world, econ.stockpile).values_mut() {
            if r[0] == player_id {
                if r[(RESOURCE_WOOD + 1) as usize] >= amount {
                    r[(RESOURCE_WOOD + 1) as usize] -= amount;
                    return true;
                }
                return false;
            }
        }
        false
    }

    fn is_farm(&self, world: &CoreWorld, node_eid: Eid) -> Option<f64> {
        let building_row = row(world, self.gcomps.building, node_eid)?;
        if self.defs.building_id_of_code(building_row[1] as u32) == "farm" {
            Some(building_row[0])
        } else {
            None
        }
    }

    /// Farm auto-reseed attempt on a dry farm node. Returns true when
    /// reseeded (node refilled); false after recording the event.
    fn try_farm_reseed(&mut self, world: &mut CoreWorld, econ: &EconomyComps, comps: &MovementComps, node_eid: Eid, owner: f64) -> bool {
        let auto = self.is_auto_reseed_enabled(owner);
        let wood = self.stockpile_wood(world, econ, owner);
        if auto && wood >= FARM_RESEED_WOOD_COST {
            self.debit_stockpile_wood(world, econ, owner, FARM_RESEED_WOOD_COST);
            rows_mut(world, econ.resource_node).get_mut(&node_eid).expect("node row")[1] = BASE_FARM_FOOD;
            self.diagnostics.farm_reseeds += 1;
            return true;
        }
        let node_pos = row(world, comps.position, node_eid).cloned();
        self.record_farm_depleted(FarmDepletedEvent {
            tick: world.tick,
            player_id: owner,
            farm_eid: node_eid,
            reason: if auto { "insufficient-wood" } else { "auto-reseed-disabled" },
            farm_x: node_pos.as_ref().map(|p| p[0]),
            farm_y: node_pos.as_ref().map(|p| p[1]),
        });
        false
    }

    fn release_worker(&self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, eid: Eid) {
        clear_assigned_node(world, econ, eid);
        let mut queue = read_queue(world, comps, eid);
        cancel_activities(&mut queue);
        write_queue(world, comps, eid, &queue);
    }

    fn vel_row<'a>(&self, world: &'a CoreWorld, comps: &MovementComps, eid: Eid) -> &'a Vec<f64> {
        row(world, comps.velocity, eid).unwrap_or_else(|| panic!("entity {eid} has no Velocity row"))
    }

    fn reset_steering(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid) {
        let vel = rows_mut(world, comps.velocity).get_mut(&eid).unwrap_or_else(|| panic!("entity {eid} has no Velocity row"));
        reset_steering_bookkeeping(vel);
    }

    fn set_move_target(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid, x: f64, y: f64) {
        assert!(row(world, comps.move_target, eid).is_some(), "entity {eid} has no MoveTarget row");
        world.set_values(comps.move_target, eid, &[x, y]).expect("registered component");
    }

    /// Live drop-off points ascending-eid (TS memoizes per tick; ranks
    /// only feed costs/diagnostics within one pass, so recomputing on
    /// each call inside the pass is observably identical).
    fn drop_offs(&self, world: &CoreWorld, comps: &MovementComps, econ: &EconomyComps) -> Vec<DropOffInfo> {
        let mut out = Vec::new();
        for &eid in &world.entities {
            let Some(r) = row(world, econ.drop_off, eid) else { continue };
            let Some(pos) = row(world, comps.position, eid) else { continue };
            out.push(DropOffInfo { eid, x: pos[0], y: pos[1], mask: r[1] });
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn cheapest_drop_off(
        &mut self,
        world: &CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        passability: &[u8],
        size: usize,
        paths_version: u32,
        from_x: f64,
        from_y: f64,
        resource_code: i64,
    ) -> Option<DropOffInfo> {
        let version = paths_version as i64;
        if version != self.cost_cache_version {
            self.cost_cache.clear();
            self.cost_cache_version = version;
        }
        let (mut start_x, mut start_y) = (from_x.floor() as i64, from_y.floor() as i64);
        if !tile_is_passable(passability, size, start_x, start_y) {
            let (nx, ny) = nearest_passable_tile(passability, size, start_x, start_y)?;
            start_x = nx;
            start_y = ny;
        }
        let from_tile = start_y * size as i64 + start_x;
        let accept_bit = 1i64 << resource_code;
        let tile_count = (size * size) as i64;
        let mut best: Option<DropOffInfo> = None;
        let mut best_cost = f64::INFINITY;
        for (rank, candidate) in self.drop_offs(world, comps, econ).into_iter().enumerate() {
            if (candidate.mask as i64 & accept_bit) == 0 {
                continue;
            }
            let (mut goal_x, mut goal_y) = (candidate.x.floor() as i64, candidate.y.floor() as i64);
            if !tile_is_passable(passability, size, goal_x, goal_y) {
                match nearest_passable_tile(passability, size, goal_x, goal_y) {
                    Some((nx, ny)) => {
                        goal_x = nx;
                        goal_y = ny;
                    }
                    None => continue,
                }
            }
            let key = rank as i64 * tile_count + from_tile;
            let cost = match self.cost_cache.get(&key) {
                Some(c) => *c,
                None => {
                    let found = find_path(passability, size, start_x, start_y, goal_x, goal_y, &mut self.cost_rng)
                        .expect("drop-off cost A* inputs valid");
                    let c = found.map(|p| p.cost as f64).unwrap_or(f64::INFINITY);
                    self.cost_cache.insert(key, c);
                    c
                }
            };
            if cost < best_cost {
                best_cost = cost;
                best = Some(candidate);
            }
        }
        best
    }

    fn record_delivery(&mut self, world: &CoreWorld, comps: &MovementComps, econ: &EconomyComps, dropoff_eid: Eid) {
        let rank = self.drop_offs(world, comps, econ).iter().position(|d| d.eid == dropoff_eid).expect("drop-off ranked");
        while self.diagnostics.deliveries_by_drop_off.len() <= rank {
            self.diagnostics.deliveries_by_drop_off.push(0.0);
        }
        self.diagnostics.deliveries_by_drop_off[rank] += 1.0;
    }

    fn drop_off_alive(&self, world: &CoreWorld, econ: &EconomyComps, eid: Eid) -> bool {
        row(world, econ.drop_off, eid).is_some()
    }

    fn drop_off_position(&self, world: &CoreWorld, comps: &MovementComps, eid: Eid) -> (f64, f64) {
        let pos = row(world, comps.position, eid)
            .unwrap_or_else(|| panic!("deliver targets entity {eid}, which has no Position row"));
        (pos[0], pos[1])
    }

    /// Worker's personal delivery door: closest perimeter offset around
    /// the depot (land path; naval passability filtering arrives with
    /// the naval port — is_naval is false for every rowless worker).
    fn deliver_door(&self, size: usize, from_x: f64, from_y: f64, drop: (f64, f64)) -> (f64, f64) {
        let (mut best_x, mut best_y) = drop;
        let mut best_distance_sq = f64::INFINITY;
        for (dx, dy) in WORK_SLOT_NEIGHBOR_OFFSETS {
            let candidate_x = (drop.0 + dx as f64 * DELIVER_DOOR_SCALE).clamp(0.5, size as f64 - 0.5);
            let candidate_y = (drop.1 + dy as f64 * DELIVER_DOOR_SCALE).clamp(0.5, size as f64 - 0.5);
            let ddx = from_x - candidate_x;
            let ddy = from_y - candidate_y;
            let distance_sq = ddx * ddx + ddy * ddy;
            if distance_sq < best_distance_sq {
                best_distance_sq = distance_sq;
                best_x = candidate_x;
                best_y = candidate_y;
            }
        }
        (best_x, best_y)
    }

    fn within_deliver_range(worker: &ClaimedWorker, drop: (f64, f64)) -> bool {
        let ddx = worker.pos_x - drop.0;
        let ddy = worker.pos_y - drop.1;
        ddx * ddx + ddy * ddy <= DELIVER_ARRIVAL_RADIUS * DELIVER_ARRIVAL_RADIUS
    }

    fn jammed_near_drop_off(&self, world: &CoreWorld, comps: &MovementComps, worker: &ClaimedWorker, drop: (f64, f64)) -> bool {
        let ddx = worker.pos_x - drop.0;
        let ddy = worker.pos_y - drop.1;
        if ddx * ddx + ddy * ddy > DELIVER_JAM_RADIUS * DELIVER_JAM_RADIUS {
            return false;
        }
        is_steering_jammed(self.vel_row(world, comps, worker.eid))
    }

    fn apply_gather_command(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, data: &serde_json::Value) {
        let parsed = parse_gather_data(data);
        let node_row = row(world, econ.resource_node, parsed.node_id).cloned().unwrap_or_else(|| {
            panic!("gather command targets entity {}, which has no ResourceNode row", parsed.node_id)
        });
        let resource_code = node_row[0] as i64;
        for eid in parsed.entity_ids {
            let live = row(world, comps.position, eid).is_some()
                && row(world, comps.velocity, eid).is_some()
                && row(world, comps.unit_tag, eid).is_some();
            if !live {
                continue;
            }
            if self.is_child(world, eid) {
                continue;
            }
            if let Some((carried_code, amount)) = inventory(world, econ, eid) {
                if amount > 0.0 && carried_code as i64 != resource_code {
                    panic!(
                        "gather unit {eid} carries resource {carried_code} but node {} yields {resource_code}",
                        parsed.node_id
                    );
                }
            }
            ensure_carry_capacity(world, econ, eid, DEFAULT_CARRY_CAPACITY).expect("carry capacity");
            ensure_inventory(world, econ, eid, resource_code).expect("inventory");
            rows_mut(world, self.gcomps.assigned_site).remove(&eid);
            assign_node(world, econ, eid, parsed.node_id).expect("assign node");
            let mut queue = read_queue(world, comps, eid);
            if !(parsed.queue && !queue.is_empty()) {
                cancel_activities(&mut queue);
                write_queue(world, comps, eid, &queue);
                self.reset_steering(world, comps, eid);
            }
        }
        self.diagnostics.commands_applied += 1;
    }

    /// Advance one gather head. The queue head's elapsed ticks mutate in
    /// place. Returns true when complete (carry full or node dry).
    fn advance_gather_head(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, worker: &ClaimedWorker, queue: &mut ActivityQueue) -> bool {
        let (ticks_per_unit, elapsed) = match &mut queue[0] {
            Activity::Gather { ticks_per_unit, elapsed_ticks } => {
                *elapsed_ticks += 1.0;
                (*ticks_per_unit, *elapsed_ticks)
            }
            _ => unreachable!("gather head"),
        };
        ensure_carry_capacity(world, econ, worker.eid, DEFAULT_CARRY_CAPACITY).expect("carry capacity");
        ensure_inventory(world, econ, worker.eid, worker.resource_code).expect("inventory");
        let (inv_code, inv_amount) = inventory(world, econ, worker.eid).expect("inventory row");
        let capacity = carry_capacity(world, econ, worker.eid);
        let remaining = row(world, econ.resource_node, worker.node_eid).expect("node row")[1];
        if elapsed >= ticks_per_unit && remaining > 0.0 && capacity > inv_amount {
            rows_mut(world, econ.resource_node).get_mut(&worker.node_eid).expect("node row")[1] = remaining - 1.0;
            set_inventory(world, econ, worker.eid, inv_code as i64, inv_amount + 1.0).expect("set inventory");
            self.diagnostics.extracted_by_resource[inv_code as usize] += 1.0;
            self.award_practice(world, worker.eid);
            if let Activity::Gather { elapsed_ticks, .. } = &mut queue[0] {
                *elapsed_ticks = 0.0;
            }
            let now_remaining = row(world, econ.resource_node, worker.node_eid).expect("node row")[1];
            if now_remaining <= 0.0 {
                if let Some(owner) = self.is_farm(world, worker.node_eid) {
                    self.try_farm_reseed(world, econ, comps, worker.node_eid, owner);
                }
            }
        }
        let amount_now = inventory(world, econ, worker.eid).expect("inventory row").1;
        let remaining_now = row(world, econ.resource_node, worker.node_eid).expect("node row")[1];
        amount_now >= capacity || remaining_now <= 0.0
    }

    /// Execute one Deliver head. False = rejected/destroyed: nothing
    /// credited, caller cancels the chain for reroute planning.
    fn execute_deliver_head(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, worker: &ClaimedWorker, dropoff_eid: Eid) -> bool {
        if !self.drop_off_alive(world, econ, dropoff_eid) {
            self.diagnostics.destroyed_dropoff_reroutes += 1;
            return false;
        }
        let owner = drop_off_owner(world, econ, dropoff_eid)
            .unwrap_or_else(|| panic!("deliver targets entity {dropoff_eid}, which has no DropOff row"));
        let Some((inv_code, inv_amount)) = inventory(world, econ, worker.eid) else { return true };
        if inv_amount <= 0.0 {
            return true;
        }
        if !drop_off_accepts(world, econ, dropoff_eid, inv_code as i64).expect("drop-off accepts") {
            self.diagnostics.rejected_by_filter += 1;
            return false;
        }
        // Income multiplier (M4-T6 observers) is ×1 until the companies/
        // difficulty ports register an observer — the byte-identical path.
        deposit(world, econ, owner, inv_code as i64, inv_amount).expect("deposit");
        self.diagnostics.deposited_by_resource[inv_code as usize] += inv_amount;
        self.record_delivery(world, comps, econ, dropoff_eid);
        set_inventory(world, econ, worker.eid, inv_code as i64, 0.0).expect("set inventory");
        true
    }

    /// Decide and enqueue the next chain leg from an empty queue.
    #[allow(clippy::too_many_arguments)]
    fn plan_next_leg(
        &mut self,
        world: &mut CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        layers: &Layers,
        paths_version: u32,
        worker: &ClaimedWorker,
        queue: &mut ActivityQueue,
    ) -> bool {
        let size = layers.size;
        'plan: loop {
            ensure_carry_capacity(world, econ, worker.eid, DEFAULT_CARRY_CAPACITY).expect("carry capacity");
            ensure_inventory(world, econ, worker.eid, worker.resource_code).expect("inventory");
            let (inv_code, inv_amount) = inventory(world, econ, worker.eid).expect("inventory row");
            let capacity = carry_capacity(world, econ, worker.eid);
            let remaining = row(world, econ.resource_node, worker.node_eid).expect("node row")[1];

            // Dry node with empty hands → assignment complete.
            if remaining <= 0.0 && inv_amount <= 0.0 {
                if let Some(owner) = self.is_farm(world, worker.node_eid) {
                    if self.try_farm_reseed(world, econ, comps, worker.node_eid, owner) {
                        continue 'plan; // TS recurses into planNextLeg
                    }
                    world.despawn(worker.node_eid);
                }
                self.release_worker(world, comps, econ, worker.eid);
                return true;
            }

            // Carry full or node dry → deposit run to personal door.
            if remaining <= 0.0 || inv_amount >= capacity {
                let _ = self.is_naval(world, worker.eid); // false for rowless
                let Some(target) = self.cheapest_drop_off(
                    world, comps, econ, &layers.passability, size, paths_version,
                    worker.pos_x, worker.pos_y, inv_code as i64,
                ) else {
                    self.diagnostics.blocked_carry_ticks += 1;
                    return false;
                };
                let door = self.deliver_door(size, worker.pos_x, worker.pos_y, (target.x, target.y));
                queue.push(move_activity(&[door.0, door.1]).expect("move activity"));
                queue.push(Activity::Deliver { dropoff_eid: target.eid as f64 });
                self.set_move_target(world, comps, worker.eid, door.0, door.1);
                self.reset_steering(world, comps, worker.eid);
                return true;
            }

            // Overflow workers mill toward their holding point.
            if worker.overflow_rank >= 0 {
                let ddx = worker.pos_x - worker.holding_x;
                let ddy = worker.pos_y - worker.holding_y;
                if ddx * ddx + ddy * ddy <= HOLDING_ARRIVAL_RADIUS * HOLDING_ARRIVAL_RADIUS {
                    return false;
                }
                queue.push(move_activity(&[worker.holding_x, worker.holding_y]).expect("move activity"));
                self.set_move_target(world, comps, worker.eid, worker.holding_x, worker.holding_y);
                self.reset_steering(world, comps, worker.eid);
                return true;
            }

            // Slotted: begin work on arrival, else walk to the slot.
            let slot = worker.slots[worker.slot_index as usize];
            let ddx = worker.pos_x - slot.0;
            let ddy = worker.pos_y - slot.1;
            if ddx * ddx + ddy * ddy <= SLOT_ARRIVAL_RADIUS * SLOT_ARRIVAL_RADIUS {
                let interval = self.resolve_gather_interval(world, worker.eid, DEFAULT_GATHER_TICKS_PER_UNIT);
                queue.push(Activity::Gather { ticks_per_unit: interval, elapsed_ticks: 0.0 });
                return true;
            }
            queue.push(move_activity(&[slot.0, slot.1]).expect("move activity"));
            self.set_move_target(world, comps, worker.eid, slot.0, slot.1);
            self.reset_steering(world, comps, worker.eid);
            return true;
        }
    }

    /// One gather tick. Runs after the movement system with the same
    /// drained command list (TS registerSystem order).
    pub fn run(
        &mut self,
        world: &mut CoreWorld,
        comps: &MovementComps,
        econ: &EconomyComps,
        layers: &Layers,
        paths_version: u32,
        commands: &[Command],
    ) {
        let size = layers.size;
        let passability = &layers.passability;

        // 1) Commands on their target-tick boundary; foreign kinds skip.
        for command in commands {
            if command.kind == SET_AUTO_RESEED_COMMAND_KIND {
                if let Some(data) = &command.data {
                    if let (Some(player), Some(enabled)) = (
                        data.get("playerId").and_then(|v| v.as_f64()),
                        data.get("enabled").and_then(|v| v.as_bool()),
                    ) {
                        self.auto_reseed.insert(player as i64, enabled);
                    }
                }
                continue;
            }
            if command.kind != "gather" {
                continue;
            }
            let data = command.data.as_ref().expect("gather requires command data");
            self.apply_gather_command(world, comps, econ, data);
        }

        // 2) Assigned workers grouped by node, ascending eid.
        let mut workers_by_node: BTreeMap<Eid, Vec<(Eid, f64, f64)>> = BTreeMap::new();
        for &eid in &world.entities {
            let Some(assigned) = row(world, econ.assigned_node, eid) else { continue };
            let (Some(pos), true, true) = (
                row(world, comps.position, eid),
                row(world, comps.velocity, eid).is_some(),
                row(world, comps.unit_tag, eid).is_some(),
            ) else {
                continue;
            };
            let node_eid = assigned[0] as Eid;
            workers_by_node.entry(node_eid).or_default().push((eid, pos[0], pos[1]));
        }

        // 3) Claim resolution per node: ascending-eid priority.
        let mut claimed: Vec<ClaimedWorker> = Vec::new();
        let mut vanished: Vec<Eid> = Vec::new();
        for (node_eid, group) in &workers_by_node {
            let node_row = row(world, econ.resource_node, *node_eid).cloned();
            let node_pos = row(world, comps.position, *node_eid).cloned();
            let (Some(node_row), Some(node_pos)) = (node_row, node_pos) else {
                vanished.extend(group.iter().map(|g| g.0));
                continue;
            };
            let limit = (node_row[2].max(0.0) as usize).min(WORK_SLOTS_PER_NODE as usize);
            let node_tile_x = node_pos[0].floor() as i64;
            let node_tile_y = node_pos[1].floor() as i64;
            let terrain = layers.terrain[node_tile_y as usize * size + node_tile_x as usize];
            if is_water_terrain(terrain) {
                panic!("gather: water-node slot passability lands with the navigability port (node {node_eid})");
            }
            let slots = work_slot_positions(passability, size, node_tile_x, node_tile_y, limit);
            for (i, &(eid, pos_x, pos_y)) in group.iter().enumerate() {
                let slotted = i < slots.len();
                let slot_index: i64 = if slotted { i as i64 } else { -1 };
                let overflow_rank: i64 = if slotted { -1 } else { (i - slots.len()) as i64 };
                {
                    let assigned = rows_mut(world, econ.assigned_node).get_mut(&eid).expect("assigned row");
                    if assigned[1] != slot_index as f64 {
                        assigned[1] = slot_index as f64;
                    }
                }
                let (mut holding_x, mut holding_y) = (node_pos[0], node_pos[1]);
                if !slotted {
                    let (dx, dy) = formation_slot_offset(&self.lut, OVERFLOW_RING_START_INDEX + overflow_rank as usize);
                    holding_x = (node_pos[0] + dx).clamp(0.5, size as f64 - 0.5);
                    holding_y = (node_pos[1] + dy).clamp(0.5, size as f64 - 0.5);
                }
                claimed.push(ClaimedWorker {
                    eid,
                    pos_x,
                    pos_y,
                    node_eid: *node_eid,
                    resource_code: node_row[0] as i64,
                    slot_index,
                    overflow_rank,
                    slots: slots.clone(),
                    holding_x,
                    holding_y,
                });
            }
        }
        for eid in vanished {
            self.release_worker(world, comps, econ, eid);
        }
        claimed.sort_by_key(|w| w.eid);

        // 4) Per-worker activity state machine (ascending eid).
        for worker in &claimed {
            let mut queue = read_queue(world, comps, worker.eid);
            let mut dirty = false;
            loop {
                let Some(head) = peek(&queue).cloned() else {
                    dirty = self.plan_next_leg(world, comps, econ, layers, paths_version, worker, &mut queue) || dirty;
                    break;
                };
                match head {
                    Activity::Move { .. } => {
                        if let Some(Activity::Deliver { dropoff_eid }) = queue.get(1).cloned() {
                            let target = dropoff_eid as Eid;
                            if !self.drop_off_alive(world, econ, target) {
                                cancel_activities(&mut queue);
                                self.diagnostics.destroyed_dropoff_reroutes += 1;
                                dirty = true;
                                continue;
                            }
                            let drop = self.drop_off_position(world, comps, target);
                            if Self::within_deliver_range(worker, drop) || self.jammed_near_drop_off(world, comps, worker, drop) {
                                let _ = self.execute_deliver_head(world, comps, econ, worker, target);
                                cancel_activities(&mut queue);
                                dirty = true;
                                continue;
                            }
                        }
                        break; // movement owns this head
                    }
                    Activity::Wait { .. } => break,
                    Activity::Gather { .. } => {
                        dirty = true;
                        if self.advance_gather_head(world, comps, econ, worker, &mut queue) {
                            dequeue_current(&mut queue);
                            continue;
                        }
                        break;
                    }
                    Activity::Deliver { dropoff_eid } => {
                        let target = dropoff_eid as Eid;
                        if !self.drop_off_alive(world, econ, target) {
                            cancel_activities(&mut queue);
                            self.diagnostics.destroyed_dropoff_reroutes += 1;
                            dirty = true;
                            continue;
                        }
                        let drop = self.drop_off_position(world, comps, target);
                        if Self::within_deliver_range(worker, drop) || self.jammed_near_drop_off(world, comps, worker, drop) {
                            let _ = self.execute_deliver_head(world, comps, econ, worker, target);
                            cancel_activities(&mut queue);
                            dirty = true;
                            continue;
                        }
                        // Stale Deliver head without its Move pair: rebuild.
                        let _ = self.is_naval(world, worker.eid);
                        let door = self.deliver_door(size, worker.pos_x, worker.pos_y, drop);
                        queue.clear();
                        queue.push(move_activity(&[door.0, door.1]).expect("move activity"));
                        queue.push(Activity::Deliver { dropoff_eid });
                        self.set_move_target(world, comps, worker.eid, door.0, door.1);
                        self.reset_steering(world, comps, worker.eid);
                        dirty = true;
                        break;
                    }
                    _ => break,
                }
            }
            if dirty {
                write_queue(world, comps, worker.eid, &queue);
            }
        }
    }
}

/// Full economy scenario runner mirroring TS `step()` plumbing with
/// systems in registration order (movement, gather, placement,
/// construction, training).
pub struct EconomySim {
    pub movement: MovementSim,
    pub econ: EconomyComps,
    pub gather: GatherSystem,
    pub placement: crate::placement::PlacementSystem,
    pub construction: crate::construction::ConstructionSystem,
    pub training: crate::training::TrainingSystem,
    pub production: crate::production::ProductionSystem,
    pub age: crate::age::AgeSystem,
}

impl EconomySim {
    pub fn new(
        seed: u32,
        size: usize,
        transport: crate::path::Transport,
        defs: Arc<Defs>,
        traits: Arc<TraitsData>,
    ) -> Result<EconomySim, String> {
        let movement = MovementSim::new(seed, size, transport)?;
        let econ = EconomyComps::from_world(&movement.world);
        let pop = PopComps::from_world(&movement.world);
        let bcomps = crate::buildings::BuildingComps::from_world(&movement.world);
        let age = crate::buildings::AgeComps::from_world(&movement.world);
        let ccomps = crate::combat::CombatComps::from_world(&movement.world);
        let gather = GatherSystem::new(
            defs.clone(),
            traits.clone(),
            pop,
            ccomps,
            GatherComps::from_world(&movement.world),
        );
        let placement = crate::placement::PlacementSystem::new(defs.clone(), bcomps, age);
        let construction = crate::construction::ConstructionSystem::new(defs.clone(), traits.clone(), pop, bcomps);
        let pcomps = crate::production::ProductionComps::from_world(&movement.world);
        let training = crate::training::TrainingSystem::new(defs.clone(), traits, pop, bcomps, ccomps, age);
        let production = crate::production::ProductionSystem::new(defs.clone(), pop, bcomps, age, pcomps);
        let age_system = crate::age::AgeSystem::new(defs, bcomps, ccomps, age);
        Ok(EconomySim { movement, econ, gather, placement, construction, training, production, age: age_system })
    }

    pub fn spawn_unit(&mut self, x: f64, y: f64) -> Eid {
        self.movement.spawn_unit(x, y)
    }

    pub fn submit(&mut self, command: Command) -> Result<(), String> {
        self.movement.submit(command)
    }

    pub fn step(&mut self) -> bool {
        if !self.movement.step() {
            return false;
        }
        let econ = self.econ;
        let MovementSim { world, comps, layers, paths, last_commands, .. } = &mut self.movement;
        let version = paths.passability_version();
        self.gather.run(world, comps, &econ, layers, version, last_commands);
        self.placement.run(world, comps, &econ, layers, paths, last_commands);
        self.construction.run(world, comps, &econ, layers, last_commands);
        self.training.run(world, comps, &econ, layers, last_commands);
        self.age.run(world, comps, &econ, last_commands);
        self.production.run(world, comps, &econ, layers, last_commands);
        true
    }

    pub fn frame(&mut self) -> bool {
        self.movement.advance_transport();
        self.step()
    }

    pub fn digest(&self) -> String {
        self.movement.digest()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::economy::{
        assigned_node, create_drop_off, create_player_stockpile, resource_node_row, spawn_resource_node,
        stockpile_amounts, PLAYER_ONE,
    };
    use crate::path::{MockWorker, Transport};
    use serde::Deserialize;
    use std::sync::OnceLock;

    fn defs() -> Arc<Defs> {
        static DEFS: OnceLock<Arc<Defs>> = OnceLock::new();
        DEFS.get_or_init(|| Arc::new(Defs::load_repo_defaults().expect("load defs"))).clone()
    }

    fn traits() -> Arc<TraitsData> {
        static TRAITS: OnceLock<Arc<TraitsData>> = OnceLock::new();
        TRAITS
            .get_or_init(|| Arc::new(TraitsData::load_repo_defaults().expect("load traits")))
            .clone()
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
    struct Fixture {
        seed: u32,
        size: usize,
        ticks: u64,
        #[serde(rename = "milestoneEvery")]
        milestone_every: u64,
        spawns: Vec<FixtureSpawn>,
        nodes: Vec<FixtureNode>,
        #[serde(rename = "dropOffs")]
        drop_offs: Vec<FixturePoint>,
        commands: Vec<FixtureCommand>,
    }

    fn load_fixture() -> Fixture {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t9/case.json");
        let text = std::fs::read_to_string(path).expect("read m1t9 case.json");
        serde_json::from_str(&text).expect("parse m1t9 case")
    }

    fn expected_digests() -> Vec<(u64, String)> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t9/__snapshots__");
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
            let num: String = after[tick_at + 7..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            out.push((num.parse::<u64>().expect("tick"), digest));
            rest = &rest[i + 24..];
        }
        assert_eq!(out.len(), 30, "m1t9 snapshot holds 30 milestones");
        out
    }

    struct RunOut {
        digests: Vec<(u64, String)>,
        positions: Vec<(Eid, f64, f64)>,
        diagnostics: GatherDiagnostics,
        blocked_ticks: u64,
        stockpiles: Vec<f64>,
        carried: Vec<f64>,
        remaining: Vec<f64>,
        claims: Vec<(Eid, Eid, f64)>, // (worker, node, slot)
        passability: Vec<u8>,
        size: usize,
    }

    fn run_scenario(worker_backed: bool) -> RunOut {
        let fixture = load_fixture();
        let transport = if worker_backed {
            Transport::Mock(MockWorker::new(|id| (id - 1) % 3))
        } else {
            Transport::synchronous()
        };
        let mut sim = EconomySim::new(fixture.seed, fixture.size, transport, defs(), traits()).unwrap();
        let econ = sim.econ;
        for spawn in &fixture.spawns {
            let eid = sim.spawn_unit(spawn.x, spawn.y);
            assert_eq!(eid as i64, spawn.eid, "fixture spawn order");
        }
        let world = &mut sim.movement.world;
        create_player_stockpile(world, &econ, PLAYER_ONE, None).unwrap();
        for point in &fixture.drop_offs {
            create_drop_off(world, &econ, point.x, point.y, PLAYER_ONE, None).unwrap();
        }
        let mut node_ids = Vec::new();
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(&node.resource).expect("resource slug");
            node_ids.push(spawn_resource_node(world, &econ, node.tile_x, node.tile_y, code, node.amount, None).unwrap());
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let mut digests = Vec::new();
        let mut iterations = 0u64;
        while sim.movement.world.tick < fixture.ticks {
            let before = sim.movement.world.tick;
            sim.frame();
            iterations += 1;
            assert!(iterations <= fixture.ticks * 20, "scenario failed to reach final tick");
            if sim.movement.world.tick == before {
                continue;
            }
            let t = sim.movement.world.tick;
            if t % fixture.milestone_every == 0 || t == fixture.ticks {
                digests.push((t, sim.digest()));
            }
        }
        let world = &sim.movement.world;
        let comps = sim.movement.comps;
        let positions = fixture
            .spawns
            .iter()
            .map(|s| {
                let p = world.rows_by_component[comps.position].get(&(s.eid as Eid)).expect("pos");
                (s.eid as Eid, p[0], p[1])
            })
            .collect();
        let mut carried = vec![0.0f64; 7];
        for s in &fixture.spawns {
            if let Some((code, amount)) = inventory(world, &econ, s.eid as Eid) {
                if amount > 0.0 {
                    carried[code as usize] += amount;
                }
            }
        }
        let remaining = node_ids.iter().map(|&id| resource_node_row(world, &econ, id).expect("node row")[1]).collect();
        let mut claims = Vec::new();
        for &eid in &world.entities {
            if let Some((node, slot)) = assigned_node(world, &econ, eid) {
                claims.push((eid, node, slot));
            }
        }
        RunOut {
            digests,
            positions,
            diagnostics: sim.gather.diagnostics.clone(),
            blocked_ticks: sim.movement.paths.blocked_ticks(),
            stockpiles: stockpile_amounts(world, &econ, PLAYER_ONE),
            carried,
            remaining,
            claims,
            passability: sim.movement.layers.passability.clone(),
            size: sim.movement.layers.size,
        }
    }

    #[test]
    fn m1t9_sync_matches_ts_snapshot_and_ledger_closes() {
        let out = run_scenario(false);
        assert_eq!(out.digests, expected_digests());
        assert_eq!(out.diagnostics.commands_applied, 4);
        assert_eq!(out.blocked_ticks, 0);
        for code in 0..7 {
            assert_eq!(
                out.diagnostics.extracted_by_resource[code],
                out.diagnostics.deposited_by_resource[code] + out.carried[code],
                "ledger closure code {code}"
            );
        }
        assert_eq!(out.stockpiles, out.diagnostics.deposited_by_resource.to_vec());
        assert_eq!(out.remaining[0], 0.0, "main wood node depletes");
        // All villagers end on passable tiles.
        for (_, x, y) in &out.positions {
            let (tx, ty) = (x.floor() as usize, y.floor() as usize);
            assert_eq!(out.passability[ty * out.size + tx], 1);
        }
        // Slot claims exclusive per node; dry nodes hold no workers.
        let mut by_node: BTreeMap<Eid, Vec<f64>> = BTreeMap::new();
        for (_, node, slot) in &out.claims {
            by_node.entry(*node).or_default().push(*slot);
        }
        for (node, slots) in &by_node {
            let slotted: Vec<f64> = slots.iter().copied().filter(|s| *s >= 0.0).collect();
            let mut distinct = slotted.clone();
            distinct.sort_by(|a, b| a.partial_cmp(b).unwrap());
            distinct.dedup();
            assert_eq!(distinct.len(), slotted.len(), "node {node} slots exclusive");
            assert!(slotted.len() <= 8);
            if slots.iter().any(|s| *s < 0.0) {
                assert_eq!(slotted.len(), 8, "overflow only at full capacity");
            }
        }
    }

    #[test]
    fn m2t2_filtered_dropoffs_match_ts_snapshot() {
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
        struct M2Fixture {
            seed: u32,
            size: usize,
            ticks: u64,
            #[serde(rename = "milestoneEvery")]
            milestone_every: u64,
            stockpile: std::collections::BTreeMap<String, f64>,
            spawns: Vec<FixtureSpawn>,
            buildings: Vec<FixtureBuilding>,
            nodes: Vec<FixtureNode2>,
            commands: Vec<FixtureCommand>,
        }
        #[derive(Deserialize)]
        struct FixtureNode2 {
            eid: i64,
            #[serde(rename = "tileX")]
            tile_x: i64,
            #[serde(rename = "tileY")]
            tile_y: i64,
            resource: String,
            amount: i64,
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t2/case.json");
        let fixture: M2Fixture = serde_json::from_str(&std::fs::read_to_string(path).expect("case")).expect("parse case");
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
        {
            let bcomps = crate::buildings::BuildingComps::from_world(&sim.movement.world);
            let age = crate::buildings::AgeComps::from_world(&sim.movement.world);
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
        let mut node_ids = Vec::new();
        for node in &fixture.nodes {
            let code = crate::economy::resource_code_of_slug(&node.resource).expect("slug");
            let eid = spawn_resource_node(&mut sim.movement.world, &econ, node.tile_x, node.tile_y, code, node.amount, None).unwrap();
            assert_eq!(eid as i64, node.eid, "node order");
            node_ids.push(eid);
        }
        for command in &fixture.commands {
            sim.submit(Command { kind: command.kind.clone(), target_tick: command.target_tick, data: Some(command.data.clone()) })
                .unwrap();
        }
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m2t2/__snapshots__");
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
        let diag = &sim.gather.diagnostics;
        assert_eq!(diag.rejected_by_filter, 0);
        assert!(diag.deliveries_by_drop_off.len() >= 3);
        assert!(diag.deliveries_by_drop_off[0] > 0.0, "wood to lumber camp");
        assert!(diag.deliveries_by_drop_off[1] > 0.0, "ores to mining camp");
        assert!(diag.deliveries_by_drop_off[2] > 0.0, "food to mill");
        let world = &sim.movement.world;
        let mut carried = [0.0f64; 7];
        for spawn in &fixture.spawns {
            if let Some((code, amount)) = inventory(world, &econ, spawn.eid as Eid) {
                if amount > 0.0 {
                    carried[code as usize] += amount;
                }
            }
        }
        for code in 0..7 {
            assert_eq!(
                diag.extracted_by_resource[code],
                diag.deposited_by_resource[code] + carried[code],
                "ledger code {code}"
            );
        }
        let final_amounts = stockpile_amounts(world, &econ, PLAYER_ONE);
        for code in 0..7 {
            assert_eq!(final_amounts[code], amounts[code] + diag.deposited_by_resource[code]);
        }
        for (i, &id) in node_ids.iter().enumerate() {
            let remaining = resource_node_row(world, &econ, id).expect("node")[1];
            assert!(remaining <= fixture.nodes[i].amount as f64);
        }
    }

    #[test]
    fn m1t9_worker_mock_byte_identical() {
        let sync = run_scenario(false);
        let worker = run_scenario(true);
        assert_eq!(worker.digests, sync.digests);
        assert_eq!(worker.positions.len(), sync.positions.len());
        for ((e1, x1, y1), (e2, x2, y2)) in sync.positions.iter().zip(&worker.positions) {
            assert_eq!(e1, e2);
            assert_eq!((x1.to_bits(), y1.to_bits()), (x2.to_bits(), y2.to_bits()), "eid {e1} position bits");
        }
        assert_eq!(worker.diagnostics, sync.diagnostics);
        assert_eq!(worker.stockpiles, sync.stockpiles);
        assert_eq!(worker.remaining, sync.remaining);
        assert!(worker.blocked_ticks > 0, "mock must hold ticks");
    }
}

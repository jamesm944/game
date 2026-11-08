//! Combat component rows + combatant spawner: Rust port of the spawn
//! slice of `src/sim/components/combat.ts` (SPEC §2.5 / M2-T5).
//! Combat (5): [defCode, ownerPlayerId, hp, targetEid, cooldownTicks].
//! The combat SYSTEM lands with its own epic; this module covers the
//! row shape training spawns and the naval predicate gather reads.
//! Civ hp/speed folds read `world.civilizations` in TS — civ-less
//! here, definition values verbatim. Monk faith rows land with the
//! faith port (training a monk panics loudly until then).
use crate::core::{Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::movement::MovementComps;
use crate::pop::{self, PopComps, TraitsData};

pub const DEFAULT_COMBAT_RADIUS: f64 = 0.25;

#[derive(Clone, Copy)]
pub struct CombatComps {
    pub combat: usize,
    pub combat_events: usize,
    pub faith: usize,
    pub morale: usize,
}

impl CombatComps {
    pub fn from_world(world: &CoreWorld) -> CombatComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        CombatComps {
            combat: id("Combat"),
            combat_events: id("CombatEvents"),
            faith: id("Faith"),
            morale: id("Morale"),
        }
    }
}

fn set_row(world: &mut CoreWorld, component: usize, eid: Eid, values: &[f64]) {
    world.set_values(component, eid, values).expect("registered component");
}

/// Turn-rate personality hash (mirrors TS spawnUnit/spawnCombatUnit —
/// same stream `movement::spawn_unit` already uses component-side).
fn default_turn_rate(seed: u32, eid: Eid) -> f64 {
    let mut z = seed ^ (eid as u32).wrapping_mul(0x9e37_79b9);
    if z == 0 {
        z = 0x1;
    }
    z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
    z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
    let unit = ((z ^ (z >> 15)) as f64) / 4_294_967_296.0;
    5.5 + unit * 3.0
}

pub struct SpawnCombatOptions {
    pub body: bool,
    pub identity: bool,
    pub morale: bool,
}

/// Spawn one attack-capable unit: movement set + Combat row at full
/// definition hp, cruise speed from the definition.
pub fn spawn_combat_unit(
    world: &mut CoreWorld,
    comps: &MovementComps,
    ccomps: &CombatComps,
    pop: &PopComps,
    traits: &TraitsData,
    defs: &Defs,
    def_id: &str,
    x: f64,
    y: f64,
    player_id: f64,
    options: &SpawnCombatOptions,
) -> Eid {
    assert!(player_id >= 0.0 && player_id.fract() == 0.0, "combat unit owner must be a non-negative integer, got {player_id}");
    let def = defs.unit(def_id).clone();
    let eid = world.spawn();
    set_row(world, comps.position, eid, &[x, y]);
    set_row(world, comps.velocity, eid, &[0.0; 8]);
    set_row(
        world,
        comps.unit_tag,
        eid,
        &[def.speed, default_turn_rate(world.seed, eid), DEFAULT_COMBAT_RADIUS],
    );
    set_row(world, comps.move_target, eid, &[x, y]);
    set_row(world, comps.activity_queue, eid, &[0.0]); // encoded empty queue
    set_row(
        world,
        ccomps.combat,
        eid,
        &[defs.unit_code(def_id) as f64, player_id, def.hp as f64, 0.0, 0.0],
    );
    if options.body {
        pop::attach_body(world, pop, eid);
    }
    if options.identity {
        pop::attach_pop_identity(world, pop, traits, eid, false);
        pop::attach_pop_skills(world, pop, eid);
        pop::attach_pop_needs(world, pop, eid);
        pop::attach_lessons(world, pop, eid);
    }
    if options.morale {
        panic!("combat spawn: Morale row lands with the morale port (eid {eid})");
    }
    if def.armor_classes.iter().any(|c| c == "monk") || def_id == "monk" || def.max_faith.is_some() {
        attach_faith(world, ccomps, eid, def.max_faith.unwrap_or(100.0));
    }
    eid
}

pub fn combat_row<'a>(world: &'a CoreWorld, ccomps: &CombatComps, eid: Eid) -> Option<&'a Vec<f64>> {
    world.rows_by_component.get(ccomps.combat).and_then(|r| r.get(&eid))
}

/// True when the entity's Combat definition carries the "ship" class.
pub fn is_naval_unit(world: &CoreWorld, ccomps: &CombatComps, defs: &Defs, eid: Eid) -> bool {
    let Some(r) = combat_row(world, ccomps, eid) else { return false };
    let unit_id = defs.unit_id_of_code(r[0] as u32);
    defs.unit(unit_id).armor_classes.iter().any(|c| c == "ship")
}

// ---- event log (components/combat.ts) ----

pub const COMBAT_EVENT_DAMAGE: f64 = 0.0;
pub const COMBAT_EVENT_DEATH: f64 = 1.0;
pub const COMBAT_EVENT_SHOT: f64 = 2.0;
pub const COMBAT_EVENT_UNIT_DEATH: f64 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CombatEvent {
    pub tick: u64,
    pub kind: f64,
    pub attacker_eid: Eid,
    pub victim_eid: Eid,
    pub amount: f64,
}

fn ledger_eid(world: &CoreWorld, econ: &crate::economy::EconomyComps, player_id: f64) -> Eid {
    world.rows_by_component[econ.stockpile]
        .iter()
        .find(|(_, r)| r[0] == player_id)
        .map(|(e, _)| *e)
        .unwrap_or_else(|| panic!("player {player_id} has no stockpile entity"))
}

pub fn ledger_eid_opt(world: &CoreWorld, econ: &crate::economy::EconomyComps, player_id: f64) -> Option<Eid> {
    world.rows_by_component[econ.stockpile]
        .iter()
        .find(|(_, r)| r[0] == player_id)
        .map(|(e, _)| *e)
}

pub fn append_combat_event(
    world: &mut CoreWorld,
    ccomps: &CombatComps,
    econ: &crate::economy::EconomyComps,
    player_id: f64,
    event: CombatEvent,
) {
    let eid = ledger_eid(world, econ, player_id);
    let rows = world.rows_by_component.get_mut(ccomps.combat_events).expect("registered component");
    let r = rows.entry(eid).or_insert_with(|| vec![0.0]);
    r.push(event.tick as f64);
    r.push(event.kind);
    r.push(event.attacker_eid as f64);
    r.push(event.victim_eid as f64);
    r.push(event.amount);
    r[0] += 1.0;
}

pub fn read_combat_events(world: &CoreWorld, ccomps: &CombatComps, econ: &crate::economy::EconomyComps, player_id: f64) -> Vec<CombatEvent> {
    let eid = ledger_eid(world, econ, player_id);
    let Some(r) = world.rows_by_component[ccomps.combat_events].get(&eid) else { return Vec::new() };
    (0..r[0] as usize)
        .map(|i| CombatEvent {
            tick: r[1 + i * 5] as u64,
            kind: r[2 + i * 5],
            attacker_eid: r[3 + i * 5] as Eid,
            victim_eid: r[4 + i * 5] as Eid,
            amount: r[5 + i * 5],
        })
        .collect()
}

// ---- stance / faith / morale rows ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitStance {
    Aggressive,
    Defensive,
    StandGround,
    NoAttack,
}

impl UnitStance {
    pub fn code(&self) -> f64 {
        match self {
            UnitStance::Aggressive => 0.0,
            UnitStance::Defensive => 1.0,
            UnitStance::StandGround => 2.0,
            UnitStance::NoAttack => 3.0,
        }
    }
    pub fn from_code(code: f64) -> UnitStance {
        match code as i64 {
            1 => UnitStance::Defensive,
            2 => UnitStance::StandGround,
            3 => UnitStance::NoAttack,
            _ => UnitStance::Aggressive,
        }
    }
    pub fn parse(value: &serde_json::Value) -> UnitStance {
        match value.as_str() {
            Some("aggressive") => UnitStance::Aggressive,
            Some("defensive") => UnitStance::Defensive,
            Some("stand-ground") => UnitStance::StandGround,
            Some("no-attack") => UnitStance::NoAttack,
            other => panic!("invalid unit stance: {other:?}"),
        }
    }
}

#[derive(Clone, Copy)]
pub struct CombatAuxComps {
    pub stance: usize,
    pub equipment: usize,
    pub relic: usize,
    pub formation: usize,
}

impl CombatAuxComps {
    pub fn from_world(world: &CoreWorld) -> CombatAuxComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        CombatAuxComps {
            stance: id("Stance"),
            equipment: id("Equipment"),
            relic: id("Relic"),
            formation: id("Formation"),
        }
    }
}

pub fn get_stance(world: &CoreWorld, aux: &CombatAuxComps, eid: Eid) -> UnitStance {
    world.rows_by_component[aux.stance].get(&eid).map(|r| UnitStance::from_code(r[0])).unwrap_or(UnitStance::Aggressive)
}

pub fn set_stance(world: &mut CoreWorld, aux: &CombatAuxComps, eid: Eid, stance: UnitStance) {
    world.set_values(aux.stance, eid, &[stance.code()]).expect("registered component");
}

pub fn attach_stance(world: &mut CoreWorld, aux: &CombatAuxComps, eid: Eid, stance: UnitStance) {
    set_stance(world, aux, eid, stance);
}

pub fn faith_row_mut<'a>(world: &'a mut CoreWorld, ccomps: &CombatComps, eid: Eid) -> Option<&'a mut Vec<f64>> {
    world.rows_by_component.get_mut(ccomps.faith).and_then(|r| r.get_mut(&eid))
}
pub fn get_faith(world: &CoreWorld, ccomps: &CombatComps, eid: Eid) -> f64 {
    world.rows_by_component[ccomps.faith].get(&eid).map(|r| r[0]).unwrap_or(0.0)
}
pub fn set_faith(world: &mut CoreWorld, ccomps: &CombatComps, eid: Eid, faith: f64) {
    if let Some(r) = faith_row_mut(world, ccomps, eid) {
        r[0] = faith;
    }
}
pub fn get_conversion_progress(world: &CoreWorld, ccomps: &CombatComps, eid: Eid) -> f64 {
    world.rows_by_component[ccomps.faith].get(&eid).map(|r| r[2]).unwrap_or(0.0)
}
pub fn set_conversion(world: &mut CoreWorld, ccomps: &CombatComps, eid: Eid, target: Eid, progress: f64) {
    if let Some(r) = faith_row_mut(world, ccomps, eid) {
        r[1] = target as f64;
        r[2] = progress;
    }
}
pub fn clear_conversion(world: &mut CoreWorld, ccomps: &CombatComps, eid: Eid) {
    if let Some(r) = faith_row_mut(world, ccomps, eid) {
        r[1] = 0.0;
        r[2] = 0.0;
    }
}
pub fn attach_faith(world: &mut CoreWorld, ccomps: &CombatComps, eid: Eid, initial: f64) {
    world.set_values(ccomps.faith, eid, &[initial, 0.0, 0.0]).expect("registered component");
}

pub fn is_routing(world: &CoreWorld, ccomps: &CombatComps, eid: Eid) -> bool {
    world.rows_by_component[ccomps.morale].get(&eid).map(|r| r[0]).unwrap_or(0.0) == 1.0
}

pub fn equipment_counts(world: &CoreWorld, aux: &CombatAuxComps, eid: Eid) -> crate::combat_stats::EquipmentCounts {
    match world.rows_by_component[aux.equipment].get(&eid) {
        Some(r) => crate::combat_stats::EquipmentCounts { weapons: r[0], armor: r[1] },
        None => Default::default(),
    }
}

pub fn get_formation(world: &CoreWorld, aux: &CombatAuxComps, eid: Eid) -> crate::combat_stats::FormationKind {
    world
        .rows_by_component[aux.formation]
        .get(&eid)
        .map(|r| crate::combat_stats::FormationKind::from_code(r[0]))
        .unwrap_or(crate::combat_stats::FormationKind::Line)
}

// ---- garrison rows (components/garrison.ts) ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GarrisonedUnit {
    pub unit_code: f64,
    pub owner: f64,
    pub hp: f64,
    pub max_hp: f64,
    pub stance_code: f64,
}

pub fn read_garrison(world: &CoreWorld, bcomps: &crate::buildings::BuildingComps, eid: Eid) -> Vec<GarrisonedUnit> {
    let Some(r) = world.rows_by_component[bcomps.garrison].get(&eid) else { return Vec::new() };
    (0..r[0] as usize)
        .map(|i| GarrisonedUnit {
            unit_code: r[1 + i * 5],
            owner: r[2 + i * 5],
            hp: r[3 + i * 5],
            max_hp: r[4 + i * 5],
            stance_code: r[5 + i * 5],
        })
        .collect()
}

pub fn write_garrison(world: &mut CoreWorld, bcomps: &crate::buildings::BuildingComps, eid: Eid, units: &[GarrisonedUnit]) {
    let mut r = vec![units.len() as f64];
    for u in units {
        r.extend_from_slice(&[u.unit_code, u.owner, u.hp, u.max_hp, u.stance_code]);
    }
    world.set_values(bcomps.garrison, eid, &r).expect("registered component");
}

pub fn clear_garrison(world: &mut CoreWorld, bcomps: &crate::buildings::BuildingComps, eid: Eid) -> Vec<GarrisonedUnit> {
    let units = read_garrison(world, bcomps, eid);
    world.rows_by_component.get_mut(bcomps.garrison).map(|r| r.remove(&eid));
    units
}

pub fn garrison_count(world: &CoreWorld, bcomps: &crate::buildings::BuildingComps, eid: Eid) -> f64 {
    world.rows_by_component[bcomps.garrison].get(&eid).filter(|r| !r.is_empty()).map(|r| r[0]).unwrap_or(0.0)
}

// ---- relic grounding on death (components/relic.ts) ----

const RELIC_GROUND: f64 = 0.0;
const RELIC_CARRIED: f64 = 1.0;
const RELIC_STORED: f64 = 2.0;

fn ground_relics_held_by(world: &mut CoreWorld, aux: &CombatAuxComps, comps: &MovementComps, state: f64, holder: Eid) -> u64 {
    let Some(pos) = world.rows_by_component[comps.position].get(&holder).cloned() else { return 0 };
    let mut grounded = 0;
    let relic_eids: Vec<Eid> = world.rows_by_component[aux.relic].keys().copied().collect();
    for relic_eid in relic_eids {
        let matches = {
            let r = &world.rows_by_component[aux.relic][&relic_eid];
            r[0] == state && r[1] == holder as f64
        };
        if !matches {
            continue;
        }
        world.set_values(aux.relic, relic_eid, &[RELIC_GROUND, 0.0]).expect("registered component");
        world.set_values(comps.position, relic_eid, &[pos[0], pos[1]]).expect("registered component");
        grounded += 1;
    }
    grounded
}

pub fn drop_carried_relics(world: &mut CoreWorld, aux: &CombatAuxComps, comps: &MovementComps, unit_eid: Eid) -> u64 {
    ground_relics_held_by(world, aux, comps, RELIC_CARRIED, unit_eid)
}

pub fn drop_stored_relics(world: &mut CoreWorld, aux: &CombatAuxComps, comps: &MovementComps, building_eid: Eid) -> u64 {
    ground_relics_held_by(world, aux, comps, RELIC_STORED, building_eid)
}

// ---- strike injuries (systems/injuries.ts allocation path) ----

pub const INJURY_SEVERITY_PER_DAMAGE: f64 = 2.0;
pub const INJURY_DURATION_TICKS: f64 = 1500.0;
pub const DEATH_SEVERITY_THRESHOLD: f64 = 100.0;
const PART_INJURY_CAPACITY: f64 = 100.0;
const INJURY_STACK_STRIDE: usize = 3;
const PART_WEIGHT_BASIS_POINTS: [u32; 6] = [3000, 5000, 6500, 8000, 9000, 10000];
const PART_CODES_BY_ROLL_ORDER: [f64; 6] = [5.0, 2.0, 0.0, 1.0, 3.0, 4.0]; // torso, head, armL, armR, legL, legR
const INJURY_STREAM_DOMAIN: u32 = 0x626f_6479;

fn mix32(mut z: u32) -> u32 {
    z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
    z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
    z ^ (z >> 15)
}

pub fn strike_part_roll(seed: u32, victim: Eid, tick: u64, stack_count: f64) -> u32 {
    let mut z = seed ^ INJURY_STREAM_DOMAIN;
    if z == 0 {
        z = 1;
    }
    z = mix32(z ^ ((victim as u32).wrapping_add(1)).wrapping_mul(0x9e37_79b9));
    z = mix32(z ^ ((tick as u32).wrapping_add(1)).wrapping_mul(0x85eb_ca6b));
    z = mix32(z ^ ((stack_count as u32).wrapping_add(1)).wrapping_mul(0xc2b2_ae35));
    z % 10_000
}

fn part_code_for_roll(roll: u32) -> f64 {
    for (i, bound) in PART_WEIGHT_BASIS_POINTS.iter().enumerate() {
        if roll < *bound {
            return PART_CODES_BY_ROLL_ORDER[i];
        }
    }
    PART_CODES_BY_ROLL_ORDER[5]
}

pub fn cumulative_active_severity(row: &[f64]) -> f64 {
    let count = row[0] as usize;
    (0..count).map(|i| row[1 + i * INJURY_STACK_STRIDE + 1]).sum()
}

fn group_severity(row: &[f64], part: f64) -> f64 {
    let count = row[0] as usize;
    (0..count)
        .filter(|i| row[1 + i * INJURY_STACK_STRIDE] == part)
        .map(|i| row[1 + i * INJURY_STACK_STRIDE + 1])
        .sum()
}

fn add_injury_stack(world: &mut CoreWorld, pop: &PopComps, eid: Eid, part: f64, severity: f64, duration: f64) -> f64 {
    let Some(row) = world.rows_by_component.get_mut(pop.body).and_then(|r| r.get_mut(&eid)) else { return 0.0 };
    let held = group_severity(row, part);
    let stored = severity.min(PART_INJURY_CAPACITY - held);
    if stored <= 0.0 {
        return 0.0;
    }
    let count = row[0] as usize;
    let at = 1 + count * INJURY_STACK_STRIDE;
    row.insert(at, part);
    row.insert(at + 1, stored);
    row.insert(at + 2, duration);
    row[0] = count as f64 + 1.0;
    stored
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrikeInjuryOutcome {
    pub stored_severity: f64,
    pub fatal: bool,
}

pub fn apply_strike_injuries(world: &mut CoreWorld, pop: &PopComps, victim: Eid, damage: f64) -> StrikeInjuryOutcome {
    assert!(damage >= 1.0 && damage.fract() == 0.0, "strike injury requires positive integer damage, got {damage}");
    let Some(before) = world.rows_by_component[pop.body].get(&victim).map(|r| r[0]) else {
        return StrikeInjuryOutcome { stored_severity: 0.0, fatal: false };
    };
    let severity = damage * INJURY_SEVERITY_PER_DAMAGE;
    let part = part_code_for_roll(strike_part_roll(world.seed, victim, world.tick, before));
    let stored = add_injury_stack(world, pop, victim, part, severity, INJURY_DURATION_TICKS);
    let fatal = stored > 0.0
        && cumulative_active_severity(&world.rows_by_component[pop.body][&victim]) > DEATH_SEVERITY_THRESHOLD;
    StrikeInjuryOutcome { stored_severity: stored, fatal }
}

// ---- entity spatial hash (core/spatialHash.ts, nearest only) ----

const PICK_HASH_CELL: f64 = 2.0;

pub struct EntitySpatialHash {
    entries: Vec<(Eid, f64, f64)>,
    cells: std::collections::HashMap<i64, Vec<usize>>,
}

impl EntitySpatialHash {
    pub fn new() -> EntitySpatialHash {
        EntitySpatialHash { entries: Vec::new(), cells: std::collections::HashMap::new() }
    }

    pub fn insert(&mut self, eid: Eid, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let index = self.entries.len();
        self.entries.push((eid, x, y));
        let key = (x / PICK_HASH_CELL).floor() as i64 * 4096 + (y / PICK_HASH_CELL).floor() as i64;
        self.cells.entry(key).or_default().push(index);
    }

    pub fn nearest(&self, x: f64, y: f64, radius: f64, min_radius: f64) -> Option<(Eid, f64)> {
        if radius < 0.0 || radius.is_nan() {
            return None;
        }
        let radius_sq = radius * radius;
        let min_radius_sq = if min_radius > 0.0 { min_radius * min_radius } else { 0.0 };
        let mut best: Option<Eid> = None;
        let mut best_dist_sq = f64::INFINITY;
        let cy0 = ((y - radius) / PICK_HASH_CELL).floor() as i64;
        let cy1 = ((y + radius) / PICK_HASH_CELL).floor() as i64;
        let cx0 = ((x - radius) / PICK_HASH_CELL).floor() as i64;
        let cx1 = ((x + radius) / PICK_HASH_CELL).floor() as i64;
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                let Some(bucket) = self.cells.get(&(cx * 4096 + cy)) else { continue };
                for &index in bucket {
                    let (eid, ex, ey) = self.entries[index];
                    let (dx, dy) = (ex - x, ey - y);
                    let dist_sq = dx * dx + dy * dy;
                    if dist_sq > radius_sq || dist_sq < min_radius_sq {
                        continue;
                    }
                    if dist_sq < best_dist_sq || (dist_sq == best_dist_sq && best.map(|b| eid < b).unwrap_or(true)) {
                        best_dist_sq = dist_sq;
                        best = Some(eid);
                    }
                }
            }
        }
        best.map(|eid| (eid, best_dist_sq))
    }
}

impl Default for EntitySpatialHash {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::define_sim_components;

    #[test]
    fn combat_spawn_rows_match_contract() {
        let defs = Defs::load_repo_defaults().unwrap();
        let traits = TraitsData::load_repo_defaults().unwrap();
        let mut world = CoreWorld::new(7);
        let comps = define_sim_components(&mut world);
        let ccomps = CombatComps::from_world(&world);
        let pop = PopComps::from_world(&world);
        let archer = spawn_combat_unit(
            &mut world, &comps, &ccomps, &pop, &traits, &defs, "archer", 3.5, 4.5, 0.0,
            &SpawnCombatOptions { body: true, identity: false, morale: false },
        );
        let def = defs.unit("archer");
        assert_eq!(
            combat_row(&world, &ccomps, archer).unwrap(),
            &vec![1.0, 0.0, def.hp as f64, 0.0, 0.0],
            "archer code 1 at full hp"
        );
        let tag = &world.rows_by_component[comps.unit_tag][&archer];
        assert_eq!(tag[0], def.speed);
        assert_eq!(tag[2], 0.25);
        assert!(world.rows_by_component[pop.body].contains_key(&archer));
        assert!(!is_naval_unit(&world, &ccomps, &defs, archer));
    }
}

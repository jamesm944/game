//! Victory evaluators — Rust port of `src/sim/systems/victory.ts` +
//! `src/sim/components/victory.ts` (SPEC §2.11 / M2-T10, M4-T4/T5).
//!
//! Every path = generator → accumulating metric → completing act →
//! victory timer (Conquest timerless). Rows ride the VictoryCheck
//! component on each player's stockpile ledger entity:
//! `[entryCount, tick, pathCode, status, metric, …]` — digest-visible,
//! so the whole decision is replay-derivable with zero hidden state.
//! Diplomacy-less worlds (all current fixtures): every other player is
//! hostile, nobody is allied (TS `isAllied` fallback `p1 === p2`).

use std::sync::Arc;

use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::economy::EconomyComps;

/// §2.8-adjacent cadence: victory checks ride the 1 s planning rhythm.
pub const VICTORY_CHECK_CADENCE_TICKS: u64 = 30;
/// Command kind conceding the match for the submitting player.
pub const SURRENDER_COMMAND_KIND: &str = "surrender";

pub const VICTORY_PATH_CONQUEST: f64 = 0.0;
pub const VICTORY_PATH_KNOWLEDGE: f64 = 1.0;
pub const VICTORY_PATH_CULTURE: f64 = 2.0;
pub const VICTORY_PATH_WONDER: f64 = 3.0;
pub const VICTORY_PATH_RELIC: f64 = 4.0;
pub const VICTORY_PATH_ECONOMIC: f64 = 5.0;

pub const VICTORY_STATUS_ONGOING: f64 = 0.0;
pub const VICTORY_STATUS_WON: f64 = 1.0;
pub const VICTORY_STATUS_LOST: f64 = 2.0;
pub const VICTORY_STATUS_SURRENDERED: f64 = 3.0;
pub const VICTORY_STATUS_SUSTAINING: f64 = 4.0;

/// Ticks in one sim minute (30 Hz × 60 s) — the per-min rate scale.
const TICKS_PER_SIM_MINUTE: f64 = 1800.0;
/// Milli-units per whole unit — thresholds are declared per minute.
const MILLI_PER_UNIT: f64 = 1000.0;

/// Definition ids that count as military production capacity (§2.6).
const MILITARY_PRODUCTION_BUILDING_IDS: [&str; 3] = ["archery-range", "barracks", "stable"];

/// TS RELIC_STORED row state.
const RELIC_STORED: f64 = 2.0;

#[derive(Clone, Copy)]
pub struct VictoryComps {
    pub victory_check: usize,
    pub stockpile: usize,
    pub building: usize,
    pub relic: usize,
    pub company: usize,
    pub knowledge_points: usize,
    pub prestige_ledger: usize,
    pub branch_output_ledger: usize,
}

fn id_of(world: &CoreWorld, name: &str) -> usize {
    world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"))
}

impl VictoryComps {
    pub fn new(world: &CoreWorld, econ: &EconomyComps, building: usize, relic: usize) -> VictoryComps {
        VictoryComps {
            victory_check: id_of(world, "VictoryCheck"),
            stockpile: econ.stockpile,
            building,
            relic,
            company: id_of(world, "Company"),
            knowledge_points: id_of(world, "KnowledgePoints"),
            prestige_ledger: id_of(world, "PrestigeLedger"),
            branch_output_ledger: id_of(world, "BranchOutputLedger"),
        }
    }
}

/// One decoded digest-visible evaluation result for one player.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VictoryCheckEntry {
    pub tick: f64,
    pub path_code: f64,
    pub status: f64,
    pub metric: f64,
}

fn require_player_ledger_eid(world: &CoreWorld, comps: &VictoryComps, player_id: f64) -> Eid {
    assert!(
        player_id.fract() == 0.0 && player_id >= 0.0,
        "player id must be a non-negative integer, got {player_id}"
    );
    for (eid, row) in world.rows_by_component[comps.stockpile].iter() {
        if row[0] == player_id {
            return *eid;
        }
    }
    panic!("player {player_id} has no stockpile entity")
}

/// Optional ledger eid (read paths tolerate a player with no ledger
/// only where TS's `?.` chains do; the appends require it).
fn ledger_eid(world: &CoreWorld, comps: &VictoryComps, player_id: f64) -> Eid {
    require_player_ledger_eid(world, comps, player_id)
}

/// Append one evaluation entry to `player_id`'s log on their ledger entity.
pub fn append_victory_check(world: &mut CoreWorld, comps: &VictoryComps, player_id: f64, entry: VictoryCheckEntry) {
    let eid = require_player_ledger_eid(world, comps, player_id);
    let mut next = world.rows_by_component[comps.victory_check]
        .get(&eid)
        .cloned()
        .unwrap_or_else(|| vec![0.0]);
    next.push(entry.tick);
    next.push(entry.path_code);
    next.push(entry.status);
    next.push(entry.metric);
    next[0] += 1.0;
    world.set_values(comps.victory_check, eid, &next).unwrap();
}

/// Decoded copy of one player's evaluation log (fresh vec each call).
pub fn read_victory_checks(world: &CoreWorld, comps: &VictoryComps, player_id: f64) -> Vec<VictoryCheckEntry> {
    let eid = ledger_eid(world, comps, player_id);
    let Some(row) = world.rows_by_component[comps.victory_check].get(&eid) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    let count = row[0] as usize;
    for i in 0..count {
        entries.push(VictoryCheckEntry {
            tick: row[1 + i * 4],
            path_code: row[2 + i * 4],
            status: row[3 + i * 4],
            metric: row[4 + i * 4],
        });
    }
    entries
}

/// Latest evaluation entry for one player, or None before the first.
pub fn latest_victory_check(world: &CoreWorld, comps: &VictoryComps, player_id: f64) -> Option<VictoryCheckEntry> {
    read_victory_checks(world, comps, player_id).into_iter().last()
}

/// Distinct stockpile-ledger owners, ascending — everyone in the match.
pub fn victory_player_ids(world: &CoreWorld, comps: &VictoryComps) -> Vec<f64> {
    let mut owners: Vec<f64> = Vec::new();
    for row in world.rows_by_component[comps.stockpile].values() {
        if !owners.contains(&row[0]) {
            owners.push(row[0]);
        }
    }
    owners.sort_by(|a, b| a.partial_cmp(b).unwrap());
    owners
}

// ---- metrics -----------------------------------------------------------------

/// Live count of `player_id`'s finished military-production buildings.
pub fn military_production_building_count(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> f64 {
    let mut count = 0.0;
    for row in world.rows_by_component[comps.building].values() {
        if row[0] != player_id {
            continue;
        }
        if MILITARY_PRODUCTION_BUILDING_IDS.contains(&defs.building_id_of_code(row[1] as u32)) {
            count += 1.0;
        }
    }
    count
}

fn ledger_metric(world: &CoreWorld, comps: &VictoryComps, component: usize, player_id: f64) -> f64 {
    for eid in &world.entities {
        let owner = world.rows_by_component[comps.stockpile].get(eid);
        if owner.map(|r| r[0]) != Some(player_id) {
            continue;
        }
        return world.rows_by_component[component].get(eid).map(|r| r[0]).unwrap_or(0.0);
    }
    panic!("player {player_id} has no stockpile entity")
}

/// Building defs whose §2.11 role serves `path`, ascending by def id
/// (BTreeMap iteration order).
fn building_defs_for_victory_path<'a>(defs: &'a Defs, path: &str) -> Vec<&'a crate::defs::BuildingDef> {
    defs.buildings
        .values()
        .filter(|d| d.victory.as_ref().map(|v| v.path == path).unwrap_or(false))
        .collect()
}

/// The path's completing-act definition — the one carrying the gate.
fn completing_act_def_of<'a>(defs: &'a Defs, path: &str) -> Option<&'a crate::defs::BuildingDef> {
    building_defs_for_victory_path(defs, path).into_iter().find(|d| {
        d.victory.as_ref().map(|v| v.sustain_per_min.is_some() || v.hold_ticks.is_some()).unwrap_or(false)
    })
}

fn owns_finished_building(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64, def_ids: &[&str]) -> bool {
    for row in world.rows_by_component[comps.building].values() {
        if row[0] != player_id {
            continue;
        }
        if def_ids.contains(&defs.building_id_of_code(row[1] as u32)) {
            return true;
        }
    }
    false
}

/// This player's live count of finished Wonder buildings.
pub fn wonder_count_of(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> f64 {
    let def_ids: Vec<&str> = building_defs_for_victory_path(defs, "wonder").iter().map(|d| d.id.as_str()).collect();
    let mut count = 0.0;
    for row in world.rows_by_component[comps.building].values() {
        if row[0] != player_id {
            continue;
        }
        if def_ids.contains(&defs.building_id_of_code(row[1] as u32)) {
            count += 1.0;
        }
    }
    count
}

/// The finished Monastery defs — the relic path's storage targets.
fn monastery_def_ids(defs: &Defs) -> Vec<&str> {
    building_defs_for_victory_path(defs, "relic")
        .iter()
        .filter(|d| d.victory.as_ref().map(|v| v.hold_ticks.is_some()).unwrap_or(false))
        .map(|d| d.id.as_str())
        .collect()
}

/// All relic rows as (state, holderEid) — TS `relicsOf`.
fn relic_rows(world: &CoreWorld, comps: &VictoryComps) -> Vec<(f64, f64)> {
    world.rows_by_component[comps.relic].values().map(|r| (r[0], r[1])).collect()
}

/// Relics of THIS player stored inside their own finished monasteries.
pub fn relics_held_of(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> f64 {
    let monastery_ids = monastery_def_ids(defs);
    if monastery_ids.is_empty() {
        return 0.0;
    }
    let mut held = 0.0;
    for (state, holder) in relic_rows(world, comps) {
        if state != RELIC_STORED {
            continue;
        }
        if let Some(holder_row) = world.rows_by_component[comps.building].get(&(holder as Eid)) {
            if holder_row[0] == player_id && monastery_ids.contains(&defs.building_id_of_code(holder_row[1] as u32)) {
                held += 1.0;
            }
        }
    }
    held
}

/// The §2.11 Relic completing act: threshold min(3, total relics).
pub fn relic_act_complete_of(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> bool {
    let all = relic_rows(world, comps);
    if all.is_empty() {
        return false;
    }
    let threshold = (all.len() as f64).min(3.0);
    relics_held_of(world, comps, defs, player_id) >= threshold
}

/// The §2.11 Economic completing act: owning ≥1 Company row.
pub fn owns_company_of(world: &CoreWorld, comps: &VictoryComps, player_id: f64) -> bool {
    world.rows_by_component[comps.company].values().any(|r| r[0] == player_id)
}

// ---- conquest predicates -----------------------------------------------------

/// Whether P ever held finished military-production capacity: readable
/// from P's own VictoryCheck history or the current live count.
fn conquest_capacity_ever_seen(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> bool {
    if military_production_building_count(world, comps, defs, player_id) > 0.0 {
        return true;
    }
    read_victory_checks(world, comps, player_id).iter().any(|entry| {
        entry.path_code == VICTORY_PATH_CONQUEST && entry.status == VICTORY_STATUS_ONGOING && entry.metric > 0.0
    })
}

/// Conquest defeat predicate for ONE player (symmetric both directions).
pub fn conquest_defeated(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> bool {
    let tail = latest_victory_check(world, comps, player_id);
    if matches!(tail.map(|t| t.status), Some(VICTORY_STATUS_SURRENDERED) | Some(VICTORY_STATUS_LOST)) {
        return true;
    }
    conquest_capacity_ever_seen(world, comps, defs, player_id)
        && military_production_building_count(world, comps, defs, player_id) == 0.0
}

/// Conquest completing act for `player_id`: every enemy defeated
/// (diplomacy-less: every other player is an enemy).
pub fn conquest_act_complete(world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> bool {
    let opponents: Vec<f64> = victory_player_ids(world, comps).into_iter().filter(|p| *p != player_id).collect();
    !opponents.is_empty() && opponents.iter().all(|enemy| conquest_defeated(world, comps, defs, *enemy))
}

// ---- timed-path heartbeat math -------------------------------------------------

/// One player's non-decisive check history for one path.
fn heartbeat_history_of(world: &CoreWorld, comps: &VictoryComps, player_id: f64, path_code: f64) -> Vec<VictoryCheckEntry> {
    read_victory_checks(world, comps, player_id)
        .into_iter()
        .filter(|e| e.path_code == path_code && (e.status == VICTORY_STATUS_ONGOING || e.status == VICTORY_STATUS_SUSTAINING))
        .collect()
}

/// Per-minute milli-rate over ONE check interval (0 on zero span).
/// JS `Math.round` on non-negative values == `f64::round`.
pub fn interval_rate_milli_of(previous: (f64, f64), current: (f64, f64)) -> f64 {
    let span = current.0 - previous.0;
    if span <= 0.0 {
        return 0.0;
    }
    let delta = current.1 - previous.1;
    if delta <= 0.0 {
        return 0.0;
    }
    (delta * TICKS_PER_SIM_MINUTE / span).round()
}

/// Accumulated hold ticks for ONE timed path from the player's own log:
/// every interval whose LATER check is SUSTAINING counts its span.
pub fn sustained_hold_ticks_of(world: &CoreWorld, comps: &VictoryComps, path_code: f64, player_id: f64) -> f64 {
    let history = heartbeat_history_of(world, comps, player_id, path_code);
    let mut hold = 0.0;
    for i in 1..history.len() {
        if history[i].status == VICTORY_STATUS_SUSTAINING {
            hold += history[i].tick - history[i - 1].tick;
        }
    }
    hold
}

// ---- evaluators ------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum PathKind {
    Conquest,
    Knowledge,
    Culture,
    Wonder,
    Relic,
    Economic,
}

#[derive(Clone)]
struct Evaluator {
    kind: PathKind,
    path_code: f64,
    timer_ticks: Option<f64>,
    threshold_per_min: Option<f64>,
    /// Completing-act building def ids (knowledge/culture probes).
    act_def_ids: Vec<String>,
}

impl Evaluator {
    fn metric(&self, world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> f64 {
        match self.kind {
            PathKind::Conquest => military_production_building_count(world, comps, defs, player_id),
            PathKind::Knowledge => ledger_metric(world, comps, comps.knowledge_points, player_id),
            PathKind::Culture => ledger_metric(world, comps, comps.prestige_ledger, player_id),
            PathKind::Wonder => wonder_count_of(world, comps, defs, player_id),
            PathKind::Relic => relics_held_of(world, comps, defs, player_id),
            PathKind::Economic => ledger_metric(world, comps, comps.branch_output_ledger, player_id),
        }
    }

    fn act_complete(&self, world: &CoreWorld, comps: &VictoryComps, defs: &Defs, player_id: f64) -> bool {
        match self.kind {
            PathKind::Conquest => conquest_act_complete(world, comps, defs, player_id),
            PathKind::Knowledge | PathKind::Culture => {
                let ids: Vec<&str> = self.act_def_ids.iter().map(|s| s.as_str()).collect();
                owns_finished_building(world, comps, defs, player_id, &ids)
            }
            PathKind::Wonder => wonder_count_of(world, comps, defs, player_id) > 0.0,
            PathKind::Relic => relic_act_complete_of(world, comps, defs, player_id),
            PathKind::Economic => owns_company_of(world, comps, player_id),
        }
    }
}

fn timed_path_gate(defs: &Defs, path: &str) -> (f64, f64) {
    let act = completing_act_def_of(defs, path).and_then(|d| d.victory.as_ref());
    match act {
        Some(v) if v.sustain_per_min.map(|s| s > 0.0).unwrap_or(false) && v.hold_ticks.map(|h| h > 0).unwrap_or(false) => {
            (v.hold_ticks.unwrap() as f64, v.sustain_per_min.unwrap())
        }
        _ => panic!("victory path {path:?} has no completing-act sustain gate in its definition set"),
    }
}

fn hold_only_gate(defs: &Defs, path: &str) -> f64 {
    let act = completing_act_def_of(defs, path).and_then(|d| d.victory.as_ref());
    match act {
        Some(v) if v.hold_ticks.map(|h| h > 0).unwrap_or(false) => v.hold_ticks.unwrap() as f64,
        _ => panic!("victory path {path:?} has no completing-act hold timer in its definition set"),
    }
}

fn completing_act_def_ids(defs: &Defs, path: &str) -> Vec<String> {
    building_defs_for_victory_path(defs, path)
        .iter()
        .filter(|d| {
            d.victory.as_ref().map(|v| v.sustain_per_min.is_some() || v.hold_ticks.is_some()).unwrap_or(false)
        })
        .map(|d| d.id.clone())
        .collect()
}

/// DEFAULT_VICTORY_PATHS: conquest + the M4-T4/M4-T5 timed paths.
fn default_evaluators(defs: &Defs) -> Vec<Evaluator> {
    let (k_timer, k_threshold) = timed_path_gate(defs, "knowledge");
    let (c_timer, c_threshold) = timed_path_gate(defs, "culture");
    let econ = defs
        .victory_paths
        .get("economic-path")
        .unwrap_or_else(|| panic!("unknown victory path definition \"economic-path\""));
    vec![
        Evaluator { kind: PathKind::Conquest, path_code: VICTORY_PATH_CONQUEST, timer_ticks: None, threshold_per_min: None, act_def_ids: Vec::new() },
        Evaluator { kind: PathKind::Knowledge, path_code: VICTORY_PATH_KNOWLEDGE, timer_ticks: Some(k_timer), threshold_per_min: Some(k_threshold), act_def_ids: completing_act_def_ids(defs, "knowledge") },
        Evaluator { kind: PathKind::Culture, path_code: VICTORY_PATH_CULTURE, timer_ticks: Some(c_timer), threshold_per_min: Some(c_threshold), act_def_ids: completing_act_def_ids(defs, "culture") },
        Evaluator { kind: PathKind::Wonder, path_code: VICTORY_PATH_WONDER, timer_ticks: Some(hold_only_gate(defs, "wonder")), threshold_per_min: None, act_def_ids: Vec::new() },
        Evaluator { kind: PathKind::Relic, path_code: VICTORY_PATH_RELIC, timer_ticks: Some(hold_only_gate(defs, "relic")), threshold_per_min: None, act_def_ids: Vec::new() },
        Evaluator {
            kind: PathKind::Economic,
            path_code: VICTORY_PATH_ECONOMIC,
            timer_ticks: econ.hold_ticks.map(|h| h as f64),
            threshold_per_min: econ.sustain_per_min,
            act_def_ids: Vec::new(),
        },
    ]
}

// ---- outcome -----------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct VictoryOutcome {
    pub decided: bool,
    pub winners: Vec<f64>,
    pub losers: Vec<(f64, &'static str)>,
}

fn defeat_reason_of_path_code(path_code: f64) -> &'static str {
    if path_code == VICTORY_PATH_KNOWLEDGE {
        "knowledge"
    } else if path_code == VICTORY_PATH_CULTURE {
        "culture"
    } else if path_code == VICTORY_PATH_WONDER {
        "wonder"
    } else if path_code == VICTORY_PATH_RELIC {
        "relic"
    } else if path_code == VICTORY_PATH_ECONOMIC {
        "economic"
    } else {
        "conquest"
    }
}

/// The current outcome, derived purely from the players' VictoryCheck
/// logs. Diplomacy-less: active players are "all allied" only when one
/// remains (TS `isAllied` fallback is identity).
pub fn evaluate_outcome(world: &CoreWorld, comps: &VictoryComps) -> VictoryOutcome {
    let mut winners: Vec<f64> = Vec::new();
    let mut losers: Vec<(f64, &'static str)> = Vec::new();
    let players = victory_player_ids(world, comps);
    for player_id in &players {
        let tail = latest_victory_check(world, comps, *player_id);
        match tail.map(|t| t.status) {
            Some(VICTORY_STATUS_WON) => winners.push(*player_id),
            Some(VICTORY_STATUS_LOST) => {
                losers.push((*player_id, defeat_reason_of_path_code(tail.unwrap().path_code)));
            }
            Some(VICTORY_STATUS_SURRENDERED) => losers.push((*player_id, "surrender")),
            _ => {}
        }
    }
    if !winners.is_empty() {
        return VictoryOutcome { decided: true, winners, losers };
    }
    if !losers.is_empty() && players.len() <= 2 {
        return VictoryOutcome { decided: true, winners, losers };
    }
    let active: Vec<f64> = players.iter().filter(|p| !losers.iter().any(|(l, _)| l == *p)).copied().collect();
    if !active.is_empty() && !losers.is_empty() && active.len() == 1 {
        return VictoryOutcome { decided: true, winners: active, losers };
    }
    let decided = !(winners.is_empty() && losers.is_empty());
    VictoryOutcome { decided, winners, losers }
}

/// Units lost by ONE player: UNIT_DEATH entries in their CombatEvents
/// death ledger (structure razes carry the separate DEATH kind).
pub fn units_lost_of(world: &CoreWorld, ccomps: &crate::combat::CombatComps, econ: &EconomyComps, player_id: f64) -> usize {
    crate::combat::read_combat_events(world, ccomps, econ, player_id)
        .iter()
        .filter(|e| e.kind == crate::combat::COMBAT_EVENT_UNIT_DEATH)
        .count()
}

// ---- the system ----------------------------------------------------------------------

pub struct VictorySystem {
    defs: Arc<Defs>,
    paths: Vec<Evaluator>,
    /// Frozen once decided; derivable from the rows on restore.
    decided: bool,
}

impl VictorySystem {
    pub fn new(defs: Arc<Defs>) -> VictorySystem {
        let paths = default_evaluators(&defs);
        for path in &paths {
            match path.timer_ticks {
                None => assert!(path.threshold_per_min.is_none(), "victory path declares a threshold but no hold timer"),
                Some(timer) => {
                    assert!(timer > 0.0, "timed victory path needs a positive hold timer");
                    if let Some(threshold) = path.threshold_per_min {
                        assert!(threshold > 0.0, "gated victory path needs a positive sustain threshold");
                    }
                }
            }
        }
        VictorySystem { defs, paths, decided: false }
    }

    /// Whether the match decision has frozen further checks (E7 saves).
    pub fn is_decided(&self) -> bool {
        self.decided
    }

    /// Restore the frozen flag after a load. The WON/LOST rows are the
    /// ground truth; this only re-arms the same freeze they imply.
    pub fn set_decided(&mut self, decided: bool) {
        self.decided = decided;
    }

    pub fn run(&mut self, world: &mut CoreWorld, econ: &EconomyComps, building: usize, relic: usize, commands: &[Command]) {
        let comps = VictoryComps::new(world, econ, building, relic);
        // Surrender commands resolve first.
        for command in commands {
            if command.kind != SURRENDER_COMMAND_KIND {
                continue;
            }
            let data = command.data.as_ref().expect("surrender requires command data");
            self.apply_surrender(world, &comps, data);
        }
        if self.decided || world.tick % VICTORY_CHECK_CADENCE_TICKS != 0 {
            return;
        }
        self.run_checks(world, &comps);
    }

    fn apply_surrender(&mut self, world: &mut CoreWorld, comps: &VictoryComps, data: &serde_json::Value) {
        let raw = data
            .get("playerId")
            .and_then(|v| v.as_f64())
            .filter(|v| v.fract() == 0.0 && *v >= 0.0)
            .expect("surrender playerId must be a non-negative integer");
        if evaluate_outcome(world, comps).decided {
            return; // post-game no-op
        }
        let players = victory_player_ids(world, comps);
        assert!(players.contains(&raw), "surrender player {raw} has no ledger");
        let defs = self.defs.clone();
        let metric = military_production_building_count(world, comps, &defs, raw);
        append_victory_check(world, comps, raw, VictoryCheckEntry {
            tick: world.tick as f64,
            path_code: VICTORY_PATH_CONQUEST,
            status: VICTORY_STATUS_SURRENDERED,
            metric,
        });
        let active: Vec<f64> = players
            .iter()
            .filter(|p| {
                !matches!(
                    latest_victory_check(world, comps, **p).map(|t| t.status),
                    Some(VICTORY_STATUS_SURRENDERED) | Some(VICTORY_STATUS_LOST)
                )
            })
            .copied()
            .collect();
        // Diplomacy-less `allAllied` reduces to a single active player.
        let all_allied = active.len() == 1;
        if active.len() <= 1 || (players.len() > 2 && all_allied) || players.len() <= 2 {
            for other in active {
                let metric = military_production_building_count(world, comps, &defs, other);
                append_victory_check(world, comps, other, VictoryCheckEntry {
                    tick: world.tick as f64,
                    path_code: VICTORY_PATH_CONQUEST,
                    status: VICTORY_STATUS_WON,
                    metric,
                });
            }
            self.decided = true;
        }
    }

    fn run_checks(&mut self, world: &mut CoreWorld, comps: &VictoryComps) {
        let defs = self.defs.clone();
        let players = victory_player_ids(world, comps);
        for path in self.paths.clone() {
            let winners_now: Vec<f64> = players
                .iter()
                .filter(|player_id| {
                    if matches!(
                        latest_victory_check(world, comps, **player_id).map(|t| t.status),
                        Some(VICTORY_STATUS_LOST) | Some(VICTORY_STATUS_SURRENDERED)
                    ) {
                        return false;
                    }
                    if !path.act_complete(world, comps, &defs, **player_id) {
                        return false;
                    }
                    match path.timer_ticks {
                        None => true,
                        Some(timer) => sustained_hold_ticks_of(world, comps, path.path_code, **player_id) >= timer,
                    }
                })
                .copied()
                .collect();
            if winners_now.is_empty() {
                continue;
            }
            // Losers first, then winners ascending — pinned row order.
            for player_id in &players {
                if winners_now.contains(player_id) {
                    continue;
                }
                if matches!(
                    latest_victory_check(world, comps, *player_id).map(|t| t.status),
                    Some(VICTORY_STATUS_LOST) | Some(VICTORY_STATUS_SURRENDERED)
                ) {
                    continue;
                }
                let metric = path.metric(world, comps, &defs, *player_id);
                append_victory_check(world, comps, *player_id, VictoryCheckEntry {
                    tick: world.tick as f64,
                    path_code: path.path_code,
                    status: VICTORY_STATUS_LOST,
                    metric,
                });
            }
            for player_id in &winners_now {
                let metric = path.metric(world, comps, &defs, *player_id);
                append_victory_check(world, comps, *player_id, VictoryCheckEntry {
                    tick: world.tick as f64,
                    path_code: path.path_code,
                    status: VICTORY_STATUS_WON,
                    metric,
                });
            }
            self.decided = true;
            return; // decided — nothing else appends this tick
        }

        // Routine heartbeat: one entry per player and path, ascending.
        for player_id in &players {
            if matches!(
                latest_victory_check(world, comps, *player_id).map(|t| t.status),
                Some(VICTORY_STATUS_LOST) | Some(VICTORY_STATUS_SURRENDERED)
            ) {
                continue;
            }
            for path in self.paths.clone() {
                let metric = path.metric(world, comps, &defs, *player_id);
                let mut status = VICTORY_STATUS_ONGOING;
                let act_stands = path.act_complete(world, comps, &defs, *player_id);
                if act_stands {
                    if let Some(threshold) = path.threshold_per_min {
                        let history = heartbeat_history_of(world, comps, *player_id, path.path_code);
                        let rate = match history.last() {
                            None => 0.0,
                            Some(tail) => interval_rate_milli_of((tail.tick, tail.metric), (world.tick as f64, metric)),
                        };
                        if rate >= threshold * MILLI_PER_UNIT {
                            status = VICTORY_STATUS_SUSTAINING;
                        }
                    } else if path.timer_ticks.is_some() {
                        status = VICTORY_STATUS_SUSTAINING;
                    }
                }
                append_victory_check(world, comps, *player_id, VictoryCheckEntry {
                    tick: world.tick as f64,
                    path_code: path.path_code,
                    status,
                    metric,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{attack_step, setup_ai_opponent, strategy_by_id, AiPlannerSystem, Strategy, AI_PLAYER};
    use crate::buildings::{building_row, create_player_age_state, current_age_rank, AgeComps, BuildingComps};
    use crate::combat::{read_combat_events, spawn_combat_unit, CombatComps, SpawnCombatOptions, COMBAT_EVENT_DEATH};
    use crate::core::Command;
    use crate::economy::{
        create_commodity_stockpile, create_player_stockpile, deposit_commodity, spawn_resource_node, PLAYER_ONE,
    };
    use crate::fog::FogHandle;
    use crate::gather::EconomySim;
    use crate::mapgen::Layers;
    use crate::path::Transport;
    use crate::pop::{PopComps, TraitsData};
    use std::sync::OnceLock;

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

    fn open_field(sim: &mut EconomySim, size: usize) {
        sim.movement.layers = Layers {
            size,
            terrain: vec![crate::mapgen::TERRAIN_GRASS; size * size],
            elevation: vec![0; size * size],
            passability: vec![1; size * size],
        };
        sim.combat.group_routes = true;
    }

    fn vcomps(sim: &EconomySim) -> VictoryComps {
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        let relic = crate::combat::CombatAuxComps::from_world(&sim.movement.world).relic;
        VictoryComps::new(&sim.movement.world, &sim.econ, bcomps.building, relic)
    }

    fn prime_hp(sim: &mut EconomySim, eid: Eid, hp: f64) {
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        sim.movement.world.rows_by_component[bcomps.building].get_mut(&eid).expect("building row")[4] = hp;
    }

    struct RunA {
        sim: EconomySim,
        digests: Vec<(u64, String)>,
        decided_tick: i64,
        barracks_tick: i64,
        stable_tick: i64,
        final_tick: u64,
    }

    fn run_a() -> RunA {
        const SIZE: usize = 40;
        const LIMIT: u64 = 3600;
        let mut sim = EconomySim::new(20260903, SIZE, Transport::synchronous(), defs(), traits()).unwrap();
        open_field(&mut sim, SIZE);
        sim.victory = Some(VictorySystem::new(defs()));
        let econ = sim.econ;
        let age = AgeComps::from_world(&sim.movement.world);
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        // Player zero: ledgers, TC, villagers, knights (TS spawn order).
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, Some(&[2000.0, 2000.0, 2000.0, 2000.0, 0.0, 0.0, 0.0])).unwrap();
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE).unwrap();
        create_player_age_state(&mut sim.movement.world, &age, &econ, PLAYER_ONE);
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &defs(), layers, paths, "town-center", 4, 4, PLAYER_ONE);
        }
        sim.spawn_unit(8.5, 12.5);
        sim.spawn_unit(8.5, 13.5);
        let mut knights = Vec::new();
        for (x, y) in [(8.5, 8.5), (8.5, 9.5), (9.5, 8.5), (9.5, 9.5)] {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            knights.push(spawn_combat_unit(
                world, comps, &ccomps, &pop, &traits(), &defs(), "knight", x, y, PLAYER_ONE,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            ));
        }
        deposit_commodity(&mut sim.movement.world, &econ, PLAYER_ONE, 3, 12.0).unwrap();
        for knight in &knights {
            sim.submit(Command {
                kind: "equip".to_string(),
                target_tick: 1,
                data: Some(serde_json::json!({"unitIds": [knight], "item": "weapon", "playerId": PLAYER_ONE})),
            }).unwrap();
        }
        // AI opponent with both producers pre-stamped + primed.
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let pop = PopComps::from_world(world);
            let morale = CombatComps::from_world(world).morale;
            setup_ai_opponent(
                world, comps, &econ, &bcomps, &age, &pop, morale, &traits(), &defs(), layers, paths,
                AI_PLAYER, (33, 33),
                &[(30.5, 36.5), (31.5, 36.5), (32.5, 36.5), (30.5, 37.5), (31.5, 37.5)],
                Some(&[5000.0, 5000.0, 2000.0, 2000.0, 0.0, 0.0, 0.0]),
            );
        }
        let (ai_barracks, ai_stable) = {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let d = defs();
            (
                crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &d, layers, paths, "barracks", 26, 26, AI_PLAYER),
                crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &d, layers, paths, "stable", 22, 22, AI_PLAYER),
            )
        };
        prime_hp(&mut sim, ai_barracks, 15.0);
        prime_hp(&mut sim, ai_stable, 15.0);
        for (x, y, slug) in [(29, 32, "food"), (30, 31, "food"), (29, 35, "wood"), (36, 29, "wood"), (36, 36, "gold"), (28, 29, "food")] {
            let code = crate::economy::resource_code_of_slug(slug).unwrap();
            spawn_resource_node(&mut sim.movement.world, &econ, x, y, code, 800, None).unwrap();
        }
        sim.ai = Some(AiPlannerSystem::new(strategy_by_id("fast-castle-knights"), FogHandle::new(SIZE, 2)));
        {
            let fcomps = crate::fog::FogComps::new(&sim.movement.comps, &bcomps, &CombatComps::from_world(&sim.movement.world));
            let pop = PopComps::from_world(&sim.movement.world);
            sim.ai.as_mut().unwrap().fog.recompute_all(&sim.movement.world, &fcomps, &pop, &defs());
        }
        // The raid script.
        #[derive(PartialEq)]
        enum Phase { Hold, Barracks, Stable, Razed }
        let mut phase = Phase::Hold;
        let (mut barracks_tick, mut stable_tick, mut decided_tick) = (-1i64, -1i64, -1i64);
        let mut digests = Vec::new();
        let vc = vcomps(&sim);
        while sim.movement.world.tick < LIMIT {
            let before = sim.movement.world.tick;
            sim.step();
            if sim.movement.world.tick == before {
                continue;
            }
            let tick = sim.movement.world.tick;
            if phase == Phase::Hold && tick >= VICTORY_CHECK_CADENCE_TICKS * 2 {
                phase = Phase::Barracks;
                sim.submit(Command {
                    kind: "attack".to_string(),
                    target_tick: tick + 1,
                    data: Some(serde_json::json!({"attackerIds": knights, "targetId": ai_barracks})),
                }).unwrap();
            }
            if phase == Phase::Barracks && building_row(&sim.movement.world, &bcomps, ai_barracks).is_none() {
                barracks_tick = tick as i64;
                phase = Phase::Stable;
                sim.submit(Command {
                    kind: "attack".to_string(),
                    target_tick: tick + 1,
                    data: Some(serde_json::json!({"attackerIds": knights, "targetId": ai_stable})),
                }).unwrap();
            }
            if phase == Phase::Stable && building_row(&sim.movement.world, &bcomps, ai_stable).is_none() {
                stable_tick = tick as i64;
                phase = Phase::Razed;
            }
            if decided_tick < 0 && evaluate_outcome(&sim.movement.world, &vc).decided {
                decided_tick = tick as i64;
            }
            if tick % 30 == 0 || tick == LIMIT {
                digests.push((tick, sim.digest()));
            }
            if decided_tick >= 0 && tick >= decided_tick as u64 + 60 {
                break;
            }
        }
        RunA { final_tick: sim.movement.world.tick, sim, digests, decided_tick, barracks_tick, stable_tick }
    }

    #[test]
    fn m2t10a_player_conquest_matches_ts() {
        let run = run_a();
        assert_eq!(run.digests, snapshot_digests("m2t10a"));
        assert!(run.decided_tick > 0);
        assert!(run.barracks_tick > 0);
        assert!(run.stable_tick > run.barracks_tick);
        assert!(run.decided_tick >= run.stable_tick);
        assert_eq!(run.decided_tick as u64 % VICTORY_CHECK_CADENCE_TICKS, 0);
        let world = &run.sim.movement.world;
        let vc = vcomps(&run.sim);
        let outcome = evaluate_outcome(world, &vc);
        assert!(outcome.decided);
        assert_eq!(outcome.winners, vec![PLAYER_ONE]);
        assert_eq!(outcome.losers, vec![(AI_PLAYER, "conquest")]);
        // Capacity ledger.
        let ai_entries = read_victory_checks(world, &vc, AI_PLAYER);
        let p0_entries = read_victory_checks(world, &vc, PLAYER_ONE);
        let ai_ongoing: Vec<f64> = ai_entries.iter()
            .filter(|e| e.status == VICTORY_STATUS_ONGOING && e.path_code == VICTORY_PATH_CONQUEST)
            .map(|e| e.metric)
            .collect();
        assert_eq!(ai_ongoing[0], 2.0);
        assert_eq!(ai_ongoing.iter().cloned().fold(f64::NEG_INFINITY, f64::max), 2.0);
        let ai_tail = ai_entries.last().unwrap();
        assert_eq!((ai_tail.tick, ai_tail.status, ai_tail.metric), (run.decided_tick as f64, VICTORY_STATUS_LOST, 0.0));
        let p0_tail = p0_entries.last().unwrap();
        assert_eq!((p0_tail.tick, p0_tail.status, p0_tail.metric), (run.decided_tick as f64, VICTORY_STATUS_WON, 0.0));
        assert_eq!(ai_entries.len(), p0_entries.len());
        let age = AgeComps::from_world(world);
        assert_eq!(current_age_rank(world, &age, AI_PLAYER), 1.0);
        assert_eq!(current_age_rank(world, &age, PLAYER_ONE), 1.0);
        // Recap: structures died, no units; one evaluator, flipped verdicts.
        let ccomps = CombatComps::from_world(world);
        assert_eq!(read_combat_events(world, &ccomps, &run.sim.econ, AI_PLAYER).iter().filter(|e| e.kind == COMBAT_EVENT_DEATH).count(), 2);
        assert_eq!(units_lost_of(world, &ccomps, &run.sim.econ, AI_PLAYER), 0);
        assert_eq!(units_lost_of(world, &ccomps, &run.sim.econ, PLAYER_ONE), 0);
        assert!(conquest_act_complete(world, &vc, &defs(), PLAYER_ONE));
        assert!(!conquest_act_complete(world, &vc, &defs(), AI_PLAYER));
        // Freeze + attack never armed.
        assert_eq!(run.sim.ai.as_ref().unwrap().telemetry.attack_drafts.len(), 0);
        assert!(run.final_tick >= run.decided_tick as u64 + 60);
        // Double-run canary.
        let second = run_a();
        assert_eq!(second.digests, run.digests);
        assert_eq!(second.decided_tick, run.decided_tick);
    }

    struct RunB {
        sim: EconomySim,
        digests: Vec<(u64, String)>,
        decided_tick: i64,
        barracks_tick: i64,
        barracks: Eid,
    }

    fn run_b() -> RunB {
        const SIZE: usize = 24;
        const LIMIT: u64 = 1200;
        let mut sim = EconomySim::new(20260904, SIZE, Transport::synchronous(), defs(), traits()).unwrap();
        open_field(&mut sim, SIZE);
        sim.victory = Some(VictorySystem::new(defs()));
        let econ = sim.econ;
        let age = AgeComps::from_world(&sim.movement.world);
        let bcomps = BuildingComps::from_world(&sim.movement.world);
        // Player zero: ledgers + ONE primed barracks near the AI base.
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, Some(&[200.0, 600.0, 100.0, 0.0, 0.0, 0.0, 0.0])).unwrap();
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE).unwrap();
        create_player_age_state(&mut sim.movement.world, &age, &econ, PLAYER_ONE);
        let barracks = {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            crate::placement::stamp_finished_building(world, comps, &bcomps, &econ, &age, &defs(), layers, paths, "barracks", 10, 6, PLAYER_ONE)
        };
        prime_hp(&mut sim, barracks, 8.0);
        // AI: base, two stamped knights, raid planner.
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let pop = PopComps::from_world(world);
            let morale = CombatComps::from_world(world).morale;
            setup_ai_opponent(world, comps, &econ, &bcomps, &age, &pop, morale, &traits(), &defs(), layers, paths, AI_PLAYER, (3, 3), &[], None);
        }
        for (x, y) in [(7.5, 6.5), (7.5, 7.5)] {
            let crate::movement::MovementSim { world, comps, .. } = &mut sim.movement;
            let ccomps = CombatComps::from_world(world);
            let pop = PopComps::from_world(world);
            spawn_combat_unit(
                world, comps, &ccomps, &pop, &traits(), &defs(), "knight", x, y, AI_PLAYER,
                &SpawnCombatOptions { body: false, identity: false, morale: false },
            );
        }
        let strategy = Strategy {
            id: "raid-player-barracks",
            villager_target: 0,
            gather_weights: (1.0, 0.0, 0.0),
            attack_army_threshold: 2,
            steps: vec![attack_step("knight", &[])],
        };
        sim.ai = Some(AiPlannerSystem::new(strategy, FogHandle::new(SIZE, 2)));
        {
            let fcomps = crate::fog::FogComps::new(&sim.movement.comps, &bcomps, &CombatComps::from_world(&sim.movement.world));
            let pop = PopComps::from_world(&sim.movement.world);
            sim.ai.as_mut().unwrap().fog.recompute_all(&sim.movement.world, &fcomps, &pop, &defs());
        }
        let (mut barracks_tick, mut decided_tick) = (-1i64, -1i64);
        let mut digests = Vec::new();
        let vc = vcomps(&sim);
        while sim.movement.world.tick < LIMIT {
            let before = sim.movement.world.tick;
            sim.step();
            if sim.movement.world.tick == before {
                continue;
            }
            let tick = sim.movement.world.tick;
            if barracks_tick < 0 && building_row(&sim.movement.world, &bcomps, barracks).is_none() {
                barracks_tick = tick as i64;
            }
            if decided_tick < 0 && evaluate_outcome(&sim.movement.world, &vc).decided {
                decided_tick = tick as i64;
            }
            if tick % 30 == 0 || tick == LIMIT {
                digests.push((tick, sim.digest()));
            }
            if decided_tick >= 0 && tick >= decided_tick as u64 + 60 {
                break;
            }
        }
        RunB { sim, digests, decided_tick, barracks_tick, barracks }
    }

    #[test]
    fn m2t10b_ai_conquest_matches_ts() {
        let run = run_b();
        assert_eq!(run.digests, snapshot_digests("m2t10b"));
        assert!(run.barracks_tick > 0);
        assert!(run.decided_tick >= run.barracks_tick);
        assert_eq!(run.decided_tick as u64 % VICTORY_CHECK_CADENCE_TICKS, 0);
        let world = &run.sim.movement.world;
        let vc = vcomps(&run.sim);
        let outcome = evaluate_outcome(world, &vc);
        assert!(outcome.decided);
        assert_eq!(outcome.winners, vec![AI_PLAYER]);
        assert_eq!(outcome.losers, vec![(PLAYER_ONE, "conquest")]);
        let p0_entries = read_victory_checks(world, &vc, PLAYER_ONE);
        let ai_entries = read_victory_checks(world, &vc, AI_PLAYER);
        assert_eq!(
            p0_entries.iter().find(|e| e.status == VICTORY_STATUS_ONGOING && e.path_code == VICTORY_PATH_CONQUEST).map(|e| e.metric),
            Some(1.0)
        );
        assert_eq!(p0_entries.last().unwrap().status, VICTORY_STATUS_LOST);
        assert_eq!(ai_entries.last().unwrap().status, VICTORY_STATUS_WON);
        assert_eq!(ai_entries.last().unwrap().tick, p0_entries.last().unwrap().tick);
        assert_eq!(ai_entries.len(), p0_entries.len());
        assert!(!conquest_act_complete(world, &vc, &defs(), PLAYER_ONE));
        assert!(conquest_act_complete(world, &vc, &defs(), AI_PLAYER));
        let drafts = &run.sim.ai.as_ref().unwrap().telemetry.attack_drafts;
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].1, run.barracks as i64);
        assert!(drafts[0].3, "target visible to AI at draft time");
        let ccomps = CombatComps::from_world(world);
        assert_eq!(units_lost_of(world, &ccomps, &run.sim.econ, AI_PLAYER), 0);
        assert_eq!(units_lost_of(world, &ccomps, &run.sim.econ, PLAYER_ONE), 0);
        let second = run_b();
        assert_eq!(second.digests, run.digests);
        assert_eq!(second.decided_tick, run.decided_tick);
    }
}

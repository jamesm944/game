//! E7 persistence (#204): AOF2 save container + replay files per
//! `docs/research/save-and-replay-compatibility-boundary.md` (#165),
//! which is the normative format document (settles C3's format
//! authority; ADR-0008 §5 deferred to it in practice).
//!
//! Container: 48-byte uncompressed header (all integers little-endian)
//! followed by a gzip payload. The payload is a JSON `EconomySave`
//! (the header treats payload as opaque bytes; FlatBuffers encoding
//! can replace JSON later without a format-version change of the
//! header contract, only of `payload_version`).
//!
//! Saves are valid at tick boundaries (between `EconomySim::step`
//! calls). Restore is verified against the header StateDigest before
//! the sim is handed back, so a corrupt or mismatched save can never
//! produce a silently wrong world.

use std::io::{Read, Write};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::{
    AiDifficulty, AiPlannerSystem, BuildOrderMemory, BuildStep, Completion, MilitaryMemory,
    PlannerTelemetry, StepAction, StepGate, Strategy,
};
use crate::core::{format_digest, fnv1a64, Eid, Inbox, Rows, Sfc32};
use crate::defs::Defs;
use crate::fog::FogHandle;
use crate::game_server::GameServer;
use crate::gather::{EconomySim, GatherSaveState};
use crate::mapgen::Layers;
use crate::movement::Continuation;
use crate::path::{PathScheduler, SchedulerSnapshot, Transport};
use crate::pop::TraitsData;
use crate::victory::VictorySystem;

pub const AOF2_FORMAT_VERSION: u32 = 2;
pub const ENGINE_ID_RUST: u32 = 0x5255_5354; // "RUST"
pub const ENGINE_ID_TS: u32 = 0x5453_494d; // "TSIM"
const HEADER_LEN: usize = 48;
const PAYLOAD_VERSION: u32 = 1;

// ---- strategy DTO (the live types borrow &'static str) ----------------------

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}
fn leak_slice<T>(v: Vec<T>) -> &'static [T] {
    Box::leak(v.into_boxed_slice())
}

#[derive(Serialize, Deserialize)]
enum ActionState {
    PlaceBuilding { def_id: String, min_clearance: i64, max_radius: i64 },
    ResearchAge,
    TrainArmy { unit_id: String },
    Attack,
    ResearchTech { tech_id: String, building_def_id: Option<String> },
}

#[derive(Serialize, Deserialize)]
enum CompletionState {
    BuildingUp { def_id: String, count: usize },
    AgeReached { rank: i64 },
    /// Count travels as raw bits: the attack step's threshold is
    /// `f64::INFINITY`, which JSON cannot represent.
    ArmySize { unit_id: String, count_bits: u64 },
    TechResearched { tech_id: String },
}

#[derive(Serialize, Deserialize)]
struct GateState {
    min_resources: Vec<(String, i64)>,
    buildings_up: Vec<(String, usize)>,
    min_age_rank: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct StepState {
    id: String,
    requires: Vec<String>,
    action: ActionState,
    complete: CompletionState,
    gate: GateState,
}

#[derive(Serialize, Deserialize)]
struct StrategyState {
    id: String,
    villager_target: usize,
    gather_weights: (f64, f64, f64),
    attack_army_threshold: usize,
    steps: Vec<StepState>,
}

fn strategy_to_state(strategy: &Strategy) -> StrategyState {
    StrategyState {
        id: strategy.id.to_string(),
        villager_target: strategy.villager_target,
        gather_weights: strategy.gather_weights,
        attack_army_threshold: strategy.attack_army_threshold,
        steps: strategy
            .steps
            .iter()
            .map(|step| StepState {
                id: step.id.to_string(),
                requires: step.requires.iter().map(|s| s.to_string()).collect(),
                action: match &step.action {
                    StepAction::PlaceBuilding { def_id, min_clearance, max_radius } => {
                        ActionState::PlaceBuilding {
                            def_id: def_id.to_string(),
                            min_clearance: *min_clearance,
                            max_radius: *max_radius,
                        }
                    }
                    StepAction::ResearchAge => ActionState::ResearchAge,
                    StepAction::TrainArmy { unit_id } => {
                        ActionState::TrainArmy { unit_id: unit_id.to_string() }
                    }
                    StepAction::Attack => ActionState::Attack,
                    StepAction::ResearchTech { tech_id, building_def_id } => {
                        ActionState::ResearchTech {
                            tech_id: tech_id.to_string(),
                            building_def_id: building_def_id.map(|s| s.to_string()),
                        }
                    }
                },
                complete: match &step.complete {
                    Completion::BuildingUp { def_id, count } => {
                        CompletionState::BuildingUp { def_id: def_id.to_string(), count: *count }
                    }
                    Completion::AgeReached { rank } => CompletionState::AgeReached { rank: *rank },
                    Completion::ArmySize { unit_id, count } => CompletionState::ArmySize {
                        unit_id: unit_id.to_string(),
                        count_bits: count.to_bits(),
                    },
                    Completion::TechResearched { tech_id } => {
                        CompletionState::TechResearched { tech_id: tech_id.to_string() }
                    }
                },
                gate: GateState {
                    min_resources: step.gate.min_resources.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
                    buildings_up: step.gate.buildings_up.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
                    min_age_rank: step.gate.min_age_rank,
                },
            })
            .collect(),
    }
}

fn strategy_from_state(state: StrategyState) -> Strategy {
    Strategy {
        id: leak_str(state.id),
        villager_target: state.villager_target,
        gather_weights: state.gather_weights,
        attack_army_threshold: state.attack_army_threshold,
        steps: state
            .steps
            .into_iter()
            .map(|step| BuildStep {
                id: leak_str(step.id),
                requires: leak_slice(step.requires.into_iter().map(leak_str).collect()),
                action: match step.action {
                    ActionState::PlaceBuilding { def_id, min_clearance, max_radius } => {
                        StepAction::PlaceBuilding { def_id: leak_str(def_id), min_clearance, max_radius }
                    }
                    ActionState::ResearchAge => StepAction::ResearchAge,
                    ActionState::TrainArmy { unit_id } => StepAction::TrainArmy { unit_id: leak_str(unit_id) },
                    ActionState::Attack => StepAction::Attack,
                    ActionState::ResearchTech { tech_id, building_def_id } => StepAction::ResearchTech {
                        tech_id: leak_str(tech_id),
                        building_def_id: building_def_id.map(leak_str),
                    },
                },
                complete: match step.complete {
                    CompletionState::BuildingUp { def_id, count } => {
                        Completion::BuildingUp { def_id: leak_str(def_id), count }
                    }
                    CompletionState::AgeReached { rank } => Completion::AgeReached { rank },
                    CompletionState::ArmySize { unit_id, count_bits } => {
                        Completion::ArmySize { unit_id: leak_str(unit_id), count: f64::from_bits(count_bits) }
                    }
                    CompletionState::TechResearched { tech_id } => {
                        Completion::TechResearched { tech_id: leak_str(tech_id) }
                    }
                },
                gate: StepGate {
                    min_resources: step.gate.min_resources.into_iter().map(|(k, v)| (leak_str(k), v)).collect(),
                    buildings_up: leak_slice(
                        step.gate.buildings_up.into_iter().map(|(k, v)| (leak_str(k), v)).collect(),
                    ),
                    min_age_rank: step.gate.min_age_rank,
                },
            })
            .collect(),
    }
}

#[derive(Serialize, Deserialize)]
struct AiState {
    knowledge_player: f64,
    fog: FogHandle,
    strategy: StrategyState,
    difficulty: AiDifficulty,
    reaction_latency: Option<u64>,
    phase_offset: u64,
    memory: BuildOrderMemory,
    military_memory: MilitaryMemory,
    telemetry: PlannerTelemetry,
}

// ---- payload ------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct LayersState {
    size: usize,
    terrain: Vec<u8>,
    elevation: Vec<u8>,
    passability: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct EconomySave {
    payload_version: u32,
    seed: u32,
    size: usize,
    tick: u64,
    component_names: Vec<String>,
    entities: Vec<Eid>,
    last_allocated_eid: Eid,
    /// Rows travel as raw f64 bit patterns: JSON numbers cannot carry
    /// NaN/Infinity, and the digest contract hashes exact bits.
    rows_by_component: Vec<Vec<(Eid, Vec<u64>)>>,
    prng: Sfc32,
    inbox: Inbox,
    used_name_indexes: Vec<i64>,
    rally_points: Vec<(Eid, f64, f64, Option<Eid>)>,
    fog_removed: Vec<Eid>,
    fog_spawned: Vec<Eid>,
    layers: LayersState,
    scheduler: SchedulerSnapshot<Continuation>,
    gather: GatherSaveState,
    combat_group_routes: bool,
    fog: Option<FogHandle>,
    ai: Option<AiState>,
    victory_decided: Option<bool>,
    /// ADR-0010 §2 narrative state slot, reserved ahead of E14 so
    /// retrofitting it later cannot break existing saves.
    narrative_blob: Option<serde_json::Value>,
}

/// FNV-1a-64 over passability then elevation planes (#165 MapHash).
pub fn map_hash_of(layers: &Layers) -> u64 {
    let mut bytes = Vec::with_capacity(layers.passability.len() + layers.elevation.len());
    bytes.extend_from_slice(&layers.passability);
    bytes.extend_from_slice(&layers.elevation);
    fnv1a64(&bytes)
}

fn digest_value(sim: &EconomySim) -> Result<u64, String> {
    let text = sim.digest();
    let hex = text
        .strip_prefix("fnv1a64:")
        .ok_or_else(|| format!("unexpected digest shape: {text}"))?;
    u64::from_str_radix(hex, 16).map_err(|e| format!("digest hex parse: {e}"))
}

fn capture(sim: &EconomySim) -> Result<EconomySave, String> {
    if !sim.movement.paths.is_synchronous() {
        return Err(
            "save requires the synchronous path transport; async worker state is not serializable yet"
                .to_string(),
        );
    }
    let world = &sim.movement.world;
    Ok(EconomySave {
        payload_version: PAYLOAD_VERSION,
        seed: world.seed,
        size: sim.movement.layers.size,
        tick: world.tick,
        component_names: world.registry.names().to_vec(),
        entities: world.entities.clone(),
        last_allocated_eid: world.last_allocated_eid,
        rows_by_component: world
            .rows_by_component
            .iter()
            .map(|rows| {
                rows.iter()
                    .map(|(eid, row)| (*eid, row.iter().map(|v| v.to_bits()).collect()))
                    .collect()
            })
            .collect(),
        prng: world.prng.clone(),
        inbox: world.inbox.clone(),
        used_name_indexes: world.used_name_indexes.iter().copied().collect(),
        rally_points: world
            .rally_points
            .iter()
            .map(|(eid, (x, y, target))| (*eid, *x, *y, *target))
            .collect(),
        fog_removed: world.fog_removed.clone(),
        fog_spawned: world.fog_spawned.clone(),
        layers: LayersState {
            size: sim.movement.layers.size,
            terrain: sim.movement.layers.terrain.clone(),
            elevation: sim.movement.layers.elevation.clone(),
            passability: sim.movement.layers.passability.clone(),
        },
        scheduler: sim.movement.paths.snapshot(),
        gather: sim.gather.save_state(),
        combat_group_routes: sim.combat.group_routes,
        fog: sim.fog.clone(),
        ai: sim.ai.as_ref().map(|ai| AiState {
            knowledge_player: ai.knowledge_player,
            fog: ai.fog.clone(),
            strategy: strategy_to_state(&ai.strategy),
            difficulty: ai.difficulty,
            reaction_latency: ai.reaction_latency,
            phase_offset: ai.phase_offset,
            memory: ai.memory,
            military_memory: ai.military_memory.clone(),
            telemetry: ai.telemetry.clone(),
        }),
        victory_decided: sim.victory.as_ref().map(|v| v.is_decided()),
        narrative_blob: None,
    })
}

fn restore(save: EconomySave, defs: Arc<Defs>, traits: Arc<TraitsData>) -> Result<EconomySim, String> {
    if save.payload_version != PAYLOAD_VERSION {
        return Err(format!("unsupported save payload version {}", save.payload_version));
    }
    let mut sim = EconomySim::new(save.seed, save.size, Transport::synchronous(), defs.clone(), traits)?;
    let world = &mut sim.movement.world;
    if world.registry.names() != save.component_names.as_slice() {
        return Err("save component layout does not match this build".to_string());
    }
    if save.rows_by_component.len() != world.rows_by_component.len() {
        return Err("save row plane count does not match this build".to_string());
    }
    world.tick = save.tick;
    world.entities = save.entities;
    world.last_allocated_eid = save.last_allocated_eid;
    world.rows_by_component = save
        .rows_by_component
        .into_iter()
        .map(|rows| {
            rows.into_iter()
                .map(|(eid, bits)| (eid, bits.into_iter().map(f64::from_bits).collect::<Vec<f64>>()))
                .collect::<Rows>()
        })
        .collect();
    world.prng = save.prng;
    world.inbox = save.inbox;
    world.used_name_indexes = save.used_name_indexes.into_iter().collect();
    world.rally_points = save.rally_points.into_iter().map(|(eid, x, y, t)| (eid, (x, y, t))).collect();
    world.fog_removed = save.fog_removed;
    world.fog_spawned = save.fog_spawned;
    sim.movement.layers = Layers {
        size: save.layers.size,
        terrain: save.layers.terrain,
        elevation: save.layers.elevation,
        passability: save.layers.passability,
    };
    sim.movement.paths = PathScheduler::restore(save.scheduler, Transport::synchronous());
    sim.gather.restore_state(save.gather);
    sim.combat.group_routes = save.combat_group_routes;
    sim.fog = save.fog;
    sim.ai = save.ai.map(|ai| AiPlannerSystem {
        knowledge_player: ai.knowledge_player,
        fog: ai.fog,
        strategy: strategy_from_state(ai.strategy),
        difficulty: ai.difficulty,
        reaction_latency: ai.reaction_latency,
        phase_offset: ai.phase_offset,
        memory: ai.memory,
        military_memory: ai.military_memory,
        telemetry: ai.telemetry,
    });
    sim.victory = save.victory_decided.map(|decided| {
        let mut victory = VictorySystem::new(defs);
        victory.set_decided(decided);
        victory
    });
    Ok(sim)
}

// ---- AOF2 container -------------------------------------------------------------

fn engine_name(id: u32) -> String {
    match id {
        ENGINE_ID_RUST => "RUST".to_string(),
        ENGINE_ID_TS => "TSIM".to_string(),
        other => format!("0x{other:08x}"),
    }
}

impl EconomySim {
    /// Serialize this sim (at a tick boundary) into an AOF2 container.
    pub fn save_aof2(&self, playtime_seconds: f64) -> Result<Vec<u8>, String> {
        let payload = capture(self)?;
        let json = serde_json::to_vec(&payload).map_err(|e| format!("save payload encode: {e}"))?;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&json).map_err(|e| format!("save gzip: {e}"))?;
        let compressed = encoder.finish().map_err(|e| format!("save gzip: {e}"))?;

        let world = &self.movement.world;
        let tick = u32::try_from(world.tick).map_err(|_| "tick exceeds AOF2 u32 header field".to_string())?;
        let mut out = Vec::with_capacity(HEADER_LEN + compressed.len());
        out.extend_from_slice(b"AOF2");
        out.extend_from_slice(&AOF2_FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&ENGINE_ID_RUST.to_le_bytes());
        out.extend_from_slice(&world.seed.to_le_bytes());
        out.extend_from_slice(&tick.to_le_bytes());
        out.extend_from_slice(&playtime_seconds.to_le_bytes());
        out.extend_from_slice(&map_hash_of(&self.movement.layers).to_le_bytes());
        out.extend_from_slice(&digest_value(self)?.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&compressed);
        Ok(out)
    }

    /// Load an AOF2 container written by [`EconomySim::save_aof2`].
    /// The restored digest and map hash are verified against the
    /// header before the sim is returned.
    pub fn load_aof2(bytes: &[u8], defs: Arc<Defs>, traits: Arc<TraitsData>) -> Result<EconomySim, String> {
        if bytes.len() < 4 {
            return Err("save file too short for a magic header".to_string());
        }
        if &bytes[0..4] == b"AOF1" {
            return Err(
                "Save file was created by legacy engine v1. Format version 1 is unsupported in the deep-sim runtime."
                    .to_string(),
            );
        }
        if &bytes[0..4] != b"AOF2" {
            return Err("Unsupported v1 save format: v2 engine requires fresh save".to_string());
        }
        if bytes.len() < HEADER_LEN {
            return Err("save file too short for the AOF2 header".to_string());
        }
        let u32_at = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let u64_at = |offset: usize| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        let version = u32_at(4);
        if version != AOF2_FORMAT_VERSION {
            return Err(format!("unsupported save format version {version}"));
        }
        let engine = u32_at(8);
        if engine != ENGINE_ID_RUST {
            return Err(format!(
                "Save file was created by engine '{}', but current build is 'RUST'.",
                engine_name(engine)
            ));
        }
        let expected_map_hash = u64_at(28);
        let expected_digest = u64_at(36);
        let payload_len = u32_at(44) as usize;
        if bytes.len() < HEADER_LEN + payload_len {
            return Err("save payload truncated".to_string());
        }
        let mut decoder = flate2::read::GzDecoder::new(&bytes[HEADER_LEN..HEADER_LEN + payload_len]);
        let mut json = Vec::new();
        decoder.read_to_end(&mut json).map_err(|e| format!("save payload gunzip: {e}"))?;
        let save: EconomySave =
            serde_json::from_slice(&json).map_err(|e| format!("save payload decode: {e}"))?;
        let sim = restore(save, defs, traits)?;
        if map_hash_of(&sim.movement.layers) != expected_map_hash {
            return Err("save map hash mismatch after restore".to_string());
        }
        let actual = digest_value(&sim)?;
        if actual != expected_digest {
            return Err(format!(
                "save state digest mismatch after restore: header {}, restored {}",
                format_digest(expected_digest),
                format_digest(actual)
            ));
        }
        Ok(sim)
    }
}

// ---- replays --------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCommand {
    pub submit_tick: u64,
    pub line: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMilestone {
    pub tick: u64,
    pub digest: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFile {
    pub format_version: u32,
    pub engine: String,
    pub seed: u32,
    pub size: usize,
    pub map_hash: String,
    pub commands: Vec<ReplayCommand>,
    pub milestones: Vec<ReplayMilestone>,
}

/// Records one served match as a replay: every command goes in
/// through `submit` (so the record is complete by construction) and
/// milestone digests land every `milestone_every` ticks.
pub struct ReplaySession {
    server: GameServer,
    milestone_every: u64,
    /// Captured at creation: buildings mutate the passability plane
    /// as the match runs, so the identity hash must be the start map.
    start_map_hash: String,
    commands: Vec<ReplayCommand>,
    milestones: Vec<ReplayMilestone>,
}

impl ReplaySession {
    pub fn new(seed: u32, size: usize, milestone_every: u64) -> Result<ReplaySession, String> {
        let server = GameServer::new_skirmish(seed, size)?;
        let start_map_hash = server.map_hash();
        let milestones = vec![ReplayMilestone { tick: server.tick(), digest: server.digest() }];
        Ok(ReplaySession { server, milestone_every, start_map_hash, commands: Vec::new(), milestones })
    }

    pub fn server(&self) -> &GameServer {
        &self.server
    }

    pub fn tick(&self) -> u64 {
        self.server.tick()
    }

    pub fn submit(&mut self, line: &str) -> Result<(), String> {
        self.server.submit_json(line)?;
        self.commands.push(ReplayCommand { submit_tick: self.server.tick(), line: line.to_string() });
        Ok(())
    }

    pub fn step(&mut self) {
        self.server.step();
        let tick = self.server.tick();
        if tick > 0 && tick % self.milestone_every == 0 {
            self.milestones.push(ReplayMilestone { tick, digest: self.server.digest() });
        }
    }

    pub fn finish(self) -> Result<String, String> {
        let file = ReplayFile {
            format_version: 2,
            engine: "rust-shipyard".to_string(),
            seed: self.server.seed,
            size: self.server.size,
            map_hash: self.start_map_hash,
            commands: self.commands,
            milestones: self.milestones,
        };
        serde_json::to_string_pretty(&file).map_err(|e| format!("replay encode: {e}"))
    }
}

/// Re-run a replay file and compare every milestone digest. Returns
/// the verified `(tick, digest)` list on success.
pub fn verify_replay(json: &str) -> Result<Vec<(u64, String)>, String> {
    let file: ReplayFile = serde_json::from_str(json).map_err(|e| format!("replay decode: {e}"))?;
    if file.format_version != 2 {
        return Err(format!("unsupported replay format version {}", file.format_version));
    }
    if file.engine != "rust-shipyard" {
        return Err(format!("replay was created by engine '{}', but current build is 'rust-shipyard'", file.engine));
    }
    let mut server = GameServer::new_skirmish(file.seed, file.size)?;
    if server.map_hash() != file.map_hash {
        return Err("replay map hash does not match the generated map".to_string());
    }
    let last = file.milestones.last().ok_or_else(|| "replay has no milestones".to_string())?.tick;
    if file.commands.iter().any(|c| c.submit_tick > last) {
        return Err("replay command submitted past the final milestone".to_string());
    }
    let mut verified = Vec::new();
    let mut pending = file.commands.iter().peekable();
    let mut milestones = file.milestones.iter().peekable();
    // Milestones at the current tick (the initial one) check before stepping.
    while milestones.peek().map(|m| m.tick == server.tick()).unwrap_or(false) {
        let milestone = milestones.next().unwrap();
        if server.digest() != milestone.digest {
            return Err(format!(
                "replay diverges at tick {}: recorded {}, rerun {}",
                milestone.tick,
                milestone.digest,
                server.digest()
            ));
        }
        verified.push((milestone.tick, milestone.digest.clone()));
    }
    while server.tick() < last {
        while pending.peek().map(|c| c.submit_tick == server.tick()).unwrap_or(false) {
            server.submit_json(&pending.next().unwrap().line)?;
        }
        server.step();
        while milestones.peek().map(|m| m.tick == server.tick()).unwrap_or(false) {
            let milestone = milestones.next().unwrap();
            if server.digest() != milestone.digest {
                return Err(format!(
                    "replay diverges at tick {}: recorded {}, rerun {}",
                    milestone.tick,
                    milestone.digest,
                    server.digest()
                ));
            }
            verified.push((milestone.tick, milestone.digest.clone()));
        }
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(server: &GameServer) -> serde_json::Value {
        serde_json::from_str(&server.snapshot_json()).expect("snapshot parses")
    }

    fn order_gather(server: &mut GameServer) {
        let snap = snapshot(server);
        let entities = snap["entities"].as_array().unwrap();
        let villagers: Vec<i64> = entities
            .iter()
            .filter(|e| e["kind"] == "unit" && e["def"] == "villager" && e["owner"] == 0.0)
            .map(|e| e["id"].as_i64().unwrap())
            .collect();
        let node = entities.iter().find(|e| e["kind"] == "node" && e["resource"] == "food").unwrap();
        let cmd = serde_json::json!({"kind": "gather", "data": {"entityIds": villagers, "nodeId": node["id"]}});
        server.submit_json(&cmd.to_string()).unwrap();
    }

    fn step_milestones(server: &mut GameServer, steps: u64) -> Vec<(u64, String)> {
        let mut out = Vec::new();
        for _ in 0..steps {
            server.step();
            if server.tick() % 300 == 0 {
                out.push((server.tick(), server.digest()));
            }
        }
        out
    }

    #[test]
    fn aof2_roundtrip_resumes_mid_game_identically() {
        let mut server = GameServer::new_skirmish(20260903, 64).unwrap();
        order_gather(&mut server);
        step_milestones(&mut server, 600);
        let bytes = server.save_aof2(12.5).expect("save");
        assert_eq!(&bytes[0..4], b"AOF2");
        let continued = step_milestones(&mut server, 600);

        let mut restored = GameServer::new_skirmish(999, 32).unwrap();
        restored.load_aof2(&bytes).expect("load");
        assert_eq!(restored.tick(), 600);
        let resumed = step_milestones(&mut restored, 600);
        assert_eq!(continued, resumed, "resumed match must not diverge");
        assert_eq!(server.digest(), restored.digest());

        // Re-saving the restored match at the same tick reproduces the
        // header digest (payload bytes may differ; digests must not).
        let mut again = GameServer::new_skirmish(1, 32).unwrap();
        again.load_aof2(&restored.save_aof2(0.0).unwrap()).unwrap();
        assert_eq!(again.digest(), server.digest());
    }

    #[test]
    fn aof2_roundtrip_mid_construction() {
        let mut server = GameServer::new_skirmish(20260903, 64).unwrap();
        let snap = snapshot(&server);
        let entities = snap["entities"].as_array().unwrap();
        let tc = entities
            .iter()
            .find(|e| e["kind"] == "building" && e["def"] == "town-center" && e["owner"] == 0.0)
            .unwrap();
        let (ox, oy) = (
            tc["origin_x"].as_f64().unwrap() as i64,
            tc["origin_y"].as_f64().unwrap() as i64,
        );
        let villager = entities
            .iter()
            .find(|e| e["kind"] == "unit" && e["def"] == "villager" && e["owner"] == 0.0)
            .unwrap()["id"]
            .clone();
        // Find a free 2x2 spot near the TC from the map + snapshot
        // (placement rejects loudly, so the test must aim first).
        let map: serde_json::Value = serde_json::from_str(&server.map_json()).unwrap();
        let terrain = map["terrain"].as_array().unwrap();
        let size = 64i64;
        let occupied = |tx: i64, ty: i64| -> bool {
            if terrain[(ty * size + tx) as usize].as_u64().unwrap() <= 1 {
                return true; // water / deep water
            }
            entities.iter().any(|e| {
                let (ex, ey) = (e["x"].as_f64().unwrap(), e["y"].as_f64().unwrap());
                if e["kind"] == "building" || e["kind"] == "site" {
                    let (bx, by) = (e["origin_x"].as_f64().unwrap() as i64, e["origin_y"].as_f64().unwrap() as i64);
                    let (bw, bh) = (e["width"].as_i64().unwrap(), e["height"].as_i64().unwrap());
                    tx >= bx && tx < bx + bw && ty >= by && ty < by + bh
                } else {
                    ex.floor() as i64 == tx && ey.floor() as i64 == ty
                }
            })
        };
        let mut spot = None;
        'search: for ring in 4i64..12 {
            for dy in -ring..=ring {
                for dx in -ring..=ring {
                    let (tx, ty) = (ox + dx, oy + dy);
                    if tx < 1 || ty < 1 || tx + 2 >= size || ty + 2 >= size {
                        continue;
                    }
                    if (0..2).all(|yy| (0..2).all(|xx| !occupied(tx + xx, ty + yy))) {
                        spot = Some((tx, ty));
                        break 'search;
                    }
                }
            }
        }
        let (hx, hy) = spot.expect("a free house plot near the TC");
        let place = serde_json::json!({
            "kind": "placeBuilding",
            "data": {"defId": "house", "tileX": hx, "tileY": hy, "playerId": 0}
        });
        server.submit_json(&place.to_string()).unwrap();
        for _ in 0..5 {
            server.step();
        }
        let snap = snapshot(&server);
        let site = snap["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "site" && e["def"] == "house")
            .expect("house site placed")
            ["id"]
            .clone();
        let build = serde_json::json!({"kind": "build", "data": {"entityIds": [villager], "siteEid": site}});
        server.submit_json(&build.to_string()).unwrap();
        for _ in 0..120 {
            server.step();
        }
        // Mid-construction: the site must still exist at save time.
        assert!(
            snapshot(&server)["entities"].as_array().unwrap().iter().any(|e| e["kind"] == "site"),
            "saved mid-construction"
        );
        let bytes = server.save_aof2(0.0).unwrap();
        let continued = step_milestones(&mut server, 900);

        let mut restored = GameServer::new_skirmish(3, 32).unwrap();
        restored.load_aof2(&bytes).unwrap();
        let resumed = step_milestones(&mut restored, 900);
        assert_eq!(continued, resumed);
        assert!(
            snapshot(&restored)["entities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "building" && e["def"] == "house" && e["owner"] == 0.0),
            "house completed after resume"
        );
    }

    #[test]
    fn aof2_rejects_v1_wrong_engine_and_corruption() {
        let server = GameServer::new_skirmish(5, 48).unwrap();
        let bytes = server.save_aof2(0.0).unwrap();
        let mut restored = GameServer::new_skirmish(6, 48).unwrap();

        let mut v1 = bytes.clone();
        v1[0..4].copy_from_slice(b"AOF1");
        let err = restored.load_aof2(&v1).unwrap_err();
        assert!(err.contains("legacy engine v1"), "{err}");

        let mut ts = bytes.clone();
        ts[8..12].copy_from_slice(&ENGINE_ID_TS.to_le_bytes());
        let err = restored.load_aof2(&ts).unwrap_err();
        assert!(err.contains("TSIM"), "{err}");

        let mut corrupt = bytes.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xff;
        assert!(restored.load_aof2(&corrupt).is_err(), "corrupt payload must fail");

        assert!(restored.load_aof2(&bytes[..bytes.len() - 9]).is_err(), "truncation must fail");
        // The untouched bytes still load: rejection never half-applies.
        restored.load_aof2(&bytes).unwrap();
        assert_eq!(restored.digest(), server.digest());
    }

    #[test]
    fn replay_roundtrip_verifies_and_tamper_fails() {
        let mut session = ReplaySession::new(7, 48, 150).unwrap();
        let snap = snapshot(session.server());
        let entities = snap["entities"].as_array().unwrap();
        let villagers: Vec<i64> = entities
            .iter()
            .filter(|e| e["kind"] == "unit" && e["def"] == "villager" && e["owner"] == 0.0)
            .map(|e| e["id"].as_i64().unwrap())
            .collect();
        let node = entities.iter().find(|e| e["kind"] == "node" && e["resource"] == "wood").unwrap();
        let cmd = serde_json::json!({"kind": "gather", "data": {"entityIds": villagers, "nodeId": node["id"]}});
        session.submit(&cmd.to_string()).unwrap();
        for _ in 0..450 {
            session.step();
        }
        let expected: Vec<(u64, String)> =
            session.milestones.iter().map(|m| (m.tick, m.digest.clone())).collect();
        let json = session.finish().unwrap();
        assert_eq!(verify_replay(&json).unwrap(), expected);

        let tampered = json.replace(&expected[1].1, "fnv1a64:0000000000000000");
        let err = verify_replay(&tampered).unwrap_err();
        assert!(err.contains("diverges"), "{err}");
    }
}

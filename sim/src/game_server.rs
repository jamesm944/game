//! Real-game bridge core (E5a, #201): runs one headless `EconomySim`
//! skirmish (player start vs scripted AI, victory evaluator on) and
//! publishes renderable snapshots. Observational only — snapshots and
//! JSON parsing never feed back into sim state; player input enters
//! exclusively through the same command inbox the fixtures use.
//!
//! Wire shapes are versioned (`ageofwind-game-v1` snapshot,
//! `ageofwind-map-v1` map). Fog-filtered per-player views are E5b
//! scope; v1 snapshots are full-state (spectator) because the AI's own
//! fog-honesty lives inside the sim, not in this publisher.

use std::sync::Arc;

use serde::Serialize;

use crate::ai::{setup_ai_opponent, strategy_by_id, AiPlannerSystem, AI_PLAYER};
use crate::buildings::{
    create_player_age_state, current_age_rank, population, population_cap, AgeComps, BuildingComps,
};
use crate::combat::{CombatAuxComps, CombatComps};
use crate::core::{Command, Eid};
use crate::defs::{Defs, RESOURCE_SLUGS};
use crate::economy::{
    commodity_amounts, create_commodity_stockpile, create_player_stockpile, resource_code_of_slug,
    spawn_resource_node, stockpile_amounts, EconomyComps, PLAYER_ONE,
};
use crate::fog::FogHandle;
use crate::gather::EconomySim;
use crate::mapgen::PASSABLE;
use crate::path::Transport;
use crate::pop::{PopComps, TraitsData};
use crate::victory::{evaluate_outcome, VictoryComps, VictorySystem};

pub const GAME_SNAPSHOT_SCHEMA: &str = "ageofwind-game-v1";
pub const GAME_MAP_SCHEMA: &str = "ageofwind-map-v1";

/// Symmetric skirmish start (mirrors the AI bootstrap default).
const STARTING_RESOURCES: [f64; 7] = [200.0, 600.0, 100.0, 0.0, 0.0, 0.0, 0.0];
const NODE_AMOUNT: i64 = 2000;

#[derive(Serialize)]
struct EntityView {
    id: Eid,
    kind: &'static str,
    def: String,
    owner: f64,
    x: f64,
    y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress_milli_ticks: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount: Option<f64>,
}

#[derive(Serialize)]
struct PlayerView {
    id: f64,
    stockpile: Vec<f64>,
    commodities: Vec<f64>,
    age_rank: f64,
    population: i64,
    population_cap: i64,
}

#[derive(Serialize)]
struct OutcomeView {
    decided: bool,
    winners: Vec<f64>,
    losers: Vec<LoserView>,
}

#[derive(Serialize)]
struct LoserView {
    player: f64,
    reason: &'static str,
}

#[derive(Serialize)]
struct Snapshot {
    schema: &'static str,
    tick: u64,
    digest: String,
    size: usize,
    entities: Vec<EntityView>,
    players: Vec<PlayerView>,
    outcome: OutcomeView,
}

#[derive(Serialize)]
struct MapView {
    schema: &'static str,
    size: usize,
    terrain: Vec<u8>,
    elevation: Vec<u8>,
}

/// One served skirmish: the full ported game, ticked by the caller
/// (the binary paces at ~30 Hz; tests drive it bare).
pub struct GameServer {
    sim: EconomySim,
    defs: Arc<Defs>,
    pub size: usize,
    pub seed: u32,
}

/// First 3×3 all-passable origin at Chebyshev distance >= `min_ring`
/// search expanding from (`cx`, `cy`); deterministic scan order.
fn find_tc_origin(layers: &crate::mapgen::Layers, cx: i64, cy: i64) -> Option<(i64, i64)> {
    let size = layers.size as i64;
    let passable = |x: i64, y: i64| -> bool {
        x >= 0
            && y >= 0
            && x < size
            && y < size
            && layers.passability[(y * size + x) as usize] == PASSABLE
    };
    for ring in 0..size {
        for dy in -ring..=ring {
            for dx in -ring..=ring {
                if dx.abs() != ring && dy.abs() != ring {
                    continue;
                }
                let (ox, oy) = (cx + dx, cy + dy);
                if ox < 1 || oy < 1 || ox + 3 >= size || oy + 3 >= size {
                    continue;
                }
                let mut ok = true;
                for y in oy - 1..oy + 4 {
                    for x in ox - 1..ox + 4 {
                        if !passable(x, y) {
                            ok = false;
                        }
                    }
                }
                if ok {
                    return Some((ox, oy));
                }
            }
        }
    }
    None
}

fn scatter_nodes(sim: &mut EconomySim, econ: &EconomyComps, tc: (i64, i64)) {
    // Deterministic ring around the TC (sight radius 8): food close,
    // wood/gold/stone a step further. Impassable or occupied tiles are
    // skipped by the spawn result.
    let spots: &[(i64, i64, &str)] = &[
        (-3, 0, "food"), (-3, 2, "food"), (5, 0, "food"), (5, 2, "food"),
        (-4, -2, "wood"), (6, -2, "wood"), (-4, 4, "wood"), (6, 4, "wood"),
        (0, -4, "gold"), (2, -4, "gold"), (0, 6, "stone"), (2, 6, "stone"),
        (-3, -3, "food"), (5, 5, "wood"),
    ];
    for (dx, dy, slug) in spots {
        let code = resource_code_of_slug(slug).expect("known resource slug");
        let _ = spawn_resource_node(
            &mut sim.movement.world,
            econ,
            tc.0 + dx,
            tc.1 + dy,
            code,
            NODE_AMOUNT,
            None,
        );
    }
}

impl GameServer {
    /// Seeded skirmish on the generated coastal map: player zero in the
    /// south-west, the fast-castle-knights AI in the north-east.
    pub fn new_skirmish(seed: u32, size: usize) -> Result<GameServer, String> {
        let defs = Arc::new(Defs::load_repo_defaults()?);
        let traits = Arc::new(TraitsData::load_repo_defaults()?);
        let mut sim = EconomySim::new(seed, size, Transport::synchronous(), defs.clone(), traits.clone())?;
        sim.combat.group_routes = true;
        sim.victory = Some(VictorySystem::new(defs.clone()));
        let econ = sim.econ;
        let age = AgeComps::from_world(&sim.movement.world);
        let bcomps = BuildingComps::from_world(&sim.movement.world);

        let s = size as i64;
        let p0_tc = find_tc_origin(&sim.movement.layers, s / 8, s * 7 / 8)
            .ok_or_else(|| "no passable town-center site for player zero".to_string())?;
        let ai_tc = find_tc_origin(&sim.movement.layers, s * 7 / 8, s / 8)
            .ok_or_else(|| "no passable town-center site for the AI".to_string())?;

        // Player zero: ledgers, town center, five villagers.
        create_player_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE, Some(&STARTING_RESOURCES))?;
        create_commodity_stockpile(&mut sim.movement.world, &econ, PLAYER_ONE)?;
        create_player_age_state(&mut sim.movement.world, &age, &econ, PLAYER_ONE);
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            crate::placement::stamp_finished_building(
                world, comps, &bcomps, &econ, &age, &defs, layers, paths,
                "town-center", p0_tc.0, p0_tc.1, PLAYER_ONE,
            );
        }
        let p0_villagers: Vec<(f64, f64)> = (0..5)
            .map(|i| (p0_tc.0 as f64 - 0.5 + i as f64, p0_tc.1 as f64 + 4.5))
            .collect();
        for (x, y) in &p0_villagers {
            sim.spawn_unit(*x, *y);
        }

        // AI opponent (bootstrap parity with the fixtures).
        let ai_villagers: Vec<(f64, f64)> = (0..5)
            .map(|i| (ai_tc.0 as f64 - 0.5 + i as f64, ai_tc.1 as f64 + 4.5))
            .collect();
        {
            let crate::movement::MovementSim { world, comps, layers, paths, .. } = &mut sim.movement;
            let pop = PopComps::from_world(world);
            let morale = CombatComps::from_world(world).morale;
            setup_ai_opponent(
                world, comps, &econ, &bcomps, &age, &pop, morale, &traits, &defs, layers, paths,
                AI_PLAYER, ai_tc, &ai_villagers, Some(&STARTING_RESOURCES),
            );
        }

        scatter_nodes(&mut sim, &econ, p0_tc);
        scatter_nodes(&mut sim, &econ, ai_tc);

        sim.ai = Some(AiPlannerSystem::new(strategy_by_id("fast-castle-knights"), FogHandle::new(size, 2)));
        {
            let fcomps =
                crate::fog::FogComps::new(&sim.movement.comps, &bcomps, &CombatComps::from_world(&sim.movement.world));
            let pop = PopComps::from_world(&sim.movement.world);
            sim.ai.as_mut().expect("ai").fog.recompute_all(&sim.movement.world, &fcomps, &pop, &defs);
        }

        Ok(GameServer { sim, defs, size, seed })
    }

    pub fn tick(&self) -> u64 {
        self.sim.movement.world.tick
    }

    pub fn digest(&self) -> String {
        self.sim.digest()
    }

    /// Advance one world step; true iff the tick advanced.
    pub fn step(&mut self) -> bool {
        self.sim.step()
    }

    /// Planner orders issued under `kind` (telemetry read for tests/HUD).
    pub fn ai_issued(&self, kind: &str) -> u64 {
        self.sim
            .ai
            .as_ref()
            .and_then(|ai| ai.telemetry.issued_by_kind.get(kind).copied())
            .unwrap_or(0)
    }

    /// Parse one wire command (`{kind, targetTick?, data?}`; extra
    /// top-level fields fold into `data` when it is absent) and queue
    /// it in the sim inbox. A missing/past target tick re-stamps to
    /// the next tick — live clients are not lockstep peers.
    pub fn submit_json(&mut self, line: &str) -> Result<(), String> {
        let value: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("invalid command JSON: {e}"))?;
        let object = value.as_object().ok_or_else(|| "command must be a JSON object".to_string())?;
        let kind = object
            .get("kind")
            .and_then(|v| v.as_str())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| "command requires a non-empty kind".to_string())?
            .to_string();
        let now = self.tick();
        let target_tick = object
            .get("targetTick")
            .or_else(|| object.get("target_tick"))
            .and_then(|v| v.as_u64())
            .filter(|t| *t > now)
            .unwrap_or(now + 1);
        let data = match object.get("data") {
            Some(data) => Some(data.clone()),
            None => {
                let rest: serde_json::Map<String, serde_json::Value> = object
                    .iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "kind" | "targetTick" | "target_tick"))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                if rest.is_empty() { None } else { Some(serde_json::Value::Object(rest)) }
            }
        };
        self.sim.submit(Command { kind, target_tick, data })
    }

    fn victory_comps(&self) -> VictoryComps {
        let world = &self.sim.movement.world;
        let bcomps = BuildingComps::from_world(world);
        VictoryComps::new(world, &self.sim.econ, bcomps.building, CombatAuxComps::from_world(world).relic)
    }

    /// Full-state render snapshot as one JSON document.
    pub fn snapshot_json(&self) -> String {
        let world = &self.sim.movement.world;
        let comps = self.sim.movement.comps;
        let econ = self.sim.econ;
        let bcomps = BuildingComps::from_world(world);
        let ccomps = CombatComps::from_world(world);
        let pop = PopComps::from_world(world);
        let age = AgeComps::from_world(world);
        let defs = &self.defs;

        let mut entities = Vec::new();
        for &eid in &world.entities {
            let Some(pos) = world.rows_by_component[comps.position].get(&eid) else { continue };
            let (x, y) = (pos[0], pos[1]);
            let (heading, speed) = match world.rows_by_component[comps.velocity].get(&eid) {
                Some(v) => (Some(v[0]), Some(v[1])),
                None => (None, None),
            };
            let mut view = EntityView {
                id: eid,
                kind: "unit",
                def: String::new(),
                owner: -1.0,
                x,
                y,
                heading,
                speed,
                hp: None,
                origin_x: None,
                origin_y: None,
                width: None,
                height: None,
                progress_milli_ticks: None,
                resource: None,
                amount: None,
            };
            if let Some(b) = world.rows_by_component[bcomps.building].get(&eid) {
                let def_id = defs.building_id_of_code(b[1] as u32);
                let def = defs.building(def_id);
                view.kind = "building";
                view.def = def_id.to_string();
                view.owner = b[0];
                view.hp = Some(b[4]);
                view.origin_x = Some(b[2]);
                view.origin_y = Some(b[3]);
                view.width = Some(def.footprint.width);
                view.height = Some(def.footprint.height);
            } else if let Some(site) = world.rows_by_component[bcomps.building_site].get(&eid) {
                let def_id = defs.building_id_of_code(site[1] as u32);
                let def = defs.building(def_id);
                view.kind = "site";
                view.def = def_id.to_string();
                view.owner = site[0];
                view.hp = Some(site[3]);
                view.progress_milli_ticks = Some(site[2]);
                view.origin_x = Some(x - def.footprint.width as f64 / 2.0);
                view.origin_y = Some(y - def.footprint.height as f64 / 2.0);
                view.width = Some(def.footprint.width);
                view.height = Some(def.footprint.height);
            } else if let Some(rubble) = world.rows_by_component[bcomps.rubble].get(&eid) {
                view.kind = "rubble";
                view.def = "rubble".to_string();
                view.origin_x = Some(rubble[0]);
                view.origin_y = Some(rubble[1]);
                view.width = Some(rubble[2] as i64);
                view.height = Some(rubble[3] as i64);
            } else if let Some(node) = world.rows_by_component[econ.resource_node].get(&eid) {
                view.kind = "node";
                let slug = RESOURCE_SLUGS.get(node[0] as usize).copied().unwrap_or("food");
                view.def = slug.to_string();
                view.resource = Some(slug);
                view.amount = Some(node[1]);
            } else if let Some(cr) = world.rows_by_component[ccomps.combat].get(&eid) {
                view.def = defs.unit_id_of_code(cr[0] as u32).to_string();
                view.owner = cr[1];
                view.hp = Some(cr[2]);
            } else if world.rows_by_component[comps.unit_tag].contains_key(&eid) {
                view.def = crate::fog::DEFAULT_UNIT_DEF_ID.to_string();
                view.owner = world.rows_by_component[pop.owner].get(&eid).map(|r| r[0]).unwrap_or(PLAYER_ONE);
            } else {
                continue;
            }
            entities.push(view);
        }

        let players = [PLAYER_ONE, AI_PLAYER]
            .iter()
            .map(|&player| PlayerView {
                id: player,
                stockpile: stockpile_amounts(world, &econ, player),
                commodities: commodity_amounts(world, &econ, player),
                age_rank: current_age_rank(world, &age, player),
                population: population(world, &comps, &bcomps, Some(player)),
                population_cap: population_cap(world, &bcomps, defs, Some(player)),
            })
            .collect();

        let outcome = evaluate_outcome(world, &self.victory_comps());
        let snapshot = Snapshot {
            schema: GAME_SNAPSHOT_SCHEMA,
            tick: world.tick,
            digest: self.sim.digest(),
            size: self.size,
            entities,
            players,
            outcome: OutcomeView {
                decided: outcome.decided,
                winners: outcome.winners,
                losers: outcome.losers.into_iter().map(|(player, reason)| LoserView { player, reason }).collect(),
            },
        };
        serde_json::to_string(&snapshot).expect("snapshot serializes")
    }

    /// Static map planes for the renderer (fetched once, not streamed).
    pub fn map_json(&self) -> String {
        let layers = &self.sim.movement.layers;
        let view = MapView {
            schema: GAME_MAP_SCHEMA,
            size: layers.size,
            terrain: layers.terrain.clone(),
            elevation: layers.elevation.clone(),
        };
        serde_json::to_string(&view).expect("map serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(server: &GameServer) -> serde_json::Value {
        serde_json::from_str(&server.snapshot_json()).expect("snapshot parses")
    }

    /// Drive player zero's villagers onto the nearest food node through
    /// the public wire shape, exactly as a client would.
    fn order_gather(server: &mut GameServer) {
        let snap = snapshot(server);
        let entities = snap["entities"].as_array().expect("entities");
        let villagers: Vec<i64> = entities
            .iter()
            .filter(|e| e["kind"] == "unit" && e["def"] == "villager" && e["owner"] == 0.0)
            .map(|e| e["id"].as_i64().unwrap())
            .collect();
        assert_eq!(villagers.len(), 5, "player zero starts with five villagers");
        let node = entities
            .iter()
            .find(|e| e["kind"] == "node" && e["resource"] == "food")
            .expect("a food node exists");
        let cmd = serde_json::json!({
            "kind": "gather",
            "data": {"entityIds": villagers, "nodeId": node["id"]}
        });
        server.submit_json(&cmd.to_string()).expect("gather command queues");
    }

    #[test]
    fn skirmish_serves_deterministically_with_live_ai() {
        let run = || {
            let mut server = GameServer::new_skirmish(20260903, 64).expect("skirmish setup");
            let map: serde_json::Value = serde_json::from_str(&server.map_json()).expect("map parses");
            assert_eq!(map["schema"], GAME_MAP_SCHEMA);
            assert_eq!(map["terrain"].as_array().unwrap().len(), 64 * 64);
            let snap0 = snapshot(&server);
            assert_eq!(snap0["schema"], GAME_SNAPSHOT_SCHEMA);
            assert_eq!(snap0["players"].as_array().unwrap().len(), 2);
            assert_eq!(snap0["outcome"]["decided"], false);
            let buildings = snap0["entities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["kind"] == "building" && e["def"] == "town-center")
                .count();
            assert_eq!(buildings, 2, "both town centers stamped");

            order_gather(&mut server);
            let mut milestones = Vec::new();
            for _ in 0..900 {
                server.step();
                if server.tick() % 300 == 0 {
                    milestones.push((server.tick(), server.digest()));
                }
            }
            (server, milestones)
        };

        let (server, first) = run();
        let (_, second) = run();
        assert_eq!(first, second, "same seed + commands ⇒ identical digests");
        assert_eq!(first.len(), 3);

        // Player zero actually harvested: food stockpile grew past start.
        let snap = snapshot(&server);
        let p0_food = snap["players"][0]["stockpile"][0].as_f64().unwrap();
        assert!(p0_food > STARTING_RESOURCES[0], "gather pipeline delivered food: {p0_food}");
        // The AI planner is playing through the inbox, not idling.
        assert!(server.ai_issued("gather") > 0, "AI issued gather orders");
    }

    #[test]
    fn submit_json_validates_wire_shape() {
        let mut server = GameServer::new_skirmish(7, 48).expect("skirmish setup");
        assert!(server.submit_json("not json").is_err());
        assert!(server.submit_json("[1,2]").is_err());
        assert!(server.submit_json("{}").is_err());
        assert!(server.submit_json("{\"kind\":\"\"}").is_err());
        // Extra fields fold into data; a stale target tick re-stamps.
        assert!(server
            .submit_json("{\"kind\":\"surrender\",\"targetTick\":0,\"playerId\":0}")
            .is_ok());
        for _ in 0..3 {
            server.step();
        }
        let snap = snapshot(&server);
        assert_eq!(snap["outcome"]["decided"], true, "surrender decided the match");
        assert_eq!(snap["outcome"]["winners"], serde_json::json!([1.0]));
    }
}

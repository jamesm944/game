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
    if def.armor_classes.iter().any(|c| c == "monk") || def_id == "monk" {
        panic!("combat spawn: Faith row for {def_id} lands with the faith port");
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

//! TS-reference parity harness for ticket #187 (ADR-0012 §2).
//!
//! Reimplements the frozen TS golden scenario `tests/golden/m1t2`
//! (case.json + harness semantics from its golden.test.ts) on a Shipyard
//! ECS tick and compares SPEC §7 milestone digests. PRNG (sfc32 seeded
//! via splitmix32, SPEC §2.1), inbox semantics (drain commands with
//! targetTick <= tick in (targetTick, submission) order), system order
//! (ping, then drift), spawn formulas, and the digest byte layout are
//! ported bit-exactly from `src/sim/core/{prng,inbox,world,digest}.ts`.
//! ADR-0012 does not require float/byte equality with TS — semantic
//! trace equality is the contract — but every float op here is an IEEE
//! add/mul/div-by-power-of-two in the same order as TS, so equality is
//! achievable and asserted where it holds.
//!
//! Parallel mode pre-draws each entity's drift deltas sequentially (the
//! PRNG stream stays single and ordered) into a TickDraws component,
//! then applies them with Shipyard par_iter, so digests are
//! worker-count independent by construction.
use rayon::prelude::*;
use serde::Deserialize;
use shipyard::{
    Component, EntityId, Get, IntoIter, Unique, UniqueView, UniqueViewMut, View, ViewMut,
    Workload, World,
};
use std::time::Instant;

// ---------------------------------------------------------------- PRNG + digest
// Shared with the production core (crate::core, E3a/#193); these were
// proven bit-exact here first (#187) and moved, not re-derived.
pub use crate::core::{format_digest, splitmix32_stream, Sfc32, SFC32_WARMUP_ROUNDS};

use crate::core::compute_digest;

// ---------------------------------------------------------------- Fixture case

#[derive(Deserialize, Clone)]
pub struct CaseCommandData {
    pub eid: i64,
    pub amount: f64,
}

#[derive(Deserialize, Clone)]
pub struct CaseCommand {
    pub kind: String,
    #[serde(rename = "targetTick")]
    pub target_tick: u64,
    pub data: Option<CaseCommandData>,
}

#[derive(Deserialize, Clone)]
struct CaseComponent {
    name: String,
    #[allow(dead_code)]
    arity: usize,
}

#[derive(Deserialize, Clone)]
pub struct Case {
    pub name: String,
    pub seed: u32,
    pub ticks: u64,
    #[serde(rename = "milestoneEvery")]
    pub milestone_every: u64,
    #[serde(rename = "entityCount")]
    pub entity_count: usize,
    components: Vec<CaseComponent>,
    pub commands: Vec<CaseCommand>,
}

impl Case {
    pub fn from_json(text: &str) -> Result<Case, String> {
        let case: Case = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let names: Vec<&str> = case.components.iter().map(|c| c.name.as_str()).collect();
        if names != ["mass", "position"] {
            return Err(format!("parity harness supports components [mass, position], got {names:?}"));
        }
        Ok(case)
    }
}

// ---------------------------------------------------------------- ECS state

#[derive(Component)]
struct Mass(f64);
#[derive(Component)]
struct Position {
    x: f64,
    y: f64,
}
#[derive(Component)]
struct TickDraws {
    dx: f64,
    dy: f64,
}

#[derive(Unique)]
struct PrngRes(Sfc32);
#[derive(Unique)]
struct Order(Vec<EntityId>);
#[derive(Unique)]
struct Due(Vec<CaseCommand>);
#[derive(Unique)]
struct Arrivals(Vec<u64>);
#[derive(Unique)]
struct TickNow(u64);
#[derive(Unique)]
struct ParFlag(bool);

fn ping_system(
    due: UniqueView<Due>,
    order: UniqueView<Order>,
    tick: UniqueView<TickNow>,
    mut arrivals: UniqueViewMut<Arrivals>,
    mut mass: ViewMut<Mass>,
) {
    for command in &due.0 {
        assert_eq!(command.kind, "ping", "fixture cannot handle command: {}", command.kind);
        let data = command.data.as_ref().expect("ping.data required");
        let ent = order.0[(data.eid - 1) as usize];
        let mut row = (&mut mass).get(ent).expect("ping targets missing mass row");
        row.0 += data.amount;
        arrivals.0.push(tick.0);
    }
}

fn draw_system(
    mut prng: UniqueViewMut<PrngRes>,
    order: UniqueView<Order>,
    mut draws: ViewMut<TickDraws>,
) {
    for &ent in &order.0 {
        // Same draw order and float ops as the TS drift system:
        // x uses nextU32()/2^32, y uses nextFloat() (= nextU32()/2^32).
        let dx = (prng.0.next_u32() as f64 / 4_294_967_296.0 - 0.5) * 0.01;
        let dy = (prng.0.next_float() - 0.5) * 0.01;
        let mut row = (&mut draws).get(ent).expect("missing TickDraws row");
        row.dx = dx;
        row.dy = dy;
    }
}

fn apply_system(par: UniqueView<ParFlag>, mut pos: ViewMut<Position>, draws: View<TickDraws>) {
    if par.0 {
        (&mut pos, &draws).par_iter().for_each(|(p, d)| {
            p.x += d.dx;
            p.y += d.dy;
        });
        return;
    }
    for (p, d) in (&mut pos, &draws).iter() {
        p.x += d.dx;
        p.y += d.dy;
    }
}

fn tick_workload() -> Workload {
    Workload::new("tick")
        .with_system(ping_system)
        .with_barrier()
        .with_system(draw_system)
        .with_barrier()
        .with_system(apply_system)
}

// ---------------------------------------------------------------- Runner

pub struct ParityRun {
    pub digests: Vec<(u64, String)>,
    pub arrivals: Vec<u64>,
    pub tick_ms: Vec<f64>,
}

pub fn run_scenario(case: &Case, parallel: bool) -> ParityRun {
    let mut world = World::new();
    let mut order = Vec::with_capacity(case.entity_count);
    for n in 0..case.entity_count {
        // Spawn formulas verbatim from tests/golden/m1t2/golden.test.ts.
        let mass = 1.0 + n as f64 * 0.25;
        let x = (n % 5) as f64 * 2.0 + 0.5;
        let y = (n / 5) as f64 * 3.0 + 0.25;
        let ent = world.add_entity((Mass(mass), Position { x, y }, TickDraws { dx: 0.0, dy: 0.0 }));
        order.push(ent);
    }
    world.add_unique(PrngRes(Sfc32::new_seeded(case.seed)));
    world.add_unique(Order(order));
    world.add_unique(Due(Vec::new()));
    world.add_unique(Arrivals(Vec::new()));
    world.add_unique(TickNow(0));
    world.add_unique(ParFlag(parallel));
    world.add_workload(tick_workload);

    // Inbox: insertion keeps (targetTick, submission seq) order; drain
    // consumes every command with targetTick <= tick (inbox.ts).
    let mut queue: Vec<CaseCommand> = case.commands.clone();
    queue.sort_by_key(|c| c.target_tick); // Vec sort is stable: submission order preserved within a tick.

    let mut digests = Vec::new();
    let mut tick_ms = Vec::with_capacity(case.ticks as usize);
    for t in 1..=case.ticks {
        let start = Instant::now();
        let mut due = Vec::new();
        while queue.first().map(|c| c.target_tick <= t).unwrap_or(false) {
            due.push(queue.remove(0));
        }
        world.run(|mut due_res: UniqueViewMut<Due>, mut tick_res: UniqueViewMut<TickNow>| {
            due_res.0 = due;
            tick_res.0 = t;
        });
        world.run_workload("tick").expect("tick workload");
        tick_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        if t % case.milestone_every == 0 || t == case.ticks {
            digests.push((t, world_digest(&world)));
        }
    }
    let arrivals = world.run(|a: UniqueView<Arrivals>| a.0.clone());
    ParityRun { digests, arrivals, tick_ms }
}

fn world_digest(world: &World) -> String {
    world.run(|mass: View<Mass>, pos: View<Position>, order: UniqueView<Order>| {
        let rows_mass: Vec<(i64, Vec<f64>)> = order
            .0
            .iter()
            .enumerate()
            .map(|(i, &ent)| ((i + 1) as i64, vec![mass.get(ent).expect("digest mass row").0]))
            .collect();
        let rows_pos: Vec<(i64, Vec<f64>)> = order
            .0
            .iter()
            .enumerate()
            .map(|(i, &ent)| {
                let p = pos.get(ent).expect("digest position row");
                ((i + 1) as i64, vec![p.x, p.y])
            })
            .collect();
        compute_digest(&[("mass", &rows_mass), ("position", &rows_pos)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED: [(u64, &str); 3] = [
        (30, "fnv1a64:f831dd442da1ca60"),
        (60, "fnv1a64:06535a22228d7441"),
        (90, "fnv1a64:f5e7ce65a95fe1e3"),
    ];

    fn load_case() -> Case {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/m1t2/case.json");
        let text = std::fs::read_to_string(path).expect("read m1t2 case.json");
        Case::from_json(&text).expect("parse m1t2 case")
    }

    #[test]
    fn m1t2_digest_parity_with_ts_snapshot() {
        let run = run_scenario(&load_case(), false);
        let got: Vec<(u64, &str)> = run.digests.iter().map(|(t, d)| (*t, d.as_str())).collect();
        assert_eq!(got, EXPECTED.to_vec());
        assert_eq!(run.arrivals, vec![5, 30, 31]);
    }

    #[test]
    fn parallel_digest_equals_sequential() {
        let case = load_case();
        let seq = run_scenario(&case, false);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap();
        let par = pool.install(|| run_scenario(&case, true));
        assert_eq!(par.digests, seq.digests);
        assert_eq!(par.arrivals, seq.arrivals);
    }
}

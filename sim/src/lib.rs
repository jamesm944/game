//! Ageofwind production simulation core (skeleton, ticket #186).
//! Integer-only deterministic tick; parallel map with canonical reduction so
//! digests are worker-count independent (ADR-0012 parity definition).
pub mod activities;
pub mod core;
pub mod deep;
pub mod defs;
pub mod economy;
pub mod mapgen;
pub mod movement;
pub mod parity;
pub mod path;
pub mod trig;
use deep::*;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Pop {
    pub id: u32,
    pub x: i32,
    pub z: i32,
    pub tx: i32,
    pub tz: i32,
    pub food: i32,
    pub rest: i32,
    pub morale: i32,
    pub wealth: i64,
    pub carried: i32,
    pub deliveries: u32,
    pub manual: bool,
    #[serde(default)]
    pub deep: DeepState,
}
#[derive(Deserialize, Clone)]
pub struct Command {
    pub kind: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub z: i32,
}
pub struct World {
    pub pops: Vec<Pop>,
    pub tick: u64,
    pub stock: i64,
    pub ack: u64,
    pub paused: bool,
    pub next_id: u32,
    pub pop_cap: usize,
    /// Structured last seasonal migration outcome (kind: 0 none, 1 arrived,
    /// 2 arrived discouraged, 3 refused/unhappy, 4 refused/danger).
    pub last_migration_tick: u64,
    pub last_migration_kind: u8,
    pub last_migration_arrived: u32,
}
pub const MIG_NONE: u8 = 0;
pub const MIG_ARRIVED: u8 = 1;
pub const MIG_DISCOURAGED: u8 = 2;
pub const MIG_REFUSED_UNHAPPY: u8 = 3;
pub const MIG_REFUSED_DANGER: u8 = 4;
/// One migration evaluation per season (~100 s at the 33 ms server tick).
pub const SEASON_TICKS: u64 = 3000;
#[derive(Serialize)]
struct Snapshot<'a> {
    schema: &'static str,
    pub tick: u64,
    pops: &'a [Pop],
    pub stock: i64,
    pub ack: u64,
    pub paused: bool,
    digest: String,
    workers: usize,
    threads_observed: usize,
    sim_ms: f64,
    last_migration_tick: u64,
    last_migration_kind: u8,
    last_migration_arrived: u32,
}
pub fn make_pop(id: u32) -> Pop {
    let i = id as usize;
    Pop {
        id,
        x: -8000 + ((i * 37) % 360) as i32 * 100,
        z: -14000 + ((i * 53) % 280) as i32 * 100,
        tx: 22000 + (i % 4) as i32 * 800,
        tz: -11000 + (i % 23) as i32 * 1000,
        food: 10000,
        rest: 10000,
        morale: 8000,
        wealth: 0,
        carried: 0,
        deliveries: 0,
        manual: false,
        deep: DeepState::new(id),
    }
}
pub fn init(n: usize) -> World {
    World {
        pops: (0..n).map(|i| make_pop(i as u32)).collect(),
        tick: 0,
        stock: 0,
        ack: 0,
        paused: false,
        next_id: n as u32,
        pop_cap: n.max(1000),
        last_migration_tick: 0,
        last_migration_kind: MIG_NONE,
        last_migration_arrived: 0,
    }
}
pub fn apply(w: &mut World, c: &Command) {
    // Protocol enum, never interpreting human language.
    match c.kind.as_str() {
        "move" => {
            for p in w.pops.iter_mut().take(32) {
                p.tx = c.x.clamp(-14000, 38000);
                p.tz = c.z.clamp(-23000, 23000);
                p.manual = true;
            }
        }
        "work" => {
            for p in &mut w.pops {
                p.manual = false;
                p.tx = 22000 + (p.id % 4) as i32 * 800;
                p.tz = -11000 + (p.id % 23) as i32 * 1000;
            }
        }
        "pause" => w.paused = !w.paused,
        _ => return,
    }
    w.ack = w.ack.max(c.seq);
}
fn next_pop(p: &Pop, tick: u64) -> (Pop, i64) {
    let mut q = p.clone();
    let mut deposit = 0;
    // Integer arithmetic and entity-based cadence: independent of worker order.
    let dx = q.tx - q.x;
    let dz = q.tz - q.z;
    q.x += dx.clamp(-65, 65);
    q.z += dz.clamp(-65, 65);
    if !q.manual && dx.abs() <= 65 && dz.abs() <= 65 {
        if q.carried == 0 {
            q.carried = 10;
            q.tx = 5000;
            q.tz = -1000 + (q.id % 9) as i32 * 200;
        } else {
            deposit = q.carried as i64;
            q.wealth += deposit;
            q.deliveries += 1;
            q.carried = 0;
            q.deep.satisfy(N_OCCUPIED);
            q.deep.eustress(40, C_DELIVERED, tick);
            q.tx = 22000 + (q.id % 4) as i32 * 800;
            q.tz = -11000 + (q.id % 23) as i32 * 1000;
        }
    }
    if (tick + q.id as u64) % 30 == 0 {
        q.food = (q.food - 3).max(0);
        q.rest = (q.rest - 2).max(0);
        if q.food < 8500 && q.wealth > 0 {
            q.wealth -= 1;
            q.food = (q.food + 200).min(10000);
            q.deep.satisfy(N_EAT);
            q.deep.eustress(25, C_ATE_MEAL, tick);
        } else if q.food < 3000 {
            q.deep.distress(30, C_HUNGRY, tick);
        }
        // Working pops pass each other constantly; manual (idle-ordered)
        // pops rest. Deterministic nourishment, no spatial query yet.
        if !q.manual {
            q.deep.nourish(N_SOCIAL, 4);
        } else {
            q.deep.nourish(N_EASY, 6);
        }
        q.deep.cadence(tick);
        q.morale = q.deep.morale();
    }
    (q, deposit)
}
pub fn advance(w: &mut World, pool: &rayon::ThreadPool, parallel: bool) -> usize {
    if w.paused {
        return 0;
    }
    w.tick += 1;
    let compute = |chunk: &[Pop]| {
        let values = chunk
            .iter()
            .map(|p| next_pop(p, w.tick))
            .collect::<Vec<_>>();
        (values, rayon::current_thread_index().unwrap_or(0))
    };
    let batches = if parallel {
        pool.install(|| w.pops.par_chunks(64).map(compute).collect::<Vec<_>>())
    } else {
        w.pops.chunks(64).map(compute).collect::<Vec<_>>()
    };
    let mut ids = BTreeSet::new();
    let mut next = Vec::with_capacity(w.pops.len());
    // Indexed parallel collect preserves input order; canonical integer reduction.
    for (batch, worker) in batches {
        ids.insert(worker);
        for (pop, deposit) in batch {
            next.push(pop);
            w.stock += deposit;
        }
    }
    w.pops = next;
    if w.tick % SEASON_TICKS == 0 {
        migrate(w);
    }
    ids.len()
}
/// Seasonal migration evaluation (DF design, #190): site happiness
/// reputation from resident stress bands gates arrival; wave is clamped
/// by the population cap. Outcome is a structured kind, never text.
fn migrate(w: &mut World) {
    w.last_migration_tick = w.tick;
    let total = w.pops.len().max(1) as i64;
    let miserable = w.pops.iter().filter(|p| p.deep.stress_band() >= 5).count() as i64;
    let unhappy = w.pops.iter().filter(|p| p.deep.stress_band() >= 4).count() as i64;
    // Deterministic integer roll from tick+stock (own constant, DF's is unknown).
    let roll = ((w.tick.wrapping_mul(2654435761) ^ (w.stock as u64).wrapping_mul(40503)) >> 16) % 100;
    let room = w.pop_cap.saturating_sub(w.pops.len());
    let (kind, mut wave): (u8, usize) = if room == 0 {
        (MIG_NONE, 0)
    } else if miserable * 2 > total || (miserable * 4 > total && roll < 50) {
        (MIG_REFUSED_UNHAPPY, 0)
    } else if unhappy * 4 > total {
        (MIG_DISCOURAGED, 1 + (roll as usize % 2))
    } else {
        (MIG_ARRIVED, 3 + (roll as usize % 7))
    };
    wave = wave.min(room);
    for _ in 0..wave {
        let id = w.next_id;
        w.next_id += 1;
        w.pops.push(make_pop(id));
    }
    w.last_migration_kind = kind;
    w.last_migration_arrived = wave as u32;
}
pub fn digest(w: &World) -> String {
    let mut h = 0xcbf29ce484222325u64;
    let mut add = |n: i64| {
        for b in n.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    add(w.tick as i64);
    add(w.stock);
    add(w.ack as i64);
    add(w.paused as i64);
    add(w.next_id as i64);
    add(w.pop_cap as i64);
    add(w.last_migration_tick as i64);
    add(w.last_migration_kind as i64);
    add(w.last_migration_arrived as i64);
    for p in &w.pops {
        for n in [
            p.id as i64,
            p.x as i64,
            p.z as i64,
            p.tx as i64,
            p.tz as i64,
            p.food as i64,
            p.rest as i64,
            p.morale as i64,
            p.wealth,
            p.carried as i64,
            p.deliveries as i64,
            p.manual as i64,
            p.deep.stress as i64,
            p.deep.longterm_stress as i64,
            p.deep.time_without_distress as i64,
            p.deep.time_without_eustress as i64,
            p.deep.mem_next as i64,
        ] {
            add(n);
        }
        for n in p.deep.facets {
            add(n as i64);
        }
        for i in 0..deep::NEEDS {
            add(p.deep.focus[i] as i64);
            add(p.deep.need_rate[i] as i64);
        }
        for m in p.deep.mem {
            add(m.circ as i64);
            add(m.strength as i64);
            add(m.tick as i64);
        }
    }
    format!("{h:016x}")
}
pub fn snapshot(w: &World, workers: usize, observed: usize, ms: f64) -> String {
    serde_json::to_string(&Snapshot {
        schema: "ageofwind-sim-v1",
        tick: w.tick,
        pops: &w.pops,
        stock: w.stock,
        ack: w.ack,
        paused: w.paused,
        digest: digest(w),
        workers,
        threads_observed: observed,
        sim_ms: ms,
        last_migration_tick: w.last_migration_tick,
        last_migration_kind: w.last_migration_kind,
        last_migration_arrived: w.last_migration_arrived,
    })
    .unwrap()
}

pub const SAVE_FORMAT: &str = "ageofwind-save-v2";

#[derive(Serialize, Deserialize)]
pub struct SaveFile {
    pub format: String,
    pub tick: u64,
    pub stock: i64,
    pub ack: u64,
    pub paused: bool,
    pub pops: Vec<Pop>,
    pub digest: String,
    #[serde(default)]
    pub next_id: u32,
    #[serde(default = "default_pop_cap")]
    pub pop_cap: usize,
    #[serde(default)]
    pub last_migration_tick: u64,
    #[serde(default)]
    pub last_migration_kind: u8,
    #[serde(default)]
    pub last_migration_arrived: u32,
}
fn default_pop_cap() -> usize {
    1000
}

impl World {
    pub fn to_save(&self) -> SaveFile {
        SaveFile { format: SAVE_FORMAT.into(), tick: self.tick, stock: self.stock, ack: self.ack, paused: self.paused, pops: self.pops.clone(), digest: digest(self), next_id: self.next_id, pop_cap: self.pop_cap, last_migration_tick: self.last_migration_tick, last_migration_kind: self.last_migration_kind, last_migration_arrived: self.last_migration_arrived }
    }
    pub fn from_save(s: SaveFile) -> Result<World, String> {
        if s.format != SAVE_FORMAT { return Err(format!("bad save format {:?}", s.format)); }
        let next_id = if s.next_id == 0 { s.pops.iter().map(|p| p.id + 1).max().unwrap_or(0) } else { s.next_id };
        let w = World { pops: s.pops, tick: s.tick, stock: s.stock, ack: s.ack, paused: s.paused, next_id, pop_cap: s.pop_cap, last_migration_tick: s.last_migration_tick, last_migration_kind: s.last_migration_kind, last_migration_arrived: s.last_migration_arrived };
        if digest(&w) != s.digest { return Err("save digest mismatch".into()); }
        Ok(w)
    }
    pub fn save_json(&self) -> String { serde_json::to_string(&self.to_save()).unwrap() }
    pub fn load_json(text: &str) -> Result<World, String> {
        let s: SaveFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
        Self::from_save(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(workers: usize, ticks: u64) -> World {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(workers).build().unwrap();
        let mut w = init(300);
        for _ in 0..ticks { advance(&mut w, &pool, workers > 1); }
        w
    }
    #[test]
    fn worker_count_digest_parity() {
        let a = digest(&run(1, 300));
        for workers in [2, 4, 8] { assert_eq!(a, digest(&run(workers, 300)), "workers={workers}"); }
    }
    #[test]
    fn save_load_round_trip() {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap();
        let mut uninterrupted = init(300);
        for _ in 0..200 { advance(&mut uninterrupted, &pool, true); }
        let mut restored = World::load_json(&run(4, 100).save_json()).unwrap();
        for _ in 0..100 { advance(&mut restored, &pool, true); }
        assert_eq!(digest(&uninterrupted), digest(&restored));
    }
    #[test]
    fn migration_wave_arrives_and_respects_cap() {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let mut w = init(10);
        w.pop_cap = 15;
        for _ in 0..SEASON_TICKS { advance(&mut w, &pool, false); }
        assert_eq!(w.last_migration_tick, SEASON_TICKS);
        assert!(w.pops.len() > 10, "pops={}", w.pops.len());
        assert!(w.pops.len() <= 15);
        assert_eq!(w.last_migration_kind, MIG_ARRIVED);
        // New migrants carry deterministic deep state for their id.
        let migrant = &w.pops[10];
        assert_eq!(migrant.deep, DeepState::new(migrant.id));
    }
    #[test]
    fn miserable_site_refuses_migrants() {
        let mut w = init(10);
        for p in &mut w.pops { p.deep.stress = 20_000; }
        w.tick = SEASON_TICKS;
        migrate(&mut w);
        assert_eq!(w.last_migration_kind, MIG_REFUSED_UNHAPPY);
        assert_eq!(w.pops.len(), 10);
        assert_eq!(w.last_migration_arrived, 0);
    }
    #[test]
    fn migration_digest_parity_across_workers() {
        let pool = |n: usize| rayon::ThreadPoolBuilder::new().num_threads(n).build().unwrap();
        let run = |n: usize| {
            let p = pool(n);
            let mut w = init(20);
            for _ in 0..(SEASON_TICKS + 90) { advance(&mut w, &p, n > 1); }
            digest(&w)
        };
        assert_eq!(run(1), run(4));
    }
    #[test]
    fn tampered_save_rejected() {
        let mut s = run(1, 10).save_json();
        s = s.replace("\"stock\":0", "\"stock\":999");
        assert!(World::load_json(&s).is_err());
    }
}

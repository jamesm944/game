//! Deterministic sim core contracts (E3a, ticket #193): Rust port of the
//! TS `src/sim/core/{registry,inbox,prng,digest,world}.ts` surfaces that
//! the E0 fixture inventory classifies V (verbatim parity owed).
//!
//! Contracts mirrored exactly: alphabetical component registration is
//! the digest/save iteration order; commands carry absolute target
//! ticks, late submissions are rejected, drain order is (targetTick,
//! submission); entity ids ascend from 1 and are never reused; step()
//! increments the tick, drains due commands, then runs systems.
//! Deliberate divergences from TS in this slice, characterized:
//! - No path-scheduler tick-hold (E3b owns movement; TS holds the whole
//!   tick on a late path response — with no scheduler attached TS
//!   behaves exactly as here).
//! - No visibility/fog seam, inbox observers, or scenario/diplomacy
//!   slots yet (E4/E7/E14 attach those; observer seams are E7 replay
//!   work). None affect digested state in the m1 fixtures.
//! - Systems additionally carry a phase home (Planner → Main → Rare,
//!   build-sequence E1 note); default registration is Main, which
//!   reproduces TS flat registration order.
use std::collections::BTreeMap;

// ---------------------------------------------------------------- PRNG (SPEC §2.1)

pub fn splitmix32_stream(seed: u32) -> impl FnMut() -> u32 {
    let mut z = seed;
    move || {
        z = z.wrapping_add(0x9e37_79b9);
        let mut t = z ^ (z >> 16);
        t = t.wrapping_mul(0x21f0_aaad);
        t ^= t >> 15;
        t = t.wrapping_mul(0x735a_2d97);
        t ^ (t >> 15)
    }
}

pub const SFC32_WARMUP_ROUNDS: usize = 12;

#[derive(Clone, PartialEq, Debug)]
pub struct Sfc32 {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
}

impl Sfc32 {
    pub fn new_seeded(seed: u32) -> Self {
        let mut next = splitmix32_stream(seed);
        let mut prng = Sfc32 { a: next(), b: next(), c: next(), d: next() };
        for _ in 0..SFC32_WARMUP_ROUNDS {
            prng.next_u32();
        }
        prng
    }
    pub fn from_state(state: [u32; 4]) -> Self {
        Sfc32 { a: state[0], b: state[1], c: state[2], d: state[3] }
    }
    pub fn state(&self) -> [u32; 4] {
        [self.a, self.b, self.c, self.d]
    }
    pub fn next_u32(&mut self) -> u32 {
        let t = self.a.wrapping_add(self.b);
        let next_a = self.b ^ (self.b >> 9);
        let next_b = self.c.wrapping_add(self.c << 3);
        let rotated_c = self.c.rotate_left(21);
        let next_d = self.d.wrapping_add(1);
        let out = t.wrapping_add(next_d);
        self.a = next_a;
        self.b = next_b;
        self.c = rotated_c.wrapping_add(out);
        self.d = next_d;
        out
    }
    pub fn next_float(&mut self) -> f64 {
        self.next_u32() as f64 / 4_294_967_296.0
    }
}

// ---------------------------------------------------------------- Digest (SPEC §7)

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn format_digest(hash: u64) -> String {
    format!("fnv1a64:{hash:016x}")
}

fn append_f64(out: &mut Vec<u8>, value: f64) {
    assert!(value.is_finite() || value.is_nan(), "cannot digest non-finite float: {value}");
    let bits = if value.is_nan() { 0x7ff8_0000_0000_0000u64 } else { value.to_bits() };
    out.extend_from_slice(&bits.to_be_bytes());
}

/// Exact TS digest byte stream: components in the order given (callers
/// pass registry order), eids strictly ascending, one
/// `name:eid:<f64 BE bytes, comma-separated>\n` line per row.
pub fn digest_input_bytes(components: &[(&str, &[(i64, Vec<f64>)])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, rows) in components {
        let mut previous_eid = -1;
        for (eid, values) in *rows {
            assert!(
                *eid > previous_eid,
                "component {name:?}: eids must ascend strictly ({eid} after {previous_eid})"
            );
            previous_eid = *eid;
            out.extend_from_slice(format!("{name}:{eid}:").as_bytes());
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    out.push(0x2c);
                }
                append_f64(&mut out, *v);
            }
            out.push(0x0a);
        }
    }
    out
}

pub fn compute_digest(components: &[(&str, &[(i64, Vec<f64>)])]) -> String {
    format_digest(fnv1a64(&digest_input_bytes(components)))
}

// ---------------------------------------------------------------- Registry

#[derive(Default)]
pub struct Registry {
    names_by_id: Vec<String>,
}

impl Registry {
    pub fn new() -> Self {
        Registry { names_by_id: Vec::new() }
    }
    pub fn register(&mut self, name: &str) -> Result<usize, String> {
        if name.is_empty() {
            return Err("component name must be non-empty".into());
        }
        if self.names_by_id.iter().any(|n| n == name) {
            return Err(format!("component already registered: {name:?}"));
        }
        if let Some(previous) = self.names_by_id.last() {
            if !(previous.as_str() < name) {
                return Err(format!(
                    "components must be registered in ascending alphabetical order: {name:?} cannot follow {previous:?}"
                ));
            }
        }
        let id = self.names_by_id.len();
        self.names_by_id.push(name.to_string());
        Ok(id)
    }
    pub fn id_of(&self, name: &str) -> Result<usize, String> {
        self.names_by_id.iter().position(|n| n == name).ok_or_else(|| format!("unknown component: {name:?}"))
    }
    pub fn name_of(&self, id: usize) -> Result<&str, String> {
        self.names_by_id.get(id).map(|s| s.as_str()).ok_or_else(|| format!("unknown component id: {id}"))
    }
    pub fn size(&self) -> usize {
        self.names_by_id.len()
    }
    pub fn names_in_order(&self) -> Vec<String> {
        self.names_by_id.clone()
    }
}

// ---------------------------------------------------------------- Inbox

#[derive(Clone, PartialEq, Debug)]
pub struct Command {
    pub kind: String,
    pub target_tick: u64,
    pub data: Option<serde_json::Value>,
}

impl Command {
    pub fn num(&self, key: &str) -> Option<f64> {
        self.data.as_ref().and_then(|d| d.get(key)).and_then(|v| v.as_f64())
    }
}

struct Queued {
    seq: u64,
    command: Command,
}

#[derive(Default)]
pub struct Inbox {
    queue: Vec<Queued>,
    next_seq: u64,
    consumed_through: i64,
}

impl Inbox {
    pub fn new() -> Self {
        Inbox { queue: Vec::new(), next_seq: 0, consumed_through: -1 }
    }
    pub fn submit(&mut self, command: Command) -> Result<(), String> {
        if command.kind.is_empty() {
            return Err("command kind must be non-empty".into());
        }
        if command.target_tick as i64 <= self.consumed_through {
            return Err(format!(
                "late command: target tick {} is at or before the last consumed tick {}",
                command.target_tick, self.consumed_through
            ));
        }
        let entry = Queued { seq: self.next_seq, command };
        self.next_seq += 1;
        let mut index = self.queue.len();
        while index > 0 {
            let prev = &self.queue[index - 1];
            if prev.command.target_tick < entry.command.target_tick
                || (prev.command.target_tick == entry.command.target_tick && prev.seq < entry.seq)
            {
                break;
            }
            index -= 1;
        }
        self.queue.insert(index, entry);
        Ok(())
    }
    pub fn drain_due(&mut self, tick: u64) -> Vec<Command> {
        let mut due = Vec::new();
        while self.queue.first().map(|q| q.command.target_tick <= tick).unwrap_or(false) {
            due.push(self.queue.remove(0).command);
        }
        if tick as i64 > self.consumed_through {
            self.consumed_through = tick as i64;
        }
        due
    }
    pub fn consumed_through_tick(&self) -> i64 {
        self.consumed_through
    }
    pub fn size(&self) -> usize {
        self.queue.len()
    }
    pub fn pending_commands(&self) -> Vec<Command> {
        self.queue.iter().map(|q| q.command.clone()).collect()
    }
    pub fn restore_state(&mut self, tick: i64, commands: &[Command]) -> Result<(), String> {
        if tick < -1 {
            return Err(format!("consumed-through tick must be an integer ≥ -1, got {tick}"));
        }
        if !self.queue.is_empty() || self.consumed_through != -1 {
            return Err("restoreState on a non-fresh inbox".into());
        }
        self.consumed_through = tick;
        for command in commands {
            self.submit(command.clone())?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- World

pub const TICK_HZ: u32 = 30;
pub const DEFAULT_MAP_SIZE: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Phase {
    Planner = 0,
    Main = 1,
    Rare = 2,
}

pub type System = Box<dyn FnMut(&mut World, &[Command]) + Send>;

pub type Eid = i64;
pub type Rows = BTreeMap<Eid, Vec<f64>>;

pub struct World {
    pub seed: u32,
    pub prng: Sfc32,
    pub registry: Registry,
    pub inbox: Inbox,
    pub entities: Vec<Eid>,
    pub tick: u64,
    pub last_allocated_eid: Eid,
    systems: Vec<(Phase, System)>,
    pub rows_by_component: Vec<Rows>,
}

impl World {
    pub fn new(seed: u32) -> World {
        World {
            seed,
            prng: Sfc32::new_seeded(seed),
            registry: Registry::new(),
            inbox: Inbox::new(),
            entities: Vec::new(),
            tick: 0,
            last_allocated_eid: 0,
            systems: Vec::new(),
            rows_by_component: Vec::new(),
        }
    }
    pub fn define_component(&mut self, name: &str) -> Result<usize, String> {
        let id = self.registry.register(name)?;
        self.rows_by_component.push(Rows::new());
        Ok(id)
    }
    pub fn spawn(&mut self) -> Eid {
        let eid = self.last_allocated_eid + 1;
        self.last_allocated_eid = eid;
        self.entities.push(eid);
        eid
    }
    pub fn despawn(&mut self, eid: Eid) -> bool {
        let Some(index) = self.entities.iter().position(|&e| e == eid) else { return false };
        self.entities.remove(index);
        for rows in &mut self.rows_by_component {
            rows.remove(&eid);
        }
    true
    }
    pub fn set_values(&mut self, component: usize, eid: Eid, values: &[f64]) -> Result<(), String> {
        let rows = self.rows_by_component.get_mut(component).ok_or_else(|| format!("unregistered component id: {component}"))?;
        rows.insert(eid, values.to_vec());
        Ok(())
    }
    pub fn values(&self, component: usize, eid: Eid) -> Option<&[f64]> {
        self.rows_by_component.get(component).and_then(|r| r.get(&eid)).map(|v| v.as_slice())
    }
    pub fn values_mut(&mut self, component: usize, eid: Eid) -> Option<&mut Vec<f64>> {
        self.rows_by_component.get_mut(component).and_then(|r| r.get_mut(&eid))
    }
    pub fn remove_component(&mut self, component: usize, eid: Eid) -> bool {
        self.rows_by_component.get_mut(component).map(|r| r.remove(&eid).is_some()).unwrap_or(false)
    }
    pub fn register_system(&mut self, system: System) {
        self.register_system_in(Phase::Main, system);
    }
    pub fn register_system_in(&mut self, phase: Phase, system: System) {
        self.systems.push((phase, system));
    }
    pub fn step(&mut self) {
        self.tick += 1;
        let commands = self.inbox.drain_due(self.tick);
        // Systems are stored on the world but must run with &mut World:
        // take them out for the duration of the tick, run phases in
        // Planner → Main → Rare order (registration order within a
        // phase), then put them back.
        let mut systems = std::mem::take(&mut self.systems);
        for phase in [Phase::Planner, Phase::Main, Phase::Rare] {
            for (p, system) in systems.iter_mut() {
                if *p == phase {
                    system(self, &commands);
                }
            }
        }
        self.systems = systems;
    }
    pub fn compute_digest(&self) -> String {
        let names = self.registry.names_in_order();
        let owned: Vec<(String, Vec<(Eid, Vec<f64>)>)> = names
            .iter()
            .enumerate()
            .map(|(id, name)| {
                let rows: Vec<(Eid, Vec<f64>)> =
                    self.rows_by_component[id].iter().map(|(e, v)| (*e, v.clone())).collect();
                (name.clone(), rows)
            })
            .collect();
        let refs: Vec<(&str, &[(Eid, Vec<f64>)])> =
            owned.iter().map(|(n, r)| (n.as_str(), r.as_slice())).collect();
        compute_digest(&refs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_enforces_alphabetical_unique() {
        let mut r = Registry::new();
        assert_eq!(r.register("mass").unwrap(), 0);
        assert_eq!(r.register("position").unwrap(), 1);
        assert!(r.register("health").is_err(), "out of order must fail");
        assert!(r.register("mass").is_err(), "duplicate must fail");
        assert!(r.register("").is_err(), "empty must fail");
        assert_eq!(r.id_of("position").unwrap(), 1);
        assert!(r.id_of("velocity").is_err());
        assert_eq!(r.name_of(0).unwrap(), "mass");
        assert!(r.name_of(9).is_err());
        assert_eq!(r.names_in_order(), vec!["mass".to_string(), "position".to_string()]);
    }

    fn cmd(kind: &str, tick: u64) -> Command {
        Command { kind: kind.into(), target_tick: tick, data: None }
    }

    #[test]
    fn inbox_orders_by_target_then_submission_and_seals_past() {
        let mut inbox = Inbox::new();
        inbox.submit(cmd("c", 10)).unwrap();
        inbox.submit(cmd("a", 5)).unwrap();
        inbox.submit(cmd("b", 5)).unwrap();
        assert!(inbox.submit(cmd("", 9)).is_err());
        let due = inbox.drain_due(5);
        assert_eq!(due.iter().map(|c| c.kind.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(inbox.consumed_through_tick(), 5);
        assert!(inbox.submit(cmd("late", 5)).is_err(), "past tick sealed");
        assert!(inbox.submit(cmd("late", 3)).is_err());
        assert_eq!(inbox.pending_commands().len(), 1);
    }

    #[test]
    fn inbox_restore_round_trip() {
        let mut inbox = Inbox::new();
        inbox.submit(cmd("x", 7)).unwrap();
        let pending = inbox.pending_commands();
        let mut fresh = Inbox::new();
        fresh.restore_state(3, &pending).unwrap();
        assert_eq!(fresh.pending_commands(), pending);
        assert!(fresh.restore_state(3, &[]).is_err(), "non-fresh restore must fail");
        let mut bad = Inbox::new();
        assert!(bad.restore_state(9, &pending).is_err(), "pending before watermark must fail");
    }

    #[test]
    fn eids_ascend_and_never_reuse() {
        let mut w = World::new(1);
        let mass = w.define_component("mass").unwrap();
        let a = w.spawn();
        let b = w.spawn();
        w.set_values(mass, a, &[1.0]).unwrap();
        assert_eq!((a, b), (1, 2));
        assert!(w.despawn(a));
        assert!(!w.despawn(a));
        assert_eq!(w.spawn(), 3, "dead ids never return");
        assert_eq!(w.entities, vec![2, 3]);
        assert!(w.values(mass, a).is_none(), "despawn removes every row");
    }

    #[test]
    fn step_drains_then_runs_phases_in_order() {
        let mut w = World::new(7);
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        for (phase, name) in [(Phase::Rare, "rare"), (Phase::Main, "main2"), (Phase::Planner, "plan"), (Phase::Main, "main1-pre")] {
            let log = log.clone();
            let name = name.to_string();
            // main1-pre is registered last but in Main phase: order within
            // a phase is registration order, phases run Planner→Main→Rare.
            w.register_system_in(phase, Box::new(move |world, commands| {
                log.lock().unwrap().push(format!("{}@{}:{}", name, world.tick, commands.len()));
            }));
        }
        w.inbox.submit(cmd("ping", 2)).unwrap();
        w.step();
        w.step();
        let got = log.lock().unwrap().clone();
        assert_eq!(got[0], "plan@1:0");
        assert_eq!(got[1..3], ["main2@1:0".to_string(), "main1-pre@1:0".to_string()]);
        assert_eq!(got[3], "rare@1:0");
        assert_eq!(got[4], "plan@2:1", "commands visible on their target tick");
    }

    /// The m1t2 fixture scenario re-run through the new core World (not
    /// Shipyard): same digests as the TS snapshot and the parity.rs run.
    #[test]
    fn core_world_reproduces_m1t2_digests() {
        let mut w = World::new(20260821);
        let mass_id = w.define_component("mass").unwrap();
        let position_id = w.define_component("position").unwrap();
        for n in 0..10usize {
            let eid = w.spawn();
            w.set_values(mass_id, eid, &[1.0 + n as f64 * 0.25]).unwrap();
            w.set_values(position_id, eid, &[(n % 5) as f64 * 2.0 + 0.5, (n / 5) as f64 * 3.0 + 0.25]).unwrap();
        }
        let arrivals = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
        let arrivals2 = arrivals.clone();
        w.register_system(Box::new(move |world, commands| {
            for command in commands {
                assert_eq!(command.kind, "ping");
                let eid = command.num("eid").unwrap() as Eid;
                let amount = command.num("amount").unwrap();
                let row = world.values_mut(mass_id, eid).expect("ping row");
                row[0] += amount;
                arrivals2.lock().unwrap().push(world.tick);
            }
        }));
        w.register_system(Box::new(move |world, _commands| {
            let entities = world.entities.clone();
            for eid in entities {
                let dx = (world.prng.next_u32() as f64 / 4_294_967_296.0 - 0.5) * 0.01;
                let dy = (world.prng.next_float() - 0.5) * 0.01;
                let row = world.values_mut(position_id, eid).expect("position row");
                row[0] += dx;
                row[1] += dy;
            }
        }));
        for (tick, eid, amount) in [(5u64, 3.0, 10.0), (30, 7.0, -2.5), (31, 3.0, 0.125)] {
            w.inbox
                .submit(Command {
                    kind: "ping".into(),
                    target_tick: tick,
                    data: Some(serde_json::json!({ "eid": eid, "amount": amount })),
                })
                .unwrap();
        }
        let mut digests = Vec::new();
        for t in 1..=90u64 {
            w.step();
            if t % 30 == 0 {
                digests.push((t, w.compute_digest()));
            }
        }
        assert_eq!(
            digests,
            vec![
                (30, "fnv1a64:f831dd442da1ca60".to_string()),
                (60, "fnv1a64:06535a22228d7441".to_string()),
                (90, "fnv1a64:f5e7ce65a95fe1e3".to_string()),
            ]
        );
        assert_eq!(*arrivals.lock().unwrap(), vec![5, 30, 31]);
    }
}

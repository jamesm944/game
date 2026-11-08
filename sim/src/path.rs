//! Path pipeline (SPEC §2.2 / ADR-0003/0004): Rust port of
//! `src/sim/path/{astar,engine,protocol,scheduler}.ts` plus the test
//! mock transport from `tests/helpers/mock-path-worker.ts`.
//!
//! A* is canonical: integer costs (straight 1000, diagonal 1414),
//! octile heuristic, (f, insertionCounter) heap order, clockwise-from-
//! east neighbor expansion, no diagonal corner-cutting, greedy
//! string-pulling over an integer supercover LOS walk. Every operation
//! is integer or exact f64, so results are byte-identical to TS.
//!
//! The scheduler keeps the TS dueTick/blocking contract (responses
//! applied ascending-id once dueTick ≤ tick; a due-but-missing
//! response holds the tick). Continuations are data tags (`T`) the
//! caller interprets, where TS stored closures.
use crate::core::Sfc32;
use std::collections::BTreeMap;

pub const PATH_LATENCY: u64 = 2;
pub const PATH_STRAIGHT_COST: i64 = 1000;
pub const PATH_DIAGONAL_COST: i64 = 1414;
const NO_G_SCORE: i64 = 0x7fff_ffff;
const NEIGHBOR_DX: [i64; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const NEIGHBOR_DY: [i64; 8] = [0, 1, 1, 1, 0, -1, -1, -1];

#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub struct PathRequest {
    pub id: u64,
    pub due_tick: u64,
    pub start_x: i64,
    pub start_y: i64,
    pub goal_x: i64,
    pub goal_y: i64,
    pub passable: Vec<u8>,
    pub passable_version: u32,
    pub seed: u32,
}

#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub struct PathResponse {
    pub id: u64,
    pub ok: bool,
    pub waypoints: Vec<i16>,
    pub cost: i64,
}

pub struct FoundPath {
    pub waypoints: Vec<i16>,
    pub cost: i64,
}

pub fn octile_heuristic(ax: i64, ay: i64, bx: i64, by: i64) -> i64 {
    let dx = (ax - bx).abs();
    let dy = (ay - by).abs();
    PATH_STRAIGHT_COST * (dx + dy) + (PATH_DIAGONAL_COST - 2 * PATH_STRAIGHT_COST) * dx.min(dy)
}

fn require_grid(passability: &[u8], width: usize) -> Result<usize, String> {
    if width < 1 {
        return Err(format!("path grid width must be a positive integer, got {width}"));
    }
    if passability.is_empty() || passability.len() % width != 0 {
        return Err(format!(
            "passability length {} is not a multiple of width {width}",
            passability.len()
        ));
    }
    Ok(passability.len() / width)
}

fn require_coord(value: i64, label: &str, max: usize, dims: &str) -> Result<(), String> {
    if value < 0 || value >= max as i64 {
        return Err(format!("{label} out of range ({dims}): {value}"));
    }
    Ok(())
}

/// Supercover LOS walk, ported verbatim (including its diagonal-first
/// stepping): every touched tile must be passable, and diagonal steps
/// additionally require both orthogonal neighbors passable.
pub fn has_line_of_sight(
    passability: &[u8],
    width: usize,
    ax: i64,
    ay: i64,
    bx: i64,
    by: i64,
) -> Result<bool, String> {
    let height = require_grid(passability, width)?;
    let dims = format!("grid {width}×{height}");
    require_coord(ax, "ax", width, &dims)?;
    require_coord(ay, "ay", height, &dims)?;
    require_coord(bx, "bx", width, &dims)?;
    require_coord(by, "by", height, &dims)?;
    let wide = width as i64;
    let at = |x: i64, y: i64| passability[(y * wide + x) as usize];
    let (mut x, mut y) = (ax, ay);
    let dx = bx - x;
    let dy = by - y;
    let sx: i64 = if dx < 0 { -1 } else { 1 };
    let sy: i64 = if dy < 0 { -1 } else { 1 };
    let mut remaining_x = dx.abs();
    let mut remaining_y = dy.abs();
    loop {
        if at(x, y) != 1 {
            return Ok(false);
        }
        if x == bx && y == by {
            return Ok(true);
        }
        if remaining_x == 0 {
            y += sy;
            remaining_y -= 1;
            continue;
        }
        if remaining_y == 0 {
            x += sx;
            remaining_x -= 1;
            continue;
        }
        if at(x + sx, y) != 1 || at(x, y + sy) != 1 {
            return Ok(false);
        }
        x += sx;
        y += sy;
        remaining_x -= 1;
        remaining_y -= 1;
    }
}

fn string_pull(passability: &[u8], width: usize, raw: &[i64]) -> Result<Vec<i16>, String> {
    let mut anchors: Vec<i16> = Vec::new();
    let mut anchor_index = 0usize;
    anchors.push(raw[0] as i16);
    anchors.push(raw[1] as i16);
    while anchor_index < raw.len() / 2 - 1 {
        let mut next = anchor_index + 1;
        let mut probe = raw.len() / 2 - 1;
        while probe > next {
            if has_line_of_sight(
                passability,
                width,
                raw[anchor_index * 2],
                raw[anchor_index * 2 + 1],
                raw[probe * 2],
                raw[probe * 2 + 1],
            )? {
                next = probe;
                break;
            }
            probe -= 1;
        }
        anchors.push(raw[next * 2] as i16);
        anchors.push(raw[next * 2 + 1] as i16);
        anchor_index = next;
    }
    Ok(anchors)
}

/// One canonical octile A* search. `Ok(None)` = endpoints impassable
/// or no route exists (TS `null`). The per-request rng stream exists
/// for protocol uniformity and is intentionally never drawn.
pub fn find_path(
    passability: &[u8],
    width: usize,
    start_x: i64,
    start_y: i64,
    goal_x: i64,
    goal_y: i64,
    _rng: &mut Sfc32,
) -> Result<Option<FoundPath>, String> {
    let height = require_grid(passability, width)?;
    let dims = format!("grid {width}×{height}");
    require_coord(start_x, "startX", width, &dims)?;
    require_coord(start_y, "startY", height, &dims)?;
    require_coord(goal_x, "goalX", width, &dims)?;
    require_coord(goal_y, "goalY", height, &dims)?;
    let w = width as i64;
    let start_index = (start_y * w + start_x) as usize;
    let goal_index = (goal_y * w + goal_x) as usize;
    if passability[start_index] != 1 || passability[goal_index] != 1 {
        return Ok(None);
    }
    if start_index == goal_index {
        return Ok(Some(FoundPath { waypoints: vec![start_x as i16, start_y as i16], cost: 0 }));
    }
    let node_count = width * height;
    let mut g_score = vec![NO_G_SCORE; node_count];
    let mut parent = vec![-1i64; node_count];
    let mut closed = vec![false; node_count];
    // (f, insertionCounter) total order makes any correct binary heap
    // produce the TS pop sequence exactly.
    let mut heap: std::collections::BinaryHeap<std::cmp::Reverse<(i64, u64, usize)>> =
        std::collections::BinaryHeap::new();
    let mut insertion_counter = 0u64;
    g_score[start_index] = 0;
    heap.push(std::cmp::Reverse((
        octile_heuristic(start_x, start_y, goal_x, goal_y),
        insertion_counter,
        start_index,
    )));
    insertion_counter += 1;
    while let Some(std::cmp::Reverse((_, _, node))) = heap.pop() {
        if closed[node] {
            continue;
        }
        closed[node] = true;
        if node == goal_index {
            let mut nodes = Vec::new();
            let mut n = goal_index as i64;
            while n != -1 {
                nodes.push(n);
                n = parent[n as usize];
            }
            nodes.reverse();
            let mut raw: Vec<i64> = Vec::new();
            for n in nodes {
                raw.push(n % w);
                raw.push(n / w);
            }
            return Ok(Some(FoundPath {
                waypoints: string_pull(passability, width, &raw)?,
                cost: g_score[goal_index],
            }));
        }
        let nx = (node % width) as i64;
        let ny = (node / width) as i64;
        for dir in 0..8 {
            let mx = nx + NEIGHBOR_DX[dir];
            let my = ny + NEIGHBOR_DY[dir];
            if mx < 0 || mx >= w || my < 0 || my >= height as i64 {
                continue;
            }
            if passability[(my * w + mx) as usize] != 1 {
                continue;
            }
            let diagonal = NEIGHBOR_DX[dir] != 0 && NEIGHBOR_DY[dir] != 0;
            if diagonal
                && (passability[(ny * w + mx) as usize] != 1
                    || passability[(my * w + nx) as usize] != 1)
            {
                continue;
            }
            let step_cost = if diagonal { PATH_DIAGONAL_COST } else { PATH_STRAIGHT_COST };
            let tentative_g = g_score[node] + step_cost;
            let neighbor = (my * w + mx) as usize;
            if tentative_g < g_score[neighbor] {
                g_score[neighbor] = tentative_g;
                parent[neighbor] = node as i64;
                heap.push(std::cmp::Reverse((
                    tentative_g + octile_heuristic(mx, my, goal_x, goal_y),
                    insertion_counter,
                    neighbor,
                )));
                insertion_counter += 1;
            }
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------- Engine (LRU)

pub const PATH_CACHE_CAPACITY: usize = 32;

struct CachedPath {
    ok: bool,
    waypoints: Vec<i16>,
    cost: i64,
}

pub struct PathEngine {
    cache: Vec<(String, CachedPath)>, // front = least recently used
}

fn require_square_grid(bytes: &[u8]) -> Result<usize, String> {
    let width = (bytes.len() as f64).sqrt() as usize;
    if width < 1 || width * width != bytes.len() {
        return Err(format!("passable snapshot must be a square grid, got length {}", bytes.len()));
    }
    Ok(width)
}

impl PathEngine {
    pub fn new() -> Self {
        PathEngine { cache: Vec::new() }
    }
    pub fn cache_size(&self) -> usize {
        self.cache.len()
    }
    pub fn handle(&mut self, request: &PathRequest) -> Result<PathResponse, String> {
        let width = require_square_grid(&request.passable)?;
        let key = format!(
            "{}:{}:{}",
            request.passable_version,
            request.goal_y * width as i64 + request.goal_x,
            request.start_y * width as i64 + request.start_x
        );
        let cached_index = self.cache.iter().position(|(k, _)| *k == key);
        let cached = if let Some(index) = cached_index {
            let entry = self.cache.remove(index);
            self.cache.push(entry);
            &self.cache.last().unwrap().1
        } else {
            let mut rng = Sfc32::new_seeded(request.seed);
            let result = find_path(
                &request.passable,
                width,
                request.start_x,
                request.start_y,
                request.goal_x,
                request.goal_y,
                &mut rng,
            )?;
            let entry = match result {
                Some(found) => CachedPath { ok: true, waypoints: found.waypoints, cost: found.cost },
                None => CachedPath { ok: false, waypoints: Vec::new(), cost: 0 },
            };
            self.cache.push((key, entry));
            while self.cache.len() > PATH_CACHE_CAPACITY {
                self.cache.remove(0);
            }
            &self.cache.last().unwrap().1
        };
        Ok(PathResponse {
            id: request.id,
            ok: cached.ok,
            waypoints: cached.waypoints.clone(),
            cost: cached.cost,
        })
    }
}

impl Default for PathEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------- Transports

pub struct MockWorker {
    engine: PathEngine,
    delay_for: Box<dyn Fn(u64) -> u64 + Send>,
    frame: u64,
    in_flight: Vec<(PathRequest, u64)>,
    pub delivered_count: usize,
}

impl MockWorker {
    pub fn new(delay_for: impl Fn(u64) -> u64 + Send + 'static) -> Self {
        MockWorker {
            engine: PathEngine::new(),
            delay_for: Box::new(delay_for),
            frame: 0,
            in_flight: Vec::new(),
            delivered_count: 0,
        }
    }
    fn send(&mut self, request: PathRequest) {
        let delay = (self.delay_for)(request.id);
        let deliver_at = self.frame + delay + 1;
        self.in_flight.push((request, deliver_at));
    }
    pub fn advance_frame(&mut self) -> Vec<PathResponse> {
        self.frame += 1;
        let mut delivered = Vec::new();
        let mut index = 0;
        while index < self.in_flight.len() {
            if self.in_flight[index].1 > self.frame {
                index += 1;
                continue;
            }
            let (request, _) = self.in_flight.remove(index);
            let response = self.engine.handle(&request).expect("mock engine handle");
            self.delivered_count += 1;
            delivered.push(response);
        }
        delivered
    }
}

pub enum Transport {
    Sync(PathEngine),
    Mock(MockWorker),
}

impl Transport {
    pub fn synchronous() -> Self {
        Transport::Sync(PathEngine::new())
    }
    fn send(&mut self, request: PathRequest) -> Option<PathResponse> {
        match self {
            Transport::Sync(engine) => Some(engine.handle(&request).expect("sync engine handle")),
            Transport::Mock(worker) => {
                worker.send(request);
                None
            }
        }
    }
}

// ---------------------------------------------------------------- Scheduler

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Outstanding<T> {
    due_tick: u64,
    passable_version: u32,
    tag: T,
    discard_tag: Option<T>,
}

/// Serializable scheduler state (E7 saves). The transport itself is
/// not captured: only the synchronous engine round-trips (its path
/// cache is derived data and rebuilds empty).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SchedulerSnapshot<T> {
    pub(crate) next_id: u64,
    pub(crate) next_apply_id: u64,
    pub(crate) outstanding: Vec<(u64, Outstanding<T>)>,
    pub(crate) buffered: Vec<(u64, PathResponse)>,
    pub(crate) blocked_ticks: u64,
    pub(crate) passability_version: u32,
}

pub enum PumpEvent<T> {
    Apply(T, PathResponse),
    Discard(T),
}

/// Events applied by one pump, in order, plus whether the tick must
/// be held (next-in-order response due but missing). TS applies the
/// available prefix inline, then holds — callers apply `events` first
/// and do not advance the tick when `blocked` is true.
pub struct PumpOutcome<T> {
    pub events: Vec<PumpEvent<T>>,
    pub blocked: bool,
}

pub struct PathRequestInput {
    pub start_x: i64,
    pub start_y: i64,
    pub goal_x: i64,
    pub goal_y: i64,
}

pub struct PathScheduler<T> {
    transport: Transport,
    next_id: u64,
    next_apply_id: u64,
    outstanding: BTreeMap<u64, Outstanding<T>>,
    buffered: BTreeMap<u64, PathResponse>,
    blocked_ticks: u64,
    passability_version: u32,
}

impl<T> PathScheduler<T> {
    pub fn new(transport: Transport) -> Self {
        PathScheduler {
            transport,
            next_id: 0,
            next_apply_id: 1,
            outstanding: BTreeMap::new(),
            buffered: BTreeMap::new(),
            blocked_ticks: 0,
            passability_version: 0,
        }
    }
    pub fn transport_mut(&mut self) -> &mut Transport {
        &mut self.transport
    }
    /// True when paths resolve in-tick (the only saveable transport).
    pub fn is_synchronous(&self) -> bool {
        matches!(self.transport, Transport::Sync(_))
    }
    /// Capture scheduler state for a save file (E7).
    pub fn snapshot(&self) -> SchedulerSnapshot<T>
    where
        T: Clone,
    {
        SchedulerSnapshot {
            next_id: self.next_id,
            next_apply_id: self.next_apply_id,
            outstanding: self.outstanding.iter().map(|(k, v)| (*k, v.clone())).collect(),
            buffered: self.buffered.iter().map(|(k, v)| (*k, v.clone())).collect(),
            blocked_ticks: self.blocked_ticks,
            passability_version: self.passability_version,
        }
    }
    /// Rebuild a scheduler from a save snapshot over `transport`.
    pub fn restore(snapshot: SchedulerSnapshot<T>, transport: Transport) -> Self {
        PathScheduler {
            transport,
            next_id: snapshot.next_id,
            next_apply_id: snapshot.next_apply_id,
            outstanding: snapshot.outstanding.into_iter().collect(),
            buffered: snapshot.buffered.into_iter().collect(),
            blocked_ticks: snapshot.blocked_ticks,
            passability_version: snapshot.passability_version,
        }
    }
    pub fn passability_version(&self) -> u32 {
        self.passability_version
    }
    pub fn set_passability_version(&mut self, version: u32) -> Result<(), String> {
        if version < self.passability_version {
            return Err("passability versions must be monotonically increasing".into());
        }
        self.passability_version = version;
        Ok(())
    }
    pub fn blocked_ticks(&self) -> u64 {
        self.blocked_ticks
    }
    pub fn pending_count(&self) -> usize {
        self.outstanding.len()
    }
    pub fn request_path(
        &mut self,
        input: &PathRequestInput,
        issue_tick: u64,
        seed: u32,
        passability: &[u8],
        tag: T,
        discard_tag: Option<T>,
    ) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let entry = Outstanding {
            due_tick: issue_tick + PATH_LATENCY,
            passable_version: self.passability_version,
            tag,
            discard_tag,
        };
        let request = PathRequest {
            id,
            due_tick: entry.due_tick,
            start_x: input.start_x,
            start_y: input.start_y,
            goal_x: input.goal_x,
            goal_y: input.goal_y,
            passable: passability.to_vec(),
            passable_version: entry.passable_version,
            seed,
        };
        self.outstanding.insert(id, entry);
        if let Some(response) = self.transport.send(request) {
            self.receive(response);
        }
        id
    }
    pub fn receive(&mut self, response: PathResponse) {
        if !self.outstanding.contains_key(&response.id) {
            return;
        }
        self.buffered.entry(response.id).or_insert(response);
    }
    pub fn pump(&mut self, current_tick: u64) -> PumpOutcome<T> {
        let mut events = Vec::new();
        loop {
            let Some(entry) = self.outstanding.get(&self.next_apply_id) else {
                return PumpOutcome { events, blocked: false };
            };
            if entry.due_tick > current_tick {
                return PumpOutcome { events, blocked: false };
            }
            let id = self.next_apply_id;
            let Some(response) = self.buffered.remove(&id) else {
                self.blocked_ticks += 1;
                return PumpOutcome { events, blocked: true };
            };
            let entry = self.outstanding.remove(&id).unwrap();
            self.next_apply_id += 1;
            if entry.passable_version == self.passability_version {
                events.push(PumpEvent::Apply(entry.tag, response));
            } else if let Some(discard) = entry.discard_tag {
                events.push(PumpEvent::Discard(discard));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(width: usize, blocked: &[(i64, i64)]) -> Vec<u8> {
        let mut g = vec![1u8; width * width];
        for &(x, y) in blocked {
            g[(y as usize) * width + x as usize] = 0;
        }
        g
    }

    #[test]
    fn astar_straight_and_diagonal_costs() {
        let g = grid(5, &[]);
        let mut rng = Sfc32::new_seeded(1);
        let found = find_path(&g, 5, 0, 0, 4, 0, &mut rng).unwrap().unwrap();
        assert_eq!(found.cost, 4000);
        assert_eq!(found.waypoints, vec![0, 0, 4, 0]);
        let found = find_path(&g, 5, 0, 0, 3, 3, &mut rng).unwrap().unwrap();
        assert_eq!(found.cost, 3 * PATH_DIAGONAL_COST);
        assert_eq!(found.waypoints, vec![0, 0, 3, 3]);
        assert_eq!(find_path(&g, 5, 2, 2, 2, 2, &mut rng).unwrap().unwrap().cost, 0);
    }

    #[test]
    fn astar_no_corner_cutting_and_unreachable() {
        // Diagonal squeeze between two blocked orthogonals is forbidden.
        let g = grid(3, &[(1, 0), (0, 1)]);
        let mut rng = Sfc32::new_seeded(1);
        assert!(find_path(&g, 3, 0, 0, 2, 2, &mut rng).unwrap().is_none());
        let walled = grid(5, &[(2, 0), (2, 1), (2, 2), (2, 3), (2, 4)]);
        assert!(find_path(&walled, 5, 0, 2, 4, 2, &mut rng).unwrap().is_none());
        assert!(find_path(&walled, 5, 2, 2, 4, 2, &mut rng).unwrap().is_none(), "impassable start");
    }

    #[test]
    fn scheduler_due_ordering_and_blocking() {
        let mut scheduler: PathScheduler<u32> = PathScheduler::new(Transport::Mock(MockWorker::new(|id| (id - 1) % 3)));
        let pass = vec![1u8; 25];
        for tag in 0..3u32 {
            scheduler.request_path(
                &PathRequestInput { start_x: 0, start_y: 0, goal_x: 4, goal_y: 0 },
                10,
                1,
                &pass,
                tag,
                None,
            );
        }
        // Nothing due before tick 12 (issue 10 + latency 2): not blocked.
        let early = scheduler.pump(11);
        assert!(early.events.is_empty() && !early.blocked);
        // At due tick with undelivered first response: blocked, counted.
        assert!(scheduler.pump(12).blocked);
        assert_eq!(scheduler.blocked_ticks(), 1);
        // Deliver frames until all applied; applications ascend by id.
        let mut applied = Vec::new();
        for _ in 0..10 {
            let delivered = match scheduler.transport_mut() {
                Transport::Mock(w) => w.advance_frame(),
                _ => unreachable!(),
            };
            for r in delivered {
                scheduler.receive(r);
            }
            for event in scheduler.pump(12).events {
                if let PumpEvent::Apply(tag, _) = event {
                    applied.push(tag);
                }
            }
            if applied.len() == 3 {
                break;
            }
        }
        assert_eq!(applied, vec![0, 1, 2]);
    }

    #[test]
    fn engine_cache_is_result_invisible() {
        let mut engine = PathEngine::new();
        let req = PathRequest {
            id: 1,
            due_tick: 2,
            start_x: 0,
            start_y: 0,
            goal_x: 4,
            goal_y: 4,
            passable: vec![1u8; 25],
            passable_version: 0,
            seed: 9,
        };
        let first = engine.handle(&req).unwrap();
        let second = engine.handle(&req).unwrap();
        assert_eq!(first, second);
        assert_eq!(engine.cache_size(), 1);
    }
}

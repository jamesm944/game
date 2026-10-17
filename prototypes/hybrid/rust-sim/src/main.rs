//! THROWAWAY deterministic parallel movement/economy slice, not a full RTS port.
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
struct Pop {
    id: u32,
    x: i32,
    z: i32,
    tx: i32,
    tz: i32,
    food: i32,
    rest: i32,
    morale: i32,
    wealth: i64,
    carried: i32,
    deliveries: u32,
    manual: bool,
}
#[derive(Deserialize, Clone)]
struct Command {
    kind: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    x: i32,
    #[serde(default)]
    z: i32,
}
struct World {
    pops: Vec<Pop>,
    tick: u64,
    stock: i64,
    ack: u64,
    paused: bool,
}
#[derive(Serialize)]
struct Snapshot<'a> {
    schema: &'static str,
    tick: u64,
    pops: &'a [Pop],
    stock: i64,
    ack: u64,
    paused: bool,
    digest: String,
    workers: usize,
    threads_observed: usize,
    sim_ms: f64,
}
fn init(n: usize) -> World {
    World {
        pops: (0..n)
            .map(|i| {
                let id = i as u32;
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
                }
            })
            .collect(),
        tick: 0,
        stock: 0,
        ack: 0,
        paused: false,
    }
}
fn apply(w: &mut World, c: &Command) {
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
        }
        q.morale = (q.morale + if q.food > 9000 { 1 } else { -1 }).clamp(0, 10000);
    }
    (q, deposit)
}
fn advance(w: &mut World, pool: &rayon::ThreadPool, parallel: bool) -> usize {
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
    ids.len()
}
fn digest(w: &World) -> String {
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
        ] {
            add(n);
        }
    }
    format!("{h:016x}")
}
fn snapshot(w: &World, workers: usize, observed: usize, ms: f64) -> String {
    serde_json::to_string(&Snapshot {
        schema: "hybrid-v1",
        tick: w.tick,
        pops: &w.pops,
        stock: w.stock,
        ack: w.ack,
        paused: w.paused,
        digest: digest(w),
        workers,
        threads_observed: observed,
        sim_ms: ms,
    })
    .unwrap()
}
fn scripted(w: &mut World) {
    if w.tick == 40 {
        apply(
            w,
            &Command {
                kind: "move".into(),
                seq: 1,
                x: -10000,
                z: 12000,
            },
        );
    }
    if w.tick == 90 {
        apply(
            w,
            &Command {
                kind: "work".into(),
                seq: 2,
                x: 0,
                z: 0,
            },
        );
    }
}
fn bench() {
    let counts = [500, 2000, 10000];
    for n in counts {
        let mut reference = String::new();
        for workers in [1, 2, 4, 8] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .build()
                .unwrap();
            for parallel in if workers == 1 {
                vec![false, true]
            } else {
                vec![true]
            } {
                let mut w = init(n);
                let mut times = Vec::new();
                let mut max_observed = 0;
                for _ in 0..360 {
                    scripted(&mut w);
                    let start = Instant::now();
                    let observed = advance(&mut w, &pool, parallel);
                    let ms = start.elapsed().as_secs_f64() * 1000.;
                    if w.tick > 60 {
                        times.push(ms);
                    }
                    max_observed = max_observed.max(observed);
                }
                times.sort_by(|a, b| a.total_cmp(b));
                let d = digest(&w);
                if reference.is_empty() {
                    reference = d.clone();
                }
                assert_eq!(reference, d, "thread-count parity failed");
                println!(
                    "{}",
                    serde_json::json!({"pops":n,"workers":workers,"parallel":parallel,"ticks":w.tick,"p50_ms":times[times.len()/2],"p95_ms":times[(times.len()*95)/100],"max_threads_observed":max_observed,"digest":d,"parity":true,"workload":"prototype integer movement+needs+deliveries, not full RTS"})
                );
            }
        }
    }
}
fn serve(n: usize, workers: usize) {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .unwrap();
    let mut w = init(n);
    let shared = Arc::new(Mutex::new(snapshot(&w, workers, 0, 0.)));
    let peers = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
    let (send, recv) = mpsc::channel::<Command>();
    let peer_accept = peers.clone();
    let tcp_commands = send.clone();
    thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:4188").expect("TCP port4188 busy");
        for socket in listener.incoming().flatten() {
            socket
                .set_write_timeout(Some(Duration::from_millis(15)))
                .ok();
            socket.set_nodelay(true).ok();
            let read = socket.try_clone().unwrap();
            peer_accept.lock().unwrap().push(socket);
            let tx = tcp_commands.clone();
            thread::spawn(move || {
                for line in BufReader::new(read).lines().map_while(Result::ok) {
                    if let Ok(cmd) = serde_json::from_str::<Command>(&line) {
                        if tx.send(cmd).is_err() {
                            break;
                        }
                    }
                }
            });
        }
    });
    let http_state = shared.clone();
    thread::spawn(move || {
        let server = tiny_http::Server::http("127.0.0.1:4189").expect("HTTP port4189 busy");
        for mut req in server.incoming_requests() {
            let response = if req.method() == &tiny_http::Method::Post && req.url() == "/command" {
                let mut body = String::new();
                req.as_reader().take(4096).read_to_string(&mut body).ok();
                if let Ok(c) = serde_json::from_str::<Command>(&body) {
                    send.send(c).ok();
                    tiny_http::Response::from_string("{\"queued\":true}")
                } else {
                    tiny_http::Response::from_string("{\"error\":\"invalid_command\"}")
                        .with_status_code(400)
                }
            } else {
                tiny_http::Response::from_string(http_state.lock().unwrap().clone())
            };
            req.respond(
                response
                    .with_header(
                        tiny_http::Header::from_bytes(
                            "Access-Control-Allow-Origin",
                            "http://127.0.0.1:5188",
                        )
                        .unwrap(),
                    )
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                    ),
            )
            .ok();
        }
    });
    println!("hybrid-v1 TCP 127.0.0.1:4188 HTTP 127.0.0.1:4189 pops={n} workers={workers}");
    loop {
        let start = Instant::now();
        for c in recv.try_iter() {
            apply(&mut w, &c);
        }
        let observed = advance(&mut w, &pool, true);
        let sim_ms = start.elapsed().as_secs_f64() * 1000.;
        let frame = snapshot(&w, workers, observed, sim_ms);
        *shared.lock().unwrap() = frame.clone();
        let mut line = frame;
        line.push('\n');
        peers
            .lock()
            .unwrap()
            .retain_mut(|s| s.write_all(line.as_bytes()).is_ok());
        thread::sleep(Duration::from_millis(33).saturating_sub(start.elapsed()));
    }
}
fn trace_parallel() {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .unwrap();
    let mut world = init(100000);
    world.tick = 1;
    pool.broadcast(|_| {});
    let origin = Instant::now();
    let batches=pool.install(||world.pops.par_chunks(64).enumerate().map(|(chunk,pops)| {
        let start=origin.elapsed().as_nanos() as u64;
        let values=pops.iter().map(|p|next_pop(p,1)).collect::<Vec<_>>();
        let end=origin.elapsed().as_nanos() as u64;
        (values,serde_json::json!({"chunk":chunk,"worker":rayon::current_thread_index().unwrap(),"start_ns":start,"end_ns":end}))
    }).collect::<Vec<_>>());
    let mut spans = Vec::new();
    let mut events = Vec::new();
    let mut next = Vec::new();
    for (values, span) in batches {
        events.push((span["start_ns"].as_u64().unwrap(), 1i32));
        events.push((span["end_ns"].as_u64().unwrap(), -1i32));
        spans.push(span);
        for (p, deposit) in values {
            next.push(p);
            world.stock += deposit;
        }
    }
    world.pops = next;
    events.sort_unstable();
    let mut active = 0;
    let mut maximum = 0;
    for (_, delta) in events {
        active += delta;
        maximum = maximum.max(active);
    }
    let mut serial = init(100000);
    advance(&mut serial, &pool, false);
    assert_eq!(digest(&world), digest(&serial));
    println!(
        "{}",
        serde_json::json!({"workload":"instrumented single movement/economy tick; separate from benchmark timings","pops":100000,"workers":4,"max_simultaneous_chunks":maximum,"digest":digest(&world),"serial_parity":true,"spans":spans})
    );
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|s| s == "trace") {
        trace_parallel();
        return;
    }
    if args.get(1).is_some_and(|s| s == "bench") {
        bench();
        return;
    }
    let n = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(500);
    let workers = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    serve(n, workers);
}

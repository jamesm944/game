//! Sim server: deterministic tick loop, loopback TCP stream (4188) +
//! HTTP snapshot/command/save/load (4189). Unity owns this process (ADR-0012).
use ageofwind_sim::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

enum Control {
    Cmd(Command),
    Load(Box<World>),
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    // `game [seed] [size]` serves the real EconomySim skirmish (E5a,
    // #201); anything else keeps the skeleton demo world.
    if args.get(1).map(|a| a == "game").unwrap_or(false) {
        let seed: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20260903);
        let size: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(120);
        run_game(seed, size);
        return;
    }
    run_skeleton(&args);
}

fn run_game(seed: u32, size: usize) {
    use ageofwind_sim::game_server::GameServer;
    let mut server = GameServer::new_skirmish(seed, size).expect("skirmish setup");
    let shared = Arc::new(Mutex::new(server.snapshot_json()));
    let map_shared = Arc::new(Mutex::new(server.map_json()));
    let peers = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
    let (send, recv) = mpsc::channel::<String>();

    let peer_accept = peers.clone();
    let tcp_send = send.clone();
    thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:4188").expect("TCP 4188 busy");
        for socket in listener.incoming().flatten() {
            socket.set_write_timeout(Some(Duration::from_millis(15))).ok();
            socket.set_nodelay(true).ok();
            let read = socket.try_clone().unwrap();
            peer_accept.lock().unwrap().push(socket);
            let tx = tcp_send.clone();
            thread::spawn(move || {
                for line in BufReader::new(read).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() { break; }
                }
            });
        }
    });

    let http_state = shared.clone();
    let http_map = map_shared.clone();
    thread::spawn(move || {
        let server = tiny_http::Server::http("127.0.0.1:4189").expect("HTTP 4189 busy");
        for mut req in server.incoming_requests() {
            let post = req.method() == &tiny_http::Method::Post;
            let response = match (post, req.url()) {
                (true, "/command") => {
                    let mut body = String::new();
                    req.as_reader().take(16384).read_to_string(&mut body).ok();
                    match serde_json::from_str::<serde_json::Value>(&body) {
                        Ok(_) => { send.send(body).ok(); tiny_http::Response::from_string("{\"queued\":true}") }
                        Err(_) => tiny_http::Response::from_string("{\"error\":\"invalid_command\"}").with_status_code(400),
                    }
                }
                (false, "/map") => tiny_http::Response::from_string(http_map.lock().unwrap().clone()),
                // Save/load for the real game is E7 (#204); fail loudly
                // instead of pretending the skeleton format applies.
                (_, "/save") | (_, "/load") => tiny_http::Response::from_string(
                    "{\"error\":\"game_save_load_lands_in_E7\"}",
                ).with_status_code(501),
                _ => tiny_http::Response::from_string(http_state.lock().unwrap().clone()),
            };
            req.respond(
                response
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                    .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
            ).ok();
        }
    });

    println!("ageofwind-game-v1 TCP 127.0.0.1:4188 HTTP 127.0.0.1:4189 seed={seed} size={size}");
    loop {
        let start = Instant::now();
        for line in recv.try_iter() {
            if let Err(e) = server.submit_json(&line) {
                eprintln!("command rejected: {e}");
            }
        }
        server.step();
        let frame = server.snapshot_json();
        *shared.lock().unwrap() = frame.clone();
        let mut line = frame;
        line.push('\n');
        peers.lock().unwrap().retain_mut(|s| s.write_all(line.as_bytes()).is_ok());
        thread::sleep(Duration::from_millis(33).saturating_sub(start.elapsed()));
    }
}

fn run_skeleton(args: &[String]) {
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(300);
    let workers: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(workers).build().unwrap();
    let mut w = init(n);
    let shared = Arc::new(Mutex::new(snapshot(&w, workers, 0, 0.)));
    let save_shared = Arc::new(Mutex::new(w.save_json()));
    let peers = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
    let (send, recv) = mpsc::channel::<Control>();

    let peer_accept = peers.clone();
    let tcp_send = send.clone();
    thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:4188").expect("TCP 4188 busy");
        for socket in listener.incoming().flatten() {
            socket.set_write_timeout(Some(Duration::from_millis(15))).ok();
            socket.set_nodelay(true).ok();
            let read = socket.try_clone().unwrap();
            peer_accept.lock().unwrap().push(socket);
            let tx = tcp_send.clone();
            thread::spawn(move || {
                for line in BufReader::new(read).lines().map_while(Result::ok) {
                    if let Ok(cmd) = serde_json::from_str::<Command>(&line) {
                        if tx.send(Control::Cmd(cmd)).is_err() { break; }
                    }
                }
            });
        }
    });

    let http_state = shared.clone();
    let http_save = save_shared.clone();
    thread::spawn(move || {
        let server = tiny_http::Server::http("127.0.0.1:4189").expect("HTTP 4189 busy");
        for mut req in server.incoming_requests() {
            let post = req.method() == &tiny_http::Method::Post;
            let response = match (post, req.url()) {
                (true, "/command") => {
                    let mut body = String::new();
                    req.as_reader().take(4096).read_to_string(&mut body).ok();
                    match serde_json::from_str::<Command>(&body) {
                        Ok(c) => { send.send(Control::Cmd(c)).ok(); tiny_http::Response::from_string("{\"queued\":true}") }
                        Err(_) => tiny_http::Response::from_string("{\"error\":\"invalid_command\"}").with_status_code(400),
                    }
                }
                (true, "/load") => {
                    let mut body = String::new();
                    req.as_reader().take(16 * 1024 * 1024).read_to_string(&mut body).ok();
                    match World::load_json(&body) {
                        Ok(world) => { send.send(Control::Load(Box::new(world))).ok(); tiny_http::Response::from_string("{\"loaded\":true}") }
                        Err(e) => tiny_http::Response::from_string(format!("{{\"error\":{e:?}}}")).with_status_code(400),
                    }
                }
                (false, "/save") => tiny_http::Response::from_string(http_save.lock().unwrap().clone()),
                _ => tiny_http::Response::from_string(http_state.lock().unwrap().clone()),
            };
            req.respond(
                response
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                    .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
            ).ok();
        }
    });

    println!("ageofwind-sim-v1 TCP 127.0.0.1:4188 HTTP 127.0.0.1:4189 pops={n} workers={workers}");
    loop {
        let start = Instant::now();
        for c in recv.try_iter() {
            match c {
                Control::Cmd(cmd) => apply(&mut w, &cmd),
                Control::Load(world) => w = *world,
            }
        }
        let observed = advance(&mut w, &pool, true);
        let sim_ms = start.elapsed().as_secs_f64() * 1000.;
        let frame = snapshot(&w, workers, observed, sim_ms);
        *shared.lock().unwrap() = frame.clone();
        *save_shared.lock().unwrap() = w.save_json();
        let mut line = frame;
        line.push('\n');
        peers.lock().unwrap().retain_mut(|s| s.write_all(line.as_bytes()).is_ok());
        thread::sleep(Duration::from_millis(33).saturating_sub(start.elapsed()));
    }
}

//! Parity + worker-spike CLI for ticket #187.
//!
//! Usage:
//!   parity <case.json> [--snapshot golden.test.ts.snap]
//!          [--entities N] [--ticks N] [--workers 1,2,4,8] [--out report.json]
//!
//! Runs the scenario once sequentially and once per worker count
//! (parallel apply inside a rayon pool of that size), reports milestone
//! digests, command arrivals, digest equality across runs, and per-tick
//! timing stats. With --snapshot, milestone digests are compared against
//! the `fnv1a64:...` values recorded in the vitest snapshot, in order.
use ageofwind_sim::parity::{run_scenario, Case};
use serde::Serialize;

#[derive(Serialize)]
struct RunReport {
    mode: String,
    workers: usize,
    digests: Vec<(u64, String)>,
    arrivals: Vec<u64>,
    tick_ms_mean: f64,
    tick_ms_p50: f64,
    tick_ms_p99: f64,
    tick_ms_max: f64,
    total_ms: f64,
}

#[derive(Serialize)]
struct Report {
    case_name: String,
    entities: usize,
    ticks: u64,
    snapshot_expected: Option<Vec<String>>,
    snapshot_match: Option<bool>,
    all_runs_digest_equal: bool,
    runs: Vec<RunReport>,
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

fn summarize(mode: &str, workers: usize, run: ageofwind_sim::parity::ParityRun) -> RunReport {
    let mut sorted = run.tick_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let total: f64 = run.tick_ms.iter().sum();
    RunReport {
        mode: mode.into(),
        workers,
        digests: run.digests,
        arrivals: run.arrivals,
        tick_ms_mean: total / run.tick_ms.len().max(1) as f64,
        tick_ms_p50: percentile(&sorted, 0.50),
        tick_ms_p99: percentile(&sorted, 0.99),
        tick_ms_max: *sorted.last().unwrap_or(&0.0),
        total_ms: total,
    }
}

fn parse_snapshot_digests(text: &str) -> Vec<String> {
    // Machine-format scan of the vitest snapshot for SPEC §7 digests.
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let needle = b"fnv1a64:";
    let mut i = 0;
    while i + needle.len() + 16 <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let hex = &text[i + needle.len()..i + needle.len() + 16];
            if hex.chars().all(|c| c.is_ascii_hexdigit()) {
                out.push(format!("fnv1a64:{hex}"));
                i += needle.len() + 16;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut case_path: Option<String> = None;
    let mut snapshot_path: Option<String> = None;
    let mut out_path: Option<String> = None;
    let mut entities: Option<usize> = None;
    let mut ticks: Option<u64> = None;
    let mut workers: Vec<usize> = vec![1, 2, 4, 8];
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--snapshot" => {
                i += 1;
                snapshot_path = args.get(i).cloned();
            }
            "--out" => {
                i += 1;
                out_path = args.get(i).cloned();
            }
            "--entities" => {
                i += 1;
                entities = args.get(i).and_then(|s| s.parse().ok());
            }
            "--ticks" => {
                i += 1;
                ticks = args.get(i).and_then(|s| s.parse().ok());
            }
            "--workers" => {
                i += 1;
                if let Some(s) = args.get(i) {
                    workers = s.split(',').filter_map(|p| p.parse().ok()).collect();
                }
            }
            other if !other.starts_with("--") && case_path.is_none() => case_path = Some(other.into()),
            other => eprintln!("ignoring arg: {other}"),
        }
        i += 1;
    }
    let case_path = case_path.expect("usage: parity <case.json> [--snapshot path] [--entities N] [--ticks N] [--workers 1,2,4,8] [--out path]");
    let text = std::fs::read_to_string(&case_path).expect("read case.json");
    let mut case = Case::from_json(&text).expect("parse case");
    if let Some(n) = entities {
        case.entity_count = n;
    }
    if let Some(t) = ticks {
        case.ticks = t;
    }

    let mut runs = vec![summarize("sequential", 0, run_scenario(&case, false))];
    for w in &workers {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(*w).build().expect("rayon pool");
        let run = pool.install(|| run_scenario(&case, true));
        runs.push(summarize("parallel-apply", *w, run));
    }
    let all_equal = runs.windows(2).all(|p| p[0].digests == p[1].digests);
    let expected = snapshot_path
        .as_ref()
        .map(|p| parse_snapshot_digests(&std::fs::read_to_string(p).expect("read snapshot")));
    let snapshot_match = expected.as_ref().map(|exp| {
        let got: Vec<&String> = runs[0].digests.iter().map(|(_, d)| d).collect();
        got.len() == exp.len() && got.iter().zip(exp).all(|(g, e)| *g == e)
    });
    let report = Report {
        case_name: case.name.clone(),
        entities: case.entity_count,
        ticks: case.ticks,
        snapshot_expected: expected,
        snapshot_match,
        all_runs_digest_equal: all_equal,
        runs,
    };
    let json = serde_json::to_string_pretty(&report).unwrap();
    println!("{json}");
    if let Some(path) = out_path {
        std::fs::write(path, &json).expect("write report");
    }
    let ok = report.all_runs_digest_equal && report.snapshot_match.unwrap_or(true);
    std::process::exit(if ok { 0 } else { 1 });
}

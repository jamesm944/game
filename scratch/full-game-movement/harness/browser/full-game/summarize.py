#!/usr/bin/env python3
"""Summarize asynchronous full-game real-worker raw JSON only."""
import json
import math
from collections import Counter
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"


def percentile(values, fraction):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1] if values else None


def stats(values):
    return {
        "count": len(values),
        "min": min(values) if values else None,
        "mean": sum(values) / len(values) if values else None,
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
    }


def category(request):
    if request.get("commandTick") == 1:
        return "initialLeader"
    if "commandTick" in request:
        return "laterLeader"
    return "individualRepath"


def request_summary(requests):
    response = [r["issueToResponseMs"] for r in requests if "issueToResponseMs" in r]
    apply = [r["applyCostMs"] for r in requests if "applyCostMs" in r]
    apply_ticks = [r["issueToApplyTicks"] for r in requests if "issueToApplyTicks" in r]
    apply_by_tick = {}
    for request in requests:
        if "applyCostMs" in request:
            apply_by_tick[request["applyTick"]] = apply_by_tick.get(request["applyTick"], 0) + request["applyCostMs"]
    apply_per_tick = list(apply_by_tick.values())
    return {
        "requests": len(requests),
        "outcomes": dict(Counter(r["outcome"] for r in requests)),
        "issueToResponseWallMs": stats(response),
        "productionPathApplyMs": stats(apply),
        "productionPathApplyPerActiveTickMs": stats(apply_per_tick),
        "issueToApplyTicks": stats(apply_ticks),
        "snapshotPayloadBytes": sum(r["snapshotBytes"] for r in requests),
        "responseP95Exceeds33_3ms": percentile(response, 0.95) > 33.3 if response else None,
        "applyP95Exceeds2ms": percentile(apply, 0.95) > 2 if apply else None,
        "applyPerTickP95Exceeds2ms": percentile(apply_per_tick, 0.95) > 2 if apply_per_tick else None,
    }


def sample_summary(sample):
    requests = sample["pathRequests"]
    groups = {"all": requests}
    for name in ("initialLeader", "laterLeader", "individualRepath"):
        groups[name] = [request for request in requests if category(request) == name]
    return {
        "finalTick": sample["finalTick"],
        "frames": sample["frames"],
        "wallClockMs": sample["wallClockMs"],
        "finalFullStateHash": sample["finalFullStateHash"],
        "completionOutcomes": dict(Counter(c["outcome"] for c in sample["completions"])),
        "crowdStates": sample["crowdStates"],
        "movementDiagnostics": sample["movementDiagnostics"],
        "scheduler": sample["scheduler"],
        "timing": sample["timing"],
        "mutations": sample["mutations"],
        "candidateMetrics": sample["candidateMetrics"],
        "requests": {name: request_summary(values) for name, values in groups.items()},
    }


runs = []
for path in sorted(RESULTS.glob("chrome-*.json")):
    if path.name.endswith("-error.json") or "smoke" in path.name:
        continue
    raw = json.loads(path.read_text())
    if raw.get("schema") != "wayfinder-browser-full-game-v1":
        continue
    assert raw["repeatLogicalResultsEqual"] and raw["repeatFullStateHashesEqual"]
    samples = raw["samples"]
    assert len(samples) == raw["measuredRuns"]
    summaries = [sample_summary(sample) for sample in samples]
    pooled_requests = [request for sample in samples for request in sample["pathRequests"]]
    pooled = {"all": request_summary(pooled_requests)}
    for name in ("initialLeader", "laterLeader", "individualRepath"):
        pooled[name] = request_summary([request for request in pooled_requests if category(request) == name])
    for sample in samples:
        assert sample["finalTick"] == sample["requestedTicks"]
        assert sample["evidenceClass"] == "browser-worker"
        assert all(request["applyTick"] >= request["dueTick"] for request in sample["pathRequests"] if "applyTick" in request)
    runs.append({
        "file": path.name,
        "browser": raw["browser"],
        "browserVersion": raw["browserVersion"],
        "host": raw["host"],
        "candidate": raw["candidate"],
        "scenario": raw["scenario"],
        "population": raw["population"],
        "requestedTicks": raw["requestedTicks"],
        "warmupRuns": raw["warmupRuns"],
        "measuredRuns": raw["measuredRuns"],
        "warmups": raw["warmups"],
        "repeatLogicalResultsEqual": raw["repeatLogicalResultsEqual"],
        "repeatFullStateHashesEqual": raw["repeatFullStateHashesEqual"],
        "samples": summaries,
        "pooledRequests": pooled,
    })

document = {
    "schema": "wayfinder-browser-full-game-summary-v1",
    "evidenceScope": "asynchronous-full-game-world-step-real-worker",
    "runs": runs,
    "firefoxWebkitSafariX64Measured": False,
}
(RESULTS / "summary.json").write_text(json.dumps(document, indent=2) + "\n")
print(json.dumps({"runs": [{"file": run["file"], "samples": len(run["samples"]), "requests": run["pooledRequests"]["all"]["requests"]} for run in runs]}, indent=2))

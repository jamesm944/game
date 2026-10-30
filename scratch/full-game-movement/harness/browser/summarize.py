#!/usr/bin/env python3
"""Summarize only real-browser direct-load artifacts in this directory."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"


def percentile(values, fraction):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1] if values else None


def stats(values):
    return {
        "count": len(values),
        "min": min(values) if values else None,
        "mean": sum(values) / len(values) if values else None,
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
    }


def pooled(samples, key):
    return [request[key] for sample in samples for request in sample["pathRequests"] if key in request]


runs = []
for path in sorted(RESULTS.glob("*.json")):
    if path.name in {"summary.json"} or path.name.endswith("-availability.json") or path.name.endswith("-error.json"):
        continue
    run = json.loads(path.read_text())
    if run.get("schema") != "wayfinder-browser-direct-worker-load-v1":
        continue
    samples = run["samples"]
    assert run["evidenceClass"] == "browser-worker"
    assert run["repeatLogicalHashesEqual"]
    assert run["ascendingApplicationOrder"]
    assert len(samples) == run["measuredRuns"]
    response = pooled(samples, "issueToResponseMs")
    apply = pooled(samples, "applyCostMs")
    apply_ticks = pooled(samples, "issueToApplyTicks")
    assert len(response) == len(apply) == run["population"] * len(samples)
    for sample in samples:
        assert sample["scheduler"]["finalQueueDepth"] == 0
        assert sample["appliedOrder"] == list(range(1, run["population"] + 1))
        assert all(request["applyTick"] >= request["dueTick"] for request in sample["pathRequests"])
    runs.append({
        "file": path.name,
        "browser": run["browser"],
        "browserVersion": run["browserVersion"],
        "host": run["host"],
        "candidate": run["candidate"],
        "scenario": run["scenario"],
        "population": run["population"],
        "pattern": run["pattern"],
        "warmupRuns": run["warmupRuns"],
        "measuredRuns": run["measuredRuns"],
        "repeatLogicalHashesEqual": run["repeatLogicalHashesEqual"],
        "logicalRouteHashes": [sample["logicalRouteHash"] for sample in samples],
        "issueToResponseWallMsPooled": stats(response),
        "pathApplyMainThreadMsPooled": stats(apply),
        "issueToApplyTicksPooled": stats(apply_ticks),
        "responseP95Exceeds33_3ms": percentile(response, 0.95) > 33.3,
        "applyP95Exceeds2ms": percentile(apply, 0.95) > 2,
        "sampleWallClockMs": [sample["wallClockMs"] for sample in samples],
        "sampleResponseP95Ms": [sample["timing"]["issueToResponseWallMs"]["p95"] for sample in samples],
        "sampleApplyP95Ms": [sample["timing"]["pathApplyMainThreadMs"]["p95"] for sample in samples],
        "blockedTicksPerSample": [sample["scheduler"]["blockedTicks"] for sample in samples],
        "framesPerSample": [sample["frames"] for sample in samples],
        "finalTickPerSample": [sample["finalTick"] for sample in samples],
        "maxQueueDepth": max(sample["scheduler"]["maxQueueDepth"] for sample in samples),
        "meanQueueDepthAcrossSamples": sum(sample["scheduler"]["meanQueueDepth"] for sample in samples) / len(samples),
        "snapshotPayloadBytesPerSample": [sample["timing"]["snapshotPayloadBytes"] for sample in samples],
        "responseWaypointBytesPerSample": [sample["responseWaypointBytes"] for sample in samples],
    })

availability = []
for path in sorted(RESULTS.glob("*-availability.json")):
    value = json.loads(path.read_text())
    availability.append({"file": path.name, **value})

document = {
    "schema": "wayfinder-browser-direct-worker-summary-v1",
    "evidenceScope": "direct-real-worker-load-not-full-game-world-step",
    "runs": runs,
    "availability": availability,
    "crossBrowserDeterminismClaimed": False,
    "crossArchitectureDeterminismClaimed": False,
}
(RESULTS / "summary.json").write_text(json.dumps(document, indent=2) + "\n")
print(json.dumps({"summarizedRuns": len(runs), "availability": [{"browser": a["browser"], "available": a["available"], "version": a.get("version")} for a in availability]}, indent=2))

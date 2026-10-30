#!/usr/bin/env python3
"""Pair preserved A* and Recast raw runs without cross-architecture hash assertions."""
import json
import math
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS_RESULTS = HERE.parent / "harness" / "results"
RESULTS = HERE / "results"
SCENARIOS = (
    "dense-open-120",
    "opposing-open-120",
    "mixed-destinations-120",
    "narrow-mutation-120",
)


def load(path):
    return json.loads(path.read_text())


def percentile(values, fraction):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1] if values else None


def stats(values):
    return {
        "count": len(values),
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
    }


def completion_count(run, outcome="completed"):
    return sum(entry["outcome"] == outcome for entry in run["completions"])


def summarize(run):
    apply_ticks = [p["issueToApplyTicks"] for p in run["pathRequests"] if "issueToApplyTicks" in p]
    response_ms = [p["issueToResponseMs"] for p in run["pathRequests"] if "issueToResponseMs" in p]
    apply_ms = [p["applyCostMs"] for p in run["pathRequests"] if "applyCostMs" in p]
    completion_ticks = [c["completionTick"] for c in run["completions"] if "completionTick" in c]
    return {
        "candidate": run["candidate"],
        "evidenceClass": run["evidenceClass"],
        "wallClockMs": run["wallClockMs"],
        "completionOutcomes": dict(Counter(c["outcome"] for c in run["completions"])),
        "completionTicks": stats(completion_ticks),
        "crowdStates": run["crowdStates"],
        "pathRequests": len(run["pathRequests"]),
        "pathOutcomes": dict(Counter(p["outcome"] for p in run["pathRequests"])),
        "issueToApplyTicks": stats(apply_ticks),
        "issueToResponseMsNonBrowser": stats(response_ms),
        "pathApplyCostMs": stats(apply_ms),
        "timing": run["timing"],
        "scheduler": run["scheduler"],
        "movementDiagnostics": run["movementDiagnostics"],
        "mutations": run["mutations"],
        "candidateMetrics": run["candidateMetrics"],
        "finalFullStateHash": run["finalFullStateHash"],
    }


comparisons = []
for scenario in SCENARIOS:
    stem = f"{scenario}-p1000"
    astar = load(HARNESS_RESULTS / f"{stem}-sync.json")
    recast = load(RESULTS / f"{stem}-recast.json")
    for run in (astar, recast):
        assert run["scenario"] == astar["scenario"]
        assert run["scenario"]["name"] == scenario
        assert run["population"] == 1000
        assert run["finalTick"] == run["requestedTicks"] == 3600
        assert run["evidenceClass"] == "node-inline"
        assert run["initialMapHash"] == astar["initialMapHash"]
        assert run["finalMapHash"] == astar["finalMapHash"]
    comparisons.append({
        "scenario": scenario,
        "population": 1000,
        "finalTick": 3600,
        "astar": summarize(astar),
        "recast": summarize(recast),
        "recastMinusAstar": {
            "completed": completion_count(recast) - completion_count(astar),
            "activeAtCutoff": completion_count(recast, "active-at-cutoff")
                - completion_count(astar, "active-at-cutoff"),
            "repaths": recast["movementDiagnostics"]["repaths"] - astar["movementDiagnostics"]["repaths"],
            "pathRequests": len(recast["pathRequests"]) - len(astar["pathRequests"]),
            "wallClockMs": recast["wallClockMs"] - astar["wallClockMs"],
            "wallClockRatio": recast["wallClockMs"] / astar["wallClockMs"],
            "meanTickMs": recast["timing"]["meanTickMs"] - astar["timing"]["meanTickMs"],
            "p95TickMs": recast["timing"]["p95TickMs"] - astar["timing"]["p95TickMs"],
        },
        "crossArchitectureHashEqualityRequired": False,
    })

prefix = "narrow-mutation-120-p100-t600-recast-"
a, b, mock = (load(RESULTS / (prefix + suffix + ".json")) for suffix in ("a", "b", "mock"))
for run in (a, b, mock):
    assert run["scenario"] == a["scenario"]
    assert run["scenario"]["name"] == "narrow-mutation-120"
    assert run["population"] == 100
    assert run["finalTick"] == run["requestedTicks"] == 600
assert a["evidenceClass"] == b["evidenceClass"] == "node-inline"
assert mock["evidenceClass"] == "node-mock-transport"


def logical(run):
    def committed_path(path):
        normalized = {key: path.get(key) for key in ("id", "issueTick", "applyTick", "outcome", "ok", "passableVersion")}
        # A response still in flight at the cutoff has not affected committed
        # state. Inline delivery may know `ok` while the mock has not delivered it.
        if path["outcome"] == "pending":
            normalized["ok"] = None
        return normalized

    return {
        key: run[key]
        for key in ("milestones", "completions", "units", "crowdStates", "movementDiagnostics")
    } | {
        "paths": [committed_path(path) for path in run["pathRequests"]]
    }


repeat_equal = logical(a) == logical(b)
mock_equal = logical(a) == logical(mock)
hashes = [run["finalFullStateHash"] for run in (a, b, mock)]
assert repeat_equal and mock_equal
assert len(set(hashes)) == 1
determinism = {
    "scope": "same-host-node-inline-and-scripted-node-mock-transport",
    "repeatEqual": repeat_equal,
    "delayedOutOfOrderMockEqual": mock_equal,
    "finalFullStateHash": hashes[0],
    "inlineFrames": a["frames"],
    "mockFrames": mock["frames"],
    "mockBlockedTicks": mock["scheduler"]["blockedTicks"],
    "pathRequestsPerRun": [len(run["pathRequests"]) for run in (a, b, mock)],
    "repathsPerRun": [run["movementDiagnostics"]["repaths"] for run in (a, b, mock)],
    "crossArchitectureHashEqualityRequired": False,
    "browserOrCrossCpuEvidence": False,
}

comparison_document = {
    "evidenceClass": "node-inline-single-run-per-large-configuration",
    "rawResultsUnmodified": True,
    "comparisons": comparisons,
    "unmeasured": [
        {"scenario": "dense-open-120", "population": 2000, "candidate": "recast-detour-0.43.0-full-rebuild"},
        {"scenario": "opposing-open-120", "population": 2000, "candidate": "recast-detour-0.43.0-full-rebuild"},
        {"scenario": "mixed-destinations-120", "population": 2000, "candidate": "recast-detour-0.43.0-full-rebuild"},
        {"scenario": "narrow-mutation-120", "population": 2000, "candidate": "recast-detour-0.43.0-full-rebuild"},
    ],
}
(RESULTS / "recast-comparison.json").write_text(json.dumps(comparison_document, indent=2) + "\n")
(RESULTS / "recast-determinism.json").write_text(json.dumps(determinism, indent=2) + "\n")
print(json.dumps({
    "pairs": len(comparisons),
    "deltas": [{"scenario": row["scenario"], **row["recastMinusAstar"]} for row in comparisons],
    "determinism": determinism,
    "unmeasured": comparison_document["unmeasured"],
}, indent=2))

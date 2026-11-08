#!/usr/bin/env python3
"""Pair existing A* and flow-field raw runs; never mutate either raw result."""
import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
SCENARIOS = (
    "dense-open-120",
    "opposing-open-120",
    "mixed-destinations-120",
    "narrow-mutation-120",
)


def load(name):
    return json.loads((RESULTS / name).read_text())


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


def completion_count(run):
    return sum(entry["outcome"] == "completed" for entry in run["completions"])


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
    astar = load(f"{stem}-sync.json")
    flow = load(f"{stem}-flow.json")
    for run in (astar, flow):
        assert run["scenario"]["name"] == scenario
        assert run["population"] == 1000
        assert run["finalTick"] == run["requestedTicks"] == 3600
        assert run["evidenceClass"] == "node-inline"
    comparisons.append({
        "scenario": scenario,
        "population": 1000,
        "finalTick": 3600,
        "astar": summarize(astar),
        "flow": summarize(flow),
        "flowMinusAstar": {
            "completed": completion_count(flow) - completion_count(astar),
            "activeAtCutoff": sum(c["outcome"] == "active-at-cutoff" for c in flow["completions"])
                - sum(c["outcome"] == "active-at-cutoff" for c in astar["completions"]),
            "repaths": flow["movementDiagnostics"]["repaths"] - astar["movementDiagnostics"]["repaths"],
            "pathRequests": len(flow["pathRequests"]) - len(astar["pathRequests"]),
            "wallClockMs": flow["wallClockMs"] - astar["wallClockMs"],
            "wallClockRatio": flow["wallClockMs"] / astar["wallClockMs"],
            "meanTickMs": flow["timing"]["meanTickMs"] - astar["timing"]["meanTickMs"],
            "p95TickMs": flow["timing"]["p95TickMs"] - astar["timing"]["p95TickMs"],
        },
    })

prefix = "narrow-mutation-120-p100-t600-flow-"
a, b, mock = (load(prefix + suffix + ".json") for suffix in ("a", "b", "mock"))
for run in (a, b, mock):
    assert run["scenario"]["name"] == "narrow-mutation-120"
    assert run["population"] == 100
    assert run["finalTick"] == run["requestedTicks"] == 600
assert a["evidenceClass"] == b["evidenceClass"] == "node-inline"
assert mock["evidenceClass"] == "node-mock-transport"


def logical(run):
    return {
        key: run[key]
        for key in ("milestones", "completions", "units", "crowdStates", "movementDiagnostics")
    } | {
        "paths": [
            {key: path.get(key) for key in ("id", "issueTick", "applyTick", "outcome", "ok", "passableVersion")}
            for path in run["pathRequests"]
        ]
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
}

comparison_document = {
    "evidenceClass": "node-inline-single-run-per-large-configuration",
    "rawResultsUnmodified": True,
    "comparisons": comparisons,
    "unmeasured": [{"scenario": "dense-open-120", "population": 2000, "candidate": "flow-field-shared-destination"}],
}
(RESULTS / "flow-field-comparison.json").write_text(json.dumps(comparison_document, indent=2) + "\n")
(RESULTS / "flow-field-determinism.json").write_text(json.dumps(determinism, indent=2) + "\n")
print(json.dumps({
    "pairs": len(comparisons),
    "determinism": determinism,
    "unmeasured": comparison_document["unmeasured"],
}, indent=2))

#!/usr/bin/env python3
"""Derive shared-corridor comparisons without modifying any raw run."""
import json
import math
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
BASELINE = HERE.parents[1] / "full-game-movement" / "harness" / "results"
SCENARIOS = ("dense-open-120", "mixed-destinations-120", "narrow-mutation-120")


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


def completed(run):
    return sum(entry["outcome"] == "completed" for entry in run["completions"])


def summarize(run):
    apply_ticks = [p["issueToApplyTicks"] for p in run["pathRequests"] if "issueToApplyTicks" in p]
    response_ms = [p["issueToResponseMs"] for p in run["pathRequests"] if "issueToResponseMs" in p]
    apply_ms = [p["applyCostMs"] for p in run["pathRequests"] if "applyCostMs" in p]
    return {
        "candidate": run["candidate"],
        "wallClockMs": run["wallClockMs"],
        "completionOutcomes": dict(Counter(c["outcome"] for c in run["completions"])),
        "crowdStates": run["crowdStates"],
        "pathRequests": len(run["pathRequests"]),
        "pathOutcomes": dict(Counter(p["outcome"] for p in run["pathRequests"])),
        "issueToApplyTicks": stats(apply_ticks),
        "issueToResponseMsNonBrowser": stats(response_ms),
        "pathApplyCostMs": stats(apply_ms),
        "totalPathComputeMs": sum(p.get("computeMs", 0) for p in run["pathRequests"]),
        "timing": run["timing"],
        "scheduler": run["scheduler"],
        "movementDiagnostics": run["movementDiagnostics"],
        "mutations": run["mutations"],
        "candidateMetrics": run["candidateMetrics"],
        "finalFullStateHash": run["finalFullStateHash"],
    }


def delta(candidate, control):
    return {
        "completed": completed(candidate) - completed(control),
        "repaths": candidate["movementDiagnostics"]["repaths"] - control["movementDiagnostics"]["repaths"],
        "pathRequests": len(candidate["pathRequests"]) - len(control["pathRequests"]),
        "wallClockMs": candidate["wallClockMs"] - control["wallClockMs"],
        "wallClockRatio": candidate["wallClockMs"] / control["wallClockMs"],
        "meanTickMs": candidate["timing"]["meanTickMs"] - control["timing"]["meanTickMs"],
        "p95TickMs": candidate["timing"]["p95TickMs"] - control["timing"]["p95TickMs"],
        "sameFinalFullStateHash": candidate["finalFullStateHash"] == control["finalFullStateHash"],
    }


comparisons = []
for scenario in SCENARIOS:
    astar = load(BASELINE / f"{scenario}-p1000-sync.json")
    old_flow = load(BASELINE / f"{scenario}-p1000-flow.json")
    shared = load(RESULTS / f"{scenario}-p1000-t3600-shared-flow.json")
    for run in (astar, old_flow, shared):
        assert run["scenario"]["name"] == scenario
        assert run["population"] == 1000
        assert run["finalTick"] == run["requestedTicks"] == 3600
        assert run["evidenceClass"] == "node-inline"
    comparisons.append({
        "scenario": scenario,
        "population": 1000,
        "finalTick": 3600,
        "astar": summarize(astar),
        "oldFlow": summarize(old_flow),
        "sharedCorridor": summarize(shared),
        "sharedMinusAstar": delta(shared, astar),
        "sharedMinusOldFlow": delta(shared, old_flow),
        "fieldBuildReductionVsOldFlow": 1 - shared["candidateMetrics"]["fieldsBuilt"] / old_flow["candidateMetrics"]["fieldsBuilt"],
    })

def logical(run):
    return {
        key: run[key]
        for key in ("milestones", "completions", "units", "crowdStates", "movementDiagnostics")
    } | {
        "paths": [
            {
                key: path.get(key)
                for key in ("id", "issueTick", "applyTick", "outcome", "ok", "passableVersion")
                # An undelivered future-due pending request has no logical ok
                # value yet; its id/outcome/snapshot identity is still compared.
                if key != "ok" or path["outcome"] != "pending"
            }
            for path in run["pathRequests"]
        ]
    }


replay_a = load(RESULTS / "narrow-mutation-120-p100-t600-replay-a.json")
replay_b = load(RESULTS / "narrow-mutation-120-p100-t600-replay-b.json")
replay_mock = load(RESULTS / "narrow-mutation-120-p100-t600-replay-mock.json")
repeat_equal = logical(replay_a) == logical(replay_b)
delayed_equal = logical(replay_a) == logical(replay_mock)
hashes = {run["finalFullStateHash"] for run in (replay_a, replay_b, replay_mock)}
assert repeat_equal and delayed_equal and len(hashes) == 1

output = {
    "schemaVersion": 1,
    "evidenceClass": "node-inline-one-large-run-per-candidate-using-preserved-controls",
    "rawResultsUnmodified": True,
    "comparisons": comparisons,
    "replayDeterminism": {
        "scenario": "narrow-mutation-120",
        "population": 100,
        "committedTicks": 600,
        "repeatEqual": repeat_equal,
        "delayedOutOfOrderEqual": delayed_equal,
        "finalFullStateHash": replay_a["finalFullStateHash"],
        "inlineFrames": replay_a["frames"],
        "mockFrames": replay_mock["frames"],
        "mockBlockedTicks": replay_mock["scheduler"]["blockedTicks"],
    },
    "unmeasured": [{"population": 2000, "reason": "1000-unit shared-corridor wall time exceeded preserved A* on all three traces"}],
}
path = RESULTS / "shared-corridor-comparison.json"
path.write_text(json.dumps(output, indent=2) + "\n")
for row in comparisons:
    shared = row["sharedCorridor"]
    metrics = shared["candidateMetrics"]
    print(json.dumps({
        "scenario": row["scenario"],
        "wallRatioVsAstar": row["sharedMinusAstar"]["wallClockRatio"],
        "completedDeltaVsAstar": row["sharedMinusAstar"]["completed"],
        "sameAstarHash": row["sharedMinusAstar"]["sameFinalFullStateHash"],
        "builds": metrics["fieldsBuilt"],
        "buildReductionVsOldFlow": row["fieldBuildReductionVsOldFlow"],
        "hitRate": metrics["cacheHitRate"],
        "localSearchMs": metrics["totalLocalSearchMs"],
        "fieldBuildMs": metrics["totalFieldBuildMs"],
        "fallbacks": metrics["directFallbacks"],
    }))
print(path)

#!/usr/bin/env python3
"""Validate and compare dense 2,000 runs; never rewrite raw benchmark results."""
import json
import math
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HARNESS = ROOT / "scratch/full-game-movement/harness/results"
RECAST = HERE / "results"
OUT = RECAST / "scaling-2000-comparison.json"
POPULATION = 2000
TICKS = 3600


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


def outcomes(run):
    return dict(Counter(entry["outcome"] for entry in run["completions"]))


def completed(run):
    return outcomes(run).get("completed", 0)


def validate_run(run, population, expected_candidate):
    assert run["schemaVersion"] == 1
    assert run["scenario"]["name"] == "dense-open-120"
    assert run["scenario"]["size"] == 120
    assert run["scenario"]["ticks"] == TICKS
    assert run["candidate"] == expected_candidate
    assert run["evidenceClass"] == "node-inline"
    assert run["population"] == population
    assert run["requestedTicks"] == run["finalTick"] == TICKS
    assert run["frames"] == TICKS
    assert len(run["completions"]) == len(run["units"]) == population
    assert len({unit["eid"] for unit in run["units"]}) == population
    assert sum(outcomes(run).values()) == population
    assert sum(run["crowdStates"].values()) == population
    assert all("completionTick" in entry for entry in run["completions"] if entry["outcome"] == "completed")
    assert run["movementDiagnostics"]["groupMoves"] == 1
    assert run["scheduler"]["blockedTicks"] == 0
    assert run["scheduler"]["maxQueueDepth"] <= population
    for key in ("meanTickMs", "p95TickMs", "maxTickMs", "totalApplyCostMs", "maxApplyCostMs"):
        assert isinstance(run["timing"][key], (int, float)) and math.isfinite(run["timing"][key])
        assert run["timing"][key] >= 0
    ids = [path["id"] for path in run["pathRequests"]]
    assert len(ids) == len(set(ids))
    assert all(path["snapshotBytes"] == 120 * 120 for path in run["pathRequests"])
    assert all(path["issueToApplyTicks"] == 2 for path in run["pathRequests"] if path["outcome"] == "applied")
    assert re.fullmatch(r"fnv1a64:[0-9a-f]{16}", run["finalWorldDigest"])
    assert re.fullmatch(r"[0-9a-f]{64}", run["finalFullStateHash"])
    assert re.fullmatch(r"fnv1a64:[0-9a-f]{16}", run["initialMapHash"])
    assert re.fullmatch(r"fnv1a64:[0-9a-f]{16}", run["finalMapHash"])


def summarize(run):
    completion_ticks = [c["completionTick"] for c in run["completions"] if "completionTick" in c]
    apply_ticks = [p["issueToApplyTicks"] for p in run["pathRequests"] if "issueToApplyTicks" in p]
    response_ms = [p["issueToResponseMs"] for p in run["pathRequests"] if "issueToResponseMs" in p]
    apply_ms = [p["applyCostMs"] for p in run["pathRequests"] if "applyCostMs" in p]
    return {
        "candidate": run["candidate"],
        "evidenceClass": run["evidenceClass"],
        "population": run["population"],
        "finalTick": run["finalTick"],
        "frames": run["frames"],
        "wallClockMs": run["wallClockMs"],
        "completionOutcomes": outcomes(run),
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
        "candidateMetrics": run["candidateMetrics"],
        "initialMapHash": run["initialMapHash"],
        "finalMapHash": run["finalMapHash"],
        "finalWorldDigest": run["finalWorldDigest"],
        "finalFullStateHash": run["finalFullStateHash"],
    }


def scaling(small, large):
    return {
        "populationRatio": large["population"] / small["population"],
        "wallClockRatio": large["wallClockMs"] / small["wallClockMs"],
        "meanTickRatio": large["timing"]["meanTickMs"] / small["timing"]["meanTickMs"],
        "p95TickRatio": large["timing"]["p95TickMs"] / small["timing"]["p95TickMs"],
        "completedDelta": completed(large) - completed(small),
        "completedRatio": completed(large) / completed(small),
        "activeAtCutoffDelta": outcomes(large).get("active-at-cutoff", 0) - outcomes(small).get("active-at-cutoff", 0),
        "pathRequestsRatio": len(large["pathRequests"]) / len(small["pathRequests"]),
        "repathsRatio": large["movementDiagnostics"]["repaths"] / small["movementDiagnostics"]["repaths"],
    }


paths = {
    "astar": {
        1000: HARNESS / "dense-open-120-p1000-sync.json",
        2000: HARNESS / "dense-open-120-p2000-sync.json",
    },
    "flow": {
        1000: HARNESS / "dense-open-120-p1000-flow.json",
        2000: HARNESS / "dense-open-120-p2000-flow.json",
    },
    "recast": {
        1000: RECAST / "dense-open-120-p1000-recast.json",
        2000: RECAST / "dense-open-120-p2000-recast.json",
    },
}
candidates = {
    "astar": "current-integer-astar",
    "flow": "flow-field-shared-destination",
    "recast": "recast-detour-0.43.0-full-rebuild",
}
runs = {}
for candidate, by_population in paths.items():
    runs[candidate] = {}
    for population, path in by_population.items():
        if path.exists():
            run = load(path)
            validate_run(run, population, candidates[candidate])
            runs[candidate][population] = run

assert set(runs["astar"]) == {1000, 2000}
assert set(runs["recast"]) == {1000, 2000}
assert set(runs["flow"]) == {1000}  # The 2,000 attempt has a separate timeout record.
reference = runs["astar"][2000]
for candidate in ("flow", "recast"):
    for run in runs[candidate].values():
        assert run["scenario"] == reference["scenario"]
        assert run["initialMapHash"] == reference["initialMapHash"]
        assert run["finalMapHash"] == reference["finalMapHash"]

metrics = runs["recast"][2000]["candidateMetrics"]
assert metrics["crowdAgentsCreated"] == metrics["dynamicObstacleAdds"] == 0
assert metrics["revisionBuilds"] == 1
for key in (
    "revisionCacheCapacityFailures", "snapshotMismatches", "navmeshGenerationFailures",
    "pathCapacityFailures", "unreachableRoutes", "partialPathsRejected",
    "endpointProjectionsRejected", "geometryRejections", "nativeQueryFailures",
    "obstacleCapacityFailures", "tileCacheUpdateFailures", "agentCapacityFailures",
):
    assert metrics[key] == 0

flow_failure_path = RECAST / "dense-open-120-p2000-flow-timeout.json"
flow_failure = load(flow_failure_path)
assert flow_failure["kind"] == "run-failure"
assert flow_failure["scenario"] == "dense-open-120"
assert flow_failure["population"] == 2000
assert flow_failure["requestedTicks"] == 3600
assert flow_failure["executionTimeoutSeconds"] == 300
assert flow_failure["runnerRawResultWritten"] is False
assert flow_failure["processRemainingAfterKill"] is False
assert not paths["flow"][2000].exists()

summaries = {
    candidate: {str(population): summarize(run) for population, run in sorted(by_population.items())}
    for candidate, by_population in runs.items()
}
recast_delta = {
    "completed": completed(runs["recast"][2000]) - completed(reference),
    "activeAtCutoff": outcomes(runs["recast"][2000]).get("active-at-cutoff", 0) - outcomes(reference).get("active-at-cutoff", 0),
    "repaths": runs["recast"][2000]["movementDiagnostics"]["repaths"] - reference["movementDiagnostics"]["repaths"],
    "pathRequests": len(runs["recast"][2000]["pathRequests"]) - len(reference["pathRequests"]),
    "wallClockMs": runs["recast"][2000]["wallClockMs"] - reference["wallClockMs"],
    "wallClockRatio": runs["recast"][2000]["wallClockMs"] / reference["wallClockMs"],
    "meanTickMs": runs["recast"][2000]["timing"]["meanTickMs"] - reference["timing"]["meanTickMs"],
    "p95TickMs": runs["recast"][2000]["timing"]["p95TickMs"] - reference["timing"]["p95TickMs"],
}
document = {
    "schemaVersion": 1,
    "scope": "dense-open-120-node-inline-single-run-per-completed-configuration",
    "statisticallyRobustTimingDistribution": False,
    "rawResultsUnmodified": True,
    "crossArchitectureHashEqualityRequired": False,
    "runs": summaries,
    "recastMinusAstar2000": recast_delta,
    "observedScaling1000To2000": {
        "astar": scaling(runs["astar"][1000], reference),
        "recast": scaling(runs["recast"][1000], runs["recast"][2000]),
        "flow": None,
    },
    "flow2000Failure": flow_failure,
    "unmeasured": [{
        "scenario": "dense-open-120",
        "population": 2000,
        "candidate": candidates["flow"],
        "reason": "Execution killed at 300 seconds before runner result write; no metrics extrapolated.",
    }],
    "additional2000ScenariosRun": [],
}
OUT.write_text(json.dumps(document, indent=2) + "\n")
print(json.dumps({
    "output": str(OUT),
    "validatedCompletedRuns": {candidate: sorted(by_population) for candidate, by_population in runs.items()},
    "recast2000": summaries["recast"]["2000"],
    "recastMinusAstar2000": recast_delta,
    "observedScaling1000To2000": document["observedScaling1000To2000"],
    "flow2000Failure": flow_failure["outcome"],
    "crossArchitectureHashEqualityRequired": False,
}, indent=2))

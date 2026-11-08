#!/usr/bin/env python3
"""Validate preserved A*/old-Recast inputs and derive corridor comparisons."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / "scratch/phase2-navigation/recast-corridor"
HARNESS = ROOT / "scratch/full-game-movement/harness/results"
OLD = ROOT / "scratch/full-game-movement/recast-integration/results"
NEW = HERE / "results"


def load(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    assert isinstance(value, dict), path
    return value


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def count(records: list[dict[str, Any]], outcome: str) -> int:
    return sum(entry["outcome"] == outcome for entry in records)


def summary(run: dict[str, Any]) -> dict[str, Any]:
    metrics = run["candidateMetrics"]
    applied = [entry for entry in run["pathRequests"] if entry["outcome"] == "applied"]
    responses = [entry["issueToResponseMs"] for entry in run["pathRequests"] if "issueToResponseMs" in entry]
    applies = [entry["applyCostMs"] for entry in applied]
    return {
        "candidate": run["candidate"],
        "wallClockMs": run["wallClockMs"],
        "completed": count(run["completions"], "completed"),
        "activeAtCutoff": count(run["completions"], "active-at-cutoff"),
        "noPathActivities": count(run["completions"], "no-path"),
        "staleCancelledActivities": count(run["completions"], "stale-cancelled"),
        "pathRequests": len(run["pathRequests"]),
        "failedPathResponses": sum(entry.get("ok") is False for entry in run["pathRequests"]),
        "repaths": run["movementDiagnostics"]["repaths"],
        "meanTickMs": run["timing"]["meanTickMs"],
        "p95TickMs": run["timing"]["p95TickMs"],
        "maxTickMs": run["timing"]["maxTickMs"],
        "applyP95Ms": percentile(applies, 0.95),
        "applyMaxMs": run["timing"]["maxApplyCostMs"],
        "responseP95Ms": percentile(responses, 0.95),
        "queueMean": run["scheduler"]["meanQueueDepth"],
        "queueMax": run["scheduler"]["maxQueueDepth"],
        "queueFinal": run["scheduler"]["finalQueueDepth"],
        "blockedTicks": run["scheduler"]["blockedTicks"],
        "revisionBuilds": metrics.get("revisionBuilds"),
        "mutationRebuilds": metrics.get("mutationRebuilds"),
        "lastRevisionBuildMs": metrics.get("lastRevisionBuildMs"),
        "totalRevisionBuildMs": metrics.get("totalRevisionBuildMs"),
        "pathQueries": metrics.get("pathQueries"),
        "totalPathQueryMs": metrics.get("totalPathQueryMs"),
        "routeConversions": metrics.get("routeConversions"),
        "totalRouteConversionMs": metrics.get("totalRouteConversionMs"),
        "geometryRejections": metrics.get("geometryRejections", 0),
        "unreachableRoutes": metrics.get("unreachableRoutes"),
        "partialPathsRejected": metrics.get("partialPathsRejected"),
        "endpointProjectionsRejected": metrics.get("endpointProjectionsRejected"),
        "nativeQueryFailures": metrics.get("nativeQueryFailures"),
        "navmeshGenerationFailures": metrics.get("navmeshGenerationFailures"),
        "crowdAgentsCreated": metrics.get("crowdAgentsCreated"),
        "dynamicObstacleAdds": metrics.get("dynamicObstacleAdds"),
        "finalWorldDigest": run["finalWorldDigest"],
        "finalFullStateHash": run["finalFullStateHash"],
        "initialMapHash": run["initialMapHash"],
        "finalMapHash": run["finalMapHash"],
        "crowdStates": run["crowdStates"],
    }


def validate_pair(runs: list[dict[str, Any]], scenario: str) -> None:
    for run in runs:
        assert run["scenario"] == runs[0]["scenario"]
        assert run["scenario"]["name"] == scenario
        assert run["population"] == 1000
        assert run["requestedTicks"] == run["finalTick"] == 3600
        assert run["frames"] == 3600
        assert run["evidenceClass"] == "node-inline"
        assert run["initialMapHash"] == runs[0]["initialMapHash"]
        assert run["finalMapHash"] == runs[0]["finalMapHash"]
        assert len(run["units"]) == 1000
        assert len({unit["eid"] for unit in run["units"]}) == 1000
        assert sum(run["crowdStates"].values()) == 1000
        assert len({entry["id"] for entry in run["pathRequests"]}) == len(run["pathRequests"])
        for entry in run["pathRequests"]:
            assert entry["snapshotBytes"] == 14400
            if entry["outcome"] == "applied":
                assert entry["issueToApplyTicks"] == 2


def logical(run: dict[str, Any]) -> dict[str, Any]:
    paths = []
    for entry in run["pathRequests"]:
        normalized = {key: entry.get(key) for key in (
            "id", "issueTick", "applyTick", "outcome", "passableVersion"
        )}
        if entry["outcome"] != "pending":
            normalized["ok"] = entry.get("ok")
        paths.append(normalized)
    return {
        "milestones": run["milestones"],
        "completions": run["completions"],
        "movementDiagnostics": run["movementDiagnostics"],
        "crowdStates": run["crowdStates"],
        "units": run["units"],
        "pathRequests": paths,
    }


def main() -> None:
    scenarios: dict[str, dict[str, Any]] = {}
    for scenario in ("narrow-mutation-120", "dense-open-120"):
        paths = {
            "astar": HARNESS / f"{scenario}-p1000-sync.json",
            "oldRecast": OLD / f"{scenario}-p1000-recast.json",
            "corridor": NEW / f"{scenario}-p1000-corridor.json",
        }
        runs = {name: load(path) for name, path in paths.items()}
        validate_pair(list(runs.values()), scenario)
        scenarios[scenario] = {
            "inputs": {name: str(path.relative_to(ROOT)) for name, path in paths.items()},
            "results": {name: summary(run) for name, run in runs.items()},
        }

    replay_paths = [
        NEW / "narrow-mutation-120-p100-t600-corridor-a.json",
        NEW / "narrow-mutation-120-p100-t600-corridor-b.json",
        NEW / "narrow-mutation-120-p100-t600-corridor-mock.json",
    ]
    replay_runs = [load(path) for path in replay_paths]
    assert logical(replay_runs[0]) == logical(replay_runs[1]) == logical(replay_runs[2])
    assert len({run["finalFullStateHash"] for run in replay_runs}) == 1
    assert replay_runs[2]["scheduler"]["blockedTicks"] > 0
    assert all(run["finalTick"] == 600 for run in replay_runs)

    output = {
        "schemaVersion": 1,
        "ticket": 168,
        "scenarios": scenarios,
        "replay": {
            "inputs": [str(path.relative_to(ROOT)) for path in replay_paths],
            "logicalStateEqual": True,
            "fullStateHashEqual": True,
            "finalFullStateHash": replay_runs[0]["finalFullStateHash"],
            "frames": [run["frames"] for run in replay_runs],
            "blockedTicks": [run["scheduler"]["blockedTicks"] for run in replay_runs],
            "requests": [len(run["pathRequests"]) for run in replay_runs],
            "repaths": [run["movementDiagnostics"]["repaths"] for run in replay_runs],
        },
        "crossArchitectureHashEqualityRequired": False,
        "statisticallyRobustTimingDistribution": False,
    }
    destination = NEW / "corridor-comparison.json"
    destination.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(destination), "scenarios": scenarios, "replay": output["replay"]}, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate preserved inputs and derive incremental TileCache comparisons."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / "scratch/navigation-protocol/recast-incremental"
HARNESS = ROOT / "scratch/full-game-movement/harness/results"
CORRIDOR = ROOT / "scratch/phase2-navigation/recast-corridor/results"
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
        "evidenceClass": run["evidenceClass"],
        "wallClockMs": run["wallClockMs"],
        "frames": run["frames"],
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
        "responseMaxMs": max(responses) if responses else None,
        "queueMean": run["scheduler"]["meanQueueDepth"],
        "queueMax": run["scheduler"]["maxQueueDepth"],
        "queueFinal": run["scheduler"]["finalQueueDepth"],
        "blockedTicks": run["scheduler"]["blockedTicks"],
        "revisionBuilds": metrics.get("revisionBuilds"),
        "mutationRebuilds": metrics.get("mutationRebuilds"),
        "totalRevisionBuildMs": metrics.get("totalRevisionBuildMs"),
        "totalMutationRebuildMs": metrics.get("totalMutationRebuildMs"),
        "maxRevisionBuildMs": metrics.get("maxRevisionBuildMs"),
        "lastRevisionBuildMs": metrics.get("lastRevisionBuildMs"),
        "changedTilesObserved": metrics.get("changedTilesObserved"),
        "mutationChangedTiles": metrics.get("mutationChangedTiles"),
        "incrementalRevisions": metrics.get("incrementalRevisions"),
        "revisionBarriersCompleted": metrics.get("revisionBarriersCompleted"),
        "revisionVisibilityChanges": metrics.get("revisionVisibilityChanges"),
        "revisionVisibilityFailures": metrics.get("revisionVisibilityFailures"),
        "lastAcknowledgedRevision": metrics.get("lastAcknowledgedRevision"),
        "totalIncrementalUpdateMs": metrics.get("totalIncrementalUpdateMs"),
        "maxIncrementalUpdateMs": metrics.get("maxIncrementalUpdateMs"),
        "navTilesTouchedRequested": metrics.get("navTilesTouchedRequested"),
        "maxNavTilesTouchedPerRevision": metrics.get("maxNavTilesTouchedPerRevision"),
        "tileCacheUpdateCalls": metrics.get("tileCacheUpdateCalls"),
        "maxUpdateCallsPerRevision": metrics.get("maxUpdateCallsPerRevision"),
        "queueDrains": metrics.get("queueDrains"),
        "obstacleRequestBatches": metrics.get("obstacleRequestBatches"),
        "peakObstacleRequestQueueDepth": metrics.get("peakObstacleRequestQueueDepth"),
        "obstacleRectanglesAdded": metrics.get("obstacleRectanglesAdded"),
        "obstacleRectanglesRemoved": metrics.get("obstacleRectanglesRemoved"),
        "dynamicObstacleAdds": metrics.get("dynamicObstacleAdds"),
        "dynamicObstacleRemoves": metrics.get("dynamicObstacleRemoves"),
        "peakLiveObstacles": metrics.get("peakLiveObstacles"),
        "revisionCacheEntries": metrics.get("revisionCacheEntries"),
        "revisionCacheCapacity": metrics.get("revisionCacheCapacity"),
        "peakRevisionCacheEntries": metrics.get("peakRevisionCacheEntries"),
        "snapshotCacheBytes": metrics.get("snapshotCacheBytes"),
        "guardedFallbacks": metrics.get("guardedFallbacks"),
        "routeFailureFallbacks": metrics.get("routeFailureFallbacks"),
        "geometryFallbacks": metrics.get("geometryFallbacks"),
        "confirmedIncrementalNoPaths": metrics.get("confirmedIncrementalNoPaths"),
        "capacityFallbacks": metrics.get("capacityFallbacks"),
        "updateFailureFallbacks": metrics.get("updateFailureFallbacks"),
        "outOfOrderRebuilds": metrics.get("outOfOrderRebuilds"),
        "snapshotMismatchRebuilds": metrics.get("snapshotMismatchRebuilds"),
        "pathQueries": metrics.get("pathQueries"),
        "totalPathQueryMs": metrics.get("totalPathQueryMs"),
        "routeConversions": metrics.get("routeConversions"),
        "totalRouteConversionMs": metrics.get("totalRouteConversionMs"),
        "responseWaypointBytes": metrics.get("responseWaypointBytes"),
        "geometryRejections": metrics.get("geometryRejections", 0),
        "unreachableRoutes": metrics.get("unreachableRoutes"),
        "partialPathsRejected": metrics.get("partialPathsRejected"),
        "endpointProjectionsRejected": metrics.get("endpointProjectionsRejected"),
        "nativeQueryFailures": metrics.get("nativeQueryFailures"),
        "navmeshGenerationFailures": metrics.get("navmeshGenerationFailures"),
        "obstacleCapacityFailures": metrics.get("obstacleCapacityFailures"),
        "tileCacheUpdateFailures": metrics.get("tileCacheUpdateFailures"),
        "crowdAgentsCreated": metrics.get("crowdAgentsCreated"),
        "finalWorldDigest": run["finalWorldDigest"],
        "finalFullStateHash": run["finalFullStateHash"],
        "initialMapHash": run["initialMapHash"],
        "finalMapHash": run["finalMapHash"],
        "crowdStates": run["crowdStates"],
    }


def validate_run(
    run: dict[str, Any],
    reference: dict[str, Any],
    scenario: str,
    population: int,
    ticks: int,
    require_sync: bool,
) -> None:
    assert run["scenario"] == reference["scenario"]
    assert run["scenario"]["name"] == scenario
    assert run["population"] == population
    assert run["requestedTicks"] == run["finalTick"] == ticks
    assert run["frames"] >= ticks
    if require_sync:
        assert run["frames"] == ticks
        assert run["evidenceClass"] == "node-inline"
    assert run["initialMapHash"] == reference["initialMapHash"]
    assert run["finalMapHash"] == reference["finalMapHash"]
    assert len(run["units"]) == population
    assert len({unit["eid"] for unit in run["units"]}) == population
    assert sum(run["crowdStates"].values()) == population
    assert len({entry["id"] for entry in run["pathRequests"]}) == len(run["pathRequests"])
    for entry in run["pathRequests"]:
        assert entry["snapshotBytes"] == scenario_size(run) ** 2
        if entry["outcome"] == "applied":
            assert entry["issueToApplyTicks"] == 2


def scenario_size(run: dict[str, Any]) -> int:
    return int(run["scenario"]["size"])


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


def stress_summary(case: dict[str, Any]) -> dict[str, Any]:
    metrics = case["incrementalMetrics"]
    assert all(revision["outcomeEqual"] for revision in case["revisions"])
    return {
        "name": case["name"],
        "width": case["width"],
        "wallClockMs": case["wallClockMs"],
        "revisions": len(case["revisions"]),
        "outcomeEquality": True,
        "incrementalRevisions": metrics["incrementalRevisions"],
        "revisionBarriersCompleted": metrics["revisionBarriersCompleted"],
        "tileCacheUpdateCalls": metrics["tileCacheUpdateCalls"],
        "maxUpdateCallsPerRevision": metrics["maxUpdateCallsPerRevision"],
        "navTilesTouchedRequested": metrics["navTilesTouchedRequested"],
        "maxNavTilesTouchedPerRevision": metrics["maxNavTilesTouchedPerRevision"],
        "obstacleRectanglesAdded": metrics["obstacleRectanglesAdded"],
        "obstacleRectanglesRemoved": metrics["obstacleRectanglesRemoved"],
        "peakLiveObstacles": metrics["peakLiveObstacles"],
        "guardedFallbacks": metrics["guardedFallbacks"],
        "geometryFallbacks": metrics["geometryFallbacks"],
        "confirmedIncrementalNoPaths": metrics["confirmedIncrementalNoPaths"],
        "capacityFallbacks": metrics["capacityFallbacks"],
        "updateFailureFallbacks": metrics["updateFailureFallbacks"],
        "obstacleCapacityFailures": metrics["obstacleCapacityFailures"],
        "tileCacheUpdateFailures": metrics["tileCacheUpdateFailures"],
        "lastAcknowledgedRevision": metrics["lastAcknowledgedRevision"],
        "visibleRevision": metrics["visibleRevision"],
        "incrementalBaseActive": metrics["incrementalBaseActive"],
    }


def main() -> None:
    narrow_paths = {
        "astar": HARNESS / "narrow-mutation-120-p1000-sync.json",
        "correctedRecast": CORRIDOR / "narrow-mutation-120-p1000-corridor.json",
        "incremental": NEW / "narrow-mutation-120-p1000-incremental.json",
    }
    narrow = {name: load(path) for name, path in narrow_paths.items()}
    reference = narrow["astar"]
    for run in narrow.values():
        validate_run(run, reference, "narrow-mutation-120", 1000, 3600, True)
    assert logical(narrow["incremental"]) == logical(narrow["correctedRecast"])
    assert narrow["incremental"]["finalFullStateHash"] == narrow["correctedRecast"]["finalFullStateHash"]

    replay_paths = [
        NEW / "narrow-mutation-120-p100-t600-incremental-a.json",
        NEW / "narrow-mutation-120-p100-t600-incremental-b.json",
        NEW / "narrow-mutation-120-p100-t600-incremental-mock.json",
    ]
    replays = [load(path) for path in replay_paths]
    for run in replays:
        validate_run(run, replays[0], "narrow-mutation-120", 100, 600, False)
    assert logical(replays[0]) == logical(replays[1]) == logical(replays[2])
    assert len({run["finalFullStateHash"] for run in replays}) == 1
    assert replays[2]["scheduler"]["blockedTicks"] > 0
    corrected_replay_path = CORRIDOR / "narrow-mutation-120-p100-t600-corridor-a.json"
    corrected_replay = load(corrected_replay_path)
    assert logical(replays[0]) == logical(corrected_replay)
    assert replays[0]["finalFullStateHash"] == corrected_replay["finalFullStateHash"]

    stress_path = NEW / "mutation-stress.json"
    stress = load(stress_path)
    assert stress["ticket"] == 169
    assert stress["outcomeEqualityRequired"] is True
    stress_cases = [stress_summary(case) for case in stress["cases"]]

    results = {name: summary(run) for name, run in narrow.items()}
    incremental_wall = results["incremental"]["wallClockMs"]
    output = {
        "schemaVersion": 1,
        "ticket": 169,
        "scenario": "narrow-mutation-120",
        "inputs": {name: str(path.relative_to(ROOT)) for name, path in narrow_paths.items()},
        "results": results,
        "correctedRecastLogicalStateEqual": True,
        "correctedRecastFullStateHashEqual": True,
        "wallClockPercentChange": {
            "incrementalVsAstar": (incremental_wall / results["astar"]["wallClockMs"] - 1) * 100,
            "incrementalVsCorrectedRecast": (incremental_wall / results["correctedRecast"]["wallClockMs"] - 1) * 100,
        },
        "replay": {
            "inputs": [str(path.relative_to(ROOT)) for path in replay_paths],
            "correctedRecastInput": str(corrected_replay_path.relative_to(ROOT)),
            "logicalStateEqual": True,
            "correctedRecastLogicalStateEqual": True,
            "fullStateHashEqual": True,
            "correctedRecastFullStateHashEqual": True,
            "finalFullStateHash": replays[0]["finalFullStateHash"],
            "frames": [run["frames"] for run in replays],
            "blockedTicks": [run["scheduler"]["blockedTicks"] for run in replays],
            "requests": [len(run["pathRequests"]) for run in replays],
            "repaths": [run["movementDiagnostics"]["repaths"] for run in replays],
        },
        "stress": {
            "input": str(stress_path.relative_to(ROOT)),
            "host": stress["host"],
            "cases": stress_cases,
        },
        "crossArchitectureHashEqualityRequired": False,
        "statisticallyRobustTimingDistribution": False,
        "browserEvidence": False,
    }
    destination = NEW / "incremental-comparison.json"
    destination.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(destination),
        "results": results,
        "wallClockPercentChange": output["wallClockPercentChange"],
        "replay": output["replay"],
        "stress": output["stress"],
    }, indent=2))


if __name__ == "__main__":
    main()

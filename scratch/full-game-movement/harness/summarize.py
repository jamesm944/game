#!/usr/bin/env python3
"""Summarize raw harness JSON without altering per-run evidence."""
import json
import math
from collections import Counter
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
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
    }


def summarize(run):
    completion_ticks = [c["completionTick"] for c in run["completions"] if "completionTick" in c]
    apply_ticks = [p["issueToApplyTicks"] for p in run["pathRequests"] if "issueToApplyTicks" in p]
    response_ms = [p["issueToResponseMs"] for p in run["pathRequests"] if "issueToResponseMs" in p]
    apply_ms = [p["applyCostMs"] for p in run["pathRequests"] if "applyCostMs" in p]
    return {
        "scenario": run["scenario"]["name"],
        "population": run["population"],
        "candidate": run["candidate"],
        "evidenceClass": run["evidenceClass"],
        "finalTick": run["finalTick"],
        "frames": run["frames"],
        "wallClockMs": run["wallClockMs"],
        "simulatedSeconds": run["simulatedSeconds"],
        "completionOutcomes": dict(Counter(c["outcome"] for c in run["completions"])),
        "completionTicks": stats(completion_ticks),
        "crowdStates": run["crowdStates"],
        "pathOutcomes": dict(Counter(p["outcome"] for p in run["pathRequests"])),
        "issueToApplyTicks": stats(apply_ticks),
        "issueToResponseMsNonBrowser": stats(response_ms),
        "pathApplyCostMs": stats(apply_ms),
        "timing": run["timing"],
        "scheduler": run["scheduler"],
        "movementDiagnostics": run["movementDiagnostics"],
        "mutations": run["mutations"],
        "initialMapHash": run["initialMapHash"],
        "finalMapHash": run["finalMapHash"],
        "finalWorldDigest": run["finalWorldDigest"],
        "finalFullStateHash": run["finalFullStateHash"],
    }


runs = []
for path in sorted(RESULTS.glob("*.json")):
    if path.name in {"summary.json", "determinism.json"} or path.name.startswith("debug-"):
        continue
    runs.append(summarize(json.loads(path.read_text())))
(RESULTS / "summary.json").write_text(json.dumps(runs, indent=2) + "\n")
prefix = "narrow-mutation-120-p100-t600-"
a = json.loads((RESULTS / f"{prefix}sync-a.json").read_text())
b = json.loads((RESULTS / f"{prefix}sync-b.json").read_text())
mock = json.loads((RESULTS / f"{prefix}mock.json").read_text())
def logical(run):
    return {key: run[key] for key in ["milestones", "completions", "units", "crowdStates", "movementDiagnostics"]}
determinism = {
    "evidenceClass": "node-inline-and-node-mock-transport",
    "repeatEqual": logical(a) == logical(b),
    "delayedOutOfOrderMockEqual": logical(a) == logical(mock),
    "finalFullStateHash": a["finalFullStateHash"],
    "syncFrames": a["frames"],
    "mockFrames": mock["frames"],
    "mockBlockedTicks": mock["scheduler"]["blockedTicks"],
}
(RESULTS / "determinism.json").write_text(json.dumps(determinism, indent=2) + "\n")
print(json.dumps({"runs": runs, "determinism": determinism}, indent=2))

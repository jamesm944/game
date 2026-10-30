import type { BenchmarkResult, EvidenceClass, ScenarioSpec } from "./types";

export type BrowserName = "chrome" | "firefox" | "safari";

/**
 * Real-browser evidence contract. Implementations must construct the
 * production worker through src/game/paths.ts in the page, drive frames
 * from performance.now(), and return unmodified raw result JSON.
 */
export interface BrowserWorkerRunner {
  readonly browser: BrowserName;
  readonly architecture: string;
  runWorker(options: {
    readonly scenario: ScenarioSpec;
    readonly population: number;
    readonly ticks?: number;
    readonly warmupRuns: number;
    readonly measuredRuns: number;
  }): Promise<BenchmarkResult>;
}

export interface BrowserEvidenceMatrixEntry {
  readonly browser: BrowserName;
  readonly architecture: "arm64" | "x64";
  readonly evidenceClass: Extract<EvidenceClass, "browser-worker">;
  readonly requiredMeasurements: readonly [
    "issue-to-response-wall-ms",
    "issue-to-apply-ticks",
    "path-apply-main-thread-ms",
    "blocked-ticks",
    "activity-completion-ticks",
    "full-state-replay-hash",
  ];
}

/** Planned minimum matrix; no entry is asserted by Node/mock execution. */
export const BROWSER_EVIDENCE_PLAN: readonly BrowserEvidenceMatrixEntry[] = [
  { browser: "chrome", architecture: "arm64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
  { browser: "firefox", architecture: "arm64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
  { browser: "safari", architecture: "arm64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
  { browser: "chrome", architecture: "x64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
  { browser: "firefox", architecture: "x64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
  { browser: "safari", architecture: "x64", evidenceClass: "browser-worker", requiredMeasurements: ["issue-to-response-wall-ms", "issue-to-apply-ticks", "path-apply-main-thread-ms", "blocked-ticks", "activity-completion-ticks", "full-state-replay-hash"] },
];

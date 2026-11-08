import type { SimCommand } from "../../../src/sim/core/inbox";
import type { PathTransport } from "../../../src/sim/path/scheduler";

export type EvidenceClass = "node-inline" | "node-mock-transport" | "browser-worker";

export interface RectSpec {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GroupSpec {
  readonly id: string;
  /** Numerator of population allocation; all shares are normalized. */
  readonly share: number;
  readonly spawn: RectSpec;
  readonly destination: { readonly x: number; readonly y: number };
}

export interface TraceCommandSpec {
  readonly targetTick: number;
  readonly groupIds: readonly string[];
}

export interface TerrainMutationSpec {
  readonly targetTick: number;
  readonly passable: 0 | 1;
  readonly tiles: readonly { readonly x: number; readonly y: number }[];
}

export interface BuildingMutationSpec {
  readonly targetTick: number;
  readonly defId: "house";
  readonly tileX: number;
  readonly tileY: number;
}

export interface ScenarioSpec {
  readonly name: string;
  readonly seed: number;
  readonly size: 120;
  readonly ticks: number;
  readonly map: {
    readonly blocked: readonly RectSpec[];
  };
  readonly groups: readonly GroupSpec[];
  readonly commands: readonly TraceCommandSpec[];
  readonly terrainMutations: readonly TerrainMutationSpec[];
  readonly buildingMutations: readonly BuildingMutationSpec[];
}

export interface CandidateContext {
  readonly evidenceClass: EvidenceClass;
  readonly now: () => number;
  readonly onRequest: (request: import("../../../src/sim/path/protocol").PathRequest) => void;
  readonly onResponse: (response: import("../../../src/sim/path/protocol").PathResponse, computeMs: number) => void;
}

/**
 * Attachment seam for A*, flow-field, and Recast candidates. A candidate
 * supplies a transport below the unchanged PathScheduler/world contract;
 * it may add candidate-only metrics without changing replay semantics.
 */
export interface MovementCandidateAdapter {
  readonly id: string;
  readonly createTransport: (context: CandidateContext) => PathTransport;
  readonly beforeFrame?: () => void;
  readonly candidateMetrics?: () => Readonly<Record<string, number | string | boolean>>;
  readonly dispose?: () => void;
}

export interface RunOptions {
  readonly scenario: ScenarioSpec;
  readonly population: number;
  readonly candidate: MovementCandidateAdapter;
  readonly evidenceClass: EvidenceClass;
  readonly ticks?: number;
  readonly digestEvery?: number;
  readonly maxFrames?: number;
}

export interface PathRequestMetric {
  readonly id: number;
  readonly issueTick: number;
  readonly dueTick: number;
  readonly responseFrame?: number;
  readonly applyTick?: number;
  readonly issueToResponseMs?: number;
  readonly issueToApplyTicks?: number;
  readonly applyCostMs?: number;
  readonly computeMs?: number;
  readonly snapshotBytes: number;
  readonly passableVersion: number;
  readonly outcome: "pending" | "applied" | "stale-discarded";
  readonly ok?: boolean;
  readonly commandTick?: number;
}

export interface UnitCompletion {
  readonly eid: number;
  readonly commandTick: number;
  readonly applyTick?: number;
  readonly completionTick?: number;
  readonly outcome: "completed" | "active-at-cutoff" | "no-path" | "stale-cancelled" | "replaced";
}

export interface CrowdStates {
  readonly completed: number;
  readonly moving: number;
  readonly stalled: number;
  readonly propagatedParked: number;
  readonly parkedNoActivity: number;
  readonly awaitingGroupPath: number;
  readonly otherActivity: number;
}

export interface FinalUnitState {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly stalledTicks: number;
  readonly propagatedParked: number;
  readonly activityKind?: string;
  readonly activityCount: number;
  readonly waypointCursor?: number;
  readonly waypointCount?: number;
  readonly targetX?: number;
  readonly targetY?: number;
}

export interface ReplayMilestone {
  readonly tick: number;
  readonly worldDigest: string;
  readonly layersHash: string;
  readonly fullStateHash: string;
}

export interface TickMetric {
  readonly tick: number;
  readonly wallMs: number;
  readonly queueDepth: number;
  readonly blockedTicks: number;
  readonly passabilityVersion: number;
}

export interface MutationMetric {
  readonly tick: number;
  readonly kind: "terrain" | "building";
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly changedTiles: number;
  readonly firstRecoveryApplyTick?: number;
}

export interface BenchmarkResult {
  readonly schemaVersion: 1;
  readonly scenario: ScenarioSpec;
  readonly candidate: string;
  readonly evidenceClass: EvidenceClass;
  readonly population: number;
  readonly requestedTicks: number;
  readonly finalTick: number;
  readonly frames: number;
  readonly wallClockMs: number;
  readonly simulatedSeconds: number;
  readonly initialMapHash: string;
  readonly finalMapHash: string;
  readonly finalWorldDigest: string;
  readonly finalFullStateHash: string;
  readonly milestones: readonly ReplayMilestone[];
  readonly pathRequests: readonly PathRequestMetric[];
  readonly completions: readonly UnitCompletion[];
  readonly units: readonly FinalUnitState[];
  readonly crowdStates: CrowdStates;
  readonly movementDiagnostics: {
    readonly sidesteps: number;
    readonly repaths: number;
    readonly groupMoves: number;
  };
  readonly scheduler: {
    readonly blockedTicks: number;
    readonly finalQueueDepth: number;
    readonly maxQueueDepth: number;
    readonly meanQueueDepth: number;
  };
  readonly timing: {
    readonly meanTickMs: number;
    readonly p95TickMs: number;
    readonly maxTickMs: number;
    readonly totalApplyCostMs: number;
    readonly maxApplyCostMs: number;
  };
  readonly mutations: readonly MutationMetric[];
  readonly ticks: readonly TickMetric[];
  readonly candidateMetrics: Readonly<Record<string, number | string | boolean>>;
}

export type RecordedCommand = SimCommand;

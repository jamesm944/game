import { PathScheduler } from "../../../src/sim/path/scheduler";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { CandidateContext, EvidenceClass, MovementCandidateAdapter, PathRequestMetric } from "./types";

interface MutablePathMetric {
  id: number;
  issueTick: number;
  dueTick: number;
  responseFrame?: number;
  applyTick?: number;
  issueToResponseMs?: number;
  issueToApplyTicks?: number;
  applyCostMs?: number;
  computeMs?: number;
  snapshotBytes: number;
  passableVersion: number;
  outcome: "pending" | "applied" | "stale-discarded";
  ok?: boolean;
  commandTick?: number;
  issueWallMs: number;
}

/** Runtime-only decoration of public scheduler methods; production is untouched. */
export class SchedulerInstrumentation {
  readonly scheduler: PathScheduler;
  readonly adapter: MovementCandidateAdapter;
  readonly #metrics: MutablePathMetric[] = [];
  readonly #byId = new Map<number, MutablePathMetric>();
  readonly #issuedWall = new Map<number, number>();
  readonly #boundaryTick: () => number;
  readonly #frame: () => number;
  readonly #now: () => number;
  readonly #onRequest?: ((metric: PathRequestMetric, request: PathRequest) => void) | undefined;
  readonly #onApply?: ((metric: PathRequestMetric, response: PathResponse) => void) | undefined;
  readonly #onDiscard?: ((metric: PathRequestMetric) => void) | undefined;

  constructor(options: {
    readonly adapter: MovementCandidateAdapter;
    readonly evidenceClass: EvidenceClass;
    readonly boundaryTick: () => number;
    readonly frame: () => number;
    readonly now?: () => number;
    readonly onRequest?: (metric: PathRequestMetric, request: PathRequest) => void;
    readonly onApply?: (metric: PathRequestMetric, response: PathResponse) => void;
    readonly onDiscard?: (metric: PathRequestMetric) => void;
  }) {
    this.adapter = options.adapter;
    this.#boundaryTick = options.boundaryTick;
    this.#frame = options.frame;
    this.#now = options.now ?? (() => performance.now());
    this.#onRequest = options.onRequest;
    this.#onApply = options.onApply;
    this.#onDiscard = options.onDiscard;
    const context: CandidateContext = {
      evidenceClass: options.evidenceClass,
      now: this.#now,
      onRequest: (request) => this.#requestSent(request),
      onResponse: (response, computeMs) => this.#responseReceived(response, computeMs),
    };
    const candidateTransport = this.adapter.createTransport(context);
    const instrumentedTransport = {
      attach: (receive: (response: PathResponse) => void) => candidateTransport.attach(receive),
      send: (request: PathRequest) => candidateTransport.send(request),
      dispose: () => candidateTransport.dispose(),
    };
    this.scheduler = new PathScheduler(instrumentedTransport);
    this.#decorateRequestPath();
    this.#decoratePump();
  }

  #requestSent(request: PathRequest): void {
    const metric: MutablePathMetric = {
      id: request.id,
      issueTick: request.dueTick - 2,
      dueTick: request.dueTick,
      snapshotBytes: request.passable.byteLength,
      passableVersion: request.passableVersion,
      outcome: "pending",
      issueWallMs: this.#now(),
    };
    this.#metrics.push(metric);
    this.#byId.set(request.id, metric);
    this.#issuedWall.set(request.id, metric.issueWallMs);
    this.#onRequest?.(metric, request);
  }

  #responseReceived(response: PathResponse, computeMs: number): void {
    const metric = this.#byId.get(response.id);
    if (!metric) return;
    metric.responseFrame = this.#frame();
    metric.issueToResponseMs = this.#now() - (this.#issuedWall.get(response.id) ?? this.#now());
    metric.computeMs = computeMs;
    metric.ok = response.ok;
  }

  #decorateRequestPath(): void {
    const original = this.scheduler.requestPath.bind(this.scheduler);
    this.scheduler.requestPath = (input, options) => {
      let id = 0;
      const result = original(input, {
        ...options,
        onApply: (response) => {
          const started = this.#now();
          try {
            options.onApply(response);
          } finally {
            const metric = this.#byId.get(id);
            if (metric) {
              metric.outcome = "applied";
              metric.applyTick = this.#boundaryTick();
              metric.issueToApplyTicks = this.#boundaryTick() - metric.issueTick;
              metric.applyCostMs = this.#now() - started;
              metric.ok = response.ok;
              this.#onApply?.(metric, response);
            }
          }
        },
        onDiscard: () => {
          options.onDiscard?.();
          const metric = this.#byId.get(id);
          if (metric) {
            metric.outcome = "stale-discarded";
            metric.applyTick = this.#boundaryTick();
            metric.issueToApplyTicks = this.#boundaryTick() - metric.issueTick;
            this.#onDiscard?.(metric);
          }
        },
      });
      id = result;
      return result;
    };
  }

  #decoratePump(): void {
    const original = this.scheduler.pump.bind(this.scheduler);
    this.scheduler.pump = (currentTick) => {
      const pendingBefore = this.#metrics
        .filter((metric) => metric.outcome === "pending")
        .sort((a, b) => a.id - b.id);
      const before = this.scheduler.pendingCount;
      const result = original(currentTick);
      const removed = before - this.scheduler.pendingCount;
      for (const metric of pendingBefore.slice(0, removed)) {
        if (metric.outcome !== "pending") continue;
        // Group requests have no onDiscard hook. The ascending pump count
        // proves that this unresolved request was removed as stale.
        metric.outcome = "stale-discarded";
        metric.applyTick = currentTick;
        metric.issueToApplyTicks = currentTick - metric.issueTick;
        this.#onDiscard?.(metric);
      }
      return result;
    };
  }

  get requests(): readonly PathRequestMetric[] {
    return this.#metrics.map(({ issueWallMs: _issueWallMs, ...metric }) => ({ ...metric }));
  }
}

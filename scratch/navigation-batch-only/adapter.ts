import type { PathRequest, PathResponse } from "../../src/sim/path/protocol";
import type { MovementCandidateAdapter } from "../full-game-movement/harness/types";
import { LegacySnapshotCompatibility } from "./legacy-compat";
import {
  batchSizeForPolicy,
  epochNowMs,
  type QueuePolicy,
  type QueueWorkerFactory,
  type QueueWorkerMessage,
  type RequestClass,
  type SinglePathMessage,
  type SnapshotAckMessage,
} from "./protocol";
import { SchedulerOwnedSnapshotProvider, type SnapshotPreparation, type SnapshotPreparationEvent } from "./provider";
import { postNavigationResult } from "./queue.worker";
import { NavigationQueueWorker } from "./worker-handler";

export interface QueueResponseTelemetry {
  readonly id: number;
  readonly requestClass: RequestClass;
  readonly batchId: number;
  readonly batchSize: number;
  readonly workerQueueMs: number;
  readonly computeMs: number;
  readonly responsePayloadBytes: number;
  readonly coalescedFromId?: number;
}

export interface QueueProtocolTelemetry {
  readonly policy: QueuePolicy;
  readonly preparations: readonly SnapshotPreparationEvent[];
  readonly acknowledgments: readonly SnapshotAckMessage[];
  readonly responses: readonly QueueResponseTelemetry[];
  readonly mainSnapshotCount: number;
  readonly mainSnapshotBytes: number;
  readonly maxQueuedRequests: number;
  readonly maxBatchSize: number;
  readonly pathRequestMessages: number;
  readonly pathResultMessages: number;
  readonly coalescingEligibleResponses: number;
  readonly coalescedResponses: number;
  readonly maxWorkerSnapshotCount: number;
  readonly maxWorkerSnapshotBytes: number;
  readonly maxPathCacheSize: number;
}

export interface QueueAstarCandidate extends MovementCandidateAdapter {
  readonly provider: SchedulerOwnedSnapshotProvider;
  readonly compatibility: LegacySnapshotCompatibility;
  noteRequest(id: number, requestClass: RequestClass, groupKey: string): void;
  protocolTelemetry(): QueueProtocolTelemetry;
}

export function createBrowserQueueWorkerFactory(): QueueWorkerFactory {
  return () => {
    const worker = new Worker(new URL("./queue.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage(message, transfer) {
        if (transfer) worker.postMessage(message, [...transfer]);
        else worker.postMessage(message);
      },
      setMessageHandler(handler) {
        worker.onmessage = handler ? (event) => handler({ data: event.data }) : null;
      },
      terminate: () => worker.terminate(),
    };
  };
}

export function createLocalQueueWorkerFactory(delayMs = 0): QueueWorkerFactory {
  return () => {
    const handler = new NavigationQueueWorker();
    let receive: ((event: { data: QueueWorkerMessage }) => void) | null = null;
    let disposed = false;
    return {
      postMessage(message) {
        const deliver = () => {
          if (!disposed) postNavigationResult((output) => receive?.({ data: output }), message, handler);
        };
        if (delayMs > 0) setTimeout(deliver, delayMs);
        else deliver();
      },
      setMessageHandler(handler) {
        receive = handler;
      },
      terminate() {
        disposed = true;
      },
    };
  };
}

export interface DeliveryProbeSample {
  readonly probeId: number;
  readonly roundTripMs: number;
  readonly workerHandlingMs: number;
}

/** Sequential main-only acknowledgment RTTs; deliberately outside headline runs. */
export async function runDeliveryProbeDiagnostic(
  factory: QueueWorkerFactory,
  count: number,
): Promise<{ readonly method: string; readonly samples: readonly DeliveryProbeSample[] }> {
  const worker = factory();
  const samples: DeliveryProbeSample[] = [];
  try {
    for (let probeId = 1; probeId <= count; probeId += 1) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`delivery probe ${probeId} timed out`)), 5_000);
        worker.setMessageHandler((event) => {
          if (event.data.kind !== "delivery-probe-ack" || event.data.probeId !== probeId) return;
          const roundTripMs = performance.now() - started;
          clearTimeout(timeout);
          samples.push({ probeId, roundTripMs, workerHandlingMs: event.data.workerHandlingMs });
          resolve();
        });
        const started = performance.now();
        worker.postMessage({ kind: "delivery-probe", probeId });
      });
    }
  } finally {
    worker.setMessageHandler(null);
    worker.terminate();
  }
  return {
    method: "64 sequential post-message/acknowledgment round trips; start and end use main performance.now(); includes outbound, worker handling, and inbound delivery; not one-way delivery and not policy-selection evidence",
    samples,
  };
}

export function createQueueAstarCandidate(
  policy: QueuePolicy,
  factory: QueueWorkerFactory = createBrowserQueueWorkerFactory(),
): QueueAstarCandidate {
  const provider = new SchedulerOwnedSnapshotProvider();
  const compatibility = new LegacySnapshotCompatibility(provider);
  const requestMetadata = new Map<number, { requestClass: RequestClass; groupKey: string }>();
  const acknowledgments: SnapshotAckMessage[] = [];
  const responses: QueueResponseTelemetry[] = [];
  let activeWorker: ReturnType<QueueWorkerFactory> | undefined;
  let maxQueuedRequests = 0;
  let maxBatchSize = 0;
  let pathRequestMessages = 0;
  let pathResultMessages = 0;
  let coalescingEligibleResponses = 0;
  let coalescedResponses = 0;
  let maxWorkerSnapshotCount = 0;
  let maxWorkerSnapshotBytes = 0;
  let maxPathCacheSize = 0;
  let responseWaypointBytes = 0;
  return {
    id: `queue-${policy}-snapshot-astar`,
    provider,
    compatibility,
    noteRequest(id, requestClass, groupKey) {
      requestMetadata.set(id, { requestClass, groupKey });
    },
    createTransport(context) {
      const worker = factory();
      activeWorker = worker;
      let responseReceiver: ((response: PathResponse) => void) | undefined;
      const registeredSnapshots = new Set<number>();
      let pending: SinglePathMessage[] = [];
      let flushScheduled = false;
      let nextBatchId = 0;
      const ensureSnapshot = (preparation: SnapshotPreparation) => {
        if (registeredSnapshots.has(preparation.handle.snapshotId)) return;
        if (preparation.baseSnapshotId === undefined) {
          worker.postMessage({
            kind: "snapshot-register",
            handle: preparation.handle,
            passable: preparation.passable.buffer as ArrayBuffer,
          });
        } else {
          worker.postMessage({
            kind: "snapshot-update",
            handle: preparation.handle,
            baseSnapshotId: preparation.baseSnapshotId,
            baseRevision: preparation.baseRevision!,
            indices: preparation.indices,
            values: preparation.values,
          }, [preparation.indices.buffer, preparation.values.buffer]);
        }
        registeredSnapshots.add(preparation.handle.snapshotId);
      };
      const flush = () => {
        flushScheduled = false;
        const ordered = pending;
        for (let index = 1; index < ordered.length; index += 1) {
          if (ordered[index]!.id <= ordered[index - 1]!.id) throw new Error("batch requests must retain strictly increasing FIFO IDs");
        }
        pending = [];
        const batchSize = batchSizeForPolicy(policy);
        for (let offset = 0; offset < ordered.length; offset += batchSize) {
          const chunk = ordered.slice(offset, offset + batchSize);
          const sentAtEpochMs = epochNowMs();
          pathRequestMessages += 1;
          maxBatchSize = Math.max(maxBatchSize, chunk.length);
          worker.postMessage({
            kind: "path-batch",
            batchId: ++nextBatchId,
            requests: chunk.map((request) => ({ ...request, sentAtEpochMs })),
          });
        }
      };
      worker.setMessageHandler((event) => {
        const message = event.data;
        if (message.kind === "snapshot-ack") {
          acknowledgments.push(message);
          maxWorkerSnapshotCount = Math.max(maxWorkerSnapshotCount, message.snapshotCount);
          maxWorkerSnapshotBytes = Math.max(maxWorkerSnapshotBytes, message.snapshotBytes);
          return;
        }
        if (message.kind === "delivery-probe-ack") throw new Error("unexpected diagnostic acknowledgment in headline transport");
        pathResultMessages += 1;
        coalescingEligibleResponses += message.coalescingEligibleResponses;
        maxWorkerSnapshotCount = Math.max(maxWorkerSnapshotCount, message.snapshotCount);
        maxWorkerSnapshotBytes = Math.max(maxWorkerSnapshotBytes, message.snapshotBytes);
        maxPathCacheSize = Math.max(maxPathCacheSize, message.pathCacheSize);
        for (const item of message.items) {
          if (item.coalescedFromId !== undefined) coalescedResponses += 1;
          responseWaypointBytes += item.responsePayloadBytes;
          responses.push({
            id: item.response.id,
            requestClass: item.requestClass,
            batchId: message.batchId,
            batchSize: message.batchSize,
            workerQueueMs: item.workerQueueMs,
            computeMs: item.computeMs,
            responsePayloadBytes: item.responsePayloadBytes,
            ...(item.coalescedFromId !== undefined ? { coalescedFromId: item.coalescedFromId } : {}),
          });
          context.onResponse(item.response, item.computeMs);
          responseReceiver?.(item.response);
        }
      });
      return {
        attach(receive) {
          responseReceiver = receive;
        },
        send(request: PathRequest) {
          context.onRequest(request);
          const preparation = compatibility.resolve(request.passable);
          ensureSnapshot(preparation);
          const metadata = requestMetadata.get(request.id) ?? {
            requestClass: "repath" as const,
            groupKey: `unknown:${String(request.id)}`,
          };
          const message: SinglePathMessage = {
            kind: "path",
            id: request.id,
            dueTick: request.dueTick,
            startX: request.startX,
            startY: request.startY,
            goalX: request.goalX,
            goalY: request.goalY,
            seed: request.seed,
            snapshot: preparation.handle,
            requestClass: metadata.requestClass,
            groupKey: metadata.groupKey,
            sentAtEpochMs: policy === "fifo" ? epochNowMs() : 0,
          };
          if (policy === "fifo") {
            pathRequestMessages += 1;
            maxBatchSize = Math.max(maxBatchSize, 1);
            worker.postMessage(message);
          } else {
            pending.push(message);
            maxQueuedRequests = Math.max(maxQueuedRequests, pending.length);
            if (!flushScheduled) {
              flushScheduled = true;
              queueMicrotask(flush);
            }
          }
        },
        dispose() {
          if (pending.length > 0) flush();
          worker.setMessageHandler(null);
          worker.terminate();
        },
      };
    },
    candidateMetrics() {
      return {
        queuePolicy: policy,
        fullSnapshotPayloadBytes: provider.events
          .filter((event) => event.operation === "register")
          .reduce((sum, event) => sum + event.snapshotBytes, 0),
        deltaSnapshotPayloadBytes: provider.events
          .filter((event) => event.operation === "update")
          .reduce((sum, event) => sum + event.deltaPayloadBytes, 0),
        snapshotPreparationCount: provider.events.length,
        sameRevisionRequests: provider.sameRevisionRequests,
        pathRequestMessages,
        pathResultMessages,
        maxBatchSize,
        coalescingEligibleResponses,
        coalescedResponses,
        responseWaypointBytes,
        mainSnapshotCount: provider.retainedSnapshotCount,
        mainSnapshotBytes: provider.retainedSnapshotBytes,
        maxWorkerSnapshotCount,
        maxWorkerSnapshotBytes,
        maxPathCacheSize,
      };
    },
    protocolTelemetry() {
      return {
        policy,
        preparations: provider.events,
        acknowledgments: acknowledgments.map((ack) => ({ ...ack })),
        responses: responses.map((response) => ({ ...response })),
        mainSnapshotCount: provider.retainedSnapshotCount,
        mainSnapshotBytes: provider.retainedSnapshotBytes,
        maxQueuedRequests,
        maxBatchSize,
        pathRequestMessages,
        pathResultMessages,
        coalescingEligibleResponses,
        coalescedResponses,
        maxWorkerSnapshotCount,
        maxWorkerSnapshotBytes,
        maxPathCacheSize,
      };
    },
    dispose() {
      activeWorker?.setMessageHandler(null);
      activeWorker?.terminate();
      activeWorker = undefined;
    },
  };
}

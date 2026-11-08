import type { PathResponse } from "../../../src/sim/path/protocol";
import type { CleanPathRequest, CleanPathTransport, SchedulerRequest } from "./clean-scheduler";
import {
  batchSizeForPolicy, epochNowMs,
  type QueuePolicy, type QueueWorkerFactory, type QueueWorkerMessage,
  type RequestClass, type SinglePathMessage, type SnapshotAckMessage,
} from "./protocol";
import type { SnapshotPreparation, SnapshotPreparationEvent } from "./provider";
import { postNavigationResult } from "./queue.worker";
import { NavigationQueueWorker } from "./worker-handler";

export interface RequestIdentity { readonly requestClass: RequestClass; readonly groupKey: string; }
export interface ResponseTelemetry {
  readonly id: number; readonly requestClass: RequestClass; readonly batchId: number;
  readonly batchSize: number; readonly workerQueueMs: number; readonly computeMs: number;
  readonly responsePayloadBytes: number; readonly coalescedFromId?: number;
}
export interface CandidateHooks {
  onRequest(request: CleanPathRequest, identity: RequestIdentity): void;
  onResponse(response: PathResponse, computeMs: number): void;
}
export interface QueueCandidate {
  readonly id: string;
  createTransport(hooks: CandidateHooks): CleanPathTransport;
  telemetry(): Readonly<Record<string, number | string | boolean>>;
  protocol(): {
    preparations: readonly SnapshotPreparationEvent[]; acknowledgments: readonly SnapshotAckMessage[];
    responses: readonly ResponseTelemetry[];
  };
  dispose(): void;
}
export function createBrowserQueueWorkerFactory(): QueueWorkerFactory {
  return () => {
    const worker = new Worker(new URL("./queue.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage(message, transfer) { worker.postMessage(message, transfer ? [...transfer] : []); },
      setMessageHandler(handler) { worker.onmessage = handler ? (event) => handler({ data: event.data }) : null; },
      terminate: () => worker.terminate(),
    };
  };
}
export function createLocalQueueWorkerFactory(delayMs = 0): QueueWorkerFactory {
  return () => {
    const handler = new NavigationQueueWorker(); let disposed = false;
    let receive: ((event: { data: QueueWorkerMessage }) => void) | null = null;
    return {
      postMessage(message) {
        const deliver = () => { if (!disposed) postNavigationResult((output) => receive?.({ data: output }), message, handler); };
        if (delayMs > 0) setTimeout(deliver, delayMs); else deliver();
      },
      setMessageHandler(next) { receive = next; }, terminate() { disposed = true; },
    };
  };
}

export function createQueueCandidate(
  policy: QueuePolicy,
  classify: (request: CleanPathRequest) => RequestIdentity,
  factory: QueueWorkerFactory = createBrowserQueueWorkerFactory(),
): QueueCandidate {
  if (policy !== "fifo" && policy !== "batch-32") throw new Error("dense comparison admits only FIFO and batch-32");
  const preparations: SnapshotPreparationEvent[] = [];
  const acknowledgments: SnapshotAckMessage[] = [];
  const responses: ResponseTelemetry[] = [];
  let activeWorker: ReturnType<QueueWorkerFactory> | undefined;
  let requestMessages = 0, resultMessages = 0, eligible = 0, coalesced = 0;
  let maxBatchSize = 0, maxWorkerSnapshotCount = 0, maxWorkerSnapshotBytes = 0, maxPathCacheSize = 0;
  let fullSnapshotBytes = 0, deltaSnapshotBytes = 0, responseWaypointBytes = 0;
  return {
    id: `clean-${policy}-snapshot-astar`,
    createTransport(hooks) {
      const worker = factory(); activeWorker = worker;
      const registered = new Set<number>(); let pending: SinglePathMessage[] = [];
      let flushScheduled = false, nextBatchId = 0;
      const flush = () => {
        flushScheduled = false; const ordered = pending; pending = [];
        for (let i = 1; i < ordered.length; i += 1) {
          if (ordered[i]!.id <= ordered[i - 1]!.id) throw new Error("FIFO IDs regressed inside batch");
        }
        for (let offset = 0; offset < ordered.length; offset += batchSizeForPolicy(policy)) {
          const chunk = ordered.slice(offset, offset + batchSizeForPolicy(policy));
          const sentAtEpochMs = epochNowMs(); requestMessages += 1;
          maxBatchSize = Math.max(maxBatchSize, chunk.length);
          worker.postMessage({ kind: "path-batch", batchId: ++nextBatchId,
            requests: chunk.map((request) => ({ ...request, sentAtEpochMs })) });
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
        if (message.kind !== "path-results") return;
        resultMessages += 1; eligible += message.coalescingEligibleResponses;
        maxWorkerSnapshotCount = Math.max(maxWorkerSnapshotCount, message.snapshotCount);
        maxWorkerSnapshotBytes = Math.max(maxWorkerSnapshotBytes, message.snapshotBytes);
        maxPathCacheSize = Math.max(maxPathCacheSize, message.pathCacheSize);
        for (const item of message.items) {
          if (item.coalescedFromId !== undefined) coalesced += 1;
          responseWaypointBytes += item.responsePayloadBytes;
          responses.push({ id: item.response.id, requestClass: item.requestClass, batchId: message.batchId,
            batchSize: message.batchSize, workerQueueMs: item.workerQueueMs, computeMs: item.computeMs,
            responsePayloadBytes: item.responsePayloadBytes,
            ...(item.coalescedFromId !== undefined ? { coalescedFromId: item.coalescedFromId } : {}) });
          hooks.onResponse(item.response, item.computeMs);
        }
      });
      return {
        attach(receive) {
          const original = hooks.onResponse;
          hooks.onResponse = (response, computeMs) => { original(response, computeMs); receive(response); };
        },
        ensureSnapshot(preparation: SnapshotPreparation) {
          if (registered.has(preparation.handle.snapshotId)) return;
          preparations.push({ handle: preparation.handle,
            ...(preparation.baseRevision !== undefined ? { baseRevision: preparation.baseRevision } : {}),
            operation: preparation.baseSnapshotId === undefined ? "register" : "update",
            snapshotBytes: preparation.passable.byteLength, deltaEntries: preparation.indices.length,
            deltaPayloadBytes: preparation.indices.byteLength + preparation.values.byteLength,
            copyMs: preparation.copyMs, diffMs: preparation.diffMs });
          if (preparation.baseSnapshotId === undefined) {
            fullSnapshotBytes += preparation.passable.byteLength;
            worker.postMessage({ kind: "snapshot-register", handle: preparation.handle,
              passable: preparation.passable.buffer as ArrayBuffer });
          } else {
            deltaSnapshotBytes += preparation.indices.byteLength + preparation.values.byteLength;
            worker.postMessage({ kind: "snapshot-update", handle: preparation.handle,
              baseSnapshotId: preparation.baseSnapshotId, baseRevision: preparation.baseRevision!,
              indices: preparation.indices, values: preparation.values },
            [preparation.indices.buffer, preparation.values.buffer]);
          }
          registered.add(preparation.handle.snapshotId);
        },
        send(request: SchedulerRequest) {
          if (!("snapshot" in request)) throw new Error("legacy payload request reached clean transport");
          const identity = classify(request); hooks.onRequest(request, identity);
          const message: SinglePathMessage = { ...request, ...identity,
            sentAtEpochMs: policy === "fifo" ? epochNowMs() : 0 };
          if (policy === "fifo") { requestMessages += 1; maxBatchSize = 1; worker.postMessage(message); }
          else { pending.push(message); if (!flushScheduled) { flushScheduled = true; queueMicrotask(flush); } }
        },
        dispose() { if (pending.length) flush(); worker.setMessageHandler(null); worker.terminate(); },
      };
    },
    telemetry: () => ({ requestMessages, resultMessages, maxBatchSize, coalescingEligibleResponses: eligible,
      coalescedResponses: coalesced, fullSnapshotBytes, deltaSnapshotBytes, responseWaypointBytes,
      maxWorkerSnapshotCount, maxWorkerSnapshotBytes, maxPathCacheSize }),
    protocol: () => ({ preparations, acknowledgments, responses }),
    dispose() { activeWorker?.setMessageHandler(null); activeWorker?.terminate(); activeWorker = undefined; },
  };
}

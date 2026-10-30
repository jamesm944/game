import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import {
  epochNowMs,
  registrationPayloadBytes,
  requestPayloadBytes,
  updatePayloadBytes,
  type SnapshotAckMessage,
  type VersionedWorkerFactory,
  type VersionedWorkerMessage,
} from "./protocol";
import { MainSnapshotCache, type SnapshotPreparationEvent } from "./snapshot-cache";
import { postVersionedResult } from "./versioned.worker";
import { VersionedSnapshotWorker } from "./worker-handler";

export interface VersionedRequestTelemetry {
  readonly id: number;
  readonly snapshotId: number;
  readonly revision: number;
  readonly requestPayloadBytes: number;
  readonly requestPostMs: number;
}

export interface VersionedResponseTelemetry {
  readonly id: number;
  readonly snapshotId: number;
  readonly revision: number;
  readonly workerQueueMs: number;
  readonly computeMs: number;
  responsePostMs?: number;
  readonly responsePayloadBytes: number;
  readonly pathCacheSize: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
}

export interface SnapshotSendTelemetry {
  readonly snapshotId: number;
  readonly revision: number;
  readonly operation: "register" | "update";
  readonly protocolPayloadBytes: number;
  readonly snapshotPayloadBytes: number;
  readonly deltaEntries: number;
  readonly mainPostMs: number;
  readonly mainCopyMs: number;
  readonly mainDiffMs: number;
}

export interface VersionedProtocolTelemetry {
  readonly snapshotPreparations: readonly SnapshotPreparationEvent[];
  readonly snapshotSends: readonly SnapshotSendTelemetry[];
  readonly snapshotAcks: readonly SnapshotAckMessage[];
  readonly requests: readonly VersionedRequestTelemetry[];
  readonly responses: readonly VersionedResponseTelemetry[];
  readonly mainRetainedSnapshotCount: number;
  readonly mainRetainedSnapshotBytes: number;
  readonly sameRevisionRequests: number;
  readonly transferMode: string;
}

export interface VersionedAstarCandidate extends MovementCandidateAdapter {
  readonly snapshots: MainSnapshotCache;
  protocolTelemetry(): VersionedProtocolTelemetry;
}

export function createBrowserVersionedWorkerFactory(): VersionedWorkerFactory {
  return () => {
    const worker = new Worker(new URL("./versioned.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage(message, transfer) {
        // Registration intentionally has no transfer list: exactly one structured clone per full registration.
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

/** In-process protocol transport for correctness/replay tests, not browser timing evidence. */
export function createLocalVersionedWorkerFactory(delayMs = 0): VersionedWorkerFactory {
  return () => {
    const handler = new VersionedSnapshotWorker();
    let receive: ((event: { data: VersionedWorkerMessage }) => void) | null = null;
    let disposed = false;
    return {
      postMessage(message) {
        const deliver = () => {
          if (!disposed) postVersionedResult((output) => receive?.({ data: output }), message, handler);
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

export function createVersionedAstarCandidate(
  factory: VersionedWorkerFactory = createBrowserVersionedWorkerFactory(),
): VersionedAstarCandidate {
  const snapshots = new MainSnapshotCache();
  const snapshotSends: SnapshotSendTelemetry[] = [];
  const snapshotAcks: SnapshotAckMessage[] = [];
  const requests: VersionedRequestTelemetry[] = [];
  const responses: VersionedResponseTelemetry[] = [];
  let activeWorker: ReturnType<VersionedWorkerFactory> | undefined;
  return {
    id: "versioned-snapshot-astar",
    snapshots,
    createTransport(context) {
      const worker = factory();
      activeWorker = worker;
      let workerSnapshotId = 0;
      let responseReceiver: ((response: PathResponse) => void) | undefined;
      const responsesById = new Map<number, VersionedResponseTelemetry>();
      worker.setMessageHandler((event) => {
        const message = event.data;
        if (message.kind === "snapshot-ack") {
          snapshotAcks.push(message);
        } else if (message.kind === "path-post-telemetry") {
          const response = responsesById.get(message.id);
          if (response) response.responsePostMs = message.responsePostMs;
        } else {
          const telemetry: VersionedResponseTelemetry = {
            id: message.response.id,
            snapshotId: message.snapshotId,
            revision: message.revision,
            workerQueueMs: message.workerQueueMs,
            computeMs: message.computeMs,
            responsePayloadBytes: message.responsePayloadBytes,
            pathCacheSize: message.pathCacheSize,
            snapshotCount: message.snapshotCount,
            snapshotBytes: message.snapshotBytes,
          };
          responses.push(telemetry);
          responsesById.set(telemetry.id, telemetry);
          context.onResponse(message.response, message.computeMs);
          responseReceiver?.(message.response);
        }
      });
      return {
        attach(receive: (response: PathResponse) => void) {
          responseReceiver = receive;
        },
        send(request: PathRequest) {
          context.onRequest(request);
          const record = snapshots.resolve(request.passable);
          if (record.snapshotId !== workerSnapshotId) {
            const preparation = snapshots.events.find((event) => event.snapshotId === record.snapshotId)!;
            const started = performance.now();
            let protocolPayloadBytes: number;
            if (record.baseSnapshotId === undefined) {
              const message = {
                kind: "snapshot-register" as const,
                snapshotId: record.snapshotId,
                revision: record.revision,
                plane: record.plane,
                width: record.width,
                passable: record.passable.buffer as ArrayBuffer,
              };
              protocolPayloadBytes = registrationPayloadBytes(message);
              worker.postMessage(message);
            } else {
              const message = {
                kind: "snapshot-update" as const,
                snapshotId: record.snapshotId,
                baseSnapshotId: record.baseSnapshotId,
                revision: record.revision,
                baseRevision: record.baseRevision!,
                plane: record.plane,
                width: record.width,
                indices: record.indices,
                values: record.values,
              };
              protocolPayloadBytes = updatePayloadBytes(message);
              worker.postMessage(message, [record.indices.buffer, record.values.buffer]);
            }
            snapshotSends.push({
              snapshotId: record.snapshotId,
              revision: record.revision,
              operation: record.baseSnapshotId === undefined ? "register" : "update",
              protocolPayloadBytes,
              snapshotPayloadBytes: preparation.snapshotBytes,
              deltaEntries: preparation.deltaEntries,
              mainPostMs: performance.now() - started,
              mainCopyMs: preparation.copyMs,
              mainDiffMs: preparation.diffMs,
            });
            workerSnapshotId = record.snapshotId;
          }
          const message = {
            kind: "versioned-path" as const,
            id: request.id,
            dueTick: request.dueTick,
            startX: request.startX,
            startY: request.startY,
            goalX: request.goalX,
            goalY: request.goalY,
            snapshotId: record.snapshotId,
            passableVersion: request.passableVersion,
            plane: record.plane,
            seed: request.seed,
            sentAtEpochMs: epochNowMs(),
          };
          const requestBytes = requestPayloadBytes(message);
          const started = performance.now();
          worker.postMessage(message);
          requests.push({
            id: request.id,
            snapshotId: record.snapshotId,
            revision: record.revision,
            requestPayloadBytes: requestBytes,
            requestPostMs: performance.now() - started,
          });
        },
        dispose() {
          worker.setMessageHandler(null);
          worker.terminate();
        },
      };
    },
    candidateMetrics() {
      return {
        transport: "versioned-snapshot-real-worker",
        snapshotPreparationCount: snapshots.events.length,
        sameRevisionRequests: snapshots.sameRevisionRequests,
        registrationCount: snapshotSends.filter((event) => event.operation === "register").length,
        updateCount: snapshotSends.filter((event) => event.operation === "update").length,
        registrationUpdateProtocolBytes: snapshotSends.reduce((sum, event) => sum + event.protocolPayloadBytes, 0),
        requestProtocolBytes: requests.reduce((sum, request) => sum + request.requestPayloadBytes, 0),
        snapshotFullPayloadBytes: snapshotSends
          .filter((event) => event.operation === "register")
          .reduce((sum, event) => sum + event.snapshotPayloadBytes, 0),
        snapshotDeltaPayloadBytes: snapshotSends
          .filter((event) => event.operation === "update")
          .reduce((sum, event) => sum + event.deltaEntries * 5, 0),
        mainRetainedSnapshotCount: snapshots.retainedSnapshotCount,
        mainRetainedSnapshotBytes: snapshots.currentSnapshotBytes,
        workerComputeTimeMeasured: true,
      };
    },
    protocolTelemetry() {
      return {
        snapshotPreparations: snapshots.events,
        snapshotSends: snapshotSends.map((event) => ({ ...event })),
        snapshotAcks: snapshotAcks.map((event) => ({ ...event })),
        requests: requests.map((event) => ({ ...event })),
        responses: responses.map((event) => ({ ...event })),
        mainRetainedSnapshotCount: snapshots.retainedSnapshotCount,
        mainRetainedSnapshotBytes: snapshots.currentSnapshotBytes,
        sameRevisionRequests: snapshots.sameRevisionRequests,
        transferMode: "full registration structured-cloned once; delta buffers and response waypoints transferred; scalar requests cloned",
      };
    },
    dispose() {
      activeWorker?.setMessageHandler(null);
      activeWorker?.terminate();
      activeWorker = undefined;
    },
  };
}

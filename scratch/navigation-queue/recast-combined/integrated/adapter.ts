import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import type { CandidateContext, MovementCandidateAdapter } from "../../../full-game-movement/harness/types";
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
import { postCombinedResult } from "./combined.worker";
import { CombinedSnapshotWorker, type CombinedPathEngine } from "./worker-handler";

export interface CombinedRouteRecord {
  readonly id: number;
  readonly ok: boolean;
  readonly cost: number;
  readonly waypoints: readonly number[];
}

export interface VersionedRequestTelemetry {
  readonly id: number;
  readonly snapshotId: number;
  readonly revision: number;
  readonly dueTick: number;
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

export interface CombinedProtocolTelemetry {
  readonly snapshotPreparations: readonly SnapshotPreparationEvent[];
  readonly snapshotSends: readonly SnapshotSendTelemetry[];
  readonly snapshotAcks: readonly SnapshotAckMessage[];
  readonly requests: readonly VersionedRequestTelemetry[];
  readonly responses: readonly VersionedResponseTelemetry[];
  readonly errors: readonly string[];
  readonly mainRetainedSnapshotCount: number;
  readonly mainRetainedSnapshotBytes: number;
  readonly sameRevisionRequests: number;
  readonly transferMode: string;
}

export interface CombinedRecastCandidate extends MovementCandidateAdapter {
  readonly snapshots: MainSnapshotCache;
  readonly ready: Promise<void>;
  readonly routes: readonly CombinedRouteRecord[];
  protocolTelemetry(): CombinedProtocolTelemetry;
}

export function createBrowserCombinedWorkerFactory(): VersionedWorkerFactory {
  return () => {
    const worker = new Worker(new URL("./combined.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage(message, transfer) {
        if (transfer) worker.postMessage(message, [...transfer]);
        else worker.postMessage(message);
      },
      setMessageHandler(handler) {
        worker.onmessage = handler ? (event) => handler({ data: event.data as VersionedWorkerMessage }) : null;
        worker.onerror = (event) => handler?.({ data: { kind: "error", phase: "initialization", message: `worker error: ${event.message}` } });
        worker.onmessageerror = () => handler?.({ data: { kind: "error", phase: "request", message: "worker response could not be deserialized" } });
      },
      terminate: () => worker.terminate(),
    };
  };
}

/** In-process protocol transport for correctness tests only, never browser timing evidence. */
export function createLocalCombinedWorkerFactory(delayMs = 0, engineFactory?: () => CombinedPathEngine): VersionedWorkerFactory {
  return () => {
    const handler = new CombinedSnapshotWorker(2, engineFactory);
    let receive: ((event: { data: VersionedWorkerMessage }) => void) | null = null;
    let disposed = false;
    return {
      postMessage(message) {
        const deliver = () => {
          if (!disposed) postCombinedResult((output) => receive?.({ data: output }), message, handler);
        };
        if (delayMs > 0) setTimeout(deliver, delayMs);
        else deliver();
      },
      setMessageHandler(next) {
        receive = next;
        if (next) queueMicrotask(() => receive?.({ data: { kind: "ready", initializationMs: 0, recastNavigationVersion: "0.43.0", wasm: "@recast-navigation/wasm-compat" } }));
      },
      terminate() {
        disposed = true;
        handler.dispose();
      },
    };
  };
}

export function createCombinedRecastCandidate(factory: VersionedWorkerFactory = createBrowserCombinedWorkerFactory()): CombinedRecastCandidate {
  const snapshots = new MainSnapshotCache();
  const snapshotSends: SnapshotSendTelemetry[] = [];
  const snapshotAcks: SnapshotAckMessage[] = [];
  const requests: VersionedRequestTelemetry[] = [];
  const responses: VersionedResponseTelemetry[] = [];
  const routes: CombinedRouteRecord[] = [];
  const errors: string[] = [];
  let activeWorker: ReturnType<VersionedWorkerFactory> | undefined;
  let latestMetrics: Readonly<Record<string, number | string | boolean>> = {};
  let initializationMs = 0;
  let fatalError: Error | undefined;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (message: string): void => {
    errors.push(message);
    fatalError = new Error(message);
    if (!readySettled) {
      readySettled = true;
      rejectReady(fatalError);
    }
  };
  const readinessTimeout = setTimeout(() => fail("combined Recast worker readiness timed out after 30000 ms"), 30_000);
  void ready.finally(() => clearTimeout(readinessTimeout)).catch(() => {});
  const worker = factory();
  activeWorker = worker;
  worker.setMessageHandler((event) => {
    const message = event.data;
    if (message.kind === "ready") {
      initializationMs = message.initializationMs;
      latestMetrics = { recastNavigationVersion: message.recastNavigationVersion, wasmPackaging: message.wasm };
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
    } else if (message.kind === "error") {
      fail(`combined Recast worker ${message.phase} failure: ${message.message}`);
    }
  });

  return {
    id: "combined-exact-tile-recast-versioned-snapshots",
    snapshots,
    ready,
    routes,
    createTransport(context: CandidateContext) {
      let workerSnapshotId = 0;
      let responseReceiver: ((response: PathResponse) => void) | undefined;
      const responsesById = new Map<number, VersionedResponseTelemetry>();
      worker.setMessageHandler((event) => {
        const message = event.data;
        if (message.kind === "ready") {
          initializationMs = message.initializationMs;
          latestMetrics = { ...latestMetrics, recastNavigationVersion: message.recastNavigationVersion, wasmPackaging: message.wasm };
          if (!readySettled) {
            readySettled = true;
            resolveReady();
          }
        } else if (message.kind === "error") {
          fail(`combined Recast worker ${message.phase} failure${message.requestId === undefined ? "" : ` at request ${message.requestId}`}: ${message.message}`);
        } else if (message.kind === "snapshot-ack") {
          snapshotAcks.push(message);
        } else if (message.kind === "path-post-telemetry") {
          const response = responsesById.get(message.id);
          if (response) response.responsePostMs = message.responsePostMs;
        } else {
          latestMetrics = message.engineMetrics;
          routes.push({ id: message.response.id, ok: message.response.ok, cost: message.response.cost, waypoints: Array.from(message.response.waypoints) });
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
        attach(receive) { responseReceiver = receive; },
        send(request: PathRequest) {
          if (fatalError) throw fatalError;
          context.onRequest(request);
          const record = snapshots.resolve(request.passable);
          if (record.snapshotId !== workerSnapshotId) {
            const preparation = snapshots.events.find((event) => event.snapshotId === record.snapshotId)!;
            const started = performance.now();
            let protocolPayloadBytes: number;
            if (record.baseSnapshotId === undefined) {
              const message = { kind: "snapshot-register" as const, snapshotId: record.snapshotId, revision: record.revision, plane: record.plane, width: record.width, passable: record.passable.buffer as ArrayBuffer };
              protocolPayloadBytes = registrationPayloadBytes(message);
              worker.postMessage(message);
            } else {
              const message = { kind: "snapshot-update" as const, snapshotId: record.snapshotId, baseSnapshotId: record.baseSnapshotId, revision: record.revision, baseRevision: record.baseRevision!, plane: record.plane, width: record.width, indices: record.indices, values: record.values };
              protocolPayloadBytes = updatePayloadBytes(message);
              worker.postMessage(message, [record.indices.buffer, record.values.buffer]);
            }
            snapshotSends.push({ snapshotId: record.snapshotId, revision: record.revision, operation: record.baseSnapshotId === undefined ? "register" : "update", protocolPayloadBytes, snapshotPayloadBytes: preparation.snapshotBytes, deltaEntries: preparation.deltaEntries, mainPostMs: performance.now() - started, mainCopyMs: preparation.copyMs, mainDiffMs: preparation.diffMs });
            workerSnapshotId = record.snapshotId;
          }
          const message = { kind: "versioned-path" as const, id: request.id, dueTick: request.dueTick, startX: request.startX, startY: request.startY, goalX: request.goalX, goalY: request.goalY, snapshotId: record.snapshotId, passableVersion: request.passableVersion, plane: record.plane, seed: request.seed, sentAtEpochMs: epochNowMs() };
          const requestBytes = requestPayloadBytes(message);
          const started = performance.now();
          worker.postMessage(message);
          requests.push({ id: request.id, snapshotId: record.snapshotId, revision: record.revision, dueTick: request.dueTick, requestPayloadBytes: requestBytes, requestPostMs: performance.now() - started });
        },
        dispose() {
          worker.setMessageHandler(null);
          worker.terminate();
        },
      };
    },
    beforeFrame() { if (fatalError) throw fatalError; },
    candidateMetrics() {
      return {
        transport: "acknowledged-versioned-full-delta-real-module-worker",
        snapshotPreparationCount: snapshots.events.length,
        sameRevisionRequests: snapshots.sameRevisionRequests,
        registrationCount: snapshotSends.filter((event) => event.operation === "register").length,
        updateCount: snapshotSends.filter((event) => event.operation === "update").length,
        registrationUpdateProtocolBytes: snapshotSends.reduce((sum, event) => sum + event.protocolPayloadBytes, 0),
        requestProtocolBytes: requests.reduce((sum, request) => sum + request.requestPayloadBytes, 0),
        snapshotFullPayloadBytes: snapshotSends.filter((event) => event.operation === "register").reduce((sum, event) => sum + event.snapshotPayloadBytes, 0),
        snapshotDeltaPayloadBytes: snapshotSends.filter((event) => event.operation === "update").reduce((sum, event) => sum + event.deltaEntries * 5, 0),
        mainRetainedSnapshotCount: snapshots.retainedSnapshotCount,
        mainRetainedSnapshotBytes: snapshots.currentSnapshotBytes,
        workerComputeTimeMeasured: true,
        wasmInitializationMs: initializationMs,
        workerErrorCount: errors.length,
        ...latestMetrics,
      };
    },
    protocolTelemetry() {
      return {
        snapshotPreparations: snapshots.events,
        snapshotSends: snapshotSends.map((event) => ({ ...event })),
        snapshotAcks: snapshotAcks.map((event) => ({ ...event })),
        requests: requests.map((event) => ({ ...event })),
        responses: responses.map((event) => ({ ...event })),
        errors: [...errors],
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

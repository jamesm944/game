import { createPathEngine, type PathEngine } from "../../src/sim/path/engine";
import type { PathResponse } from "../../src/sim/path/protocol";
import {
  epochNowMs,
  responsePayloadBytes,
  type BatchPathMessage,
  type PathResultsMessage,
  type QueuePathRequest,
  type QueuePathResultItem,
  type QueueWorkerMessage,
  type QueueWorkerRequest,
  type SnapshotAckMessage,
  type SnapshotHandle,
  type SnapshotPlane,
  type SnapshotRegisterMessage,
  type SnapshotUpdateMessage,
} from "./protocol";

interface StoredSnapshot {
  readonly handle: SnapshotHandle;
  readonly passable: Uint8Array;
}

export const WORKER_SNAPSHOT_CAPACITY = 2;
export const MAX_BATCH_SIZE = 64;

export class NavigationQueueWorker {
  readonly #planes = new Map<SnapshotPlane, Map<number, StoredSnapshot>>();
  readonly #engines = new Map<SnapshotPlane, PathEngine>();
  readonly #capacity: number;
  #coalescedRequests = 0;

  constructor(capacity = WORKER_SNAPSHOT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("invalid snapshot capacity");
    this.#capacity = capacity;
  }

  handle(message: QueueWorkerRequest): QueueWorkerMessage {
    if (message.kind === "snapshot-register") return this.#register(message);
    if (message.kind === "snapshot-update") return this.#update(message);
    if (message.kind === "path") return this.#paths({ kind: "path-batch", batchId: 0, requests: [message] });
    return this.#paths(message);
  }

  #snapshots(plane: SnapshotPlane): Map<number, StoredSnapshot> {
    let snapshots = this.#planes.get(plane);
    if (!snapshots) {
      snapshots = new Map();
      this.#planes.set(plane, snapshots);
    }
    return snapshots;
  }

  #ack(
    message: SnapshotRegisterMessage | SnapshotUpdateMessage,
    operation: "register" | "update",
    started: number,
  ): SnapshotAckMessage {
    const snapshots = this.#snapshots(message.handle.plane);
    return {
      kind: "snapshot-ack",
      snapshotId: message.handle.snapshotId,
      revision: message.handle.revision,
      plane: message.handle.plane,
      operation,
      binaryPayloadBytes: operation === "register"
        ? (message as SnapshotRegisterMessage).passable.byteLength
        : (message as SnapshotUpdateMessage).indices.byteLength + (message as SnapshotUpdateMessage).values.byteLength,
      deltaEntries: operation === "update" ? (message as SnapshotUpdateMessage).indices.length : 0,
      workerHandlingMs: performance.now() - started,
      snapshotCount: snapshots.size,
      snapshotBytes: [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.passable.byteLength, 0),
    };
  }

  #register(message: SnapshotRegisterMessage): SnapshotAckMessage {
    const started = performance.now();
    const { handle } = message;
    const snapshots = this.#snapshots(handle.plane);
    const duplicate = snapshots.get(handle.snapshotId);
    if (duplicate) {
      if (duplicate.handle.revision !== handle.revision) throw new Error("snapshot ID reused");
      return this.#ack(message, "register", started);
    }
    for (const snapshot of snapshots.values()) {
      if (snapshot.handle.revision >= handle.revision) throw new Error("snapshot revisions must increase");
    }
    if (message.passable.byteLength !== handle.width * handle.width) throw new Error("snapshot size mismatch");
    snapshots.set(handle.snapshotId, { handle, passable: new Uint8Array(message.passable) });
    this.#evict(snapshots);
    return this.#ack(message, "register", started);
  }

  #update(message: SnapshotUpdateMessage): SnapshotAckMessage {
    const started = performance.now();
    const { handle } = message;
    const snapshots = this.#snapshots(handle.plane);
    const duplicate = snapshots.get(handle.snapshotId);
    if (duplicate) return this.#ack(message, "update", started);
    const base = snapshots.get(message.baseSnapshotId);
    if (!base || base.handle.revision !== message.baseRevision || base.handle.plane !== handle.plane) {
      throw new Error("update base is missing or mismatched");
    }
    if (handle.revision <= base.handle.revision || message.indices.length !== message.values.length) {
      throw new Error("invalid update revision or delta");
    }
    const next = base.passable.slice();
    for (let offset = 0; offset < message.indices.length; offset += 1) {
      const index = message.indices[offset]!;
      if (index >= next.length) throw new Error("delta index outside snapshot");
      next[index] = message.values[offset]!;
    }
    snapshots.set(handle.snapshotId, { handle, passable: next });
    this.#evict(snapshots);
    return this.#ack(message, "update", started);
  }

  #evict(snapshots: Map<number, StoredSnapshot>): void {
    while (snapshots.size > this.#capacity) {
      const oldest = snapshots.keys().next();
      if (oldest.done) break;
      snapshots.delete(oldest.value);
    }
  }

  #coalescingKey(request: QueuePathRequest): string {
    return JSON.stringify([
      request.snapshot.snapshotId, request.snapshot.revision, request.snapshot.plane,
      request.dueTick, request.startX, request.startY, request.goalX, request.goalY,
      request.seed, request.requestClass, request.groupKey,
    ]);
  }

  #paths(message: BatchPathMessage): PathResultsMessage {
    if (message.requests.length < 1 || message.requests.length > MAX_BATCH_SIZE) throw new Error("invalid batch size");
    const receivedAt = epochNowMs();
    const firstByKey = new Map<string, QueuePathResultItem>();
    const items: QueuePathResultItem[] = [];
    for (const request of message.requests) {
      const snapshot = this.#snapshots(request.snapshot.plane).get(request.snapshot.snapshotId);
      if (!snapshot || snapshot.handle.revision !== request.snapshot.revision) {
        throw new Error(`unregistered snapshot ${request.snapshot.snapshotId}@${request.snapshot.revision}`);
      }
      let engine = this.#engines.get(request.snapshot.plane);
      if (!engine) {
        engine = createPathEngine();
        this.#engines.set(request.snapshot.plane, engine);
      }
      const key = this.#coalescingKey(request);
      const first = firstByKey.get(key);
      const computeStarted = performance.now();
      let response: PathResponse;
      let coalescedFromId: number | undefined;
      if (first) {
        response = {
          ...first.response,
          id: request.id,
          waypoints: first.response.waypoints.slice(),
        };
        coalescedFromId = first.response.id;
        this.#coalescedRequests += 1;
      } else {
        response = engine.handle({
          kind: "path",
          id: request.id,
          dueTick: request.dueTick,
          startX: request.startX,
          startY: request.startY,
          goalX: request.goalX,
          goalY: request.goalY,
          seed: request.seed,
          passable: snapshot.passable,
          passableVersion: snapshot.handle.revision,
        });
      }
      const item: QueuePathResultItem = {
        response,
        requestClass: request.requestClass,
        workerQueueMs: receivedAt - request.sentAtEpochMs,
        computeMs: performance.now() - computeStarted,
        workerSentAtEpochMs: 0,
        responsePayloadBytes: responsePayloadBytes(response),
        ...(coalescedFromId !== undefined ? { coalescedFromId } : {}),
      };
      if (!first) firstByKey.set(key, item);
      items.push(item);
    }
    const sentAt = epochNowMs();
    return {
      kind: "path-results",
      batchId: message.batchId,
      batchSize: message.requests.length,
      items: items.map((item) => ({ ...item, workerSentAtEpochMs: sentAt })),
      pathCacheSize: [...this.#engines.values()].reduce((sum, engine) => sum + engine.cacheSize, 0),
      snapshotCount: this.snapshotCount(),
      snapshotBytes: this.snapshotBytes(),
    };
  }

  get coalescedRequests(): number {
    return this.#coalescedRequests;
  }

  snapshotCount(plane?: SnapshotPlane): number {
    const maps = plane ? [this.#snapshots(plane)] : [...this.#planes.values()];
    return maps.reduce((sum, snapshots) => sum + snapshots.size, 0);
  }

  snapshotBytes(plane?: SnapshotPlane): number {
    const maps = plane ? [this.#snapshots(plane)] : [...this.#planes.values()];
    return maps.reduce((total, snapshots) => total
      + [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.passable.byteLength, 0), 0);
  }
}

import { createPathEngine, type PathEngine } from "../../../src/sim/path/engine";
import type { PathResponse } from "../../../src/sim/path/protocol";
import {
  responsePayloadBytes,
  type SnapshotAckMessage,
  type SnapshotPlane,
  type SnapshotRegisterMessage,
  type SnapshotUpdateMessage,
  type VersionedPathRequestMessage,
  type VersionedPathResultMessage,
  type VersionedWorkerRequest,
} from "./protocol";

interface StoredSnapshot {
  readonly snapshotId: number;
  readonly revision: number;
  readonly plane: SnapshotPlane;
  readonly width: number;
  readonly passable: Uint8Array;
}

export const SNAPSHOT_REVISION_CAPACITY = 2;

/** Pure worker-side protocol handler; production A* remains the only path engine. */
export class VersionedSnapshotWorker {
  readonly #planes = new Map<SnapshotPlane, Map<number, StoredSnapshot>>();
  readonly #engines = new Map<SnapshotPlane, PathEngine>();
  readonly #capacity: number;

  constructor(capacity = SNAPSHOT_REVISION_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("invalid snapshot capacity");
    this.#capacity = capacity;
  }

  handle(message: VersionedWorkerRequest): SnapshotAckMessage | VersionedPathResultMessage {
    if (message.kind === "snapshot-register") return this.#register(message);
    if (message.kind === "snapshot-update") return this.#update(message);
    return this.#path(message);
  }

  #planeSnapshots(plane: SnapshotPlane): Map<number, StoredSnapshot> {
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
    deltaEntries: number,
  ): SnapshotAckMessage {
    const snapshots = this.#planeSnapshots(message.plane);
    return {
      kind: "snapshot-ack",
      snapshotId: message.snapshotId,
      revision: message.revision,
      plane: message.plane,
      operation,
      snapshotPayloadBytes: operation === "register"
        ? (message as SnapshotRegisterMessage).passable.byteLength
        : (message as SnapshotUpdateMessage).indices.byteLength
          + (message as SnapshotUpdateMessage).values.byteLength,
      deltaEntries,
      workerHandlingMs: performance.now() - started,
      snapshotCount: snapshots.size,
      snapshotBytes: [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.passable.byteLength, 0),
    };
  }

  #register(message: SnapshotRegisterMessage): SnapshotAckMessage {
    const started = performance.now();
    const snapshots = this.#planeSnapshots(message.plane);
    const existing = snapshots.get(message.snapshotId);
    if (existing) {
      if (existing.revision !== message.revision) throw new Error("snapshot ID reused for another revision");
      return this.#ack(message, "register", started, 0);
    }
    for (const snapshot of snapshots.values()) {
      if (snapshot.revision >= message.revision) throw new Error("snapshot revisions must increase");
    }
    if (message.passable.byteLength !== message.width * message.width) {
      throw new Error("registration dimensions do not match payload");
    }
    snapshots.set(message.snapshotId, {
      snapshotId: message.snapshotId,
      revision: message.revision,
      plane: message.plane,
      width: message.width,
      passable: new Uint8Array(message.passable),
    });
    this.#evict(snapshots);
    return this.#ack(message, "register", started, 0);
  }

  #update(message: SnapshotUpdateMessage): SnapshotAckMessage {
    const started = performance.now();
    const snapshots = this.#planeSnapshots(message.plane);
    const duplicate = snapshots.get(message.snapshotId);
    if (duplicate) {
      if (duplicate.revision !== message.revision) throw new Error("snapshot ID reused for another revision");
      return this.#ack(message, "update", started, message.indices.length);
    }
    const base = snapshots.get(message.baseSnapshotId);
    if (!base || base.revision !== message.baseRevision || base.plane !== message.plane) {
      throw new Error("update base snapshot is absent or mismatched");
    }
    if (message.revision <= base.revision) throw new Error("update revision must increase");
    if (message.indices.length !== message.values.length) throw new Error("delta index/value length mismatch");
    // Copy once per worker revision so the retained base revision remains immutable.
    const next = base.passable.slice();
    for (let offset = 0; offset < message.indices.length; offset += 1) {
      const index = message.indices[offset]!;
      if (index >= next.length) throw new Error("delta index outside snapshot");
      next[index] = message.values[offset]!;
    }
    snapshots.set(message.snapshotId, {
      snapshotId: message.snapshotId,
      revision: message.revision,
      plane: message.plane,
      width: base.width,
      passable: next,
    });
    this.#evict(snapshots);
    return this.#ack(message, "update", started, message.indices.length);
  }

  #evict(snapshots: Map<number, StoredSnapshot>): void {
    while (snapshots.size > this.#capacity) {
      const oldest = snapshots.keys().next();
      if (oldest.done) break;
      snapshots.delete(oldest.value);
    }
  }

  #path(message: VersionedPathRequestMessage): VersionedPathResultMessage {
    const receivedAt = performance.timeOrigin + performance.now();
    const snapshots = this.#planeSnapshots(message.plane);
    const snapshot = snapshots.get(message.snapshotId);
    if (!snapshot || snapshot.revision !== message.passableVersion) {
      throw new Error(`snapshot ${message.snapshotId}@${message.passableVersion} is not registered`);
    }
    let engine = this.#engines.get(message.plane);
    if (!engine) {
      engine = createPathEngine();
      this.#engines.set(message.plane, engine);
    }
    const computeStarted = performance.now();
    const response: PathResponse = engine.handle({
      kind: "path",
      id: message.id,
      dueTick: message.dueTick,
      startX: message.startX,
      startY: message.startY,
      goalX: message.goalX,
      goalY: message.goalY,
      passable: snapshot.passable,
      passableVersion: snapshot.revision,
      seed: message.seed,
    });
    const computeMs = performance.now() - computeStarted;
    return {
      kind: "versioned-path-result",
      response,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      workerQueueMs: receivedAt - message.sentAtEpochMs,
      computeMs,
      responsePayloadBytes: responsePayloadBytes(response),
      pathCacheSize: engine.cacheSize,
      snapshotCount: snapshots.size,
      snapshotBytes: [...snapshots.values()].reduce((sum, entry) => sum + entry.passable.byteLength, 0),
    };
  }

  snapshotCount(plane: SnapshotPlane = "land"): number {
    return this.#planeSnapshots(plane).size;
  }

  snapshotBytes(plane: SnapshotPlane = "land"): number {
    return [...this.#planeSnapshots(plane).values()]
      .reduce((sum, snapshot) => sum + snapshot.passable.byteLength, 0);
  }
}

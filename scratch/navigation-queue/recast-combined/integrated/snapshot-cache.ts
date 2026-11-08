import type { PathScheduler } from "../../../../src/sim/path/scheduler";
import type { SnapshotPlane } from "./protocol";

export interface MainSnapshotRecord {
  readonly snapshotId: number;
  readonly revision: number;
  readonly baseSnapshotId?: number;
  readonly baseRevision?: number;
  readonly plane: SnapshotPlane;
  readonly width: number;
  readonly passable: Uint8Array;
  readonly indices: Uint32Array;
  readonly values: Uint8Array;
  readonly copyMs: number;
  readonly diffMs: number;
}

export interface SnapshotPreparationEvent {
  readonly snapshotId: number;
  readonly revision: number;
  readonly baseRevision?: number;
  readonly plane: SnapshotPlane;
  readonly operation: "register" | "update";
  readonly snapshotBytes: number;
  readonly deltaEntries: number;
  readonly deltaPayloadBytes: number;
  readonly copyMs: number;
  readonly diffMs: number;
}

/**
 * Owns one private same-revision main-thread snapshot. The previous record is
 * replaced only after a one-copy diff; older arrays are not strongly retained.
 */
export class MainSnapshotCache {
  readonly #byArray = new WeakMap<Uint8Array, MainSnapshotRecord>();
  readonly #events: SnapshotPreparationEvent[] = [];
  #current: MainSnapshotRecord | undefined;
  #nextSnapshotId = 0;
  #sameRevisionRequests = 0;

  prepare(revision: number, source: Uint8Array, plane: SnapshotPlane = "land"): MainSnapshotRecord {
    const current = this.#current;
    if (current && current.revision === revision && current.plane === plane) {
      this.#sameRevisionRequests += 1;
      return current;
    }
    const width = Math.sqrt(source.length);
    if (!Number.isInteger(width) || width < 1) throw new Error("snapshot must be a non-empty square grid");
    const copyStarted = performance.now();
    const copied = source.slice();
    const copyMs = performance.now() - copyStarted;
    const diffStarted = performance.now();
    const changed: number[] = [];
    if (current && current.plane === plane) {
      if (current.passable.length !== copied.length) throw new Error("snapshot dimensions changed");
      for (let index = 0; index < copied.length; index += 1) {
        if (current.passable[index] !== copied[index]) changed.push(index);
      }
    }
    const diffMs = performance.now() - diffStarted;
    const record: MainSnapshotRecord = {
      snapshotId: ++this.#nextSnapshotId,
      revision,
      ...(current ? { baseSnapshotId: current.snapshotId, baseRevision: current.revision } : {}),
      plane,
      width,
      passable: copied,
      indices: Uint32Array.from(changed),
      values: Uint8Array.from(changed.map((index) => copied[index]!)),
      copyMs,
      diffMs,
    };
    // Narrow scratch adaptation: production requestPath still owns IDs,
    // buffering, due ticks, and stale gates, but slice() returns the already
    // private immutable-by-ownership revision instead of copying per request.
    Object.defineProperty(copied, "slice", {
      value: () => copied,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    this.#byArray.set(copied, record);
    this.#current = record;
    this.#events.push({
      snapshotId: record.snapshotId,
      revision,
      ...(record.baseRevision !== undefined ? { baseRevision: record.baseRevision } : {}),
      plane,
      operation: current ? "update" : "register",
      snapshotBytes: copied.byteLength,
      deltaEntries: changed.length,
      deltaPayloadBytes: record.indices.byteLength + record.values.byteLength,
      copyMs,
      diffMs,
    });
    return record;
  }

  resolve(passable: Uint8Array): MainSnapshotRecord {
    const record = this.#byArray.get(passable);
    if (!record) throw new Error("request did not use a registered scratch snapshot");
    return record;
  }

  get events(): readonly SnapshotPreparationEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  get sameRevisionRequests(): number {
    return this.#sameRevisionRequests;
  }

  get currentSnapshotBytes(): number {
    return this.#current?.passable.byteLength ?? 0;
  }

  get retainedSnapshotCount(): number {
    return this.#current ? 1 : 0;
  }
}

/** Install only the snapshot-copy seam; all other production scheduler behavior stays intact. */
export function installVersionedSnapshotScheduler(
  scheduler: PathScheduler,
  cache: MainSnapshotCache,
  plane: SnapshotPlane = "land",
): void {
  const original = scheduler.requestPath.bind(scheduler);
  scheduler.requestPath = (input, options) => original(input, {
    ...options,
    passability: cache.prepare(scheduler.passabilityVersion, options.passability, plane).passable,
  });
}

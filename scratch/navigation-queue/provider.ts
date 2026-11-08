import type { SnapshotHandle, SnapshotPlane } from "./protocol";

export interface SnapshotPreparation {
  readonly handle: SnapshotHandle;
  readonly baseSnapshotId?: number;
  readonly baseRevision?: number;
  /** Private immutable-by-ownership data; never part of a clean path request. */
  readonly passable: Uint8Array;
  readonly indices: Uint32Array;
  readonly values: Uint8Array;
  readonly copyMs: number;
  readonly diffMs: number;
}

export interface SnapshotPreparationEvent {
  readonly handle: SnapshotHandle;
  readonly baseRevision?: number;
  readonly operation: "register" | "update";
  readonly snapshotBytes: number;
  readonly deltaEntries: number;
  readonly deltaPayloadBytes: number;
  readonly copyMs: number;
  readonly diffMs: number;
}

/**
 * Clean production seam: the scheduler asks this provider for a handle and
 * sends SnapshotHandle in PathRequest. There is no slice compatibility here.
 */
export class SchedulerOwnedSnapshotProvider {
  readonly #current = new Map<SnapshotPlane, SnapshotPreparation>();
  readonly #events: SnapshotPreparationEvent[] = [];
  #nextSnapshotId = 0;
  #sameRevisionRequests = 0;

  prepare(revision: number, plane: SnapshotPlane, source: Uint8Array): SnapshotPreparation {
    const current = this.#current.get(plane);
    if (current?.handle.revision === revision) {
      this.#sameRevisionRequests += 1;
      return current;
    }
    const width = Math.sqrt(source.length);
    if (!Number.isInteger(width) || width < 1) throw new Error("snapshot must be a non-empty square grid");
    const copyStarted = performance.now();
    const passable = source.slice();
    const copyMs = performance.now() - copyStarted;
    const diffStarted = performance.now();
    const changed: number[] = [];
    if (current) {
      if (current.passable.length !== passable.length) throw new Error("snapshot dimensions changed");
      for (let index = 0; index < passable.length; index += 1) {
        if (current.passable[index] !== passable[index]) changed.push(index);
      }
    }
    const diffMs = performance.now() - diffStarted;
    const preparation: SnapshotPreparation = {
      handle: { snapshotId: ++this.#nextSnapshotId, revision, plane, width },
      ...(current ? {
        baseSnapshotId: current.handle.snapshotId,
        baseRevision: current.handle.revision,
      } : {}),
      passable,
      indices: Uint32Array.from(changed),
      values: Uint8Array.from(changed.map((index) => passable[index]!)),
      copyMs,
      diffMs,
    };
    this.#current.set(plane, preparation);
    this.#events.push({
      handle: preparation.handle,
      ...(preparation.baseRevision !== undefined ? { baseRevision: preparation.baseRevision } : {}),
      operation: current ? "update" : "register",
      snapshotBytes: passable.byteLength,
      deltaEntries: changed.length,
      deltaPayloadBytes: preparation.indices.byteLength + preparation.values.byteLength,
      copyMs,
      diffMs,
    });
    return preparation;
  }

  get events(): readonly SnapshotPreparationEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  get sameRevisionRequests(): number {
    return this.#sameRevisionRequests;
  }

  get retainedSnapshotCount(): number {
    return this.#current.size;
  }

  get retainedSnapshotBytes(): number {
    return [...this.#current.values()].reduce((sum, current) => sum + current.passable.byteLength, 0);
  }
}

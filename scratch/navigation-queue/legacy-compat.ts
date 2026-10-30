import type { PathScheduler } from "../../src/sim/path/scheduler";
import type { SnapshotPlane } from "./protocol";
import type { SchedulerOwnedSnapshotProvider, SnapshotPreparation } from "./provider";

/**
 * Runnable-only adapter for today's PathRequest.passable + per-request slice.
 * The clean provider/worker/request union does not depend on this shim.
 */
export class LegacySnapshotCompatibility {
  readonly #byArray = new WeakMap<Uint8Array, SnapshotPreparation>();
  constructor(readonly provider: SchedulerOwnedSnapshotProvider) {}

  prepare(revision: number, plane: SnapshotPlane, source: Uint8Array): SnapshotPreparation {
    const preparation = this.provider.prepare(revision, plane, source);
    if (!this.#byArray.has(preparation.passable)) {
      Object.defineProperty(preparation.passable, "slice", {
        value: () => preparation.passable,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      this.#byArray.set(preparation.passable, preparation);
    }
    return preparation;
  }

  resolve(passable: Uint8Array): SnapshotPreparation {
    const preparation = this.#byArray.get(passable);
    if (!preparation) throw new Error("legacy request lacks a provider snapshot");
    return preparation;
  }
}

export function installLegacySnapshotCompatibility(
  scheduler: PathScheduler,
  compatibility: LegacySnapshotCompatibility,
  plane: SnapshotPlane = "land",
): void {
  const original = scheduler.requestPath.bind(scheduler);
  scheduler.requestPath = (input, options) => original(input, {
    ...options,
    passability: compatibility.prepare(scheduler.passabilityVersion, plane, options.passability).passable,
  });
}

import { PathScheduler, type PathTransport } from "../../../src/sim/path/scheduler";
import type { PathRequestInput } from "../../../src/sim/path/scheduler";
import type { PathApplyFn } from "../../../src/sim/path/scheduler";
import type { SnapshotPreparation } from "./provider";
import { SchedulerOwnedSnapshotProvider } from "./provider";

/**
 * Experimental scheduler subclass: production owns IDs, outstanding requests,
 * due ticks, stale discard, blocking, and ascending application. This override
 * only replaces snapshot selection. The provider's current-send union lets the
 * transport discard PathRequest.passable and send a SnapshotHandle instead.
 * No Uint8Array method is overridden.
 */
export class HandlePathScheduler extends PathScheduler {
  #current: SnapshotPreparation | undefined;

  constructor(transport: PathTransport, readonly provider: SchedulerOwnedSnapshotProvider) {
    super(transport);
  }

  get currentSnapshot(): SnapshotPreparation {
    if (!this.#current) throw new Error("path send is not associated with a scheduler snapshot");
    return this.#current;
  }

  override requestPath(
    input: PathRequestInput,
    options: Readonly<{
      issueTick: number;
      seed: number;
      passability: Uint8Array;
      onApply: PathApplyFn;
      onDiscard?: (() => void) | undefined;
    }>,
  ): number {
    const preparation = this.provider.prepare(this.passabilityVersion, "land", options.passability);
    const previous = this.#current;
    this.#current = preparation;
    try {
      // Normal production copying remains intact; the copied array is telemetry-
      // only at this seam. The queue transport sends preparation.handle.
      return super.requestPath(input, { ...options, passability: preparation.passable });
    } finally {
      this.#current = previous;
    }
  }
}

/**
 * Main-thread path scheduler — SPEC §2.2 / ADR-0003/0004.
 *
 * Owns the FIFO request stream (monotonically increasing ids), the
 * response inbox and the dueTick/blocking contract:
 *
 * - Responses may arrive in any order; they are buffered keyed by id.
 * - `pump(currentTick)` runs inside `step()` BEFORE the movement system
 *   and applies buffered responses strictly in ascending-id order while
 *   their `dueTick ≤ currentTick`.
 * - If the next-in-order response is due but missing, the tick is
 *   BLOCKED: the caller must not advance world state and must retry the
 *   same boundary next frame (never a spin-wait — one attempt per
 *   frame, counted in `blockedTicks`). Later-in-order responses are
 *   held until every earlier id has been applied.
 * - Responses computed against a passability version other than the
 *   current one are discarded on application (their world has ceased to
 *   exist); ordering still advances past them.
 *
 * The transport that carries requests to a worker (or computes them
 * inline for headless determinism) is injected — this module never
 * constructs browser objects itself.
 */

import { createPathEngine } from "./engine";
import { PATH_LATENCY, type PathRequest, type PathResponse } from "./protocol";

/** Callback invoked once per applied (non-stale) response, ascending-id. */
export type PathApplyFn = (response: PathResponse) => void;

export interface PathRequestInput {
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
}

interface OutstandingRequest {
  readonly id: number;
  readonly dueTick: number;
  readonly passableVersion: number;
  readonly onApply: PathApplyFn;
  /**
   * Called INSTEAD of onApply when the response arrives version-stale
   * and is discarded. Requesters that hold per-unit state while a
   * response is in flight MUST release it here — otherwise a mid-flight
   * passability bump freezes the requester forever.
   */
  readonly onDiscard?: (() => void) | undefined;
}

/** How issued requests leave the main thread. */
export interface PathTransport {
  /** Called by the scheduler before the first send. */
  attach(receive: (response: PathResponse) => void): void;
  send(request: PathRequest): void;
  /** Stop the underlying worker (no-op for synchronous transports). */
  dispose(): void;
}

/** Minimal worker surface the real browser Worker is adapted onto. */
export interface PathWorkerLike {
  postMessage(message: PathRequest): void;
  terminate(): void;
  setMessageHandler(
    handler: ((event: { data: PathResponse }) => void) | null,
  ): void;
}

export type PathWorkerFactory = () => PathWorkerLike;

/** Wrap an injected worker object into the transport interface. */
export function createWorkerTransport(
  factory: PathWorkerFactory,
): PathTransport {
  const worker = factory();
  let receive: ((response: PathResponse) => void) | undefined;
  worker.setMessageHandler((event) => receive?.(event.data));
  return {
    attach(onReceive) {
      receive = onReceive;
    },
    send(request) {
      worker.postMessage(request);
    },
    dispose() {
      worker.setMessageHandler(null);
      worker.terminate();
    },
  };
}

/**
 * Zero-async fallback: responses are computed inline at issuance via
 * the same pure engine the real worker runs, then flow through the
 * identical buffer/dueTick machinery. Headless tests get byte-identical
 * results to worker mode without spawning anything.
 */
export function createSynchronousPathTransport(): PathTransport {
  const engine = createPathEngine();
  let receive: ((response: PathResponse) => void) | undefined;
  return {
    attach(onReceive) {
      receive = onReceive;
    },
    send(request) {
      receive?.(engine.handle(request));
    },
    dispose() {},
  };
}

export class PathScheduler {
  readonly #transport: PathTransport;
  #nextId = 0;
  #nextApplyId = 1;
  /** Issued-but-unapplied requests keyed by id (insertion = issue order). */
  readonly #outstanding = new Map<number, OutstandingRequest>();
  /** Arrived responses awaiting their turn in id order. */
  readonly #buffered = new Map<number, PathResponse>();
  #blockedTicks = 0;
  #passabilityVersion = 0;

  constructor(transport: PathTransport) {
    this.#transport = transport;
    transport.attach((response) => this.receive(response));
  }

  /** Current passability version; bumps invalidate pending responses. */
  get passabilityVersion(): number {
    return this.#passabilityVersion;
  }

  setPassabilityVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(
        `passability version must be a u32, got ${String(version)}`,
      );
    }
    if (version < this.#passabilityVersion) {
      throw new Error("passability versions must be monotonically increasing");
    }
    this.#passabilityVersion = version;
  }

  /** Ticks held waiting on late responses (tests/telemetry). */
  get blockedTicks(): number {
    return this.#blockedTicks;
  }

  get pendingCount(): number {
    return this.#outstanding.size;
  }

  /**
   * Issue one path request. `issueTick` is the tick whose systems are
   * running now; the response applies at some boundary ≥ dueTick. The
   * passability array is copied here so later sim mutations can never
   * race the snapshot.
   */
  requestPath(
    input: PathRequestInput,
    options: Readonly<{
      issueTick: number;
      seed: number;
      passability: Uint8Array;
      onApply: PathApplyFn;
      onDiscard?: (() => void) | undefined;
    }>,
  ): number {
    const id = ++this.#nextId;
    const entry: OutstandingRequest = {
      id,
      dueTick: options.issueTick + PATH_LATENCY,
      passableVersion: this.#passabilityVersion,
      onApply: options.onApply,
      onDiscard: options.onDiscard,
    };
    this.#outstanding.set(id, entry);
    const request: PathRequest = {
      kind: "path",
      id,
      dueTick: entry.dueTick,
      startX: input.startX,
      startY: input.startY,
      goalX: input.goalX,
      goalY: input.goalY,
      passable: options.passability.slice(),
      passableVersion: entry.passableVersion,
      seed: options.seed,
    };
    this.#transport.send(request);
    return id;
  }

  /** Accept one response from the transport (any order, duplicates dropped). */
  receive(response: PathResponse): void {
    if (!this.#outstanding.has(response.id)) return;
    if (this.#buffered.has(response.id)) return;
    this.#buffered.set(response.id, response);
  }

  /**
   * Apply every buffered response whose turn has come AND whose dueTick
   * is ≤ currentTick, strictly ascending by id. Returns false when the
   * tick must be held because the next-in-order response is due but has
   * not arrived; the caller retries the SAME tick next frame.
   */
  pump(currentTick: number): boolean {
    for (;;) {
      const entry = this.#outstanding.get(this.#nextApplyId);
      if (entry === undefined) return true; // nothing pending in order
      if (entry.dueTick > currentTick) return true; // not late yet (ids ascend ⇒ neither are later ones)
      const response = this.#buffered.get(entry.id);
      if (response === undefined) {
        this.#blockedTicks += 1;
        return false; // hold the tick; retry next frame
      }
      this.#buffered.delete(entry.id);
      this.#outstanding.delete(entry.id);
      this.#nextApplyId += 1;
      // Stale-version responses are answered normally but discarded on
      // arrival (ADR-0003): their passability no longer exists. The
      // requester's onDiscard hook still fires so any held state (an
      // awaiting-repath unit, say) is released this boundary.
      if (entry.passableVersion === this.#passabilityVersion) {
        entry.onApply(response);
      } else {
        entry.onDiscard?.();
      }
    }
  }
}

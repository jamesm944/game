/**
 * Path worker protocol — SPEC §2.2 / ADR-0003.
 *
 * Requests are pure functions of their contents: `{kind, id, dueTick,
 * start, goal, passable snapshot, passableVersion, seed}` in,
 * `{id, ok, waypoints, cost}` out. The sim consumes responses at tick
 * boundaries in ascending-id order, applying those whose
 * `dueTick ≤ currentTick`; a response missing past its due tick blocks
 * the tick instead of letting movement diverge (replay-exactness).
 */

/**
 * Tick offset between request issuance and earliest application
 * (SPEC §2.2): hides sub-frame worker latency behind a fixed contract.
 */
export const PATH_LATENCY = 2;

/** Main thread → worker. */
export interface PathRequest {
  readonly kind: "path";
  /** Monotonic id assigned by the scheduler in strict issue order. */
  readonly id: number;
  /** issueTick + PATH_LATENCY: earliest tick boundary that may apply it. */
  readonly dueTick: number;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
  /**
   * Snapshot COPY of derived passability (never a live sim array); flat
   * row-major square grid whose edge is √length.
   */
  readonly passable: Uint8Array;
  /** Passability version the snapshot was taken at (staleness gate). */
  readonly passableVersion: number;
  /** Child of the sim PRNG stream feeding the per-request worker PRNG. */
  readonly seed: number;
}

/** Worker → main thread. `waypoints`/`cost` are meaningless when !ok. */
export interface PathResponse {
  readonly kind: "path";
  /** Echoes request.id. */
  readonly id: number;
  /** false when no route exists or endpoints are impassable/off-grid. */
  readonly ok: boolean;
  /** String-pulled waypoints, flat [x0,y0,x1,y1,…] tile coordinates. */
  readonly waypoints: Int16Array;
  /** Exact optimal integer path cost (×1000 units). */
  readonly cost: number;
}

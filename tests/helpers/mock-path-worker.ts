/**
 * Deterministic scripted path-worker mock for node tests.
 *
 * Stands in for a real Web Worker without spawning one: responses are
 * computed by the SAME pure engine the production worker runs, but
 * delivery is scripted — a per-request-id delay `d ≥ 0` meaning "the
 * response becomes visible at the tick boundary `d + 1` after the
 * issuing tick". Delays 0/1 stay inside PATH_LATENCY (=2); delays ≥ 2
 * are late and exercise the scheduler's tick-holding contract.
 * `advanceFrame()` is called once per simulated frame by the test loop,
 * immediately before `step()`.
 */
import { createPathEngine } from "../../src/sim/path/engine";
import type { PathRequest, PathResponse } from "../../src/sim/path/protocol";
import type { PathTransport } from "../../src/sim/path/scheduler";

export class MockPathWorker {
  readonly #engine = createPathEngine();
  readonly #delayFor: (requestId: number) => number;
  #frame = 0;
  readonly #inFlight: { request: PathRequest; deliverAt: number }[] = [];
  #receive: ((response: PathResponse) => void) | undefined;
  /** Total responses handed back to the scheduler (tests/telemetry). */
  deliveredCount = 0;

  constructor(delayFor: (requestId: number) => number = () => 0) {
    this.#delayFor = delayFor;
  }

  /** The scheduler-facing transport bound to this mock worker. */
  get transport(): PathTransport {
    return {
      attach: (receive) => {
        this.#receive = receive;
      },
      send: (request) => {
        const delay = Math.max(this.#delayFor(request.id), 0);
        this.#inFlight.push({
          request,
          deliverAt: this.#frame + delay + 1,
        });
      },
      dispose: () => {
        this.#inFlight.length = 0;
      },
    };
  }

  /**
   * Advance one simulated frame and flush every response whose deadline
   * has arrived, in send order. Different per-id delays make arrivals
   * cross tick boundaries out of order.
   */
  advanceFrame(): void {
    this.#frame += 1;
    let index = 0;
    while (index < this.#inFlight.length) {
      const entry = this.#inFlight[index]!;
      if (entry.deliverAt > this.#frame) {
        index += 1;
        continue;
      }
      this.#inFlight.splice(index, 1);
      this.#receive?.(this.#engine.handle(entry.request));
      this.deliveredCount += 1;
    }
  }

  get inFlightCount(): number {
    return this.#inFlight.length;
  }
}

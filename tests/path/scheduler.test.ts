/**
 * Path scheduler tests — SPEC §2.2 / ADR-0003/0004 (M1-T5).
 *
 * Node-env only: transports are either a manual scriptable stand-in or
 * a mocked worker object via `createWorkerTransport` — no real Worker
 * is ever spawned. Covers: monotonic ids + passability snapshots,
 * out-of-order arrivals applying strictly ascending-id, stale-version
 * discard, dueTick gating, late-response tick blocking (with counter),
 * and the worker transport wiring both directions.
 */
import { describe, expect, it } from "vitest";
import { MockPathWorker } from "../helpers/mock-path-worker";
import { installSimPurityShims } from "../helpers/sim-purity-shims";
import {
  PathScheduler,
  createWorkerTransport,
  type PathTransport,
} from "../../src/sim/path/scheduler";
import {
  PATH_LATENCY,
  type PathRequest,
  type PathResponse,
} from "../../src/sim/path/protocol";

installSimPurityShims();

/** Transport that records sends and lets tests inject responses manually. */
class ManualTransport implements PathTransport {
  readonly sent: PathRequest[] = [];
  #receive: ((response: PathResponse) => void) | undefined;

  attach(receive: (response: PathResponse) => void): void {
    this.#receive = receive;
  }

  send(request: PathRequest): void {
    this.sent.push(request);
  }

  dispose(): void {}

  deliver(response: PathResponse): void {
    this.#receive?.(response);
  }
}

const OPEN_GRID = new Uint8Array(16).fill(1); // 4×4 open grid

function makeScheduler(): {
  scheduler: PathScheduler;
  transport: ManualTransport;
} {
  const transport = new ManualTransport();
  return { scheduler: new PathScheduler(transport), transport };
}

function fakeResponse(id: number, ok = true): PathResponse {
  return {
    kind: "path",
    id,
    ok,
    waypoints: Int16Array.from(ok ? [1, 2, 2, 2] : []),
    cost: ok ? 1414 : 0,
  };
}

function request(scheduler: PathScheduler, issueTick: number): number[] {
  const applied: number[] = [];
  scheduler.requestPath(
    { startX: 0, startY: 0, goalX: 2, goalY: 2 },
    {
      issueTick,
      seed: 7,
      passability: OPEN_GRID,
      onApply: (response) => {
        applied.push(response.id);
      },
    },
  );
  return applied;
}

describe("path scheduler protocol", () => {
  it("assigns monotonically increasing ids and dueTicks and snapshots passability", () => {
    const { scheduler, transport } = makeScheduler();
    const grid = new Uint8Array(OPEN_GRID); // mutable copy handed to requests

    scheduler.requestPath(
      { startX: 0, startY: 0, goalX: 2, goalY: 2 },
      {
        issueTick: 5,
        seed: 7,
        passability: grid,
        onApply: () => {},
      },
    );
    scheduler.setPassabilityVersion(3);
    scheduler.requestPath(
      { startX: 1, startY: 1, goalX: 3, goalY: 0 },
      {
        issueTick: 5,
        seed: 8,
        passability: grid,
        onApply: () => {},
      },
    );
    scheduler.requestPath(
      { startX: 2, startY: 2, goalX: 0, goalY: 3 },
      {
        issueTick: 6,
        seed: 9,
        passability: grid,
        onApply: () => {},
      },
    );

    expect(transport.sent.map((request) => request.id)).toEqual([1, 2, 3]);
    expect(transport.sent.map((request) => request.dueTick)).toEqual([
      5 + PATH_LATENCY,
      5 + PATH_LATENCY,
      6 + PATH_LATENCY,
    ]);
    expect(transport.sent.map((request) => request.passableVersion)).toEqual([
      0, 3, 3,
    ]);

    // The snapshot must be a copy: mutating the source afterwards
    // cannot leak into the in-flight request.
    grid[0] = 0;
    expect(transport.sent[0]!.passable[0]).toBe(1);
    expect(scheduler.pendingCount).toBe(3);
  });

  it("applies out-of-order arrivals strictly in ascending-id order", () => {
    const { scheduler, transport } = makeScheduler();
    const appliedA = request(scheduler, 0);
    const appliedB = request(scheduler, 0);
    const appliedC = request(scheduler, 0);

    // Arrive completely reversed, plus an unknown duplicate that must
    // be ignored defensively.
    transport.deliver(fakeResponse(3));
    transport.deliver(fakeResponse(1));
    transport.deliver(fakeResponse(99));
    transport.deliver(fakeResponse(2));

    expect(scheduler.pump(10)).toBe(true);
    expect(appliedA).toEqual([1]);
    expect(appliedB).toEqual([2]);
    expect(appliedC).toEqual([3]);
    expect(scheduler.blockedTicks).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("discards stale-version responses but keeps the id order advancing", () => {
    const { scheduler, transport } = makeScheduler();
    scheduler.setPassabilityVersion(1);
    const stale = request(scheduler, 0);

    scheduler.setPassabilityVersion(2); // terrain changed mid-flight
    transport.deliver(fakeResponse(1));
    expect(scheduler.pump(10)).toBe(true);
    expect(stale).toEqual([]); // discarded, never applied

    const fresh = request(scheduler, 10);
    transport.deliver(fakeResponse(2));
    expect(scheduler.pump(12)).toBe(true);
    expect(fresh).toEqual([2]);
  });

  it("gates application on dueTick even when responses arrive early", () => {
    const { scheduler, transport } = makeScheduler();
    const applied = request(scheduler, 5);
    transport.deliver(fakeResponse(1)); // instant worker

    expect(scheduler.pump(6)).toBe(true);
    expect(applied).toEqual([]); // not due yet

    expect(scheduler.pump(7)).toBe(true);
    expect(applied).toEqual([1]); // exactly at dueTick
  });

  it("blocks held ticks on a late head-of-line response, then resumes", () => {
    const { scheduler, transport } = makeScheduler();
    const appliedFirst = request(scheduler, 5);
    const appliedSecond = request(scheduler, 5);

    // Only the LATER response arrives early; the head of line is late.
    transport.deliver(fakeResponse(2));
    expect(scheduler.pump(7)).toBe(false);
    expect(appliedFirst).toEqual([]);
    expect(appliedSecond).toEqual([]); // held behind id 1
    expect(scheduler.blockedTicks).toBe(1);

    expect(scheduler.pump(8)).toBe(false);
    expect(scheduler.blockedTicks).toBe(2);

    transport.deliver(fakeResponse(1));
    expect(scheduler.pump(8)).toBe(true);
    expect(appliedFirst).toEqual([1]);
    expect(appliedSecond).toEqual([2]);
  });

  it("does not block while the head-of-line response is merely not yet due", () => {
    const { scheduler, transport } = makeScheduler();
    request(scheduler, 5); // dueTick 7
    transport.deliver(fakeResponse(1));
    expect(scheduler.pump(4)).toBe(true); // future work, no blocking
    expect(scheduler.blockedTicks).toBe(0);
    expect(scheduler.pendingCount).toBe(1);
  });
});

describe("worker transport wiring", () => {
  it("sends requests through the injected worker and receives its responses", () => {
    const posted: PathRequest[] = [];
    let messageHandler: ((event: { data: PathResponse }) => void) | null = null;
    let terminated = false;

    // Mock "Worker": captures postMessage, replays scripted responses.
    const factory = () => ({
      postMessage: (message: PathRequest) => {
        posted.push(message);
      },
      terminate: () => {
        terminated = true;
      },
      setMessageHandler: (
        handler: ((event: { data: PathResponse }) => void) | null,
      ) => {
        messageHandler = handler;
      },
    });

    const scheduler = new PathScheduler(createWorkerTransport(factory));
    const applied: number[] = [];
    scheduler.requestPath(
      { startX: 0, startY: 0, goalX: 2, goalY: 2 },
      {
        issueTick: 3,
        seed: 11,
        passability: OPEN_GRID,
        onApply: (response) => {
          applied.push(response.id);
          expect(response.ok).toBe(true);
          expect([...response.waypoints]).toEqual([1, 2, 2, 2]);
        },
      },
    );

    expect(posted.length).toBe(1);
    expect(posted[0]!.id).toBe(1);
    expect(posted[0]!.seed).toBe(11);

    // Simulate the worker replying through its message event. (The
    // variable is captured through a closure TS cannot see, so widen it
    // back before invoking.)
    const reply = messageHandler as
      ((event: { data: PathResponse }) => void) | null;
    reply?.({ data: fakeResponse(1) });
    expect(scheduler.pump(3 + PATH_LATENCY)).toBe(true);
    expect(applied).toEqual([1]);

    // Dispose tears the mock worker down exactly once per transport.
    createWorkerTransport(factory).dispose();
    expect(terminated).toBe(true);
  });
});

describe("main-thread application budget", () => {
  it("applies thousands of buffered responses well under the tick budget", () => {
    // Issue acceptance criterion: main-thread application stays
    // <2 ms/tick. Node wall-clock is noisier than a browser frame, so
    // assert a generous ceiling that still catches any super-linear
    // regression in the ascending-id pump.
    const { scheduler, transport } = makeScheduler();
    const COUNT = 5000;
    const applied: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      scheduler.requestPath(
        { startX: 0, startY: 0, goalX: 2, goalY: 2 },
        {
          issueTick: 0,
          seed: i,
          passability: OPEN_GRID,
          onApply: (response) => {
            applied.push(response.id);
          },
        },
      );
      transport.deliver(fakeResponse(i + 1));
    }
    const started = performance.now();
    expect(scheduler.pump(COUNT)).toBe(true);
    const elapsedMs = performance.now() - started;
    expect(applied.length).toBe(COUNT);
    expect(elapsedMs).toBeLessThan(200); // observed ≈ single-digit ms
  });
});

describe("MockPathWorker delivery timing", () => {
  it("delivers delay-0 responses within PATH_LATENCY and delays them by script", () => {
    const worker = new MockPathWorker((id) => (id === 2 ? 5 : 0));
    const scheduler = new PathScheduler(worker.transport);
    const applied: number[] = [];
    scheduler.requestPath(
      { startX: 0, startY: 0, goalX: 1, goalY: 1 },
      {
        issueTick: 0,
        seed: 1,
        passability: OPEN_GRID,
        onApply: (response) => applied.push(response.id),
      },
    );
    scheduler.requestPath(
      { startX: 0, startY: 0, goalX: 2, goalY: 2 },
      {
        issueTick: 0,
        seed: 2,
        passability: OPEN_GRID,
        onApply: (response) => applied.push(response.id),
      },
    );

    // Frames 1..2: fast response arrives, waits for its dueTick (2).
    worker.advanceFrame(); // frame 1: id 1 visible
    expect(scheduler.pump(1)).toBe(true);
    expect(applied).toEqual([]); // dueTick 2 not reached
    worker.advanceFrame(); // frame 2
    // id 1 applies exactly at dueTick 2 — then id 2 shares that
    // dueTick and is LATE, so the boundary blocks behind it.
    expect(scheduler.pump(2)).toBe(false);
    expect(applied).toEqual([1]);
    expect(scheduler.blockedTicks).toBe(1);

    // Slow response (delay 5 → visible frame 6) keeps holding ticks.
    for (let frame = 3; frame <= 5; frame++) {
      worker.advanceFrame();
      expect(scheduler.pump(frame)).toBe(false);
    }
    expect(scheduler.blockedTicks).toBe(4);
    worker.advanceFrame(); // frame 6: id 2 finally visible
    expect(scheduler.pump(6)).toBe(true);
    expect(applied).toEqual([1, 2]);
    expect(worker.inFlightCount).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { PathTransport } from "../../../src/sim/path/scheduler";
import type { CandidateContext } from "../../full-game-movement/harness/types";
import { createQueueAstarCandidate } from "./adapter";
import { HandlePathScheduler } from "./handle-scheduler";
import { SchedulerOwnedSnapshotProvider } from "./provider";
import type { QueueWorkerLike, QueueWorkerMessage, QueueWorkerRequest } from "./protocol";
import { NavigationQueueWorker } from "./worker-handler";

function response(id: number, marker = id): PathResponse {
  return { kind: "path", id, ok: true, waypoints: Int16Array.from([marker]), cost: marker };
}

function manualScheduler() {
  const sent: PathRequest[] = [];
  let receive: ((response: PathResponse) => void) | undefined;
  const transport: PathTransport = {
    attach(handler) { receive = handler; },
    send(request) { sent.push(request); },
    dispose() {},
  };
  const provider = new SchedulerOwnedSnapshotProvider();
  const scheduler = new HandlePathScheduler(transport, provider);
  return { scheduler, provider, sent, receive: (value: PathResponse) => receive?.(value) };
}

const input = { startX: 0, startY: 0, goalX: 2, goalY: 2 };
const options = (applied: number[], discarded: number[] = []) => ({
  issueTick: 4,
  seed: 7,
  passability: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  onApply: (value: PathResponse) => applied.push(value.id),
  onDiscard: () => discarded.push(1),
});

describe("clean handle scheduler", () => {
  it("retains normal request copying and sends monotonic ids", () => {
    const { scheduler, sent } = manualScheduler();
    const passability = Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const first = scheduler.requestPath(input, { ...options([]), passability });
    const second = scheduler.requestPath(input, { ...options([]), passability });
    passability[0] = 0;
    expect([first, second]).toEqual([1, 2]);
    expect(sent.map((request) => request.id)).toEqual([1, 2]);
    expect(sent.map((request) => request.dueTick)).toEqual([6, 6]);
    expect(sent[0]!.passable[0]).toBe(1);
    expect(sent[0]!.passable).not.toBe(passability);
  });

  it("blocks on a missing due response, then applies delayed out-of-order responses once in ascending order", () => {
    const { scheduler, receive } = manualScheduler();
    const applied: number[] = [];
    for (let index = 0; index < 3; index += 1) scheduler.requestPath(input, options(applied));
    expect(scheduler.pump(5)).toBe(true);
    receive(response(2));
    receive(response(3));
    expect(scheduler.pump(6)).toBe(false);
    expect(scheduler.blockedTicks).toBe(1);
    expect(applied).toEqual([]);
    receive(response(1));
    receive(response(1, 999));
    receive(response(2, 999));
    expect(scheduler.pump(6)).toBe(true);
    expect(applied).toEqual([1, 2, 3]);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.blockedTicks).toBe(1);
    expect(scheduler.pump(6)).toBe(true);
    expect(applied).toEqual([1, 2, 3]);
  });

  it("discards stale revisions in order and preserves the two-tick due contract", () => {
    const { scheduler, receive } = manualScheduler();
    const applied: number[] = [];
    const discarded: number[] = [];
    const id = scheduler.requestPath(input, options(applied, discarded));
    scheduler.setPassabilityVersion(1);
    receive(response(id));
    expect(scheduler.pump(5)).toBe(true);
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.pump(6)).toBe(true);
    expect(applied).toEqual([]);
    expect(discarded).toEqual([1]);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.blockedTicks).toBe(0);
  });
});

describe("FIFO chunk transport", () => {
  it("retains strictly increasing ids within 32-request chunks on the clean provider path", async () => {
    const posted: QueueWorkerRequest[] = [];
    const engine = new NavigationQueueWorker();
    let receiver: ((event: { data: QueueWorkerMessage }) => void) | null = null;
    const worker: QueueWorkerLike = {
      postMessage(message) {
        posted.push(message);
        // Results are intentionally withheld: this check concerns request order only.
        if (message.kind === "snapshot-register" || message.kind === "snapshot-update") {
          receiver?.({ data: engine.handle(message) });
        } else if (message.kind === "path" || message.kind === "path-batch") {
          engine.handle(message);
        }
      },
      terminate() {},
      setMessageHandler(handler) { receiver = handler; },
    };
    const candidate = createQueueAstarCandidate("batch-32", () => worker);
    const context: CandidateContext = {
      evidenceClass: "node-mock-transport",
      now: () => performance.now(),
      onRequest: () => {},
      onResponse: () => {},
    };
    const scheduler = new HandlePathScheduler(candidate.createTransport(context), candidate.provider);
    candidate.bindScheduler(scheduler);
    for (let index = 0; index < 70; index += 1) {
      candidate.noteRequest(index + 1, "repath", `request:${index + 1}`);
      scheduler.requestPath(input, options([]));
    }
    await Promise.resolve();
    const batches = posted.filter((message) => message.kind === "path-batch");
    expect(batches.map((batch) => batch.kind === "path-batch" ? batch.requests.length : -1)).toEqual([32, 32, 6]);
    expect(batches.flatMap((batch) => batch.kind === "path-batch" ? batch.requests.map((request) => request.id) : []))
      .toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
    expect(posted.filter((message) => message.kind === "snapshot-register")).toHaveLength(1);
  });
});

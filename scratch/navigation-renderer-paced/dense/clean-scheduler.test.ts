import { describe, expect, it } from "vitest";
import { createQueueCandidate } from "./adapter";
import { CleanPathScheduler } from "./clean-scheduler";
import { SchedulerOwnedSnapshotProvider } from "./provider";
import { NavigationQueueWorker } from "./worker-handler";
import { postNavigationResult } from "./queue.worker";
import type { QueueWorkerFactory, QueueWorkerMessage, QueueWorkerRequest } from "./protocol";

function grid() { return new Uint8Array(25).fill(1); }
function manual() {
  const outbound: QueueWorkerRequest[] = []; const handler = new NavigationQueueWorker();
  let receive: ((event: { data: QueueWorkerMessage }) => void) | null = null;
  const factory: QueueWorkerFactory = () => ({
    postMessage(message) { outbound.push(message); },
    setMessageHandler(next) { receive = next; }, terminate() {},
  });
  return { outbound, factory, deliver(message: QueueWorkerRequest) {
    postNavigationResult((output) => receive?.({ data: output }), message, handler);
  } };
}
function setup(policy: "fifo" | "batch-32") {
  const transport = manual(); const clean: unknown[] = [];
  const candidate = createQueueCandidate(policy, (request) => {
    clean.push(request); return { requestClass: "repath", groupKey: `unshared-repath:${request.id}` };
  }, transport.factory);
  const scheduler = new CleanPathScheduler(candidate.createTransport({ onRequest() {}, onResponse() {} }),
    new SchedulerOwnedSnapshotProvider());
  return { ...transport, scheduler, clean };
}

describe("renderer-paced clean scheduler seam", () => {
  it.each(["fifo", "batch-32"] as const)("preserves ascending delayed out-of-order application for %s", async (policy) => {
    const { scheduler, outbound, deliver, clean } = setup(policy); const applied: number[] = [];
    const passable = grid();
    for (let i = 0; i < 34; i += 1) scheduler.requestPath(
      { startX: i % 5, startY: 0, goalX: 4, goalY: 4 },
      { issueTick: 1, seed: i + 1, passability: passable, onApply: () => applied.push(i + 1) });
    await Promise.resolve();
    expect(clean).toHaveLength(34); expect(clean.every((request) => !("passable" in (request as object)))).toBe(true);
    expect(scheduler.pump(3)).toBe(false);
    const snapshots = outbound.filter((m) => m.kind.startsWith("snapshot"));
    const paths = outbound.filter((m) => m.kind === "path" || m.kind === "path-batch");
    for (const message of snapshots) deliver(message);
    for (const message of [...paths].reverse()) deliver(message);
    for (const message of paths) deliver(message); // duplicates are harmless
    expect(scheduler.pump(3)).toBe(true); expect(applied).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
  });

  it("discards stale revisions and keeps issue-to-apply at two ticks", async () => {
    const { scheduler, outbound, deliver } = setup("batch-32"); const applied: number[] = [], discarded: number[] = [];
    const passable = grid();
    scheduler.requestPath({ startX: 0, startY: 0, goalX: 4, goalY: 4 },
      { issueTick: 1, seed: 1, passability: passable, onApply: () => applied.push(1), onDiscard: () => discarded.push(1) });
    scheduler.setPassabilityVersion(1); passable[0] = 0;
    scheduler.requestPath({ startX: 1, startY: 0, goalX: 4, goalY: 4 },
      { issueTick: 1, seed: 2, passability: passable, onApply: () => applied.push(2), onDiscard: () => discarded.push(2) });
    await Promise.resolve(); for (const message of outbound) deliver(message);
    expect(scheduler.pump(3)).toBe(true); expect(applied).toEqual([2]); expect(discarded).toEqual([1]);
  });
});

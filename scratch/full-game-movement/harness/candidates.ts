import { createPathEngine } from "../../../src/sim/path/engine";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { CandidateContext, MovementCandidateAdapter } from "./types";

export type MockDelayScript = (requestId: number) => number;

export function createCurrentAstarCandidate(): MovementCandidateAdapter {
  return {
    id: "current-integer-astar",
    createTransport(context: CandidateContext) {
      const engine = createPathEngine();
      let receive: ((response: PathResponse) => void) | undefined;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
        send(request) {
          context.onRequest(request);
          const started = context.now();
          const response = engine.handle(request);
          const computeMs = context.now() - started;
          context.onResponse(response, computeMs);
          receive?.(response);
        },
        dispose() {},
      };
    },
  };
}

/** Deterministic frame-delayed transport; this is not a real worker. */
export function createMockAstarCandidate(
  delayFor: MockDelayScript = (id) => (id * 7 + 1) % 5,
): MovementCandidateAdapter {
  let frame = 0;
  let inFlight: { request: PathRequest; deliverAt: number }[] = [];
  let receive: ((response: PathResponse) => void) | undefined;
  let context: CandidateContext | undefined;
  const engine = createPathEngine();
  const adapter: MovementCandidateAdapter = {
    id: "current-integer-astar-delayed-mock",
    createTransport(candidateContext) {
      context = candidateContext;
      frame = 0;
      inFlight = [];
      receive = undefined;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
        send(request) {
          candidateContext.onRequest(request);
          inFlight.push({
            request,
            deliverAt: frame + Math.max(0, delayFor(request.id)) + 1,
          });
        },
        dispose() {
          inFlight = [];
        },
      };
    },
    beforeFrame() {
      frame += 1;
      const due = inFlight
        .filter((entry) => entry.deliverAt <= frame)
        .sort((a, b) => a.deliverAt - b.deliverAt || b.request.id - a.request.id);
      inFlight = inFlight.filter((entry) => entry.deliverAt > frame);
      for (const entry of due) {
        if (!context) throw new Error("mock transport used before creation");
        const started = context.now();
        const response = engine.handle(entry.request);
        const computeMs = context.now() - started;
        context.onResponse(response, computeMs);
        receive?.(response);
      }
    },
    candidateMetrics() {
      return { mockInFlight: inFlight.length, cacheEntries: engine.cacheSize };
    },
    dispose() {
      inFlight = [];
    },
  };
  return adapter;
}

import { recastCore } from "../../full-game-movement/recast-integration/recast-runtime";
import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { CandidateContext, MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import type { MockDelayScript } from "../../full-game-movement/harness/candidates";
import { RecastRouteEngine } from "./incremental-engine";

let initialization: Promise<void> | undefined;

export function initializeRecast(): Promise<void> {
  if (!initialization) initialization = recastCore.init();
  return initialization;
}

export async function createRecastCandidate(): Promise<MovementCandidateAdapter> {
  await initializeRecast();
  const engine = new RecastRouteEngine();
  return {
    id: "recast-corridor-supercover-cs0.25-incremental-tilecache",
    createTransport(context: CandidateContext) {
      let receive: ((response: PathResponse) => void) | undefined;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
        send(request) {
          context.onRequest(request);
          const started = context.now();
          const response = engine.handle(request, context.now);
          const computeMs = context.now() - started;
          context.onResponse(response, computeMs);
          receive?.(response);
        },
        dispose() {},
      };
    },
    candidateMetrics() {
      return engine.candidateMetrics();
    },
    dispose() {
      engine.dispose();
    },
  };
}

/** Scripted frame delivery only; this does not create a worker or browser. */
export async function createMockRecastCandidate(
  delayFor: MockDelayScript = (id) => (id * 7 + 1) % 5,
): Promise<MovementCandidateAdapter> {
  await initializeRecast();
  const engine = new RecastRouteEngine();
  let frame = 0;
  let inFlight: { request: PathRequest; deliverAt: number }[] = [];
  let receive: ((response: PathResponse) => void) | undefined;
  let context: CandidateContext | undefined;
  return {
    id: "recast-corridor-supercover-cs0.25-incremental-tilecache-delayed-mock",
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
          inFlight.push({ request, deliverAt: frame + Math.max(0, delayFor(request.id)) + 1 });
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
        if (!context) throw new Error("Recast mock used before creation");
        const started = context.now();
        const response = engine.handle(entry.request, context.now);
        const computeMs = context.now() - started;
        context.onResponse(response, computeMs);
        receive?.(response);
      }
    },
    candidateMetrics() {
      return engine.candidateMetrics(inFlight.length);
    },
    dispose() {
      inFlight = [];
      engine.dispose();
    },
  };
}

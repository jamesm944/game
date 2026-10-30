import type { PathRequest, PathResponse } from "../../../src/sim/path/protocol";
import type { CandidateContext, MovementCandidateAdapter } from "../../full-game-movement/harness/types";
import type { RecastWorkerEvent, RecastWorkerRequest } from "./recast.worker";

export interface RecastRouteRecord {
  readonly id: number;
  readonly ok: boolean;
  readonly cost: number;
  readonly waypoints: readonly number[];
}

export interface RecastBrowserAdapter extends MovementCandidateAdapter {
  readonly ready: Promise<void>;
  readonly routes: readonly RecastRouteRecord[];
}

export function createRecastBrowserAdapter(): RecastBrowserAdapter {
  const worker = new Worker(new URL("./recast.worker.ts", import.meta.url), { type: "module" });
  const routes: RecastRouteRecord[] = [];
  let latestMetrics: Readonly<Record<string, number | string | boolean>> = {};
  let initializationMs = 0;
  let fatalError: Error | undefined;
  let readySettled = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (message: string): void => {
    fatalError = new Error(message);
    if (!readySettled) {
      readySettled = true;
      rejectReady(fatalError);
    }
  };
  const readinessTimeout = setTimeout(() => fail("Recast worker readiness timed out after 30000 ms"), 30_000);
  void ready.finally(() => clearTimeout(readinessTimeout)).catch(() => {});
  worker.onerror = (event) => fail(`Recast worker error: ${event.message}`);
  worker.onmessageerror = () => fail("Recast worker response could not be deserialized");
  let transportContext: CandidateContext | undefined;
  let receive: ((response: PathResponse) => void) | undefined;
  worker.onmessage = (event: MessageEvent<RecastWorkerEvent>) => {
    const message = event.data;
    if (message.kind === "ready") {
      initializationMs = message.initializationMs;
      latestMetrics = { ...latestMetrics, recastNavigationVersion: message.recastNavigationVersion, wasmPackaging: message.wasm };
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
    } else if (message.kind === "path") {
      latestMetrics = message.metrics;
      routes.push({ id: message.response.id, ok: message.response.ok, cost: message.response.cost, waypoints: Array.from(message.response.waypoints) });
      if (!transportContext) {
        fail("Recast worker returned a path before transport creation");
        return;
      }
      transportContext.onResponse(message.response, message.computeMs);
      receive?.(message.response);
    } else {
      fail(`Recast worker ${message.phase} failure: ${message.message}`);
    }
  };

  return {
    id: "recast-corridor-supercover-cs0.25-full-rebuild-browser-worker",
    ready,
    routes,
    createTransport(context: CandidateContext) {
      transportContext = context;
      return {
        attach(onReceive) {
          receive = onReceive;
        },
        send(request: PathRequest) {
          if (fatalError) throw fatalError;
          context.onRequest(request);
          const message: RecastWorkerRequest = { kind: "path", request };
          worker.postMessage(message);
        },
        dispose() {
          const message: RecastWorkerRequest = { kind: "dispose" };
          worker.postMessage(message);
          worker.terminate();
        },
      };
    },
    beforeFrame() {
      if (fatalError) throw fatalError;
    },
    candidateMetrics() {
      return {
        transport: "real-browser-module-worker",
        wasmInitializationMs: initializationMs,
        workerComputeTimeMeasured: true,
        fullRevisionRebuilds: true,
        ...latestMetrics,
      };
    },
    dispose() {
      worker.terminate();
    },
  };
}

export async function smokeRecastBrowserWorker(): Promise<{
  readonly ready: true;
  readonly route: readonly number[];
  readonly metrics: Readonly<Record<string, number | string | boolean>>;
}> {
  const adapter = createRecastBrowserAdapter();
  await adapter.ready;
  let responseResolve: (response: PathResponse) => void;
  const responsePromise = new Promise<PathResponse>((resolve) => { responseResolve = resolve; });
  const transport = adapter.createTransport({
    evidenceClass: "browser-worker",
    now: () => performance.now(),
    onRequest: () => {},
    onResponse: (response) => responseResolve(response),
  });
  transport.attach((response) => responseResolve(response));
  const width = 12;
  const passable = new Uint8Array(width * width).fill(1);
  for (let y = 0; y < width; y += 1) if (y !== 4) passable[y * width + 5] = 0;
  transport.send({ kind: "path", id: 1, dueTick: 2, startX: 0, startY: 4, goalX: 11, goalY: 4, passable, passableVersion: 0, seed: 169 });
  const timeout = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("Recast worker smoke timeout")), 30_000); });
  const response = await Promise.race([responsePromise, timeout]);
  if (!response.ok || response.id !== 1 || Array.from(response.waypoints.slice(0, 2)).join(",") !== "0,4" || Array.from(response.waypoints.slice(-2)).join(",") !== "11,4") {
    throw new Error(`Recast worker smoke returned invalid route: ${JSON.stringify({ ok: response.ok, id: response.id, route: Array.from(response.waypoints) })}`);
  }
  const metrics = adapter.candidateMetrics?.() ?? {};
  transport.dispose();
  return { ready: true, route: Array.from(response.waypoints), metrics };
}

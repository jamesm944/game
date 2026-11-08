import { createPathWorkerFactory } from "../../../../../src/game/paths";
import type { PathWorkerFactory } from "../../../../../src/sim/path/scheduler";
import type { MovementCandidateAdapter } from "../../types";

export type FullGameCandidate = "astar" | "flow";

function createFlowWorkerFactory(): PathWorkerFactory {
  return () => {
    const worker = new Worker(new URL("../flow.worker.ts", import.meta.url), { type: "module" });
    return {
      postMessage: (message) => worker.postMessage(message),
      setMessageHandler: (handler) => {
        worker.onmessage = handler ? (event) => handler({ data: event.data }) : null;
      },
      terminate: () => worker.terminate(),
    };
  };
}

export function createFullGameWorkerAdapter(candidate: FullGameCandidate): MovementCandidateAdapter {
  const factory = candidate === "astar" ? createPathWorkerFactory() : createFlowWorkerFactory();
  let activeWorker: ReturnType<PathWorkerFactory> | undefined;
  return {
    id: candidate === "astar" ? "current-integer-astar" : "flow-field-shared-destination",
    createTransport(context) {
      const worker = factory();
      activeWorker = worker;
      return {
        attach(receive) {
          worker.setMessageHandler((event) => {
            // Only end-to-end response time is measured; worker compute is unknown here.
            context.onResponse(event.data, 0);
            receive(event.data);
          });
        },
        send(request) {
          context.onRequest(request);
          worker.postMessage(request);
        },
        dispose() {
          worker.setMessageHandler(null);
          worker.terminate();
        },
      };
    },
    candidateMetrics() {
      return {
        transport: "real-browser-module-worker",
        workerComputeTimeMeasured: false,
        flowMetricsTransferred: false,
      };
    },
    dispose() {
      activeWorker?.terminate();
      activeWorker = undefined;
    },
  };
}

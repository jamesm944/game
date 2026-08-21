/**
 * Browser glue for the path worker — the ONLY place that constructs a
 * real `Worker` for pathfinding. The sim-side scheduler accepts this
 * factory by injection; node tests never import this file, so no test
 * environment ever spawns a worker (SPEC §2.2 / ADR-0004).
 */

import type { PathWorkerFactory } from "../sim/path/scheduler";

export function createPathWorkerFactory(): PathWorkerFactory {
  return () => {
    const worker = new Worker(
      new URL("../sim/path.worker.ts", import.meta.url),
      { type: "module" },
    );
    return {
      postMessage: (message) => {
        worker.postMessage(message);
      },
      setMessageHandler: (handler) => {
        worker.onmessage = handler
          ? (event) => handler({ data: event.data })
          : null;
      },
      terminate: () => {
        worker.terminate();
      },
    };
  };
}

import { initializeCombinedRecast } from "../combined-engine";
import type { VersionedWorkerMessage, VersionedWorkerRequest } from "./protocol";
import { CombinedSnapshotWorker } from "./worker-handler";

interface WorkerScope {
  postMessage(message: VersionedWorkerMessage, transfer?: readonly Transferable[]): void;
  onmessage: ((event: MessageEvent<VersionedWorkerRequest>) => void) | null;
}

export function postCombinedResult(
  post: (message: VersionedWorkerMessage, transfer?: readonly Transferable[]) => void,
  message: VersionedWorkerRequest,
  handler: CombinedSnapshotWorker,
): void {
  try {
    const output = handler.handle(message);
    if (output.kind === "versioned-path-result") {
      const postStarted = performance.now();
      post(output, [output.response.waypoints.buffer]);
      const responsePostMs = performance.now() - postStarted;
      if (output.response.id === 1 || output.response.id % 256 === 0) post({ kind: "path-post-telemetry", id: output.response.id, responsePostMs });
    } else {
      post(output);
    }
  } catch (error: unknown) {
    post({
      kind: "error",
      phase: "request",
      ...(message.kind === "versioned-path" ? { requestId: message.id } : {}),
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

function wireWorkerScope(): void {
  if (typeof self === "undefined") return;
  const scope = self as unknown as Partial<WorkerScope>;
  if (typeof scope.postMessage !== "function") return;
  const workerScope = scope as WorkerScope;
  const handler = new CombinedSnapshotWorker();
  const initializationStarted = performance.now();
  const ready = initializeCombinedRecast().then(() => {
    workerScope.postMessage({ kind: "ready", initializationMs: performance.now() - initializationStarted, recastNavigationVersion: "0.43.0", wasm: "@recast-navigation/wasm-compat" });
  });
  ready.catch((error: unknown) => {
    workerScope.postMessage({ kind: "error", phase: "initialization", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  });
  workerScope.onmessage = (event) => {
    void ready.then(() => postCombinedResult((message, transfer) => workerScope.postMessage(message, transfer), event.data, handler));
  };
}

wireWorkerScope();

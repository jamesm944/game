import type { VersionedWorkerMessage, VersionedWorkerRequest } from "./protocol";
import { VersionedSnapshotWorker } from "./worker-handler";

interface WorkerScope {
  postMessage(message: VersionedWorkerMessage, transfer?: readonly Transferable[]): void;
  onmessage: ((event: MessageEvent<VersionedWorkerRequest>) => void) | null;
}

export function postVersionedResult(
  post: (message: VersionedWorkerMessage, transfer?: readonly Transferable[]) => void,
  message: VersionedWorkerRequest,
  handler: VersionedSnapshotWorker,
): void {
  const output = handler.handle(message);
  if (output.kind === "versioned-path-result") {
    const postStarted = performance.now();
    post(output, [output.response.waypoints.buffer]);
    const responsePostMs = performance.now() - postStarted;
    // Avoid doubling the real worker message stream for instrumentation.
    if (output.response.id === 1 || output.response.id % 256 === 0) {
      post({ kind: "path-post-telemetry", id: output.response.id, responsePostMs });
    }
  } else {
    post(output);
  }
}

function wireWorkerScope(): void {
  if (typeof self === "undefined") return;
  const scope = self as unknown as Partial<WorkerScope>;
  if (typeof scope.postMessage !== "function") return;
  const handler = new VersionedSnapshotWorker();
  scope.onmessage = (event: MessageEvent<VersionedWorkerRequest>) => {
    postVersionedResult(
      (message, transfer) => transfer
        ? (scope as WorkerScope).postMessage(message, transfer)
        : (scope as WorkerScope).postMessage(message),
      event.data,
      handler,
    );
  };
}

wireWorkerScope();

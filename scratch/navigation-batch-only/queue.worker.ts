import type { QueueWorkerMessage, QueueWorkerRequest } from "./protocol";
import { NavigationQueueWorker } from "./worker-handler";

interface WorkerScope {
  postMessage(message: QueueWorkerMessage, transfer?: readonly Transferable[]): void;
  onmessage: ((event: MessageEvent<QueueWorkerRequest>) => void) | null;
}

export function postNavigationResult(
  post: (message: QueueWorkerMessage, transfer?: readonly Transferable[]) => void,
  request: QueueWorkerRequest,
  handler: NavigationQueueWorker,
): void {
  const result = handler.handle(request);
  if (result.kind === "path-results") {
    post(result, result.items.map((item) => item.response.waypoints.buffer));
  } else {
    post(result);
  }
}

function wireWorkerScope(): void {
  if (typeof self === "undefined") return;
  const scope = self as unknown as Partial<WorkerScope>;
  if (typeof scope.postMessage !== "function") return;
  const handler = new NavigationQueueWorker();
  scope.onmessage = (event: MessageEvent<QueueWorkerRequest>) => {
    postNavigationResult(
      (message, transfer) => transfer
        ? (scope as WorkerScope).postMessage(message, transfer)
        : (scope as WorkerScope).postMessage(message),
      event.data,
      handler,
    );
  };
}

wireWorkerScope();

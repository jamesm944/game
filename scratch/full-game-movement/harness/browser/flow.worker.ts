import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import { FlowFieldRouteEngine } from "../flow-integration/flow-candidate";

interface FlowWorkerScope {
  postMessage(message: PathResponse): void;
  onmessage: ((event: MessageEvent<PathRequest>) => void) | null;
}

const scope = self as unknown as FlowWorkerScope;
const engine = new FlowFieldRouteEngine();
scope.onmessage = (event) => {
  const response = engine.handle(event.data, () => performance.now());
  scope.postMessage(response);
};

export {};

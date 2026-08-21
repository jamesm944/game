/**
 * Dedicated pathfinding Web Worker shell — SPEC §2.2 / ADR-0003/0004.
 *
 * Deliberately thin: all logic lives in the pure `path/engine` module so
 * golden tests exercise the exact request→response function headless
 * without spawning a Worker. This file only wires that engine to worker
 * scope (`onmessage` in, `postMessage` out) and does nothing at import
 * time under Node, where no worker scope exists.
 */

import { createPathEngine } from "./path/engine";
import type { PathRequest, PathResponse } from "./path/protocol";

interface PathWorkerScope {
  postMessage(message: PathResponse): void;
  onmessage: ((event: MessageEvent<PathRequest>) => void) | null;
}

function wireWorkerScope(): void {
  if (typeof self === "undefined") return; // Node/test import: inert.
  const scope = self as unknown as Partial<PathWorkerScope>;
  if (typeof scope.postMessage !== "function") return;
  const engine = createPathEngine();
  scope.onmessage = (event: MessageEvent<PathRequest>) => {
    const response = engine.handle(event.data);
    (scope as PathWorkerScope).postMessage(response);
  };
}

wireWorkerScope();

export {};

import { init } from "@recast-navigation/core";
import type { PathRequest } from "../../../src/sim/path/protocol";
import { RecastRouteEngine } from "./recast-engine";

export type RecastWorkerRequest =
  | { readonly kind: "path"; readonly request: PathRequest }
  | { readonly kind: "dispose" };

export type RecastWorkerEvent =
  | {
      readonly kind: "ready";
      readonly initializationMs: number;
      readonly recastNavigationVersion: "0.43.0";
      readonly wasm: "@recast-navigation/wasm-compat";
    }
  | {
      readonly kind: "path";
      readonly response: import("../../../src/sim/path/protocol").PathResponse;
      readonly computeMs: number;
      readonly metrics: Readonly<Record<string, number | string | boolean>>;
    }
  | { readonly kind: "error"; readonly phase: "initialization" | "request"; readonly message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RecastWorkerRequest>) => void) | null;
  postMessage: (event: RecastWorkerEvent) => void;
};

const initializationStarted = performance.now();
const ready = init().then(() => {
  scope.postMessage({
    kind: "ready",
    initializationMs: performance.now() - initializationStarted,
    recastNavigationVersion: "0.43.0",
    wasm: "@recast-navigation/wasm-compat",
  });
});
ready.catch((error: unknown) => {
  scope.postMessage({ kind: "error", phase: "initialization", message: error instanceof Error ? error.stack ?? error.message : String(error) });
});

let engine: RecastRouteEngine | undefined;
scope.onmessage = (event): void => {
  const message = event.data;
  if (message.kind === "dispose") {
    void ready.then(() => {
      engine?.dispose();
      engine = undefined;
      scope.onmessage = null;
    });
    return;
  }
  void ready.then(() => {
    try {
      engine ??= new RecastRouteEngine();
      const started = performance.now();
      const response = engine.handle(message.request, () => performance.now());
      scope.postMessage({
        kind: "path",
        response,
        computeMs: performance.now() - started,
        metrics: engine.candidateMetrics(),
      });
    } catch (error: unknown) {
      scope.postMessage({ kind: "error", phase: "request", message: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });
};

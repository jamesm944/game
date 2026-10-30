import type { PathResponse } from "../../../../src/sim/path/protocol";

export type SnapshotPlane = "land" | "naval" | "owner";

export interface SnapshotRegisterMessage {
  readonly kind: "snapshot-register";
  readonly snapshotId: number;
  readonly revision: number;
  readonly plane: SnapshotPlane;
  readonly width: number;
  /** Structured-cloned once at registration; this is not claimed as zero-copy. */
  readonly passable: ArrayBuffer;
}

export interface SnapshotUpdateMessage {
  readonly kind: "snapshot-update";
  readonly snapshotId: number;
  readonly baseSnapshotId: number;
  readonly revision: number;
  readonly baseRevision: number;
  readonly plane: SnapshotPlane;
  readonly width: number;
  /** Changed flat indices and replacement bytes; both buffers are transferred. */
  readonly indices: Uint32Array;
  readonly values: Uint8Array;
}

export interface VersionedPathRequestMessage {
  readonly kind: "versioned-path";
  readonly id: number;
  readonly dueTick: number;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number
  readonly snapshotId: number;
  readonly passableVersion: number;
  readonly plane: SnapshotPlane;
  readonly seed: number;
  /** performance.timeOrigin + performance.now() on the sending agent. */
  readonly sentAtEpochMs: number;
}

export interface SnapshotAckMessage {
  readonly kind: "snapshot-ack";
  readonly snapshotId: number;
  readonly revision: number;
  readonly plane: SnapshotPlane;
  readonly operation: "register" | "update";
  readonly snapshotPayloadBytes: number;
  readonly deltaEntries: number;
  readonly workerHandlingMs: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
}

export interface VersionedPathResultMessage {
  readonly kind: "versioned-path-result";
  readonly response: PathResponse;
  readonly snapshotId: number;
  readonly revision: number;
  /** postMessage-to-worker-onmessage latency using epoch-adjusted high-resolution clocks. */
  readonly workerQueueMs: number;
  readonly computeMs: number;
  readonly responsePayloadBytes: number;
  readonly pathCacheSize: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
  readonly engineMetrics: Readonly<Record<string, number | string | boolean>>;
}

/** Instrumentation-only follow-up because postMessage duration is known only after sending. */
export interface PathPostTelemetryMessage {
  readonly kind: "path-post-telemetry";
  readonly id: number;
  readonly responsePostMs: number;
}

export interface CombinedReadyMessage {
  readonly kind: "ready";
  readonly initializationMs: number;
  readonly recastNavigationVersion: "0.43.0";
  readonly wasm: "@recast-navigation/wasm-compat";
}

export interface CombinedWorkerErrorMessage {
  readonly kind: "error";
  readonly phase: "initialization" | "request";
  readonly requestId?: number;
  readonly message: string;
}

export type VersionedWorkerRequest =
  | SnapshotRegisterMessage
  | SnapshotUpdateMessage
  | VersionedPathRequestMessage;
export type VersionedWorkerMessage =
  | SnapshotAckMessage
  | VersionedPathResultMessage
  | PathPostTelemetryMessage
  | CombinedReadyMessage
  | CombinedWorkerErrorMessage;

export interface VersionedWorkerLike {
  postMessage(message: VersionedWorkerRequest, transfer?: readonly Transferable[]): void;
  terminate(): void;
  setMessageHandler(handler: ((event: { data: VersionedWorkerMessage }) => void) | null): void;
}

export type VersionedWorkerFactory = () => VersionedWorkerLike;

export function epochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Deterministic payload accounting, not a claim about browser wire-format overhead. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function requestPayloadBytes(message: VersionedPathRequestMessage): number {
  return jsonBytes(message);
}

export function registrationPayloadBytes(message: SnapshotRegisterMessage): number {
  const { passable, ...scalar } = message;
  return jsonBytes(scalar) + passable.byteLength;
}

export function updatePayloadBytes(message: SnapshotUpdateMessage): number {
  const { indices, values, ...scalar } = message;
  return jsonBytes(scalar) + indices.byteLength + values.byteLength;
}

export function responsePayloadBytes(response: PathResponse): number {
  const { waypoints, ...scalar } = response;
  return jsonBytes(scalar) + waypoints.byteLength;
}

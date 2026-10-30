import type { PathResponse } from "../../src/sim/path/protocol";

export type SnapshotPlane = "land" | "naval" | "owner";
export type RequestClass = "leader" | "repath";
export type QueuePolicy = "fifo" | "batch-8" | "batch-16" | "batch-32" | "batch-64";

export function batchSizeForPolicy(policy: QueuePolicy): number {
  return policy === "fifo" ? 1 : Number(policy.slice("batch-".length));
}

/** Separate post-benchmark diagnostic; RTT uses only the main thread clock. */
export interface DeliveryProbeMessage {
  readonly kind: "delivery-probe";
  readonly probeId: number;
}
export interface DeliveryProbeAckMessage {
  readonly kind: "delivery-probe-ack";
  readonly probeId: number;
  readonly workerHandlingMs: number;
}

/** Production-suitable request identity: no embedded passability array. */
export interface SnapshotHandle {
  readonly snapshotId: number;
  readonly revision: number;
  readonly plane: SnapshotPlane;
  readonly width: number;
}

export interface SnapshotRegisterMessage {
  readonly kind: "snapshot-register";
  readonly handle: SnapshotHandle;
  readonly baseSnapshotId?: never;
  readonly passable: ArrayBuffer;
}

export interface SnapshotUpdateMessage {
  readonly kind: "snapshot-update";
  readonly handle: SnapshotHandle;
  readonly baseSnapshotId: number;
  readonly baseRevision: number;
  readonly indices: Uint32Array;
  readonly values: Uint8Array;
}

export interface QueuePathRequest {
  readonly id: number;
  readonly dueTick: number;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
  readonly seed: number;
  readonly snapshot: SnapshotHandle;
  readonly requestClass: RequestClass;
  /** Compute coalescing is legal only within the same explicit requester group. */
  readonly groupKey: string;
  readonly sentAtEpochMs: number;
}

export interface SinglePathMessage extends QueuePathRequest {
  readonly kind: "path";
}

export interface BatchPathMessage {
  readonly kind: "path-batch";
  readonly batchId: number;
  readonly requests: readonly QueuePathRequest[];
}

export interface SnapshotAckMessage {
  readonly kind: "snapshot-ack";
  readonly snapshotId: number;
  readonly revision: number;
  readonly plane: SnapshotPlane;
  readonly operation: "register" | "update";
  readonly binaryPayloadBytes: number;
  readonly deltaEntries: number;
  readonly workerHandlingMs: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
}

export interface QueuePathResultItem {
  readonly response: PathResponse;
  readonly requestClass: RequestClass;
  readonly workerQueueMs: number;
  readonly computeMs: number;
  readonly workerSentAtEpochMs: number;
  readonly responsePayloadBytes: number;
  readonly coalescedFromId?: number;
}

export interface PathResultsMessage {
  readonly kind: "path-results";
  readonly batchId: number;
  readonly batchSize: number;
  readonly items: readonly QueuePathResultItem[];
  /** Responses after the first occurrence of an exact compatibility key in this batch. */
  readonly coalescingEligibleResponses: number;
  readonly pathCacheSize: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
}

export type QueueWorkerRequest = SnapshotRegisterMessage | SnapshotUpdateMessage | SinglePathMessage | BatchPathMessage | DeliveryProbeMessage;
export type QueueWorkerMessage = SnapshotAckMessage | PathResultsMessage | DeliveryProbeAckMessage;

export interface QueueWorkerLike {
  postMessage(message: QueueWorkerRequest, transfer?: readonly Transferable[]): void;
  terminate(): void;
  setMessageHandler(handler: ((event: { data: QueueWorkerMessage }) => void) | null): void;
}
export type QueueWorkerFactory = () => QueueWorkerLike;

export function epochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

export function responsePayloadBytes(response: PathResponse): number {
  return response.waypoints.byteLength;
}

import type { PathResponse } from "../../src/sim/path/protocol";

export type SnapshotPlane = "land" | "naval" | "owner";
export type RequestClass = "leader" | "repath";
export type QueuePolicy = "fifo" | "priority" | "priority-batch";

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
  readonly pathCacheSize: number;
  readonly snapshotCount: number;
  readonly snapshotBytes: number;
}

export type QueueWorkerRequest = SnapshotRegisterMessage | SnapshotUpdateMessage | SinglePathMessage | BatchPathMessage;
export type QueueWorkerMessage = SnapshotAckMessage | PathResultsMessage;

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

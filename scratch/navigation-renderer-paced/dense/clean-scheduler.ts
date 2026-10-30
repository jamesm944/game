import { PATH_LATENCY, type PathRequest, type PathResponse } from "../../../src/sim/path/protocol";
import { PathScheduler, type PathRequestInput, type PathTransport } from "../../../src/sim/path/scheduler";
import { SchedulerOwnedSnapshotProvider, type SnapshotPreparation } from "./provider";
import type { SnapshotHandle } from "./protocol";

/** Experimental request union: production fields plus a handle, never a payload array. */
export interface CleanPathRequest {
  readonly kind: "path";
  readonly id: number;
  readonly dueTick: number;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
  readonly seed: number;
  readonly passableVersion: number;
  readonly snapshot: SnapshotHandle;
}
export type SchedulerRequest = PathRequest | CleanPathRequest;
export interface CleanPathTransport extends Omit<PathTransport, "send"> {
  ensureSnapshot(preparation: SnapshotPreparation): void;
  send(request: SchedulerRequest): void;
}
interface Outstanding {
  readonly dueTick: number;
  readonly passableVersion: number;
  readonly onApply: (response: PathResponse) => void;
  readonly onDiscard?: (() => void) | undefined;
}

/**
 * Scratch subclass/fork of production PathScheduler. pump/receive/due/stale
 * semantics are copied verbatim; only request construction uses the provider.
 * The super transport is inert and no production private state is used.
 */
export class CleanPathScheduler extends PathScheduler {
  readonly #cleanTransport: CleanPathTransport;
  readonly #provider: SchedulerOwnedSnapshotProvider;
  readonly #outstanding = new Map<number, Outstanding>();
  readonly #buffered = new Map<number, PathResponse>();
  #nextId = 0;
  #nextApplyId = 1;
  #blockedTicks = 0;
  #passabilityVersion = 0;

  constructor(transport: CleanPathTransport, provider: SchedulerOwnedSnapshotProvider) {
    super({ attach() {}, send() {}, dispose() {} });
    this.#cleanTransport = transport;
    this.#provider = provider;
    transport.attach((response) => this.receive(response));
  }

  override get passabilityVersion(): number { return this.#passabilityVersion; }
  override setPassabilityVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) throw new Error("passability version must be a u32");
    if (version < this.#passabilityVersion) throw new Error("passability versions must be monotonically increasing");
    this.#passabilityVersion = version;
  }
  override get blockedTicks(): number { return this.#blockedTicks; }
  override get pendingCount(): number { return this.#outstanding.size; }

  override requestPath(input: PathRequestInput, options: Readonly<{
    issueTick: number;
    seed: number;
    passability: Uint8Array;
    onApply: (response: PathResponse) => void;
    onDiscard?: (() => void) | undefined;
  }>): number {
    const id = ++this.#nextId;
    const dueTick = options.issueTick + PATH_LATENCY;
    const passableVersion = this.#passabilityVersion;
    this.#outstanding.set(id, {
      dueTick, passableVersion, onApply: options.onApply, onDiscard: options.onDiscard,
    });
    const preparation = this.#provider.prepare(passableVersion, "land", options.passability);
    this.#cleanTransport.ensureSnapshot(preparation);
    this.#cleanTransport.send({
      kind: "path", id, dueTick,
      startX: input.startX, startY: input.startY, goalX: input.goalX, goalY: input.goalY,
      seed: options.seed, passableVersion, snapshot: preparation.handle,
    });
    return id;
  }

  override receive(response: PathResponse): void {
    if (!this.#outstanding.has(response.id) || this.#buffered.has(response.id)) return;
    this.#buffered.set(response.id, response);
  }

  override pump(currentTick: number): boolean {
    for (;;) {
      const entry = this.#outstanding.get(this.#nextApplyId);
      if (entry === undefined || entry.dueTick > currentTick) return true;
      const response = this.#buffered.get(this.#nextApplyId);
      if (response === undefined) { this.#blockedTicks += 1; return false; }
      this.#buffered.delete(this.#nextApplyId);
      this.#outstanding.delete(this.#nextApplyId);
      this.#nextApplyId += 1;
      if (entry.passableVersion === this.#passabilityVersion) entry.onApply(response);
      else entry.onDiscard?.();
    }
  }
}

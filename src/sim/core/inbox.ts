/**
 * Command inbox — SPEC §2.1.
 *
 * Commands carry an ABSOLUTE target tick and are consumed only when
 * step() reaches that tick. Within one tick, consumption follows exact
 * submission order, keeping replays bit-reproducible.
 */

export interface SimCommand {
  readonly kind: string;
  readonly targetTick: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Replay instrumentation seam (M5-T3): fired once per drainDue with the
 * consumed tick and a private copy of the due commands, in consumption
 * order. step() drains exactly once per completed tick (a held boundary
 * returns before draining), so observers see one event per advanced tick.
 */
export type DrainObserver = (
  tick: number,
  commands: readonly SimCommand[],
) => void;

interface QueuedCommand {
  readonly seq: number;
  readonly command: SimCommand;
}

export class CommandInbox {
  readonly #queue: QueuedCommand[] = [];
  #nextSeq = 0;
  #consumedThroughTick = -1;
  #drainObserver: DrainObserver | undefined;
  #submitObserver: ((command: SimCommand) => void) | undefined;

  /**
   * Attach/detach the replay recorder's drain observer (M5-T3). At most
   * one observer — the recorder is the only sanctioned consumer.
   */
  setDrainObserver(observer: DrainObserver | undefined): void {
    this.#drainObserver = observer;
  }

  /**
   * Attach/detach the replay recorder's submit observer (M5-T3): fires
   * for every accepted submission, giving the recorder the provenance
   * it needs to tell player orders (external) from sim-generated ones
   * (planner/pop brain, emitted during step) apart.
   */
  setSubmitObserver(
    observer: ((command: SimCommand) => void) | undefined,
  ): void {
    this.#submitObserver = observer;
  }

  /**
   * Enqueue a command for a future tick. Submitting a command whose
   * target tick has already been consumed throws: late commands would
   * make replays irreproducible.
   */
  submit(command: SimCommand): void {
    if (!Number.isInteger(command.targetTick) || command.targetTick < 0) {
      throw new Error(
        `command target tick must be a non-negative integer, got ${String(command.targetTick)}`,
      );
    }
    if (command.kind.length === 0) {
      throw new Error("command kind must be non-empty");
    }
    if (command.targetTick <= this.#consumedThroughTick) {
      throw new Error(
        `late command: target tick ${String(command.targetTick)} is at or before the last consumed tick ${String(this.#consumedThroughTick)}`,
      );
    }
    const entry: QueuedCommand = { seq: this.#nextSeq++, command };
    let index = this.#queue.length;
    while (index > 0) {
      const prev = this.#queue[index - 1];
      if (!prev) break;
      if (
        prev.command.targetTick < command.targetTick ||
        (prev.command.targetTick === command.targetTick && prev.seq < entry.seq)
      ) {
        break;
      }
      index -= 1;
    }
    this.#queue.splice(index, 0, entry);
    this.#submitObserver?.(command);
  }

  /**
   * Consume every command with `targetTick <= tick`, oldest first.
   * Advances the consumption watermark even when empty, sealing past
   * ticks against late submissions forever.
   */
  drainDue(tick: number): readonly SimCommand[] {
    const due: SimCommand[] = [];
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (!head || head.command.targetTick > tick) break;
      due.push(head.command);
      this.#queue.shift();
    }
    if (tick > this.#consumedThroughTick) this.#consumedThroughTick = tick;
    if (this.#drainObserver !== undefined && due.length > 0) {
      this.#drainObserver(tick, [...due]);
    }
    return due;
  }

  /** Highest tick whose window has closed to new submissions. */
  get consumedThroughTick(): number {
    return this.#consumedThroughTick;
  }

  get size(): number {
    return this.#queue.length;
  }

  /**
   * Snapshot of every queued (not yet due) command in drain order —
   * SPEC §2.12's pending-command save section. Order is exactly the
   * (targetTick, submission seq) sort step() consumes, so resubmitting
   * the list through {@link restoreState} reproduces the queue.
   */
  pendingCommands(): readonly SimCommand[] {
    return this.#queue.map((entry) => entry.command);
  }

  /**
   * Save/restore seam: seal consumption through `tick`, then enqueue
   * `commands` in list order. Every target tick must be strictly
   * future (the same late-command rule submit enforces); callers pass
   * the snapshot from {@link pendingCommands} verbatim.
   */
  restoreState(tick: number, commands: readonly SimCommand[]): void {
    if (!Number.isInteger(tick) || tick < -1) {
      throw new Error(
        `consumed-through tick must be an integer ≥ -1, got ${String(tick)}`,
      );
    }
    if (this.#queue.length > 0 || this.#consumedThroughTick !== -1) {
      throw new Error("restoreState on a non-fresh inbox");
    }
    this.#consumedThroughTick = tick;
    for (const command of commands) this.submit(command);
  }
}

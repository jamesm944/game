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

interface QueuedCommand {
  readonly seq: number;
  readonly command: SimCommand;
}

export class CommandInbox {
  readonly #queue: QueuedCommand[] = [];
  #nextSeq = 0;
  #consumedThroughTick = -1;

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
    return due;
  }

  /** Highest tick whose window has closed to new submissions. */
  get consumedThroughTick(): number {
    return this.#consumedThroughTick;
  }

  get size(): number {
    return this.#queue.length;
  }
}

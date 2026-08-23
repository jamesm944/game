/**
 * OpenRA-style Activity queues — SPEC §2.1 / §2.2 / ADR-0003.
 *
 * Each Pop owns a FIFO queue of activities; the head is the current
 * activity. Queues are advanced ONLY inside step() (by systems), never
 * from render or input code — commands enqueue whole chains at tick
 * boundaries, which keeps replays bit-reproducible.
 *
 * M1 ships Move and Wait; M1-T9 appends Gather (work at a slot until
 * the carry fills or the node depletes) and Deliver (deposit carried
 * resources at a drop-off point). Both are advanced by the gather
 * system inside step(); travel legs stay plain Move activities so the
 * movement system keeps steering them. M2-T5 adds Attack and
 * attackMove, advanced by the combat system. Because the digest recipe
 * hashes numeric component rows, queues serialize to a flat number
 * stream via encodeActivities/decodeActivities (kind code, payload
 * length, payload… per activity).
 */

/** Flat waypoint pairs [x0,y0,x1,y1,…] in float tile coordinates. */
export interface MoveActivity {
  readonly kind: "move";
  /**
   * Owned mutable copy: the movement system replaces remaining
   * waypoints on individual re-paths.
   */
  waypoints: number[];
  /**
   * Index into `waypoints` of the NEXT target pair. Advances as
   * intermediate waypoints are reached; survives encode/decode because
   * it is part of the digest-visible numeric row.
   */
  cursor: number;
}

export interface WaitActivity {
  readonly kind: "wait";
  /** Ticks remaining before this activity completes. */
  ticks: number;
}

/**
 * Work the head-of-queue resource node: every `ticksPerUnit` ticks
 * extract one unit into the worker's inventory, until the carry
 * capacity fills or the node depletes (the gather system owns both
 * counters and completes the activity at either boundary).
 */
export interface GatherActivity {
  readonly kind: "gather";
  /** Ticks of work per extracted resource unit. */
  ticksPerUnit: number;
  /** Ticks already spent on the current unit. */
  elapsedTicks: number;
}

/**
 * Deposit the carried load into the owning player's stockpile via the
 * drop-off entity `dropoffEid`. Becomes meaningful only once the unit
 * has physically arrived; the gather system executes the deposit event
 * the tick this activity reaches the queue head.
 */
export interface DeliverActivity {
  readonly kind: "deliver";
  dropoffEid: number;
}

/**
 * Engage `targetEid` in combat (SPEC §2.5 / M2-T5). The combat system
 * advances this head: while out of range it inserts a Move approach leg
 * AHEAD of it (movement steers only the head), and once in range it
 * strikes on the reload cadence. When the target dies the head is
 * dropped — an attackMove behind it resumes automatically, a paused
 * gather chain picks its slot back up.
 */
export interface AttackActivity {
  readonly kind: "attack";
  targetEid: number;
}

/**
 * Attack-move: steer exactly like Move (same waypoint/cursor shape) but
 * flag the march as combat-ready — the combat system scans units whose
 * head is an attackMove for enemies inside their aggro radius and pauses
 * the march by inserting an Attack head in front (full acquire/resume
 * behavior lands with M2-T6).
 */
export interface AttackMoveActivity {
  readonly kind: "attackMove";
  waypoints: number[];
  cursor: number;
}

export type Activity =
  | MoveActivity
  | WaitActivity
  | GatherActivity
  | DeliverActivity
  | AttackActivity
  | AttackMoveActivity;

/** Numeric activity kind codes — stable, never renumber. */
export const ACTIVITY_KIND_MOVE = 1;
export const ACTIVITY_KIND_WAIT = 2;
export const ACTIVITY_KIND_GATHER = 3;
export const ACTIVITY_KIND_DELIVER = 4;
export const ACTIVITY_KIND_ATTACK = 5;
export const ACTIVITY_KIND_ATTACK_MOVE = 6;

export type ActivityQueue = Activity[];

export function createActivityQueue(): ActivityQueue {
  return [];
}

/** Currently executing activity, if any. */
export function peekActivity(queue: ActivityQueue): Activity | undefined {
  return queue[0];
}

/** Append an activity after everything already queued. */
export function enqueueActivity(
  queue: ActivityQueue,
  activity: Activity,
): void {
  queue.push(activity);
}

/** Complete and discard the current activity. */
export function dequeueCurrentActivity(queue: ActivityQueue): void {
  queue.shift();
}

/** Cancel everything queued (OpenRA "stop"). */
export function cancelActivities(queue: ActivityQueue): void {
  queue.length = 0;
}

/** Build a Move activity over a copy of the given flat waypoints. */
export function moveActivity(waypoints: readonly number[]): MoveActivity {
  if (waypoints.length < 2 || waypoints.length % 2 !== 0) {
    throw new Error(
      `move activity needs an even number of waypoint coordinates ≥ 2, got ${String(waypoints.length)}`,
    );
  }
  return { kind: "move", waypoints: [...waypoints], cursor: 0 };
}

/** Build a Wait activity lasting `ticks` more sim ticks. */
export function waitActivity(ticks: number): WaitActivity {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new Error(
      `wait ticks must be a non-negative integer, got ${String(ticks)}`,
    );
  }
  return { kind: "wait", ticks };
}

/** Build a Gather activity working `ticksPerUnit` ticks per unit. */
export function gatherActivity(
  ticksPerUnit: number,
  elapsedTicks = 0,
): GatherActivity {
  if (!Number.isInteger(ticksPerUnit) || ticksPerUnit <= 0) {
    throw new Error(
      `gather ticks per unit must be a positive integer, got ${String(ticksPerUnit)}`,
    );
  }
  if (
    !Number.isInteger(elapsedTicks) ||
    elapsedTicks < 0 ||
    elapsedTicks >= ticksPerUnit
  ) {
    throw new Error(
      `gather elapsed ticks must be an integer in [0, ${String(ticksPerUnit)}), got ${String(elapsedTicks)}`,
    );
  }
  return { kind: "gather", ticksPerUnit, elapsedTicks };
}

/** Build a Deliver activity targeting the drop-off entity `dropoffEid`. */
export function deliverActivity(dropoffEid: number): DeliverActivity {
  if (!Number.isInteger(dropoffEid) || dropoffEid < 1) {
    throw new Error(
      `deliver drop-off entity id must be a positive integer, got ${String(dropoffEid)}`,
    );
  }
  return { kind: "deliver", dropoffEid };
}

/** Build an Attack activity engaging `targetEid`. */
export function attackActivity(targetEid: number): AttackActivity {
  if (!Number.isInteger(targetEid) || targetEid < 1) {
    throw new Error(
      `attack target entity id must be a positive integer, got ${String(targetEid)}`,
    );
  }
  return { kind: "attack", targetEid };
}

/** Build an attackMove activity over a copy of the given flat waypoints. */
export function attackMoveActivity(
  waypoints: readonly number[],
): AttackMoveActivity {
  if (waypoints.length < 2 || waypoints.length % 2 !== 0) {
    throw new Error(
      `attackMove activity needs an even number of waypoint coordinates ≥ 2, got ${String(waypoints.length)}`,
    );
  }
  return { kind: "attackMove", waypoints: [...waypoints], cursor: 0 };
}

/** Serialize a queue to the digest-friendly numeric row format. */
export function encodeActivities(queue: readonly Activity[]): number[] {
  const row: number[] = [queue.length];
  for (const activity of queue) {
    if (activity.kind === "move") {
      // payload: cursor first, then flat waypoint pairs.
      row.push(
        ACTIVITY_KIND_MOVE,
        activity.waypoints.length + 1,
        activity.cursor,
        ...activity.waypoints,
      );
    } else if (activity.kind === "wait") {
      row.push(ACTIVITY_KIND_WAIT, 1, activity.ticks);
    } else if (activity.kind === "gather") {
      row.push(
        ACTIVITY_KIND_GATHER,
        2,
        activity.ticksPerUnit,
        activity.elapsedTicks,
      );
    } else if (activity.kind === "deliver") {
      row.push(ACTIVITY_KIND_DELIVER, 1, activity.dropoffEid);
    } else if (activity.kind === "attack") {
      row.push(ACTIVITY_KIND_ATTACK, 1, activity.targetEid);
    } else {
      // attackMove shares the move payload shape (cursor + flat pairs).
      row.push(
        ACTIVITY_KIND_ATTACK_MOVE,
        activity.waypoints.length + 1,
        activity.cursor,
        ...activity.waypoints,
      );
    }
  }
  return row;
}

/** Rebuild a queue from its encoded numeric row (validates loudly). */
export function decodeActivities(row: readonly number[]): ActivityQueue {
  const rawCount = row[0];
  if (
    typeof rawCount !== "number" ||
    !Number.isInteger(rawCount) ||
    rawCount < 0
  ) {
    throw new Error(`activity row has malformed count: ${String(row[0])}`);
  }
  const queue: ActivityQueue = [];
  let cursor = 1;
  for (let i = 0; i < rawCount; i++) {
    const kind = row[cursor];
    const rawPayloadLength = row[cursor + 1];
    if (
      kind === undefined ||
      typeof rawPayloadLength !== "number" ||
      !Number.isInteger(rawPayloadLength) ||
      rawPayloadLength < 0
    ) {
      throw new Error(`activity row entry ${String(i)} is malformed`);
    }
    const payloadLength: number = rawPayloadLength;
    const payload: number[] = [];
    for (let j = 0; j < payloadLength; j++) {
      const value = row[cursor + 2 + j];
      if (value === undefined) {
        throw new Error(`activity row entry ${String(i)} truncated`);
      }
      payload.push(value);
    }
    if (kind === ACTIVITY_KIND_MOVE || kind === ACTIVITY_KIND_ATTACK_MOVE) {
      if (payloadLength < 3 || (payloadLength - 1) % 2 !== 0) {
        throw new Error(
          `${kind === ACTIVITY_KIND_MOVE ? "move" : "attackMove"} activity ${String(i)} has malformed waypoint payload`,
        );
      }
      const cursor = payload[0]!;
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor % 2 !== 0 ||
        cursor > payload.length - 3
      ) {
        throw new Error(
          `${kind === ACTIVITY_KIND_MOVE ? "move" : "attackMove"} activity ${String(i)} has out-of-range cursor`,
        );
      }
      queue.push({
        kind: kind === ACTIVITY_KIND_MOVE ? "move" : "attackMove",
        waypoints: payload.slice(1),
        cursor,
      });
    } else if (kind === ACTIVITY_KIND_WAIT) {
      if (payloadLength !== 1) {
        throw new Error(
          `wait activity ${String(i)} must carry exactly one value`,
        );
      }
      queue.push({ kind: "wait", ticks: payload[0]! });
    } else if (kind === ACTIVITY_KIND_GATHER) {
      if (payloadLength !== 2) {
        throw new Error(
          `gather activity ${String(i)} must carry exactly two values`,
        );
      }
      const ticksPerUnit = payload[0]!;
      const elapsedTicks = payload[1]!;
      if (!Number.isInteger(ticksPerUnit) || ticksPerUnit <= 0) {
        throw new Error(
          `gather activity ${String(i)} has malformed ticks per unit`,
        );
      }
      if (
        !Number.isInteger(elapsedTicks) ||
        elapsedTicks < 0 ||
        elapsedTicks >= ticksPerUnit
      ) {
        throw new Error(
          `gather activity ${String(i)} has out-of-range elapsed ticks`,
        );
      }
      queue.push({ kind: "gather", ticksPerUnit, elapsedTicks });
    } else if (kind === ACTIVITY_KIND_DELIVER) {
      if (payloadLength !== 1) {
        throw new Error(
          `deliver activity ${String(i)} must carry exactly one value`,
        );
      }
      const dropoffEid = payload[0]!;
      if (!Number.isInteger(dropoffEid) || dropoffEid < 1) {
        throw new Error(
          `deliver activity ${String(i)} has malformed drop-off entity id`,
        );
      }
      queue.push({ kind: "deliver", dropoffEid });
    } else if (kind === ACTIVITY_KIND_ATTACK) {
      if (payloadLength !== 1) {
        throw new Error(
          `attack activity ${String(i)} must carry exactly one value`,
        );
      }
      const targetEid = payload[0]!;
      if (!Number.isInteger(targetEid) || targetEid < 1) {
        throw new Error(
          `attack activity ${String(i)} has malformed target entity id`,
        );
      }
      queue.push({ kind: "attack", targetEid });
    } else {
      throw new Error(`unknown activity kind code: ${String(kind)}`);
    }
    cursor += 2 + payloadLength;
  }
  if (cursor !== row.length) {
    throw new Error(
      `activity row has ${String(row.length - cursor)} trailing values`,
    );
  }
  return queue;
}

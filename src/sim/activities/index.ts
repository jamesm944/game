/**
 * OpenRA-style Activity queues — SPEC §2.1 / §2.2 / ADR-0003.
 *
 * Each Pop owns a FIFO queue of activities; the head is the current
 * activity. Queues are advanced ONLY inside step() (by systems), never
 * from render or input code — commands enqueue whole chains at tick
 * boundaries, which keeps replays bit-reproducible.
 *
 * M1 ships Move and Wait; later tickets append Gather/Return/Build/…
 * behind the same shape. Because the digest recipe hashes numeric
 * component rows, queues serialize to a flat number stream via
 * encodeActivities/decodeActivities (kind code, payload length,
 * payload… per activity).
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

export type Activity = MoveActivity | WaitActivity;

/** Numeric activity kind codes — stable, never renumber. */
export const ACTIVITY_KIND_MOVE = 1;
export const ACTIVITY_KIND_WAIT = 2;

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
    } else {
      row.push(ACTIVITY_KIND_WAIT, 1, activity.ticks);
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
    if (kind === ACTIVITY_KIND_MOVE) {
      if (payloadLength < 3 || (payloadLength - 1) % 2 !== 0) {
        throw new Error(
          `move activity ${String(i)} has malformed waypoint payload`,
        );
      }
      const cursor = payload[0]!;
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor % 2 !== 0 ||
        cursor > payload.length - 3
      ) {
        throw new Error(`move activity ${String(i)} has out-of-range cursor`);
      }
      queue.push({ kind: "move", waypoints: payload.slice(1), cursor });
    } else if (kind === ACTIVITY_KIND_WAIT) {
      if (payloadLength !== 1) {
        throw new Error(
          `wait activity ${String(i)} must carry exactly one value`,
        );
      }
      queue.push({ kind: "wait", ticks: payload[0]! });
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

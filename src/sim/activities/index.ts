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

import { unitCodeOf, unitIdOfCode } from "../../data/definitions";

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

/**
 * Eat at `dropoffEid` (SPEC §2.3 needs / M3-T3): the needs system plans
 * [Move door, Eat] chains for hungry Pops and advances the head — while
 * out of range it inserts a fresh approach leg AHEAD (movement steers
 * only the head), and within reach it debits the drop-off owner's food
 * ledger once and restores the eater's meters.
 */
export interface EatActivity {
  readonly kind: "eat";
  dropoffEid: number;
}

/**
 * Sleep until `wakeTick` (SPEC §2.4 day/night / M3-T6): the schedules
 * system plans [Move bed, Sleep] chains at the night band and owns this
 * head exclusively — movement merely PARKS sleepers (no decrement, unlike
 * wait), and when `world.tick` reaches wakeTick the schedules pass pops
 * the head and applies the sleep-quality Rest refill exactly once.
 * `isNap` marks daytime micro-sleeps (deprivation napping idles), which
 * restore a small fixed amount instead of the housing-scaled refill.
 */
export interface SleepActivity {
  readonly kind: "sleep";
  wakeTick: number;
  isNap: boolean;
}

/**
 * Leisure at a venue or host (SPEC §2.4 social life / M3-T7): the
 * social system plans [Move door, Leisure] chains from IAUS-scored
 * evening choices and owns this head exclusively — movement parks it
 * exactly like eat/sleep, and on arrival the SOCIAL system executes the
 * venue behavior (gold sink, morale buff, bond increments, jealousy
 * roll) and drops the head. `venueCode` is one of the LEISURE_VENUE_*
 * stable codes; `targetEid` is the venue building eid (pay/study/
 * worship venues) or the visited host Pop's eid (visit), 0 = none.
 *
 * M3-T8 adds LEISURE_VENUE_MASS: same chain shape, but booked by the
 * communal Sunday Mass planner (systems/mass.ts) rather than scored by
 * the brain — §2.4 "community attends Morning Mass".
 */
export interface LeisureActivity {
  readonly kind: "leisure";
  venueCode: number;
  targetEid: number;
}

/**
 * Patrol: walk between waypoints indefinitely, auto-attacking enemies in sight range,
 * reversing direction when the final/initial waypoint is reached (V13, Issue #95).
 */
export interface PatrolActivity {
  readonly kind: "patrol";
  waypoints: number[];
  cursor: number;
  direction: number; // 1 for forward, -1 for backward
}

/**
 * Guard: follow targetEid at ≤1.5 tile distance and auto-attack anything that attacks it (V13, Issue #95).
 */
export interface GuardActivity {
  readonly kind: "guard";
  targetEid: number;
}

/**
 * Garrison: walk to targetBuildingId and enter it (V13, Issue #96).
 */
export interface GarrisonActivity {
  readonly kind: "garrison";
  targetBuildingId: number;
}

/**
 * Pack or unpack a siege weapon (e.g. Trebuchet) over packTimeTicks (V13, Issue #97).
 */
export interface PackActivity {
  readonly kind: "pack";
  remainingTicks: number;
  targetUnitId: string;
}

/**
 * Convert an enemy unit to the monk's player ownership (V14, Issue #101).
 */
export interface ConvertActivity {
  readonly kind: "convert";
  targetEid: number;
}

export type Activity =
  | MoveActivity
  | WaitActivity
  | GatherActivity
  | DeliverActivity
  | AttackActivity
  | AttackMoveActivity
  | EatActivity
  | SleepActivity
  | LeisureActivity
  | PatrolActivity
  | GuardActivity
  | GarrisonActivity
  | PackActivity
  | ConvertActivity;

/** Numeric activity kind codes — stable, never renumber. */
export const ACTIVITY_KIND_MOVE = 1;
export const ACTIVITY_KIND_WAIT = 2;
export const ACTIVITY_KIND_GATHER = 3;
export const ACTIVITY_KIND_DELIVER = 4;
export const ACTIVITY_KIND_ATTACK = 5;
export const ACTIVITY_KIND_ATTACK_MOVE = 6;
export const ACTIVITY_KIND_EAT = 7;
export const ACTIVITY_KIND_SLEEP = 8;
export const ACTIVITY_KIND_LEISURE = 9;
export const ACTIVITY_KIND_PATROL = 10;
export const ACTIVITY_KIND_GUARD = 11;
export const ACTIVITY_KIND_GARRISON = 12;
export const ACTIVITY_KIND_PACK = 13;
export const ACTIVITY_KIND_CONVERT = 14;

/** Stable leisure-venue codes carried inside Leisure payloads. */
export const LEISURE_VENUE_TAVERN = 1;
export const LEISURE_VENUE_BROTHEL = 2;
export const LEISURE_VENUE_SHRINE = 3;
export const LEISURE_VENUE_STUDY = 4;
export const LEISURE_VENUE_VISIT = 5;
/** M3-T8: Sunday Morning Mass at a finished Church (communal booking). */
export const LEISURE_VENUE_MASS = 6;

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

/** Build an Eat activity targeting the drop-off entity `dropoffEid`. */
export function eatActivity(dropoffEid: number): EatActivity {
  if (!Number.isInteger(dropoffEid) || dropoffEid < 1) {
    throw new Error(
      `eat drop-off entity id must be a positive integer, got ${String(dropoffEid)}`,
    );
  }
  return { kind: "eat", dropoffEid };
}

/** Build a Sleep activity ending at `wakeTick` (naps flag `isNap`). */
export function sleepActivity(wakeTick: number, isNap = false): SleepActivity {
  if (!Number.isInteger(wakeTick) || wakeTick < 0) {
    throw new Error(
      `sleep wake tick must be a non-negative integer, got ${String(wakeTick)}`,
    );
  }
  return { kind: "sleep", wakeTick, isNap };
}

/** Build a Leisure activity at `venueCode` targeting `targetEid`. */
export function leisureActivity(
  venueCode: number,
  targetEid: number,
): LeisureActivity {
  if (
    !Number.isInteger(venueCode) ||
    venueCode < LEISURE_VENUE_TAVERN ||
    venueCode > LEISURE_VENUE_MASS
  ) {
    throw new Error(`leisure venue code out of range: ${String(venueCode)}`);
  }
  if (!Number.isInteger(targetEid) || targetEid < 0) {
    throw new Error(
      `leisure target entity id must be a non-negative integer, got ${String(targetEid)}`,
    );
  }
  return { kind: "leisure", venueCode, targetEid };
}

/** Build a Patrol activity over a copy of the given flat waypoints. */
export function patrolActivity(
  waypoints: readonly number[],
  cursor = 0,
  direction = 1,
): PatrolActivity {
  if (waypoints.length < 4 || waypoints.length % 2 !== 0) {
    throw new Error(
      `patrol activity needs an even number of waypoint coordinates ≥ 4, got ${String(waypoints.length)}`,
    );
  }
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor % 2 !== 0 ||
    cursor > waypoints.length - 2
  ) {
    throw new Error(`patrol cursor out of range: ${String(cursor)}`);
  }
  return {
    kind: "patrol",
    waypoints: [...waypoints],
    cursor,
    direction: direction === -1 ? -1 : 1,
  };
}

/** Build a Guard activity targeting entity targetEid. */
export function guardActivity(targetEid: number): GuardActivity {
  if (!Number.isInteger(targetEid) || targetEid < 1) {
    throw new Error(
      `guard target entity id must be a positive integer, got ${String(targetEid)}`,
    );
  }
  return { kind: "guard", targetEid };
}

/** Build a Garrison activity targeting targetBuildingId. */
export function garrisonActivity(targetBuildingId: number): GarrisonActivity {
  if (!Number.isInteger(targetBuildingId) || targetBuildingId < 1) {
    throw new Error(
      `garrison target building entity id must be a positive integer, got ${String(targetBuildingId)}`,
    );
  }
  return { kind: "garrison", targetBuildingId };
}

/** Build a Pack activity to morph into targetUnitId over remainingTicks. */
export function packActivity(
  remainingTicks: number,
  targetUnitId: string,
): PackActivity {
  if (!Number.isInteger(remainingTicks) || remainingTicks < 0) {
    throw new Error(
      `pack remaining ticks must be a non-negative integer, got ${String(remainingTicks)}`,
    );
  }
  if (!targetUnitId || typeof targetUnitId !== "string") {
    throw new Error(
      `pack targetUnitId must be a non-empty string, got ${String(targetUnitId)}`,
    );
  }
  return { kind: "pack", remainingTicks, targetUnitId };
}

/** Build a Convert activity targeting enemy unit targetEid (V14, Issue #101). */
export function convertActivity(targetEid: number): ConvertActivity {
  if (!Number.isInteger(targetEid) || targetEid < 1) {
    throw new Error(
      `convert target entity id must be a positive integer, got ${String(targetEid)}`,
    );
  }
  return { kind: "convert", targetEid };
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
    } else if (activity.kind === "eat") {
      row.push(ACTIVITY_KIND_EAT, 1, activity.dropoffEid);
    } else if (activity.kind === "sleep") {
      row.push(
        ACTIVITY_KIND_SLEEP,
        2,
        activity.wakeTick,
        activity.isNap ? 1 : 0,
      );
    } else if (activity.kind === "leisure") {
      row.push(
        ACTIVITY_KIND_LEISURE,
        2,
        activity.venueCode,
        activity.targetEid,
      );
    } else if (activity.kind === "patrol") {
      row.push(
        ACTIVITY_KIND_PATROL,
        activity.waypoints.length + 2,
        activity.cursor,
        activity.direction === -1 ? 0 : 1,
        ...activity.waypoints,
      );
    } else if (activity.kind === "guard") {
      row.push(ACTIVITY_KIND_GUARD, 1, activity.targetEid);
    } else if (activity.kind === "garrison") {
      row.push(ACTIVITY_KIND_GARRISON, 1, activity.targetBuildingId);
    } else if (activity.kind === "pack") {
      row.push(
        ACTIVITY_KIND_PACK,
        2,
        activity.remainingTicks,
        unitCodeOf(activity.targetUnitId),
      );
    } else if (activity.kind === "convert") {
      row.push(ACTIVITY_KIND_CONVERT, 1, activity.targetEid);
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
    } else if (kind === ACTIVITY_KIND_EAT) {
      if (payloadLength !== 1) {
        throw new Error(
          `eat activity ${String(i)} must carry exactly one value`,
        );
      }
      const dropoffEid = payload[0]!;
      if (!Number.isInteger(dropoffEid) || dropoffEid < 1) {
        throw new Error(
          `eat activity ${String(i)} has malformed drop-off entity id`,
        );
      }
      queue.push({ kind: "eat", dropoffEid });
    } else if (kind === ACTIVITY_KIND_SLEEP) {
      if (payloadLength !== 2) {
        throw new Error(
          `sleep activity ${String(i)} must carry exactly two values`,
        );
      }
      const wakeTick = payload[0]!;
      const napFlag = payload[1]!;
      if (!Number.isInteger(wakeTick) || wakeTick < 0) {
        throw new Error(`sleep activity ${String(i)} has malformed wake tick`);
      }
      if (napFlag !== 0 && napFlag !== 1) {
        throw new Error(`sleep activity ${String(i)} has malformed nap flag`);
      }
      queue.push({ kind: "sleep", wakeTick, isNap: napFlag === 1 });
    } else if (kind === ACTIVITY_KIND_LEISURE) {
      if (payloadLength !== 2) {
        throw new Error(
          `leisure activity ${String(i)} must carry exactly two values`,
        );
      }
      const venueCode = payload[0]!;
      const targetEid = payload[1]!;
      if (
        !Number.isInteger(venueCode) ||
        venueCode < LEISURE_VENUE_TAVERN ||
        venueCode > LEISURE_VENUE_MASS
      ) {
        throw new Error(
          `leisure activity ${String(i)} has malformed venue code`,
        );
      }
      if (!Number.isInteger(targetEid) || targetEid < 0) {
        throw new Error(
          `leisure activity ${String(i)} has malformed target entity id`,
        );
      }
      queue.push({ kind: "leisure", venueCode, targetEid });
    } else if (kind === ACTIVITY_KIND_PATROL) {
      if (payloadLength < 4 || (payloadLength - 2) % 2 !== 0) {
        throw new Error(
          `patrol activity ${String(i)} has malformed waypoint payload`,
        );
      }
      const cursor = payload[0]!;
      const dirFlag = payload[1]!;
      if (dirFlag !== 0 && dirFlag !== 1) {
        throw new Error(`patrol activity ${String(i)} has malformed direction flag`);
      }
      const waypoints = payload.slice(2);
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor % 2 !== 0 ||
        cursor > waypoints.length - 2
      ) {
        throw new Error(`patrol activity ${String(i)} has out-of-range cursor`);
      }
      queue.push({
        kind: "patrol",
        waypoints,
        cursor,
        direction: dirFlag === 1 ? 1 : -1,
      });
    } else if (kind === ACTIVITY_KIND_GUARD) {
      if (payloadLength !== 1) {
        throw new Error(
          `guard activity ${String(i)} must carry exactly one value`,
        );
      }
      const targetEid = payload[0]!;
      if (!Number.isInteger(targetEid) || targetEid < 1) {
        throw new Error(
          `guard activity ${String(i)} has malformed target entity id`,
        );
      }
      queue.push({ kind: "guard", targetEid });
    } else if (kind === ACTIVITY_KIND_GARRISON) {
      if (payloadLength !== 1) {
        throw new Error(
          `garrison activity ${String(i)} must carry exactly one value`,
        );
      }
      const targetBuildingId = payload[0]!;
      if (!Number.isInteger(targetBuildingId) || targetBuildingId < 1) {
        throw new Error(
          `garrison activity ${String(i)} has malformed target building entity id`,
        );
      }
      queue.push({ kind: "garrison", targetBuildingId });
    } else if (kind === ACTIVITY_KIND_PACK) {
      if (payloadLength !== 2) {
        throw new Error(
          `pack activity ${String(i)} must carry exactly two values`,
        );
      }
      const remainingTicks = payload[0]!;
      const targetCode = payload[1]!;
      if (!Number.isInteger(remainingTicks) || remainingTicks < 0) {
        throw new Error(
          `pack activity ${String(i)} has malformed remaining ticks`,
        );
      }
      if (!Number.isInteger(targetCode) || targetCode < 1) {
        throw new Error(
          `pack activity ${String(i)} has malformed target unit code`,
        );
      }
      queue.push({
        kind: "pack",
        remainingTicks,
        targetUnitId: unitIdOfCode(targetCode),
      });
    } else if (kind === ACTIVITY_KIND_CONVERT) {
      if (payloadLength !== 1) {
        throw new Error(
          `convert activity ${String(i)} must carry exactly one value`,
        );
      }
      const targetEid = payload[0]!;
      if (!Number.isInteger(targetEid) || targetEid < 1) {
        throw new Error(
          `convert activity ${String(i)} has malformed target entity id`,
        );
      }
      queue.push({ kind: "convert", targetEid });
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

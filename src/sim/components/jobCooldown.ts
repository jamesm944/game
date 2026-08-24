/**
 * Job-cooldown component — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). JobCooldown slots between
 * Inventory and MealConsumed.
 *
 * DFHack `building.setJobCooldown` prior art (docs/research/
 * pop-sim-sources.md): after a worker takes a job AT a target, the
 * target refuses further brain assignments until a cooldown elapses.
 * The IAUS pop brain (ai/popBrain.ts) stamps rows; nothing else reads
 * or writes them. Storing the window ON THE TARGET keeps the state
 * digest-visible and replay-safe — no hidden brain-side table — and
 * doubles as load-spreading: a fresh assignment to one tree/bench
 * pushes the next idle Pop onto the runner-up candidate.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * JobCooldown (1): [readyTick] — first tick the target accepts another
 * brain assignment. Absent row = no cooldown.
 */

import type { ComponentRows, World } from "../core/world";

export const JOB_COOLDOWN = "JobCooldown" as const;

/** Row arity per job-cooldown component — pinned for digest stability. */
export const JOB_COOLDOWN_ARITY = 1;

/** Component ids the job-cooldown readers need. */
export interface BrainCooldownComponents {
  readonly jobCooldownId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** Ready tick stamped on `targetEid`, or undefined when uncooled. */
export function jobCooldownReadyTickOf(
  world: World,
  comps: Pick<BrainCooldownComponents, "jobCooldownId">,
  targetEid: number,
): number | undefined {
  return requireRows(world, comps.jobCooldownId).get(targetEid)?.[0];
}

/**
 * True while `targetEid` refuses new brain assignments (readyTick is
 * set AND still in the future relative to `tick`).
 */
export function jobCooldownActive(
  world: World,
  comps: Pick<BrainCooldownComponents, "jobCooldownId">,
  targetEid: number,
  tick: number,
): boolean {
  const ready = jobCooldownReadyTickOf(world, comps, targetEid);
  return ready !== undefined && ready > tick;
}

/**
 * Stamp/refresh the cooldown window on `targetEid`: no further brain
 * assignment lands here until `readyTick`. Player orders ignore this
 * entirely — direct commands always win (#48 override rule).
 */
export function stampJobCooldown(
  world: World,
  comps: Pick<BrainCooldownComponents, "jobCooldownId">,
  targetEid: number,
  readyTick: number,
): void {
  if (!Number.isInteger(readyTick) || readyTick < 0) {
    throw new Error(
      `job cooldown ready tick must be a non-negative integer, got ${String(readyTick)}`,
    );
  }
  requireRows(world, comps.jobCooldownId).set(targetEid, [readyTick]);
}

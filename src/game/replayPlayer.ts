/**
 * Replay player — SPEC §2.12 / M5-T3 (issue #65).
 *
 * Rebuilds a recorded skirmish from its golden-fixture artifact:
 * boots {@link createSkirmishWorld} from the artifact's seed, gates the
 * map hash BEFORE stepping ({@link assertReplayMapHash}), resubmits the
 * logged `{tick,type,payload}` commands through the real inbox exactly
 * on their recorded consumption ticks, and compares §7 milestone
 * digests as they come due. First mismatch stops the run and reports
 * `{tick, expected, actual}` — the loud desync report SPEC §2.12
 * demands instead of a silent drift.
 *
 * One code path serves both callers: the browser's Import-replay flow
 * (worker transport; chunked awaits keep the progress overlay painting)
 * and headless tests / generated golden fixtures (synchronous
 * transport). The path scheduler's hold-on-late-response contract makes
 * transport timing irrelevant to outcomes, so both produce identical
 * digests.
 *
 * Lives in game/, not sim/: it orchestrates full session bootstraps,
 * like session.ts does (sim stays import-free of game code).
 */

import { computeWorldDigest, step } from "../sim/core/world";
import { PLAYER_ONE } from "../sim/core/stockpile";
import {
  createSynchronousPathTransport,
  type PathTransport,
} from "../sim/path/scheduler";
import { evaluateOutcome, unitsLostOf } from "../sim/systems/victory";
import type { ReplayArtifact, ReplayMilestone } from "../sim/replay/record";
import { assertReplayMapHash } from "../sim/replay/play";
import type { VictoryEndReason, VictorySide } from "../ui/victoryScreen";
import {
  createSkirmishWorld,
  type SkirmishWorld,
  type SkirmishWorldOptions,
} from "./session";

/** Where a replay stopped matching its recorded milestones. */
export interface ReplayDivergence {
  /** Index into the artifact's milestones array. */
  readonly index: number;
  readonly tick: number;
  /** Digest recorded by the exporting build. */
  readonly expected: string;
  /** Digest this build actually computed. */
  readonly actual: string;
}

export interface ReplayRunResult {
  /** The fully bootstrapped session after the final completed step. */
  readonly session: SkirmishWorld;
  /** Milestone digests computed during THIS run (may stop early). */
  readonly milestones: readonly ReplayMilestone[];
  /** Defined iff the run stopped on a first-mismatch desync. */
  readonly divergence: ReplayDivergence | undefined;
}

export interface ReplayRunOptions {
  /**
   * Transport factory. Defaults to the synchronous transport (tests);
   * the browser passes the production worker transport.
   */
  readonly createTransport?: (() => PathTransport) | undefined;
  /** Progress hook for overlays: ticks completed / total ticks. */
  readonly onProgress?: ((tickDone: number, total: number) => void) | undefined;
  /**
   * How often (in ticks) the loop yields to the event loop and reports
   * progress. Pure overhead in tests; the browser needs it to paint.
   */
  readonly progressEveryTicks?: number | undefined;
}

const DEFAULT_PROGRESS_EVERY_TICKS = 30;
/** Bound against a wedged scheduler so playback fails, never hangs. */
const MAX_HELD_STEPS_PER_TICK = 10_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Replay `replay` headlessly to its end or first divergence. Throws
 * {@link ReplayFormatError} when the header gate rejects the file
 * (recorded map hash ≠ this build's seed-driven map).
 */
export async function runReplayHeadless(
  replay: ReplayArtifact,
  options: ReplayRunOptions = {},
): Promise<ReplayRunResult> {
  const progressEvery =
    options.progressEveryTicks ?? DEFAULT_PROGRESS_EVERY_TICKS;
  const sessionOptions: SkirmishWorldOptions = {
    createTransport: options.createTransport ?? createSynchronousPathTransport,
  };
  const session = createSkirmishWorld(replay.seed, sessionOptions);
  const world = session.world;

  // Header gate FIRST (SPEC §2.12: reject mismatch loudly, never drift).
  assertReplayMapHash(replay, world.layers);

  const computed: ReplayMilestone[] = [];
  let divergence: ReplayDivergence | undefined;
  let nextCommand = 0;

  for (let tick = 1; tick <= replay.ticks && divergence === undefined; tick++) {
    // Deliver every command recorded for exactly this tick, in log
    // order (the inbox preserves same-tick order by submission seq).
    // Validation guarantees ticks within [1, replay.ticks] ascending,
    // so the pointer advances monotonically.
    while (
      nextCommand < replay.commands.length &&
      replay.commands[nextCommand]!.tick === tick
    ) {
      const record = replay.commands[nextCommand]!;
      world.inbox.submit(
        record.payload === undefined
          ? { kind: record.type, targetTick: record.tick }
          : {
              kind: record.type,
              targetTick: record.tick,
              data: record.payload,
            },
      );
      nextCommand += 1;
    }

    // step() may hold a boundary on a late path response (worker
    // transports); retry until the tick completes or the bound trips.
    // A sim throw mid-replay usually means an earlier silent divergence
    // left the world inconsistent with the log — surface the tick.
    for (
      let held = 0;
      held < MAX_HELD_STEPS_PER_TICK && world.tick < tick;
      held++
    ) {
      try {
        step(world);
      } catch (error) {
        throw new Error(
          `replay sim threw at tick ${String(tick)} (the artifact likely diverged earlier): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (world.tick !== tick) {
      throw new Error(
        `replay stalled at tick ${String(world.tick)} waiting on path responses`,
      );
    }

    if (tick % progressEvery === 0 || tick === replay.ticks) {
      options.onProgress?.(tick, replay.ticks);
      await yieldToEventLoop();
    }

    if (tick % replay.milestoneEvery === 0 || tick === replay.ticks) {
      const digest = computeWorldDigest(world);
      const index = computed.length;
      const expected = replay.milestones[index];
      computed.push({ tick, digest });
      if (expected === undefined || expected.tick !== tick) {
        divergence = {
          index,
          tick,
          expected: expected?.digest ?? "fnv1a64:<milestone missing>",
          actual: digest,
        };
      } else if (expected.digest !== digest) {
        divergence = { index, tick, expected: expected.digest, actual: digest };
      }
    }
  }

  return { session, milestones: computed, divergence };
}

/** Outcome recap shaped for the shared victory screen. */
export interface ReplayOutcome {
  readonly decided: boolean;
  readonly side: VictorySide;
  readonly reason: VictoryEndReason;
  readonly stats: {
    readonly ticksElapsed: number;
    readonly viewerUnitsLost: number;
    readonly enemyUnitsLost: number;
  };
}

/**
 * Evaluate the replayed world through the SAME victory evaluator the
 * live HUD polls, mapped to the viewer's perspective (identical logic
 * to main.ts's pollMatchOutcome).
 */
export function replayOutcomeOf(session: SkirmishWorld): ReplayOutcome {
  const { world, comps } = session;
  const outcome = evaluateOutcome(world, comps);
  const viewerLoss = outcome.losers.find(
    (record) => record.playerId === PLAYER_ONE,
  );
  let enemyUnitsLost = 0;
  for (const record of outcome.losers) {
    if (record.playerId !== PLAYER_ONE) {
      enemyUnitsLost += unitsLostOf(world, comps, record.playerId);
    }
  }
  return {
    decided: outcome.decided,
    side: viewerLoss !== undefined ? "defeat" : "victory",
    reason: viewerLoss?.reason ?? outcome.losers[0]?.reason ?? "conquest",
    stats: {
      ticksElapsed: world.tick,
      viewerUnitsLost: unitsLostOf(world, comps, PLAYER_ONE),
      enemyUnitsLost,
    },
  };
}

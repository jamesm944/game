/**
 * Replay recorder — SPEC §2.12 / M5-T3 (issue #65).
 *
 * Captures a match as a golden-fixture artifact (SPEC §2.12): every
 * PLAYER-originated command as `{tick, type, payload}` plus §7 state
 * digest milestones every simulated second, so a later mismatch
 * bisects a regression to its exact simulated second.
 *
 * PROVENANCE — what counts as a replayable command: the sim itself is a
 * command AUTHOR too. The AI planner, pop brain and friends submit
 * their orders into the shared inbox from inside system passes; those
 * emissions are pure functions of world state and REGENERATE
 * identically on every replay. Recording them would double-fire them.
 * The recorder therefore classifies submissions:
 *
 * - `attach()` during session bootstrap → everything the bootstrap
 *   submits (AI opening drafts) is sim-internal;
 * - `beginPlay()` opens the player window: commands submitted between
 *   steps (UI clicks, scripted directors) are EXTERNAL and recorded;
 * - `stepWorld()` wraps each `step()`: submissions inside that window
 *   are sim-internal and excluded, and each COMPLETED tick samples its
 *   §7 digest milestone on cadence — strictly after that tick's
 *   systems ran, so digests match what a fresh replay computes.
 *
 * MILESTONE TIMING: digests must be sampled strictly AFTER a tick's
 * systems ran (the state a replay will reproduce at that tick). The
 * inbox drain runs BEFORE a tick's systems, so milestones are NOT
 * captured there — {@link stepWorld} samples right after step()
 * returns, on every completed cadence boundary, regardless of whether
 * any command traffic happened to cross the tick.
 *
 * Lifecycle: `new ReplayRecorder()` → pass to createSkirmishWorld({
 * replay }) → `beginPlay()` → `stepWorld()` per tick → `finalize()`.
 * The artifact downloads as `<map>-<tick>.ageofreplay` and converts to
 * a bisectable fixture via `npm run replay:to-fixture`.
 *
 * Headless-pure (ADR-0001): no DOM, no clock, no rng.
 */

import { fnv1a64Hex } from "../core/digest";
import type { CommandInbox } from "../core/inbox";
import { computeWorldDigest, step, type World } from "../core/world";
import { derivePassability, type WorldLayers } from "../world/layers";

/**
 * The replay's map identity: FNV-1a-64 over the PRISTINE canonical map
 * bytes — terrain ‖ elevation ‖ passability RE-DERIVED from terrain.
 *
 * Why not serializeLayers verbatim (the `.ageof` recipe)? Buildings
 * stamp their footprints into the live derivedPassability plane as they
 * finish, so an export-time snapshot encodes the match's construction
 * history. A replay regenerates the map from the seed, so the header
 * gate must compare against the seed-pristine planes — a hash that is
 * a pure function of (seed, mapgen), identical at record time and
 * replay time no matter what got built in between.
 */
export function replayMapHash(layers: WorldLayers): string {
  const terrain = layers.terrainType;
  const elevation = layers.elevationLevel;
  const passability = derivePassability(terrain);
  const bytes = new Uint8Array(terrain.length * 3);
  bytes.set(terrain, 0);
  bytes.set(elevation, terrain.length);
  bytes.set(passability, terrain.length * 2);
  return fnv1a64Hex(bytes);
}

/** Bumped format invalidates old replay files loudly (no silent desync). */
export const REPLAY_FORMAT_VERSION = 1;

/**
 * Milestone cadence: one digest per simulated second (30 ticks @30 Hz),
 * matching the golden-fixture convention so a failing milestone names
 * the exact simulated second a regression appeared in.
 */
export const DEFAULT_MILESTONE_EVERY = 30;

/** One logged command, in the SPEC §2.12 replay shape. */
export interface ReplayCommandRecord {
  /** Absolute tick the command was consumed on (= its targetTick). */
  readonly tick: number;
  readonly type: string;
  readonly payload: Record<string, unknown> | undefined;
}

/** One §7 state-digest checkpoint. */
export interface ReplayMilestone {
  readonly tick: number;
  readonly digest: string;
}

/** The golden-fixture-shaped replay artifact (SPEC §2.12). */
export interface ReplayArtifact {
  readonly formatVersion: number;
  readonly seed: number;
  readonly mapHash: string;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly commands: readonly ReplayCommandRecord[];
  readonly milestones: readonly ReplayMilestone[];
}

export interface ReplayRecorderOptions {
  readonly milestoneEvery?: number | undefined;
}

type RecorderPhase = "idle" | "boot" | "play";

export class ReplayRecorder {
  readonly #milestoneEvery: number;
  readonly #commands: ReplayCommandRecord[] = [];
  readonly #milestones: ReplayMilestone[] = [];
  /** Sim-generated commands (bootstrap + inside-step), never recorded. */
  readonly #internal = new WeakSet<object>();
  #world: World | undefined;
  #phase: RecorderPhase = "idle";
  #inSimStep = false;

  constructor(options: ReplayRecorderOptions = {}) {
    const every = options.milestoneEvery ?? DEFAULT_MILESTONE_EVERY;
    if (!Number.isInteger(every) || every < 1) {
      throw new Error(
        `milestoneEvery must be a positive integer, got ${String(every)}`,
      );
    }
    this.#milestoneEvery = every;
  }

  get recording(): boolean {
    return this.#phase !== "idle";
  }

  get milestoneEvery(): number {
    return this.#milestoneEvery;
  }

  get capturedCommandCount(): number {
    return this.#commands.length;
  }

  /**
   * Wire the observers into `inbox`. Called by createSkirmishWorld
   * BEFORE any bootstrap submission so AI opening drafts classify as
   * sim-internal. Everything submitted until beginPlay() is internal.
   */
  attach(world: World, inbox: CommandInbox): void {
    if (this.#phase !== "idle") {
      throw new Error("replay recorder attached twice");
    }
    this.#world = world;
    inbox.setSubmitObserver((command) => {
      if (this.#phase === "boot" || this.#inSimStep)
        this.#internal.add(command);
    });
    inbox.setDrainObserver((_tick, drained) => {
      for (const command of drained) {
        if (this.#internal.has(command)) continue;
        this.#commands.push({
          tick: command.targetTick,
          type: command.kind,
          payload:
            command.data === undefined
              ? undefined
              : (JSON.parse(JSON.stringify(command.data)) as Record<
                  string,
                  unknown
                >),
        });
      }
    });
    this.#phase = "boot";
  }

  /** Open the player window: external submissions start being logged. */
  beginPlay(): void {
    if (this.#phase !== "boot") {
      throw new Error("beginPlay requires an attached recorder");
    }
    this.#phase = "play";
  }

  /**
   * Advance the world one tick INSIDE the sim window — the drop-in
   * replacement for a bare `step(world)` while recording. Submissions
   * by systems (planner, pop brain) classify as sim-internal here, and
   * each COMPLETED tick samples its §7 digest milestone on cadence
   * (held path-scheduler boundaries simply complete one call later;
   * digests are sampled strictly after a tick's systems ran).
   */
  stepWorld(): void {
    const world = this.#requireWorld();
    this.#inSimStep = true;
    try {
      step(world);
    } finally {
      this.#inSimStep = false;
    }
    const tick = world.tick;
    if (tick > 0 && tick % this.#milestoneEvery === 0) {
      const digest = computeWorldDigest(world);
      const last = this.#milestones.at(-1);
      if (last === undefined || last.tick < tick) {
        this.#milestones.push({ tick, digest });
      }
    }
  }

  /** Stop capturing without producing an artifact. */
  stop(): void {
    if (this.#phase === "idle") return;
    this.#world?.inbox.setDrainObserver(undefined);
    this.#world?.inbox.setSubmitObserver(undefined);
    this.#phase = "idle";
  }

  /**
   * Finish the recording and serialize the artifact: final-tick digest
   * appended (deduped against an already-captured boundary), map hash
   * computed from the live layers. Detaches both observers — one
   * artifact per recording.
   */
  finalize(finalTick?: number): ReplayArtifact {
    const world = this.#requireWorld();
    const ticks = finalTick ?? world.tick;
    this.stop();
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new Error("final tick must be a non-negative integer");
    }
    const last = this.#milestones.at(-1);
    if (last === undefined || last.tick < ticks) {
      this.#milestones.push({
        tick: ticks,
        digest: computeWorldDigest(world),
      });
    }
    return {
      formatVersion: REPLAY_FORMAT_VERSION,
      seed: world.seed,
      mapHash: replayMapHash(world.layers),
      ticks,
      milestoneEvery: this.#milestoneEvery,
      commands: [...this.#commands],
      milestones: [...this.#milestones],
    };
  }

  #requireWorld(): World {
    if (this.#world === undefined) {
      throw new Error("replay recorder is not attached to a world");
    }
    return this.#world;
  }
}

/** Canonical JSON text for an artifact (stable key order by construction). */
export function serializeReplay(artifact: ReplayArtifact): string {
  return JSON.stringify(artifact);
}

/**
 * Download name per SPEC §2.12's `<map>-<tick>` convention: the map id
 * is the first 8 hex of its FNV-1a-64, e.g.
 * `map-1a2b3c4d-tick9000.ageofreplay`.
 */
export function replayFileName(
  artifact: Pick<ReplayArtifact, "mapHash" | "ticks">,
): string {
  const hex = artifact.mapHash.slice("fnv1a64:".length);
  return `map-${hex.slice(0, 8)}-tick${String(artifact.ticks)}.ageofreplay`;
}

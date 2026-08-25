/**
 * Replay artifact validation + header gates — SPEC §2.12 / M5-T3
 * (issue #65).
 *
 * The mirror of record.ts: {@link parseReplay} accepts ONLY a
 * well-formed golden-fixture-shaped replay and rejects everything else
 * with a named {@link ReplayFormatError} (magic → version → seed → map
 * hash → ticks → commands → milestones, loud and ordered like the
 * `.ageof` decoder). {@link assertReplayMapHash} is the header gate:
 * the file's recorded hash must equal FNV-1a-64 over the freshly built
 * world's own canonical map bytes BEFORE a single command replays — a
 * mismatched build/map fails loudly instead of desyncing silently.
 *
 * Headless-pure: JSON in, validated data out, no DOM.
 */

import { replayMapHash } from "./record";
import type { WorldLayers } from "../world/layers";
import {
  REPLAY_FORMAT_VERSION,
  type ReplayArtifact,
  type ReplayCommandRecord,
  type ReplayMilestone,
} from "./record";

/** Loud rejection for any malformed/mismatched replay input. */
export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFormatError";
  }
}

const MAP_HASH_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReplayFormatError(`replay ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireInt(
  value: unknown,
  where: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ReplayFormatError(`replay ${where} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ReplayFormatError(
      `replay ${where} out of range [${String(min)}, ${String(max)}]: ${String(value)}`,
    );
  }
  return value;
}

function requireDigest(value: unknown, where: string): string {
  if (typeof value !== "string" || !MAP_HASH_PATTERN.test(value)) {
    throw new ReplayFormatError(
      `replay ${where} must match fnv1a64:<16 lowercase hex>`,
    );
  }
  return value;
}

/**
 * Validate one replay artifact deeply. Every field is checked; commands
 * must be non-decreasing by tick within [1, ticks]; milestones must be
 * strictly ascending, aligned to `milestoneEvery` or the final tick.
 */
export function parseReplay(raw: unknown): ReplayArtifact {
  const box = requireObject(raw, "artifact");

  const formatVersion = requireInt(
    box.formatVersion,
    "formatVersion",
    0,
    0xffffffff,
  );
  if (formatVersion !== REPLAY_FORMAT_VERSION) {
    throw new ReplayFormatError(
      `replay format ${String(formatVersion)} unsupported (this build reads ${String(REPLAY_FORMAT_VERSION)}) — old replays are forward-incompatible`,
    );
  }
  const seed = requireInt(box.seed, "seed", 0, 0xffffffff);
  const mapHash = requireDigest(box.mapHash, "mapHash");
  const ticks = requireInt(box.ticks, "ticks", 0, 0xffffffff);
  const milestoneEvery = requireInt(
    box.milestoneEvery,
    "milestoneEvery",
    1,
    0xffffffff,
  );

  if (!Array.isArray(box.commands)) {
    throw new ReplayFormatError("replay commands must be an array");
  }
  const commands: ReplayCommandRecord[] = box.commands.map(
    (entry, index): ReplayCommandRecord => {
      const cell = requireObject(entry, `command #${String(index)}`);
      const tick = requireInt(
        cell.tick,
        `command #${String(index)} tick`,
        1,
        ticks,
      );
      const type = cell.type;
      if (typeof type !== "string" || type.length === 0) {
        throw new ReplayFormatError(
          `replay command #${String(index)} type must be a non-empty string`,
        );
      }
      let payload: Record<string, unknown> | undefined;
      if (cell.payload !== undefined) {
        payload = requireObject(
          cell.payload,
          `command #${String(index)} payload`,
        );
      }
      return { tick, type, payload };
    },
  );
  for (let i = 1; i < commands.length; i++) {
    const previous = commands[i - 1];
    const current = commands[i];
    if (previous === undefined || current === undefined) continue;
    if (current.tick < previous.tick) {
      throw new ReplayFormatError(
        `replay commands must be ordered by tick (#${String(i - 1)} tick ${String(previous.tick)} > #${String(i)} tick ${String(current.tick)})`,
      );
    }
  }

  if (!Array.isArray(box.milestones)) {
    throw new ReplayFormatError("replay milestones must be an array");
  }
  const milestones: ReplayMilestone[] = box.milestones.map(
    (entry, index): ReplayMilestone => {
      const cell = requireObject(entry, `milestone #${String(index)}`);
      return {
        tick: requireInt(
          cell.tick,
          `milestone #${String(index)} tick`,
          0,
          ticks,
        ),
        digest: requireDigest(
          cell.digest,
          `milestone #${String(index)} digest`,
        ),
      };
    },
  );
  for (let i = 1; i < milestones.length; i++) {
    const previous = milestones[i - 1];
    const current = milestones[i];
    if (previous === undefined || current === undefined) continue;
    if (current.tick <= previous.tick) {
      throw new ReplayFormatError(
        `replay milestones must ascend strictly (${String(current.tick)} after ${String(previous.tick)})`,
      );
    }
  }
  for (const milestone of milestones) {
    if (milestone.tick !== ticks && milestone.tick % milestoneEvery !== 0) {
      throw new ReplayFormatError(
        `replay milestone at tick ${String(milestone.tick)} is off-cadence (every ${String(milestoneEvery)}) and not the final tick`,
      );
    }
  }

  return {
    formatVersion,
    seed,
    mapHash,
    ticks,
    milestoneEvery,
    commands,
    milestones,
  };
}

/** Parse + validate raw JSON text (the imported file's contents). */
export function parseReplayJson(text: string): ReplayArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReplayFormatError(
      `replay file is not valid JSON (${String(error)})`,
    );
  }
  return parseReplay(raw);
}

/**
 * The header gate: computed vs recorded map hash, before any replay.
 * Both sides hash the seed-PRISTINE map planes (see {@link replayMapHash})
 * so the gate is a pure function of (seed, mapgen) on each side.
 */
export function assertReplayMapHash(
  replay: Pick<ReplayArtifact, "mapHash" | "seed">,
  layers: WorldLayers,
): void {
  const actual = replayMapHash(layers);
  if (actual !== replay.mapHash) {
    throw new ReplayFormatError(
      `replay map-hash mismatch: file says ${replay.mapHash}, this build's map for seed ${String(replay.seed)} hashes ${actual} — wrong game version or corrupted file`,
    );
  }
}

export interface ReplayDivergenceInfo {
  readonly tick: number;
  readonly expected: string;
  readonly actual: string;
}

/**
 * The loud desync report lines (expected vs actual digest at the first
 * diverging milestone). Shared verbatim by the in-game import overlay
 * and generated golden-fixture failure messages.
 */
export function formatReplayDesyncLines(
  divergence: ReplayDivergenceInfo,
): string[] {
  return [
    `DESYNC at tick ${String(divergence.tick)} — this build no longer reproduces the recorded match.`,
    `expected digest: ${divergence.expected}`,
    `actual digest:   ${divergence.actual}`,
    `First diverging simulated second: tick ${String(divergence.tick)} (t = ${(divergence.tick / 30).toFixed(1)}s).`,
    `Attach the .ageofreplay file to the bug issue, or convert it into a failing fixture with: npm run replay:to-fixture <file> <bug-name>`,
  ];
}

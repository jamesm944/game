/**
 * M5-T3 replay record/export/import + bug-fixture flow (issue #65).
 *
 * Covers SPEC §2.12's replay contract end-to-end, headless:
 *
 * 1. RECORD→REPLAY BYTE-EXACT: the shared scripted skirmish records an
 *    artifact whose replay reproduces every §7 milestone digest exactly
 *    — twice, as a determinism canary. Only PLAYER-originated commands
 *    enter the artifact (bootstrap drafts and in-step AI emissions are
 *    excluded — they regenerate identically on playback).
 * 2. CORRUPTED REPLAYS REJECTED: the parser refuses every malformation
 *    loudly, and the map-hash header gate rejects wrong-map artifacts
 *    BEFORE any command replays (no silent desync, ever).
 * 3. DESYNC DETECTION: one tampered order surfaces as a first-milestone
 *    divergence carrying expected-vs-actual digests.
 * 4. CONVERTER: `buildGoldenFixtureFiles` turns an artifact into the
 *    two files of a bisectable tests/golden/<name>/ fixture; the REAL
 *    generated output lives committed under tests/golden/m5t3-replay/
 *    and runs in this suite.
 */

import { describe, expect, it } from "vitest";
import {
  createWorld,
  defineComponent,
  registerSystem,
  setComponentValues,
  spawnEntity,
} from "../src/sim/core/world";
import {
  DEFAULT_MILESTONE_EVERY,
  ReplayRecorder,
  replayFileName,
  replayMapHash,
  serializeReplay,
} from "../src/sim/replay/record";
import type { ReplayArtifact } from "../src/sim/replay/record";
import {
  assertReplayMapHash,
  formatReplayDesyncLines,
  parseReplay,
  parseReplayJson,
  ReplayFormatError,
} from "../src/sim/replay/play";
import { replayOutcomeOf, runReplayHeadless } from "../src/game/replayPlayer";
import {
  buildGoldenFixtureFiles,
  isValidFixtureName,
} from "../src/game/replayFixture";
import {
  recordScriptedSkirmish,
  SCENARIO_TICKS,
} from "./helpers/replay-scenario";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function cloneArtifact(artifact: ReplayArtifact): ReplayArtifact {
  return JSON.parse(serializeReplay(artifact)) as ReplayArtifact;
}

async function replayArtifact(
  artifact: ReplayArtifact,
): Promise<Awaited<ReturnType<typeof runReplayHeadless>>> {
  return runReplayHeadless(parseReplay(cloneArtifact(artifact)));
}

describe("replay recorder mechanics", () => {
  it("logs external commands only, in consumption order, with absolute ticks", () => {
    const world = createWorld(7);
    const alphaId = defineComponent(world, "alpha");
    const recorder = new ReplayRecorder();
    recorder.attach(world, world.inbox);

    // Bootstrap-window submissions are sim-internal: never logged.
    world.inbox.submit({ kind: "bootDraft", targetTick: 3 });

    recorder.beginPlay();
    const eid = spawnEntity(world);
    setComponentValues(world, alphaId, eid, [1]);

    // A system that emits during its pass — planner-style traffic that
    // must stay OUT of the artifact because playback regenerates it.
    registerSystem(world, (current, commands) => {
      for (const command of commands) {
        if (command.kind === "ping") {
          current.inbox.submit({
            kind: "echo",
            targetTick: current.tick + 2,
          });
        }
      }
    });

    // External (player-shaped) orders submitted between steps.
    world.inbox.submit({
      kind: "ping",
      targetTick: 2,
      data: { n: 1 },
    });

    recorder.stepWorld(); // tick 1: nothing due
    recorder.stepWorld(); // tick 2: consumes ping#1 → system echoes @4
    world.inbox.submit({ kind: "ping", targetTick: 4, data: { n: 2 } });
    recorder.stepWorld(); // tick 3
    recorder.stepWorld(); // tick 4: consumes ping#2 + echo

    const artifact = recorder.finalize();
    expect(artifact.ticks).toBe(4);
    expect(artifact.seed).toBe(7);
    expect(artifact.formatVersion).toBe(1);
    // Only the two player pings — no bootDraft, no echo.
    expect(
      artifact.commands.map((command) => [command.tick, command.type]),
    ).toEqual([
      [2, "ping"],
      [4, "ping"],
    ]);
    expect(artifact.commands[0]?.payload).toEqual({ n: 1 });
    // Milestones below the cadence collapse to the single final digest.
    expect(artifact.milestoneEvery).toBe(DEFAULT_MILESTONE_EVERY);
    expect(artifact.milestones).toEqual([
      { tick: 4, digest: artifact.milestones[0]?.digest },
    ]);
    expect(recorder.recording).toBe(false); // finalize detaches

    const fileName = replayFileName(artifact);
    expect(fileName).toMatch(/^map-[0-9a-f]{8}-tick4\.ageofreplay$/);
    expect(fileName).toBe(
      replayFileName({ mapHash: artifact.mapHash, ticks: 4 }),
    );
  });

  it("rejects double attach and beginPlay-before-attach", () => {
    const world = createWorld(9);
    const recorder = new ReplayRecorder();
    recorder.attach(world, world.inbox);
    expect(() => recorder.attach(world, world.inbox)).toThrow();
    const second = new ReplayRecorder();
    expect(() => second.beginPlay()).toThrow();
  });
});

describe("record → replay byte-exact (scripted skirmish)", () => {
  const recording = recordScriptedSkirmish();

  it("records a well-formed artifact from the live match", () => {
    const { session, artifact } = recording;
    expect(artifact.seed).toBe(session.world.seed);
    expect(artifact.ticks).toBe(SCENARIO_TICKS);
    // The map hash is the seed-PRISTINE map identity of THIS world —
    // a pure function of (seed, mapgen), unaffected by built buildings.
    expect(artifact.mapHash).toBe(replayMapHash(session.world.layers));
    // Every scripted director order landed, plus none from the sim.
    const kinds = new Set(artifact.commands.map((command) => command.type));
    for (const kind of [
      "groupMove",
      "gather",
      "placeBuilding",
      "trainUnit",
      "stop",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
    // Commands strictly ordered by tick within range.
    let previous = 0;
    for (const command of artifact.commands) {
      expect(command.tick).toBeGreaterThan(previous);
      expect(command.tick).toBeLessThanOrEqual(SCENARIO_TICKS);
      previous = command.tick;
    }
    // Milestones: every simulated second lazily captured + the finale.
    expect(artifact.milestones).toHaveLength(SCENARIO_TICKS / 30);
    expect(artifact.milestones.at(-1)?.tick).toBe(SCENARIO_TICKS);
  });

  it("replays byte-exact through the full production bootstrap", async () => {
    const result = await replayArtifact(recording.artifact);
    expect(result.divergence).toBeUndefined();
    expect(result.milestones).toEqual(recording.artifact.milestones);
    // Short skirmish: nobody has won yet, outcome shape still holds.
    const outcome = replayOutcomeOf(result.session);
    expect(outcome.decided).toBe(false);
  });

  it("double-run canary: independent replays agree digest-for-digest", async () => {
    const first = await replayArtifact(recording.artifact);
    const second = await replayArtifact(recording.artifact);
    expect(second.milestones).toEqual(first.milestones);
    expect(second.divergence).toBeUndefined();
  });
});

describe("corrupted replays are rejected loudly", () => {
  const valid = cloneArtifact(recordScriptedSkirmish().artifact);
  const validJson = (): Record<string, unknown> =>
    JSON.parse(serializeReplay(valid)) as Record<string, unknown>;

  const broken: readonly [string, (raw: Record<string, unknown>) => unknown][] =
    [
      [
        "unsupported future format version",
        (raw) => ({ ...raw, formatVersion: 99 }),
      ],
      ["negative seed", (raw) => ({ ...raw, seed: -1 })],
      ["fractional seed", (raw) => ({ ...raw, seed: 1.5 })],
      ["malformed map hash", (raw) => ({ ...raw, mapHash: "fnv1a64:XYZ" })],
      [
        "uppercase map hash",
        (raw) => ({ ...raw, mapHash: "fnv1a64:ABCDEF0123456789" }),
      ],
      ["negative ticks", (raw) => ({ ...raw, ticks: -5 })],
      ["commands not an array", (raw) => ({ ...raw, commands: "nope" })],
      [
        "command without type",
        (raw) => ({
          ...raw,
          commands: [{ tick: 2, payload: {} }],
        }),
      ],
      [
        "commands out of order",
        (raw) => ({
          ...raw,
          commands: [...valid.commands.slice().reverse()],
        }),
      ],
      [
        "command beyond the final tick",
        (raw) => ({
          ...raw,
          commands: [{ tick: valid.ticks + 1, type: "groupMove", payload: {} }],
        }),
      ],
      [
        "milestone off the cadence",
        (raw) => ({
          ...raw,
          milestones: [{ tick: 17, digest: valid.mapHash }],
        }),
      ],
      [
        "milestone digest malformed",
        (raw) => ({
          ...raw,
          milestones: [{ tick: 30, digest: "sha256:nope" }],
        }),
      ],
      [
        "milestones descending",
        (raw) => ({
          ...raw,
          milestones: [
            { tick: 60, digest: valid.mapHash },
            { tick: 30, digest: valid.mapHash },
          ],
        }),
      ],
    ];

  for (const [label, mutate] of broken) {
    it(`rejects ${label}`, () => {
      expect(() => parseReplay(mutate(validJson()))).toThrow(ReplayFormatError);
    });
  }

  it("rejects non-JSON files with a named error", () => {
    expect(() => parseReplayJson("{not json")).toThrow(ReplayFormatError);
  });

  it("header gate: wrong-map artifacts never reach a single command", async () => {
    const wrongMap = {
      ...cloneArtifact(valid),
      mapHash: "fnv1a64:0000000000000000",
    };
    expect(() =>
      assertReplayMapHash(
        parseReplay(wrongMap),
        createWorld(valid.seed).layers,
      ),
    ).toThrow(/map-hash mismatch/);
    await expect(runReplayHeadless(parseReplay(wrongMap))).rejects.toThrow(
      ReplayFormatError,
    );
  });
});

describe("desync detection", () => {
  it("stops at the first diverging milestone with expected vs actual", async () => {
    const source = cloneArtifact(recordScriptedSkirmish().artifact);
    // Re-tasking a different resource node is an effectful divergence:
    // gather chains feed stockpiles and villager positions from that
    // tick on (movement-only tampers can be overridden back to parity
    // by later orders — the artifact stays honest either way).
    const gatherIndex = source.commands.findIndex(
      (command) => command.type === "gather",
    );
    expect(gatherIndex).toBeGreaterThanOrEqual(0);
    const tampered: ReplayArtifact = {
      ...source,
      commands: source.commands.map((command, index) =>
        index === gatherIndex
          ? {
              ...command,
              payload: {
                ...(command.payload ?? {}),
                nodeId: (command.payload?.nodeId as number) + 1,
              },
            }
          : command,
      ),
    };

    const result = await runReplayHeadless(parseReplay(tampered));
    expect(result.divergence).toBeDefined();
    const divergence = result.divergence!;
    // The reported checkpoint is exactly where the recorded digests end.
    const expected = tampered.milestones[divergence.index];
    expect(expected?.digest).toBe(divergence.expected);
    expect(expected?.tick).toBe(divergence.tick);
    expect(divergence.actual).not.toBe(divergence.expected);
    expect(result.milestones.length - 1).toBe(divergence.index);

    const lines = formatReplayDesyncLines(divergence);
    expect(lines[0]).toContain(`DESYNC at tick ${String(divergence.tick)}`);
    expect(lines.join("\n")).toContain(divergence.expected);
    expect(lines.join("\n")).toContain(divergence.actual);
    expect(lines.join("\n")).toContain("replay:to-fixture");
  });
});

describe("bug-replay converter core", () => {
  const source = recordScriptedSkirmish().artifact;

  it("emits case.json + generated harness from a valid artifact", () => {
    const files = buildGoldenFixtureFiles(cloneArtifact(source), "my-bug-65");
    const roundTripped = parseReplay(JSON.parse(files.caseJson));
    expect(roundTripped).toEqual(source);
    expect(files.goldenTestTs).toContain("runReplayHeadless");
    expect(files.goldenTestTs).toContain("formatReplayDesyncLines");
    expect(files.goldenTestTs).toContain("golden:record");
    expect(files.goldenTestTs).toContain("240_000");
  });

  it("refuses unsafe fixture names", () => {
    for (const bad of [
      "Bad Name",
      "-lead",
      "trail-",
      "under_score",
      "a".repeat(49),
    ]) {
      expect(isValidFixtureName(bad)).toBe(false);
      expect(() => buildGoldenFixtureFiles(source, bad)).toThrow(
        ReplayFormatError,
      );
    }
    expect(isValidFixtureName("m5t3-replay")).toBe(true);
  });

  it("refuses malformed artifacts", () => {
    expect(() =>
      buildGoldenFixtureFiles({ formatVersion: 99 }, "ok-name"),
    ).toThrow(ReplayFormatError);
  });
});

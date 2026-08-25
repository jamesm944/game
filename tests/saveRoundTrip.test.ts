/**
 * M5-T2 save/load golden round-trip — SPEC §2.12 (issue #64).
 *
 * The acceptance core: save→load MID-COMBAT resumes digest-identical.
 * One scripted two-player skirmish (production createSkirmishWorld
 * roster: movement → … → companies → AI planner) runs twice from the
 * same seed:
 *
 *   CONTROL — never saved, steps straight through to the end.
 *   SAVED    — at a quiet step boundary mid-fight, captureSkirmishSave
 *              produces `.ageof` bytes; restoreSkirmishSession rebuilds
 *              from them; both arms keep stepping and every per-tick §7
 *              digest must match EXACTLY.
 *
 * The script deliberately leaves commands pending ACROSS the save point
 * (absolute future target ticks) so the inbox section proves itself,
 * and the fight exercises paths-in-flight drain, combat strikes +
 * morale, company output stamps and AI planner memories — every piece
 * of non-digest closure state the payload sections carry.
 *
 * Also pinned here: loud header rejections (magic / version / framing /
 * map-hash), digest-verification tamper detection, and the rolling-
 * autosave slot policy.
 */
import { describe, expect, it } from "vitest";
import { computeWorldDigest, step } from "../src/sim/core/world";
import { PLAYER_ONE } from "../src/sim/core/stockpile";
import { AI_PLAYER } from "../src/sim/ai/bootstrap";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";
import {
  buildingRectOf,
  getBuildingRow,
} from "../src/sim/components/buildings";
import { spawnCombatUnit } from "../src/sim/components/combat";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import {
  captureSkirmishSave,
  createSkirmishWorld,
  restoreSkirmishSession,
} from "../src/game/session";
import type { SkirmishWorld } from "../src/game/session";
import {
  AUTOSAVE_SLOT_NAMES,
  SaveFormatError,
  assertMapHash,
  decodeAgeof,
  encodeAgeof,
  HEADER_BYTES,
  pickAutosaveTarget,
} from "../src/game/saveManager";
import { parsePayload } from "../src/sim/save/serialize";

installSimPurityShims();

const SEED = 20260903;
/** Mid-combat save point (~8 sim-seconds in). */
const SAVE_TICK = 240;
/** Ticks of post-restore continuation compared against the control. */
const POST_TICKS = 180;
const STEP_BOUND = 2000;

// ---- Scripted combat scenario ---------------------------------------------------

interface ScriptedCommand {
  readonly tick: number;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

/**
 * Commands enter the inbox ONCE at scenario start with ABSOLUTE target
 * ticks — including a pair that only come due well after SAVE_TICK, so
 * a correct restore must carry them across the container.
 */
function buildScript(
  knightIds: number[],
  rallyX: number,
  rallyY: number,
): ScriptedCommand[] {
  return [
    {
      tick: 5,
      kind: "attackMove",
      data: { ids: knightIds, x: rallyX, y: rallyY },
    },
    {
      tick: 120,
      kind: "attackMove",
      data: { ids: knightIds, x: rallyX, y: rallyY },
    },
    // Straddles the save point: pending in BOTH arms at SAVE_TICK.
    {
      tick: SAVE_TICK + 45,
      kind: "stop",
      data: { entityIds: [knightIds[0]!] },
    },
    {
      tick: SAVE_TICK + 60,
      kind: "attackMove",
      data: { ids: knightIds, x: rallyX, y: rallyY },
    },
  ];
}

/** Spawn four knights beside the AI's first building and script the raid. */
function startScenario(): SkirmishWorld {
  const session = createSkirmishWorld(SEED, {
    createTransport: createSynchronousPathTransport,
  });
  const { world, comps } = session;

  let aiBuilding: number | undefined;
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (row !== undefined && row[0] === AI_PLAYER) {
      aiBuilding = eid;
      break;
    }
  }
  expect(aiBuilding).toBeDefined();
  const rect = buildingRectOf(world, comps, aiBuilding!)!;
  const rallyX = rect.x + rect.width / 2;
  const rallyY = rect.y + rect.height / 2;

  const knights = [
    spawnCombatUnit(
      world,
      comps,
      "knight",
      rect.x - 3.5,
      rect.y - 0.5,
      PLAYER_ONE,
    ),
    spawnCombatUnit(
      world,
      comps,
      "knight",
      rect.x - 3.5,
      rect.y + 0.5,
      PLAYER_ONE,
    ),
    spawnCombatUnit(
      world,
      comps,
      "knight",
      rect.x - 4.5,
      rect.y - 0.5,
      PLAYER_ONE,
    ),
    spawnCombatUnit(
      world,
      comps,
      "knight",
      rect.x - 4.5,
      rect.y + 0.5,
      PLAYER_ONE,
    ),
  ];

  for (const entry of buildScript(knights, rallyX, rallyY)) {
    world.inbox.submit({
      kind: entry.kind,
      targetTick: entry.tick,
      data: entry.data,
    });
  }
  return session;
}

/** Step until `predicate(session)` holds; throws past STEP_BOUND steps. */
function stepUntil(
  session: SkirmishWorld,
  predicate: (session: SkirmishWorld) => boolean,
): void {
  for (let guard = 0; guard < STEP_BOUND; guard++) {
    if (predicate(session)) return;
    step(session.world);
  }
  throw new Error(`stepUntil exceeded ${String(STEP_BOUND)} iterations`);
}

/** Quiet-boundary gate: saves wait for in-flight path responses to drain. */
function isQuietBoundary(session: SkirmishWorld): boolean {
  return (
    session.world.tick >= SAVE_TICK && session.scheduler.pendingCount === 0
  );
}
/** Step past `minTick` AND the next quiet path-pipeline boundary. */
function stepToQuietBoundary(session: SkirmishWorld, minTick: number): void {
  stepUntil(
    session,
    (s) => s.world.tick >= minTick && s.scheduler.pendingCount === 0,
  );
}

/**
 * Walk the nine u32-length-prefixed payload sections; returns each
 * section's [start, end) byte span inside the UNCOMPRESSED payload.
 */
function sectionSpans(payload: Uint8Array): { start: number; end: number }[] {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const spans: { start: number; end: number }[] = [];
  let offset = 0;
  for (let i = 0; i < 9; i++) {
    const length = view.getUint32(offset, false);
    spans.push({ start: offset + 4, end: offset + 4 + length });
    offset += 4 + length;
  }
  expect(offset).toBe(payload.length);
  return spans;
}

describe("M5-T2 .ageof round-trip (issue #64)", () => {
  it("save→load mid-combat resumes digest-identical to a never-saved control", async () => {
    // ---- Control arm -------------------------------------------------------
    const control = startScenario();
    stepUntil(control, isQuietBoundary);
    const controlDigests: string[] = [];
    for (let i = 0; i < POST_TICKS; i++) {
      step(control.world);
      controlDigests.push(computeWorldDigest(control.world));
    }

    // ---- Saved arm ---------------------------------------------------------
    const saved = startScenario();
    stepUntil(saved, isQuietBoundary);
    expect(saved.world.tick).toBe(control.world.tick - POST_TICKS);

    const preSaveDigest = computeWorldDigest(saved.world);
    expect(preSaveDigest).toBeTypeOf("string");

    // Snapshot every non-digest closure state so the restore can be
    // pinned field-by-field, not just through eventual digest drift.
    const savedPrng = saved.world.prng.getState();
    const savedCommands = saved.world.inbox.pendingCommands();

    const container = await captureSkirmishSave(saved, 42.5);

    // Header sanity: uncompressed fields inspectable without inflating.
    expect(String.fromCharCode(...container.subarray(0, 4))).toBe("AOF1");
    const headerView = new DataView(
      container.buffer,
      container.byteOffset,
      container.byteLength,
    );
    expect(headerView.getUint32(8, false)).toBe(SEED);
    expect(headerView.getFloat64(16, false)).toBeCloseTo(42.5, 5);

    const restored = await restoreSkirmishSession(container, {
      createTransport: createSynchronousPathTransport,
    });
    expect(restored.restoredFromTick).toBe(saved.world.tick);
    expect(restored.playtimeSeconds).toBeCloseTo(42.5, 5);
    expect(computeWorldDigest(restored.world)).toBe(preSaveDigest);

    // Field-exact closure-state restoration (SPEC §2.12 sections):
    expect([...restored.world.prng.getState()]).toEqual([...savedPrng]);
    expect(restored.world.inbox.pendingCommands()).toEqual(savedCommands);
    expect(restored.world.inbox.pendingCommands().length).toBeGreaterThan(0);
    expect([...restored.companiesPersistent.lastOutputTickByBuilding]).toEqual([
      ...saved.companiesPersistent.lastOutputTickByBuilding,
    ]);
    expect([...restored.companiesPersistent.lastOrganicFoundingTick]).toEqual([
      ...saved.companiesPersistent.lastOrganicFoundingTick,
    ]);
    expect(restored.aiMemory.attackedTick).toBe(saved.aiMemory.attackedTick);
    expect(restored.militaryMemory.countersTrained).toBe(
      saved.militaryMemory.countersTrained,
    );
    expect([...restored.militaryMemory.threatSince]).toEqual([
      ...saved.militaryMemory.threatSince,
    ]);
    expect(restored.fog.state.planes[0]!.explored).toEqual(
      saved.fog.state.planes[0]!.explored,
    );

    // ---- Identical continuation -------------------------------------------
    const restoredDigests: string[] = [];
    for (let i = 0; i < POST_TICKS; i++) {
      step(restored.world);
      restoredDigests.push(computeWorldDigest(restored.world));
    }
    expect(restoredDigests).toEqual(controlDigests);
  });

  it("rejects corrupted headers loudly: magic, version, framing", async () => {
    const session = startScenario();
    stepToQuietBoundary(session, 40);
    const container = await captureSkirmishSave(session, 1);

    const flippedMagic = container.slice();
    flippedMagic[2] = 0x58; // "AOF1" → "AOX1"
    expect(() => decodeAgeof(flippedMagic)).toThrow(SaveFormatError);
    expect(() => decodeAgeof(flippedMagic)).toThrow(/magic/i);

    expect(() => decodeAgeof(container.slice(0, HEADER_BYTES - 1))).toThrow(
      /shorter than/,
    );

    const badVersion = container.slice();
    badVersion[4] = 0x7f;
    expect(() => decodeAgeof(badVersion)).toThrow(SaveFormatError);
    expect(() => decodeAgeof(badVersion)).toThrow(/version mismatch/i);

    const badLen = container.slice();
    const view = new DataView(badLen.buffer);
    view.setUint32(32, view.getUint32(32, false) + 1, false);
    expect(() => decodeAgeof(badLen)).toThrow(SaveFormatError);
    expect(() => decodeAgeof(badLen)).toThrow(/framing corrupt/i);
  });

  it("rejects wrong-map-hash saves loudly (header or payload tampering)", async () => {
    const session = startScenario();
    stepToQuietBoundary(session, 40);
    const container = await captureSkirmishSave(session, 2);

    // Corrupt the u64 map-hash field in the raw header.
    const flippedHeader = container.slice();
    flippedHeader[24] = (flippedHeader[24] ?? 0) ^ 0xff;
    const decodedFlipped = decodeAgeof(flippedHeader);
    const parsedFlipped = parsePayload(decodedFlipped.payload);
    expect(() =>
      assertMapHash(decodedFlipped.meta, parsedFlipped.mapBytes),
    ).toThrow(SaveFormatError);
    expect(() =>
      assertMapHash(decodedFlipped.meta, parsedFlipped.mapBytes),
    ).toThrow(/map-hash mismatch/i);

    // Corrupt ONE map byte inside the inflated payload — the stored hash
    // no longer matches the map the file carries.
    const decoded = decodeAgeof(container);
    const parsed = parsePayload(decoded.payload);
    assertMapHash(decoded.meta, parsed.mapBytes); // intact container passes
    const tamperedMap = parsed.mapBytes.slice();
    const mid = tamperedMap.length >> 1;
    tamperedMap[mid] = (tamperedMap[mid] ?? 0) ^ 0x01;
    expect(() => assertMapHash(decoded.meta, tamperedMap)).toThrow(
      /map-hash mismatch/i,
    );
  });

  it("digest verification catches state tampering inside a valid container", async () => {
    const session = startScenario();
    stepToQuietBoundary(session, 40);
    const container = await captureSkirmishSave(session, 3);

    // Rebuild the container with ONE nibble of the stored §7 digest
    // flipped — every section stays internally consistent, the map hash
    // still matches, so ONLY the restore-time digest recipe can catch it.
    const { meta, payload } = decodeAgeof(container);
    const spans = sectionSpans(payload);
    const digestSpan = spans[8]!;
    const tamperedPayload = payload.slice();
    const spanView = new DataView(
      tamperedPayload.buffer,
      tamperedPayload.byteOffset,
      tamperedPayload.byteLength,
    );
    // Section body = u32 string length + the ASCII digest itself.
    const textStart = digestSpan.start + 4;
    const textLength = spanView.getUint32(digestSpan.start, false);
    const ascii = new TextDecoder().decode(
      tamperedPayload.subarray(textStart, textStart + textLength),
    );
    expect(ascii.startsWith("fnv1a64:")).toBe(true);
    const firstNibbleIndex = textStart + "fnv1a64:".length;
    const originalChar = String.fromCharCode(
      tamperedPayload[firstNibbleIndex]!,
    );
    tamperedPayload[firstNibbleIndex] = originalChar === "0" ? 0x31 : 0x30; // flip 0<->1

    const tamperedContainer = await encodeAgeof(meta, tamperedPayload);

    // The container itself decodes cleanly…
    const decodedTampered = decodeAgeof(tamperedContainer);
    expect(decodedTampered.meta.seed).toBe(meta.seed);
    // …and the restore rejects it on THE free corruption check.
    await expect(
      restoreSkirmishSession(tamperedContainer, {
        createTransport: createSynchronousPathTransport,
      }),
    ).rejects.toThrow(SaveFormatError);
    await expect(
      restoreSkirmishSession(tamperedContainer, {
        createTransport: createSynchronousPathTransport,
      }),
    ).rejects.toThrow(/digest verification failed/i);
  });

  it("rolls autosave slots: fill empty first, then evict oldest", () => {
    expect(pickAutosaveTarget([])).toBe("autosave-1");

    const now = 10_000;
    expect(pickAutosaveTarget([{ name: "autosave-1", savedAt: now }])).toBe(
      "autosave-2",
    );
    expect(
      pickAutosaveTarget([
        { name: "autosave-1", savedAt: now },
        { name: "autosave-2", savedAt: now + 5 },
      ]),
    ).toBe("autosave-3");
    expect(
      pickAutosaveTarget([
        ...AUTOSAVE_SLOT_NAMES.map((name, index) => ({
          name,
          savedAt: now + index,
        })),
      ]),
    ).toBe("autosave-1"); // oldest evicted

    // Ties break to the LOWEST slot index.
    expect(
      pickAutosaveTarget([
        ...AUTOSAVE_SLOT_NAMES.map((name) => ({ name, savedAt: now })),
      ]),
    ).toBe("autosave-1");

    // Manual slots are invisible to the rotation.
    expect(
      pickAutosaveTarget([
        { name: "my match", savedAt: 1 },
        { name: "autosave-1", savedAt: 2 },
      ]),
    ).toBe("autosave-2");
  });
});

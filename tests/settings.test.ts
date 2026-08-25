/**
 * Settings persistence + formatting — M5-T4 (issue #66).
 *
 * The panel's pure half: volume blobs parse/clamp/merge against the
 * SAME storage key the audio graph reads (audio/buses.VOLUME_KEY), the
 * difficulty handoff round-trips through its stash exactly once, and
 * the autosave cadence line derives from the real tick constant. No
 * DOM — Map-faked storage keeps the seam unbroken.
 */
import { describe, expect, it } from "vitest";
import { AUTOSAVE_INTERVAL_TICKS } from "../src/game/saveManager";
import {
  BUS_VOLUME_NAMES,
  DEFAULT_BUS_VOLUMES,
  VOLUME_KEY,
  clampVolume,
  consumeDifficulty,
  formatAutosaveInterval,
  formatVolumePct,
  parseStoredVolumes,
  persistVolume,
  readStoredVolumes,
  stashDifficulty,
} from "../src/ui/settings";

function mapStorage(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

describe("volume parsing", () => {
  it("falls back to the shared bus defaults when nothing is stored", () => {
    expect(readStoredVolumes(mapStorage())).toEqual(DEFAULT_BUS_VOLUMES);
    for (const name of BUS_VOLUME_NAMES) {
      expect(parseStoredVolumes(null)[name]).toBe(
        DEFAULT_BUS_VOLUMES[name as keyof typeof DEFAULT_BUS_VOLUMES],
      );
    }
  });

  it("ignores corrupt blobs wholesale", () => {
    expect(parseStoredVolumes("not json{")).toEqual(DEFAULT_BUS_VOLUMES);
    expect(parseStoredVolumes(JSON.stringify([0.1, 0.2]))).toEqual(
      DEFAULT_BUS_VOLUMES,
    );
    expect(parseStoredVolumes(JSON.stringify("loud"))).toEqual(
      DEFAULT_BUS_VOLUMES,
    );
  });

  it("overlays only numeric entries and clamps into [0,1]", () => {
    const parsed = parseStoredVolumes(
      JSON.stringify({ master: 1.7, sfx: -3, ui: 0.25, music: "loud" }),
    );
    expect(parsed.master).toBe(1);
    expect(parsed.sfx).toBe(0);
    expect(parsed.ui).toBe(0.25);
    // Non-numeric entry → default survives.
    expect(parsed.music).toBe(DEFAULT_BUS_VOLUMES.music);
  });
});

describe("volume persistence", () => {
  it("merges one change while preserving sibling buses", () => {
    const storage = mapStorage({
      [VOLUME_KEY]: JSON.stringify({ music: 0.4, ambient: 0.6 }),
    });
    const merged = persistVolume(storage, "sfx", 0.9);
    expect(merged.music).toBe(0.4);
    expect(merged.ambient).toBe(0.6);
    expect(merged.sfx).toBe(0.9);
    // Written blob parses back identically through the reader.
    expect(readStoredVolumes(storage)).toEqual(merged);
  });

  it("clamps out-of-range writes before they hit storage", () => {
    const storage = mapStorage();
    persistVolume(storage, "master", 42);
    expect(readStoredVolumes(storage).master).toBe(1);
    persistVolume(storage, "ui", -1);
    expect(readStoredVolumes(storage).ui).toBe(0);
  });

  it("uses the exact key/format the audio graph reads", () => {
    const storage = mapStorage();
    persistVolume(storage, "music", 0.33);
    const raw = storage.store.get(VOLUME_KEY)!;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw)).toMatchObject({ music: 0.33 });
  });

  it("clamps and renders slider labels", () => {
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(NaN)).toBe(0);
    expect(formatVolumePct(0.825)).toBe("83%");
    expect(formatVolumePct(-5)).toBe("0%");
    expect(formatVolumePct(1)).toBe("100%");
  });
});

describe("difficulty handoff", () => {
  it("round-trips a valid choice exactly once", () => {
    const storage = mapStorage();
    expect(consumeDifficulty(storage)).toBeUndefined();
    stashDifficulty(storage, "hard");
    expect(consumeDifficulty(storage)).toBe("hard");
    // One stash fires one boot — the key is consumed.
    expect(consumeDifficulty(storage)).toBeUndefined();
  });

  it("rejects unknown ids loudly-softly (undefined, key still cleared)", () => {
    const storage = mapStorage({ "ageofwind.difficulty": "nightmare" });
    expect(consumeDifficulty(storage)).toBeUndefined();
    expect(storage.store.has("ageofwind.difficulty")).toBe(false);
  });
});

describe("autosave cadence display", () => {
  it("renders the §2.12 two-sim-minute cadence from the real constant", () => {
    expect(formatAutosaveInterval(AUTOSAVE_INTERVAL_TICKS)).toBe(
      "every 2 sim-minutes",
    );
  });

  it("degrades to seconds off whole minutes and stays singular-aware", () => {
    expect(formatAutosaveInterval(45 * 30)).toBe("every 45 sim-seconds");
    expect(formatAutosaveInterval(60 * 30)).toBe("every 1 sim-minute");
    expect(formatAutosaveInterval(3 * 60 * 30)).toBe("every 3 sim-minutes");
  });
});

/**
 * Unit Tests for Graphics Quality Settings & Persistence — P1 / Issue #130.
 */

import { describe, expect, it } from "vitest";
import {
  GRAPHICS_QUALITIES,
  GRAPHICS_QUALITY_KEY,
  readStoredGraphicsQuality,
  stashGraphicsQuality,
  type SettingsStorage,
} from "../../src/ui/settings";

function mapStorage(initial: Record<string, string> = {}): SettingsStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

describe("P1: Graphics Quality Persistence", () => {
  it("defines canonical graphics quality preset identifiers", () => {
    expect(GRAPHICS_QUALITIES).toEqual(["high", "medium", "low"]);
    expect(GRAPHICS_QUALITY_KEY).toBe("ageofwind.graphics");
  });

  it("defaults to 'high' when no quality is stored", () => {
    const storage = mapStorage();
    expect(readStoredGraphicsQuality(storage)).toBe("high");
  });

  it("round-trips all valid graphics quality presets", () => {
    const storage = mapStorage();
    for (const q of GRAPHICS_QUALITIES) {
      stashGraphicsQuality(storage, q);
      expect(readStoredGraphicsQuality(storage)).toBe(q);
    }
  });

  it("falls back safely to 'high' when corrupted or unrecognized value is stored", () => {
    const storage = mapStorage({
      [GRAPHICS_QUALITY_KEY]: "ultra_insane_fps",
    });
    expect(readStoredGraphicsQuality(storage)).toBe("high");

    storage.setItem(GRAPHICS_QUALITY_KEY, "");
    expect(readStoredGraphicsQuality(storage)).toBe("high");
  });
});

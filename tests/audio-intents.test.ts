import { describe, expect, it } from "vitest";
import {
  AUDIO_CLIPS,
  COALESCABLE,
  coalesceSameFrame,
  type AudioIntent,
} from "../src/audio/intents";

describe("audio intents", () => {
  it("every clip is known and coalescing set is a subset", () => {
    for (const clip of COALESCABLE) expect(AUDIO_CLIPS).toContain(clip);
  });

  it("coalescing keeps at most maxSame highest-priority with pitch spread", () => {
    const spam: AudioIntent[] = Array.from({ length: 20 }, (_, i) => ({
      clip: "combat.strike",
      worldX: i,
      priority: i,
    }));
    const out = coalesceSameFrame(spam, 4);
    expect(out).toHaveLength(4);
    const keptPriorities = out.map((o) => o.intent.priority);
    expect(keptPriorities).toEqual([19, 18, 17, 16]);
    expect(new Set(out.map((o) => o.pitch)).size).toBe(4);
  });

  it("short bursts pass through untouched with mild spread", () => {
    const few: AudioIntent[] = [{ clip: "act.chop" }, { clip: "act.chop" }];
    const out = coalesceSameFrame(few, 4);
    expect(out).toHaveLength(2);
    expect(out[0]!.pitch).toBeCloseTo(1);
  });
});

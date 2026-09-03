import { describe, expect, it } from "vitest";
import { minuteOfDay } from "../src/audio/simBridge";
import { AudioScheduler } from "../src/audio/scheduler";

describe("audio scheduling glue", () => {
  it("clock math: 8-min day at 30Hz → 10 ticks per sim minute (offset 7:00 AM)", () => {
    expect(minuteOfDay(0)).toBe(420); // 07:00 AM boot
    expect(minuteOfDay(300)).toBe(450); // 07:30 AM
    expect(minuteOfDay(10 * 1440)).toBe(420); // exactly one day later (07:00 AM)
    expect(minuteOfDay(10 * (1440 + 720))).toBe(1140); // 12h later (19:00 PM)
  });

  it("ambient flips day↔night across the boundaries and throttles", () => {
    const s = new AudioScheduler();
    s.ambient(600, 0); // day
    const first = s.drain((_) => {});
    expect(first.map((i) => i.clip)).toContain("ambient.day");
    s.ambient(600, 1000); // same, throttled
    expect(s.drain((_) => {})).toHaveLength(0);
    s.ambient(1400, 9000); // night, throttle elapsed
    expect(s.drain((_) => {}).map((i) => i.clip)).toContain("ambient.night");
  });

  it("drain clears the queue", () => {
    const s = new AudioScheduler();
    s.click();
    s.order();
    expect(s.drain((_) => {})).toHaveLength(2);
    expect(s.drain((_) => {})).toHaveLength(0);
  });
});

/**
 * Victory overlay chrome — M2-T10 (SPEC §2.11/§2.13).
 *
 * The pure formatting layer behind the DOM host: headline flips with the
 * viewer's perspective, reasons name conquest vs surrender per side, and
 * the stats recap reads ticks-elapsed plus both death ledgers. No DOM
 * here — createVictoryScreen stays untested by node like the rest of
 * the chrome.
 */
import { describe, expect, it } from "vitest";
import {
  formatRecapLines,
  formatTicksClock,
  formatVictoryReason,
  formatVictoryTitle,
} from "../src/ui/victoryScreen";

describe("victory overlay formatting", () => {
  it("flips the headline with the viewer's perspective", () => {
    expect(formatVictoryTitle("victory")).toBe("Victory");
    expect(formatVictoryTitle("defeat")).toBe("Defeat");
  });

  it("names the end reason for either side", () => {
    expect(formatVictoryReason("victory", "conquest")).toBe(
      "Conquest — enemy military production destroyed",
    );
    expect(formatVictoryReason("defeat", "conquest")).toBe(
      "Conquest — your military production was destroyed",
    );
    expect(formatVictoryReason("defeat", "surrender")).toBe(
      "You surrendered the match",
    );
    expect(formatVictoryReason("victory", "surrender")).toBe(
      "AI opponent surrendered the match",
    );
  });

  it("renders the recap: ticks elapsed first, then units lost", () => {
    expect(
      formatRecapLines({
        ticksElapsed: 630,
        viewerUnitsLost: 0,
        enemyUnitsLost: 0,
      }),
    ).toEqual(["Ticks elapsed: 630 (0:21)", "Units lost — you: 0 · enemy: 0"]);
    expect(
      formatRecapLines({
        ticksElapsed: 4500,
        viewerUnitsLost: 12,
        enemyUnitsLost: 3,
      }),
    ).toEqual([
      "Ticks elapsed: 4500 (2:30)",
      "Units lost — you: 12 · enemy: 3",
    ]);
  });

  it("formats the §2.13 clock at 30 ticks to the second", () => {
    expect(formatTicksClock(0)).toBe("0:00");
    expect(formatTicksClock(29)).toBe("0:00");
    expect(formatTicksClock(30)).toBe("0:01");
    expect(formatTicksClock(90)).toBe("0:03");
    expect(formatTicksClock(3600)).toBe("2:00");
  });
});

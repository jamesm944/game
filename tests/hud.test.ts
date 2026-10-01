/**
 * Topbar formatting — M2-T2 (SPEC §2.6), age badge M2-T4 (§2.11).
 *
 * The resource line must render ALL SEVEN gatherable slugs in canonical
 * code order, straight off the Stockpile rows the digests hash. The
 * age badge renders the roman-rank icon-text for the current ladder
 * rung. Pure string formatting — no DOM here (the seam stays unbroken).
 */
import { describe, expect, it } from "vitest";
import {
  ageBadgeStyle,
  formatAgeBadge,
  formatDifficultyBadge,
  formatStockpileLine,
  parseStockpileLine,
  resourceIconSvg,
} from "../src/ui/hud";
import { RESOURCE_NAMES } from "../src/sim/components/economy";

describe("topbar stockpile line (M2-T2)", () => {
  it("renders all seven gatherables in canonical order", () => {
    const line = formatStockpileLine([12, 340, 5, 0, 7, 3, 21]);
    expect(line).toBe(
      "food 12 · wood 340 · gold 5 · stone 0 · iron 7 · coal 3 · clay 21",
    );
    for (const name of RESOURCE_NAMES) {
      expect(line).toContain(name);
    }
  });

  it("fills missing codes with zeros — the pre-stockpile default", () => {
    expect(formatStockpileLine([])).toBe(
      "food 0 · wood 0 · gold 0 · stone 0 · iron 0 · coal 0 · clay 0",
    );
    // Legacy four-slug rows still render the full seven-slug line.
    expect(formatStockpileLine([1, 2, 3, 4])).toBe(
      "food 1 · wood 2 · gold 3 · stone 4 · iron 0 · coal 0 · clay 0",
    );
  });
});

describe("topbar age badge (M2-T4)", () => {
  it("renders the roman-rank icon-text for every ladder rung", () => {
    expect(formatAgeBadge(1)).toBe("I · Dark Age");
    expect(formatAgeBadge(2)).toBe("II · Feudal Age");
    expect(formatAgeBadge(3)).toBe("III · Castle Age");
    expect(formatAgeBadge(4)).toBe("IV · Imperial Age");
  });

  it("treats a missing rank as the dark-age default", () => {
    expect(formatAgeBadge(undefined)).toBe("I · Dark Age");
  });
});

describe("AI difficulty badge (M4-T6, §2.8 disclosure)", () => {
  it("normal hides nothing because nothing deviates", () => {
    expect(formatDifficultyBadge("normal")).toBe("AI Normal");
  });

  it("discloses every knob that deviates from normal", () => {
    // Easy: slower decisions AND slower reactions.
    expect(formatDifficultyBadge("easy")).toBe(
      "AI Easy · decisions ÷3 · reactions ÷3",
    );
    // Hard: faster decisions, instant reactions, and the documented
    // income cheat — spelled out, never hidden.
    expect(formatDifficultyBadge("hard")).toBe(
      "AI Hard · decisions ×2 · reactions instant · income ×1.25",
    );
  });
});

describe("resource topbar icons & parsing (V13, #92)", () => {
  it("provides distinct SVG icons for all 7 resources and pop", () => {
    const slugs = [
      "food",
      "wood",
      "gold",
      "stone",
      "iron",
      "coal",
      "clay",
      "pop",
    ];
    const svgs = new Set<string>();
    for (const slug of slugs) {
      const svg = resourceIconSvg(slug);
      expect(svg).toContain("<svg");
      expect(svgs.has(svg)).toBe(false);
      svgs.add(svg);
    }
  });

  it("parses stockpile + pop lines accurately", () => {
    const parsed = parseStockpileLine(
      "food 200 · wood 600 · gold 100 · pop 13/20",
    );
    expect(parsed).toEqual([
      { name: "food", value: "200" },
      { name: "wood", value: "600" },
      { name: "gold", value: "100" },
      { name: "pop", value: "13/20" },
    ]);
  });

  it("assigns distinct colors for every age rank", () => {
    const dark = ageBadgeStyle(1);
    const feudal = ageBadgeStyle(2);
    const castle = ageBadgeStyle(3);
    const imperial = ageBadgeStyle(4);

    expect(dark.borderColor).not.toBe(feudal.borderColor);
    expect(feudal.borderColor).not.toBe(castle.borderColor);
    expect(castle.borderColor).not.toBe(imperial.borderColor);
  });
});

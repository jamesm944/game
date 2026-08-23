/**
 * Topbar formatting — M2-T2 (SPEC §2.6).
 *
 * The resource line must render ALL SEVEN gatherable slugs in canonical
 * code order, straight off the Stockpile rows the digests hash. Pure
 * string formatting — no DOM here (the seam stays unbroken).
 */
import { describe, expect, it } from "vitest";
import { formatStockpileLine } from "../src/ui/hud";
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

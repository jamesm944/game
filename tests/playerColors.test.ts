import { describe, expect, it } from "vitest";
import {
  PLAYER_COLORS,
  playerColorOf,
  playerTintOf,
} from "../src/render/playerColors";

describe("playerColors", () => {
  it("defines at least 8 distinct player colors", () => {
    expect(PLAYER_COLORS.length).toBeGreaterThanOrEqual(8);
    const names = new Set(PLAYER_COLORS.map((c) => c.name));
    expect(names.size).toBe(PLAYER_COLORS.length);
  });

  it("gives Player 1 a blue tint and Player 2 a red tint", () => {
    const p1 = playerColorOf(0);
    expect(p1.name).toBe("Blue");
    expect(p1.tint[2]).toBeGreaterThan(p1.tint[0]); // B > R

    const p2 = playerColorOf(1);
    expect(p2.name).toBe("Red");
    expect(p2.tint[0]).toBeGreaterThan(p2.tint[2]); // R > B
  });

  it("falls back gracefully for unknown player IDs", () => {
    const fallback = playerColorOf(999);
    expect(fallback).toBe(PLAYER_COLORS[0]);
    expect(playerTintOf(999)).toEqual(PLAYER_COLORS[0]!.tint);
  });
});

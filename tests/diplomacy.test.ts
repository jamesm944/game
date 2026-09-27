import { describe, expect, it } from "vitest";
import {
  createDiplomacyMatrix,
  DIPLOMACY_STANCE_ALLY,
  DIPLOMACY_STANCE_NEUTRAL,
  DIPLOMACY_STANCE_ENEMY,
} from "../src/sim/core/diplomacy";

describe("DiplomacyMatrix (Issue #86 / #111)", () => {
  it("initializes FFA mode with self as ally and all opponents as enemies", () => {
    const d = createDiplomacyMatrix(4, "ffa");
    expect(d.playerCount).toBe(4);
    expect(d.mode).toBe("ffa");

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) {
          expect(d.getStance(i, j)).toBe(DIPLOMACY_STANCE_ALLY);
          expect(d.isAllied(i, j)).toBe(true);
          expect(d.isHostile(i, j)).toBe(false);
          expect(d.isNeutral(i, j)).toBe(false);
        } else {
          expect(d.getStance(i, j)).toBe(DIPLOMACY_STANCE_ENEMY);
          expect(d.isAllied(i, j)).toBe(false);
          expect(d.isHostile(i, j)).toBe(true);
          expect(d.isNeutral(i, j)).toBe(false);
        }
      }
    }

    expect(d.getAllies(0)).toEqual([0]);
    expect(d.getEnemies(0)).toEqual([1, 2, 3]);
  });

  it("initializes Teams mode (2v2) with allied pairings and cross-team hostility", () => {
    const d = createDiplomacyMatrix(4, "teams");
    expect(d.playerCount).toBe(4);
    expect(d.mode).toBe("teams");

    // Team 0: Players 0 & 1
    expect(d.isAllied(0, 1)).toBe(true);
    expect(d.isAllied(1, 0)).toBe(true);
    expect(d.isHostile(0, 1)).toBe(false);

    // Team 1: Players 2 & 3
    expect(d.isAllied(2, 3)).toBe(true);
    expect(d.isAllied(3, 2)).toBe(true);
    expect(d.isHostile(2, 3)).toBe(false);

    // Cross-team is hostile
    expect(d.isHostile(0, 2)).toBe(true);
    expect(d.isHostile(0, 3)).toBe(true);
    expect(d.isHostile(1, 2)).toBe(true);
    expect(d.isHostile(1, 3)).toBe(true);

    expect(d.getAllies(0)).toEqual([0, 1]);
    expect(d.getEnemies(0)).toEqual([2, 3]);
    expect(d.getAllies(2)).toEqual([2, 3]);
    expect(d.getEnemies(2)).toEqual([0, 1]);
  });

  it("supports dynamic stance modifications", () => {
    const d = createDiplomacyMatrix(4, "ffa");

    // Shift P0 and P1 to neutral
    d.setStance(0, 1, DIPLOMACY_STANCE_NEUTRAL);
    expect(d.getStance(0, 1)).toBe(DIPLOMACY_STANCE_NEUTRAL);
    expect(d.isNeutral(0, 1)).toBe(true);
    expect(d.isHostile(0, 1)).toBe(false);
    expect(d.isAllied(0, 1)).toBe(false);

    // Form alliance between P0 and P2
    d.setStance(0, 2, DIPLOMACY_STANCE_ALLY);
    d.setStance(2, 0, DIPLOMACY_STANCE_ALLY);
    expect(d.isAllied(0, 2)).toBe(true);
    expect(d.isAllied(2, 0)).toBe(true);

    // Invariant: cannot break self-alliance
    d.setStance(0, 0, DIPLOMACY_STANCE_ENEMY);
    expect(d.isAllied(0, 0)).toBe(true);
    expect(d.getStance(0, 0)).toBe(DIPLOMACY_STANCE_ALLY);
  });

  it("handles out-of-bounds player IDs safely", () => {
    const d = createDiplomacyMatrix(4, "ffa");

    expect(d.isHostile(0, 99)).toBe(true);
    expect(d.isAllied(0, 99)).toBe(false);
    expect(d.getStance(0, 99)).toBe(DIPLOMACY_STANCE_ENEMY);
    expect(d.isAllied(99, 99)).toBe(true); // self is always allied
  });

  it("rejects invalid player counts", () => {
    expect(() => createDiplomacyMatrix(0)).toThrow(
      "playerCount must be an integer >= 1",
    );
    expect(() => createDiplomacyMatrix(-1)).toThrow(
      "playerCount must be an integer >= 1",
    );
    expect(() => createDiplomacyMatrix(1.5 as unknown as number)).toThrow(
      "playerCount must be an integer >= 1",
    );
  });
});

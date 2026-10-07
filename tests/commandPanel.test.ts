import { describe, expect, it } from "vitest";
import {
  COMMAND_BUTTONS,
  FORMATION_BUTTONS,
  formatFormationLabel,
  formatStanceLabel,
  nextFormation,
  nextStance,
  type UnitStance,
} from "../src/ui/commandPanel";

describe("commandPanel button definitions (V13, #91)", () => {
  it("defines canonical AoE2 command buttons with unique hotkeys", () => {
    expect(COMMAND_BUTTONS.length).toBe(6);
    const ids = COMMAND_BUTTONS.map((b) => b.id);
    expect(ids).toContain("stop");
    expect(ids).toContain("attack-move");
    expect(ids).toContain("patrol");
    expect(ids).toContain("guard");
    expect(ids).toContain("stance");
    expect(ids).toContain("garrison");

    const hotkeys = new Set(COMMAND_BUTTONS.map((b) => b.hotkey));
    expect(hotkeys.size).toBe(COMMAND_BUTTONS.length);
  });

  it("assigns appropriate hotkeys (S for Stop, A for Attack-Move)", () => {
    const stop = COMMAND_BUTTONS.find((b) => b.id === "stop");
    expect(stop?.hotkey).toBe("S");

    const attack = COMMAND_BUTTONS.find((b) => b.id === "attack-move");
    expect(attack?.hotkey).toBe("A");
  });
});

describe("commandPanel formation buttons (Q4, #125)", () => {
  it("defines all 8 tactical formation buttons with distinct hotkeys", () => {
    expect(FORMATION_BUTTONS.length).toBe(8);
    const ids = FORMATION_BUTTONS.map((b) => b.id);
    expect(ids).toEqual([
      "line",
      "box",
      "staggered",
      "flank",
      "shieldWall",
      "square",
      "circle",
      "wedge",
    ]);

    const hotkeys = new Set(FORMATION_BUTTONS.map((b) => b.hotkey));
    expect(hotkeys.size).toBe(FORMATION_BUTTONS.length);
  });

  it("cycles through all 8 formations", () => {
    expect(nextFormation("line")).toBe("box");
    expect(nextFormation("box")).toBe("staggered");
    expect(nextFormation("staggered")).toBe("flank");
    expect(nextFormation("flank")).toBe("shieldWall");
    expect(nextFormation("shieldWall")).toBe("square");
    expect(nextFormation("square")).toBe("circle");
    expect(nextFormation("circle")).toBe("wedge");
    expect(nextFormation("wedge")).toBe("line");
  });

  it("formats human-readable labels for all formations", () => {
    expect(formatFormationLabel("line")).toBe("Formation: Line");
    expect(formatFormationLabel("box")).toBe("Formation: Box");
    expect(formatFormationLabel("staggered")).toBe("Formation: Staggered");
    expect(formatFormationLabel("flank")).toBe("Formation: Flank");
    expect(formatFormationLabel("shieldWall")).toBe("Formation: Shield Wall");
    expect(formatFormationLabel("square")).toBe("Formation: Square");
    expect(formatFormationLabel("circle")).toBe("Formation: Circle");
    expect(formatFormationLabel("wedge")).toBe("Formation: Wedge");
  });
});

describe("commandPanel stance cycle", () => {
  it("cycles through all four combat stances", () => {
    let stance: UnitStance = "aggressive";
    stance = nextStance(stance);
    expect(stance).toBe("defensive");
    stance = nextStance(stance);
    expect(stance).toBe("stand-ground");
    stance = nextStance(stance);
    expect(stance).toBe("no-attack");
    stance = nextStance(stance);
    expect(stance).toBe("aggressive");
  });

  it("formats human-readable labels for all stances", () => {
    expect(formatStanceLabel("aggressive")).toBe("Stance: Aggressive");
    expect(formatStanceLabel("defensive")).toBe("Stance: Defensive");
    expect(formatStanceLabel("stand-ground")).toBe("Stance: Stand Ground");
    expect(formatStanceLabel("no-attack")).toBe("Stance: No Attack");
  });
});

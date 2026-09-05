import { describe, expect, it } from "vitest";
import {
  COMMAND_BUTTONS,
  formatStanceLabel,
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

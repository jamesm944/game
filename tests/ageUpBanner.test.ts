import { describe, expect, it } from "vitest";
import {
  ageIconSvg,
  formatAgeToast,
  formatAgeUpTitle,
} from "../src/ui/ageUpBanner";
import { createWorld } from "../src/sim/core/world";
import { defineSimComponents } from "../src/sim/components";
import {
  createPlayerStockpile,
  createCommodityStockpile,
  PLAYER_ONE,
} from "../src/sim/core/stockpile";
import {
  appendAgeAdvancedEvent,
  createPlayerAgeState,
} from "../src/sim/components/age";
import { collectAudioIntents } from "../src/audio/simBridge";

describe("age-up cinematic banner & toast formatting (V13, #98)", () => {
  it("formats mid-screen toast titles for each age", () => {
    expect(formatAgeToast(1)).toBe("Dark Age reached!");
    expect(formatAgeToast(2)).toBe("Feudal Age reached!");
    expect(formatAgeToast(3)).toBe("Castle Age reached!");
    expect(formatAgeToast(4)).toBe("Imperial Age reached!");
  });

  it("formats Roman numeral crest title", () => {
    expect(formatAgeUpTitle(1)).toBe("I · DARK AGE");
    expect(formatAgeUpTitle(2)).toBe("II · FEUDAL AGE");
    expect(formatAgeUpTitle(3)).toBe("III · CASTLE AGE");
    expect(formatAgeUpTitle(4)).toBe("IV · IMPERIAL AGE");
  });

  it("provides distinct SVG emblem icons for every age", () => {
    const svgs = new Set<string>();
    for (let age = 1; age <= 4; age++) {
      const svg = ageIconSvg(age);
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svgs.has(svg)).toBe(false);
      svgs.add(svg);
    }
  });

  it("audio bridge collects age.up intent for human player age advance", () => {
    const world = createWorld(42, { size: 32 });
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE);
    createCommodityStockpile(world, comps, PLAYER_ONE);
    createPlayerAgeState(world, comps, PLAYER_ONE);

    world.tick = 100;
    appendAgeAdvancedEvent(world, comps, PLAYER_ONE, {
      tick: 100,
      ageRank: 2,
    });

    const intents = collectAudioIntents(world, comps, PLAYER_ONE, 50);
    const ageIntents = intents.filter((i) => i.clip === "age.up");
    expect(ageIntents).toHaveLength(1);
    expect(ageIntents[0]!.priority).toBe(10);
    expect(ageIntents[0]!.pitch).toBeUndefined();
  });

  it("audio bridge collects age.up intent with distinct enemy tone (pitch: 0.82) for AI opponent", () => {
    const world = createWorld(42, { size: 32 });
    const comps = defineSimComponents(world);
    const AI_PLAYER = 1;

    // Set up human and AI players
    createPlayerStockpile(world, comps, PLAYER_ONE);
    createCommodityStockpile(world, comps, PLAYER_ONE);
    createPlayerAgeState(world, comps, PLAYER_ONE);

    createPlayerStockpile(world, comps, AI_PLAYER);
    createCommodityStockpile(world, comps, AI_PLAYER);
    createPlayerAgeState(world, comps, AI_PLAYER);

    world.tick = 150;
    // Opponent advances
    appendAgeAdvancedEvent(world, comps, AI_PLAYER, {
      tick: 150,
      ageRank: 2,
    });

    const intents = collectAudioIntents(world, comps, PLAYER_ONE, 100);
    const ageIntents = intents.filter((i) => i.clip === "age.up");
    expect(ageIntents).toHaveLength(1);
    expect(ageIntents[0]!.pitch).toBe(0.82);
    expect(ageIntents[0]!.priority).toBe(8);
  });
});

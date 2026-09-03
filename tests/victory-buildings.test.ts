/**
 * Tests for Issue #76 (V5: Victory-act buildings present):
 * - Victory-act buildings (Grand Academy, Grand Monument, Wonder, Monastery) placeable & constructible
 * - Authentic 3D model mapping per ASSET-INVENTORY.md
 * - Relic mirror snapshot and skirmish world relic spawning
 * - Build menu and building training queue UI integration
 */

import { describe, expect, it } from "vitest";
import { BUILDING_DEFINITIONS } from "../src/data/definitions";
import { BUILD_MENU_IDS } from "../src/ui/buildMenu";
import { modelKeyFor } from "../src/render/buildingModels";
import { createWorld } from "../src/sim/core/world";
import { defineSimComponents, spawnUnit } from "../src/sim/components";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  spawnRelic,
  carryRelic,
  storeRelic,
  relicsOf,
  RELIC_GROUND,
  RELIC_CARRIED,
  RELIC_STORED,
} from "../src/sim/components/relic";
import { captureRelicSnapshot } from "../src/sim/mirror";
import { createSkirmishWorld } from "../src/game/session";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";

describe("Issue #76: Victory-act buildings & relics", () => {
  describe("victory-act building definitions and models", () => {
    it("Grand Academy (knowledge path) has correct def and authentic model", () => {
      const def = BUILDING_DEFINITIONS.get("grand-academy");
      expect(def).toBeDefined();
      expect(def?.ageGate).toBe("imperial");
      expect(def?.footprint).toEqual({ width: 3, height: 3 });
      expect(modelKeyFor("grand-academy", 4)).toBe("academy");
    });

    it("Monument and Grand Monument (culture path) have authentic models", () => {
      const monument = BUILDING_DEFINITIONS.get("monument");
      expect(monument).toBeDefined();
      expect(monument?.ageGate).toBe("castle");
      expect(monument?.footprint).toEqual({ width: 2, height: 2 });
      expect(modelKeyFor("monument", 3)).toBe("monumentModel");

      const grandMonument = BUILDING_DEFINITIONS.get("grand-monument");
      expect(grandMonument).toBeDefined();
      expect(grandMonument?.ageGate).toBe("imperial");
      expect(grandMonument?.footprint).toEqual({ width: 3, height: 3 });
      expect(modelKeyFor("grand-monument", 4)).toBe("grandMonumentModel");
    });

    it("Wonder (wonder path) has authentic model", () => {
      const wonder = BUILDING_DEFINITIONS.get("wonder");
      expect(wonder).toBeDefined();
      expect(wonder?.ageGate).toBe("imperial");
      expect(wonder?.footprint).toEqual({ width: 3, height: 3 });
      expect(modelKeyFor("wonder", 4)).toBe("wonder2");
    });

    it("Monastery (relic path) trains monks and has authentic models", () => {
      const monastery = BUILDING_DEFINITIONS.get("monastery");
      expect(monastery).toBeDefined();
      expect(monastery?.ageGate).toBe("castle");
      expect(monastery?.trainQueue?.trainable.map((t) => t.unitId)).toContain(
        "monk",
      );
      expect(modelKeyFor("monastery", 3)).toBe("monasteryCastle");
      expect(modelKeyFor("monastery", 4)).toBe("monasteryImperial");
    });
  });

  describe("build menu inclusion", () => {
    it("contains all victory buildings and economic workplaces", () => {
      expect(BUILD_MENU_IDS).toContain("grand-academy");
      expect(BUILD_MENU_IDS).toContain("monument");
      expect(BUILD_MENU_IDS).toContain("grand-monument");
      expect(BUILD_MENU_IDS).toContain("wonder");
      expect(BUILD_MENU_IDS).toContain("monastery");
      expect(BUILD_MENU_IDS).toContain("church");
      expect(BUILD_MENU_IDS).toContain("school");
      expect(BUILD_MENU_IDS).toContain("lumber-camp");
      expect(BUILD_MENU_IDS).toContain("mining-camp");
    });
  });

  describe("relic mirror snapshot", () => {
    it("captures ground, carried, and stored relics into pure typed arrays", () => {
      const world = createWorld(42, { size: 64 });
      const comps = defineSimComponents(world);

      const r1 = spawnRelic(world, comps, 15, 20);
      const r2 = spawnRelic(world, comps, 25, 30);
      const r3 = spawnRelic(world, comps, 35, 40);

      const monk = spawnUnit(world, comps, 50, 50);
      const monastery = stampFinishedBuilding(
        world,
        comps,
        "monastery",
        60,
        60,
        {
          playerId: 0,
        },
      );

      // r1 remains ground
      // r2 carried by monk
      carryRelic(world, comps, r2, monk);

      // r3 stored in monastery
      storeRelic(world, comps, r3, monastery);

      const frame = captureRelicSnapshot(world, comps);
      expect(frame.count).toBe(3);
      expect(frame.eids[0]).toBe(r1);
      expect(frame.states[0]).toBe(RELIC_GROUND);
      expect(frame.positions[0]).toBe(15);
      expect(frame.positions[1]).toBe(20);

      expect(frame.eids[1]).toBe(r2);
      expect(frame.states[1]).toBe(RELIC_CARRIED);
      expect(frame.holderEids[1]).toBe(monk);
      // Carried relic reports holder's position (50, 50)
      expect(frame.positions[2]).toBe(50);
      expect(frame.positions[3]).toBe(50);

      expect(frame.eids[2]).toBe(r3);
      expect(frame.states[2]).toBe(RELIC_STORED);
      expect(frame.holderEids[2]).toBe(monastery);
    });
  });

  describe("skirmish world relic spawning", () => {
    it("spawns 5 neutral relics when spawnRelics is enabled", () => {
      const session = createSkirmishWorld(12345, {
        createTransport: () => createSynchronousPathTransport(),
        spawnRelics: true,
      });

      const relics = relicsOf(session.world, session.comps);
      expect(relics.length).toBe(5);

      for (const relic of relics) {
        expect(relic.row.state).toBe(RELIC_GROUND);
        expect(relic.row.holderEid).toBe(0);
      }
    });

    it("omits relics when spawnRelics is undefined (preserving headless test fixtures)", () => {
      const session = createSkirmishWorld(12345, {
        createTransport: () => createSynchronousPathTransport(),
      });

      const relics = relicsOf(session.world, session.comps);
      expect(relics.length).toBe(0);
    });
  });
});

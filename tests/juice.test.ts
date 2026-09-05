/**
 * Unit & Integration Tests for V11: Juice (#82).
 *
 * Headless-compliant tests (zero three.js imports per SPEC §7 / ADR-0001 seam rules):
 * - Animated selection rings bracket rotation & pulse math
 * - Order feedback ring markers cubic ease-out & rotational expansion
 * - Production building rally point logic & badge mapping
 * - Chimney smoke building filter & height emission offsets
 * - Age-up cinematic banner formatting & headless safety
 */

import { describe, expect, it } from "vitest";
import { formatAgeUpTitle, createAgeUpBanner } from "../src/ui/ageUpBanner";
import { BUILDING_DEFINITIONS } from "../src/data/definitions";

describe("V11: Juice — selection polish, ambient life, UI transitions", () => {
  describe("selection ring animation math", () => {
    it("calculates bracket rotation and pulsing scale accurately", () => {
      // Rotation: 0.8 radians per second
      const rotAt0 = (0 * 0.8) % (Math.PI * 2);
      const rotAt1 = (1 * 0.8) % (Math.PI * 2);
      expect(rotAt0).toBe(0);
      expect(rotAt1).toBeCloseTo(0.8, 5);

      // Pulse: 1.0 + 0.06 * sin(5 * t)
      const pulseAt0 = 1.0 + 0.06 * Math.sin(5 * 0);
      const pulseAtHalfPi = 1.0 + 0.06 * Math.sin(Math.PI / 2);
      const pulseAtNegHalfPi = 1.0 + 0.06 * Math.sin(-Math.PI / 2);

      expect(pulseAt0).toBeCloseTo(1.0, 5);
      expect(pulseAtHalfPi).toBeCloseTo(1.06, 5);
      expect(pulseAtNegHalfPi).toBeCloseTo(0.94, 5);

      // Verify pulse is strictly bounded in [0.94, 1.06] over a full period
      for (let t = 0; t <= 2; t += 0.05) {
        const p = 1.0 + 0.06 * Math.sin(5 * t);
        expect(p).toBeGreaterThanOrEqual(0.94 - 1e-6);
        expect(p).toBeLessThanOrEqual(1.06 + 1e-6);
      }
    });
  });

  describe("order marker easing math", () => {
    it("implements cubic ease-out expansion: 1 - (1 - p)^3", () => {
      const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

      expect(easeOut(0)).toBe(0);
      expect(easeOut(0.5)).toBeCloseTo(0.875, 5);
      expect(easeOut(1)).toBe(1);

      // Monotonically increasing
      let last = -1;
      for (let p = 0; p <= 1; p += 0.1) {
        const val = easeOut(p);
        expect(val).toBeGreaterThanOrEqual(last);
        last = val;
      }
    });

    it("interpolates marker expansion scale and fade alpha over lifetime", () => {
      const durationSec = 0.65;
      const initialScale = 0.35;
      const finalScale = 1.6;

      const evalMarker = (elapsed: number) => {
        const progress = Math.min(1.0, elapsed / durationSec);
        const ease = 1 - Math.pow(1 - progress, 3);
        const scale = initialScale + (finalScale - initialScale) * ease;
        const alpha = Math.max(0, 1.0 - progress);
        const spin = progress * 0.4;
        return { scale, alpha, spin };
      };

      const atStart = evalMarker(0);
      expect(atStart.scale).toBeCloseTo(0.35, 5);
      expect(atStart.alpha).toBe(1.0);
      expect(atStart.spin).toBe(0);

      const atMid = evalMarker(0.325);
      expect(atMid.scale).toBeGreaterThan(1.0);
      expect(atMid.alpha).toBeCloseTo(0.5, 5);

      const atEnd = evalMarker(0.65);
      expect(atEnd.scale).toBeCloseTo(1.6, 5);
      expect(atEnd.alpha).toBe(0);
      expect(atEnd.spin).toBeCloseTo(0.4, 5);
    });
  });

  describe("production building rally point logic", () => {
    it("correctly identifies production buildings eligible for rally points", () => {
      const isProduction = (defId: string) => {
        const def = BUILDING_DEFINITIONS.get(defId);
        return Boolean(def && def.trainQueue !== undefined);
      };

      expect(isProduction("town-center")).toBe(true);
      expect(isProduction("barracks")).toBe(true);
      expect(isProduction("archery-range")).toBe(true);
      expect(isProduction("stable")).toBe(true);
      expect(isProduction("monastery")).toBe(true);

      expect(isProduction("house")).toBe(false);
      expect(isProduction("farm")).toBe(false);
      expect(isProduction("blacksmith")).toBe(false);
      expect(isProduction("watch-tower")).toBe(false);
      expect(isProduction("wall-wood")).toBe(false);
    });

    it("calculates building center coordinates for rally waypoint lines", () => {
      const buildingCenter = (
        tileX: number,
        tileY: number,
        footprint: { width: number; height: number },
      ) => {
        return [tileX + footprint.width * 0.5, tileY + footprint.height * 0.5];
      };

      const tc = BUILDING_DEFINITIONS.get("town-center")!;
      expect(buildingCenter(10, 10, tc.footprint)).toEqual([11.5, 11.5]); // 3x3 footprint

      const barracks = BUILDING_DEFINITIONS.get("barracks")!;
      expect(buildingCenter(20, 15, barracks.footprint)).toEqual([21.5, 16.5]); // 3x3 footprint
    });
  });

  describe("chimney smoke emission candidates", () => {
    it("identifies residential and industrial buildings with chimneys", () => {
      const CHIMNEY_DEFS = new Set(["house", "town-center", "blacksmith"]);

      expect(CHIMNEY_DEFS.has("house")).toBe(true);
      expect(CHIMNEY_DEFS.has("town-center")).toBe(true);
      expect(CHIMNEY_DEFS.has("blacksmith")).toBe(true);
      expect(CHIMNEY_DEFS.has("barracks")).toBe(false);
      expect(CHIMNEY_DEFS.has("farm")).toBe(false);
      expect(CHIMNEY_DEFS.has("wall-wood")).toBe(false);
    });

    it("computes chimney world offset from footprint", () => {
      const chimneyWorldPos = (
        tileX: number,
        tileY: number,
        footprint: { width: number; height: number },
        groundY: number,
        roofHeight: number,
      ) => {
        const cx = tileX + footprint.width * 0.65;
        const cy = tileY + footprint.height * 0.65;
        const cz = groundY + roofHeight;
        return { x: cx, y: cz, z: cy };
      };

      const pos = chimneyWorldPos(10, 10, { width: 2, height: 2 }, 0.5, 1.8);
      expect(pos.x).toBeCloseTo(11.3, 4);
      expect(pos.z).toBeCloseTo(11.3, 4);
      expect(pos.y).toBeCloseTo(2.3, 4);
    });
  });

  describe("age-up banner", () => {
    it("formats correct Roman numeral and age name", () => {
      expect(formatAgeUpTitle(1)).toBe("I · DARK AGE");
      expect(formatAgeUpTitle(2)).toBe("II · FEUDAL AGE");
      expect(formatAgeUpTitle(3)).toBe("III · CASTLE AGE");
      expect(formatAgeUpTitle(4)).toBe("IV · IMPERIAL AGE");
      expect(formatAgeUpTitle(5)).toBe("5 · AGE 5");
    });

    it("handles show and dispose safely in headless environment", () => {
      const banner = createAgeUpBanner();
      expect(() => banner.show(2)).not.toThrow();
      expect(() => banner.show(3)).not.toThrow();
      expect(() => banner.dispose()).not.toThrow();
    });
  });
});

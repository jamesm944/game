/**
 * Fog-of-war stub tests — SPEC §2.9 / M1-T11.
 *
 * M1 ships only the VisibilityProvider seam plus the all-visible
 * implementation. These tests pin:
 *   1. stub semantics (on-grid explored+visible, off-grid false);
 *   2. dirty hooks + flush are safe no-ops;
 *   3. the seam actually SEAMS: a world created with a denying fake
 *      provider rejects placements as "unexplored" through the exact
 *      same call-sites production uses — M2's real planes swap in at
 *      world creation without touching any consumer.
 */

import { describe, expect, it } from "vitest";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import { defineSimComponents, getBuildingSiteRow } from "../src/sim/components";
import {
  createAllVisibleProvider,
  type VisibilityProvider,
} from "../src/sim/systems/fog";
import {
  createPlacementSystem,
  validatePlacement,
} from "../src/sim/systems/placement";

/** Fake M2-style provider: everything visible, nothing explored. */
function denyingExploredProvider(): VisibilityProvider {
  const dirty: string[] = [];
  return {
    id: "deny-explored",
    isVisible: () => true,
    isExplored: () => false,
    markDirty: (reason, eid) => {
      dirty.push(`${reason}:${String(eid)}`);
    },
    flushDirty: () => {
      dirty.length = 0;
    },
  };
}

describe("all-visible fog stub (SPEC §2.9)", () => {
  it("answers explored+visible on-grid and false off-grid", () => {
    const fog = createAllVisibleProvider(4);
    expect(fog.id).toBe("all-visible");
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(fog.isVisible(x, y, 0)).toBe(true);
        expect(fog.isExplored(x, y, 1)).toBe(true);
      }
    }
    expect(fog.isVisible(-1, 0, 0)).toBe(false);
    expect(fog.isExplored(0, -1, 0)).toBe(false);
    expect(fog.isVisible(4, 2, 0)).toBe(false);
    expect(fog.isExplored(2, 4, 0)).toBe(false);
    expect(fog.isVisible(0.5, 2, 0)).toBe(false);
  });

  it("rejects non-positive or non-integer grid sizes", () => {
    expect(() => createAllVisibleProvider(0)).toThrow(/positive integer/);
    expect(() => createAllVisibleProvider(3.5)).toThrow(/positive integer/);
  });

  it("tolerates dirty marks and empty flushes", () => {
    const fog = createAllVisibleProvider(8);
    fog.flushDirty(); // nothing queued: must not throw
    fog.markDirty("spawned", 1);
    fog.markDirty("moved", 2);
    fog.markDirty("removed", 3);
    fog.flushDirty();
    // Stub stays stateless: queries unchanged after any traffic.
    expect(fog.isVisible(3, 3, 0)).toBe(true);
    expect(fog.isExplored(3, 3, 0)).toBe(true);
  });
});

describe("visibility seam wiring", () => {
  it("defaults every world to the all-visible provider", () => {
    const world = createWorld(7, { size: 16 });
    expect(world.visibility.id).toBe("all-visible");
    expect(world.visibility.isExplored(15, 15, 0)).toBe(true);
  });

  it("flushes dirty entities once per tick after systems run", () => {
    let flushes = 0;
    const world = createWorld(7, {
      size: 16,
      visibility: {
        ...createAllVisibleProvider(16),
        flushDirty: () => {
          flushes += 1;
        },
      },
    });
    step(world);
    step(world);
    expect(world.tick).toBe(2);
    expect(flushes).toBe(2);
  });

  it("placement consults the provider — denying fakes reject unexplored", () => {
    // Two identical worlds; the ONLY difference is the fog provider.
    const allVisibleWorld = createWorld(11, { size: 32 });
    const denyingWorld = createWorld(11, {
      size: 32,
      visibility: denyingExploredProvider(),
    });
    const compsA = defineSimComponents(allVisibleWorld);
    const compsB = defineSimComponents(denyingWorld);
    registerSystem(allVisibleWorld, createPlacementSystem(compsA));
    registerSystem(denyingWorld, createPlacementSystem(compsB));

    // A plain grass spot both worlds agree is on-grid and buildable.
    const passable = allVisibleWorld.layers.derivedPassability;
    let spot: { x: number; y: number } | undefined;
    outer: for (let y = 2; y < 30; y++) {
      for (let x = 2; x < 30; x++) {
        if (passable[y * 32 + x] === 1 && passable[y * 32 + x + 1] === 1) {
          spot = { x, y };
          break outer;
        }
      }
    }
    expect(spot).toBeDefined();
    expect(
      validatePlacement(allVisibleWorld, compsA, "house", spot!.x, spot!.y).ok,
    ).toBe(true);

    // Same call-site through the swapped provider now rejects with the
    // fog reason, and the command handler throws loudly exactly like
    // every other placement rejection.
    const check = validatePlacement(
      denyingWorld,
      compsB,
      "house",
      spot!.x,
      spot!.y,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("unexplored");
    denyingWorld.inbox.submit({
      kind: "placeBuilding",
      targetTick: denyingWorld.tick + 1,
      data: { defId: "house", tileX: spot!.x, tileY: spot!.y },
    });
    expect(() => step(denyingWorld)).toThrow(/unexplored/);
    // Nothing was placed in either world.
    step(allVisibleWorld);
    expect(getBuildingSiteRow(allVisibleWorld, compsA, 1)).toBeUndefined();
    expect(getBuildingSiteRow(denyingWorld, compsB, 1)).toBeUndefined();
  });
});

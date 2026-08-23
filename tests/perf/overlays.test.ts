/**
 * Overlay attribute-write headless gate — SPEC §7 / M2-T6.
 *
 * Node-only by design (no jsdom, no three): the overlay layers' per-
 * frame CPU cost is the pure typed-array fill in render/overlayPack.ts
 * (the three.js layer only uploads what it produced), mirroring the
 * billboard field's discipline. The draw-CALL side of the contract —
 * overlays = exactly 2 extra draw calls — is asserted in a browser via
 * renderer.info and documented in docs/m2-overlays.md; this suite pins
 * the write path: semantics, f32 types, capacity capping, and the
 * 500-instance budget.
 */

import { describe, expect, it } from "vitest";
import {
  HEALTH_BAR_CAPACITY,
  HEALTH_BAR_LIFT,
  packHealthBarAttributes,
  type HealthBarAttributeArrays,
} from "../../src/render/overlayPack";
import {
  defineSimComponents,
  spawnCombatUnit,
  spawnUnit,
} from "../../src/sim/components";
import { createWorld } from "../../src/sim/core/world";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import { captureSimSnapshot } from "../../src/sim/mirror";
import {
  createRenderMirror,
  pushFrame,
  sampleMirror,
} from "../../src/render/mirror";

const COUNT = 512;

function arrays(capacity = HEALTH_BAR_CAPACITY): HealthBarAttributeArrays {
  return {
    origins: new Float32Array(capacity * 3),
    fractions: new Float32Array(capacity),
  };
}

describe("health bar packer", () => {
  it("includes damaged or selected units and skips healthy bystanders", () => {
    const out = arrays();
    // ranks: 0 healthy, 1 damaged, 2 selected-healthy, 3 dead-ish.
    const sample = {
      positions: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      hpFractions: Float32Array.of(1, 0.75, 1, 0.05),
      selectedFlags: Uint8Array.of(0, 0, 1, 0),
      count: 4,
    };
    const heights = new Float32Array(4).fill(0.25);
    const written = packHealthBarAttributes(
      out,
      sample,
      heights,
      HEALTH_BAR_CAPACITY,
    );
    expect(written).toBe(3);
    // Compacted but keeping their own positions + ground heights.
    expect(out.origins[0]).toBe(3); // rank 1 x
    expect(out.origins[1]).toBeCloseTo(Math.fround(0.25 + HEALTH_BAR_LIFT), 5);
    expect(out.origins[2]).toBe(4); // rank 1 y
    expect(out.fractions[0]).toBe(0.75);
    expect(out.origins[3]).toBe(5); // rank 2 x
    expect(out.fractions[1]).toBe(1);
    expect(out.origins[6]).toBe(7); // rank 3 x
    // Fractions store as f32 — compare rounded.
    expect(out.fractions[0]).toBeCloseTo(0.75, 5);
    expect(out.fractions[1]).toBe(1);
    expect(out.fractions[2]).toBeCloseTo(0.05, 5);
  });

  it("caps writes at capacity without touching memory beyond", () => {
    const small = arrays(2);
    const sample = {
      positions: new Float32Array(COUNT * 2).fill(9),
      hpFractions: new Float32Array(COUNT).fill(0.5),
      selectedFlags: new Uint8Array(COUNT),
      count: COUNT,
    };
    const heights = new Float32Array(COUNT);
    expect(packHealthBarAttributes(small, sample, heights, 2)).toBe(2);
    expect(small.fractions.length).toBe(2);
  });

  it("fills a full screen of bars well under the §7 budget", () => {
    const out = arrays();
    const sample = {
      positions: new Float32Array(COUNT * 2),
      hpFractions: new Float32Array(COUNT),
      selectedFlags: new Uint8Array(COUNT),
      count: COUNT,
    };
    for (let i = 0; i < COUNT; i++) {
      sample.positions[i * 2] = (i % 24) + 0.5;
      sample.positions[i * 2 + 1] = Math.floor(i / 24) + 0.5;
      sample.hpFractions[i] = (i % 3) / 3;
    }
    const heights = new Float32Array(COUNT).fill(0.25);

    packHealthBarAttributes(out, sample, heights, HEALTH_BAR_CAPACITY); // warm-up
    let fastest = Infinity;
    for (let attempt = 0; attempt < 7; attempt++) {
      const start = performance.now();
      const n = packHealthBarAttributes(
        out,
        sample,
        heights,
        HEALTH_BAR_CAPACITY,
      );
      fastest = Math.min(fastest, performance.now() - start);
      expect(n).toBeGreaterThan(0);
    }
    expect(fastest).toBeLessThan(2); // ms — same flat-fill gate as billboards
  });
});

describe("mirror health feed (M2-T6)", () => {
  it("captures combatant hp fractions and full bars for civilians", () => {
    const world = createWorld(5, { size: 16 });
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE); // ledger takes eid 1
    const fighter = spawnCombatUnit(
      world,
      comps,
      "militia",
      4.5,
      4.5,
      PLAYER_ONE,
    );
    spawnUnit(world, comps, 8.5, 8.5);

    // Chip the fighter to half health through its live Combat row.
    const row = world.rowsByComponentId.get(comps.combatId)!.get(fighter)!;
    row[2] = Math.floor(row[2]! / 2); // 20 / 40

    const frame = captureSimSnapshot(world, comps);
    expect(frame.count).toBe(2);
    expect(frame.hpFractions[0]).toBe(0.5); // ascending-eid rank order
    expect(frame.hpFractions[1]).toBe(1);
    expect(frame.hpFractions.constructor).toBe(Float32Array);
  });

  it("carries fractions through push/sample interpolation", () => {
    const world = createWorld(6, { size: 16 });
    const comps = defineSimComponents(world);
    createPlayerStockpile(world, comps, PLAYER_ONE); // ledger takes eid 1
    const fighter = spawnCombatUnit(
      world,
      comps,
      "militia",
      4.5,
      4.5,
      PLAYER_ONE,
    );

    const mirror = createRenderMirror();
    pushFrame(mirror, captureSimSnapshot(world, comps)); // tick N: full hp

    // Next tick: same unit down to 10/40.
    world.tick += 1;
    const row = world.rowsByComponentId.get(comps.combatId)!.get(fighter)!;
    row[2] = 10;
    pushFrame(mirror, captureSimSnapshot(world, comps));

    const out = {
      positions: new Float32Array(4),
      headings: new Float32Array(2),
      hpFractions: new Float32Array(2),
    };
    expect(sampleMirror(mirror, 0.5, out)).toBe(1);
    expect(out.hpFractions[0]).toBeCloseTo(0.625, 10); // lerp 1 → 0.25
  });
});

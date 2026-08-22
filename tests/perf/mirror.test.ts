/**
 * Render-mirror headless perf gate — SPEC §7 ("headless CPU-budget
 * assertions") / M1-T6 ticket.
 *
 * Node-only by design (no jsdom — a jsdom need would mean the seam is
 * broken): both ends of the mirror are plain typed-array arithmetic,
 * `sim/mirror.captureSimSnapshot` is pure TS and `render/mirror` is
 * deliberately THREE-FREE, so the whole pipeline runs here without a
 * browser or GPU. Asserts the ticket budget — snapshot copy AND
 * interpolation sampling each under 1 ms for 10k entities — plus the
 * correctness contract (endpoints exact, shortest-arc headings,
 * population-change tails).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  defineMovementComponents,
  getPosition,
  getVelocityRow,
  setPosition,
  spawnUnit,
} from "../../src/sim/components";
import { createWorld } from "../../src/sim/core/world";
import { captureSimSnapshot } from "../../src/sim/mirror";
import {
  createRenderMirror,
  pushFrame,
  sampleMirror,
  type MirrorSampleOut,
} from "../../src/render/mirror";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

const ENTITY_COUNT = 10_000;
const MAP_SIZE = 120;
/** Ticket budget: each side of the mirror alone must stay under this. */
const BUDGET_MS = 1;

installSimPurityShims();

describe("render mirror", () => {
  let world!: ReturnType<typeof createWorld>;
  let comps!: ReturnType<typeof defineMovementComponents>;

  beforeEach(() => {
    // Fresh 10k-population world per test; NOT part of timing claims.
    world = createWorld(20260822, { size: MAP_SIZE });
    comps = defineMovementComponents(world);
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const eid = spawnUnit(
        world,
        comps,
        ((i * 7) % MAP_SIZE) + 0.5,
        (Math.floor(i / MAP_SIZE) % MAP_SIZE) + 0.5,
      );
      getVelocityRow(world, comps, eid)[0] = ((i % 64) / 64) * Math.PI * 2;
    }
    world.tick = 99;
  });

  function makeOut(): MirrorSampleOut {
    return {
      positions: new Float32Array(ENTITY_COUNT * 2),
      headings: new Float32Array(ENTITY_COUNT),
    };
  }

  it("captures every live unit ascending-eid into SoA arrays", () => {
    const frame = captureSimSnapshot(world, comps);
    expect(frame.tick).toBe(99);
    expect(frame.count).toBe(ENTITY_COUNT);
    for (let i = 0; i < ENTITY_COUNT; i += 977) {
      const pos = getPosition(world, comps, frame.eids[i]!);
      // Frames store f32, sim rows are f64 — compare rounded.
      expect(frame.positions[i * 2]).toBe(Math.fround(pos.x));
      expect(frame.positions[i * 2 + 1]).toBe(Math.fround(pos.y));
      expect(frame.headings[i]).toBe(
        Math.fround(getVelocityRow(world, comps, frame.eids[i]!)[0]!),
      );
    }
  });

  it("interpolates endpoints exactly and midpoints linearly", () => {
    const mirror = createRenderMirror();
    pushFrame(mirror, captureSimSnapshot(world, comps));

    // Move every unit one tick later.
    world.tick = 100;
    for (const eid of world.entities) {
      const row = getPosition(world, comps, eid);
      setPosition(world, comps, eid, row.x + 1, row.y + 2);
    }
    pushFrame(mirror, captureSimSnapshot(world, comps));

    const out = makeOut();
    expect(sampleMirror(mirror, 0, out)).toBe(ENTITY_COUNT);
    // Alpha 0 must equal buffer B verbatim…
    expect(out.positions[4]).toBe(mirror.bufferB.positions[4]);
    expect(out.headings[0]).toBe(mirror.bufferB.headings[0]);
    // …alpha 1 must equal buffer A…

    sampleMirror(mirror, 1, out);
    expect(out.positions[0]).toBeCloseTo(mirror.bufferA.positions[0]!, 6);

    const halfX =
      (mirror.bufferA.positions[0]! + mirror.bufferB.positions[0]!) / 2;
    sampleMirror(mirror, 0.5, out);
    expect(out.positions[0]).toBeCloseTo(halfX, 6);
  });

  it("wraps headings along the shortest arc", () => {
    const mirror = createRenderMirror();
    pushFrame(mirror, {
      tick: 1,
      count: 1,
      eids: Int32Array.of(1),
      positions: Float32Array.of(5, 5),
      headings: Float32Array.of(0.1),
    });
    pushFrame(mirror, {
      tick: 2,
      count: 1,
      eids: Int32Array.of(1),
      positions: Float32Array.of(5, 5),
      headings: Float32Array.of(0.1 + 5.5), // raw gap 5.5 rad > π
    });
    const out = makeOut();
    sampleMirror(mirror, 0.5, out);
    // Shortest arc: 5.5 wraps to 5.5 − 2π ≈ −0.783, so the midpoint
    // lands near 0.1 − 0.392, NOT halfway through π.
    expect(out.headings[0]).toBeCloseTo(0.1 - 0.7831853 / 2, 4);
  });

  it("renders population growth verbatim beyond the shared prefix", () => {
    const mirror = createRenderMirror();
    pushFrame(mirror, {
      tick: 1,
      count: 2,
      eids: Int32Array.of(1, 2),
      positions: Float32Array.of(1, 1, 2, 2),
      headings: Float32Array.of(0, 0),
    });
    pushFrame(mirror, {
      tick: 2,
      count: 3,
      eids: Int32Array.of(1, 2, 3),
      positions: Float32Array.of(3, 3, 4, 4, 5, 5),
      headings: Float32Array.of(1, 1, 1),
    });
    const out = makeOut();
    const written = sampleMirror(mirror, 0.5, out);
    expect(written).toBe(3);
    expect(out.positions[0]).toBe(2); // interpolated prefix…
    expect(out.positions[4]).toBe(5); // …verbatim tail for newcomers
    expect(out.headings[2]).toBe(1);
  });

  it("copies 10k-entity snapshots in under 1 ms", () => {
    // Warm-up (JIT + allocator), then best-of-seven single shots —
    // best-of keeps scheduler/GC noise out of the budget claim.
    captureSimSnapshot(world, comps);
    captureSimSnapshot(world, comps);
    let fastest = Infinity;
    for (let attempt = 0; attempt < 7; attempt++) {
      const start = performance.now();
      captureSimSnapshot(world, comps);
      fastest = Math.min(fastest, performance.now() - start);
    }
    expect(fastest).toBeLessThan(BUDGET_MS);
  });

  it("samples 10k entities in under 1 ms", () => {
    const mirror = createRenderMirror();
    pushFrame(mirror, captureSimSnapshot(world, comps));
    world.tick += 1;
    for (const eid of world.entities) {
      const row = getPosition(world, comps, eid);
      setPosition(world, comps, eid, row.x + 0.03, row.y - 0.02);
    }
    pushFrame(mirror, captureSimSnapshot(world, comps));

    const out = makeOut();
    sampleMirror(mirror, 0.5, out);
    sampleMirror(mirror, 0.5, out);
    let fastest = Infinity;
    for (let attempt = 0; attempt < 7; attempt++) {
      const start = performance.now();
      sampleMirror(mirror, 0.37, out);
      fastest = Math.min(fastest, performance.now() - start);
    }
    expect(fastest).toBeLessThan(BUDGET_MS);
  });
});

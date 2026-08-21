import { describe, expect, it } from "vitest";
import {
  computeWorldDigest,
  createWorld,
  defineComponent,
  registerSystem,
  setComponentValues,
  spawnEntity,
  step,
} from "../src/sim/core/world";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function buildDriftWorld(seed: number) {
  const world = createWorld(seed);
  const mass = defineComponent(world, "mass");
  const position = defineComponent(world, "position");
  for (let i = 0; i < 8; i++) {
    const eid = spawnEntity(world);
    setComponentValues(world, mass, eid, [eid * 1.5]);
    setComponentValues(world, position, eid, [i, -i]);
  }
  registerSystem(world, (current) => {
    const rows = current.rowsByComponentId.get(position);
    if (!rows) throw new Error("missing position rows");
    // Map insertion order is ascending-eid here, so prng draw order is stable.
    for (const values of rows.values()) {
      const x = values[0];
      const y = values[1];
      if (x === undefined || y === undefined) {
        throw new Error("position row missing components");
      }
      values[0] = x + current.prng.nextFloat() * 0.001;
      values[1] = y - current.prng.nextU32() / 0x100000000;
    }
  });
  return world;
}

describe("sim purity shims (SPEC §2.1/§7)", () => {
  it("arms Math.random as a thrower", () => {
    expect(() => Math.random()).toThrow(/sim purity violation: Math\.random/);
  });

  it("arms Date.now as a thrower", () => {
    expect(() => Date.now()).toThrow(/sim purity violation: Date\.now/);
  });

  it("runs 200 ticks of the deterministic core cleanly under the shims", () => {
    const world = buildDriftWorld(424242);
    const initial = computeWorldDigest(world);
    for (let t = 0; t < 200; t++) step(world);
    expect(world.tick).toBe(200);
    expect(computeWorldDigest(world)).not.toBe(initial);
  });

  it("surfaces violations coming from inside sim systems", () => {
    const world = buildDriftWorld(424242);
    let entered = false;
    registerSystem(world, () => {
      if (!entered) {
        entered = true;
        Math.random();
      }
    });
    expect(() => step(world)).toThrow(/purity violation: Math\.random/);
  });

  it("keeps digests stable across independent rebuilds", () => {
    const build = (): string => {
      const world = buildDriftWorld(99);
      step(world);
      step(world);
      return computeWorldDigest(world);
    };
    expect(build()).toBe(build());
  });
});

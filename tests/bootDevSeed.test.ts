import { describe, expect, it } from "vitest";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";
import { step } from "../src/sim/core/world";
import { createSkirmishWorld } from "../src/game/session";

/**
 * Boot regression: the browser's fixed dev seed must produce a
 * playable match — session bootstrap (town-center stamps on real
 * terrain) AND the first seconds of AI build-order drafting applied
 * through the inbox must never throw.
 */
describe("skirmish boot on the dev seed", () => {
  const DEV_SEED = 20260822;

  it("boots cleanly and steps 300 ticks without placement throws", () => {
    const session = createSkirmishWorld(DEV_SEED, {
      createTransport: createSynchronousPathTransport,
    });
    expect(() => {
      for (let i = 0; i < 300; i += 1) {
        step(session.world);
      }
    }).not.toThrow();
  });
});

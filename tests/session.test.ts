/**
 * Skirmish session lifecycle — M2-T10 game flow (issue #44).
 *
 * createSkirmishWorld is the ONE two-player bootstrap production and
 * tests share; restart-to-fresh-world re-runs it from a new seed. Pins:
 *
 *   - same seed ⇒ byte-identical tick-0 world (bootstrap determinism);
 *   - a fresh seed ⇒ a genuinely different world (restart is real);
 *   - both sides bootstrapped: ledgers for the victory evaluator, the
 *     mirrored AI base, five villagers per side;
 *   - the victory evaluator is on the roster: heartbeats land every 30
 *     ticks with no decision on an untouched world;
 *   - the seed handoff (stash → consume) fires exactly one restart and
 *     rejects junk; freshSeed avoids colliding with the outgoing seed.
 */
import { describe, expect, it } from "vitest";
import { computeWorldDigest, step } from "../src/sim/core/world";
import { populationOf } from "../src/sim/components";
import { AI_PLAYER } from "../src/sim/ai/bootstrap";
import { PLAYER_ONE } from "../src/sim/core/stockpile";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";
import {
  consumeNextSeed,
  createSkirmishWorld,
  freshSeed,
  stashNextSeed,
  type SeedStore,
} from "../src/game/session";
import {
  VICTORY_CHECK_CADENCE_TICKS,
  evaluateOutcome,
  victoryPlayerIds,
} from "../src/sim/systems/victory";
import {
  VICTORY_STATUS_ONGOING,
  readVictoryChecks,
} from "../src/sim/components/victory";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SYNC_TRANSPORT = createSynchronousPathTransport;

function mapFakeStore(): SeedStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

installSimPurityShims();

describe("createSkirmishWorld", () => {
  it("builds a byte-identical world from the same seed", () => {
    const a = createSkirmishWorld(20260902, {
      createTransport: SYNC_TRANSPORT,
    });
    const b = createSkirmishWorld(20260902, {
      createTransport: SYNC_TRANSPORT,
    });
    expect(computeWorldDigest(a.world)).toBe(computeWorldDigest(b.world));
    expect(a.world.entities.length).toBe(b.world.entities.length);
    expect(a.aiKnowledge.villagerEids().length).toBe(
      b.aiKnowledge.villagerEids().length,
    );
  });

  it("restarting from a fresh seed builds a genuinely different world", () => {
    const first = createSkirmishWorld(20260902, {
      createTransport: SYNC_TRANSPORT,
    });
    const second = createSkirmishWorld(
      freshSeed(20260902, () => 0.123456789),
      { createTransport: SYNC_TRANSPORT },
    );
    expect(second.seed).not.toBe(first.seed);
    expect(computeWorldDigest(second.world)).not.toBe(
      computeWorldDigest(first.world),
    );
  });

  it("bootstraps both sides through the shared victory roster", () => {
    const session = createSkirmishWorld(20260902, {
      createTransport: SYNC_TRANSPORT,
    });
    const { world, comps } = session;

    expect(victoryPlayerIds(world, comps)).toEqual([PLAYER_ONE, AI_PLAYER]);
    // Rowless M1 spawner units read as player zero; the AI carries
    // explicit Owner rows.
    expect(populationOf(world, comps, PLAYER_ONE)).toBe(5);
    expect(populationOf(world, comps, AI_PLAYER)).toBe(5);
    expect(session.aiKnowledge.villagerEids().length).toBe(5);
    expect(session.aiKnowledge.population()).toBe(5);

    // One heartbeat, no decision on an untouched world.
    step(world);
    while (world.tick < VICTORY_CHECK_CADENCE_TICKS) step(world);
    expect(evaluateOutcome(world, comps).decided).toBe(false);
    for (const playerId of [PLAYER_ONE, AI_PLAYER]) {
      const checks = readVictoryChecks(world, comps, playerId);
      expect(checks.length).toBe(1);
      expect(checks[0]?.status).toBe(VICTORY_STATUS_ONGOING);
      expect(checks[0]?.metric).toBe(0); // nobody built production yet
    }
  });
});

describe("restart seed handoff", () => {
  it("fires exactly one restart and clears itself", () => {
    const store = mapFakeStore();
    expect(consumeNextSeed(store)).toBeUndefined(); // nothing stashed

    stashNextSeed(store, 424242);
    expect(consumeNextSeed(store)).toBe(424242);
    expect(consumeNextSeed(store)).toBeUndefined(); // one-shot
  });

  it("rejects junk stashes instead of rebooting into them", () => {
    const store = mapFakeStore();
    store.setItem("ageofwind.nextSeed", "not-a-seed");
    expect(consumeNextSeed(store)).toBeUndefined();
    store.setItem("ageofwind.nextSeed", "-1");
    expect(consumeNextSeed(store)).toBeUndefined();
    store.setItem("ageofwind.nextSeed", String(0x100000000));
    expect(consumeNextSeed(store)).toBeUndefined();
  });

  it("freshSeed never returns the outgoing seed", () => {
    expect(freshSeed(0, () => 0)).not.toBe(0); // rng pinned at zero
    let flip = false;
    const previous = 7;
    const next = freshSeed(previous, () => {
      if (!flip) {
        flip = true;
        return previous / 0x100000000; // collides once…
      }
      return 0.5; // …then resolves deterministically
    });
    expect(next).not.toBe(previous);
    expect(Number.isInteger(next)).toBe(true);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThanOrEqual(0xffffffff);
  });
});

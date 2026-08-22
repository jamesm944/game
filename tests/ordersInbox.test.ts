/**
 * Order-pipeline → command-inbox integration tests — M1-T8 (SPEC
 * §2.1/§2.13).
 *
 * The UI's right-click move goes through `issueGroupMove` into the sim
 * CommandInbox; these tests prove the pipeline produces exactly the
 * inbox entries a replay expects: delivery on the EXACT target tick,
 * submission-order consumption within a tick, canonical (deduped,
 * ascending) payloads, and the late-command seal. A second scenario
 * drives real movement end-to-end through the synchronous path
 * transport, mirroring how golden fixtures will drive orders.
 *
 * Node-only by construction — no DOM, no jsdom anywhere.
 */
import { describe, expect, it } from "vitest";
import { defineMovementComponents, spawnUnit } from "../src/sim/components";
import type { SimCommand } from "../src/sim/core/inbox";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  createSynchronousPathTransport,
  PathScheduler,
} from "../src/sim/path/scheduler";
import {
  createMovementDiagnostics,
  createMovementSystem,
} from "../src/sim/systems/movement";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { formatMoveLabel, issueGroupMove } from "../src/ui/orders";

installSimPurityShims();

/** Register a system that only observes drained commands. */
function registerSpySystem(
  world: World,
  spy: (tick: number, commands: readonly SimCommand[]) => void,
): void {
  registerSystem(world, (current, commands) => {
    spy(current.tick, commands);
  });
}

function createTestWorld(
  terrainType: Uint8Array,
  size: number,
  pathScheduler?: PathScheduler,
): World {
  return createWorld(20260822, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler,
  });
}

function runTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(world);
}

describe("order pipeline → command inbox", () => {
  it("delivers groupMove commands exactly on their target ticks", () => {
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const size = 24;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const world = createTestWorld(terrainType, size, scheduler);

    const delivered: { tick: number; kind: string; seq: number }[] = [];
    let seq = 0;
    registerSpySystem(world, (tick, commands) => {
      for (const command of commands) {
        delivered.push({ tick, kind: command.kind, seq: seq++ });
      }
    });

    // The UI always targets "next tick" relative to issue time.
    expect(world.tick).toBe(0);
    const early = issueGroupMove(
      world.inbox,
      world.tick,
      [3, 1, 2],
      10.5,
      10.5,
    );
    expect(early.targetTick).toBe(1);

    // A later order issued after some steps lands on its own tick.
    runTicks(world, 2); // tick is now 2
    const later = issueGroupMove(world.inbox, world.tick, [5], 4.5, 4.5);
    expect(later.targetTick).toBe(3);

    runTicks(world, 6);

    expect(delivered).toEqual([
      { tick: 1, kind: "groupMove", seq: 0 },
      { tick: 3, kind: "groupMove", seq: 1 },
    ]);
    expect(world.inbox.size).toBe(0);
  });

  it("canonicalizes payloads: dedupe + ascending entityIds", () => {
    const size = 16;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const world = createTestWorld(terrainType, size);

    let captured: SimCommand | undefined;
    registerSpySystem(world, (_tick, commands) => {
      if (commands[0]) captured = commands[0];
    });
    issueGroupMove(world.inbox, world.tick, [7, 3, 7, 3, 5], 8.5, 8.5);
    step(world);

    expect(captured?.kind).toBe("groupMove");
    expect(captured?.data).toEqual({
      entityIds: [3, 5, 7],
      x: 8.5,
      y: 8.5,
    });
  });

  it("seals consumed ticks against late submissions", () => {
    const size = 16;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const world = createTestWorld(terrainType, size);
    runTicks(world, 4); // watermark now at tick 4

    // A stale UI issuing against an old cached tick must fail loudly —
    // silent acceptance would make replays irreproducible.
    expect(() => issueGroupMove(world.inbox, 3, [1], 8, 8)).toThrow(
      /late command/,
    );
    // Current-tick issue remains valid and consumes next step.
    expect(() =>
      issueGroupMove(world.inbox, world.tick, [1], 8, 8),
    ).not.toThrow();
  });

  it("rejects empty selections and non-finite destinations", () => {
    const size = 16;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const world = createTestWorld(terrainType, size);
    expect(() => issueGroupMove(world.inbox, world.tick, [], 1, 1)).toThrow(
      /at least one entity/,
    );
    expect(() =>
      issueGroupMove(world.inbox, world.tick, [1], Number.NaN, 1),
    ).toThrow(/finite/);
  });

  it("drives real movement end-to-end through the sync path transport", () => {
    const size = 32;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const paths = new PathScheduler(createSynchronousPathTransport());
    const world = createTestWorld(terrainType, size, paths);
    const comps = defineMovementComponents(world);
    const diagnostics = createMovementDiagnostics();
    registerSystem(world, createMovementSystem(comps, paths, diagnostics));

    spawnUnit(world, comps, 4.5, 4.5);
    spawnUnit(world, comps, 5.5, 4.5);
    spawnUnit(world, comps, 4.5, 5.5);

    // Exactly what wireOrderInput does on a right-click:
    issueGroupMove(world.inbox, world.tick, [1, 2, 3], 20.5, 20.5);

    runTicks(world, 900); // 30 s of sim time: ~22 tiles at the M1 1 tile/s cruise
    expect(diagnostics.groupMoves).toBe(1);

    const pos = (eid: number) => {
      const row = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      return { x: row![0]!, y: row![1]! };
    };
    for (const eid of [1, 2, 3]) {
      const p = pos(eid);
      const dx = p.x - 20.5;
      const dy = p.y - 20.5;
      // Formation slots keep members near the destination wedge.
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(2.5);
    }
  });

  it("formats log labels like the validated prototype panel", () => {
    expect(formatMoveLabel(12, 63.2, 48.9)).toBe("12 units → (63, 49)");
    expect(formatMoveLabel(1, 5, 6)).toBe("1 unit → (5, 6)");
  });
});

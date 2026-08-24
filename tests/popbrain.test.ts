/**
 * IAUS pop job brain — SPEC §2.3 / M3-T3 (issue #48).
 *
 * Pins the decision layer end to end:
 *   - newly spawned / unassigned named Pops self-assign through the
 *     shared command inbox within one staggered think interval;
 *   - the DFHack-style per-target cooldown prevents thrash: a second
 *     idle Pop cannot pile onto a freshly-cooled node and only picks
 *     it up after the window elapses;
 *   - player direct orders always win — an ordered Pop is invisible to
 *     the brain for as long as the order lives;
 *   - production slots are filled from affordable, staffed buildings;
 *   - the scorer is honest about its inputs: skill levels pull
 *     candidates (the skilled worker wins ties the novice loses).
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { getAssignedNode } from "../src/sim/components/economy";
import { spawnBuildingSite } from "../src/sim/components/buildings";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../src/sim/systems/gather";
import { createConstructionSystem } from "../src/sim/systems/construction";
import { createProductionSystem } from "../src/sim/systems/production";
import { createNeedsSystem } from "../src/sim/systems/needs";
import { grantKnowledge } from "../src/sim/systems/skills";
import {
  NODE_COOLDOWN_TICKS,
  THINK_INTERVAL_TICKS,
  createPopBrainDiagnostics,
  createPopBrainSystem,
} from "../src/sim/ai/popBrain";
import { jobCooldownReadyTickOf } from "../src/sim/components/jobCooldown";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 24;

interface BrainScenario {
  readonly world: ReturnType<typeof createWorld>;
  readonly comps: SimComponents;
  readonly brain: ReturnType<typeof createPopBrainDiagnostics>;
}

function openBrainWorld(seed: number): BrainScenario {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  const brain = createPopBrainDiagnostics();
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createGatherSystem(comps, scheduler));
  registerSystem(world, createConstructionSystem(comps));
  registerSystem(world, createProductionSystem(comps));
  registerSystem(world, createNeedsSystem(comps));
  registerSystem(
    world,
    createPopBrainSystem({ comps, players: [PLAYER_ONE], diagnostics: brain }),
  );
  createPlayerStockpile(world, comps, PLAYER_ONE, [100, 100, 50, 0, 0, 0, 0]);
  createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
  return { world, comps, brain };
}

/** First tick ≥ startTick where (tick + eid) % THINK hits zero. */
function nextThinkTick(eid: number, startTick: number): number {
  for (let tick = startTick + 1; ; tick++) {
    if ((tick + eid) % THINK_INTERVAL_TICKS === 0) return tick;
  }
}

installSimPurityShims();

describe("pop brain self-assignment", () => {
  it("a newly spawned villager gathers within one think interval", () => {
    const { world, comps, brain } = openBrainWorld(20260830);
    const nodeId = spawnResourceNode(world, comps, 12, 12, 1 /* wood */, 400);
    const eid = spawnUnit(world, comps, 10.5, 11.5, { identity: true });

    const thinkAt = nextThinkTick(eid, 0);
    while (world.tick < thinkAt + 1) step(world);

    // The brain spoke through the shared inbox; the gather system did
    // the employing on the very next boundary.
    expect(brain.gathers).toBe(1);
    expect(getAssignedNode(world, comps, eid)?.nodeEid).toBe(nodeId);
    // And the cooldown landed on the TARGET, digest-visible.
    expect(jobCooldownReadyTickOf(world, comps, nodeId)).toBe(
      thinkAt + NODE_COOLDOWN_TICKS,
    );
  });

  it("fills an affordable production slot at a finished kitchen", () => {
    const { world, comps, brain } = openBrainWorld(20260831);
    stampFinishedBuilding(world, comps, "kitchen", 14, 6, {
      playerId: PLAYER_ONE,
    });
    const eid = spawnUnit(world, comps, 12.5, 7.5, { identity: true });

    const thinkAt = nextThinkTick(eid, 0);
    while (world.tick < thinkAt + 1) step(world);

    expect(brain.produces).toBe(1);
    expect(world.rowsByComponentId.get(comps.productionJobId)?.has(eid)).toBe(
      true,
    );
  });

  it("staffs construction sites with build orders", () => {
    const { world, comps, brain } = openBrainWorld(20260901);
    // A player-order site exists but nobody is assigned yet.
    const siteEid = spawnBuildingSite(world, comps, "house", 16, 16, {
      playerId: PLAYER_ONE,
    });
    const eid = spawnUnit(world, comps, 15.5, 15.5, { identity: true });

    const thinkAt = nextThinkTick(eid, 0);
    while (world.tick < thinkAt + 1) step(world);

    expect(brain.builds).toBe(1);
    expect(world.rowsByComponentId.get(comps.assignedSiteId)?.has(eid)).toBe(
      true,
    );
    void siteEid;
  });
});

describe("cooldown anti-thrash", () => {
  it("blocks a second idle Pop until the target's cooldown elapses", () => {
    const { world, comps, brain } = openBrainWorld(20260902);
    // ONE node: after the first taker cools it, the runner-up must wait.
    const nodeId = spawnResourceNode(world, comps, 12, 12, 1, 400);
    const first = spawnUnit(world, comps, 11.5, 11.5, { identity: true });
    const second = spawnUnit(world, comps, 13.5, 11.5, { identity: true });

    const firstThink = Math.min(
      nextThinkTick(first, 0),
      nextThinkTick(second, 0),
    );
    const secondThink = Math.max(
      nextThinkTick(first, 0),
      nextThinkTick(second, 0),
    );

    // Both have thought by now; exactly one job may exist while the
    // node sits on cooldown.
    while (world.tick <= secondThink) step(world);
    expect(brain.gathers).toBe(1);
    expect(brain.cooldownSkips).toBeGreaterThanOrEqual(1);
    const employed =
      getAssignedNode(world, comps, first)?.nodeEid === nodeId ? first : second;
    const waiting = employed === first ? second : first;
    expect(getAssignedNode(world, comps, waiting)).toBeUndefined();

    // Still blocked deep into the window…
    while (world.tick < firstThink + NODE_COOLDOWN_TICKS - 1) step(world);
    expect(getAssignedNode(world, comps, waiting)).toBeUndefined();

    // …and employable the moment it lapses.
    while (
      world.tick <
      firstThink + NODE_COOLDOWN_TICKS + THINK_INTERVAL_TICKS + 1
    ) {
      step(world);
    }
    expect(getAssignedNode(world, comps, waiting)?.nodeEid).toBe(nodeId);
  }, 20_000);
});

describe("player orders always win", () => {
  it("never re-tasks a Pop carrying a live player order", () => {
    const { world, comps, brain } = openBrainWorld(20260903);
    const orderedNode = spawnResourceNode(world, comps, 18, 18, 1, 400);
    const otherNode = spawnResourceNode(world, comps, 6, 6, 1, 400);
    const eid = spawnUnit(world, comps, 17.5, 17.5, { identity: true });
    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [eid], nodeId: orderedNode },
    });

    while (world.tick < THINK_INTERVAL_TICKS * 4) step(world);

    // The order survives every staggered think untouched…
    expect(getAssignedNode(world, comps, eid)?.nodeEid).toBe(orderedNode);
    // …and the brain never even counted this Pop as idle.
    expect(brain.idleThinks).toBe(0);
    void otherNode;
  });
});

describe("scorer honesty", () => {
  it("a skilled worker outgathers a novice twin through brain assignment", () => {
    const runWithSkill = (knowledgeXp: number): number => {
      const scheduler = new PathScheduler(createSynchronousPathTransport());
      const world = createWorld(20260904, {
        size: SIZE,
        layers: buildLayers(
          new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
          new Uint8Array(SIZE * SIZE),
        ),
        pathScheduler: scheduler,
      });
      const comps = defineSimComponents(world);
      const brain = createPopBrainDiagnostics();
      const gather = createGatherDiagnostics();
      registerSystem(world, createMovementSystem(comps, scheduler));
      registerSystem(world, createGatherSystem(comps, scheduler, gather));
      registerSystem(world, createNeedsSystem(comps));
      registerSystem(
        world,
        createPopBrainSystem({
          comps,
          players: [PLAYER_ONE],
          diagnostics: brain,
        }),
      );
      createPlayerStockpile(
        world,
        comps,
        PLAYER_ONE,
        [100, 100, 50, 0, 0, 0, 0],
      );
      createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
      spawnResourceNode(world, comps, 12, 4, 1 /* wood */, 400);
      const eid = spawnUnit(world, comps, 12.5, 8.5, { identity: true });
      if (knowledgeXp > 0) {
        grantKnowledge(world, comps, eid, "gathering", knowledgeXp);
      }
      while (world.tick < 2600) step(world);
      // The brain employed this Pop on its own.
      expect(brain.gathers).toBe(1);
      return gather.extractedByResource[1]!;
    };

    // Level-5 theory (2500 XP ⇒ level 5) raises work speed ~30%: same
    // seed, same geometry, different utility-relevant skill sheet.
    const novice = runWithSkill(0);
    const skilled = runWithSkill(2500);
    expect(skilled).toBeGreaterThan(novice);
  }, 20_000);
});

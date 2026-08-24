/**
 * M3-T2 golden harness — SPEC §2.3 knowledge-vs-practice skills / issue #47.
 *
 * The learning-and-rusting arc: one named novice Pop (Identity/Traits/
 * Skills rows via the spawnUnit identity branch) gathers wood from a
 * large node, earning gathering practice XP on every extracted unit
 * (10 XP/unit) on top of 500 XP of granted theory — the knowledge
 * floor that must never rust. When the node depletes (~tick 7000) the
 * Pop idles and the rare-tick accumulator machine (grace one day, then
 * 100 practice XP shed every 8 idle rare-ticks per
 * docs/research/pop-sim-sources.md §7) drains every point of practice
 * back to the floor over the following simulated days.
 *
 * Pinned here:
 * - milestone digests every 30th tick plus final;
 * - the skill-sheet arc sampled at fixed ticks (learning climb, idle
 *   plateau inside grace, rust decay, exact knowledge-floor landing);
 * - the extended determinism canary (two identical runs agree
 *   byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readSkillEntries,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import { RESOURCE_WOOD } from "../../../src/sim/components/economy";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import {
  createSkillsSystem,
  grantKnowledge,
} from "../../../src/sim/systems/skills";
import { levelOfTotalXp } from "../../../src/sim/data/skills";

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly grantedKnowledgeXp: number;
  readonly nodeTile: readonly [number, number];
  readonly nodeAmount: number;
  readonly villagerSpawn: readonly [number, number];
  readonly dropOff: readonly [number, number];
  readonly gatherCommandTick: number;
  readonly arcSampleTicks: readonly number[];
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  const box = raw as Record<string, unknown>;
  const pair = (value: unknown): [number, number] => {
    const list = value as unknown[];
    return [Number(list[0]), Number(list[1])];
  };
  return {
    name: String(box.name),
    seed: Number(box.seed),
    size: Number(box.size),
    ticks: Number(box.ticks),
    milestoneEvery: Number(box.milestoneEvery),
    grantedKnowledgeXp: Number(box.grantedKnowledgeXp),
    nodeTile: pair(box.nodeTile),
    nodeAmount: Number(box.nodeAmount),
    villagerSpawn: pair(box.villagerSpawn),
    dropOff: pair(box.dropOff),
    gatherCommandTick: Number(box.gatherCommandTick),
    arcSampleTicks: (box.arcSampleTicks as number[]).map(Number),
  };
}

/** One pinned snapshot of the Pop's gathering skill sheet. */
interface SkillSample {
  readonly tick: number;
  /** Derived level of total XP at this tick. */
  readonly level: number;
  readonly knowledgeXp: number;
  readonly practiceXp: number;
  readonly rustAccumulator: number;
}

export interface ArcRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly skillArc: SkillSample[];
  readonly finalLevel: number;
  readonly extractedWood: number;
  readonly depositedWood: number;
}

function runScenario(fixture: GoldenCase): ArcRunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const diagnostics = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, diagnostics));
  // The rare-tick rust pass runs after the awarding systems.
  registerSystem(world, createSkillsSystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(
    world,
    comps,
    fixture.dropOff[0],
    fixture.dropOff[1],
    PLAYER_ONE,
  );
  const nodeId = spawnResourceNode(
    world,
    comps,
    fixture.nodeTile[0],
    fixture.nodeTile[1],
    RESOURCE_WOOD,
    fixture.nodeAmount,
  );
  // Named Pop ⇒ Identity + Traits + novice Skills rows attach here.
  const villagerEid = spawnUnit(
    world,
    comps,
    fixture.villagerSpawn[0],
    fixture.villagerSpawn[1],
    { identity: true },
  );
  // Permanent theory: the knowledge floor this arc must land on.
  grantKnowledge(
    world,
    comps,
    villagerEid,
    "gathering",
    fixture.grantedKnowledgeXp,
  );

  world.inbox.submit({
    kind: "gather",
    targetTick: fixture.gatherCommandTick,
    data: { entityIds: [villagerEid], nodeId },
  });

  const sampleTicks = new Set(fixture.arcSampleTicks);
  const digests: { tick: number; digest: string }[] = [];
  const skillArc: SkillSample[] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (sampleTicks.has(tick)) {
      const entry = readSkillEntries(world, comps, villagerEid)![0]!;
      const total = entry.knowledgeXp + entry.practiceXp;
      skillArc.push({
        tick,
        level: levelOfTotalXp(total),
        knowledgeXp: entry.knowledgeXp,
        practiceXp: entry.practiceXp,
        rustAccumulator: entry.rustAccumulator,
      });
    }
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const finalEntry = readSkillEntries(world, comps, villagerEid)![0]!;
  return {
    digests,
    skillArc,
    finalLevel: levelOfTotalXp(finalEntry.knowledgeXp + finalEntry.practiceXp),
    extractedWood: diagnostics.extractedByResource[RESOURCE_WOOD]!,
    depositedWood: diagnostics.depositedByResource[RESOURCE_WOOD]!,
  };
}

installSimPurityShims();

describe("golden harness m3t2", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks: number[] = [];
    for (
      let tick = fixture.milestoneEvery;
      tick <= fixture.ticks;
      tick += fixture.milestoneEvery
    ) {
      expectedTicks.push(tick);
    }
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("pins a learning-and-rusting arc landing exactly on the knowledge floor", () => {
    const run = runScenario(fixture);

    // Learning phase: practice climbs strictly across work samples and
    // crosses multiple level thresholds while the node lasts.
    const workSamples = run.skillArc.filter((s) => s.tick <= 7200);
    expect(workSamples.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < workSamples.length; i++) {
      expect(workSamples[i]!.practiceXp).toBeGreaterThan(
        workSamples[i - 1]!.practiceXp,
      );
    }
    expect(workSamples.at(-1)!.level).toBeGreaterThanOrEqual(3);

    // Knowledge NEVER moves: theory stays at the granted 500 forever.
    for (const sample of run.skillArc) {
      expect(sample.knowledgeXp).toBe(fixture.grantedKnowledgeXp);
    }

    // Rust phase: after the idle days every point of practice is gone
    // and the Pop lands exactly on its studied level (Novice).
    expect(run.finalLevel).toBe(1);
    const last = run.skillArc.at(-1)!;
    expect(last.tick).toBe(fixture.ticks);
    expect(last.practiceXp).toBe(0);
    expect(last.rustAccumulator).toBe(0);

    // The full pinned arc (levels + counters at each sample tick).
    expect(run.skillArc).toMatchSnapshot();

    // Conservation sanity for the work phase itself.
    expect(run.depositedWood).toBe(run.extractedWood);
    expect(run.extractedWood).toBeGreaterThan(150);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(100);
  });
});

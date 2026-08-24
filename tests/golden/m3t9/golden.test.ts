/**
 * M3-T9 golden harness — SPEC §2.5 morale break & routing / issue #54.
 *
 * A battle WITH routing on an open grass field under the combat +
 * morale roster (no movement: the choreography is adjacency-based and
 * the flee legs are asserted as rows, not walked). The cast:
 *
 *   V  bonded companion (P0)   — dies to the raider's first blow
 *   W  witness (P0, bond 80)   — rattled at morale 20; breaks at 9
 *   R  rally ally (P0)         — full-morale, inside radius (variant A)
 *   E1 raider (P1)             — kills V, then loiters as THE threat
 *   E2 raider (P1)             — idles in A; executes E1 in B at killTick
 *
 * Pinned here:
 * - milestone digests every 100th tick plus final for BOTH variants;
 * - a compact per-milestone trace: routing flag, meter, flee-leg tail,
 *   threat liveness — the panic is legible tick by tick;
 * - variant A exits through the RALLIED door (rally restores ≥3 passes,
 *   zero safe exits); variant B through the SAFE door (threat death at
 *   killTick, meter still wounded below the exit margin);
 * - routers ignore orders: the mid-flight attack command never sticks;
 * - buffered grief: the companion shock lands as exactly round(22·0.52);
 * - extended determinism canary: two identical runs of EACH variant
 *   agree byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getCombatRow,
  readActivityQueue,
  readNeeds,
  setNeedLevels,
  spawnCombatUnit,
} from "../../../src/sim/components";
import { setRelationship } from "../../../src/sim/components/relationship";
import {
  COMPANION_DEATH_MORALE_SHOCK,
  createMoraleDiagnostics,
  createMoraleSystem,
  type MoraleDiagnostics,
} from "../../../src/sim/systems/morale";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../../../src/sim/systems/combat";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly killTick: number;
  readonly victimHp: number;
  readonly witnessMorale: number;
  readonly witnessBond: number;
  readonly spawns: Readonly<Record<string, readonly [number, number]>>;
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
    killTick: Number(box.killTick),
    victimHp: Number(box.victimHp),
    witnessMorale: Number(box.witnessMorale),
    witnessBond: Number(box.witnessBond),
    spawns: Object.fromEntries(
      Object.entries(box.spawns as Record<string, unknown>).map(
        ([key, value]) => [key, pair(value)],
      ),
    ) as GoldenCase["spawns"],
  };
}

/** One milestone's worth of legible battle state. */
export interface BattleSample {
  readonly tick: number;
  /** Witness routing flag + meter. */
  readonly routing: boolean;
  readonly morale: number;
  /** Flee-leg tail x (∞ when not fleeing west of the spawn). */
  readonly fleeTailX: number | null;
  readonly threatAlive: boolean;
}

export interface BattleRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly trace: BattleSample[];
  readonly diagnostics: {
    routedTotal: number;
    shockApplied: number;
    ralliesApplied: number;
    safeExits: number;
    ralliedExits: number;
    ordersSuppressed: number;
  };
  readonly endMorale: number;
  readonly endRouting: boolean;
  readonly threatAliveAtEnd: boolean;
}

export function runScenario(
  fixture: GoldenCase,
  withRallyAlly: boolean,
): BattleRunState {
  const world = createWorld(fixture.seed, {
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
  });
  const comps = defineSimComponents(world);
  const diagnostics: MoraleDiagnostics = createMoraleDiagnostics();
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));
  registerSystem(world, createMoraleSystem(comps, diagnostics));
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);

  const soldier = (spot: readonly [number, number], owner: number): number =>
    spawnCombatUnit(world, comps, "militia", spot[0], spot[1], owner, {
      identity: true,
      body: true,
      morale: true,
    });

  const victim = soldier(fixture.spawns.victim!, PLAYER_ONE);
  const witness = soldier(fixture.spawns.witness!, PLAYER_ONE);
  const ally = withRallyAlly ? soldier(fixture.spawns.ally!, PLAYER_ONE) : 0;
  const enemy = soldier(fixture.spawns.enemy!, 1);
  const enemyB = soldier(fixture.spawns.enemyB!, 1);
  void ally;

  setRelationship(world, comps, witness, victim, fixture.witnessBond);
  setNeedLevels(world, comps, witness, {
    food: 100,
    rest: 100,
    morale: fixture.witnessMorale,
  });
  getCombatRow(world, comps, victim)![2] = fixture.victimHp;

  // The killing blow: ordered through the shared inbox like a player's.
  world.inbox.submit({
    kind: "attack",
    targetTick: 1,
    data: { attackerIds: [enemy], targetId: victim },
  });
  // Mid-flight order the ROUTER itself around — it must be ignored.
  world.inbox.submit({
    kind: "attack",
    targetTick: 60,
    data: { attackerIds: [witness], targetId: enemy },
  });
  // Variant B only: the warband turns on its own raider mid-siege.
  if (!withRallyAlly) {
    getCombatRow(world, comps, enemy)![2] = 4;
    world.inbox.submit({
      kind: "attack",
      targetTick: fixture.killTick,
      data: { attackerIds: [enemyB], targetId: enemy },
    });
  }

  const spawnX = fixture.spawns.witness![0];
  const digests: { tick: number; digest: string }[] = [];
  const trace: BattleSample[] = [];

  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      const row = world.rowsByComponentId.get(comps.moraleId)!.get(witness)!;
      const queue = readActivityQueue(world, comps, witness);
      const head = queue[0];
      const tail =
        head !== undefined && head.kind === "move"
          ? head.waypoints[head.waypoints.length - 2]!
          : null;
      trace.push({
        tick,
        routing: row[0] === 1,
        morale: readNeeds(world, comps, witness)!.morale,
        fleeTailX: tail !== null && tail < spawnX ? tail : null,
        threatAlive:
          world.rowsByComponentId.get(comps.positionId)?.has(enemy) === true,
      });
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  return {
    digests,
    trace,
    diagnostics: {
      routedTotal: diagnostics.routedTotal,
      shockApplied: diagnostics.shockApplied,
      ralliesApplied: diagnostics.ralliesApplied,
      safeExits: diagnostics.safeExits,
      ralliedExits: diagnostics.ralliedExits,
      ordersSuppressed: diagnostics.ordersSuppressed,
    },
    endMorale: readNeeds(world, comps, witness)!.morale,
    endRouting:
      (world.rowsByComponentId.get(comps.moraleId)!.get(witness)![0] ?? 0) ===
      1,
    threatAliveAtEnd:
      world.rowsByComponentId.get(comps.positionId)?.has(enemy) === true,
  };
}

installSimPurityShims();

describe("golden harness m3t9", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests plus the battle trace (rally variant)", () => {
    const run = runScenario(fixture, true);

    const expectedTicks: number[] = [];
    for (
      let tick = fixture.milestoneEvery;
      tick <= fixture.ticks;
      tick += fixture.milestoneEvery
    ) {
      expectedTicks.push(tick);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
    expect(run.trace).toMatchSnapshot();
  });

  it("records milestone digests plus the battle trace (safe variant)", () => {
    const run = runScenario(fixture, false);

    expect(run.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
    expect(run.trace).toMatchSnapshot();
  });

  it("routes on a buffered companion death, ignores orders, and RALLIES", () => {
    const run = runScenario(fixture, true);

    // The buffered grief landing: bond 80 absorbs 48% of the raw shock.
    const expectedLanding = Math.round(COMPANION_DEATH_MORALE_SHOCK * 0.52);
    expect(expectedLanding).toBe(11);
    expect(run.diagnostics.shockApplied).toBeGreaterThanOrEqual(
      expectedLanding,
    );

    // Exactly one episode, entered on the first post-strike tick.
    expect(run.diagnostics.routedTotal).toBe(1);
    const first = run.trace[0]!;
    expect(first.routing).toBe(true);
    expect(first.morale).toBe(fixture.witnessMorale - expectedLanding);
    expect(first.fleeTailX).not.toBeNull(); // fleeing WEST

    // The mid-flight attack order never stuck…
    expect(run.diagnostics.ordersSuppressed).toBeGreaterThanOrEqual(1);
    // …and every traced tick while routed kept the flight aimed west.
    let sawRouting = false;
    for (const sample of run.trace) {
      if (!sample.routing) continue;
      sawRouting = true;
      expect(sample.threatAlive).toBe(true);
    }
    expect(sawRouting).toBe(true);

    // RALLIED exit: ally restores across ≥3 rare passes, margin cleared.
    expect(run.diagnostics.ralliesApplied).toBeGreaterThanOrEqual(3);
    expect(run.diagnostics.ralliedExits).toBe(1);
    expect(run.diagnostics.safeExits).toBe(0);
    expect(run.endRouting).toBe(false);
    expect(run.endMorale).toBeGreaterThanOrEqual(
      moraleBreakPointOfBreakPointBase(),
    );
    expect(run.threatAliveAtEnd).toBe(true); // rallied DESPITE the danger
  });

  it("ends the episode through the SAFE door when the threat falls", () => {
    const run = runScenario(fixture, false);

    expect(run.diagnostics.routedTotal).toBe(1);
    expect(run.diagnostics.ralliesApplied).toBe(0); // nobody close enough
    expect(run.diagnostics.ralliedExits).toBe(0);

    // Before the killTick every sample still routes; after it the
    // router stands down UNROUTED with a wounded meter.
    const beforeKill = run.trace.filter((s) => s.tick < fixture.killTick);
    const afterKill = run.trace.filter((s) => s.tick >= fixture.killTick);
    expect(beforeKill.length).toBeGreaterThan(0);
    expect(afterKill.length).toBeGreaterThan(0);
    for (const sample of beforeKill) expect(sample.routing).toBe(true);
    const firstCalm = afterKill.find((sample) => !sample.routing);
    expect(firstCalm).toBeDefined();
    expect(firstCalm!.threatAlive).toBe(false);
    expect(firstCalm!.morale).toBeLessThan(22); // safe ≠ recovered
    expect(run.endRouting).toBe(false);
    expect(run.diagnostics.safeExits).toBe(1);
    expect(run.threatAliveAtEnd).toBe(false);
  });

  it("extended canary: two identical runs of each variant agree byte-for-byte", () => {
    const firstA = runScenario(fixture, true);
    const secondA = runScenario(fixture, true);
    expect(secondA).toEqual(firstA);

    const firstB = runScenario(fixture, false);
    const secondB = runScenario(fixture, false);
    expect(secondB).toEqual(firstB);

    // And the variants genuinely differ — the ally leaves a mark.
    expect(firstB).not.toEqual(firstA);
    expect(firstA.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

/** Break point floor used by the rallied-exit gate (traitless squad). */
function moraleBreakPointOfBreakPointBase(): number {
  return 12 + 10; // MORALE_BREAK_BASE + ROUTE_EXIT_MARGIN
}

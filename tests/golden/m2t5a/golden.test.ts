/**
 * M2-T5 golden harness A — SPEC §2.5 combat core / issue #39.
 *
 * The melee-duel fixture: two player-one militias attack-move across an
 * open all-grass field against mirrored idle player-two defenders.
 * Exercises the full engagement loop — attackMove acquisition inside
 * aggro range, pause-and-fight march semantics, approach legs, reload
 * cadence, auto-retaliation on first blood, death cleanup (entity rows
 * vanish, engagements purge, no orphan claims) — with milestone digests
 * every 30th tick plus final and a double-run determinism canary.
 *
 * Eid layout is part of the fixture contract: attackers 1–2 (owner
 * player 0), defenders 3–4 (owner player 1), ledger entities 5 (player
 * 0) and 6 (player 1). Commands reference those ids.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimCommand } from "../../../src/sim/core/inbox";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  defineSimComponents,
  getCombatRow,
  readActivityQueue,
  spawnCombatUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_UNIT_DEATH,
  readCombatEvents,
} from "../../../src/sim/components/combat";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../../../src/sim/systems/combat";

interface GoldenSpawn {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly spawns: readonly GoldenSpawn[];
  readonly commands: readonly SimCommand[];
}

function requiredNumber(value: unknown, where: string): number {
  if (typeof value !== "number") {
    throw new Error(`fixture ${where} must be a number`);
  }
  return value;
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;
  if (!Array.isArray(box.spawns) || box.spawns.length === 0) {
    throw new Error("fixture case.json: spawns must be a non-empty array");
  }
  const spawns = box.spawns.map((entry): GoldenSpawn => {
    const spawn = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(spawn.eid, "spawn.eid"),
      x: requiredNumber(spawn.x, "spawn.x"),
      y: requiredNumber(spawn.y, "spawn.y"),
    };
  });
  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all M2-T5 commands require data");
    }
    return {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    };
  });
  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    size: requiredNumber(box.size, "size"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    spawns,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

/** Plain-comparable final state so canaries deep-equal trivially. */
interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  readonly allOnPassableTiles: boolean;
  /** [eid, x, y] ascending eid over survivors only. */
  readonly survivorPositions: readonly (readonly [number, number, number])[];
  /** [eid, hp] ascending eid over survivors only. */
  readonly survivorHp: readonly (readonly [number, number])[];
  /** Combat rows whose targetEid references a dead or missing entity. */
  readonly danglingTargets: readonly number[];
  /** Attack activities still queued anywhere. */
  readonly queuedAttackActivities: number;
  readonly kills: number;
  readonly strikes: number;
  readonly retaliations: number;
  readonly aggroAcquisitions: number;
  readonly attackMovesCommanded: number;
  /** Per-owner event tallies [[damage, death] p0, [damage, death] p1]. */
  readonly eventTallies: readonly (readonly [number, number])[];
}

/** Open field: every tile grass ⇒ everything passable. */
function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

const PLAYER_TWO = 1;

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: openFieldLayers(fixture.size),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const diagnostics = createCombatDiagnostics();
  // Combat registers AFTER movement: strikes observe this tick's final
  // positions and queue writes survive movement's write-back window.
  registerSystem(world, createCombatSystem(comps, diagnostics));

  // Eid contract: combatants first (eids 1–2 owner 0, 3–4 owner 1),
  // then one ledger entity per player carrying Stockpile + CombatEvents
  // + ResearchedTechs rows.
  let owner = PLAYER_ONE;
  for (const spawn of fixture.spawns) {
    const eid = spawnCombatUnit(
      world,
      comps,
      "militia",
      spawn.x,
      spawn.y,
      owner,
    );
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
    if (eid === 2) owner = PLAYER_TWO; // defenders follow
  }
  createPlayerStockpile(world, comps, PLAYER_ONE); // eid 5
  createPlayerStockpile(world, comps, PLAYER_TWO); // eid 6

  for (const command of fixture.commands) world.inbox.submit(command);

  const digests: MilestoneDigest[] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const passability = world.layers.derivedPassability;
  const size = world.layers.size;
  let allOnPassableTiles = true;
  const survivorPositions: [number, number, number][] = [];
  const survivorHp: [number, number][] = [];
  for (const spawn of fixture.spawns) {
    const row = getCombatRow(world, comps, spawn.eid);
    if (!row) continue; // dead: asserted separately
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(spawn.eid);
    if (!pos) continue;
    survivorPositions.push([spawn.eid, pos[0]!, pos[1]!]);
    survivorHp.push([spawn.eid, row[2]!]);
    const tx = Math.floor(pos[0]!);
    const ty = Math.floor(pos[1]!);
    if (
      tx < 0 ||
      ty < 0 ||
      tx >= size ||
      ty >= size ||
      passability[ty * size + tx] !== 1
    ) {
      allOnPassableTiles = false;
    }
  }

  const liveSet = new Set(world.entities);
  const danglingTargets: number[] = [];
  let queuedAttackActivities = 0;
  for (const eid of world.entities) {
    const row = getCombatRow(world, comps, eid);
    if (!row) continue;
    if (row[3] !== 0 && !liveSet.has(row[3]!)) danglingTargets.push(eid);
    for (const activity of readActivityQueue(world, comps, eid)) {
      if (activity.kind === "attack") queuedAttackActivities += 1;
    }
  }

  const tally = (ownerId: number): [number, number] => {
    let damage = 0;
    let deaths = 0;
    for (const event of readCombatEvents(world, comps, ownerId)) {
      if (event.kind === COMBAT_EVENT_DAMAGE) damage += 1;
      // M2-T10: fallen UNITS ride the dedicated unit-death kind.
      if (event.kind === COMBAT_EVENT_UNIT_DEATH) deaths += 1;
    }
    return [damage, deaths];
  };

  return {
    digests,
    finalTick: world.tick,
    allOnPassableTiles,
    survivorPositions,
    survivorHp,
    danglingTargets,
    queuedAttackActivities,
    kills: diagnostics.kills,
    strikes: diagnostics.strikes,
    retaliations: diagnostics.retaliations,
    aggroAcquisitions: diagnostics.aggroAcquisitions,
    attackMovesCommanded: diagnostics.attackMoveCommands,
    eventTallies: [tally(PLAYER_ONE), tally(PLAYER_TWO)],
  };
}

installSimPurityShims();

describe("golden harness m2t5a", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("fights the duel to asymmetric mutual destruction", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.allOnPassableTiles).toBe(true);

    // Both marchers acquired their nearest enemy via aggro; both idle
    // defenders retaliated on first blood.
    expect(run.aggroAcquisitions).toBe(2);
    expect(run.retaliations).toBe(2);
    expect(run.attackMovesCommanded).toBe(2);

    // Ascending-eid strike order: each attacker lands blow 10 (the
    // kill) before the defender's tenth blow could land — 38 strikes,
    // 2 corpses, both survivors left at exactly 4 hp.
    expect(run.strikes).toBe(38);
    expect(run.kills).toBe(2);
    expect(run.survivorPositions.map(([eid]) => eid)).toEqual([1, 2]);
    expect(run.survivorHp).toEqual([
      [1, 4],
      [2, 4],
    ]);

    // Death cleanup: no dangling targets, no orphan Attack activities.
    expect(run.danglingTargets).toEqual([]);
    expect(run.queuedAttackActivities).toBe(0);

    // Event ledgers close: player one's attackers suffered 9 blows per
    // duel (18 damage events, no losses), player two's defenders took
    // 10 per duel (20) and both died there.
    expect(run.eventTallies).toEqual([
      [18, 0],
      [20, 2],
    ]);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(40);
  });
});

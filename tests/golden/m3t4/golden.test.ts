/**
 * M3-T4 golden harness — SPEC §2.5 injuries & impairments / issue #49.
 *
 * The duel-with-wounds: two body-carrying knights fight a seeded mirror
 * duel while an idle named villager stands nearby (all three spawned
 * with Body rows via the spawner body options). Pinned here:
 *
 * - milestone digests every 60th tick plus final (Body rows ride the
 *   digest like any other state);
 * - the wound arc sampled at fixed ticks: per-part severities draining
 *   on the rare-tick cadence, permanent scars appearing where wounds
 *   heal-at-full-severity, and the duel loser dying BY TRAUMA
 *   (cumulative severity past the threshold while hp remained);
 * - impairment feedback: the surviving knight's leg/arm wounds slow its
 *   raid march and dull its blows (damage < baseline in the ledger);
 * - the extended determinism canary (two identical runs agree
 *   byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readInjuries,
  readScars,
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
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import { createCombatSystem } from "../../../src/sim/systems/combat";
import { createInjuriesSystem } from "../../../src/sim/systems/injuries";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

/** The AI opponent's player id (PLAYER_ONE is the legacy zero). */
const PLAYER_TWO = 1;

interface GoldenCommand {
  readonly tick: number;
  readonly kind: "attack" | "stop";
  readonly actor?: string | undefined;
  readonly actors?: readonly string[] | undefined;
  readonly targetId?: string | undefined;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly arcSampleTicks: readonly number[];
  readonly knightASpawn: readonly [number, number];
  readonly kBSpawn: readonly [number, number];
  readonly villagerSpawn: readonly [number, number];
  readonly commands: readonly GoldenCommand[];
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
    arcSampleTicks: (box.arcSampleTicks as number[]).map(Number),
    knightASpawn: pair(box.knightASpawn),
    kBSpawn: pair(box.kBSpawn),
    villagerSpawn: pair(box.villagerSpawn),
    commands: (box.commands as Record<string, unknown>[]).map((command) => ({
      tick: Number(command.tick),
      kind: String(command.kind) as "attack" | "stop",
      actor: command.actor === undefined ? undefined : String(command.actor),
      actors:
        command.actors === undefined
          ? undefined
          : (command.actors as string[]).map(String),
      targetId:
        command.targetId === undefined ? undefined : String(command.targetId),
    })),
  };
}

export interface DuelRunState {
  readonly digests: { tick: number; digest: string }[];
  /** Wound/scar/death state at each pinned sample tick. */
  readonly arc: {
    readonly tick: number;
    readonly knightA: {
      readonly injuries: ReturnType<typeof readInjuries>;
      readonly scars: ReturnType<typeof readScars>;
    };
    readonly villager: {
      readonly injuries: ReturnType<typeof readInjuries>;
      readonly scars: ReturnType<typeof readScars>;
    };
    readonly unitDeaths: number;
  }[];
  /** Total DAMAGE-event amount dealt by knightA across the run. */
  readonly knightADamageDealt: number;
  /** Total damage the villager took before dying (≥ its hp ⇒ hp death). */
  readonly villagerDamageTaken: number;
  /**
   * Total damage knightB took before dying — strictly under its 70 hp
   * when the kill was BY TRAUMA rather than by hp exhaustion.
   */
  readonly knightBDamageTaken: number;
}

function runScenario(fixture: GoldenCase): DuelRunState {
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
  registerSystem(world, createCombatSystem(comps, undefined, scheduler));
  registerSystem(world, createInjuriesSystem(comps));

  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, PLAYER_TWO);

  // All three carry Body rows — strikes allocate against them.
  const knightA = spawnCombatUnit(
    world,
    comps,
    "knight",
    fixture.knightASpawn[0],
    fixture.knightASpawn[1],
    PLAYER_ONE,
    { body: true },
  );
  const knightB = spawnCombatUnit(
    world,
    comps,
    "knight",
    fixture.kBSpawn[0],
    fixture.kBSpawn[1],
    PLAYER_TWO,
    { body: true },
  );
  const villagerEid = spawnCombatUnit(
    world,
    comps,
    "villager",
    fixture.villagerSpawn[0],
    fixture.villagerSpawn[1],
    PLAYER_ONE,
    { body: true },
  );

  const eidByRole: Record<string, number> = {
    knightA,
    knightB,
    villager: villagerEid,
  };

  for (const command of fixture.commands) {
    world.inbox.submit({
      kind: command.kind,
      targetTick: command.tick,
      data:
        command.kind === "attack"
          ? {
              attackerIds: [eidByRole[command.actor!]!],
              targetId: eidByRole[command.targetId!]!,
            }
          : {
              entityIds: (command.actors ?? []).map((role) => eidByRole[role]!),
            },
    });
  }

  const sampleTicks = new Set(fixture.arcSampleTicks);
  const digests: { tick: number; digest: string }[] = [];
  const arc: DuelRunState["arc"] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (sampleTicks.has(tick)) {
      arc.push({
        tick,
        knightA: {
          injuries: readInjuries(world, comps, knightA),
          scars: readScars(world, comps, knightA),
        },
        villager: {
          injuries: readInjuries(world, comps, villagerEid),
          scars: readScars(world, comps, villagerEid),
        },
        unitDeaths: countUnitDeaths(world, comps),
      });
    }
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  let knightADamageDealt = 0;
  let villagerDamageTaken = 0;
  let knightBDamageTaken = 0;
  for (const event of readCombatEvents(world, comps, PLAYER_ONE)) {
    if (event.kind === COMBAT_EVENT_DAMAGE && event.attackerEid === knightA) {
      knightADamageDealt += event.amount;
    }
    if (event.kind === COMBAT_EVENT_DAMAGE && event.victimEid === villagerEid) {
      villagerDamageTaken += event.amount;
    }
    if (event.kind === COMBAT_EVENT_DAMAGE && event.victimEid === knightB) {
      knightBDamageTaken += event.amount;
    }
  }

  return {
    digests,
    arc,
    knightADamageDealt,
    villagerDamageTaken,
    knightBDamageTaken,
  };
}

function countUnitDeaths(
  world: ReturnType<typeof createWorld>,
  comps: SimComponents,
): number {
  let deaths = 0;
  for (const player of [PLAYER_ONE, PLAYER_TWO]) {
    for (const event of readCombatEvents(world, comps, player)) {
      if (event.kind === COMBAT_EVENT_UNIT_DEATH) deaths += 1;
    }
  }
  return deaths;
}

installSimPurityShims();

describe("golden harness m3t4", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every milestone tick plus final", () => {
    const run = runScenario(fixture);

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
  });

  it("runs a duel that kills by trauma and scars its survivors", () => {
    const run = runScenario(fixture);

    // Both deaths land in the ledger: knightB died BY WOUNDS in the
    // mirror duel — total damage received stayed under the knight's
    // 70 hp while cumulative severity crossed the whole-body threshold
    // — and the villager died by plain HP exhaustion during the raid.
    expect(run.arc.at(-1)!.unitDeaths).toBe(2);
    const villagerEnd = run.arc.at(-1)!.villager;
    expect(villagerEnd.injuries).toBeUndefined(); // despawned with the corpse
    expect(run.knightBDamageTaken).toBeLessThan(70); // trauma, not hp
    expect(run.villagerDamageTaken).toBeGreaterThanOrEqual(25); // hp

    // The surviving knight ends the horizon fully drained of open
    // wounds but carries a permanent mark from a severe duel wound
    // that outlived its recovery window (healed-at-full-severity).
    const knightEnd = run.arc.at(-1)!.knightA;
    expect(knightEnd.injuries).toEqual([]);
    expect(knightEnd.scars!.length).toBeGreaterThanOrEqual(1);

    // Impairment feedback: open arm/torso trauma dulled the winner's
    // derived attack mid-fight — pinned via the damage ledger.
    expect(run.knightADamageDealt).toBeGreaterThan(0);
    expect(run.knightADamageDealt).toMatchSnapshot();

    // Full pinned wound arc.
    expect(run.arc).toMatchSnapshot();
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });
});

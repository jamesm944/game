/**
 * M1-T2 golden harness — SPEC §7.
 *
 * Runs the m1t2 fixture scenario headlessly, records the SPEC §7 state
 * digest at every 30th tick plus final into a vitest snapshot, and runs
 * the whole thing twice as a determinism canary. Digests regenerate only
 * through `npm run golden:record` (vitest --update); hand-edited digests
 * fail every normal run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimCommand } from "../../../src/sim/core/inbox";
import {
  computeWorldDigest,
  createWorld,
  defineComponent,
  registerSystem,
  setComponentValues,
  spawnEntity,
  step,
} from "../../../src/sim/core/world";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

interface FixtureComponent {
  readonly name: string;
  readonly arity: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly entityCount: number;
  readonly components: readonly FixtureComponent[];
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

  if (!Array.isArray(box.components) || box.components.length === 0) {
    throw new Error("fixture case.json: components must be a non-empty array");
  }
  const components = box.components.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("fixture case.json: component entries must be objects");
    }
    const component = entry as Record<string, unknown>;
    return {
      name: String(component.name),
      arity: requiredNumber(component.arity, "component arity"),
    };
  });
  for (let i = 1; i < components.length; i++) {
    const previous = components[i - 1];
    const current = components[i];
    if (previous === undefined || current === undefined) {
      throw new Error("fixture case.json: component list mutated mid-read");
    }
    if (!(previous.name < current.name)) {
      throw new Error(
        `fixture case.json: components must be listed alphabetically (${previous.name} !< ${current.name})`,
      );
    }
  }

  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("fixture case.json: command entries must be objects");
    }
    const command = entry as Record<string, unknown>;
    const data =
      command.data === undefined
        ? undefined
        : (command.data as Readonly<Record<string, unknown>>);
    const spec: SimCommand = {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
    };
    if (data !== undefined) return { ...spec, data };
    return spec;
  });

  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    entityCount: requiredNumber(box.entityCount, "entityCount"),
    components,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

export interface ScenarioRun {
  readonly digests: readonly MilestoneDigest[];
  /** Ticks on which commands were actually consumed, in order. */
  readonly commandArrivals: readonly number[];
}

function runScenario(fixture: GoldenCase): ScenarioRun {
  const world = createWorld(fixture.seed);

  const componentIds = fixture.components.map((component) =>
    defineComponent(world, component.name),
  );
  const [massId, positionId] = componentIds;
  if (massId === undefined || positionId === undefined) {
    throw new Error("fixture requires at least two components");
  }

  for (let n = 0; n < fixture.entityCount; n++) {
    const eid = spawnEntity(world);
    setComponentValues(world, massId, eid, [1 + n * 0.25]);
    setComponentValues(world, positionId, eid, [
      (n % 5) * 2 + 0.5,
      Math.floor(n / 5) * 3 + 0.25,
    ]);
  }

  // Submission order is preserved by the inbox; consumption happens on
  // each command's absolute target tick only.
  for (const command of fixture.commands) world.inbox.submit(command);

  const commandArrivals: number[] = [];

  registerSystem(world, (current, commands) => {
    for (const command of commands) {
      if (command.kind !== "ping") {
        throw new Error(`fixture cannot handle command: ${command.kind}`);
      }
      const eid = requiredNumber(command.data?.eid, "ping.data.eid");
      const amount = requiredNumber(command.data?.amount, "ping.data.amount");
      const values = current.rowsByComponentId.get(massId)?.get(eid);
      if (!values) {
        throw new Error(`ping targets missing row mass:${String(eid)}`);
      }
      const currentMass = values[0];
      if (currentMass === undefined) {
        throw new Error("mass row missing value");
      }
      values[0] = currentMass + amount;
      commandArrivals.push(current.tick);
    }
  });

  registerSystem(world, (current) => {
    const rows = current.rowsByComponentId.get(positionId);
    if (!rows) throw new Error("missing position rows");
    for (const eid of current.entities) {
      const values = rows.get(eid);
      if (!values) continue;
      const x = values[0];
      const y = values[1];
      if (x === undefined || y === undefined) {
        throw new Error("position row missing components");
      }
      values[0] = x + (current.prng.nextU32() / 0x100000000 - 0.5) * 0.01;
      values[1] = y + (current.prng.nextFloat() - 0.5) * 0.01;
    }
  });

  const digests: MilestoneDigest[] = [];
  for (let t = 1; t <= fixture.ticks; t++) {
    step(world);
    if (t % fixture.milestoneEvery === 0 || t === fixture.ticks) {
      digests.push({ tick: t, digest: computeWorldDigest(world) });
    }
  }

  return { digests, commandArrivals };
}

installSimPurityShims();

describe("golden harness m1t2", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks)
      expectedTicks.push(fixture.ticks);

    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    expect(run.digests.at(-1)?.tick).toBe(fixture.ticks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    // State must actually evolve between milestones.
    expect(new Set(run.digests.map((entry) => entry.digest)).size).toBe(
      run.digests.length,
    );
  });

  it("consumes commands exactly on their absolute target ticks", () => {
    const run = runScenario(fixture);
    expect(run.commandArrivals).toEqual(
      fixture.commands.map((command) => command.targetTick),
    );
    expect(run.commandArrivals).toEqual([5, 30, 31]);
  });

  it("double-run canary: independent runs produce identical digests", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second.digests).toEqual(first.digests);
    expect(second.commandArrivals).toEqual(first.commandArrivals);
  });

  it("golden digests match the recorded fixture", () => {
    const run = runScenario(fixture);
    expect(run.digests).toMatchSnapshot();
  });
});

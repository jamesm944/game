/**
 * M1-T4 golden harness — SPEC §2.2/§7.
 *
 * Runs the sim-side movement scenario headlessly on the pinned 32×32
 * map (m1t3 seed bytes): two six-Pop groups receive groupMove orders at
 * fixed ticks, the SPEC §7 state digest is recorded at every 30th tick
 * plus final into a vitest snapshot, arrival positions are asserted
 * against the dealt formation slots, and the whole run executes twice
 * as an extended determinism canary.
 *
 * Since M1-T5 every search flows through the path scheduler, so the
 * scenario runs in BOTH transports: the zero-async synchronous fallback
 * and a scripted worker mock whose deliveries interleave out of order
 * across ticks and sometimes land LATE (exercising tick holding). The
 * two modes must produce byte-identical replays — the determinism
 * canary across the async boundary. Milestones regenerate only through
 * `npm run golden:record`; hand-edited digests fail every normal run.
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
  defineMovementComponents,
  getPosition,
  spawnUnit,
} from "../../../src/sim/components";
import { MockPathWorker } from "../../helpers/mock-path-worker";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import {
  createMovementDiagnostics,
  createMovementSystem,
  formationSlotOffset,
  type MovementDiagnostics,
} from "../../../src/sim/systems/movement";

interface GoldenSpawn {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenGroup {
  readonly entityIds: readonly number[];
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
  readonly groups: readonly GoldenGroup[];
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
    if (typeof entry !== "object" || entry === null) {
      throw new Error("fixture case.json: spawn entries must be objects");
    }
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
    if (typeof entry !== "object" || entry === null) {
      throw new Error("fixture case.json: command entries must be objects");
    }
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: groupMove commands require data");
    }
    return {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    };
  });

  if (!Array.isArray(box.groups)) {
    throw new Error("fixture case.json: groups must be an array");
  }
  const groups = box.groups.map((entry): GoldenGroup => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("fixture case.json: group entries must be objects");
    }
    const group = entry as Record<string, unknown>;
    if (!Array.isArray(group.entityIds)) {
      throw new Error("fixture case.json: group.entityIds must be an array");
    }
    return {
      entityIds: group.entityIds.map((id) =>
        requiredNumber(id, "group entityId"),
      ),
      x: requiredNumber(group.x, "group.x"),
      y: requiredNumber(group.y, "group.y"),
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
    groups,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

export interface ScenarioRun {
  readonly digests: readonly MilestoneDigest[];
  /** Final position per eid, ascending. */
  readonly positions: ReadonlyMap<number, { x: number; y: number }>;
  readonly diagnostics: MovementDiagnostics;
  /** True when every unit ends the run on a passable tile. */
  readonly allOnPassableTiles: boolean;
  /** Ticks held waiting on late path responses (worker-mock mode). */
  readonly blockedTicks: number;
  readonly finalTick: number;
}

/** Which transport feeds the scheduler for a scenario run. */
export type RunMode = "sync-fallback" | "worker-mock";

/**
 * Worker-mock delivery script: delay `d` per request id (cycling
 * 0,1,2,0,…). Delays 0/1 land within PATH_LATENCY; delay 2 is late and
 * makes step() hold ticks — replay-exactness must survive both.
 */
const MOCK_DELAY_SCRIPT = (requestId: number): number => (requestId - 1) % 3;

function buildScheduler(mode: RunMode): {
  scheduler: PathScheduler;
  advanceMock?: () => void;
} {
  if (mode === "sync-fallback") {
    return { scheduler: new PathScheduler(createSynchronousPathTransport()) };
  }
  const worker = new MockPathWorker(MOCK_DELAY_SCRIPT);
  return {
    scheduler: new PathScheduler(worker.transport),
    advanceMock: () => worker.advanceFrame(),
  };
}

/**
 * Mirror handleGroupMove's slot dealing exactly: members ascending-eid,
 * leader nearest the centroid (strict `<` keeps lowest eid on ties),
 * leader on slot 0, remaining Pops filling slots in ascending order.
 */
function expectedSlotPoints(
  fixture: GoldenCase,
): Map<number, { x: number; y: number }> {
  const spawnById = new Map(fixture.spawns.map((spawn) => [spawn.eid, spawn]));
  const expected = new Map<number, { x: number; y: number }>();
  for (const group of fixture.groups) {
    const members = group.entityIds.filter((eid) => spawnById.has(eid));
    let centroidX = 0;
    let centroidY = 0;
    for (const eid of members) {
      centroidX += spawnById.get(eid)!.x;
      centroidY += spawnById.get(eid)!.y;
    }
    centroidX /= members.length;
    centroidY /= members.length;
    let leader = members[0]!;
    let leaderDistanceSq = Infinity;
    for (const eid of members) {
      const dx = spawnById.get(eid)!.x - centroidX;
      const dy = spawnById.get(eid)!.y - centroidY;
      const d2 = dx * dx + dy * dy;
      if (d2 < leaderDistanceSq) {
        leaderDistanceSq = d2;
        leader = eid;
      }
    }
    const ordered = [leader, ...members.filter((eid) => eid !== leader)];
    ordered.forEach((eid, slotIndex) => {
      const offset = formationSlotOffset(slotIndex);
      expected.set(eid, { x: group.x + offset.dx, y: group.y + offset.dy });
    });
  }
  return expected;
}

function runScenario(fixture: GoldenCase, mode: RunMode): ScenarioRun {
  const { scheduler, advanceMock } = buildScheduler(mode);
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    pathScheduler: scheduler,
  });
  const comps = defineMovementComponents(world);
  const diagnostics = createMovementDiagnostics();
  registerSystem(world, createMovementSystem(comps, scheduler, diagnostics));

  for (const spawn of fixture.spawns) {
    const eid = spawnUnit(world, comps, spawn.x, spawn.y);
    if (eid !== spawn.eid) {
      throw new Error(
        `fixture spawn order mismatch: expected eid ${String(spawn.eid)}, allocated ${String(eid)}`,
      );
    }
  }

  for (const command of fixture.commands) world.inbox.submit(command);

  // Held ticks retry the same boundary next frame, so the loop runs
  // until the sim actually reaches the final tick; the cap only guards
  // against a transport that never answers.
  const digests: MilestoneDigest[] = [];
  let iterations = 0;
  const iterationCap = fixture.ticks * 20;
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    advanceMock?.();
    step(world);
    iterations += 1;
    if (iterations > iterationCap) {
      throw new Error(
        `scenario failed to reach tick ${String(fixture.ticks)} within ${String(iterationCap)} frames`,
      );
    }
    // Held ticks retry the same boundary and must not double-record.
    if (world.tick === before) continue;
    const t = world.tick;
    if (t % fixture.milestoneEvery === 0 || t === fixture.ticks) {
      digests.push({ tick: t, digest: computeWorldDigest(world) });
    }
  }

  const positions = new Map<number, { x: number; y: number }>();
  let allOnPassableTiles = true;
  const passability = world.layers.derivedPassability;
  const size = world.layers.size;
  for (const spawn of fixture.spawns) {
    const pos = getPosition(world, comps, spawn.eid);
    positions.set(spawn.eid, pos);
    const tx = Math.floor(pos.x);
    const ty = Math.floor(pos.y);
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

  return {
    digests,
    positions,
    diagnostics,
    allOnPassableTiles,
    blockedTicks: scheduler.blockedTicks,
    finalTick: world.tick,
  };
}

installSimPurityShims();

describe("golden harness m1t4", () => {
  const fixture = loadGoldenCase();
  // Arrival bound = FINAL_ARRIVAL_RADIUS (0.08) plus crowd settling:
  // latecomers queue behind already-Parked slot-mates instead of
  // shoving through them (Parked propagation halts there), and early
  // arrivers can be shouldered ~one slot spacing off their ring point.
  // Observed worst case ≈ 1.4 tiles.
  const ARRIVAL_TOLERANCE = 1.5;
  // Group-centroid accuracy stays tight: settling offsets average out,
  // so the formation as a whole must land on the ordered destination.
  const CENTROID_TOLERANCE = 0.6;

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture, "sync-fallback");

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks)
      expectedTicks.push(fixture.ticks);

    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("both groups arrive within tolerance of their dealt formation slots", () => {
    const run = runScenario(fixture, "sync-fallback");
    const expected = expectedSlotPoints(fixture);

    expect(run.diagnostics.groupMoves).toBe(fixture.groups.length);
    expect(run.allOnPassableTiles).toBe(true);

    // No interpenetration anywhere in the settled crowd.
    const eids = [...run.positions.keys()].sort((a, b) => a - b);
    for (let i = 0; i < eids.length; i++) {
      for (let j = i + 1; j < eids.length; j++) {
        const a = run.positions.get(eids[i]!)!;
        const b = run.positions.get(eids[j]!)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(0.45);
      }
    }
    // Every Pop settled onto (or directly behind) its dealt slot.
    for (const eid of eids) {
      const actual = run.positions.get(eid)!;
      const slot = expected.get(eid);
      expect(slot).toBeDefined();
      const dx = actual.x - slot!.x;
      const dy = actual.y - slot!.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      expect(
        distance,
        `eid ${eid} arrived ${distance.toFixed(3)} from its slot`,
      ).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
    }
    // Formation-level accuracy: each group's mean position lands on the
    // ordered destination.
    for (const group of fixture.groups) {
      let cx = 0;
      let cy = 0;
      for (const eid of group.entityIds) {
        const pos = run.positions.get(eid)!;
        cx += pos.x;
        cy += pos.y;
      }
      cx /= group.entityIds.length;
      cy /= group.entityIds.length;
      const dx = cx - group.x;
      const dy = cy - group.y;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(
        CENTROID_TOLERANCE,
      );
    }
  });

  it("extended double-run canary: identical digests, positions and diagnostics", () => {
    const first = runScenario(fixture, "sync-fallback");
    const second = runScenario(fixture, "sync-fallback");
    expect(second.digests).toEqual(first.digests);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect([...second.positions.entries()]).toEqual([
      ...first.positions.entries(),
    ]);
  });

  it("canary across the async boundary: worker-mock replays byte-identically to sync fallback", () => {
    // The scripted mock interleaves out-of-order deliveries and lands
    // some responses LATE (delay 2 > PATH_LATENCY−1), so the sim must
    // hold ticks; digests/positions/diagnostics still match the
    // synchronous fallback byte-for-byte (ADR-0003 blocking contract).
    const sync = runScenario(fixture, "sync-fallback");
    const mocked = runScenario(fixture, "worker-mock");

    expect(mocked.finalTick).toBe(sync.finalTick);
    expect(mocked.digests).toEqual(sync.digests);
    expect(mocked.diagnostics).toEqual(sync.diagnostics);
    expect([...mocked.positions.entries()]).toEqual([
      ...sync.positions.entries(),
    ]);
    expect(mocked.allOnPassableTiles).toBe(true);

    // The run genuinely exercised both async regimes.
    expect(sync.blockedTicks).toBe(0);
    expect(mocked.blockedTicks).toBeGreaterThan(0);
  });
});

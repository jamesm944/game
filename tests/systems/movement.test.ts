/**
 * Movement system tests — SPEC §2.2 / ADR-0003.
 *
 * Hand-authored 16×16 grids exercise: single-unit arrival, crowd
 * separation (no interpenetration), wall detours, the stalled →
 * sidestep → re-path ladder, and Parked propagation through contact.
 * Paths flow through the scheduler in its zero-async synchronous
 * fallback mode (byte-identical results to worker mode; see the m1t4
 * golden canary). Everything runs under the sim purity shims.
 */
import { describe, expect, it } from "vitest";
import { peekActivity, type Activity } from "../../src/sim/activities";
import {
  defineMovementComponents,
  getPosition,
  getVelocityRow,
  readActivityQueue,
  spawnUnit,
  DEFAULT_UNIT_RADIUS,
  type MovementComponents,
} from "../../src/sim/components";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import {
  createMovementDiagnostics,
  createMovementSystem,
  formationSlotOffset,
} from "../../src/sim/systems/movement";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../src/sim/core/world";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
} from "../../src/sim/world/layers";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const OPEN_16: readonly string[] = Array.from({ length: 16 }, () =>
  ".".repeat(16),
);

/** '#' tiles become water (impassable); everything else grass. */
function worldFromAscii(
  rows: readonly string[],
  seed: number,
  pathScheduler?: PathScheduler,
): World {
  const size = rows.length;
  if (rows.some((row) => row.length !== size))
    throw new Error("grid must be square");
  const terrainType = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      terrainType[y * size + x] =
        rows[y]![x] === "#" ? TERRAIN_WATER : TERRAIN_GRASS;
    }
  }
  return createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler,
  });
}

interface Harness {
  readonly world: World;
  readonly comps: MovementComponents;
  readonly diagnostics: ReturnType<typeof createMovementDiagnostics>;
}

function harness(rows: readonly string[], seed = 424242): Harness {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = worldFromAscii(rows, seed, paths);
  const comps = defineMovementComponents(world);
  const diagnostics = createMovementDiagnostics();
  registerSystem(world, createMovementSystem(comps, paths, diagnostics));
  return { world, comps, diagnostics };
}

function groupMove(
  world: World,
  entityIds: number[],
  x: number,
  y: number,
  targetTick = 1,
): void {
  world.inbox.submit({
    kind: "groupMove",
    targetTick,
    data: { entityIds, x, y },
  });
}

function runTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(world);
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

const V_PROPAGATION_PARKED = 7;

describe("movement system", () => {
  it("walks a single unit to its destination and stops", () => {
    const { world, comps } = harness(OPEN_16);
    spawnUnit(world, comps, 3.5, 3.5);
    groupMove(world, [1], 12.5, 8.5);

    let arrivedAt = -1;
    for (let t = 0; t < 900 && arrivedAt < 0; t++) {
      step(world);
      const pos = getPosition(world, comps, 1);
      if (distance(pos.x, pos.y, 12.5, 8.5) <= 0.35) arrivedAt = world.tick;
    }
    expect(arrivedAt).toBeGreaterThan(0);
    // 1 tile/s across ~10 tiles of path takes a believable number of ticks.
    expect(arrivedAt).toBeGreaterThan(150);
    expect(arrivedAt).toBeLessThan(900);
    // Let the final-arrival tolerance finish the activity off.
    runTicks(world, 60);
    const pos = getPosition(world, comps, 1);
    expect(distance(pos.x, pos.y, 12.5, 8.5)).toBeLessThanOrEqual(0.15);
    expect(peekActivity(readActivityQueue(world, comps, 1))).toBeUndefined();
  });

  it("keeps two grouped units separated — no interpenetration, slots reached", () => {
    const { world, comps } = harness(OPEN_16);
    spawnUnit(world, comps, 6.5, 6.5); // eid 1
    spawnUnit(world, comps, 8.0, 6.5); // eid 2
    // Leader (nearest the centroid) takes slot 0 at the destination; the
    // follower's ring slot comes from the shared formation LUT.
    const followerSlot = formationSlotOffset(1);

    groupMove(world, [1, 2], 13.5, 6.5);

    const radiusSum = 2 * DEFAULT_UNIT_RADIUS;
    let leaderArrived = false;
    let followerArrived = false;
    for (let t = 0; t < 1200 && !(leaderArrived && followerArrived); t++) {
      step(world);
      const a = getPosition(world, comps, 1);
      const b = getPosition(world, comps, 2);
      expect(distance(a.x, a.y, b.x, b.y)).toBeGreaterThanOrEqual(
        radiusSum - 0.02,
      );
      if (t % 25 === 0) {
        // Both stay inside the map bounds while travelling.
        expect(a.x).toBeLessThan(15.9);
        expect(b.x).toBeLessThan(15.9);
        expect(a.y).toBeGreaterThan(3.5);
        expect(b.y).toBeGreaterThan(3.5);
      }
      leaderArrived = distance(a.x, a.y, 13.5, 6.5) <= 0.4;
      followerArrived =
        distance(b.x, b.y, 13.5 + followerSlot.dx, 6.5 + followerSlot.dy) <=
        0.4;
    }
    expect(leaderArrived).toBe(true);
    expect(followerArrived).toBe(true);

    // Orders drained once both slots are reached.
    runTicks(world, 30);
    expect(peekActivity(readActivityQueue(world, comps, 1))).toBeUndefined();
    expect(peekActivity(readActivityQueue(world, comps, 2))).toBeUndefined();
  });

  it("detours around a wall through the gap without ever entering water", () => {
    // Column x=8 is water except a gap at rows 12–14.
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      rows.push(y >= 12 ? "................" : "........#.......");
    }
    const { world, comps } = harness(rows);
    spawnUnit(world, comps, 3.5, 7.5);
    groupMove(world, [1], 12.5, 7.5);

    let arrived = false;
    for (let t = 0; t < 2400 && !arrived; t++) {
      step(world);
      const pos = getPosition(world, comps, 1);
      const tx = Math.floor(pos.x);
      const ty = Math.floor(pos.y);
      expect(world.layers.derivedPassability[ty * 16 + tx]).toBe(1);
      if (Math.abs(pos.y - 7.5) <= 1.5 && pos.x >= 11.5) arrived = true;
    }
    expect(arrived).toBe(true);
  });

  it("stalled movers sidestep and re-path instead of shoving forever", () => {
    // One-tile-wide horizontal corridor with oversized bodies: two units
    // ordered to swap ends cannot physically pass, deadlock head-on,
    // trip the stall ladder (sidestep + re-path), and must never
    // interpenetrate or leave the corridor.
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      rows.push(y === 7 ? "................" : "#".repeat(16));
    }
    const { world, comps, diagnostics } = harness(rows);
    const fat = { radius: 0.55 };
    spawnUnit(world, comps, 2.5, 7.5, fat); // eid 1 → ordered east
    spawnUnit(world, comps, 11.5, 7.5, fat); // eid 2 → ordered west
    groupMove(world, [1], 11.5, 7.5);
    groupMove(world, [2], 2.5, 7.5, 2);

    let sawSidestep = false;
    for (let t = 0; t < 1800; t++) {
      step(world);
      if (diagnostics.sidesteps > 0) sawSidestep = true;
      const a = getPosition(world, comps, 1);
      const b = getPosition(world, comps, 2);
      expect(distance(a.x, a.y, b.x, b.y)).toBeGreaterThanOrEqual(1.1 - 0.02);
      expect(Math.floor(a.y)).toBe(7);
      expect(Math.floor(b.y)).toBe(7);
    }
    expect(sawSidestep).toBe(true);
    expect(diagnostics.repaths).toBeGreaterThanOrEqual(1);
  });

  it("propagates Parked backward through contact so columns halt cleanly", () => {
    // Open corridor with an idle blocker mid-way: the mover stalls
    // against it and transitions to propagated-Parked (~0.7 s), keeping
    // its Move activity queued but its speed pinned at zero.
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      rows.push(y === 7 ? "................" : "#".repeat(16));
    }
    const { world, comps } = harness(rows);
    const fat = { radius: 0.55 };
    const blockerEid = spawnUnit(world, comps, 8.5, 7.5, fat); // eid 1, no orders
    const moverEid = spawnUnit(world, comps, 2.5, 7.5, fat); // eid 2
    groupMove(world, [moverEid], 13.5, 7.5);

    let sawPropagatedParked = false;
    for (let t = 0; t < 900 && !sawPropagatedParked; t++) {
      step(world);
      const velRow = getVelocityRow(world, comps, moverEid);
      if (velRow[V_PROPAGATION_PARKED] === 1) {
        sawPropagatedParked = true;
        expect(velRow[1]).toBe(0); // speed pinned while halted
        expect(getVelocityRow(world, comps, blockerEid)[1]).toBe(0);
      }
    }
    expect(sawPropagatedParked).toBe(true);
    // The Move order survives the halt (it resumes when unblocked).
    const queue: Activity[] = readActivityQueue(world, comps, moverEid);
    expect(queue[0]?.kind).toBe("move");
  });
});

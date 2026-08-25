/**
 * M5-T5 balance pass — equal-cost engagement matrix (issue #67).
 *
 * SPEC §2.5 makes counters DATA: attack-bonus multipliers over canonical
 * armor classes, with the documented emergent triangle
 * (CONTEXT.md "Counter triangle"): infantry → archer → cavalry →
 * infantry, plus the skirmisher's anti-archer support role. This suite
 * asks the only question balance can answer headlessly: with EQUAL
 * RESOURCE VALUE on both sides, does the counted-against side actually
 * win its favorable matchups?
 *
 * Method: scripted N-vs-N duels between every military unit pair
 * (archer/knight/militia/scout-cavalry/skirmisher) on an open grass
 * field, both sides attack-moving toward each other through the real
 * command surface (movement + combat systems, synchronous path
 * transport). Pair sizes solve `nA·costA ≈ nB·costB` exactly where the
 * integers allow (≤8% drift otherwise), so "equal cost" means resource
 * parity, not headcount parity.
 *
 * Gates (mirrors issue #67's acceptance criteria):
 *   1. every declared favorable matchup is WON by its favored side on
 *      every pinned seed — no counter entry may be nominal;
 *   2. no composition beats everything — every unit loses at least one
 *      favorable matchup (the table covers each unit as a loser);
 *   3. no matchup is unwinnable — every unit wins at least one
 *      favorable matchup (each unit appears as a winner too);
 *   4. even matchups still RESOLVE (one army eliminated inside the tick
 *      cap) with clean death cleanup, and identical seeds replay
 *      byte-identically (determinism canary).
 *
 * Headless, parameterized, deterministic: fixed seeds, no clocks, no
 * randomness reachable from the sim (purity shims installed).
 */

import { describe, expect, it } from "vitest";
import { unitDefOf } from "../../src/data/definitions";
import {
  defineSimComponents,
  getCombatRow,
  type SimComponents,
} from "../../src/sim/components";
import { spawnCombatUnit } from "../../src/sim/components/combat";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { installSimPurityShims } from "../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../src/sim/world/layers";
import { createMovementSystem } from "../../src/sim/systems/movement";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../../src/sim/systems/combat";

installSimPurityShims();

/** The five military units in scope for the §2.5 matrix (issue #67). */
const MILITARY_IDS = [
  "archer",
  "knight",
  "militia",
  "scout-cavalry",
  "skirmisher",
] as const;

type MilitaryId = (typeof MILITARY_IDS)[number];

/** Pinned deterministic seeds — favored sides must hold on EVERY one. */
const SEEDS = [20260901, 20260902, 20260903] as const;

const FIELD_SIZE = 36;
/** Any duel exceeding this many ticks without a verdict is degenerate. */
const ENGAGEMENT_TICK_CAP = 6000;

// ---- The counter table under test ------------------------------------------
//
// Each row: [favored, counted-against]. Sources:
//   - CONTEXT.md "Counter triangle": infantry → archer → cavalry →
//     infantry;
//   - SPEC §2.5 / AoE2 support roles: skirmisher hard-counters the
//     archer class (its ×3 bonus), cavalry hunts ranged support.
const FAVORABLE_MATCHUPS: readonly (readonly [MilitaryId, MilitaryId])[] = [
  ["militia", "archer"], // infantry → archer (triangle)
  ["militia", "skirmisher"], // infantry punishes light ranged support
  ["archer", "knight"], // archer → cavalry (triangle)
  ["archer", "scout-cavalry"], // archer → cavalry (triangle)
  ["skirmisher", "archer"], // anti-archer support (AoE2 skirms)
  ["knight", "militia"], // cavalry → infantry (triangle)
  ["knight", "skirmisher"], // cavalry hunts ranged support
  ["knight", "scout-cavalry"], // heavy horse beats scouts
  ["scout-cavalry", "skirmisher"], // scouts hunt ranged support (AoE2)
];

// ---- Equal-value pairing -----------------------------------------------------

/** Total resource cost of one unit across all gatherables. */
function unitCostOf(defId: string): number {
  const costs = unitDefOf(defId).costs;
  let total = 0;
  for (const amount of Object.values(costs)) total += amount;
  if (total <= 0) throw new Error(`${defId} has no resource cost`);
  return total;
}

export interface EqualValuePair {
  readonly countA: number;
  readonly countB: number;
  /** |valueA − valueB| relative to the cheaper army (≤ 0.08 by search). */
  readonly relativeError: number;
}

/**
 * Integer pair (nA, nB) with nA·costA ≈ nB·costB: scan candidate counts
 * 4–12 per side, keep the smallest relative error, ties broken toward
 * the larger total army then the smaller first count — fully
 * deterministic, no randomness.
 */
function equalValuePair(costA: number, costB: number): EqualValuePair {
  let best: EqualValuePair | undefined;
  for (let countA = 4; countA <= 12; countA++) {
    const countB = Math.round((countA * costA) / costB);
    if (countB < 4 || countB > 12) continue;
    const valueA = countA * costA;
    const valueB = countB * costB;
    const relativeError = Math.abs(valueA - valueB) / Math.min(valueA, valueB);
    if (relativeError > 0.08) continue;
    const better =
      best === undefined ||
      relativeError < best.relativeError ||
      (relativeError === best.relativeError &&
        (countA + countB > best.countA + best.countB ||
          (countA + countB === best.countA + best.countB &&
            countA < best.countA)));
    if (better) best = { countA, countB, relativeError };
  }
  if (best === undefined) {
    throw new Error(
      `no near-equal pairing for ${String(costA)} vs ${String(costB)}`,
    );
  }
  return best;
}

// ---- Duel harness -------------------------------------------------------------

interface DuelResult {
  readonly aliveA: number;
  readonly aliveB: number;
  readonly ticks: number;
}

function openFieldWorld(seed: number): {
  world: World;
  comps: SimComponents;
} {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: FIELD_SIZE,
    layers: buildLayers(
      new Uint8Array(FIELD_SIZE * FIELD_SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(FIELD_SIZE * FIELD_SIZE),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  // Combat registers AFTER movement: strikes observe final positions
  // (same order contract as the m2t5a golden fixture).
  registerSystem(world, createCombatSystem(comps, createCombatDiagnostics()));
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createPlayerStockpile(world, comps, 1);
  return { world, comps };
}

/** Deterministic concentric-ring placement around an anchor tile. */
function spawnRinged(
  world: World,
  comps: SimComponents,
  anchorX: number,
  anchorY: number,
  count: number,
  defId: string,
  playerId: number,
): number[] {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  const eids: number[] = [];
  let placed = 0;
  for (let ring = 0; placed < count && ring < 8; ring++) {
    for (let dy = -ring; dy <= ring && placed < count; dy++) {
      for (let dx = -ring; dx <= ring && placed < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = anchorX + dx;
        const y = anchorY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (passability[y * size + x] !== 1) continue;
        eids.push(
          spawnCombatUnit(world, comps, defId, x + 0.5, y + 0.5, playerId),
        );
        placed += 1;
      }
    }
  }
  if (placed < count) {
    throw new Error(
      `engagement matrix could only place ${String(placed)}/${String(count)} ${defId}s`,
    );
  }
  return eids;
}

function livingCount(
  world: World,
  comps: SimComponents,
  eids: readonly number[],
): number {
  let alive = 0;
  for (const eid of eids) {
    if (getCombatRow(world, comps, eid) !== undefined) alive += 1;
  }
  return alive;
}

/** Re-aim cadence keeping duels converged (budget-scenario idiom). */
const REISSUE_TICKS = 60;

function centroidOf(
  world: World,
  comps: SimComponents,
  eids: readonly number[],
): { x: number; y: number } | undefined {
  let sumX = 0;
  let sumY = 0;
  let live = 0;
  for (const eid of eids) {
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    sumX += pos[0]!;
    sumY += pos[1]!;
    live += 1;
  }
  return live === 0 ? undefined : { x: sumX / live, y: sumY / live };
}

/**
 * One scripted duel: both armies attack-move toward the opposing army,
 * re-aimed at the living enemy centroid every REISSUE_TICKS so the
 * fight converges to elimination instead of outliving its march order
 * (attack-marches that reach their destination stand down by design).
 */
function runDuel(
  seed: number,
  defA: MilitaryId,
  countA: number,
  defB: MilitaryId,
  countB: number,
): DuelResult {
  const { world, comps } = openFieldWorld(seed);
  const armyA = spawnRinged(world, comps, 6, 18, countA, defA, PLAYER_ONE);
  const armyB = spawnRinged(world, comps, 29, 18, countB, defB, 1);

  const reaim = (): void => {
    const targetB = centroidOf(world, comps, armyB);
    if (targetB !== undefined) {
      world.inbox.submit({
        kind: "attackMove",
        targetTick: world.tick + 1,
        data: { ids: [...armyA], x: targetB.x, y: targetB.y },
      });
    }
    const targetA = centroidOf(world, comps, armyA);
    if (targetA !== undefined) {
      world.inbox.submit({
        kind: "attackMove",
        targetTick: world.tick + 1,
        data: { ids: [...armyB], x: targetA.x, y: targetA.y },
      });
    }
  };
  reaim();

  while (world.tick < ENGAGEMENT_TICK_CAP) {
    if (world.tick % REISSUE_TICKS === 0) {
      if (
        livingCount(world, comps, armyA) === 0 ||
        livingCount(world, comps, armyB) === 0
      ) {
        break;
      }
      reaim();
    }
    step(world);
  }

  return {
    aliveA: livingCount(world, comps, armyA),
    aliveB: livingCount(world, comps, armyB),
    ticks: world.tick,
  };
}

// ---- Suites --------------------------------------------------------------------

describe("equal-cost engagement matrix (SPEC §2.5, issue #67)", () => {
  it("pairs armies at equal resource value (documented pairing table)", () => {
    for (const a of MILITARY_IDS) {
      for (const b of MILITARY_IDS) {
        if (a >= b) continue; // unordered pairs only
        const pair = equalValuePair(unitCostOf(a), unitCostOf(b));
        expect(pair.relativeError).toBeLessThanOrEqual(0.08);
        expect(pair.countA).toBeGreaterThanOrEqual(4);
        expect(pair.countB).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("wins every favorable matchup for the counted-against side, on every seed", () => {
    for (const [favored, target] of FAVORABLE_MATCHUPS) {
      const pair = equalValuePair(unitCostOf(favored), unitCostOf(target));
      for (const seed of SEEDS) {
        const result = runDuel(seed, favored, pair.countA, target, pair.countB);
        expect(result.aliveA).toBeGreaterThan(0);
        expect(result.aliveB).toBe(0);
      }
    }
  });

  it("has no composition that beats everything (every unit loses somewhere)", () => {
    const losers = new Set(FAVORABLE_MATCHUPS.map(([, against]) => against));
    for (const id of MILITARY_IDS) {
      expect(losers.has(id)).toBe(true);
    }
  });

  it("has no unwinnable book (every unit wins somewhere)", () => {
    const winners = new Set(FAVORABLE_MATCHUPS.map(([favored]) => favored));
    for (const id of MILITARY_IDS) {
      expect(winners.has(id)).toBe(true);
    }
  });

  it("resolves even matchups cleanly and replays identically (determinism canary)", () => {
    // Mirror match: symmetric armies, ascending-eid strike order gives
    // player one the edge — assert only resolution + cleanup symmetry.
    const mirrorPair = equalValuePair(
      unitCostOf("militia"),
      unitCostOf("militia"),
    );
    const first = runDuel(
      SEEDS[0],
      "militia",
      mirrorPair.countA,
      "militia",
      mirrorPair.countB,
    );
    const second = runDuel(
      SEEDS[0],
      "militia",
      mirrorPair.countA,
      "militia",
      mirrorPair.countB,
    );
    expect(second).toEqual(first);
    expect(first.ticks).toBeLessThan(ENGAGEMENT_TICK_CAP);
    expect(Math.min(first.aliveA, first.aliveB)).toBe(0);

    // An unlisted even pairing must also reach a verdict inside the cap.
    const scoutMirror = equalValuePair(
      unitCostOf("scout-cavalry"),
      unitCostOf("archer"),
    );
    const resolved = runDuel(
      SEEDS[1],
      "scout-cavalry",
      scoutMirror.countA,
      "archer",
      scoutMirror.countB,
    );
    expect(resolved.ticks).toBeLessThan(ENGAGEMENT_TICK_CAP);
    expect(Math.min(resolved.aliveA, resolved.aliveB)).toBe(0);
  });
});

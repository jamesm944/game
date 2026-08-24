/**
 * M2 sign-off budget scenario — SPEC §7 / M2-T11 (issue #45).
 *
 * The M1 canonical workload (300 villagers on a full gather+move loop)
 * escalated to the M2 envelope: COMBAT and REAL FOG OF WAR active at
 * the same time, on the shared production skirmish bootstrap
 * (createSkirmishWorld — full system roster, KnowledgeView-gated AI
 * planner, victory evaluator, per-player fog planes):
 *
 *   - 300 villagers (5 start + 295 scenario spawns) chopping deep-
 *     reserve wood nodes round-robin near the human base — the M1
 *     economy load, unchanged;
 *   - 100 knights PER SIDE spawned beside each town, re-ordered every
 *     REISSUE_TICKS to attack-march the opposing army centroid — a
 *     sustained melee with counter-table strikes, deaths, repath
 *     churn and sight-plane stamping for ~500 total contributors;
 *   - real fog: every spawn/move/death rides the dirty queue into
 *     un-stamp + re-stamp cycles (the T8 gate covered this in
 *     isolation; here it shares the tick with everything else).
 *
 * Warm-up absorbs JIT + the initial path storm; MEASURED_TICKS feed
 * mean/p95/max; mirror snapshot copy is best-of-seven. Draw calls stay
 * a static composition approximation (GL context needed otherwise).
 */

import {
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../src/sim/components";
import { spawnCombatUnit } from "../../src/sim/components/combat";
import { RESOURCE_WOOD } from "../../src/sim/components/economy";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { step, type World } from "../../src/sim/core/world";
import { AI_PLAYER } from "../../src/sim/ai/bootstrap";
import { createSkirmishWorld } from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import { captureSimSnapshot } from "../../src/sim/mirror";
import { approximateDrawCalls } from "./budget-scenario";

/** Scenario scale (§7 envelope floor: 500 Pops @30 Hz). */
export const VILLAGER_COUNT = 300;
export const KNIGHTS_PER_SIDE = 100;
export const EXTRA_NODE_COUNT = 40;
export const WARMUP_TICKS = 120;
export const MEASURED_TICKS = 300;
/** Attack-move re-issue cadence keeping the melee sustained. */
export const REISSUE_TICKS = 45;

export interface BudgetM2RunResult {
  readonly villagerCount: number;
  readonly knightsPerSide: number;
  readonly measuredTicks: number;
  readonly meanTickMs: number;
  readonly p95TickMs: number;
  readonly maxTickMs: number;
  readonly mirrorCopyMs: number;
  readonly drawCallApprox: number;
  /** Knights still alive per side when measurement ended. */
  readonly survivorsPerSide: readonly [number, number];
}

/**
 * Spawn `count` units ringed outward around an anchor on passable
 * tiles, starting at `minRing` so separate populations don't stack;
 * deterministic ring scan (same idiom as the M1 helper).
 */
function spawnRinged(
  world: World,
  comps: SimComponents,
  anchorX: number,
  anchorY: number,
  count: number,
  minRing: number,
  spawn: (x: number, y: number) => void,
): void {
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  // Anchors may be footprint centers (half-tile floats) — tile math
  // needs the integer corner.
  const baseX = Math.floor(anchorX);
  const baseY = Math.floor(anchorY);
  let placed = 0;
  for (let ring = minRing; placed < count && ring < 40; ring++) {
    for (let dy = -ring; dy <= ring && placed < count; dy++) {
      for (let dx = -ring; dx <= ring && placed < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = baseX + dx;
        const y = baseY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (passability[y * size + x] !== 1) continue;
        spawn(x + 0.5, y + 0.5);
        placed += 1;
      }
    }
  }
  if (placed < count) {
    throw new Error(
      `budget-m2 could only place ${String(placed)}/${String(count)} units`,
    );
  }
}

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
    if (!pos) continue; // dead since the roster was taken
    sumX += pos[0]!;
    sumY += pos[1]!;
    live += 1;
  }
  return live === 0 ? undefined : { x: sumX / live, y: sumY / live };
}

/** Run the full M2 workload and return its measured telemetry. */
export function runBudgetScenarioM2(): BudgetM2RunResult {
  // Session-tested seed: hosted map (no center water) with both bases.
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
  });
  const { world, comps } = session;

  // Scenario capital so the AI planner runs its real FC ladder while we
  // measure (its drafts flow through the same inbox under load).
  const capital = [6000, 6000, 2000, 0, 0, 0, 0];
  for (const ledger of world.rowsByComponentId
    .get(comps.stockpileId)!
    .values()) {
    for (let code = 0; code < capital.length; code++) {
      ledger[code + 1] = capital[code]!;
    }
  }

  const playerTown = finishedTownAnchor(world, comps, PLAYER_ONE);
  const aiTown = finishedTownAnchor(world, comps, AI_PLAYER);

  // ---- Economy load: 295 extra villagers around the human town.
  const extraNodes = scatterResourceNodes(world.layers, 0x1234abcd, {
    count: EXTRA_NODE_COUNT,
    minSpacing: 3,
  }).filter((node) => {
    const size = world.layers.size;
    if (world.layers.derivedPassability[node.tileY * size + node.tileX] !== 1)
      return false;
    return (
      Math.max(
        Math.abs(node.tileX - Math.floor(playerTown.x)),
        Math.abs(node.tileY - Math.floor(playerTown.y)),
      ) > 6
    );
  });
  if (extraNodes.length < EXTRA_NODE_COUNT / 2) {
    throw new Error("budget-m2 needs at least 20 scatterable wood nodes");
  }
  const nodeIds = extraNodes.map((node) =>
    spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      RESOURCE_WOOD,
      node.amount * 40,
    ),
  );
  const villagerIds: number[] = [];
  spawnRinged(
    world,
    comps,
    playerTown.x,
    playerTown.y,
    VILLAGER_COUNT,
    2,
    (x, y) => {
      villagerIds.push(spawnUnit(world, comps, x, y));
    },
  );
  const chunkSize = 10;
  for (let first = 0; first < VILLAGER_COUNT; first += chunkSize) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: {
        entityIds: villagerIds.slice(first, first + chunkSize),
        nodeId: nodeIds[(first / chunkSize) % nodeIds.length]!,
      },
    });
  }

  // ---- Combat load: two 100-knight armies locked onto each other.
  const playerKnights: number[] = [];
  const aiKnights: number[] = [];
  spawnRinged(
    world,
    comps,
    playerTown.x,
    playerTown.y,
    KNIGHTS_PER_SIDE,
    14, // outside the villager ring: no spawn stacking
    (x, y) => {
      playerKnights.push(
        spawnCombatUnit(world, comps, "knight", x, y, PLAYER_ONE),
      );
    },
  );
  spawnRinged(world, comps, aiTown.x, aiTown.y, KNIGHTS_PER_SIDE, 2, (x, y) => {
    aiKnights.push(spawnCombatUnit(world, comps, "knight", x, y, AI_PLAYER));
  });

  /** Re-aim each army at the opposing army's current centroid. */
  const issueAttacks = (): void => {
    const livingPlayers = livingOf(world, comps, playerKnights);
    const livingAi = livingOf(world, comps, aiKnights);
    const targetForPlayer = centroidOf(world, comps, livingAi);
    if (targetForPlayer !== undefined && livingPlayers.length > 0) {
      world.inbox.submit({
        kind: "attackMove",
        targetTick: world.tick + 1,
        data: {
          ids: livingPlayers,
          x: targetForPlayer.x,
          y: targetForPlayer.y,
        },
      });
    }
    const targetForAi = centroidOf(world, comps, livingPlayers);
    if (targetForAi !== undefined && livingAi.length > 0) {
      world.inbox.submit({
        kind: "attackMove",
        targetTick: world.tick + 1,
        data: {
          ids: livingAi,
          x: targetForAi.x,
          y: targetForAi.y,
        },
      });
    }
  };

  for (let i = 0; i < WARMUP_TICKS; i++) {
    if (world.tick % REISSUE_TICKS === 0) issueAttacks();
    step(world);
  }

  const samples: number[] = [];
  for (let i = 0; i < MEASURED_TICKS; i++) {
    if (world.tick % REISSUE_TICKS === 0) issueAttacks();
    const start = performance.now();
    step(world);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95TickMs = samples[Math.ceil(samples.length * 0.95) - 1]!;
  const meanTickMs =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const maxTickMs = samples[samples.length - 1]!;

  let frame = captureSimSnapshot(world, comps);
  captureSimSnapshot(world, comps, { reusable: frame });
  let mirrorCopyMs = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 7; attempt++) {
    const start = performance.now();
    frame = captureSimSnapshot(world, comps, { reusable: frame });
    mirrorCopyMs = Math.min(mirrorCopyMs, performance.now() - start);
  }

  return {
    villagerCount: VILLAGER_COUNT,
    knightsPerSide: KNIGHTS_PER_SIDE,
    measuredTicks: MEASURED_TICKS,
    meanTickMs,
    p95TickMs,
    maxTickMs,
    mirrorCopyMs,
    drawCallApprox: approximateDrawCalls(2), // villagers + knight billboards
    survivorsPerSide: [
      livingOf(world, comps, playerKnights).length,
      livingOf(world, comps, aiKnights).length,
    ],
  };
}

function finishedTownAnchor(
  world: World,
  comps: SimComponents,
  player: number,
): { x: number; y: number } {
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (!row || row[0] !== player) continue;
    const rect = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!rect) continue;
    // Town centers are the first stamped building of each bootstrap.
    return { x: rect[0]!, y: rect[1]! };
  }
  throw new Error(`budget-m2: no building found for player ${String(player)}`);
}

function livingOf(
  world: World,
  comps: SimComponents,
  eids: readonly number[],
): number[] {
  return eids.filter((eid) =>
    world.rowsByComponentId.get(comps.combatId)?.has(eid),
  );
}

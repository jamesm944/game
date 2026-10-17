import { createSkirmishWorld } from "../src/game/session";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";
import {
  scatterResourceNodes,
} from "../src/sim/mapgen/resources";
import {
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { spawnCombatUnit } from "../src/sim/components/combat";
import { RESOURCE_WOOD } from "../src/sim/components/economy";
import { PLAYER_ONE } from "../src/sim/core/stockpile";
import { AI_PLAYER } from "../src/sim/ai/bootstrap";
import { step, type World } from "../src/sim/core/world";
import {
  EXTRA_NODE_COUNT,
  KNIGHTS_PER_SIDE,
  MEASURED_TICKS,
  REISSUE_TICKS,
  VILLAGER_COUNT,
  WARMUP_TICKS,
} from "../tests/helpers/budget-scenario-m2";

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
    if (!pos) continue;
    sumX += pos[0]!;
    sumY += pos[1]!;
    live += 1;
  }
  return live === 0 ? undefined : { x: sumX / live, y: sumY / live };
}

async function profile() {
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
  });
  const { world, comps } = session;

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

  const playerKnights: number[] = [];
  const aiKnights: number[] = [];
  spawnRinged(
    world,
    comps,
    playerTown.x,
    playerTown.y,
    KNIGHTS_PER_SIDE,
    14,
    (x, y) => {
      playerKnights.push(
        spawnCombatUnit(world, comps, "knight", x, y, PLAYER_ONE),
      );
    },
  );
  spawnRinged(world, comps, aiTown.x, aiTown.y, KNIGHTS_PER_SIDE, 2, (x, y) => {
    aiKnights.push(spawnCombatUnit(world, comps, "knight", x, y, AI_PLAYER));
  });

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

  // Wrap systems with timers
  const systemNames = world.systems.map((s, idx) => s.name || `system_${idx}`);
  const systemTimes: number[] = new Array(world.systems.length).fill(0);
  let pathSchedulerTime = 0;
  let flushDirtyTime = 0;
  let totalMeasuredTime = 0;

  const originalSystems = [...world.systems];
  const instrumentedSystems = originalSystems.map((sys, idx) => {
    return (w: World, cmds: any) => {
      const t0 = performance.now();
      sys(w, cmds);
      const dt = performance.now() - t0;
      systemTimes[idx] += dt;
    };
  });
  world.systems = instrumentedSystems;

  const tickTimes: number[] = [];

  for (let i = 0; i < MEASURED_TICKS; i++) {
    if (world.tick % REISSUE_TICKS === 0) issueAttacks();
    const tStart = performance.now();

    if (world.pathScheduler !== undefined) {
      const tp0 = performance.now();
      world.pathScheduler.pump(world.tick + 1);
      pathSchedulerTime += performance.now() - tp0;
    }
    world.tick += 1;
    const commands = world.inbox.drainDue(world.tick);
    for (const sys of world.systems) {
      sys(world, commands);
    }
    const tf0 = performance.now();
    world.visibility.flushDirty();
    flushDirtyTime += performance.now() - tf0;

    const tEnd = performance.now();
    const dt = tEnd - tStart;
    tickTimes.push(dt);
    totalMeasuredTime += dt;
  }

  tickTimes.sort((a, b) => a - b);
  const p95 = tickTimes[Math.ceil(tickTimes.length * 0.95) - 1]!;
  const mean = totalMeasuredTime / MEASURED_TICKS;

  console.log(`Measured ${MEASURED_TICKS} ticks: mean = ${mean.toFixed(3)}ms, p95 = ${p95.toFixed(3)}ms, max = ${tickTimes[tickTimes.length - 1]!.toFixed(3)}ms`);
  console.log(`Path scheduler pump total: ${pathSchedulerTime.toFixed(2)}ms (avg ${(pathSchedulerTime/MEASURED_TICKS).toFixed(3)}ms/tick)`);
  console.log(`Visibility flushDirty total: ${flushDirtyTime.toFixed(2)}ms (avg ${(flushDirtyTime/MEASURED_TICKS).toFixed(3)}ms/tick)`);
  console.log("\nPer-system breakdown (sorted by total time):");

  const breakdown = systemNames.map((name, idx) => ({
    name,
    totalMs: systemTimes[idx]!,
    avgMs: systemTimes[idx]! / MEASURED_TICKS,
    pct: (systemTimes[idx]! / totalMeasuredTime) * 100,
  })).sort((a, b) => b.totalMs - a.totalMs);

  for (const item of breakdown) {
    if (item.avgMs > 0.01) {
      console.log(`  ${item.name.padEnd(35)} : ${item.totalMs.toFixed(2)}ms total | ${item.avgMs.toFixed(3)}ms/tick | ${item.pct.toFixed(1)}%`);
    }
  }
}

profile().catch(console.error);

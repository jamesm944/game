import { createSkirmishWorld } from "../src/game/session";
import { createSynchronousPathTransport } from "../src/sim/path/scheduler";
import { scatterResourceNodes } from "../src/sim/mapgen/resources";
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
  VILLAGER_COUNT,
  WARMUP_TICKS,
} from "../tests/helpers/budget-scenario-m2";
import { hasLineOfSight } from "../src/sim/path/astar";

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

async function testWhyLosFails() {
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
  for (let first = 0; first < VILLAGER_COUNT; first += 10) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: {
        entityIds: villagerIds.slice(first, first + 10),
        nodeId: nodeIds[(first / 10) % nodeIds.length]!,
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

  for (let i = 0; i < WARMUP_TICKS; i++) {
    step(world);
  }

  // Let's sample 5 units that fail hasLineOfSight in movement.ts
  let samples = 0;
  for (const eid of world.entities) {
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    const queue = world.rowsByComponentId.get(comps.activityQueueId)?.get(eid);
    if (!pos || !queue || queue[0] !== 1 /* move */) continue;
    // queue format: [kind, targetX, targetY, waypointsLength, ...waypoints]
    // Let's check how peekActivity reads queue
  }
}

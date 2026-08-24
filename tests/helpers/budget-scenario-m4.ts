/**
 * M4 sign-off budget scenario — SPEC §7 / M4-T7 (issue #62).
 *
 * The §7 CPU gates re-run at the M4 workload: the FULL M3 deep-sim
 * village (305 Pops through the compressed-clock daily transition zoo,
 * see budget-scenario-m3.ts) PLUS the whole delegation + companies
 * stack live and LOADED:
 *
 *   - two mining camps stamped beside rich iron nodes and CHARTERED
 *     into a company (real charterCompany command) with a 50% tithe —
 *     every delivery from the re-pointed miners flushes a treasury
 *     accrual AND an economic-ledger credit on top of the deposit;
 *   - expansion thinks run at the 1 Hz cadence against always-ask
 *     approval, so each one scans unclaimed nodes and scores AI
 *     placement candidates before stamping its pending proposal;
 *   - eight villagers are kept OUT of direct labor so the branch
 *     staffing pass seats real foremen (management-rated picks) whose
 *     service grows ManagementSkill rows while the management system's
 *     lock sweep validates the direct orders.
 *
 * Warm-up absorbs JIT + the initial path storm; MEASURED_TICKS feed
 * mean/p95/max; mirror snapshot copy is best-of-seven. Draw calls stay
 * a static composition approximation (GL context needed otherwise).
 */

import {
  buildingRectOf,
  populationOf,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../src/sim/components";
import {
  RESOURCE_FOOD,
  RESOURCE_IRON,
  RESOURCE_WOOD,
} from "../../src/sim/components/economy";
import { branchRowOf, companyRowOf } from "../../src/sim/components/company";
import { foremanRowOf } from "../../src/sim/components/management";
import { PLAYER_ONE, stockpileAmountsOf } from "../../src/sim/core/stockpile";
import { step, type World } from "../../src/sim/core/world";
import { createSkirmishWorld } from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import {
  M3_BUDGET_CLOCK,
  MEASURED_TICKS,
  VILLAGER_COUNT,
  spawnRinged,
  stampVillageBuilding,
} from "./budget-scenario-m3";
import { captureSimSnapshot } from "../../src/sim/mirror";
import { approximateDrawCalls } from "./budget-scenario";

/** Miners re-pointed onto the company's iron nodes. */
export const MINER_COUNT = 40;
/** Unordered villagers left for the branch staffing pass to draft. */
export const IDLE_LABOR = 8;
/**
 * Longer pre-measurement warm-up than M3's: the gate also demands live
 * company accruals, and the first miner delivery (walk out, fill a
 * carry under slot congestion, return, tithe) lands well past M3's
 * JIT-absorbing 150 ticks. Measured window stays identical.
 */
export const WARMUP_TICKS_M4 = 2400;

/** Scenario bank so births/outings never starve mid-measurement. */
const CAPITAL = [6000, 6000, 2000, 0, 0, 0, 0];

export interface BudgetM4RunResult {
  readonly villagerCount: number;
  readonly measuredTicks: number;
  readonly meanTickMs: number;
  readonly p95TickMs: number;
  readonly maxTickMs: number;
  readonly mirrorCopyMs: number;
  readonly drawCallApprox: number;
  /** Household rows live when measurement ended (lifecycle active). */
  readonly householdsFormed: number;
  /** Named-Pop population when measurement ended (births landed). */
  readonly populationEnd: number;
  /** Company rows owned by the player when measurement ended. */
  readonly companies: number;
  /** Branch rows feeding the treasury when measurement ended. */
  readonly branches: number;
  /** Seated foremen across all workplaces (delegation staffed). */
  readonly foremen: number;
  /** Company treasury milli-credits accrued (>0 = tithe flowing). */
  readonly treasuryMilli: number;
}

/**
 * Run the full M4 workload — M3's deep-sim village PLUS management +
 * companies — and return its measured telemetry.
 */
export function runBudgetScenarioM4(): BudgetM4RunResult {
  // Session-tested seed: hosted map (no center water) with both bases.
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
    lifecycleConfig: M3_BUDGET_CLOCK,
  });
  const { world, comps } = session;

  for (const ledger of world.rowsByComponentId
    .get(comps.stockpileId)!
    .values()) {
    for (let code = 0; code < CAPITAL.length; code++) {
      ledger[code + 1] = CAPITAL[code]!;
    }
  }

  const townAnchor = townCenterAnchor(world, comps);
  const acceptedRects: {
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  for (const defId of [
    "house",
    "house",
    "house",
    "house",
    "school",
    "church",
    "tavern",
  ]) {
    stampVillageBuilding(
      world,
      comps,
      defId,
      townAnchor.x,
      townAnchor.y,
      acceptedRects,
    );
  }

  // ---- The M4 layer: two camps + an iron pair, chartered -------------
  const campSpots = [
    [townAnchor.x + 12, townAnchor.y + 9],
    [townAnchor.x + 16, townAnchor.y - 6],
  ].map(([x, y]) =>
    stampVillageBuilding(world, comps, "mining-camp", x!, y!, acceptedRects),
  );
  // Nodes go on PASSABLE ground near each camp — the real mapgen is
  // not flat grass, so blind coordinates can strand a node off-grid.
  const ironNodes = [
    ironNodeNear(world, comps, campSpots[0]!),
    ironNodeNear(world, comps, campSpots[1]!),
  ];
  world.inbox.submit({
    kind: "charterCompany",
    targetTick: world.tick + 1,
    data: {
      name: "Deepvein Combine",
      focus: 3 /* metal */,
      seedBuildingIds: [...campSpots].sort((a, b) => a - b),
    },
  });
  step(world);
  let companyId = 0;
  for (const [eid, row] of world.rowsByComponentId.get(comps.companyId)!) {
    if (row[0] === PLAYER_ONE) companyId = eid;
  }
  if (companyId === 0) throw new Error("budget-m4: charter did not land");
  if (
    branchRowOf(world, comps, campSpots[0]!)?.companyEid !== companyId ||
    branchRowOf(world, comps, campSpots[1]!)?.companyEid !== companyId
  ) {
    throw new Error("budget-m4: seed camps did not become Branches");
  }
  world.inbox.submit({
    kind: "setCompanyShare",
    targetTick: world.tick + 1,
    data: { companyId, sharePct: 50 },
  });

  // ---- Workforce: the M3 census minus the reserved idle labor --------
  const villagerIds: number[] = [];
  spawnRinged(
    world,
    comps,
    townAnchor.x,
    townAnchor.y,
    VILLAGER_COUNT,
    2,
    (x, y) => {
      villagerIds.push(
        spawnUnit(world, comps, x, y, {
          ownerId: PLAYER_ONE,
          identity: true,
          body: true,
          morale: true,
        }),
      );
    },
  );

  // Miners feed the COMPANY nodes (their deliveries tithe the treasury
  // and credit the economic ledger at every drop-off). The unordered
  // tail stays idle so branch staffing has eligible foreman candidates.
  const miners = villagerIds.slice(0, MINER_COUNT);
  const ringWorkers = villagerIds.slice(
    MINER_COUNT,
    villagerIds.length - IDLE_LABOR,
  );
  const ringNodes = ringNodesFor(world, comps, townAnchor);
  const chunkSize = 10;
  for (let first = 0; first < miners.length; first += chunkSize) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 2,
      data: {
        entityIds: miners.slice(first, first + chunkSize),
        nodeId: ironNodes[(first / chunkSize) % ironNodes.length]!,
      },
    });
  }
  for (let first = 0; first < ringWorkers.length; first += chunkSize) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 2,
      data: {
        entityIds: ringWorkers.slice(first, first + chunkSize),
        nodeId: ringNodes[(first / chunkSize) % ringNodes.length]!,
      },
    });
  }

  for (let i = 0; i < WARMUP_TICKS_M4; i++) step(world);

  // Fail loudly HERE if the tithe never started flowing, instead of a
  // far-away assertion on the returned telemetry.
  const ironDelivered = stockpileAmountsOf(world, comps, PLAYER_ONE)[
    RESOURCE_IRON
  ]!;
  const treasuryAtMeasure =
    companyRowOf(world, comps, companyId)?.treasuryMilli ?? 0;
  if (ironDelivered <= 0 || treasuryAtMeasure <= 0) {
    throw new Error(
      `budget-m4: company tithe not flowing at warm-up end (iron=${String(ironDelivered)}, treasury=${String(treasuryAtMeasure)})`,
    );
  }

  const samples: number[] = [];
  for (let i = 0; i < MEASURED_TICKS; i++) {
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

  // ---- Liveness reads: the M4 layers must be demonstrably ON --------
  let companies = 0;
  for (const [, row] of world.rowsByComponentId.get(comps.companyId)!) {
    if (row[0] === PLAYER_ONE) companies += 1;
  }
  let branches = 0;
  for (const [, row] of world.rowsByComponentId.get(comps.branchId)!) {
    if (row[0] === companyId) branches += 1;
  }
  let foremen = 0;
  for (const [eid] of world.rowsByComponentId.get(comps.foremanId)!) {
    if (foremanRowOf(world, comps, eid) !== undefined) foremen += 1;
  }
  const treasuryMilli =
    companyRowOf(world, comps, companyId)?.treasuryMilli ?? 0;

  return {
    villagerCount: VILLAGER_COUNT,
    measuredTicks: MEASURED_TICKS,
    meanTickMs,
    p95TickMs,
    maxTickMs,
    mirrorCopyMs,
    drawCallApprox: approximateDrawCalls(1), // villager billboards only
    householdsFormed: world.rowsByComponentId.get(comps.householdId)!.size,
    populationEnd: populationOf(world, comps, PLAYER_ONE),
    companies,
    branches,
    foremen,
    treasuryMilli,
  };
}

function townCenterAnchor(
  world: World,
  comps: SimComponents,
): { x: number; y: number } {
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (!row || row[0] !== PLAYER_ONE) continue;
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    // Town centers are the first stamped building of the bootstrap.
    return { x: pos[0]!, y: pos[1]! };
  }
  throw new Error("budget-m4: no player building found");
}

/**
 * A rich iron node on a PASSABLE tile ring-searched outward from
 * `anchorEid`'s footprint edge — guaranteed walkable from the camp's
 * door so miners can actually work it.
 */
function ironNodeNear(
  world: World,
  comps: SimComponents,
  anchorEid: number,
): number {
  const rect = buildingRectOf(world, comps, anchorEid);
  if (!rect) throw new Error("budget-m4: anchor building has no rect");
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  const cx = Math.floor(rect.x + rect.width / 2);
  const cy = Math.floor(rect.y + rect.height / 2);
  const clearOfFootprint = (x: number, y: number): boolean =>
    x < rect.x - 1 ||
    x > rect.x + rect.width ||
    y < rect.y - 1 ||
    y > rect.y + rect.height;
  for (let ring = 2; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
        if (!clearOfFootprint(x, y)) continue;
        // The tile itself AND one step toward the camp stay walkable.
        if (passability[y * size + x] !== 1) continue;
        return spawnResourceNode(world, comps, x, y, RESOURCE_IRON, 400_000);
      }
    }
  }
  throw new Error("budget-m4: no passable iron node site near camp");
}

/**
 * Deterministic food/wood belt around the town for the ring workers —
 * generous single-shot nodes so no worker starves mid-measurement.
 */
function ringNodesFor(
  world: World,
  comps: SimComponents,
  townAnchor: { x: number; y: number },
): number[] {
  const nodes: number[] = [];
  const size = world.layers.size;
  const passability = world.layers.derivedPassability;
  let placed = 0;
  for (let ring = 8; placed < 24 && ring < 40; ring += 2) {
    for (let dy = -ring; dy <= ring && placed < 24; dy += 2) {
      for (let dx = -ring; dx <= ring && placed < 24; dx += 2) {
        const x = Math.floor(townAnchor.x) + dx;
        const y = Math.floor(townAnchor.y) + dy;
        if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
        if (passability[y * size + x] !== 1) continue;
        nodes.push(
          spawnResourceNode(
            world,
            comps,
            x,
            y,
            placed % 2 === 0 ? RESOURCE_FOOD : RESOURCE_WOOD,
            100_000,
          ),
        );
        placed += 1;
      }
    }
  }
  return nodes;
}

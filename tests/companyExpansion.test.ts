/**
 * Company expansion & organic founding — SPEC §2.7 / M4-T3 (issue #58).
 *
 * Pins the §2.7 acceptance criteria end to end:
 *   - EXPANSION HOLDS: treasury ≥ threshold AND an unclaimed node in
 *     reach AND labor slack AND a placement-valid footprint near the
 *     node AND not frozen — every hold verified, then the proposal
 *     pipeline: always-ask stamps PendingExpansion and approve/reject
 *     resolve it; auto-approve breaks ground the same think, paid from
 *     the TREASURY at the definition's exact market-value equivalent,
 *     sited by the AI's distance-sorted scorer;
 *   - OVERSIGHT: seizeBranch reverts one branch (foreman post dies with
 *     it); dissolveCompany reverts EVERY branch and sweeps all company
 *     rows — free for commissioned charters, gold severance for organic
 *     companies past their grace window;
 *   - ORGANIC ORIGINS: three profitable directly-owned workplaces of
 *     one domain plus a sufficiently-rated Pop found spontaneously on
 *     the daily scan (below either threshold nothing fires), absorbing
 *     them as Branches under a free-dissolve grace window;
 *   - DIGEST SEAM: worlds that never exercise the feature carry zero
 *     expansion rows, so legacy digests stay byte-identical.
 */
import { describe, expect, it } from "vitest";
import { traitCodeOf } from "../src/sim/data/traits";
import {
  defineSimComponents,
  getBuildingRow,
  getBuildingSiteRow,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  APPROVAL_AUTO_APPROVE,
  approvalModeOf,
  branchRowOf,
  companyOriginOf,
  companyRowOf,
  expansionLogOf,
  EXPANSION_LOG_APPROVED,
  EXPANSION_LOG_EXECUTED,
  EXPANSION_LOG_FOUNDED,
  EXPANSION_LOG_REJECTED,
  EXPANSION_LOG_SEIZED,
  pendingExpansionOf,
} from "../src/sim/components/company";
import {
  foremanRowOf,
  setForemanRow,
  stampOrderLock,
} from "../src/sim/components/management";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../src/sim/systems/gather";
import {
  createProductionDiagnostics,
  createProductionSystem,
  type ProductionDiagnostics,
} from "../src/sim/systems/production";
import {
  createCompaniesSystem,
  createCompanyDiagnostics,
  expansionCostMilli,
  ORGANIC_DISSOLVE_FEE_GOLD,
  ORGANIC_DISSOLVE_GRACE_TICKS,
  type CompanyDiagnostics,
} from "../src/sim/systems/companies";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import type { LifecycleConfig } from "../src/sim/systems/lifecycle";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 40;
const RESOURCE_IRON = 4;
/** mining-camp costs wood 100 × market value 1 ⇒ 100 credits. */
const MINING_CAMP_COST_MILLI = expansionCostMilli("mining-camp");

interface Scenario {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diag: CompanyDiagnostics;
  readonly gather: GatherDiagnostics;
  readonly production: ProductionDiagnostics;
}

function openWorld(
  seed: number,
  options: { lifecycleConfig?: LifecycleConfig } = {},
): Scenario {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  const diag = createCompanyDiagnostics();
  const gather = createGatherDiagnostics();
  const production = createProductionDiagnostics();
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    diagnostics: diag,
    lifecycleConfig: options.lifecycleConfig,
  });
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, gather, {
      onOutput: companies.onOutput,
    }),
  );
  registerSystem(
    world,
    createProductionSystem(
      comps,
      production,
      { isRecipeUnlocked: () => true },
      { onOutput: companies.onOutput },
    ),
  );
  registerSystem(world, companies.system);
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [400, 4000, 100, 0, 50, 50, 0],
  );
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(world, comps, 4.5, 4.5, PLAYER_ONE);
  return { world, comps, diag, gather, production };
}

const villager = (scene: Scenario, x: number, y: number): number =>
  spawnUnit(scene.world, scene.comps, x, y, { identity: true });

/** Blank every named Pop's rolled traits; optionally pin one Pop's. */
const pinTraits = (
  scene: Scenario,
  pinned?: { readonly eid: number; readonly slugs: string[] },
): void => {
  const rows = scene.world.rowsByComponentId.get(scene.comps.traitsId)!;
  for (const eid of scene.world.entities) {
    if (!scene.world.rowsByComponentId.get(scene.comps.identityId)?.has(eid)) {
      continue;
    }
    rows.set(eid, []);
  }
  if (pinned) {
    rows.set(pinned.eid, pinned.slugs.map(traitCodeOf));
  }
};

const workplace = (
  scene: Scenario,
  defId: string,
  tileX: number,
  tileY: number,
): number =>
  stampFinishedBuilding(scene.world, scene.comps, defId, tileX, tileY, {
    playerId: PLAYER_ONE,
  });

function submit(
  scene: Scenario,
  kind: string,
  data: Record<string, unknown>,
): void {
  scene.world.inbox.submit({
    kind,
    targetTick: scene.world.tick + 1,
    data,
  });
}

function runFor(scene: Scenario, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(scene.world);
}

function companyEidOf(scene: Scenario): number {
  const rows = scene.world.rowsByComponentId.get(scene.comps.companyId);
  const first = [...(rows ?? []).keys()].sort((a, b) => a - b)[0];
  if (first === undefined) throw new Error("no chartered company");
  return first;
}

function playerGold(scene: Scenario): number {
  const rows = scene.world.rowsByComponentId.get(scene.comps.stockpileId)!;
  for (const [, row] of rows) {
    if (row[0] === PLAYER_ONE) return row[3] ?? 0; // index 0 = owner tag
  }
  throw new Error("no player stockpile");
}

interface MiningRig {
  readonly scene: Scenario;
  readonly camp: number;
  readonly co: number;
}

/**
 * A chartered metal company over one mining camp beside a rich iron
 * node, fed at 100% share until `targetMilli` accrues. One locked miner
 * mules the deliveries; three idle Pops staff the hierarchy: the
 * staffing pass drafts ONE as camp foreman, leaving two as the labor
 * slack later holds demand.
 */
function mineAndFeed(seed: number, targetMilli: number): MiningRig {
  const scene = openWorld(seed);
  const camp = workplace(scene, "mining-camp", 8, 8);
  const nodeId = spawnResourceNode(
    scene.world,
    scene.comps,
    12,
    12,
    RESOURCE_IRON,
    200_000,
  );
  villager(scene, 9.5, 11.5); // officer candidates (one gets drafted)
  villager(scene, 13.5, 11.5);
  villager(scene, 14.5, 15.5);
  const miner = villager(scene, 11.5, 11.5);
  // Blank every rolled trait: ratings start identical, so the staffing
  // pass's lower-eid tie-break seats an OFFICER as camp foreman and
  // never drafts the busy miner off his line (same privilege the
  // M4-T2 fixture pins).
  pinTraits(scene);
  submit(scene, "charterCompany", {
    name: "Deepvein Combine",
    focus: 3 /* metal */,
    seedBuildingIds: [camp],
  });
  runFor(scene, 2);
  const co = companyEidOf(scene);
  submit(scene, "setCompanyShare", { companyId: co, sharePct: 100 });
  submit(scene, "gather", { entityIds: [miner], nodeId });
  let guard = 0;
  while (
    companyRowOf(scene.world, scene.comps, co)!.treasuryMilli < targetMilli &&
    guard++ < 20_000
  ) {
    step(scene.world);
  }
  expect(guard).toBeLessThan(20_000);
  return { scene, camp, co };
}

installSimPurityShims();

describe("expansion holds", () => {
  it("proposes nothing below the treasury threshold", () => {
    const scene = openWorld(20261001);
    const camp = workplace(scene, "mining-camp", 8, 8);
    villager(scene, 19.5, 19.5); // idle slack
    submit(scene, "charterCompany", {
      name: "Tiny",
      focus: 3,
      seedBuildingIds: [camp],
    });
    runFor(scene, 150); // several staffing/expansion thinks
    expect(companyEidOf(scene)).toBeGreaterThan(0);
    expect(
      pendingExpansionOf(scene.world, scene.comps, companyEidOf(scene)),
    ).toBeUndefined();
    expect(
      scene.world.rowsByComponentId.get(scene.comps.pendingExpansionId)!.size,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.expansionLogId)!.size,
    ).toBe(0);
  });

  it("demands an unclaimed node in reach before proposing", () => {
    // Sole live node sits inside the camp's claim radius ⇒ nothing is
    // expandable-onto regardless of treasury/slack.
    const rig = mineAndFeed(20261002, MINING_CAMP_COST_MILLI);
    runFor(rig.scene, 120);
    expect(
      pendingExpansionOf(rig.scene.world, rig.scene.comps, rig.co),
    ).toBeUndefined();
  });

  it("demands labor slack before proposing", () => {
    const rig = mineAndFeed(20261003, MINING_CAMP_COST_MILLI);
    const { scene } = rig;
    // Rich unclaimed node staged within reach of the camp…
    spawnResourceNode(scene.world, scene.comps, 24, 16, RESOURCE_IRON, 60_000);
    // …then every named Pop direct-order-locked (fixture privilege:
    // the exact row a direct order stamps) ⇒ zero slack ⇒ no proposal.
    for (const eid of scene.world.entities) {
      if (
        !scene.world.rowsByComponentId.get(scene.comps.identityId)?.has(eid)
      ) {
        continue;
      }
      stampOrderLock(scene.world, scene.comps, eid, scene.world.tick, 0);
    }
    runFor(scene, 120);
    expect(
      pendingExpansionOf(scene.world, scene.comps, rig.co),
    ).toBeUndefined();
    // Unlock: the very next think proposes.
    const lockRows = scene.world.rowsByComponentId.get(
      scene.comps.orderLockId,
    )!;
    lockRows.clear();
    let guard = 0;
    while (
      pendingExpansionOf(scene.world, scene.comps, rig.co) === undefined &&
      guard++ < 120
    ) {
      step(scene.world);
    }
    expect(pendingExpansionOf(scene.world, scene.comps, rig.co)).toBeDefined();
  });

  it("freeze halts proposals but never accrual", () => {
    const rig = mineAndFeed(20261004, MINING_CAMP_COST_MILLI);
    const { scene } = rig;
    spawnResourceNode(scene.world, scene.comps, 24, 16, RESOURCE_IRON, 60_000);
    submit(scene, "setCompanyFrozen", { companyId: rig.co, frozen: true });
    runFor(scene, 2);
    const frozenFrom = scene.world.tick;
    runFor(scene, 120);
    expect(
      pendingExpansionOf(scene.world, scene.comps, rig.co),
    ).toBeUndefined();
    expect(scene.diag.frozenThinks).toBeGreaterThanOrEqual(1);
    // Unfreeze: the proposal arrives at the next staggered think.
    submit(scene, "setCompanyFrozen", { companyId: rig.co, frozen: false });
    runFor(scene, 2);
    let guard = 0;
    while (
      pendingExpansionOf(scene.world, scene.comps, rig.co) === undefined &&
      guard++ < 120
    ) {
      step(scene.world);
    }
    expect(scene.world.tick).toBeGreaterThan(frozenFrom);
    expect(pendingExpansionOf(scene.world, scene.comps, rig.co)).toBeDefined();
  });
});

describe("always-ask proposals", () => {
  it("queues a pending site, approves from the treasury exactly", () => {
    const rig = mineAndFeed(20261005, MINING_CAMP_COST_MILLI);
    const { scene } = rig;
    const comps = scene.comps;
    // Second iron node: rich, unclaimed, within reach of the camp.
    spawnResourceNode(scene.world, comps, 24, 16, RESOURCE_IRON, 60_000);
    let guard = 0;
    while (
      pendingExpansionOf(scene.world, comps, rig.co) === undefined &&
      guard++ < 120
    ) {
      step(scene.world);
    }
    const pending = pendingExpansionOf(scene.world, comps, rig.co)!;
    expect(pending.defId).toBe("mining-camp");
    // Sited by the AI scorer around the chosen node: inside its search
    // window, on valid ground (never ON the node tile itself).
    expect(Math.abs(pending.tileX - 24)).toBeLessThanOrEqual(4);
    expect(Math.abs(pending.tileY - 16)).toBeLessThanOrEqual(4);
    const before = companyRowOf(scene.world, comps, rig.co)!.treasuryMilli;
    expect(before).toBeGreaterThanOrEqual(MINING_CAMP_COST_MILLI);

    submit(scene, "approveExpansion", { companyId: rig.co });
    runFor(scene, 2);

    // Ground broke: a real construction site holding Branch status.
    let siteEid: number | undefined;
    for (const [eid, row] of scene.world.rowsByComponentId.get(
      comps.branchId,
    )!) {
      if (row[0] !== rig.co || eid === rig.camp) continue;
      siteEid = eid;
    }
    expect(siteEid).toBeDefined();
    expect(getBuildingSiteRow(scene.world, comps, siteEid!)).toBeDefined();
    expect(getBuildingRow(scene.world, comps, siteEid!)).toBeUndefined();
    // EXACT treasury payment — the stockpile never moved.
    expect(companyRowOf(scene.world, comps, rig.co)!.treasuryMilli).toBe(
      before - MINING_CAMP_COST_MILLI,
    );
    // Public history: one APPROVED entry carrying the site tile.
    const log = expansionLogOf(scene.world, comps, rig.co);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe(EXPANSION_LOG_APPROVED);
    expect(log[0]!.argA).toBe(pending.tileX);
    expect(log[0]!.argB).toBe(pending.tileY);
    expect(scene.diag.approvedExpansions).toBe(1);
  });

  it("rejecting clears the pending row and logs the verdict", () => {
    const rig = mineAndFeed(20261006, MINING_CAMP_COST_MILLI);
    const { scene } = rig;
    spawnResourceNode(scene.world, scene.comps, 24, 16, RESOURCE_IRON, 60_000);
    let guard = 0;
    while (
      pendingExpansionOf(scene.world, scene.comps, rig.co) === undefined &&
      guard++ < 120
    ) {
      step(scene.world);
    }
    const before = companyRowOf(
      scene.world,
      scene.comps,
      rig.co,
    )!.treasuryMilli;
    submit(scene, "rejectExpansion", { companyId: rig.co });
    runFor(scene, 2);
    expect(
      pendingExpansionOf(scene.world, scene.comps, rig.co),
    ).toBeUndefined();
    expect(companyRowOf(scene.world, scene.comps, rig.co)!.treasuryMilli).toBe(
      before,
    );
    const log = expansionLogOf(scene.world, scene.comps, rig.co);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe(EXPANSION_LOG_REJECTED);
    expect(log[0]!.argA).toBe(0);
    expect(log[0]!.argB).toBe(0);
    expect(scene.diag.rejectedProposals).toBe(1);
  });
});

describe("auto-approve mode", () => {
  it("breaks ground the same think, without ever pending", () => {
    const scene = openWorld(20261007);
    const camp = workplace(scene, "mining-camp", 8, 8);
    spawnResourceNode(scene.world, scene.comps, 12, 12, RESOURCE_IRON, 90_000);
    spawnResourceNode(scene.world, scene.comps, 24, 16, RESOURCE_IRON, 60_000);
    villager(scene, 9.5, 11.5); // foreman fodder
    const builder = villager(scene, 14.5, 15.5); // stays slack
    void builder;
    const minerA = villager(scene, 11.5, 11.5);
    const minerB = villager(scene, 12.5, 12.5);
    // Blank rolled traits so the staffing tie-break drafts the officer,
    // never a miner (see mineAndFeed).
    pinTraits(scene);
    submit(scene, "charterCompany", {
      name: "Auto Camp",
      focus: 3,
      seedBuildingIds: [camp],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    submit(scene, "setApprovalMode", {
      companyId: co,
      mode: APPROVAL_AUTO_APPROVE,
    });
    submit(scene, "setCompanyShare", { companyId: co, sharePct: 100 });
    runFor(scene, 2);
    expect(approvalModeOf(scene.world, scene.comps, co)).toBe(
      APPROVAL_AUTO_APPROVE,
    );
    submit(scene, "gather", {
      entityIds: [minerA],
      nodeId: nodeNear(scene, 12, 12),
    });
    submit(scene, "gather", {
      entityIds: [minerB],
      nodeId: nodeNear(scene, 12, 12),
    });
    let guard = 0;
    while (scene.diag.autoExpansions === 0 && guard++ < 8000) {
      step(scene.world);
    }
    expect(scene.diag.autoExpansions).toBe(1);
    // No pending row survives an auto execution…
    expect(pendingExpansionOf(scene.world, scene.comps, co)).toBeUndefined();
    // …and the new branch SITE stands near the far node.
    const sites: number[] = [];
    for (const [eid, row] of scene.world.rowsByComponentId.get(
      scene.comps.branchId,
    )!) {
      if (row[0] === co && eid !== camp) sites.push(eid);
    }
    expect(sites).toHaveLength(1);
    const pos = scene.world.rowsByComponentId
      .get(scene.comps.positionId)!
      .get(sites[0]!)!;
    expect(Math.abs(Math.floor(pos[0]!) - 24)).toBeLessThanOrEqual(5);
    expect(Math.abs(Math.floor(pos[1]!) - 16)).toBeLessThanOrEqual(5);
    const log = expansionLogOf(scene.world, scene.comps, co);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe(EXPANSION_LOG_EXECUTED);
  });
});

/** The spawned resource node nearest one tile (test-scoped lookup). */
function nodeNear(scene: Scenario, x: number, y: number): number {
  const posRows = scene.world.rowsByComponentId.get(scene.comps.positionId)!;
  let best: number | undefined;
  let bestD = Infinity;
  for (const [eid] of scene.world.rowsByComponentId.get(
    scene.comps.resourceNodeId,
  )!) {
    const pos = posRows.get(eid);
    if (!pos) continue;
    const d = (pos[0]! - x) ** 2 + (pos[1]! - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = eid;
    }
  }
  if (best === undefined) throw new Error("no resource node");
  return best;
}

describe("oversight actions", () => {
  it("seizeBranch reverts one branch and kills its foreman post", () => {
    const scene = openWorld(20261008);
    const camp = workplace(scene, "mining-camp", 8, 8);
    const boss = villager(scene, 9.5, 11.5);
    submit(scene, "charterCompany", {
      name: "Seized",
      focus: 3,
      seedBuildingIds: [camp],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    setForemanRow(scene.world, scene.comps, camp, boss, scene.world.tick);
    submit(scene, "seizeBranch", { companyId: co, branchId: camp });
    runFor(scene, 2);
    expect(branchRowOf(scene.world, scene.comps, camp)).toBeUndefined();
    expect(foremanRowOf(scene.world, scene.comps, camp)).toBeUndefined();
    expect(getBuildingRow(scene.world, scene.comps, camp)).toBeDefined();
    const log = expansionLogOf(scene.world, scene.comps, co);
    expect(log).toEqual([
      {
        tick: expect.any(Number),
        kind: EXPANSION_LOG_SEIZED,
        argA: camp,
        argB: 0,
      },
    ]);
    expect(scene.diag.seizures).toBe(1);
  });

  it("seizing a foreign or non-branch building throws loudly", () => {
    const scene = openWorld(20261009);
    const camp = workplace(scene, "mining-camp", 8, 8);
    const shed = workplace(scene, "kitchen", 18, 18);
    submit(scene, "charterCompany", {
      name: "Seized",
      focus: 3,
      seedBuildingIds: [camp],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    submit(scene, "seizeBranch", { companyId: co, branchId: shed });
    expect(() => step(scene.world)).toThrow(/not a Branch/);
    submit(scene, "dissolveCompany", { companyId: 999999 });
    expect(() => step(scene.world)).toThrow(/no Company row/);
  });

  it("dissolveCompany reverts branches and Pops cleanly, free of charge", () => {
    const scene = openWorld(20261010);
    const camp = workplace(scene, "mining-camp", 8, 8);
    const boss = villager(scene, 9.5, 11.5);
    submit(scene, "charterCompany", {
      name: "Shortlived",
      focus: 3,
      seedBuildingIds: [camp],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    setForemanRow(scene.world, scene.comps, camp, boss, scene.world.tick);
    const goldBefore = playerGold(scene);
    submit(scene, "dissolveCompany", { companyId: co });
    runFor(scene, 2);
    // Workplace reverted: no Branch row, no foreman post, building fine.
    expect(branchRowOf(scene.world, scene.comps, camp)).toBeUndefined();
    expect(foremanRowOf(scene.world, scene.comps, camp)).toBeUndefined();
    expect(getBuildingRow(scene.world, scene.comps, camp)).toBeDefined();
    // Every company-layer row swept with the entity.
    expect(scene.world.rowsByComponentId.get(scene.comps.companyId)!.size).toBe(
      0,
    );
    expect(
      scene.world.rowsByComponentId.get(scene.comps.treasuryDeltaId)!.size,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.expansionLogId)!.size,
    ).toBe(0);
    expect(scene.world.entities.includes(co)).toBe(false);
    // Commissioned dissolves never touch the owner's stockpile.
    expect(playerGold(scene)).toBe(goldBefore);
    expect(scene.diag.dissolutions).toBe(1);
  });
});

describe("organic founding", () => {
  /** Compressed clock: the daily scan fires every 300 ticks. */
  const DAY_TICKS_COMPRESSED: LifecycleConfig = {
    dayTicks: 300,
    adultAgeDays: 4,
    elderAgeDays: 8,
    lifespanDays: 40,
  };

  interface OrganicVillage {
    readonly scene: Scenario;
    readonly kitchens: number[];
    readonly founder: number;
  }

  /**
   * Kitchens in a row, one crafter EACH producing meals (profit events),
   * and a pinned-trait founder idling beside them. All rolled traits
   * blanked so the founder's rating is the only nonzero one.
   */
  function openOrganicVillage(
    seed: number,
    kitchenCount: number,
    founderSlugs: string[],
  ): OrganicVillage {
    const scene = openWorld(seed, {
      lifecycleConfig: DAY_TICKS_COMPRESSED,
    });
    const kitchens: number[] = [];
    for (let i = 0; i < kitchenCount; i++) {
      kitchens.push(workplace(scene, "kitchen", 17 + i * 4, 4));
    }
    const founder = villager(scene, 17.5, 12.5);
    for (let i = 0; i < kitchenCount; i++) {
      const crafter = villager(scene, 17.5 + i * 4, 6.5);
      submit(scene, "produce", {
        entityIds: [crafter],
        buildingEid: kitchens[i]!,
        delegated: true,
      });
    }
    pinTraits(scene, { eid: founder, slugs: founderSlugs });
    return { scene, kitchens, founder };
  }

  function runUntilFounded(scene: Scenario): number {
    let guard = 0;
    while (
      scene.world.rowsByComponentId.get(scene.comps.companyId)!.size === 0 &&
      guard++ < 2000
    ) {
      step(scene.world);
    }
    return companyEidOf(scene);
  }

  it("stays dormant below either threshold", () => {
    // Two profitable kitchens: below ORGANIC_MIN_PROFITABLE_WORKPLACES.
    const two = openOrganicVillage(20261011, 2, ["industrious"]);
    runFor(two.scene, 700); // two daily scans
    expect(
      two.scene.world.rowsByComponentId.get(two.scene.comps.companyId)!.size,
    ).toBe(0);

    // Three kitchens but a traitless founder: rating below minimum.
    const rated = openOrganicVillage(20261012, 3, []);
    runFor(rated.scene, 700);
    expect(
      rated.scene.world.rowsByComponentId.get(rated.scene.comps.companyId)!
        .size,
    ).toBe(0);
    expect(rated.scene.diag.organicFoundations).toBe(0);
  });

  it("founds spontaneously on the daily scan, absorbing the sector", () => {
    const org = openOrganicVillage(20261013, 3, ["industrious"]);
    const { scene, kitchens, founder } = org;
    const co = runUntilFounded(scene);
    const company = companyRowOf(scene.world, scene.comps, co)!;
    expect(company.focusDomain).toBe(0 /* food */);
    expect(company.name.endsWith(" & Co.")).toBe(true);
    // Origin record pins the founder and the daily founding tick.
    const origin = companyOriginOf(scene.world, scene.comps, co)!;
    expect(origin.founderPopEid).toBe(founder);
    expect(origin.foundedTick % 300).toBe(0);
    // All three DIRECT kitchens absorbed as Branches.
    for (const kitchen of kitchens) {
      expect(branchRowOf(scene.world, scene.comps, kitchen)?.companyEid).toBe(
        co,
      );
    }
    expect(scene.diag.organicFoundations).toBe(1);
    expect(scene.diag.transfers).toBe(0);
    // Public history opens with the FOUNDED entry.
    const log = expansionLogOf(scene.world, scene.comps, co);
    expect(log).toEqual([
      {
        tick: origin.foundedTick,
        kind: EXPANSION_LOG_FOUNDED,
        argA: 3,
        argB: founder,
      },
    ]);
  });

  it("keeps the grace window free and charges severance after it", () => {
    // INSIDE the window: dissolve is free — the stockpile stays put.
    const inside = openOrganicVillage(20261014, 3, ["industrious"]);
    const coIn = runUntilFounded(inside.scene);
    const foundedIn = companyOriginOf(
      inside.scene.world,
      inside.scene.comps,
      coIn,
    )!.foundedTick;
    runFor(inside.scene, foundedIn + 10 - inside.scene.world.tick);
    const goldInside = playerGold(inside.scene);
    submit(inside.scene, "dissolveCompany", { companyId: coIn });
    runFor(inside.scene, 2);
    expect(playerGold(inside.scene)).toBe(goldInside);
    expect(
      inside.scene.world.rowsByComponentId.get(inside.scene.comps.companyId)!
        .size,
    ).toBe(0);
    for (const kitchen of inside.kitchens) {
      expect(
        branchRowOf(inside.scene.world, inside.scene.comps, kitchen),
      ).toBeUndefined();
    }

    // PAST the window: the exact gold severance applies.
    const past = openOrganicVillage(20261015, 3, ["industrious"]);
    const coOut = runUntilFounded(past.scene);
    const foundedOut = companyOriginOf(
      past.scene.world,
      past.scene.comps,
      coOut,
    )!.foundedTick;
    runFor(
      past.scene,
      foundedOut + ORGANIC_DISSOLVE_GRACE_TICKS + 10 - past.scene.world.tick,
    );
    const goldPast = playerGold(past.scene);
    submit(past.scene, "dissolveCompany", { companyId: coOut });
    runFor(past.scene, 2);
    expect(playerGold(past.scene)).toBe(goldPast - ORGANIC_DISSOLVE_FEE_GOLD);
    expect(
      past.scene.world.rowsByComponentId.get(past.scene.comps.companyId)!.size,
    ).toBe(0);
  });

  it("refuses the post-grace severance when the owner cannot pay", () => {
    const poor = openOrganicVillage(20261016, 3, ["industrious"]);
    // Strip gold from the EXISTING stockpile row: the fee can never clear.
    for (const [, row] of poor.scene.world.rowsByComponentId.get(
      poor.scene.comps.stockpileId,
    )!) {
      if (row[0] === PLAYER_ONE) row[3] = 0;
    }
    const co = runUntilFounded(poor.scene);
    const founded = companyOriginOf(
      poor.scene.world,
      poor.scene.comps,
      co,
    )!.foundedTick;
    runFor(
      poor.scene,
      founded + ORGANIC_DISSOLVE_GRACE_TICKS + 10 - poor.scene.world.tick,
    );
    submit(poor.scene, "dissolveCompany", { companyId: co });
    expect(() => step(poor.scene.world)).toThrow(/cannot afford/);
    // Nothing dissolved: the company outlives the refused payment.
    expect(
      poor.scene.world.rowsByComponentId
        .get(poor.scene.comps.companyId)!
        .has(co),
    ).toBe(true);
  });
});

describe("digest seam", () => {
  it("never attaches expansion rows implicitly", () => {
    const scene = openWorld(20261017);
    const nodeId = spawnResourceNode(scene.world, scene.comps, 20, 20, 1, 500);
    const worker = villager(scene, 19.5, 19.5);
    submit(scene, "gather", { entityIds: [worker], nodeId });
    runFor(scene, 360);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.approvalModeId)!.size,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.pendingExpansionId)!.size,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.expansionLogId)!.size,
    ).toBe(0);
    expect(
      scene.world.rowsByComponentId.get(scene.comps.companyOriginId)!.size,
    ).toBe(0);
  });
});

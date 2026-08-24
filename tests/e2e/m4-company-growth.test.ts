/**
 * M4 demo checklist, headless half — SPEC §2.7 / M4-T3 (issue #58) +
 * M4-T7 sign-off extension (issue #62).
 *
 * One unattended company lifecycle over the REAL §2.7 stack, BOTH
 * origins back-to-back in a single run:
 *
 *   ACT 1 — COMMISSIONED: a mining company chartered over one camp
 *   self-expands to a SECOND camp on an unclaimed iron node (auto-
 *   approve, paid from its own treasury, sited by the AI's placement
 *   scorer), a build crew raises the foundation, and the finished camp
 *   wakes up as a fully tithe-paying Branch whose drop-off reroutes
 *   the sector's deliveries from the next tick.
 *
 *   ACT 2 — ORGANIC: three MORE directly-owned metal workplaces rise
 *   across fresh territory and keep turning output when a sufficiently
 *   management-rated Pop walks the map unlocked — and at the next
 *   daily scan that Pop FOUNDES a company spontaneously, absorbing all
 *   three as seed Branches (SPEC §2.7 origins clause; FOUNDED entry in
 *   the public expansion log, CompanyOrigin row stamped, grace window
 *   opened). No player command participates in Act 2 beyond the
 *   ordinary gather orders that made the workplaces profitable.
 *
 *   - the scenario editor stamps the seed camp, two rich iron nodes and
 *     the workforce before the first step (bootstrap privilege);
 *   - the player's only inputs are the SAME shared-inbox commands the
 *     oversight panel issues: charterCompany / setCompanyShare /
 *     setApprovalMode, plus ordinary gather/build labor orders — every
 *     expansion decision itself is made INSIDE step() by the company;
 *   - assertions read digest-visible rows (Company / Branch / Building /
 *     Stockpile / CompanyOrigin / ExpansionLog) plus the gather
 *     counters, mirroring the M4-T2 pin.
 *
 * The seed is pinned because outcomes are a pure function of it.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  getBuildingRow,
  getBuildingSiteRow,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import { branchRowOf } from "../../src/sim/components/company";
import { traitCodeOf } from "../../src/sim/data/traits";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createDropOffPoint,
  createPlayerStockpile,
} from "../../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../src/sim/path/scheduler";
import { createMovementSystem } from "../../src/sim/systems/movement";
import { createGatherSystem } from "../../src/sim/systems/gather";
import { createConstructionSystem } from "../../src/sim/systems/construction";
import { createProductionSystem } from "../../src/sim/systems/production";
import { createManagementSystem } from "../../src/sim/systems/management";
import {
  APPROVAL_AUTO_APPROVE,
  approvalModeOf,
  companyOriginOf,
  companyRowOf,
  expansionLogOf,
  EXPANSION_LOG_EXECUTED,
  EXPANSION_LOG_FOUNDED,
  pendingExpansionOf,
} from "../../src/sim/components/company";
import {
  createCompaniesSystem,
  createCompanyDiagnostics,
  expansionCostMilli,
} from "../../src/sim/systems/companies";
import { stampFinishedBuilding } from "../../src/sim/systems/placement";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const SEED = 20260824;
const SIZE = 48;
const RESOURCE_IRON = 4;
/** Iron market value 4 × share 100% ⇒ 4000 milli-credits per unit. */
const MILLI_PER_IRON_UNIT = 4_000;
const CAMP_COST_MILLI = expansionCostMilli("mining-camp");
/**
 * Compressed company clock: the organic scan fires on every day
 * boundary (tick % dayTicks), so the fixture shortens the day rather
 * than stepping a canonical 14,400-tick one. Adults stay adults (the
 * spawned settlers are ARRIVAL-origin working adults regardless).
 */
const COMPANY_CLOCK = {
  dayTicks: 450,
  adultAgeDays: 2,
  elderAgeDays: 4,
  lifespanDays: 8,
};

function submit(
  world: ReturnType<typeof createWorld>,
  kind: string,
  data: Record<string, unknown>,
): void {
  world.inbox.submit({ kind, targetTick: world.tick + 1, data });
}

describe("M4 demo checklist (SPEC §2.7): one autonomous company growth arc", () => {
  it("self-expands to a second camp on a new node and keeps the ledger exact", () => {
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const layers = buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    );
    const world = createWorld(SEED, {
      size: SIZE,
      layers,
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    const companyDiagnostics = createCompanyDiagnostics();
    const companies = createCompaniesSystem({
      comps,
      players: [PLAYER_ONE],
      diagnostics: companyDiagnostics,
      lifecycleConfig: COMPANY_CLOCK,
    });
    registerSystem(world, createMovementSystem(comps, scheduler));
    registerSystem(
      world,
      createGatherSystem(comps, scheduler, undefined, {
        onOutput: companies.onOutput,
      }),
    );
    registerSystem(world, createConstructionSystem(comps));
    registerSystem(
      world,
      createProductionSystem(comps, undefined, undefined, {
        onOutput: companies.onOutput,
      }),
    );
    registerSystem(
      world,
      createManagementSystem({ comps, players: [PLAYER_ONE] }),
    );
    registerSystem(world, companies.system);

    // ---- Scenario-editor founding, before the first step --------------
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [2000, 8000, 300, 0, 0, 0, 0],
    );
    createCommodityStockpile(world, comps, PLAYER_ONE);
    createDropOffPoint(world, comps, 6.5, 6.5, PLAYER_ONE);
    const campA = stampFinishedBuilding(world, comps, "mining-camp", 10, 10, {
      playerId: PLAYER_ONE,
    });
    // Worked node (claimed by camp A) and fresh territory (unclaimed).
    const workedNode = spawnResourceNode(
      world,
      comps,
      14,
      14,
      RESOURCE_IRON,
      120_000,
    );
    const freshNode = spawnResourceNode(
      world,
      comps,
      26,
      18,
      RESOURCE_IRON,
      80_000,
    );
    void workedNode;

    const officer = spawnUnit(world, comps, 11.5, 13.5, { identity: true });
    void officer;
    const builderA = spawnUnit(world, comps, 16.5, 17.5, { identity: true });
    const builderB = spawnUnit(world, comps, 17.5, 19.5, { identity: true });
    const minerA = spawnUnit(world, comps, 13.5, 13.5, { identity: true });
    const minerB = spawnUnit(world, comps, 14.5, 12.5, { identity: true });
    const minerC = spawnUnit(world, comps, 15.5, 14.5, { identity: true });
    // Blank rolled traits: identical ratings make the staffing tie-break
    // draft the OFFICER (lowest eid) as camp foreman, leaving both
    // builders as the expansion's labor slack.
    const traitRows = world.rowsByComponentId.get(comps.traitsId)!;
    for (const eid of [officer, builderA, builderB, minerA, minerB, minerC]) {
      traitRows.set(eid, [traitCodeOf("industrious")]);
    }
    for (const eid of [officer, builderA, builderB]) traitRows.set(eid, []);

    // ---- Player inputs: charter + policy only --------------------------
    submit(world, "charterCompany", {
      name: "Deepvein Combine",
      focus: 3 /* metal */,
      seedBuildingIds: [campA],
    });
    for (let i = 0; i < 2; i++) step(world);
    const co = [...world.rowsByComponentId.get(comps.companyId)!.keys()].sort(
      (a, b) => a - b,
    )[0]!;
    submit(world, "setCompanyShare", { companyId: co, sharePct: 100 });
    submit(world, "setApprovalMode", {
      companyId: co,
      mode: APPROVAL_AUTO_APPROVE,
    });
    submit(world, "gather", {
      entityIds: [minerA, minerB],
      nodeId: workedNode,
    });

    // ---- THE ARC: the company does the rest ---------------------------
    let expansionSite: number | undefined;
    let guard = 0;
    while (expansionSite === undefined && guard++ < 6000) {
      step(world);
      if (pendingExpansionOf(world, comps, co) !== undefined) {
        throw new Error("auto-approve company queued a pending proposal");
      }
      for (const [eid, row] of world.rowsByComponentId.get(comps.branchId)!) {
        if (row[0] === co && eid !== campA) expansionSite = eid;
      }
    }
    expect(expansionSite).toBeDefined();
    expect(approvalModeOf(world, comps, co)).toBe(APPROVAL_AUTO_APPROVE);

    // The expansion sited by the AI scorer around the FRESH node…
    const sitePos = world.rowsByComponentId
      .get(comps.positionId)!
      .get(expansionSite!)!;
    expect(Math.abs(sitePos[0]! - 27)).toBeLessThanOrEqual(5);
    expect(Math.abs(sitePos[1]! - 19)).toBeLessThanOrEqual(5);
    // …paid from the TREASURY at the exact definition price…
    const log = expansionLogOf(world, comps, co);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe(EXPANSION_LOG_EXECUTED);
    const depositsSoFar = log[0]!.tick; // refined below via stockpile math
    void depositsSoFar;
    // …and the ledger closes exactly: accruals − the camp price.
    const milliAtExpansion =
      companyRowOf(world, comps, co)!.treasuryMilli + CAMP_COST_MILLI;
    expect(milliAtExpansion % MILLI_PER_IRON_UNIT).toBe(0);

    // ---- The crew raises the foundation into a working camp -----------
    submit(world, "build", {
      entityIds: [builderA, builderB],
      siteEid: expansionSite,
    });
    let built = false;
    guard = 0;
    while (!built && guard++ < 4000) {
      step(world);
      built = getBuildingRow(world, comps, expansionSite!) !== undefined;
    }
    expect(built);
    expect(getBuildingSiteRow(world, comps, expansionSite!)).toBeUndefined();
    expect(branchRowOf(world, comps, expansionSite!)?.companyEid).toBe(co);

    // ---- The new camp joins the sector: deliveries reroute to it ------
    submit(world, "gather", { entityIds: [minerC], nodeId: freshNode });
    const ironAtBuild = world.rowsByComponentId
      .get(comps.stockpileId)!
      .get(stockpileEid(world, comps))![RESOURCE_IRON + 1]!;
    guard = 0;
    while (
      world.rowsByComponentId
        .get(comps.stockpileId)!
        .get(stockpileEid(world, comps))![RESOURCE_IRON + 1]! <= ironAtBuild &&
      guard++ < 2500
    ) {
      step(world);
    }
    const ironTotal = world.rowsByComponentId
      .get(comps.stockpileId)!
      .get(stockpileEid(world, comps))![RESOURCE_IRON + 1]!;
    expect(ironTotal).toBeGreaterThan(ironAtBuild);

    // EXACT LEDGER CLOSURE across the whole arc: every iron unit paid
    // 40 credits at the 100% share, the camp price left the treasury
    // once, and no organic founding had fired YET (never three DIRECT
    // workplaces of one domain).
    expect(companyRowOf(world, comps, co)!.treasuryMilli).toBe(
      ironTotal * MILLI_PER_IRON_UNIT - CAMP_COST_MILLI,
    );
    expect(world.rowsByComponentId.get(comps.companyOriginId)!.size).toBe(0);
    expect(expansionLogOf(world, comps, co)).toHaveLength(1);

    // ==== ACT 2 — ORGANIC ORIGINS (SPEC §2.7) ==========================
    //
    // Three fresh metal workplaces rise across unclaimed territory,
    // each worked by its own miner delivering to ITS OWN camp (the
    // nearest accepting drop-off by path cost). A rated, UNLOCKED pop
    // idles among them — and the daily scan does the rest with zero
    // player commands.
    const directCamps = [
      { node: [38, 38], camp: [41, 37] },
      { node: [43, 31], camp: [44, 34] },
      { node: [33, 43], camp: [35, 44] },
    ].map(({ node, camp }) => {
      const campEid = stampFinishedBuilding(
        world,
        comps,
        "mining-camp",
        camp[0]!,
        camp[1]!,
        { playerId: PLAYER_ONE },
      );
      const nodeEid = spawnResourceNode(
        world,
        comps,
        node[0]!,
        node[1]!,
        RESOURCE_IRON,
        80_000,
      );
      const miner = spawnUnit(world, comps, node[0]! + 1.5, node[1]! + 1.5, {
        identity: true,
      });
      submit(world, "gather", { entityIds: [miner], nodeId: nodeEid });
      return { campEid, miner };
    });

    // The founder: an Organization-rated pop (industrious ⇒ 2.0 ≥ the
    // 1.5 bar) carrying NO labor order — delegation never founds, and
    // the scan skips locked pops outright.
    const founder = spawnUnit(world, comps, 39.5, 40.5, { identity: true });
    world.rowsByComponentId
      .get(comps.traitsId)!
      .set(founder, [traitCodeOf("industrious")]);

    let organicCo: number | undefined;
    let guardAct2 = 0;
    while (organicCo === undefined && guardAct2++ < 4000) {
      step(world);
      for (const [eid] of world.rowsByComponentId.get(comps.companyId)!) {
        if (companyOriginOf(world, comps, eid) !== undefined) {
          organicCo = eid;
        }
      }
    }
    expect(organicCo).toBeDefined();
    expect(organicCo).not.toBe(co);

    // The origin row names the founder and the founding tick…
    const origin = companyOriginOf(world, comps, organicCo!)!;
    expect(origin.founderPopEid).toBe(founder);
    expect(origin.foundedTick).toBeGreaterThan(0);
    // …the public log carries the FOUNDED entry (workplaces absorbed,
    // founder recorded)…
    const organicLog = expansionLogOf(world, comps, organicCo!);
    expect(organicLog).toHaveLength(1);
    expect(organicLog[0]!.kind).toBe(EXPANSION_LOG_FOUNDED);
    expect(organicLog[0]!.argA).toBe(directCamps.length);
    expect(organicLog[0]!.argB).toBe(founder);
    // …all three workplaces became Branches of the NEW company…
    for (const { campEid } of directCamps) {
      expect(branchRowOf(world, comps, campEid)?.companyEid).toBe(organicCo);
      expect(getBuildingRow(world, comps, campEid)).toBeDefined();
    }
    // …and the workplaces keep delivering into them (their miner's
    // drop-off rerouted to the absorbed camp at absorption).
    const stockpileBefore =
      world.rowsByComponentId
        .get(comps.stockpileId)!
        .get(stockpileEid(world, comps))![RESOURCE_IRON + 1] ?? 0;
    let guardDeliveries = 0;
    while (
      (world.rowsByComponentId
        .get(comps.stockpileId)!
        .get(stockpileEid(world, comps))![RESOURCE_IRON + 1] ?? 0) <=
        stockpileBefore &&
      guardDeliveries++ < 2000
    ) {
      step(world);
    }
    expect(
      world.rowsByComponentId
        .get(comps.stockpileId)!
        .get(stockpileEid(world, comps))![RESOURCE_IRON + 1]!,
    ).toBeGreaterThan(stockpileBefore);

    // Exactly ONE spontaneous founding this run; the commissioned
    // company is untouched (no origin row, its own single expansion).
    expect(companyDiagnostics.organicFoundations).toBe(1);
    expect(companyOriginOf(world, comps, co)).toBeUndefined();
    expect(expansionLogOf(world, comps, co)).toHaveLength(1);
    expect(expansionLogOf(world, comps, co)[0]!.kind).toBe(
      EXPANSION_LOG_EXECUTED,
    );
  }, 120_000);
});

/** The player's stockpile entity id (single-owner fixture). */
function stockpileEid(
  world: ReturnType<typeof createWorld>,
  comps: ReturnType<typeof defineSimComponents>,
): number {
  for (const [eid, row] of world.rowsByComponentId.get(comps.stockpileId)!) {
    if (row[0] === PLAYER_ONE) return eid;
  }
  throw new Error("no player stockpile");
}

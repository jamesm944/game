/**
 * Companies — SPEC §2.7 / M4-T2 (issue #57).
 *
 * Pins the §2.7 acceptance criteria end to end:
 *   - CHARTER → TREASURY: a commissioned charter absorbs seed branches
 *     and routes the output share to the virtual treasury at EXACT
 *     integer milli-credits on EXACT completion ticks (meals: value 10
 *     × default share 20% ⇒ 2000 milli per cycle), while the physical
 *     units still land in the normal stockpile;
 *   - CONFIGURABLE SHARE: setCompanyShare rescales accrual (and 0%
 *     silences the ledger);
 *   - STAFFING EXCLUSIVITY: player appoint/dismiss commands targeting
 *     a branch are rejected loudly; the company staffing pass seats
 *     its own best-rated Pops; direct workplaces stay fully player-
 *     controlled;
 *   - FREEZE: the flag halts staffing churn (vacant posts stay vacant)
 *     but never production or passive treasury accrual;
 *   - DIGEST SEAM: worlds that never charter carry zero company rows,
 *     so legacy digests stay byte-identical.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  COMPANY_NAME_MAX_CHARS,
  branchRowOf,
  companyRowOf,
  treasuryDeltasOf,
} from "../src/sim/components/company";
import {
  PLAYER_ONE,
  commodityAmountOf,
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
import { createNeedsSystem } from "../src/sim/systems/needs";
import {
  createManagementSystem,
  managementRatingOf,
} from "../src/sim/systems/management";
import { foremanRowOf } from "../src/sim/components/management";
import {
  COMPANY_STAFF_INTERVAL_TICKS,
  createCompaniesSystem,
  createCompanyDiagnostics,
  type CompanyDiagnostics,
} from "../src/sim/systems/companies";
import { awardPractice } from "../src/sim/systems/skills";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 32;
const COMMODITY_MEALS = 5;

interface Scenario {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diag: CompanyDiagnostics;
  readonly production: ProductionDiagnostics;
  readonly gather: GatherDiagnostics;
}

function openCompanyWorld(
  seed: number,
  options: { readonly genericDropOff?: boolean } = {},
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
  const production = createProductionDiagnostics();
  const gather = createGatherDiagnostics();
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    diagnostics: diag,
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
  registerSystem(world, createNeedsSystem(comps));
  // Delegation layer first (it serves branch foremen too), companies
  // LAST so same-tick lock sweeps land before staffing thinks.
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE] }),
  );
  registerSystem(world, companies.system);
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [400, 400, 100, 0, 50, 50, 0],
  );
  createCommodityStockpile(world, comps, PLAYER_ONE);
  if (options.genericDropOff !== false) {
    createDropOffPoint(world, comps, 8.5, 8.5, PLAYER_ONE);
  }
  return { world, comps, diag, production, gather };
}

const villager = (scene: Scenario, x: number, y: number): number =>
  spawnUnit(scene.world, scene.comps, x, y, { identity: true });

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

/** Blank one or more Pops' trait rolls so ratings start identical. */
const clearTraits = (scene: Scenario, eids: number[]): void => {
  const rows = scene.world.rowsByComponentId.get(scene.comps.traitsId)!;
  for (const eid of eids) rows.set(eid, []);
};

/** The (single) chartered company's entity id, allocated last. */
function companyEidOf(scene: Scenario): number {
  const rows = scene.world.rowsByComponentId.get(scene.comps.companyId);
  const first = [...(rows ?? []).keys()].sort((a, b) => a - b)[0];
  if (first === undefined) throw new Error("no chartered company");
  return first;
}

/** First tick > `after` at which the company's staffing think fires. */
function nextStaffingTick(companyEid: number, after: number): number {
  for (let tick = after + 1; ; tick++) {
    if ((tick + companyEid) % COMPANY_STAFF_INTERVAL_TICKS === 0) return tick;
  }
}

installSimPurityShims();

describe("charter and treasury ledger", () => {
  it("accrues the exact share at the exact completion ticks", () => {
    const scene = openCompanyWorld(20260927);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    // Officer candidate FIRST (lower eid): with traits held equal the
    // staffing pass drafts THEM as branch foreman, never the crafter
    // already standing on the line — production stays undisturbed.
    const officer = villager(scene, 12.5, 9.5);
    const crafter = villager(scene, 15.5, 8.5); // inside the work band
    clearTraits(scene, [officer, crafter]);

    // Cycle #1 opens on tick 1 and completes on tick 301 (300 ticks).
    submit(scene, "produce", {
      entityIds: [crafter],
      buildingEid: kitchen,
      delegated: true,
    });
    // Charter lands on tick 2 — after the cycle opened, well before it
    // completes: the boundary must not disturb exact accounting.
    submit(scene, "charterCompany", {
      name: "Aurora Guild",
      focus: 0 /* food */,
      seedBuildingIds: [kitchen],
    });
    runFor(scene, 305);

    const co = companyEidOf(scene);
    expect(branchRowOf(scene.world, scene.comps, kitchen)?.companyEid).toBe(co);
    const company = companyRowOf(scene.world, scene.comps, co)!;
    expect(company.name).toBe("Aurora Guild");
    expect(company.focusDomain).toBe(0);
    expect(company.sharePct).toBe(20);
    expect(company.frozen).toBe(false);

    // One meal (market value 10) at 20% share = 2000 milli-credits,
    // credited on the exact completion tick.
    expect(scene.production.cyclesCompleted).toBe(1);
    expect(company.treasuryMilli).toBe(2000);
    expect(treasuryDeltasOf(scene.world, scene.comps, co)).toEqual([
      { tick: 301, milli: 2000 },
    ]);
    // The remainder hit the normal stockpile: the FULL meal landed.
    expect(
      commodityAmountOf(scene.world, scene.comps, PLAYER_ONE, COMMODITY_MEALS),
    ).toBe(1);
  });

  it("keeps accruing across further cycles with a growing tail", () => {
    const scene = openCompanyWorld(20260928);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    const officer = villager(scene, 12.5, 9.5); // drafted, see test #1
    const crafter = villager(scene, 15.5, 8.5);
    clearTraits(scene, [officer, crafter]);
    submit(scene, "produce", {
      entityIds: [crafter],
      buildingEid: kitchen,
      delegated: true,
    });
    submit(scene, "charterCompany", {
      name: "Aurora Guild",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    runFor(scene, 605);

    const co = companyEidOf(scene);
    expect(scene.production.cyclesCompleted).toBe(2);
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      4000,
    );
    expect(treasuryDeltasOf(scene.world, scene.comps, co)).toEqual([
      { tick: 301, milli: 2000 },
      { tick: 601, milli: 2000 },
    ]);
  });

  it("rescales accrual with setCompanyShare, down to silence at 0%", () => {
    const scene = openCompanyWorld(20260929);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    const officer = villager(scene, 12.5, 9.5); // drafted, see test #1
    const crafter = villager(scene, 15.5, 8.5);
    clearTraits(scene, [officer, crafter]);
    submit(scene, "produce", {
      entityIds: [crafter],
      buildingEid: kitchen,
      delegated: true,
    });
    submit(scene, "charterCompany", {
      name: "Half Share",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    submit(scene, "setCompanyShare", { companyId: co, sharePct: 50 });
    runFor(scene, 303);
    // 10 × 50% ⇒ 5000 milli per meal.
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      5000,
    );

    submit(scene, "setCompanyShare", { companyId: co, sharePct: 0 });
    runFor(scene, 300); // completion #2 lands under the silent ledger
    expect(scene.production.cyclesCompleted).toBe(2);
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      5000,
    );
    expect(treasuryDeltasOf(scene.world, scene.comps, co)).toEqual([
      { tick: 301, milli: 5000 },
    ]);
  });

  it("routes gathered output through a branch drop-off", () => {
    const scene = openCompanyWorld(20260930, { genericDropOff: false });
    // Lumber camp: the ONLY drop-off, therefore the certain destination.
    // Geometry keeps the worker clear of the camp footprint (its tiles
    // turn impassable the moment the branch is stamped).
    const camp = workplace(scene, "lumber-camp", 18, 18);
    const nodeId = spawnResourceNode(scene.world, scene.comps, 22, 22, 1, 900);
    const worker = villager(scene, 21.5, 21.5);
    // Gather order lands FIRST: its direct-order lock fences the lone
    // worker out of foreman candidacy, so nobody gets drafted off the
    // line and the ledger sees every delivered unit.
    submit(scene, "gather", { entityIds: [worker], nodeId });
    submit(scene, "charterCompany", {
      name: "Timber Combine",
      focus: 1 /* wood */,
      seedBuildingIds: [camp],
    });
    runFor(scene, 2400);

    const deposited = scene.gather.depositedByResource[1]!;
    expect(deposited).toBeGreaterThan(0);
    // Wood market value 1 × 20% share: exactly 200 milli per unit.
    const co = companyEidOf(scene);
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      deposited * 200,
    );
    // Tail entries sum exactly to the treasury for this single-company
    // world: conservation the panel renders verbatim.
    const tailSum = treasuryDeltasOf(scene.world, scene.comps, co).reduce(
      (sum, entry) => sum + entry.milli,
      0,
    );
    expect(tailSum).toBe(deposited * 200);
  });
});

describe("staffing exclusivity", () => {
  function exclusivityScene(seed: number): {
    scene: Scenario;
    branch: number;
    direct: number;
    boss: number;
    helper: number;
  } {
    const scene = openCompanyWorld(seed);
    const branch = workplace(scene, "kitchen", 14, 6);
    const direct = workplace(scene, "kitchen", 22, 6);
    const boss = villager(scene, 13.5, 8.5);
    const helper = villager(scene, 23.5, 8.5);
    clearTraits(scene, [boss, helper]);
    submit(scene, "charterCompany", {
      name: "Aurora Guild",
      focus: 0,
      seedBuildingIds: [branch],
    });
    runFor(scene, 2);
    return { scene, branch, direct, boss, helper };
  }

  it("rejects player appointment targeting a branch", () => {
    const { scene, branch, boss } = exclusivityScene(20260931);
    submit(scene, "appointForeman", { buildingEid: branch, popId: boss });
    expect(() => step(scene.world)).toThrow(/Branch/);
  });

  it("rejects player dismissal targeting a branch", () => {
    const { scene, branch } = exclusivityScene(20260932);
    submit(scene, "dismissForeman", { buildingEid: branch });
    expect(() => step(scene.world)).toThrow(/Branch/);
  });

  it("rejects taking a branch foreman over as domain manager", () => {
    const { scene, branch, boss } = exclusivityScene(20260933);
    // Seat the boss as the branch's own foreman first.
    const companyEid = branchRowOf(
      scene.world,
      scene.comps,
      branch,
    )!.companyEid;
    const thinkTick = nextStaffingTick(companyEid, scene.world.tick);
    runFor(scene, thinkTick - scene.world.tick);
    expect(foremanRowOf(scene.world, scene.comps, branch)?.foremanPopEid).toBe(
      boss,
    );

    submit(scene, "appointManager", { popId: boss, domain: 0 });
    expect(() => step(scene.world)).toThrow(/Branch/);
  });

  it("rejects re-posting a branch foreman onto a direct workplace", () => {
    const { scene, branch, direct, boss } = exclusivityScene(20260934);
    const companyEid = branchRowOf(
      scene.world,
      scene.comps,
      branch,
    )!.companyEid;
    const thinkTick = nextStaffingTick(companyEid, scene.world.tick);
    runFor(scene, thinkTick - scene.world.tick);
    expect(foremanRowOf(scene.world, scene.comps, branch)?.foremanPopEid).toBe(
      boss,
    );

    submit(scene, "appointForeman", { buildingEid: direct, popId: boss });
    expect(() => step(scene.world)).toThrow(/re-posted/);
  });

  it("leaves directly-owned workplaces fully player-controlled", () => {
    const { scene, direct, helper } = exclusivityScene(20260935);
    submit(scene, "appointForeman", { buildingEid: direct, popId: helper });
    runFor(scene, 2);
    expect(foremanRowOf(scene.world, scene.comps, direct)?.foremanPopEid).toBe(
      helper,
    );
    submit(scene, "dismissForeman", { buildingEid: direct });
    runFor(scene, 2);
    expect(foremanRowOf(scene.world, scene.comps, direct)).toBeUndefined();
  });

  it("seats the best-rated own Pop at vacancies, ties to the lower eid", () => {
    const scene = openCompanyWorld(20260936);
    const branch = workplace(scene, "kitchen", 14, 6);
    const novice = villager(scene, 12.5, 9.5); // lower eid…
    const journeyman = villager(scene, 13.5, 9.5); // …higher rating wins
    // Hold traits equal so the craft-skill term decides the ranking.
    scene.world.rowsByComponentId.get(scene.comps.traitsId)!.set(novice, []);
    scene.world.rowsByComponentId
      .get(scene.comps.traitsId)!
      .set(journeyman, []);
    awardPractice(scene.world, scene.comps, journeyman, "gathering", 1500);
    expect(
      managementRatingOf(scene.world, scene.comps, journeyman, 0),
    ).toBeGreaterThan(managementRatingOf(scene.world, scene.comps, novice, 0));

    submit(scene, "charterCompany", {
      name: "Aurora Guild",
      focus: 0,
      seedBuildingIds: [branch],
    });
    runFor(scene, 2);
    const thinkTick = nextStaffingTick(companyEidOf(scene), scene.world.tick);
    runFor(scene, thinkTick - scene.world.tick);

    expect(foremanRowOf(scene.world, scene.comps, branch)?.foremanPopEid).toBe(
      journeyman,
    );
    expect(scene.diag.appointments).toBe(1);
  });
});

describe("freeze flag", () => {
  it("halts staffing churn but never production or accrual", () => {
    const scene = openCompanyWorld(20260937);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    const boss = villager(scene, 13.5, 8.5);
    const crafter = villager(scene, 15.5, 8.5);
    clearTraits(scene, [boss, crafter]);
    submit(scene, "produce", {
      entityIds: [crafter],
      buildingEid: kitchen,
      delegated: true,
    });
    submit(scene, "charterCompany", {
      name: "Aurora Guild",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    runFor(scene, 2);
    const co = companyEidOf(scene);
    // First completion (tick 301) happens UNFROZEN with a seated
    // foreman from the first staffing think.
    const firstThink = nextStaffingTick(co, 2);
    expect(firstThink).toBeLessThan(301);
    runFor(scene, firstThink - 2);
    expect(foremanRowOf(scene.world, scene.comps, kitchen)?.foremanPopEid).toBe(
      boss,
    );
    runFor(scene, 301 - scene.world.tick);
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      2000,
    );

    // Freeze; vacate the post (the stand-in for death/expansion churn).
    submit(scene, "setCompanyFrozen", { companyId: co, frozen: true });
    runFor(scene, 2);
    scene.world.rowsByComponentId.get(scene.comps.foremanId)!.delete(kitchen);
    const frozenFrom = scene.world.tick;
    runFor(scene, nextStaffingTick(co, frozenFrom) - frozenFrom + 1);
    // Churn halted: no reappointment across a full staffing cadence…
    expect(foremanRowOf(scene.world, scene.comps, kitchen)).toBeUndefined();
    expect(scene.diag.frozenThinks).toBeGreaterThanOrEqual(1);
    // …but cycle #2 still completes and still pays the treasury.
    runFor(scene, 601 - scene.world.tick);
    expect(scene.production.cyclesCompleted).toBe(2);
    expect(companyRowOf(scene.world, scene.comps, co)!.treasuryMilli).toBe(
      4000,
    );

    // Unfreeze: the very next think refills the vacancy.
    submit(scene, "setCompanyFrozen", { companyId: co, frozen: false });
    runFor(scene, 2);
    const thawThink = nextStaffingTick(co, scene.world.tick);
    runFor(scene, thawThink - scene.world.tick);
    expect(foremanRowOf(scene.world, scene.comps, kitchen)?.foremanPopEid).toBe(
      boss,
    );
    expect(scene.diag.appointments).toBe(2); // initial seat + post-thaw refill
  });
});

describe("charter validation", () => {
  it("rejects malformed charters loudly on the boundary", () => {
    const scene = openCompanyWorld(20260938);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    const house = workplace(scene, "house", 20, 6);
    const foreign = stampFinishedBuilding(
      scene.world,
      scene.comps,
      "kitchen",
      17,
      14,
      { playerId: 1 },
    );

    submit(scene, "charterCompany", {
      name: "",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    expect(() => step(scene.world)).toThrow(/non-empty name/);

    submit(scene, "charterCompany", {
      name: "A".repeat(COMPANY_NAME_MAX_CHARS + 1),
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    expect(() => step(scene.world)).toThrow(/at most/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 9,
      seedBuildingIds: [kitchen],
    });
    expect(() => step(scene.world)).toThrow(/unknown domain code/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 0,
      seedBuildingIds: [],
    });
    expect(() => step(scene.world)).toThrow(/non-empty seedBuildingIds/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 0,
      seedBuildingIds: [999999],
    });
    expect(() => step(scene.world)).toThrow(/no finished Building row/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 0,
      seedBuildingIds: [house],
    });
    expect(() => step(scene.world)).toThrow(/cannot become a Branch/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 0,
      seedBuildingIds: [kitchen, foreign],
    });
    expect(() => step(scene.world)).toThrow(/not served/);

    submit(scene, "charterCompany", {
      name: "Ok",
      focus: 0,
      seedBuildingIds: [kitchen, kitchen],
    });
    expect(() => step(scene.world)).toThrow(/twice/);

    // After all those failures nothing was created.
    expect(scene.world.rowsByComponentId.get(scene.comps.companyId)!.size).toBe(
      0,
    );
  });

  it("refuses seeds that are already another company's branch", () => {
    const scene = openCompanyWorld(20260939);
    const kitchen = workplace(scene, "kitchen", 14, 6);
    submit(scene, "charterCompany", {
      name: "First",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    runFor(scene, 2);
    submit(scene, "charterCompany", {
      name: "Second",
      focus: 0,
      seedBuildingIds: [kitchen],
    });
    expect(() => step(scene.world)).toThrow(/already a company Branch/);
  });
});

describe("digest seam", () => {
  it("never attaches company rows implicitly", () => {
    const scene = openCompanyWorld(20260940);
    const nodeId = spawnResourceNode(scene.world, scene.comps, 20, 20, 0, 500);
    const worker = villager(scene, 19.5, 19.5);
    submit(scene, "gather", { entityIds: [worker], nodeId });
    runFor(scene, 120);

    // A busy un-chartered world carries zero company-layer rows —
    // legacy digests stay byte-identical.
    expect(scene.world.rowsByComponentId.get(scene.comps.companyId)!.size).toBe(
      0,
    );
    expect(scene.world.rowsByComponentId.get(scene.comps.branchId)!.size).toBe(
      0,
    );
    expect(
      scene.world.rowsByComponentId.get(scene.comps.treasuryDeltaId)!.size,
    ).toBe(0);
  });
});

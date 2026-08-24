/**
 * M4-T3 golden harness — SPEC §2.7 company expansion & organic
 * founding / issue #58.
 *
 * A mining company with a 100% share and AUTO-APPROVE expansion works
 * a rich iron vein until its virtual treasury covers a second camp,
 * which it sites itself beside the sector's unclaimed node (AI scorer)
 * and pays for at the exact market-value price; three profitable
 * directly-owned kitchens ripen into an ORGANIC founding on the daily
 * scan, and the new "& Co." is dissolved FREE inside its grace window.
 *
 * Pinned here:
 * - milestone digests every 150th tick plus final;
 * - a legible per-milestone trace: Deepvein treasury + branch count,
 *   live company count, expansion-log length, kitchenA staffing;
 * - semantic gates: EXACT ledger closure (every iron unit pays 4000
 *   milli at the 100% share, the camp price leaves the treasury once),
 *   the organic founding landing on the exact daily tick with all
 *   three kitchens absorbed and reverting cleanly on free dissolution,
 *   and the expansion site standing inside the scorer's window around
 *   the fresh node as an unfinished Branch (nobody builds in this
 *   fixture — completion is the e2e fixture's proof);
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { traitCodeOf } from "../../../src/sim/data/traits";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
} from "../../../src/sim/components";
import {
  branchRowOf,
  companyOriginOf,
  companyRowOf,
  expansionLogOf,
  EXPANSION_LOG_EXECUTED,
} from "../../../src/sim/components/company";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import {
  createProductionDiagnostics,
  createProductionSystem,
} from "../../../src/sim/systems/production";
import { createManagementSystem } from "../../../src/sim/systems/management";
import {
  createCompaniesSystem,
  createCompanyDiagnostics,
  expansionCostMilli,
  type CompanyDiagnostics,
} from "../../../src/sim/systems/companies";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const IRON_MILLI_PER_UNIT = 4_000; // value 4 × share 100% × 10
const CAMP_COST_MILLI = expansionCostMilli("mining-camp");
const STARTING_GOLD = 300;
/** Compressed life thresholds for the golden clock (arrivals adult). */
const GOLDEN_LIFE = { adultAgeDays: 4, elderAgeDays: 8, lifespanDays: 40 };

interface GoldenCommand {
  readonly tick: number;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly dayTicks: number;
  readonly startingResources: number[];
  readonly workplaces: Record<string, [number, number]>;
  readonly popSpawns: Record<string, [number, number]>;
  readonly nodes: Record<string, [number, number, number]>;
  readonly traitBoosts: Record<string, string[]>;
  readonly commands: GoldenCommand[];
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  const box = raw as Record<string, unknown>;
  const triple = (value: unknown): [number, number, number] => {
    const list = value as unknown[];
    return [Number(list[0]), Number(list[1]), Number(list[2])];
  };
  return {
    name: String(box.name),
    seed: Number(box.seed),
    size: Number(box.size),
    ticks: Number(box.ticks),
    milestoneEvery: Number(box.milestoneEvery),
    dayTicks: Number(box.dayTicks),
    startingResources: box.startingResources as number[],
    workplaces: Object.fromEntries(
      Object.entries(box.workplaces as Record<string, unknown>).map(
        ([key, value]) => {
          const pair = value as unknown[];
          return [key, [Number(pair[0]), Number(pair[1])] as [number, number]];
        },
      ),
    ),
    popSpawns: Object.fromEntries(
      Object.entries(box.popSpawns as Record<string, unknown>).map(
        ([key, value]) => {
          const pair = value as unknown[];
          return [key, [Number(pair[0]), Number(pair[1])] as [number, number]];
        },
      ),
    ) as GoldenCase["popSpawns"],
    nodes: Object.fromEntries(
      Object.entries(box.nodes as Record<string, unknown>).map(
        ([key, value]) => [key, triple(value)],
      ),
    ),
    traitBoosts: Object.fromEntries(
      Object.entries(box.traitBoosts as Record<string, unknown>).map(
        ([key, value]) => [key, value as string[]],
      ),
    ),
    commands: (box.commands as GoldenCommand[]).map((command) => ({
      tick: Number(command.tick),
      kind: command.kind,
      data: command.data,
    })),
  };
}

/** One milestone's worth of legible company state. */
export interface GrowthSample {
  readonly tick: number;
  /** Live chartered companies. */
  readonly companies: number;
  /** Deepvein treasury milli-credits (0 before its charter). */
  readonly treasuryMilli: number;
  /** Buildings/sites holding a Deepvein Branch row. */
  readonly deepveinBranches: number;
  /** Deepvein public-history length. */
  readonly logEntries: number;
  /** Production jobs seated at kitchenA. */
  readonly kitchenAJobs: number;
  readonly digest: string;
}

export interface GrowthRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly trace: GrowthSample[];
  readonly endGold: number;
  readonly ironDeposited: number;
  readonly mealsProduced: number;
  readonly organicFoundedTick: number | undefined;
  readonly organicName: string | undefined;
  readonly organicFounderEid: number | undefined;
  readonly expansionTick: number | undefined;
  readonly expansionSiteTile: readonly [number, number] | undefined;
}

function runScenario(fixture: GoldenCase): GrowthRunState {
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
    pathScheduler: new PathScheduler(createSynchronousPathTransport()),
  });
  const comps = defineSimComponents(world);
  const production = createProductionDiagnostics();
  const gather = createGatherDiagnostics();
  const diag: CompanyDiagnostics = createCompanyDiagnostics();
  // Compressed clock so the DAILY organic scan fires several times.
  const lifecycleConfig = { ...GOLDEN_LIFE, dayTicks: fixture.dayTicks };
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    diagnostics: diag,
    lifecycleConfig,
  });
  registerSystem(world, createMovementSystem(comps, world.pathScheduler!));
  registerSystem(
    world,
    createGatherSystem(comps, world.pathScheduler!, gather, {
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
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE], lifecycleConfig }),
  );
  registerSystem(world, companies.system);

  createPlayerStockpile(world, comps, PLAYER_ONE, [
    ...fixture.startingResources,
  ]);
  createCommodityStockpile(world, comps, PLAYER_ONE);

  // Buildings first, then Pops in case-file order — both ascensions are
  // load-bearing (officers outrank workers via the lower-eid tie-break).
  const workplaceEid = new Map<string, number>();
  for (const [key, tile] of Object.entries(fixture.workplaces)) {
    const defId = key === "miningCamp" ? "mining-camp" : ("kitchen" as string);
    workplaceEid.set(
      key,
      stampFinishedBuilding(world, comps, defId, tile[0], tile[1], {
        playerId: PLAYER_ONE,
      }),
    );
  }
  const popEid = new Map<string, number>();
  for (const [key, spot] of Object.entries(fixture.popSpawns)) {
    popEid.set(
      key,
      spawnUnit(world, comps, spot[0], spot[1], { identity: true }),
    );
  }
  // Fixture privilege: blank EVERY rolled trait, then pin the case
  // file's boosts — ratings start identical except the founder's, so
  // both the staffing tie-breaks and the organic scan are deterministic.
  const traitRows = world.rowsByComponentId.get(comps.traitsId)!;
  for (const eid of popEid.values()) traitRows.set(eid, []);
  for (const [key, slugs] of Object.entries(fixture.traitBoosts)) {
    traitRows.set(popEid.get(key)!, slugs.map(traitCodeOf));
  }
  const nodeEid = new Map<string, number>();
  for (const [key, spec] of Object.entries(fixture.nodes)) {
    nodeEid.set(
      key,
      spawnResourceNode(world, comps, spec[0], spec[1], 4 /* iron */, spec[2]),
    );
  }

  const companyRows = () => world.rowsByComponentId.get(comps.companyId)!;

  /** The commissioned mining company's eid (first row, ascending). */
  const deepveinEid = (): number | undefined =>
    [...companyRows().keys()].sort((a, b) => a - b)[0];

  /** The organically-founded company's eid (carries an Origin row). */
  const organicEid = (): number | undefined => {
    for (const eid of [...companyRows().keys()].sort((a, b) => a - b)) {
      if (companyOriginOf(world, comps, eid) !== undefined) return eid;
    }
    return undefined;
  };

  const resolveRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      const pop = popEid.get(value);
      if (pop !== undefined) return pop;
      const building = workplaceEid.get(value);
      if (building !== undefined) return building;
      const node = nodeEid.get(value);
      if (node !== undefined) return node;
      if (value === "deepvein") return deepveinEid();
      // The case file only references the organic company AFTER its
      // founding tick; an unresolved reference is a case-file bug.
      if (value === "organic") return organicEid();
    }
    if (Array.isArray(value)) {
      const mapped = value.map(resolveRefs);
      if (mapped.includes(undefined)) {
        throw new Error("organic company referenced before its founding");
      }
      return mapped;
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry)]),
      );
    }
    return value;
  };

  const scheduled = [...fixture.commands]
    .sort((a, b) => a.tick - b.tick)
    .map((command) => ({
      tick: command.tick,
      kind: command.kind,
      data: command.data,
    }));
  let commandIndex = 0;

  // The organic company is dissolved mid-run; capture its founding
  // facts the moment they exist rather than reading them at the end.
  let organicFoundedTick: number | undefined;
  let organicName: string | undefined;
  let organicFounderEid: number | undefined;

  const trace: GrowthSample[] = [];
  const digests: { tick: number; digest: string }[] = [];

  while (world.tick < fixture.ticks) {
    const nextTick = world.tick + 1;
    while (
      commandIndex < scheduled.length &&
      scheduled[commandIndex]!.tick <= nextTick
    ) {
      const command = scheduled[commandIndex++]!;
      world.inbox.submit({
        kind: command.kind,
        targetTick: Math.max(command.tick, nextTick),
        data: resolveRefs(command.data) as Record<string, unknown>,
      });
    }
    step(world);
    const organicNow = organicEid();
    if (
      organicNow !== undefined &&
      organicFoundedTick === undefined &&
      companyOriginOf(world, comps, organicNow) !== undefined
    ) {
      const origin = companyOriginOf(world, comps, organicNow)!;
      organicFoundedTick = origin.foundedTick;
      organicFounderEid = origin.founderPopEid;
      organicName = companyRowOf(world, comps, organicNow)!.name;
    }
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      const co = deepveinEid();
      let branches = 0;
      if (co !== undefined) {
        for (const [, row] of world.rowsByComponentId.get(comps.branchId)!) {
          if (row[0] === co) branches += 1;
        }
      }
      const jobRows = world.rowsByComponentId.get(comps.productionJobId)!;
      trace.push({
        tick,
        companies: companyRows().size,
        treasuryMilli:
          co === undefined ? 0 : companyRowOf(world, comps, co)!.treasuryMilli,
        deepveinBranches: branches,
        logEntries:
          co === undefined ? 0 : expansionLogOf(world, comps, co).length,
        kitchenAJobs: [...jobRows].filter(
          ([, row]) => row[0] === workplaceEid.get("kitchenA"),
        ).length,
        digest: computeWorldDigest(world),
      });
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  // ---- End-state reads -------------------------------------------------
  const co = deepveinEid();
  const coLog = co === undefined ? [] : expansionLogOf(world, comps, co);
  const executed = coLog.find((entry) => entry.kind === EXPANSION_LOG_EXECUTED);
  let expansionSiteTile: [number, number] | undefined;
  if (co !== undefined && executed !== undefined) {
    for (const [eid] of world.rowsByComponentId.get(comps.buildingSiteId)!) {
      if (branchRowOf(world, comps, eid)?.companyEid === co) {
        expansionSiteTile = [executed.argA, executed.argB];
      }
    }
  }

  return {
    digests,
    trace,
    endGold: stockpileAmountsOf(world, comps, PLAYER_ONE)[2]!,
    ironDeposited: gather.depositedByResource[4]!,
    mealsProduced: production.producedByCommodity[5]!,
    organicFoundedTick,
    organicName,
    organicFounderEid,
    expansionTick: executed?.tick,
    expansionSiteTile,
  };
}

installSimPurityShims();

describe("golden harness m4t3", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests plus the growth trace", () => {
    const run = runScenario(fixture);

    const expectedTicks: number[] = [];
    for (
      let tick = fixture.milestoneEvery;
      tick <= fixture.ticks;
      tick += fixture.milestoneEvery
    ) {
      expectedTicks.push(tick);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
    expect(run.trace).toMatchSnapshot();
  });

  it("auto-expands once from the treasury and founds organically", () => {
    const run = runScenario(fixture);

    // ORGANIC FOUNDING under the exact thresholds: the daily scan fired
    // on the compressed clock, absorbing all three kitchens under a
    // founder whose rating cleared the bar…
    expect(run.organicFoundedTick).toBe(600);
    expect(run.organicName!.endsWith(" & Co.")).toBe(true);
    expect(run.trace.find((sample) => sample.tick === 450)!.companies).toBe(1);
    expect(run.trace.find((sample) => sample.tick === 600)!.companies).toBe(2);

    // …and the GRACE-WINDOW dissolve reverted it without touching gold.
    expect(run.endGold).toBe(STARTING_GOLD);
    // The dissolve command targets tick 1050 exactly: still two
    // companies at the t=900 milestone, back to one at t=1050.
    expect(run.trace.find((sample) => sample.tick === 900)!.companies).toBe(2);
    expect(run.trace.find((sample) => sample.tick === 1050)!.companies).toBe(1);
    expect(run.trace.find((sample) => sample.tick === 1200)!.companies).toBe(1);

    // AUTO EXPANSION exactly once, sited by the AI scorer around the
    // fresh node, paid from the treasury at the exact camp price.
    expect(run.expansionTick).toBeDefined();
    expect(run.expansionTick!).toBeGreaterThan(600);
    expect(run.expansionSiteTile![0]).toBeGreaterThanOrEqual(22 - 4);
    expect(run.expansionSiteTile![0]).toBeLessThanOrEqual(22 + 4);
    expect(run.expansionSiteTile![1]).toBeGreaterThanOrEqual(16 - 4);
    expect(run.expansionSiteTile![1]).toBeLessThanOrEqual(16 + 4);
    expect(run.trace[run.trace.length - 1]!.deepveinBranches).toBe(2);

    // EXACT LEDGER CLOSURE: every deposited iron unit paid 4000 milli at
    // the 100% share; the camp price left the treasury exactly once.
    const last = run.trace[run.trace.length - 1]!;
    expect(last.treasuryMilli).toBe(
      run.ironDeposited * IRON_MILLI_PER_UNIT - CAMP_COST_MILLI,
    );
    expect(run.mealsProduced).toBeGreaterThan(0);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
  });
});

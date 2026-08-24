/**
 * M4-T2 golden harness — SPEC §2.7 companies / issue #57.
 *
 * A six-Pop village charters "Aurora Guild" (focus food) over two
 * kitchens and a lumber camp; a wood gatherer feeds the branch camp,
 * which is the world's ONLY drop-off, so every delivery is certain.
 *
 * Pinned here:
 * - milestone digests every 150th tick plus final;
 * - a legible per-milestone trace: kitchen staffing, treasury
 *   milli-credits, frozen flag, ledger-tail length;
 * - semantic gates: EXACT charter→production→treasury closure
 *   (meals: 6 completions × 2000 milli; wood: deposited units × 200
 *   milli — value × 20% share in integer milli-credits), exclusive
 *   company staffing (three officer seats, workers never drafted),
 *   freeze halting churn but not accrual (strictly growing treasury
 *   through the frozen window), and the physical remainder still
 *   landing in the normal stockpiles;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
} from "../../../src/sim/components";
import {
  TREASURY_TAIL_ENTRIES,
  treasuryDeltasOf,
} from "../../../src/sim/components/company";
import {
  PLAYER_ONE,
  commodityAmountOf,
  createCommodityStockpile,
  createPlayerStockpile,
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
  type GatherDiagnostics,
} from "../../../src/sim/systems/gather";
import {
  createProductionDiagnostics,
  createProductionSystem,
  type ProductionDiagnostics,
} from "../../../src/sim/systems/production";
import { createNeedsSystem } from "../../../src/sim/systems/needs";
import { createManagementSystem } from "../../../src/sim/systems/management";
import {
  createCompaniesSystem,
  createCompanyDiagnostics,
  type CompanyDiagnostics,
} from "../../../src/sim/systems/companies";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

const MEALS_MILLI_PER_UNIT = 2000; // value 10 × default share 20% × 10
const WOOD_MILLI_PER_UNIT = 200; // value 1 × default share 20% × 10
const COMMODITY_MEALS = 5;
const RESOURCE_WOOD = 1;

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
  readonly startingResources: number[];
  readonly workplaces: Record<string, [number, number]>;
  readonly popSpawns: Record<string, [number, number]>;
  readonly woodNode: [number, number, number];
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
    woodNode: triple(box.woodNode),
    commands: (box.commands as GoldenCommand[]).map((command) => ({
      tick: Number(command.tick),
      kind: command.kind,
      data: command.data,
    })),
  };
}

/** One milestone's worth of legible company state. */
export interface CompanySample {
  readonly tick: number;
  /** Live crafter count per traced workplace, case-file order. */
  readonly staffing: number[];
  readonly treasuryMilli: number;
  readonly frozen: boolean;
  readonly ledgerTailEntries: number;
  readonly digest: string;
}

export interface CompanyRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly trace: CompanySample[];
  readonly endStaffing: number[];
  readonly endTreasuryMilli: number;
  readonly mealsProduced: number;
  readonly mealsStockpiled: number;
  readonly woodDeposited: number;
  readonly appointments: number;
}

function runScenario(fixture: GoldenCase): CompanyRunState {
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
    pathScheduler: new PathScheduler(createSynchronousPathTransport()),
  });
  const comps = defineSimComponents(world);
  const production: ProductionDiagnostics = createProductionDiagnostics();
  const gather: GatherDiagnostics = createGatherDiagnostics();
  const companiesDiag: CompanyDiagnostics = createCompanyDiagnostics();
  // The companies ledger observes every output credit event, so its
  // observer wires into gather + production BEFORE they register; the
  // system itself runs after the delegation layer (mirrors session.ts).
  const companies = createCompaniesSystem({
    comps,
    players: [PLAYER_ONE],
    diagnostics: companiesDiag,
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
  registerSystem(world, createNeedsSystem(comps));
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE] }),
  );
  registerSystem(world, companies.system);

  createPlayerStockpile(world, comps, PLAYER_ONE, fixture.startingResources);
  createCommodityStockpile(world, comps, PLAYER_ONE);

  // Buildings first (lower eids), then Pops in case-file order — both
  // ascensions are load-bearing for the trace ordering and for the
  // tie-break that seats officers (never the working villagers).
  const workplaceEid = new Map<string, number>();
  for (const [key, tile] of Object.entries(fixture.workplaces)) {
    const defId = key === "lumberCamp" ? "lumber-camp" : ("kitchen" as string);
    const eid = stampFinishedBuilding(world, comps, defId, tile[0], tile[1], {
      playerId: PLAYER_ONE,
    });
    workplaceEid.set(key, eid);
  }
  const popEid = new Map<string, number>();
  for (const [key, spot] of Object.entries(fixture.popSpawns)) {
    popEid.set(
      key,
      spawnUnit(world, comps, spot[0], spot[1], { identity: true }),
    );
  }
  // Fixture privilege (same traitless state management.test pins): all
  // Pops hold EMPTY trait rows, so every management rating starts equal
  // and the staffing pass's tie-break (lower eid) seats the three
  // officers — the working villagers can never be drafted off their
  // lines no matter how the seeded rolls would have compared.
  const traitRows = world.rowsByComponentId.get(comps.traitsId)!;
  for (const eid of popEid.values()) traitRows.set(eid, []);
  const nodeId = spawnResourceNode(
    world,
    comps,
    fixture.woodNode[0],
    fixture.woodNode[1],
    RESOURCE_WOOD,
    fixture.woodNode[2],
  );

  /** The chartered company's eid — resolvable only once it exists. */
  const currentCompanyEid = (): number => {
    const rows = world.rowsByComponentId.get(comps.companyId)!;
    const first = [...rows.keys()].sort((a, b) => a - b)[0];
    if (first === undefined) {
      throw new Error("company referenced before any charter exists");
    }
    return first;
  };

  const resolveRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      const pop = popEid.get(value);
      if (pop !== undefined) return pop;
      const building = workplaceEid.get(value);
      if (building !== undefined) return building;
      if (value === "woodNode") return nodeId;
      if (value === "aurora") return currentCompanyEid();
    }
    if (Array.isArray(value)) return value.map(resolveRefs);
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

  const digests: { tick: number; digest: string }[] = [];
  const trace: CompanySample[] = [];
  const tracedWorkplaces = ["kitchenA", "kitchenB"];

  while (world.tick < fixture.ticks) {
    // Case-file commands enter the shared inbox BEFORE their target
    // boundary: a submission after that tick's drain would be late.
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
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      const jobRows = world.rowsByComponentId.get(comps.productionJobId)!;
      const co = currentCompanyEid();
      trace.push({
        tick,
        staffing: tracedWorkplaces.map(
          (key) =>
            [...jobRows].filter(([, row]) => row[0] === workplaceEid.get(key))
              .length,
        ),
        treasuryMilli: world.rowsByComponentId
          .get(comps.companyId)!
          .get(co)![2]!,
        frozen: world.rowsByComponentId.get(comps.companyId)!.get(co)![4] === 1,
        ledgerTailEntries: Math.min(
          treasuryDeltasOf(world, comps, co).length,
          TREASURY_TAIL_ENTRIES,
        ),
        digest: computeWorldDigest(world),
      });
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  return {
    digests,
    trace,
    endStaffing: trace[trace.length - 1]!.staffing,
    endTreasuryMilli: trace[trace.length - 1]!.treasuryMilli,
    mealsProduced: production.producedByCommodity[COMMODITY_MEALS]!,
    mealsStockpiled: commodityAmountOf(
      world,
      comps,
      PLAYER_ONE,
      COMMODITY_MEALS,
    ),
    woodDeposited: gather.depositedByResource[RESOURCE_WOOD]!,
    appointments: companiesDiag.appointments,
  };
}

installSimPurityShims();

describe("golden harness m4t2", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests plus the company trace", () => {
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

  it("routes branch output to the treasury exactly and exclusively staffs branches", () => {
    const run = runScenario(fixture);

    // EXACT LEDGER CLOSURE: every meal cycle paid 2000 milli and every
    // delivered wood unit paid 200 milli — nothing more, nothing less.
    expect(run.mealsProduced).toBe(6);
    expect(run.endTreasuryMilli).toBe(
      run.mealsProduced * MEALS_MILLI_PER_UNIT +
        run.woodDeposited * WOOD_MILLI_PER_UNIT,
    );
    expect(run.woodDeposited).toBeGreaterThan(0);
    // The physical remainder hit the normal stockpile untouched.
    expect(run.mealsStockpiled).toBe(run.mealsProduced);

    // EXCLUSIVE STAFFING: all three branch seats went to the officers —
    // best-rated own Pops; the locked gatherer and line crafters were
    // never drafted.
    expect(run.appointments).toBe(3);
    expect(run.endStaffing).toEqual([1, 1]);

    // Freeze beat: FROZEN at the tick-900 milestone, thawed by 1050.
    const atTick = (tick: number): CompanySample =>
      run.trace.find((sample) => sample.tick >= tick)!;
    expect(atTick(900).frozen).toBe(true);
    expect(atTick(1050).frozen).toBe(false);

    // Accrual NEVER stops — not even mid-freeze: the treasury never
    // shrinks across any consecutive milestones, and the frozen window
    // (750–1050, containing the 901/902 completions) still pays in.
    for (let i = 1; i < run.trace.length; i++) {
      expect(run.trace[i]!.treasuryMilli).toBeGreaterThanOrEqual(
        run.trace[i - 1]!.treasuryMilli,
      );
    }
    const before = atTick(900);
    const after = atTick(1050);
    expect(after.frozen).toBe(false);
    expect(after.treasuryMilli).toBeGreaterThan(before.treasuryMilli);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
  });
});

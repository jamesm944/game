/**
 * Trait-correlation fixture — SPEC §2.4 / M3-T7 acceptance (issue #52).
 *
 * "Hedonists tavern-ward, Pious shrine-ward": twelve named Pops — six
 * forced Hedonists, six forced Pious — share a village with a Tavern
 * and a Church (no brothel, so the tavern is the only pay venue) and
 * live FIFTY compressed evenings under the production-style roster.
 *
 * The tally reads the DIGEST-VISIBLE evidence: every completed outing
 * logs a SocialEvent VISIT row whose targetEid names the venue (or the
 * visited host), so the per-Pop venue split accumulates over the whole
 * run without sampling transient activity queues.
 *
 * The trait-weighted IAUS pulls decide the split: Hedonist +0.45 makes
 * the tavern dominate every alternative for its group; Pious +0.55 does
 * the same for the shrine — and neither group carries the other's pull,
 * so the tally separates almost cleanly.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { createMovementSystem } from "../src/sim/systems/movement";
import { createGatherSystem } from "../src/sim/systems/gather";
import { createNeedsSystem } from "../src/sim/systems/needs";
import { createSocialSystem, isLeisureTime } from "../src/sim/systems/social";
import { createSchedulesSystem } from "../src/sim/systems/schedules";
import { createPopBrainSystem } from "../src/sim/ai/popBrain";
import { normalizeLifecycleConfig } from "../src/sim/systems/lifecycle";
import {
  SOCIAL_EVENT_VISIT,
  readSocialEvents,
} from "../src/sim/components/socialEvents";
import { spawnHousehold } from "../src/sim/components/household";
import { traitCodeOf } from "../src/sim/data/traits";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

const SIZE = 48;
/**
 * Compressed clock sized so an evening can hold BOTH walks: the
 * staggered homeward release plus a venue stroll must fit between the
 * 18:00 close and the 22:00 night band. At 600-tick days the whole
 * window was ~100 ticks — shorter than one stroll — and even 2400 left
 * the commute eating the margin; 4800-tick days give the evening ~800
 * ticks while keeping the 50-evening run fast.
 */
const DAY_TICKS = 4800;
const EVENINGS = 50;

interface VillageRun {
  readonly hedonistTavern: number;
  readonly hedonistOther: number;
  readonly piousShrine: number;
  readonly piousOther: number;
}

function runVillage(seed: number): VillageRun {
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
  const cfg = normalizeLifecycleConfig({
    dayTicks: DAY_TICKS,
    // Arrivals enter as adults and outlive the run: nobody ages out.
    adultAgeDays: 3,
    elderAgeDays: 200,
    lifespanDays: 201,
  });
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createGatherSystem(comps, scheduler));
  registerSystem(world, createNeedsSystem(comps));
  registerSystem(world, createSocialSystem({ comps, lifecycleConfig: cfg }));
  registerSystem(
    world,
    createSchedulesSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
    }),
  );
  registerSystem(
    world,
    createPopBrainSystem({
      comps,
      players: [PLAYER_ONE],
      lifecycleConfig: cfg,
      leisureWindow: (tick) => isLeisureTime(tick, cfg),
    }),
  );

  // Deep pockets so the gold sink never gates a choice; one rich food
  // node keeps the daytime brain staffed until evening releases.
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [5000, 5000, 5000, 0, 0, 0, 0],
  );
  createDropOffPoint(world, comps, 22.5, 26.5, PLAYER_ONE);
  const worker = spawnUnit(world, comps, 21.5, 28.5, {
    identity: true,
    ownerId: PLAYER_ONE,
  });
  void worker;
  spawnResourceNode(world, comps, 20, 32, 0, 999999);
  spawnResourceNode(world, comps, 26, 32, 0, 999999);

  // The two venues sit at opposite ends of the housing row, so each
  // group's favored venue is a short stroll and the other's is far.
  const tavernEid = stampFinishedBuilding(world, comps, "tavern", 10, 14, {
    playerId: PLAYER_ONE,
  });
  const churchEid = stampFinishedBuilding(world, comps, "church", 36, 14, {
    playerId: PLAYER_ONE,
  });

  // Six roofs in one row: the western three hedge the tavern, the
  // eastern three the church. The west houses hold Hedonist couples,
  // the east houses Pious couples — each group lives beside its venue.
  const houseTiles: (readonly [number, number])[] = [
    [6, 18],
    [12, 18],
    [18, 18],
    [28, 18],
    [34, 18],
    [40, 18],
  ];
  const hedonists: number[] = [];
  const pious: number[] = [];
  for (const [index, [tx, ty]] of houseTiles.entries()) {
    const houseEid = stampFinishedBuilding(world, comps, "house", tx, ty, {
      playerId: PLAYER_ONE,
    });
    const head = spawnUnit(world, comps, tx - 0.5, ty + 2.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    const partner = spawnUnit(world, comps, tx + 2.5, ty + 2.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    spawnHousehold(world, comps, {
      playerId: PLAYER_ONE,
      homeEid: houseEid,
      headEid: head,
      partnerEid: partner,
      nextBirthRollTick: 999999999,
    });
    const slug = index < 3 ? "hedonist" : "pious";
    world.rowsByComponentId.get(comps.traitsId)!.set(head, [traitCodeOf(slug)]);
    world.rowsByComponentId
      .get(comps.traitsId)!
      .set(partner, [traitCodeOf(slug)]);
    (slug === "hedonist" ? hedonists : pious).push(head, partner);
  }

  const totalTicks = DAY_TICKS * (EVENINGS + 1);
  while (world.tick < totalTicks) step(world);

  // Tally completed outings from the SocialEvents log.
  let hedonistTavern = 0;
  let hedonistOther = 0;
  let piousShrine = 0;
  let piousOther = 0;
  for (const event of readSocialEvents(world, comps, PLAYER_ONE)) {
    if (event.kind !== SOCIAL_EVENT_VISIT) continue;
    if (hedonists.includes(event.actorEid)) {
      if (event.targetEid === tavernEid) hedonistTavern += 1;
      else if (event.targetEid !== churchEid) hedonistOther += 1;
    } else if (pious.includes(event.actorEid)) {
      if (event.targetEid === churchEid) piousShrine += 1;
      else if (event.targetEid !== tavernEid) piousOther += 1;
    }
  }
  return { hedonistTavern, hedonistOther, piousShrine, piousOther };
}

installSimPurityShims();

describe("trait correlation across 50 evenings", () => {
  it("hedonists tavern-ward, pious shrine-ward", () => {
    const run = runVillage(20260825);
    console.log(
      `50-evening correlation: hedonists ${run.hedonistTavern} tavern / ${run.hedonistOther} other; ` +
        `pious ${run.piousShrine} shrine / ${run.piousOther} other`,
    );

    // Both venues actually drew crowds.
    expect(run.hedonistTavern).toBeGreaterThan(0);
    expect(run.piousShrine).toBeGreaterThan(0);
    // Hedonists overwhelmingly chose the tavern…
    expect(run.hedonistTavern).toBeGreaterThanOrEqual(4 * run.hedonistOther);
    // …and the Pious overwhelmingly chose the shrine.
    expect(run.piousShrine).toBeGreaterThanOrEqual(4 * run.piousOther);
  });
}, 240_000);

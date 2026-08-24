/**
 * M4 demo checklist, headless half — SPEC §8 M4 / M4-T7 (issue #62).
 *
 * The M4 demo definition, proven end-to-end: WIN VIA EACH VICTORY PATH
 * AGAINST THE FULL AI OPPONENT. Every case boots the shared production
 * skirmish (`createSkirmishWorld`, exactly what main.ts boots) — real
 * fog planes, KnowledgeView-gated AI planner running its fast-castle-
 * knights strategy through the same inbox, combat, delegation layer,
 * companies, knowledge/culture/relic generators and the symmetric
 * §2.11 victory frame — and then plays ONE scripted player (the macro-
 * bot idiom of the M2 demo) whose orders enter through the same
 * command kinds the UI emits:
 *
 *   - CONQUEST (compact re-proof; the full FC→knights macro lives in
 *     m2-full-game.test.ts): dark-age militia mass off three barracks,
 *     then a regrouped push razes every AI military-production building;
 *   - KNOWLEDGE: a stamped Grand Academy + School, a skilled teacher
 *     and fourteen pupils — lessons flow through the REAL school pass,
 *     the teacher-scaled KP credits land on the ledger, and the sustain
 *     timer banks across successive lesson windows;
 *   - CULTURE: twin Monuments + a stamped Grand Monument, sustained by
 *     a festival season — every hostFestival converts Food+Gold into a
 *     timed prestige burst through the atomic command path;
 *   - WONDER: the completed Wonder holds through its hold timer;
 *   - RELIC: a Monastery, a monk and two grounded relics moved ground →
 *     monk → monastery through the collect/deposit commands, then ALL
 *     relics hold through the timer;
 *   - ECONOMIC: a chartered mining company (charterCompany command)
 *     whose Branch camp receives real miner deliveries — the full
 *     market value of every branch credit event feeds the ledger the
 *     evaluator derives its sustained rate from.
 *
 * SCENARIO-GRADE OPENING (documented privilege, mirroring every budget/
 * e2e fixture): completing-act buildings are STAMPED finished before
 * the first step (raising a Wonder legitimately costs thousands of
 * ticks the demo does not need to re-prove — construction is golden-
 * covered), opening banks are topped up, and the knowledge scenario
 * grants its teacher prior-life practice XP. Everything else — every
 * generator credit, every timer tick, the decision itself — flows
 * through the real systems against a live opponent.
 *
 * DETERMINISM: outcomes are pure functions of the pinned seeds. Seeds
 * were chosen so the generated maps host both starts and each scripted
 * arc lands its decision before the AI's first offensive could matter;
 * other seeds can stall or reject the bootstrap outright. Ticks-to-
 * victory are logged for the sign-off record in docs/m4-budget.md.
 */

import { describe, expect, it } from "vitest";
import {
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  buildingRectOf,
  getInventory,
  getProductionJob,
  populationCapOf,
  populationOf,
  readActivityQueue,
  readTrainQueue,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../../src/sim/components/pop";
import { rectsOverlap } from "../../src/sim/components/buildings";
import { knowledgePointsOf } from "../../src/sim/components/knowledge";
import { prestigeOf } from "../../src/sim/components/culture";
import { branchOutputOf } from "../../src/sim/components/branchOutput";
import { companyRowOf } from "../../src/sim/components/company";
import {
  latestVictoryCheck,
  VICTORY_STATUS_WON,
} from "../../src/sim/components/victory";
import { PLAYER_ONE, stockpileAmountsOf } from "../../src/sim/core/stockpile";
import { step, type World } from "../../src/sim/core/world";
import { AI_PLAYER } from "../../src/sim/ai/bootstrap";
import {
  createSkirmishWorld,
  type SkirmishWorld,
} from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import { BUILD_KIND } from "../../src/sim/systems/construction";
import {
  PLACE_BUILDING_KIND,
  stampFinishedBuilding,
  validatePlacement,
} from "../../src/sim/systems/placement";
import {
  TRAIN_UNIT_KIND,
  canEnqueueTraining,
} from "../../src/sim/systems/training";
import { canAffordCosts } from "../../src/sim/systems/costs";
import { militaryProductionBuildingsOf } from "../../src/sim/systems/conquest";
import { HOST_FESTIVAL_KIND } from "../../src/sim/systems/culture";
import {
  COLLECT_RELIC_COMMAND_KIND,
  DEPOSIT_RELIC_COMMAND_KIND,
} from "../../src/sim/systems/relics";
import { awardPractice } from "../../src/sim/systems/skills";
import { xpToReachLevel } from "../../src/sim/data/skills";
import {
  evaluateOutcome,
  relicsHeldOf,
  type VictoryOutcome,
} from "../../src/sim/systems/victory";
import type { LifecycleConfig } from "../../src/sim/systems/lifecycle";
import {
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_IRON,
} from "../../src/sim/components/economy";
import { spawnRelic } from "../../src/sim/components/relic";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
} from "../../src/data/definitions";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

/** Hosted skirmish seed (both starts land; see header). */
const SEED = 20260902;
const MAP_SIZE = 120;
/** Hard ceiling: a stalled scenario fails loudly instead of hanging. */
const MAX_TICKS = 30_000;
/** Player director cadence — the 1 s planning rhythm. */
const DIRECTOR_INTERVAL_TICKS = 30;

/** Compressed knowledge clock: 600-tick days keep lesson windows dense
 *  while adulthood (40 compressed days) stays far beyond the horizon. */
const KNOWLEDGE_CLOCK: LifecycleConfig = {
  dayTicks: 600,
  adultAgeDays: 40,
  elderAgeDays: 80,
  lifespanDays: 200,
};

// ---- Shared scenario helpers ---------------------------------------------------

type Session = SkirmishWorld;

function newSession(lifecycleConfig?: LifecycleConfig | undefined): Session {
  return createSkirmishWorld(SEED, {
    createTransport: createSynchronousPathTransport,
    ...(lifecycleConfig ? { lifecycleConfig } : {}),
  });
}

function submit(
  world: World,
  kind: string,
  data: Record<string, unknown>,
): void {
  world.inbox.submit({ kind, targetTick: world.tick + 1, data });
}

/**
 * Scenario-grade opening bank for BOTH sides (symmetric — the win is
 * decided by play, not by handouts).
 */
function topUpLedgers(session: Session, amounts: readonly number[]): void {
  for (const ledger of session.world.rowsByComponentId
    .get(session.comps.stockpileId)!
    .values()) {
    for (let code = 0; code < amounts.length; code++) {
      ledger[code + 1] = amounts[code]!;
    }
  }
}

function finishedBuildingsOf(
  session: Session,
  playerId: number,
): { eid: number; defId: string; centerX: number; centerY: number }[] {
  const out: {
    eid: number;
    defId: string;
    centerX: number;
    centerY: number;
  }[] = [];
  const { world, comps } = session;
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== playerId) continue;
    const rect = buildingRectOf(world, comps, eid);
    out.push({
      eid,
      defId: buildingIdOfCode(row[1]!),
      centerX: rect ? rect.x + rect.width / 2 : 0,
      centerY: rect ? rect.y + rect.height / 2 : 0,
    });
  }
  return out;
}

function townCenterOf(
  session: Session,
  playerId: number,
): {
  eid: number;
  centerX: number;
  centerY: number;
} {
  const tc = finishedBuildingsOf(session, playerId).find(
    (building) => building.defId === "town-center",
  );
  if (!tc) throw new Error("town center missing");
  return tc;
}

/**
 * Bootstrap-privilege stamp: ring-search outward from an anchor for the
 * first footprint clearing existing buildings/sites (with a 1-tile
 * margin), resource nodes (2-tile margin) and previously accepted
 * stamps, then stamp `defId` FINISHED. Validation walls are skipped by
 * design — construction and age gates are golden-covered elsewhere;
 * the demo only needs the completing act standing.
 */
function stampActBuilding(
  session: Session,
  defId: string,
  anchorX: number,
  anchorY: number,
  accepted: { x: number; y: number; width: number; height: number }[],
): number {
  const { world, comps } = session;
  const size = world.layers.size;
  const def = buildingDefOf(defId);
  const blockedByWorld = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): boolean => {
    for (const eid of world.entities) {
      const other =
        getBuildingSiteRow(world, comps, eid) !== undefined ||
        getBuildingRow(world, comps, eid) !== undefined
          ? (buildingRectOf(world, comps, eid) ?? undefined)
          : undefined;
      if (other && rectsOverlap(other, rect)) return true;
      const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      if (
        pos !== undefined &&
        pos[0]! >= rect.x - 2 &&
        pos[0]! <= rect.x + rect.width + 2 &&
        pos[1]! >= rect.y - 2 &&
        pos[1]! <= rect.y + rect.height + 2 &&
        world.rowsByComponentId.get(comps.resourceNodeId)?.has(eid) === true
      ) {
        return true;
      }
    }
    return false;
  };
  for (let ring = 4; ring <= 20; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.floor(anchorX) + dx;
        const y = Math.floor(anchorY) + dy;
        if (x < 1 || y < 1 || x + def.footprint.width >= size - 1) continue;
        if (y + def.footprint.height >= size - 1) continue;
        const rect = {
          x,
          y,
          width: def.footprint.width,
          height: def.footprint.height,
        };
        if (accepted.some((other) => rectsOverlap(other, rect))) continue;
        if (blockedByWorld(rect)) continue;
        accepted.push(rect);
        return stampFinishedBuilding(world, comps, defId, x, y, {
          playerId: PLAYER_ONE,
        });
      }
    }
  }
  throw new Error(`m4-paths found no clear spot for ${defId}`);
}

interface Decision {
  readonly outcome: VictoryOutcome;
  readonly decidedTick: number;
}

/** Step until the symmetric evaluator decides (or the guard trips). */
function runUntilDecided(
  session: Session,
  guardTicks = MAX_TICKS,
  director?: (() => void) | undefined,
): Decision {
  const { world, comps } = session;
  let directorNext = 1;
  while (world.tick < guardTicks) {
    const outcome = evaluateOutcome(world, comps);
    if (outcome.decided) {
      return { outcome, decidedTick: world.tick };
    }
    if (director !== undefined && world.tick >= directorNext) {
      director();
      directorNext = world.tick + DIRECTOR_INTERVAL_TICKS;
    }
    step(world);
  }
  throw new Error("match never decided within the guard window");
}

function expectPlayerWin(decision: Decision, reason: string): void {
  expect(decision.outcome.decided).toBe(true);
  expect(decision.outcome.winners).toEqual([PLAYER_ONE]);
  expect(decision.outcome.losers).toEqual([{ playerId: AI_PLAYER, reason }]);
}

/** The winner's decisive WON entry — its metric proves the generator. */
function winningMetricOf(session: Session, playerId: number): number {
  const won = latestVictoryCheck(session.world, session.comps, playerId);
  expect(won?.status).toBe(VICTORY_STATUS_WON);
  return won!.metric;
}

// ---- Case 1: CONQUEST ------------------------------------------------------------

describe("M4 demo checklist (SPEC §8): victory via each path against the full AI", () => {
  it("wins by CONQUEST — a dark-age militia push razes every AI military building", () => {
    const session = newSession();
    const { world, comps } = session;
    topUpLedgers(session, [9000, 9000, 5000, 0, 0, 0, 0]);

    const tc = townCenterOf(session, PLAYER_ONE);
    const anchorX = Math.floor(tc.centerX);
    const anchorY = Math.floor(tc.centerY);
    const acceptedRects: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    /**
     * First valid spot for `defId`, ring-searched with a 1-tile
     * SPACING margin: tightly packed footprints can wall a later
     * foundation's approach door in, stranding its crew forever (the
     * construction system's blocked-terrain slide cannot rescue a
     * fully enclosed face).
     */
    const pickSpot = (defId: string): { x: number; y: number } => {
      const def = buildingDefOf(defId);
      for (let ring = 4; ring <= 22; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const x = anchorX + dx;
            const y = anchorY + dy;
            if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
            const spaced = {
              x: x - 1,
              y: y - 1,
              width: def.footprint.width + 2,
              height: def.footprint.height + 2,
            };
            if (acceptedRects.some((other) => rectsOverlap(other, spaced)))
              continue;
            if (!validatePlacement(world, comps, defId, x, y).ok) continue;
            acceptedRects.push(spaced);
            return { x, y };
          }
        }
      }
      throw new Error(`macro found no valid spot for ${defId}`);
    };

    /** Player civilians (explicit Owner rows mark the AI's). */
    const villagersOf = (): number[] => {
      const out: number[] = [];
      for (const eid of world.entities) {
        if (!world.rowsByComponentId.get(comps.unitTagId)?.has(eid)) continue;
        if (world.rowsByComponentId.get(comps.combatId)?.has(eid)) continue;
        const owner = world.rowsByComponentId.get(comps.ownerId)?.get(eid);
        if (owner && owner[0] !== PLAYER_ONE) continue;
        out.push(eid);
      }
      return out.sort((a, b) => a - b);
    };

    const retaskIdleVillagers = (): void => {
      const candidates: { eid: number; d2: number }[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(
        comps.resourceNodeId,
      ) ?? new Map()) {
        if ((row[1] ?? 0) <= 0) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        const d2 = (pos[0]! - tc.centerX) ** 2 + (pos[1]! - tc.centerY) ** 2;
        if (d2 > 45 * 45) continue;
        candidates.push({ eid, d2 });
      }
      if (candidates.length === 0) return;
      candidates.sort((a, b) => a.d2 - b.d2 || a.eid - b.eid);
      let nextNode = 0;
      for (const eid of villagersOf()) {
        if (readActivityQueue(world, comps, eid).length > 0) continue;
        if (getAssignedSite(world, comps, eid) !== undefined) continue;
        if (getProductionJob(world, comps, eid) !== undefined) continue;
        const carry = getInventory(world, comps, eid);
        if (carry !== undefined && carry.amount > 0) continue;
        submit(world, "gather", {
          entityIds: [eid],
          nodeId: candidates[nextNode % candidates.length]!.eid,
        });
        nextNode += 1;
      }
    };

    let skeletonPlaced = false;
    let barracksEids: number[] = [];
    const MILITIA_WAVE = 18;
    const PUSH_ARMY = 12;
    let phase: "build" | "push" = "build";
    let activePushTarget: number | undefined;
    const siteProgress = new Map<number, { tick: number; prog: number }>();
    const staleSites = new Set<number>();

    const director = (): void => {
      // Dark-age skeleton: housing headroom + triple barracks.
      if (!skeletonPlaced) {
        skeletonPlaced = true;
        for (const defId of [
          "house",
          "house",
          "barracks",
          "barracks",
          "barracks",
        ]) {
          const spot = pickSpot(defId);
          submit(world, PLACE_BUILDING_KIND, {
            defId,
            tileX: spot.x,
            tileY: spot.y,
          });
        }
      }

      // Builders: two villagers per pending site, three on the first;
      // a site whose progress froze (walled-in foundation) is abandoned
      // so its crew flows to live work instead.
      const villagers = villagersOf();
      {
        let nextVillager = 0;
        const sites: number[] = [];
        for (const eid of world.entities) {
          const row = getBuildingSiteRow(world, comps, eid);
          if (!row || row[0] !== PLAYER_ONE) continue;
          const last = siteProgress.get(eid);
          if (last === undefined) {
            siteProgress.set(eid, { tick: world.tick, prog: row[2] ?? 0 });
          } else if ((row[2] ?? 0) !== last.prog) {
            siteProgress.set(eid, { tick: world.tick, prog: row[2] ?? 0 });
            staleSites.delete(eid);
          } else if (world.tick - last.tick >= 1200 && !staleSites.has(eid)) {
            staleSites.add(eid);
          }
          if (!staleSites.has(eid)) sites.push(eid);
        }
        for (const siteEid of sites) {
          const crew = villagers.slice(nextVillager, nextVillager + 3);
          nextVillager += 3;
          if (crew.length === 0) break;
          submit(world, BUILD_KIND, { entityIds: crew, siteEid });
        }
      }
      retaskIdleVillagers();

      // Housing ahead of the training pipeline.
      const pendingHouses = (() => {
        let count = 0;
        for (const eid of world.entities) {
          const row = getBuildingSiteRow(world, comps, eid);
          if (
            row &&
            row[0] === PLAYER_ONE &&
            buildingIdOfCode(row[1]!) === "house"
          ) {
            count += 1;
          }
        }
        return count;
      })();
      if (
        pendingHouses === 0 &&
        populationOf(world, comps, PLAYER_ONE) + 2 >
          populationCapOf(world, comps, PLAYER_ONE)
      ) {
        const spot = pickSpot("house");
        submit(world, PLACE_BUILDING_KIND, {
          defId: "house",
          tileX: spot.x,
          tileY: spot.y,
        });
      }

      // Militia production across all live barracks.
      barracksEids = finishedBuildingsOf(session, PLAYER_ONE)
        .filter((building) => building.defId === "barracks")
        .map((building) => building.eid);
      const army: number[] = [];
      for (const eid of world.entities) {
        const row = world.rowsByComponentId.get(comps.combatId)?.get(eid);
        if (row && row[1] === PLAYER_ONE) army.push(eid);
      }
      let queued = 0;
      for (const eid of barracksEids) {
        queued += readTrainQueue(world, comps, eid).length;
      }
      if (army.length + queued < MILITIA_WAVE) {
        for (const eid of barracksEids) {
          if (army.length + queued >= MILITIA_WAVE) break;
          if (!canEnqueueTraining(world, comps, eid, PLAYER_ONE, "militia"))
            continue;
          // UI parity: the panel refuses orders the bank cannot cover,
          // so the script gates each order the same way.
          if (
            !canAffordCosts(
              world,
              comps,
              PLAYER_ONE,
              unitDefOf("militia").costs,
            )
          ) {
            break;
          }
          submit(world, TRAIN_UNIT_KIND, { siteEid: eid, unitId: "militia" });
          queued += 1;
        }
      }

      // Push: regroup, then raze military production nearest the army.
      if (phase === "build" && army.length >= PUSH_ARMY) phase = "push";
      if (phase !== "push") return;
      if (army.length < PUSH_ARMY) return; // regroup before engaging
      const aiMilitary = militaryProductionBuildingsOf(world, comps, AI_PLAYER);
      const anyoneFighting = army.some((eid) => {
        const row = world.rowsByComponentId.get(comps.combatId)?.get(eid);
        if (row && row[3]! !== 0) return true;
        return readActivityQueue(world, comps, eid).some(
          (activity) =>
            activity.kind === "attack" || activity.kind === "attackMove",
        );
      });
      if (!anyoneFighting) activePushTarget = undefined;
      if (aiMilitary.length > 0) {
        const anchorPos = world.rowsByComponentId
          .get(comps.positionId)
          ?.get(army[0]!);
        const ax = anchorPos?.[0] ?? tc.centerX;
        const ay = anchorPos?.[1] ?? tc.centerY;
        let target = aiMilitary[0]!;
        let bestD = Number.POSITIVE_INFINITY;
        for (const eid of aiMilitary) {
          const rect = buildingRectOf(world, comps, eid)!;
          const d =
            (rect.x + rect.width / 2 - ax) ** 2 +
            (rect.y + rect.height / 2 - ay) ** 2;
          if (d < bestD) {
            bestD = d;
            target = eid;
          }
        }
        if (activePushTarget !== target) {
          activePushTarget = target;
          submit(world, "attack", { attackerIds: army, targetId: target });
        }
      } else {
        activePushTarget = undefined;
        const aiTown = finishedBuildingsOf(session, AI_PLAYER)[0];
        if (aiTown !== undefined) {
          submit(world, "attackMove", {
            ids: army,
            x: aiTown.centerX,
            y: aiTown.centerY,
          });
        }
      }
    };

    const decision = runUntilDecided(session, MAX_TICKS, director);
    expectPlayerWin(decision, "conquest");
    expect(militaryProductionBuildingsOf(world, comps, AI_PLAYER)).toEqual([]);

    console.log(
      `m4-paths conquest ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes)`,
    );
  }, 300_000);

  // ---- Case 2: KNOWLEDGE ---------------------------------------------------------

  it("wins by KNOWLEDGE — real school lessons sustain KP/min under the Grand Academy", () => {
    const session = newSession(KNOWLEDGE_CLOCK);
    const { world, comps } = session;
    topUpLedgers(session, [6000, 3000, 2000, 0, 0, 0, 0]);

    const tc = townCenterOf(session, PLAYER_ONE);
    const accepted: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    // Completing act + its generator, stamped standing before step one.
    stampActBuilding(
      session,
      "grand-academy",
      tc.centerX,
      tc.centerY,
      accepted,
    );
    stampActBuilding(session, "school", tc.centerX, tc.centerY, accepted);

    // A teacher with prior-life skill, then fourteen pupils of school
    // age — the school pass needs BOTH a standing School and somebody
    // who knows something before it teaches a single lesson.
    const teacher = spawnUnit(
      world,
      comps,
      tc.centerX + 2.5,
      tc.centerY + 4.5,
      {
        identity: true,
        ownerId: PLAYER_ONE,
      },
    );
    awardPractice(world, comps, teacher, "gathering", xpToReachLevel(5) * 3);
    for (let i = 0; i < 14; i++) {
      spawnUnit(
        world,
        comps,
        tc.centerX - 4 + (i % 5),
        tc.centerY + 6 + Math.floor(i / 5),
        {
          identity: true,
          ownerId: PLAYER_ONE,
          origin: POP_ORIGIN_BIRTH,
        },
      );
    }

    const decision = runUntilDecided(session, MAX_TICKS);
    expectPlayerWin(decision, "knowledge");
    expect(knowledgePointsOf(world, comps, PLAYER_ONE)).toBeGreaterThan(0);
    expect(winningMetricOf(session, PLAYER_ONE)).toBeGreaterThan(0);

    console.log(
      `m4-paths knowledge ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes), ` +
        `${String(knowledgePointsOf(world, comps, PLAYER_ONE))} milli-KP banked`,
    );
  }, 300_000);

  // ---- Case 3: CULTURE -----------------------------------------------------------

  it("wins by CULTURE — monuments plus a festival season sustain Prestige/min", () => {
    const session = newSession();
    const { world, comps } = session;
    topUpLedgers(session, [9000, 0, 9000, 0, 0, 0, 0]);

    const tc = townCenterOf(session, PLAYER_ONE);
    const accepted: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    stampActBuilding(
      session,
      "grand-monument",
      tc.centerX,
      tc.centerY,
      accepted,
    );
    stampActBuilding(session, "monument", tc.centerX, tc.centerY, accepted);
    stampActBuilding(session, "monument", tc.centerX, tc.centerY, accepted);

    const director = (): void => {
      // Festival season: one burst per heartbeat interval keeps every
      // interval's delta above the 20 Prestige/min sustain gate.
      const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
      if (
        amounts[RESOURCE_FOOD]! >= 120 + 40 &&
        amounts[RESOURCE_GOLD]! >= 80 + 40
      ) {
        submit(world, HOST_FESTIVAL_KIND, { playerId: PLAYER_ONE });
      }
    };

    const decision = runUntilDecided(session, MAX_TICKS, director);
    expectPlayerWin(decision, "culture");
    expect(prestigeOf(world, comps, PLAYER_ONE)).toBeGreaterThan(0);
    expect(winningMetricOf(session, PLAYER_ONE)).toBeGreaterThan(0);

    console.log(
      `m4-paths culture ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes), ` +
        `${String(prestigeOf(world, comps, PLAYER_ONE))} milli-prestige banked`,
    );
  }, 120_000);

  // ---- Case 4: WONDER ------------------------------------------------------------

  it("wins by WONDER — the completed Wonder stands through its hold timer", () => {
    const session = newSession();

    const tc = townCenterOf(session, PLAYER_ONE);
    stampActBuilding(session, "wonder", tc.centerX, tc.centerY, []);

    const decision = runUntilDecided(session, MAX_TICKS);
    expectPlayerWin(decision, "wonder");
    expect(winningMetricOf(session, PLAYER_ONE)).toBeGreaterThan(0);

    console.log(
      `m4-paths wonder ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes)`,
    );
  }, 120_000);

  // ---- Case 5: RELIC -------------------------------------------------------------

  it("wins by RELIC — a monk banks every relic and the hold timer runs out", () => {
    const session = newSession();
    const { world, comps } = session;

    const tc = townCenterOf(session, PLAYER_ONE);
    const accepted: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    const monastery = stampActBuilding(
      session,
      "monastery",
      tc.centerX,
      tc.centerY,
      accepted,
    );
    // One monk (any owned Pop carries relics) and two grounded relics.
    const monk = spawnUnit(world, comps, tc.centerX + 2.5, tc.centerY + 4.5, {
      identity: true,
      ownerId: PLAYER_ONE,
    });
    const relics = [
      spawnRelic(world, comps, tc.centerX + 4.5, tc.centerY + 4.5),
      spawnRelic(world, comps, tc.centerX + 4.5, tc.centerY + 6.5),
    ];

    for (const relic of relics) {
      submit(world, COLLECT_RELIC_COMMAND_KIND, {
        unitEid: monk,
        relicEid: relic,
      });
      step(world);
      submit(world, DEPOSIT_RELIC_COMMAND_KIND, {
        unitEid: monk,
        monasteryEid: monastery,
      });
      step(world);
    }
    expect(relicsHeldOf({ world, comps }, PLAYER_ONE)).toBe(2);

    const decision = runUntilDecided(session, MAX_TICKS);
    expectPlayerWin(decision, "relic");
    expect(winningMetricOf(session, PLAYER_ONE)).toBe(2);

    console.log(
      `m4-paths relic ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes)`,
    );
  }, 120_000);

  // ---- Case 6: ECONOMIC ----------------------------------------------------------

  it("wins by ECONOMIC — a chartered mining company's branch deliveries sustain value/min", () => {
    const session = newSession();
    const { world, comps } = session;

    const tc = townCenterOf(session, PLAYER_ONE);
    // The seed camp and two rich iron nodes a few tiles east of town —
    // close enough that the camp wins every delivery race against the
    // distant town-center drop-off.
    const campAnchor = {
      x: Math.floor(tc.centerX) + 8,
      y: Math.floor(tc.centerY) + 8,
    };
    const accepted: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    const camp = stampActBuilding(
      session,
      "mining-camp",
      campAnchor.x,
      campAnchor.y,
      accepted,
    );
    const nodes = [
      spawnResourceNode(
        world,
        comps,
        campAnchor.x + 4,
        campAnchor.y,
        RESOURCE_IRON,
        60_000,
      ),
      spawnResourceNode(
        world,
        comps,
        campAnchor.x + 4,
        campAnchor.y + 3,
        RESOURCE_IRON,
        60_000,
      ),
    ];

    // Charter through the REAL oversight-panel command, then put four
    // miners on the nodes. From here the §2.7 stack does the rest:
    // deliveries tithe the treasury and feed the economic ledger.
    submit(world, "charterCompany", {
      name: "Ironwright Guild",
      focus: 3 /* metal */,
      seedBuildingIds: [camp],
    });
    step(world);
    let companyId = 0;
    for (const [eid, row] of world.rowsByComponentId.get(comps.companyId)!) {
      if (row[0] === PLAYER_ONE) companyId = eid;
    }
    expect(companyId).toBeGreaterThan(0);

    const miners: number[] = [];
    for (let i = 0; i < 4; i++) {
      miners.push(
        spawnUnit(world, comps, campAnchor.x + 2 + i, campAnchor.y + 2, {
          identity: true,
          ownerId: PLAYER_ONE,
        }),
      );
    }
    for (let i = 0; i < miners.length; i++) {
      submit(world, "gather", {
        entityIds: [miners[i]!],
        nodeId: nodes[i % nodes.length]!,
      });
    }

    const decision = runUntilDecided(session, MAX_TICKS);
    expectPlayerWin(decision, "economic");
    expect(companyRowOf(world, comps, companyId)?.ownerPlayerId).toBe(
      PLAYER_ONE,
    );
    expect(branchOutputOf(world, comps, PLAYER_ONE)).toBeGreaterThan(0);
    expect(winningMetricOf(session, PLAYER_ONE)).toBe(
      branchOutputOf(world, comps, PLAYER_ONE),
    );

    console.log(
      `m4-paths economic ${String(SEED)}: victory at tick ${String(decision.decidedTick)} ` +
        `(${(decision.decidedTick / 30 / 60).toFixed(1)} sim-minutes), ` +
        `${String(branchOutputOf(world, comps, PLAYER_ONE))} milli-value banked`,
    );
  }, 180_000);
});

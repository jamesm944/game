/**
 * M2 demo checklist, headless half — SPEC §8 M2 / M2-T11 (issue #45).
 *
 * Executes the machine-verifiable portion of the M2 demo ("beat the
 * scripted AI by conquest on a 120×120 map") as ONE scripted macro
 * game over the REAL command surface and the full M2 system stack —
 * real fog planes, KnowledgeView-gated AI planner, combat, ages,
 * production, conquest evaluator — bootstrapped by the shared
 * production skirmish (`createSkirmishWorld`, exactly what main.ts
 * boots):
 *
 *   1. FAST CASTLE: houses + barracks placed and raised off the
 *      opening ladder, Feudal researched immediately, twin stables at
 *      Feudal, Castle research the moment its two prior-age buildings
 *      stand;
 *   2. KNIGHTS: the stables fill with knights (trainUnit, age-gated);
 *   3. PUSH: the army attack-marches into the AI town and every
 *      director pass re-targets the nearest LIVE AI military-production
 *      building until the conquest evaluator decides.
 *
 * Every order enters through the same command kinds the UI emits — the
 * script is a player, not a referee. The AI plays its own
 * fast-castle-knights strategy through the same inbox.
 *
 * SCENARIO-GRADE OPENING (documented privilege, mirrors the M1 demo's
 * "opening capital only" stance): both ledgers are topped up to a Fast
 * Castle ladder bank at bootstrap, before the first step — symmetric
 * for both sides, so the win is decided by play, not by handouts.
 * Everything after that is paid through the real cost paths.
 *
 * DETERMINISM: the outcome is a pure function of the pinned seed. The
 * seed is chosen so the generated map hosts both starts (mapgen water
 * at the mirrored center rejects some seeds in the T10 bootstrap — a
 * known scenario-editor edge outside this ticket) and produces a
 * decisive player win; other seeds can stalemate or reject the
 * bootstrap outright. Ticks-to-victory is logged for the sign-off
 * record in docs/m2-budget.md.
 */

import { describe, expect, it } from "vitest";
import { getAgeResearchRow, ageRankOf } from "../../src/sim/components/age";
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
  type SimComponents,
} from "../../src/sim/components";
import { rectsOverlap } from "../../src/sim/components/buildings";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitDefOf,
} from "../../src/data/definitions";
import { canAffordCosts } from "../../src/sim/systems/costs";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
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
  validatePlacement,
} from "../../src/sim/systems/placement";
import { RESEARCH_AGE_KIND } from "../../src/sim/systems/age";
import {
  TRAIN_UNIT_KIND,
  canEnqueueTraining,
} from "../../src/sim/systems/training";
import { militaryProductionBuildingsOf } from "../../src/sim/systems/conquest";
import { evaluateOutcome } from "../../src/sim/systems/victory";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

/** Pinned demo seed: hosted map + decisive conquest (see header). */
const SEED = 20260902;
const MAP_SIZE = 120;

/** Hard ceiling: a stalled match fails loudly instead of hanging. */
const MAX_TICKS = 40_000;
/** Player director cadence — the 1 s planning rhythm (§2.8-adjacent). */
const DIRECTOR_INTERVAL_TICKS = 30;
/** Knight wave the stables keep filled while Castle-age production runs.
 *  Sized for a DEFENDING opponent: since M4-T6 the AI rallies its whole
 *  army under attack and refills losses from its own economy, so the
 *  demo push needs local superiority (≈3:1) to break through. */
const KNIGHT_WAVE = 12;
/** Army size that launches the push. */
const PUSH_ARMY = 9;

/**
 * Scenario-grade Fast Castle bank: food for both age advances plus
 * slack, wood for the building skeleton, gold for Castle + knights.
 * Written once at bootstrap for BOTH players (see header). The gold
 * line prices SUSTAINED replacement waves: since M4-T6 the opponent
 * rallies its knights to defend under attack (§2.8 layer 3), so the
 * push trades units instead of rolling over — the bank must cover the
 * attrition or the demo stalls mid-push.
 */
const FC_CAPITAL = [6000, 4000, 4000, 0, 0, 0, 0];

interface MacroState {
  phase: "build" | "push";
  feudalSubmitted: boolean;
  castleSubmitted: boolean;
  stablesPlaced: boolean;
  acceptedRects: { x: number; y: number; width: number; height: number }[];
}

/** Player-one civilians (explicit Owner rows mark the AI's). */
function villagersOf(world: World, comps: SimComponents): number[] {
  const out: number[] = [];
  for (const eid of world.entities) {
    if (!world.rowsByComponentId.get(comps.unitTagId)?.has(eid)) continue;
    if (world.rowsByComponentId.get(comps.combatId)?.has(eid)) continue;
    const owner = world.rowsByComponentId.get(comps.ownerId)?.get(eid);
    if (owner && owner[0] !== PLAYER_ONE) continue;
    out.push(eid);
  }
  return out.sort((a, b) => a - b);
}

function finishedBuildingsOf(
  world: World,
  comps: SimComponents,
  player: number,
): { eid: number; defId: string; centerX: number; centerY: number }[] {
  const out: {
    eid: number;
    defId: string;
    centerX: number;
    centerY: number;
  }[] = [];
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== player) continue;
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

function pendingSitesOf(
  world: World,
  comps: SimComponents,
  player: number,
): { eid: number; defId: string }[] {
  const out: { eid: number; defId: string }[] = [];
  for (const eid of world.entities) {
    const row = getBuildingSiteRow(world, comps, eid);
    if (!row || row[0] !== player) continue;
    out.push({ eid, defId: buildingIdOfCode(row[1]!) });
  }
  return out;
}

/** Living military units owned by `player`, ascending eid. */
function armyOf(world: World, comps: SimComponents, player: number): number[] {
  const out: number[] = [];
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.combatId)?.get(eid);
    if (row && row[1] === player) out.push(eid);
  }
  return out;
}

describe("M2 demo checklist (SPEC §8)", () => {
  it("beats the scripted AI by conquest: FC → knights → push, headless on 120×120", () => {
    const session: SkirmishWorld = createSkirmishWorld(SEED, {
      createTransport: createSynchronousPathTransport,
    });
    const { world, comps } = session;
    expect(world.layers.size).toBe(MAP_SIZE);

    // ---- Scenario-grade opening, symmetric, BEFORE the first step.
    for (const ledger of world.rowsByComponentId
      .get(comps.stockpileId)!
      .values()) {
      for (let code = 0; code < FC_CAPITAL.length; code++) {
        ledger[code + 1] = FC_CAPITAL[code]!;
      }
    }

    const tc = finishedBuildingsOf(world, comps, PLAYER_ONE).find(
      (building) => building.defId === "town-center",
    );
    expect(tc).toBeDefined();
    const anchorX = Math.floor(tc!.centerX) - 1;
    const anchorY = Math.floor(tc!.centerY) - 1;

    const macro: MacroState = {
      phase: "build",
      feudalSubmitted: false,
      castleSubmitted: false,
      stablesPlaced: false,
      acceptedRects: [],
    };
    let stableEids: number[] = [];
    let directorNext = 1;
    let activePushTarget: number | undefined;
    const pushTargetsAttacked = new Set<number>();

    /**
     * Send fully IDLE villagers gathering. A walking worker shows an
     * empty AssignedNode row until it arrives — re-ordering it would
     * cancel its walk every director pass, so the activity QUEUE is
     * the idle test: only a literally empty queue re-tasks. Nodes are
     * re-scanned live so exhausted ground hands off to fresh nodes.
     */
    const retaskIdleVillagers = (): void => {
      const candidates: { eid: number; d2: number }[] = [];
      for (const [eid, row] of world.rowsByComponentId.get(
        comps.resourceNodeId,
      ) ?? new Map()) {
        if ((row[1] ?? 0) <= 0) continue;
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        const d2 = (pos[0]! - tc!.centerX) ** 2 + (pos[1]! - tc!.centerY) ** 2;
        if (d2 > 55 * 55) continue;
        candidates.push({ eid, d2 });
      }
      if (candidates.length === 0) return;
      candidates.sort((a, b) => a.d2 - b.d2 || a.eid - b.eid);
      let nextNode = 0;
      for (const eid of villagersOf(world, comps)) {
        if (readActivityQueue(world, comps, eid).length > 0) continue;
        if (getAssignedSite(world, comps, eid) !== undefined) continue;
        if (getProductionJob(world, comps, eid) !== undefined) continue;
        // Mid-delivery carriers keep their cargo and their own plans.
        const carry = getInventory(world, comps, eid);
        if (carry !== undefined && carry.amount > 0) continue;
        submit("gather", {
          entityIds: [eid],
          nodeId: candidates[nextNode % candidates.length]!.eid,
        });
        nextNode += 1;
      }
    };

    /** First valid non-overlapping spot for `defId`, ring-searched. */
    const pickSpot = (defId: string): { x: number; y: number } => {
      const def = buildingDefOf(defId);
      for (let ring = 3; ring <= 16; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const x = anchorX + dx;
            const y = anchorY + dy;
            if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
            const rect = {
              x,
              y,
              width: def.footprint.width,
              height: def.footprint.height,
            };
            if (macro.acceptedRects.some((other) => rectsOverlap(other, rect)))
              continue;
            if (!validatePlacement(world, comps, defId, x, y).ok) continue;
            macro.acceptedRects.push(rect);
            return { x, y };
          }
        }
      }
      throw new Error(`macro found no valid spot for ${defId}`);
    };

    const submit = (kind: string, data: Record<string, unknown>): void => {
      world.inbox.submit({ kind, targetTick: world.tick + 1, data });
    };

    /**
     * One player decision pass: age ladder, construction crews,
     * knight production, then the push loop. Reads only digest-
     * visible rows; emits only UI-shaped commands.
     */
    const director = (): void => {
      const rank = ageRankOf(world, comps, PLAYER_ONE) ?? 1;
      const researchRow = getAgeResearchRow(world, comps, PLAYER_ONE);

      // ---- Age ladder: Feudal off the opening bank, Castle the moment
      // its two prior-age buildings stand (barracks + first stable).
      if (!researchRow && rank === 1 && !macro.feudalSubmitted) {
        submit(RESEARCH_AGE_KIND, {});
        macro.feudalSubmitted = true;
      }
      const ownMilitaryCount = militaryProductionBuildingsOf(
        world,
        comps,
        PLAYER_ONE,
      ).length;
      if (
        !researchRow &&
        rank === 2 &&
        ownMilitaryCount >= 2 &&
        !macro.castleSubmitted
      ) {
        submit(RESEARCH_AGE_KIND, {});
        macro.castleSubmitted = true;
      }

      // ---- Dark-age skeleton: two houses (pop headroom) + barracks.
      if (!macro.stablesPlaced && macro.acceptedRects.length === 0) {
        for (const defId of ["house", "house", "barracks"]) {
          const spot = pickSpot(defId);
          submit(PLACE_BUILDING_KIND, {
            defId,
            tileX: spot.x,
            tileY: spot.y,
          });
        }
      }

      // ---- Feudal skeleton: twin stables (knights + Castle prereq).
      if (rank >= 2 && !macro.stablesPlaced) {
        macro.stablesPlaced = true;
        for (let i = 0; i < 2; i++) {
          const spot = pickSpot("stable");
          submit(PLACE_BUILDING_KIND, {
            defId: "stable",
            tileX: spot.x,
            tileY: spot.y,
          });
        }
      }

      // ---- Builders: player villagers onto pending sites, two per
      // site; everyone else keeps the resource chains fed (income pays
      // for the replacement waves — attrition is real against a
      // defending opponent).
      const villagers = villagersOf(world, comps);
      {
        let nextVillager = 0;
        for (const site of pendingSitesOf(world, comps, PLAYER_ONE)) {
          const crew = villagers.slice(nextVillager, nextVillager + 2);
          nextVillager += 2;
          if (crew.length === 0) break;
          submit(BUILD_KIND, { entityIds: crew, siteEid: site.eid });
        }
      }
      retaskIdleVillagers();

      // ---- Housing: keep pop headroom ahead of the training pipeline
      // or the wave deadlock (full queue + idle army + nobody dying).
      // One pending foundation at a time, mirroring the economy layer.
      {
        const pendingHouses = pendingSitesOf(world, comps, PLAYER_ONE).filter(
          (site) => site.defId === "house",
        ).length;
        if (
          pendingHouses === 0 &&
          populationOf(world, comps, PLAYER_ONE) + 2 >
            populationCapOf(world, comps, PLAYER_ONE)
        ) {
          const spot = pickSpot("house");
          submit(PLACE_BUILDING_KIND, {
            defId: "house",
            tileX: spot.x,
            tileY: spot.y,
          });
        }
      }

      // ---- Knight production: keep the wave filled while Castle-age.
      if (rank >= 2) {
        stableEids = finishedBuildingsOf(world, comps, PLAYER_ONE)
          .filter((building) => building.defId === "stable")
          .map((building) => building.eid);
      }
      const aliveKnights = armyOf(world, comps, PLAYER_ONE).length;
      let queuedKnights = 0;
      for (const eid of stableEids) {
        queuedKnights += readTrainQueue(world, comps, eid).length;
      }
      if (rank >= 3 && aliveKnights + queuedKnights < KNIGHT_WAVE) {
        for (const eid of stableEids) {
          if (aliveKnights + queuedKnights >= KNIGHT_WAVE) break;
          if (!canEnqueueTraining(world, comps, eid, PLAYER_ONE, "knight"))
            continue;
          // UI parity: the panel refuses orders the bank cannot cover
          // (canAffordCosts), so the script — a player, not a referee —
          // gates each order the same way instead of overdrafting.
          if (
            !canAffordCosts(world, comps, PLAYER_ONE, unitDefOf("knight").costs)
          ) {
            break;
          }
          submit(TRAIN_UNIT_KIND, { siteEid: eid, unitId: "knight" });
          queuedKnights += 1;
        }
      }

      // ---- Push: march on the AI town and raze military production.
      if (macro.phase === "build" && aliveKnights >= PUSH_ARMY) {
        macro.phase = "push";
      }
      if (macro.phase === "push") {
        const army = armyOf(world, comps, PLAYER_ONE);
        const aiMilitary = militaryProductionBuildingsOf(
          world,
          comps,
          AI_PLAYER,
        );
        // REGROUP before engaging: the opponent rallies its knights
        // home under attack, so piecemeal replacements just feed the
        // defender one at a time. Wait for the wave to reform.
        if (army.length < PUSH_ARMY) return;
        // One order per target — like a human click. Re-issuing every
        // director pass would cancel live engagements (and their
        // retaliations) mid-swing; re-click only when NOBODY is
        // attacking or engaged anymore (fresh replacements arrived, or
        // the wave was broken off).
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
          // Nearest LIVE military-production building to the army
          // anchor; explicit orders (buildings are invisible to aggro).
          const anchorPos = world.rowsByComponentId
            .get(comps.positionId)
            ?.get(army[0]!);
          const ax = anchorPos?.[0] ?? tc!.centerX;
          const ay = anchorPos?.[1] ?? tc!.centerY;
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
            pushTargetsAttacked.add(target);
            submit("attack", { attackerIds: army, targetId: target });
          }
        } else {
          activePushTarget = undefined;
          // Everything razed: camp the AI town until the evaluator lands.
          const aiTown = finishedBuildingsOf(world, comps, AI_PLAYER)[0];
          if (aiTown !== undefined) {
            submit("attackMove", {
              ids: army,
              x: aiTown.centerX,
              y: aiTown.centerY,
            });
          }
        }
      }
    };

    // ---- The game loop.
    let decidedTick = -1;
    let winners: readonly number[] = [];
    let losers: readonly { playerId: number; reason: string }[] = [];
    while (world.tick < MAX_TICKS) {
      const outcome = evaluateOutcome(world, comps);
      if (outcome.decided) {
        decidedTick = world.tick;
        winners = outcome.winners;
        losers = outcome.losers;
        break;
      }
      if (world.tick >= directorNext) {
        director();
        directorNext = world.tick + DIRECTOR_INTERVAL_TICKS;
      }
      step(world);
    }

    // ---- End-state assertions: the demo definition, proven.
    expect(decidedTick).toBeGreaterThan(0);
    expect(winners).toEqual([PLAYER_ONE]);
    expect(losers).toEqual([{ playerId: AI_PLAYER, reason: "conquest" }]);
    // The AI's military capacity was observed standing, then destroyed:
    expect(pushTargetsAttacked.size).toBeGreaterThanOrEqual(2);
    expect(militaryProductionBuildingsOf(world, comps, AI_PLAYER)).toEqual([]);
    // The winner actually climbed the ladder the demo names.
    expect(ageRankOf(world, comps, PLAYER_ONE)).toBe(3);

    console.log(
      `m2-full-game ${String(SEED)}: conquest victory at tick ` +
        `${String(decidedTick)} (${(decidedTick / 30 / 60).toFixed(1)} sim-minutes), ` +
        `${String(pushTargetsAttacked.size)} AI military buildings razed`,
    );
  }, 240_000);
});

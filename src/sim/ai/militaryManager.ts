/**
 * Military manager — SPEC §2.8 layer 3 / M4-T6 (issue #61).
 *
 * The third AI planning layer, utility-scored and fog-honest: every
 * query here goes through {@link AiKnowledge}, so raid targets, counter
 * picks and defense rallies are decided strictly against what the AI's
 * own scouting has legitimately observed. Like layers 1+2 the manager
 * never mutates sim state — it returns plain command descriptors the
 * orchestrator (planner.ts) submits into the shared inbox.
 *
 * Three duties, in fixed priority order:
 *
 *   1. DEFENSE — any own finished building below its definition hp with
 *      a hostile UNIT inside {@link DEFENSE_THREAT_RADIUS_TILES} tiles
 *      arms a rally: after the difficulty's `reactionDelayTicks` of
 *      sustained observation the whole army attack-marches the nearest
 *      raider. Observation clocks reset when the threat leaves, so
 *      easier difficulties genuinely react later (§2.8 knob).
 *   2. OFFENSE — the one-shot strike/raid decision (it spends the SAME
 *      `attackedTick` memory the §2.8 layer-1 attack step uses, so both
 *      paths share one offensive per match). Utility scoring compares
 *      every visible enemy entity: base strike value plus a large
 *      villager-density bonus for targets whose surroundings swarm with
 *      SCOUTED workers — "punish the undefended expansion" — minus a
 *      small distance penalty toward the AI town.
 *   3. COUNTERS — composition counter-picks. Scouted enemy units are
 *      grouped by definition; every trainable candidate scores
 *      Σ count × (its bonus vs them − their bonus vs it) using the real
 *      §2.5 definition tables (skirmisher 3× vs archer, …). Only a
 *      STRICTLY positive best score emits, one training order per pass,
 *      capped per match so a static enemy mass cannot infinite-loop the
 *      trainer.
 *
 * All arithmetic is integer-safe (scores in whole points, distances as
 * squared tile distances) — replay-stable by construction.
 */

import { buildingDefOf, unitDefOf } from "../../data/definitions";
import type { UnitDefinition } from "../../data/schema";
import { bonusMultiplierOf } from "../combat/stats";
import type { CommandDraft } from "./buildOrder";
import type { AiKnowledge, ResourceBudget } from "./knowledge";

/** Radius (tiles) around a raid target where scouted villagers count. */
export const RAID_DENSITY_RADIUS_TILES = 6;
/** Density weight per scouted villager — dominates the distance term. */
export const RAID_DENSITY_WEIGHT = 1_000_000;
/** Radius (tiles) a hostile unit must sit within to threaten a building. */
export const DEFENSE_THREAT_RADIUS_TILES = 9;
/** Ticks between successive defense rallies (order-churn guard). */
export const DEFENSE_RALLY_COOLDOWN_TICKS = 30;
/** Counter-training orders the manager will spend per match, max. */
export const COUNTER_TRAIN_CAP = 8;

/**
 * Cross-pass military state held by the orchestrator (fresh per match).
 * The one-shot offensive flag deliberately lives on BuildOrderMemory —
 * layer-1 attack steps and this manager share it.
 */
export interface MilitaryMemory {
  /** Damaged building eid → tick its current threat was first seen. */
  threatSince: Map<number, number>;
  /** Tick of the last emitted defense rally (cooldown anchor). */
  lastRallyTick?: number | undefined;
  /** Counter training orders emitted so far this match. */
  countersTrained: number;
}

export function createMilitaryMemory(): MilitaryMemory {
  return { threatSince: new Map(), countersTrained: 0 };
}

// ---- Shared geometry -----------------------------------------------------------

type Tile = { readonly tileX: number; readonly tileY: number };

function distSq(a: Tile, b: Tile): number {
  const dx = a.tileX - b.tileX;
  const dy = a.tileY - b.tileY;
  return dx * dx + dy * dy;
}

/** Footprint-center tile of the AI's first town center (anchor). */
function anchorTileOf(k: AiKnowledge): Tile {
  const tcEid = k.finishedBuildings("town-center")[0];
  const origin = tcEid !== undefined ? k.ownBuildingOrigin(tcEid) : undefined;
  // Origin is the footprint corner; the stamp position (center) sits at
  // +half footprint — close enough for scoring, and stable.
  return origin !== undefined
    ? { tileX: origin.x + 1, tileY: origin.y + 1 }
    : { tileX: 0, tileY: 0 };
}

function isBuildingDef(defId: string): boolean {
  try {
    buildingDefOf(defId);
    return true;
  } catch {
    return false;
  }
}

function isUnitDef(defId: string): boolean {
  try {
    unitDefOf(defId);
    return true;
  } catch {
    return false;
  }
}

/** Visible enemy UNITS (structures excluded — they never raid). */
function visibleEnemyUnits(k: AiKnowledge): readonly {
  eid: number;
  defId: string;
  tileX: number;
  tileY: number;
}[] {
  return k.visibleEnemies().filter((enemy) => !isBuildingDef(enemy.defId));
}

// ---- 1) Defense rally ------------------------------------------------------------

/**
 * Scan own damaged buildings for active threats and emit the rally
 * attack once a threat has persisted `reactionDelayTicks`. Prunes the
 * observation clocks of buildings no longer under threat (the clock
 * restarts if the raider leaves and comes back).
 */
export function planDefenseRally(
  k: AiKnowledge,
  memory: MilitaryMemory,
  reactionDelayTicks: number,
): CommandDraft | undefined {
  const army = k.armyUnits();
  if (army.length === 0) {
    memory.threatSince.clear();
    return undefined;
  }
  const enemies = visibleEnemyUnits(k);
  if (enemies.length === 0) {
    memory.threatSince.clear();
    return undefined;
  }
  const now = k.tick();
  const radiusSq = DEFENSE_THREAT_RADIUS_TILES * DEFENSE_THREAT_RADIUS_TILES;
  // Cooldown: a standing rally order does not need re-issue every tick.
  const coolingDown =
    memory.lastRallyTick !== undefined &&
    now - memory.lastRallyTick < DEFENSE_RALLY_COOLDOWN_TICKS;
  const nextClocks = new Map<number, number>();
  let rally: CommandDraft | undefined;
  for (const building of k.damagedOwnBuildings()) {
    let nearest: (Tile & { eid: number }) | undefined;
    let nearestD = Number.POSITIVE_INFINITY;
    for (const enemy of enemies) {
      const d = distSq(enemy, building);
      if (d > radiusSq) continue;
      if (d < nearestD || (d === nearestD && enemy.eid < nearest!.eid)) {
        nearestD = d;
        nearest = enemy;
      }
    }
    if (nearest === undefined) continue; // damage, but nobody home
    const first = memory.threatSince.get(building.eid) ?? now;
    nextClocks.set(building.eid, first);
    if (coolingDown) continue; // the previous rally still stands
    if (now - first < reactionDelayTicks) continue; // still observing
    rally ??= {
      kind: "attack",
      data: {
        attackerIds: army.map((unit) => unit.eid),
        targetId: nearest.eid,
        purpose: "defense",
      },
    };
  }
  memory.threatSince = nextClocks;
  if (rally !== undefined) memory.lastRallyTick = now;
  return rally;
}

// ---- 2) Offense: strike vs density-scored raid ------------------------------------

export interface OffensiveTarget {
  readonly targetId: number;
  /** Scouted villagers inside the raid radius of the chosen target. */
  readonly villagersNearby: number;
}

/**
 * Utility-score the offensive target across every legitimately visible
 * enemy entity: villager density dominates, squared distance to the AI
 * town breaks ties toward nearer targets (and serves as the tiny
 * penalty between equally-empty targets). Deterministic: ties resolve
 * to the lower eid.
 */
export function scoreOffensiveTarget(
  k: AiKnowledge,
): OffensiveTarget | undefined {
  const enemies = k.visibleEnemies();
  if (enemies.length === 0) return undefined; // fog says no
  const villagers = k.visibleEnemyVillagers();
  const anchor = anchorTileOf(k);
  const radiusSq = RAID_DENSITY_RADIUS_TILES * RAID_DENSITY_RADIUS_TILES;
  let best: OffensiveTarget | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const enemy of enemies) {
    let nearby = 0;
    for (const villager of villagers) {
      if (distSq(villager, enemy) <= radiusSq) nearby += 1;
    }
    const score = nearby * RAID_DENSITY_WEIGHT - distSq(enemy, anchor);
    if (
      score > bestScore ||
      (score === bestScore && best !== undefined && enemy.eid < best.targetId)
    ) {
      bestScore = score;
      best = { targetId: enemy.eid, villagersNearby: nearby };
    }
  }
  return best;
}

/**
 * The one-shot offensive (shared with layer-1 attack-step memory):
 * threshold met + scored target exists → the whole army attacks it.
 * `villagersNearby > 0` marks the draft a DENSITY RAID.
 */
export function planOffensive(
  k: AiKnowledge,
  strategy: { readonly attackArmyThreshold: number },
  memory: { attackedTick?: number | undefined },
): CommandDraft | undefined {
  if (memory.attackedTick !== undefined) return undefined;
  const army = k.armyUnits();
  if (army.length < Math.max(strategy.attackArmyThreshold, 1)) {
    return undefined;
  }
  const target = scoreOffensiveTarget(k);
  if (target === undefined) return undefined;
  memory.attackedTick = k.tick();
  return {
    kind: "attack",
    data: {
      attackerIds: army.map((unit) => unit.eid),
      targetId: target.targetId,
      purpose: target.villagersNearby > 0 ? "raid" : "strike",
    },
  };
}

// ---- 3) Composition counter-picks ----------------------------------------------

interface EnemyGroup {
  readonly def: UnitDefinition;
  readonly count: number;
}

/** Group visible enemy units by definition, ascending defId. */
function scoutedComposition(k: AiKnowledge): EnemyGroup[] {
  const counts = new Map<string, number>();
  for (const enemy of visibleEnemyUnits(k)) {
    if (!isUnitDef(enemy.defId)) continue;
    counts.set(enemy.defId, (counts.get(enemy.defId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([defId, count]) => ({ def: unitDefOf(defId), count }))
    .sort((a, b) => a.def.id.localeCompare(b.def.id));
}

/**
 * §2.5 net-counter score: how much extra damage `candidate` deals into
 * the scouted mass minus how much extra it takes back, weighted by how
 * many of each enemy definition are out there.
 */
function counterScore(
  candidate: UnitDefinition,
  enemies: readonly EnemyGroup[],
): number {
  let score = 0;
  for (const group of enemies) {
    score +=
      group.count *
      (bonusMultiplierOf(candidate, group.def.armorClasses) -
        bonusMultiplierOf(group.def, candidate.armorClasses));
  }
  return score;
}

/**
 * Emit AT MOST ONE counter-training order per pass: the strictly best
 * scoring trainable candidate (ties → alphabetical unit id), produced
 * by the lowest-eid own building that can enqueue it right now and is
 * affordable inside the caller's planning budget. A zero-or-negative
 * best score means the strategy's own line is already fine — no order.
 */
export function planCounterTraining(
  k: AiKnowledge,
  budget: ResourceBudget,
  memory: MilitaryMemory,
  out: CommandDraft[],
): void {
  if (memory.countersTrained >= COUNTER_TRAIN_CAP) return;
  const enemies = scoutedComposition(k);
  if (enemies.length === 0) return;

  // Candidate pool: everything own production buildings may train.
  const candidates = new Map<string, UnitDefinition>();
  for (const eid of k.finishedBuildings()) {
    for (const unitId of k.trainableUnitIds(eid)) {
      if (candidates.has(unitId)) continue;
      const def = unitDefOf(unitId);
      if (def.attack <= 0) continue; // monks never counter-pick
      candidates.set(unitId, def);
    }
  }
  let bestId: string | undefined;
  let bestScore = 0; // strictly-positive gate lives HERE
  const visibleBuildings = k.visibleEnemies().filter((e) => isBuildingDef(e.defId));
  for (const [unitId, def] of candidates) {
    let score = counterScore(def, enemies);
    if (visibleBuildings.length > 0) {
      const bBonus = bonusMultiplierOf(def, ["building"]);
      if (bBonus > 1) {
        score += visibleBuildings.length * Math.floor(bBonus);
      }
    }
    if (
      score > bestScore ||
      (score === bestScore &&
        bestId !== undefined &&
        score > 0 &&
        unitId.localeCompare(bestId) < 0)
    ) {
      bestId = unitId;
      bestScore = score;
    }
  }
  if (bestId === undefined) return;
  const def = unitDefOf(bestId);
  if (!budget.afford(def.costs)) return;
  for (const eid of k.finishedBuildings()) {
    if (!k.trainableUnitIds(eid).includes(bestId)) continue;
    if (!k.canTrain(eid, bestId)) continue;
    budget.debit(def.costs);
    memory.countersTrained += 1;
    out.push({
      kind: "trainUnit",
      data: { siteEid: eid, unitId: bestId, purpose: "counter" },
    });
    return;
  }
}

/**
 * Identify whether an enemy unit definition represents a high-value conversion target (knights, siege).
 */
export function isHighValueConversionTarget(defId: string): boolean {
  if (
    defId.includes("knight") ||
    defId.includes("cavalier") ||
    defId.includes("paladin") ||
    defId.includes("ram") ||
    defId.includes("mangonel") ||
    defId.includes("onager") ||
    defId.includes("scorpion") ||
    defId.includes("trebuchet") ||
    defId.includes("elephant")
  ) {
    return true;
  }
  try {
    const def = unitDefOf(defId);
    if (def.armorClasses?.includes("cavalry") || def.armorClasses?.includes("siege")) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Plan monk conversions for idle monks against visible high-value enemy targets (V14 Issue #101).
 */
export function planMonkConversions(
  k: AiKnowledge,
  out: CommandDraft[],
): void {
  const ownMonks = k.armyUnits().filter((u) => u.defId === "monk");
  if (ownMonks.length === 0) return;

  const enemies = k.visibleEnemies();
  if (enemies.length === 0) return;

  const highValueEnemies = enemies.filter((e) => isHighValueConversionTarget(e.defId));
  const candidateTargets = highValueEnemies.length > 0 ? highValueEnemies : enemies;

  for (const monk of ownMonks) {
    let bestTarget: (typeof enemies)[number] | undefined;
    let bestDistSq = 144; // 12 tiles squared max range
    for (const enemy of candidateTargets) {
      const dx = enemy.tileX - monk.tileX;
      const dy = enemy.tileY - monk.tileY;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestTarget = enemy;
      }
    }

    if (bestTarget !== undefined) {
      out.push({
        kind: "convert",
        data: {
          targetId: bestTarget.eid,
          monkEid: monk.eid,
        },
      });
    }
  }
}

/**
 * Incremental check for monk conversions: returns the first high-value conversion order available.
 */
export function planMonkConversionSingle(
  k: AiKnowledge,
): CommandDraft | undefined {
  const drafts: CommandDraft[] = [];
  planMonkConversions(k, drafts);
  return drafts[0];
}


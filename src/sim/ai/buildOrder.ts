/**
 * Build-order layer — SPEC §2.8 layer 1 / M2-T9 (issue #43).
 *
 * Scripted gated strategies as DATA: steps with a completion condition
 * ("barracks up", "Feudal reached", "four knights trained"), a gate
 * ("wood ≥ 175", "age ≥ Z"), optional `requires` edges onto other
 * steps, and an action (placeBuilding / researchAge / trainArmy /
 * attack).
 *
 * Each planning pass scans document order and emits AT MOST ONE
 * command: the first step that is INCOMPLETE, has every `requires`
 * dependency complete, passes its gate AND can actually emit right
 * now. A step that is waiting on the world (research in flight, spot
 * blocked, producer missing, army mustering) is skipped for this pass,
 * never a hard stop — ordering is carried by `requires` edges and
 * completion conditions, not by scan position, so genuinely parallel
 * work (barracks during the Feudal research) flows naturally while
 * true dependencies (knights before Castle completes) stay impossible.
 *
 * Everything speaks the player command interface: emissions are plain
 * `{kind, data}` descriptors that planner.ts submits to the shared
 * inbox with `playerId` stamped — identical in kind to human clicks.
 *
 * The attack step is deliberately MINIMAL (full utility-scored timing
 * lives in the M4 military manager): a scripted `attack` step only
 * marks intent in the strategy data — the planner's one-shot offensive
 * (shared `attackedTick` memory, scored by militaryManager.ts) does the
 * actual firing when the strategy's army threshold is met AND enemies
 * are inside AI vision. No vision → no target → no order; the fog gate
 * decides.
 */

import { buildingDefOf, techDefOf, unitDefOf } from "../../data/definitions";
import type { AiKnowledge } from "./knowledge";
import type { ResourceBudget, SpotReservation } from "./knowledge";

export type StrategyId = "fast-castle-knights" | "scouts-rush" | "archers-push";

/** Gatherable slug → minimum held amount ("resources ≥ X"). */
export type ResourceGate = Readonly<Record<string, number>>;

/** Finished-and-owned building minimum ("building Y up"). */
export interface BuildingRequirement {
  readonly defId: string;
  readonly count: number;
}

export interface StepGate {
  readonly minResources?: ResourceGate | undefined;
  readonly buildingsUp?: readonly BuildingRequirement[] | undefined;
  /** Minimum owned ladder rank ("age ≥ Z"). */
  readonly minAgeRank?: number | undefined;
}

/** Observable facts that mark one step done — evaluated on knowledge. */
export type CompletionCondition =
  | {
      readonly kind: "buildingUp";
      readonly defId: string;
      readonly count: number;
    }
  | { readonly kind: "ageReached"; readonly rank: number }
  | {
      readonly kind: "armySize";
      readonly unitId: string;
      readonly count: number;
    };

export interface PlaceBuildingAction {
  readonly kind: "placeBuilding";
  readonly defId: string;
  /**
   * Site-search window around the AI town center: candidate origins are
   * every tile at least `minClearance` tiles off the TC footprint out
   * to `maxRadius`, tried nearest-first until placement validates.
   * Data-driven AND deadlock-proof — a crowded core simply pushes the
   * next building outward instead of trapping its builders.
   */
  readonly minClearance: number;
  readonly maxRadius: number;
}

export interface BuildStep {
  readonly id: string;
  /**
   * Step ids that must COMPLETE before this one may act. Ordering is
   * carried by these edges (plus gates/completions), never by scan
   * position, so parallel work flows while true dependencies hold.
   */
  readonly requires?: readonly string[] | undefined;
  readonly action:
    | PlaceBuildingAction
    | { readonly kind: "researchAge" }
    | { readonly kind: "trainArmy"; readonly unitId: string }
    | { readonly kind: "attack" };
  readonly complete: CompletionCondition;
  readonly gate: StepGate;
}

export interface Strategy {
  /** Stable strategy slug (the scripted set keys STRATEGIES by these). */
  readonly id: string;
  /** Villager headroom the economy manager saturates the TC toward. */
  readonly villagerTarget: number;
  /**
   * Gather weights over food/wood/gold (sum ≈ 1) driving the economy
   * manager's assignment split for this strategy.
   */
  readonly gatherWeights: Readonly<Record<"food" | "wood" | "gold", number>>;
  /** Army size that arms the minimal attack trigger. */
  readonly attackArmyThreshold: number;
  readonly steps: readonly BuildStep[];
}

/** Cross-strategy memory held by the orchestrator (fresh per match). */
export interface BuildOrderMemory {
  attackedTick?: number | undefined;
}

/** Plain command descriptor destined for the shared inbox. */
export interface CommandDraft {
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

// ---- Strategy data ---------------------------------------------------------------

/**
 * Distance-sorted placement candidates around an anchor origin: every
 * tile outside the clearance square, out to the search radius, nearest
 * first with stable (y, x) tie-breaking.
 */
export function siteCandidates(
  originX: number,
  originY: number,
  minClearance: number,
  maxRadius: number,
): { x: number; y: number }[] {
  const slots: { x: number; y: number; d: number }[] = [];
  for (let dy = -maxRadius; dy <= maxRadius; dy++) {
    for (let dx = -maxRadius; dx <= maxRadius; dx++) {
      if (Math.abs(dx) <= minClearance && Math.abs(dy) <= minClearance)
        continue;
      slots.push({ x: originX + dx, y: originY + dy, d: dx * dx + dy * dy });
    }
  }
  slots.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return slots.map(({ x, y }) => ({ x, y }));
}

/** Military buildings keep one open approach lane off the town core. */
const MILITARY_SITE_SEARCH = { minClearance: 4, maxRadius: 9 } as const;

/**
 * Fast Castle → knights. The canonical FC skeleton: Feudal clicked off
 * the opening food surplus WHILE the dark-age barracks goes up in
 * parallel (`requires` carries the real dependency: none yet), a Stable
 * follows once Feudal lands (second castle prereq AND the knight
 * producer), Castle research waits for BOTH prior-age buildings, then
 * knights muster until the army threshold arms the attack trigger.
 */
const fastCastleKnights: Strategy = {
  id: "fast-castle-knights",
  villagerTarget: 12,
  gatherWeights: { food: 0.45, wood: 0.3, gold: 0.25 },
  attackArmyThreshold: 2,
  steps: [
    {
      id: "feudal-up",
      action: { kind: "researchAge" },
      complete: { kind: "ageReached", rank: 2 },
      gate: { minResources: { food: 500 }, minAgeRank: 1 },
    },
    {
      id: "dark-barracks",
      action: {
        kind: "placeBuilding",
        defId: "barracks",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "barracks", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 1 },
    },
    {
      id: "stable",
      action: {
        kind: "placeBuilding",
        defId: "stable",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "stable", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 2 },
    },
    {
      id: "castle-up",
      requires: ["feudal-up", "dark-barracks", "stable"],
      action: { kind: "researchAge" },
      complete: { kind: "ageReached", rank: 3 },
      gate: { minResources: { food: 800, gold: 200 }, minAgeRank: 2 },
    },
    {
      id: "train-knights",
      requires: ["castle-up"],
      action: { kind: "trainArmy", unitId: "knight" },
      complete: { kind: "armySize", unitId: "knight", count: 4 },
      gate: { minAgeRank: 3 },
    },
    {
      id: "attack",
      requires: ["train-knights"],
      action: { kind: "attack" },
      // Terminal step: never completes; the planner fires it once per
      // match when vision offers a legitimate target.
      complete: {
        kind: "armySize",
        unitId: "knight",
        count: Number.POSITIVE_INFINITY,
      },
      gate: {},
    },
  ],
};

/** Scouts rush: same skeleton, cheaper army, earlier aggression. */
const scoutsRush: Strategy = {
  id: "scouts-rush",
  villagerTarget: 10,
  gatherWeights: { food: 0.55, wood: 0.35, gold: 0.1 },
  attackArmyThreshold: 3,
  steps: [
    {
      id: "feudal-up",
      action: { kind: "researchAge" },
      complete: { kind: "ageReached", rank: 2 },
      gate: { minResources: { food: 500 }, minAgeRank: 1 },
    },
    {
      id: "dark-barracks",
      action: {
        kind: "placeBuilding",
        defId: "barracks",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "barracks", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 1 },
    },
    {
      id: "stable",
      action: {
        kind: "placeBuilding",
        defId: "stable",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "stable", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 2 },
    },
    {
      id: "train-scouts",
      requires: ["feudal-up", "stable"],
      action: { kind: "trainArmy", unitId: "scout-cavalry" },
      complete: { kind: "armySize", unitId: "scout-cavalry", count: 6 },
      gate: { minAgeRank: 2 },
    },
    {
      id: "attack",
      requires: ["train-scouts"],
      action: { kind: "attack" },
      complete: {
        kind: "armySize",
        unitId: "scout-cavalry",
        count: Number.POSITIVE_INFINITY,
      },
      gate: {},
    },
  ],
};

/** Archers push: ranges behind feudal, mass archers, then push. */
const archersPush: Strategy = {
  id: "archers-push",
  villagerTarget: 11,
  gatherWeights: { food: 0.35, wood: 0.4, gold: 0.25 },
  attackArmyThreshold: 4,
  steps: [
    {
      id: "feudal-up",
      action: { kind: "researchAge" },
      complete: { kind: "ageReached", rank: 2 },
      gate: { minResources: { food: 500 }, minAgeRank: 1 },
    },
    {
      id: "dark-barracks",
      action: {
        kind: "placeBuilding",
        defId: "barracks",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "barracks", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 1 },
    },
    {
      id: "archery-range",
      action: {
        kind: "placeBuilding",
        defId: "archery-range",
        minClearance: MILITARY_SITE_SEARCH.minClearance,
        maxRadius: MILITARY_SITE_SEARCH.maxRadius,
      },
      complete: { kind: "buildingUp", defId: "archery-range", count: 1 },
      gate: { minResources: { wood: 175 }, minAgeRank: 2 },
    },
    {
      id: "train-archers",
      requires: ["feudal-up", "archery-range"],
      action: { kind: "trainArmy", unitId: "archer" },
      complete: { kind: "armySize", unitId: "archer", count: 6 },
      gate: { minAgeRank: 2 },
    },
    {
      id: "attack",
      requires: ["train-archers"],
      action: { kind: "attack" },
      complete: {
        kind: "armySize",
        unitId: "archer",
        count: Number.POSITIVE_INFINITY,
      },
      gate: {},
    },
  ],
};

export const STRATEGIES: Readonly<Record<StrategyId, Strategy>> = {
  "fast-castle-knights": fastCastleKnights,
  "scouts-rush": scoutsRush,
  "archers-push": archersPush,
};

// ---- Step evaluation --------------------------------------------------------------

function completionMet(
  k: AiKnowledge,
  condition: CompletionCondition,
): boolean {
  switch (condition.kind) {
    case "buildingUp":
      return k.finishedBuildings(condition.defId).length >= condition.count;
    case "ageReached":
      return k.ageRank() >= condition.rank;
    case "armySize":
      return (
        k.armyUnits().filter((u) => u.defId === condition.unitId).length >=
        condition.count
      );
  }
}

function gateOpen(
  k: AiKnowledge,
  budget: ResourceBudget,
  gate: StepGate,
): boolean {
  if (gate.minAgeRank !== undefined && k.ageRank() < gate.minAgeRank) {
    return false;
  }
  if (gate.minResources !== undefined && !budget.afford(gate.minResources)) {
    return false;
  }
  if (gate.buildingsUp !== undefined) {
    for (const req of gate.buildingsUp) {
      if (k.finishedBuildings(req.defId).length < req.count) return false;
    }
  }
  return true;
}

function emitForStep(
  k: AiKnowledge,
  budget: ResourceBudget,
  reserved: SpotReservation,
  step: BuildStep,
): CommandDraft | undefined {
  const action = step.action;

  if (action.kind === "placeBuilding") {
    const def = buildingDefOf(action.defId);
    if (!budget.afford(def.costs)) return undefined;
    // One unfinished site per definition at a time: completions are
    // what the step waits for, so a second foundation would only
    // strand wood and builders.
    if (k.unfinishedSites().some((site) => site.defId === action.defId)) {
      return undefined;
    }
    const tcEid = k.finishedBuildings("town-center")[0];
    const origin = tcEid !== undefined ? k.ownBuildingOrigin(tcEid) : undefined;
    if (!origin) return undefined;
    for (const slot of siteCandidates(
      origin.x,
      origin.y,
      action.minClearance,
      action.maxRadius,
    )) {
      // validatePlacement inside the knowledge seam gates geometry AND
      // the §2.9 explored rule — scripted spots outside AI knowledge
      // are structurally unreachable. Same-pass reservations keep two
      // drafts off one footprint (sites exist only next tick).
      if (reserved.isReserved(action.defId, slot.x, slot.y)) continue;
      if (!k.canPlace(action.defId, slot.x, slot.y)) continue;
      budget.debit(def.costs);
      reserved.reserve(action.defId, slot.x, slot.y);
      return {
        kind: "placeBuilding",
        data: {
          defId: action.defId,
          tileX: slot.x,
          tileY: slot.y,
          playerId: k.player,
        },
      };
    }
    return undefined; // no valid spot in the window: wait, never force
  }

  if (action.kind === "researchAge") {
    const techId = k.nextAgeTechId();
    if (techId === undefined || !k.canStartAgeAdvance()) return undefined;
    const costs = techDefOf(techId).costs;
    if (!budget.afford(costs)) return undefined;
    budget.debit(costs);
    return { kind: "researchAge", data: { playerId: k.player } };
  }

  if (action.kind === "trainArmy") {
    const def = unitDefOf(action.unitId);
    const target = step.complete.kind === "armySize" ? step.complete.count : 0;
    // Count living units AND queued heads: the producer drains its
    // queue long after the orders were paid, so gating on alive alone
    // would overshoot the strategy target every time.
    let current = k.armyUnits().filter((u) => u.defId === action.unitId).length;
    for (const eid of k.finishedBuildings()) {
      for (const unitId of k.trainQueueOf(eid)) {
        if (unitId === action.unitId) current += 1;
      }
    }
    if (current >= target) return undefined;
    if (!budget.afford(def.costs)) return undefined;
    // Lowest-eid own production building that trains this unit and can
    // enqueue it right now (age gate, housing headroom, queue space).
    for (const eid of k.finishedBuildings()) {
      if (!k.trainableUnitIds(eid).includes(action.unitId)) continue;
      if (!k.canTrain(eid, action.unitId)) continue;
      budget.debit(def.costs);
      return {
        kind: "trainUnit",
        data: { siteEid: eid, unitId: action.unitId },
      };
    }
    return undefined;
  }

  // The attack step is deliberately MINIMAL: M4's military manager
  // (militaryManager.ts) owns target scoring — density raids, counter
  // picks, defense rallies — and the PLANNER owns emission timing. A
  // scripted attack step here only marks intent; the orchestrator's
  // one-shot offensive (shared `attackedTick` memory) does the firing.
  if (action.kind === "attack") {
    return undefined;
  }

  return undefined;
}

/**
 * Scan document order and emit at most ONE command for the first step
 * that is incomplete, has all `requires` complete, opens its gate AND
 * can actually emit now. Steps waiting on the world are skipped for
 * this pass — ordering lives in the data (requires/completions), so a
 * stalled Feudal research never blocks the parallel barracks, while a
 * Castle research genuinely gates the knight line through its edges.
 */
export function planBuildOrder(
  k: AiKnowledge,
  strategy: Strategy,
  budget: ResourceBudget,
  reserved: SpotReservation,
  memory: BuildOrderMemory,
): CommandDraft | undefined {
  void memory; // attack emission moved to the military manager (M4-T6)
  const doneIds = new Set(
    strategy.steps
      .filter((step) => completionMet(k, step.complete))
      .map((step) => step.id),
  );
  for (const step of strategy.steps) {
    if (doneIds.has(step.id)) continue;
    const depsReady = (step.requires ?? []).every((id) => doneIds.has(id));
    if (!depsReady) continue;
    if (!gateOpen(k, budget, step.gate)) continue;
    const draft = emitForStep(k, budget, reserved, step);
    if (draft !== undefined) return draft;
    // Waiting on this one (research in flight, spot blocked, producer
    // missing, army mustering): fall through — later steps whose own
    // edges/gates permit may still act this pass.
  }
  return undefined;
}

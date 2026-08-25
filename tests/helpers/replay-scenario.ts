/**
 * Scripted replay scenario — M5-T3 (issue #65).
 *
 * ONE deterministic scripted skirmish shared by tests/replay.test.ts
 * and the fixture generator: a fresh two-player world from a pinned
 * seed, a handful of REAL player orders through the same inbox kinds
 * the UI emits (groupMove/gather/placeBuilding/trainUnit/stop), stepped
 * through the recorder's sim window so AI/planner emissions stay out of
 * the artifact. Pure function of the seed — the recorded artifact
 * replays byte-exact everywhere.
 */

import { buildingIdOfCode } from "../../src/data/definitions";
import type { SimComponents } from "../../src/sim/components";
import { getBuildingRow } from "../../src/sim/components";
import {
  buildingRectOf,
  rectsOverlap,
} from "../../src/sim/components/buildings";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { ReplayRecorder } from "../../src/sim/replay/record";
import type { ReplayArtifact } from "../../src/sim/replay/record";
import { BUILD_KIND } from "../../src/sim/systems/construction";
import {
  PLACE_BUILDING_KIND,
  validatePlacement,
} from "../../src/sim/systems/placement";
import {
  TRAIN_UNIT_KIND,
  canEnqueueTraining,
} from "../../src/sim/systems/training";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import type { World } from "../../src/sim/core/world";
import {
  createSkirmishWorld,
  type SkirmishWorld,
} from "../../src/game/session";

/** Known-good bootstrap seed (the pinned M2 demo seed — its generated
 *  map hosts both mirrored starts; several seeds reject in mapgen). */
export const SCENARIO_SEED = 20260902;
/** 30 simulated seconds — long enough to span a full build→train arc
 *  across many milestone boundaries, short enough for the suite. */
export const SCENARIO_TICKS = 900;

export interface ScriptedRecording {
  readonly session: SkirmishWorld;
  readonly artifact: ReplayArtifact;
}

/** Player-one civilians (Owner rows mark the AI's), ascending eid. */
export function scenarioVillagers(
  world: World,
  comps: SimComponents,
): number[] {
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

function townCenterOf(world: World, comps: SimComponents): number {
  for (const eid of world.entities) {
    const row = getBuildingRow(world, comps, eid);
    if (
      row &&
      row[0] === PLAYER_ONE &&
      buildingIdOfCode(row[1]!) === "town-center"
    ) {
      return eid;
    }
  }
  throw new Error("scenario: no player town center");
}

function nearestNodeId(
  world: World,
  comps: SimComponents,
  x: number,
  y: number,
): number {
  let best = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (const [eid, row] of world.rowsByComponentId.get(comps.resourceNodeId) ??
    []) {
    if ((row[1] ?? 0) <= 0) continue;
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    const d2 = (pos[0]! - x) ** 2 + (pos[1]! - y) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = eid;
    }
  }
  if (best < 0) throw new Error("scenario: no live resource node");
  return best;
}

function pendingHouseSite(
  world: World,
  comps: SimComponents,
): number | undefined {
  for (const [eid, row] of world.rowsByComponentId.get(comps.buildingSiteId) ??
    []) {
    if (row[0] !== PLAYER_ONE) continue;
    if (buildingIdOfCode(row[1]!) === "house") return eid;
  }
  return undefined;
}

function houseSpotNear(
  world: World,
  comps: SimComponents,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } {
  const occupied: {
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  for (const eid of world.entities) {
    const rect = buildingRectOf(world, comps, eid) ?? undefined;
    if (rect) occupied.push(rect);
  }
  for (let ring = 3; ring <= 14; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = anchorX + dx;
        const y = anchorY + dy;
        if (!validatePlacement(world, comps, "house", x, y).ok) continue;
        if (
          occupied.some((other) =>
            rectsOverlap(other, { x, y, width: 2, height: 2 }),
          )
        ) {
          continue;
        }
        return { x, y };
      }
    }
  }
  throw new Error("scenario: no valid house spot");
}

/**
 * Record one full scripted match. The director submits ONLY between
 * steps (exactly how the browser UI does), so every logged command is
 * player-originated by construction.
 */
export function recordScriptedSkirmish(): ScriptedRecording {
  const recorder = new ReplayRecorder();
  const session = createSkirmishWorld(SCENARIO_SEED, {
    createTransport: createSynchronousPathTransport,
    replay: recorder,
  });
  const { world, comps } = session;
  recorder.beginPlay();

  const tcEid = townCenterOf(world, comps);
  const tcRect = buildingRectOf(world, comps, tcEid)!;
  const anchorX = Math.floor(tcRect.x);
  const anchorY = Math.floor(tcRect.y);

  /** Orders keyed by their absolute delivery tick. */
  const orders = new Map<number, () => void>();
  const submit = (kind: string, data: Record<string, unknown>): void => {
    world.inbox.submit({ kind, targetTick: world.tick + 1, data });
  };

  orders.set(5, () => {
    const villagers = scenarioVillagers(world, comps).slice(0, 3);
    submit("groupMove", {
      entityIds: villagers,
      x: anchorX + 9.5,
      y: anchorY + 6.5,
    });
  });
  orders.set(40, () => {
    const villagers = scenarioVillagers(world, comps);
    const nodeId = nearestNodeId(world, comps, anchorX, anchorY);
    submit("gather", { entityIds: villagers.slice(0, 2), nodeId });
  });
  orders.set(90, () => {
    const spot = houseSpotNear(world, comps, anchorX + 4, anchorY + 4);
    submit(PLACE_BUILDING_KIND, {
      defId: "house",
      tileX: spot.x,
      tileY: spot.y,
    });
  });
  orders.set(91, () => {
    // Crew the fresh foundation (right-click-a-site shape from §2.13).
    const site = pendingHouseSite(world, comps);
    if (site !== undefined) {
      submit(BUILD_KIND, {
        entityIds: scenarioVillagers(world, comps).slice(0, 2),
        siteEid: site,
      });
    }
  });
  orders.set(105, () => {
    const spot = houseSpotNear(world, comps, anchorX - 4, anchorY - 4);
    submit(PLACE_BUILDING_KIND, {
      defId: "house",
      tileX: spot.x,
      tileY: spot.y,
    });
  });
  orders.set(106, () => {
    const site = pendingHouseSite(world, comps);
    if (site !== undefined) {
      submit(BUILD_KIND, {
        entityIds: scenarioVillagers(world, comps).slice(2, 4),
        siteEid: site,
      });
    }
  });
  orders.set(210, () => {
    // The two idle villagers (builders keep building — a stop would
    // cancel their site assignment like a player's S key does).
    const idle = scenarioVillagers(world, comps).slice(3, 5);
    submit("stop", { entityIds: idle });
  });
  orders.set(260, () => {
    const walkers = scenarioVillagers(world, comps).slice(3, 5);
    submit("groupMove", {
      entityIds: walkers,
      x: anchorX - 7.25,
      y: anchorY - 4.75,
    });
  });

  // Training retries through a deterministic window until the site
  // accepts (pop headroom opens once a house finishes) — exactly how a
  // player re-clicks a disabled production button.
  let trained = false;
  for (let delivered = 1; delivered <= SCENARIO_TICKS; delivered++) {
    orders.get(delivered)?.();
    if (
      !trained &&
      delivered >= 820 &&
      delivered <= 895 &&
      canEnqueueTraining(world, comps, tcEid, PLAYER_ONE, "villager")
    ) {
      submit(TRAIN_UNIT_KIND, { siteEid: tcEid, unitId: "villager" });
      trained = true;
    }
    recorder.stepWorld();
  }

  const artifact = recorder.finalize(SCENARIO_TICKS);
  return { session, artifact };
}
